/**
 * mqtt-net.js — 基于 MQTT over WebSocket 的联机传输层（GitHub Pages 静态版）
 * 架构：房主浏览器运行 game-core 权威引擎（充当服务器），消息经公共 MQTT broker 中转
 *
 * 主题（base = tod67web/<roomCode>）：
 *   <base>/state               房主→所有人  快照（retained：新玩家加入秒收状态）
 *   <base>/chat                房主→所有人  聊天/系统消息/定向错误(带 to)
 *   <base>/action              玩家→房主    游戏动作（带 from=playerId）
 *   <base>/presence/<pid>      玩家→房主    心跳（房主 12 秒收不到即移除玩家）
 */
(function () {
  'use strict';

  const BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081',
  ];
  const TOPIC_BASE = 'tod67web';
  const HEARTBEAT_MS = 4000;
  const OFFLINE_AFTER_MS = 12000;

  function MqttNet() {
    this.client = null;
    this.myId = null;
    this.roomCode = null;
    this.isHost = false;
    this.engine = null;
    this.lastSeen = new Map(); // pid -> ts（房主视角）
    this.onMessage = null; // (msg) => void，统一消息流
    this.onStatus = null; // ('ok'|'bad'|'connecting') => void
    this.brokerIdx = 0;
    this.connectTimer = null;
    this.timers = [];
    this.staleWarned = false;
  }

  MqttNet.prototype._base = function () {
    return TOPIC_BASE + '/' + this.roomCode;
  };

  MqttNet.prototype._pub = function (suffix, obj, retain) {
    if (this.client && this.client.connected) {
      this.client.publish(this._base() + suffix, JSON.stringify(obj), { qos: 0, retain: !!retain });
    }
  };

  MqttNet.prototype._sub = function (topics) {
    if (this.client && this.client.connected) {
      this.client.subscribe(topics, { qos: 0 });
    }
  };

  // ---------- 连接（含 broker 故障转移） ----------
  MqttNet.prototype.connect = function (myId, onReady) {
    this.myId = myId;
    const self = this;
    const url = BROKERS[this.brokerIdx];
    if (this.onStatus) this.onStatus('connecting');

    let clientId = 'tod67' + myId.replace(/[^a-zA-Z0-9]/g, '').slice(-10) + Math.floor(Math.random() * 9999);
    try {
      this.client = mqtt.connect(url, { clientId, keepalive: 30, reconnectPeriod: 2500, connectTimeout: 8000, clean: true });
    } catch (e) {
      return this._failover(onReady);
    }

    this.connectTimer = setTimeout(() => {
      if (!this.client.connected) {
        this.client.end(true);
        this._failover(onReady);
      }
    }, 9000);

    this.client.on('connect', () => {
      clearTimeout(this.connectTimer);
      if (this.onStatus) this.onStatus('ok');
      if (onReady) onReady();
    });
    this.client.on('reconnect', () => this.onStatus && this.onStatus('connecting'));
    this.client.on('close', () => this.onStatus && this.onStatus('bad'));

    this.client.on('message', (topic, payload) => {
      let msg;
      try { msg = JSON.parse(payload.toString()); } catch { return; }
      self._route(topic, msg, payload.toString());
    });
  };

  MqttNet.prototype._failover = function (onReady) {
    this.brokerIdx += 1;
    if (this.brokerIdx < BROKERS.length) this.connect(this.myId, onReady);
    else if (this.onMessage) this.onMessage({ type: 'error', message: '无法连接消息服务器，请刷新页面重试' });
  };

  MqttNet.prototype._afterConnect = function (fn) {
    if (this.client && this.client.connected) return fn();
    const c = this.client;
    const h = () => { c.off('connect', h); fn(); };
    c.on('connect', h);
  };

  // ---------- 消息路由 ----------
  MqttNet.prototype._route = function (topic, msg, raw) {
    const base = this._base();
    if (topic.startsWith(base + '/presence/')) {
      const pid = topic.slice((base + '/presence/').length);
      if (this.isHost) {
        this.lastSeen.set(pid, Date.now());
        if (msg && msg.connected === false) {
          // 玩家主动退出
          this._sweepPlayer(pid);
        }
      }
      return;
    }
    if (topic === base + '/action') {
      if (this.isHost && this.engine) {
        const from = msg.from;
        if (msg.action === 'leave') return this._sweepPlayer(from);
        if (from) {
          this.lastSeen.set(from, Date.now());
          this.engine.handleAction(from, msg);
        }
      }
      return;
    }
    if (topic === base + '/state') {
      if (this.isHost) return; // 房主本地已通过 emitState 渲染
      if (!msg || msg.type !== 'state') return;
      if (msg.closed) {
        if (this.onMessage) this.onMessage({ type: 'error', message: '房主已解散房间' });
        setTimeout(() => location.reload(), 1500);
        return;
      }
      return this.onMessage && this.onMessage(msg);
    }
    if (topic === base + '/chat') {
      if (this.isHost) return; // 房主本地已通过 emitChat 渲染
      if (msg && msg.type === 'error') {
        if (msg.to === this.myId && this.onMessage) this.onMessage(msg);
        return;
      }
      return this.onMessage && this.onMessage({ type: 'chat', msg });
    }
  };

  MqttNet.prototype._sweepPlayer = function (pid) {
    if (!this.engine) return;
    this.lastSeen.delete(pid);
    this.engine.removePlayer(pid);
  };

  MqttNet.prototype._startPresenceSweep = function () {
    const t = setInterval(() => {
      const now = Date.now();
      for (const [pid, ts] of this.lastSeen) {
        if (pid === this.myId) continue;
        if (now - ts > OFFLINE_AFTER_MS) this._sweepPlayer(pid);
      }
    }, 3000);
    this.timers.push(t);
  };

  // ---------- 建房 ----------
  MqttNet.prototype.hostRoom = function (myId, hostName, maxPlayers) {
    const self = this;
    this.isHost = true;

    this.engine = window.GameCore.createGameEngine({
      hostId: myId,
      hostName,
      maxPlayers,
      emitState: (snap) => {
        self._pub('/state', snap, true);
        if (self.onMessage) self.onMessage(snap);
      },
      emitChat: (msg) => {
        self._pub('/chat', msg, false);
        if (self.onMessage) self.onMessage({ type: 'chat', msg });
      },
      emitError: (playerId, text) => {
        const msg = { type: 'error', to: playerId, message: text };
        self._pub('/chat', msg, false);
        if (playerId === self.myId && self.onMessage) self.onMessage(msg);
      },
    });

    this.roomCode = this.engine.room.code;

    this._afterConnect(() => {
      self._sub([self._base() + '/action', self._base() + '/presence/#']);
      self.engine.init(); // 加入房主自己并广播首份快照
      const hb = setInterval(() => {
        if (self.engine.room.phase !== 'closed') {
          self._pub('/state', self.engine.snapshot(), true); // retained 心跳
        }
      }, HEARTBEAT_MS);
      self.timers.push(hb);
      self._startPresenceSweep();
    });

    return this.roomCode;
  };

  // ---------- 加入 ----------
  MqttNet.prototype.joinRoom = function (myId, name, code) {
    const self = this;
    this.roomCode = code;
    return new Promise((resolve) => {
      let settled = false;

      this._afterConnect(() => {
        self._sub([self._base() + '/state']);

        const origOnMessage = self.onMessage;
        const probe = (msg) => {
          if (settled || !msg || msg.type !== 'state') return;
          if (msg.serverTime && Date.now() - msg.serverTime > OFFLINE_AFTER_MS + 3000) {
            finish({ ok: false, error: '房主已离开，房间已失效' });
            return;
          }
          self._pub('/action', { action: 'join', from: myId, name });
          self._pub('/presence/' + myId, { on: true }, false);
          const hb = setInterval(() => self._pub('/presence/' + myId, { on: true }, false), HEARTBEAT_MS);
          self.timers.push(hb);
          self._sub([self._base() + '/chat']);
          finish({ ok: true });
        };

        self.onMessage = (msg) => {
          probe(msg);
          if (settled && origOnMessage) origOnMessage(msg);
        };

        const timer = setTimeout(() => {
          finish({ ok: false, error: '房间不存在或已失效，请检查房间号' });
        }, 6000);
        function finish(r) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          self.onMessage = origOnMessage;
          resolve(r);
        }
      });
    });
  };

  // ---------- 发送动作 ----------
  MqttNet.prototype.send = function (obj) {
    if (this.isHost && this.engine) {
      this.engine.handleAction(this.myId, obj);
      return true;
    }
    if (this.roomCode && this.client && this.client.connected) {
      this._pub('/action', Object.assign({ from: this.myId }, obj), false);
      return true;
    }
    if (this.onMessage) this.onMessage({ type: 'error', message: '正在连接服务器，请稍候 1-2 秒再试…' });
    this.onStatus && this.onStatus('bad');
    return false;
  };

  // ---------- 离开/关闭 ----------
  MqttNet.prototype.leave = function () {
    if (this.isHost) {
      if (this.roomCode) this._pub('/state', { type: 'state', serverTime: Date.now(), closed: true }, true);
      if (this.engine) this.engine.dispose();
    } else if (this.roomCode) {
      this._pub('/action', { action: 'leave', from: this.myId }, false);
    }
    this.timers.forEach(clearInterval);
    this.timers = [];
    if (this.client) this.client.end(true);
  };

  window.MqttNet = MqttNet;
})();
