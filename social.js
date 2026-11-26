/**
 * social.js — 账号 + 好友 + 私聊（GitHub Pages 静态版，无后端）
 *
 * 无服务器方案：全局账号注册表用 MQTT retained 主题充当"数据库"，
 * 密码只存 SHA-256 哈希，本机 localStorage 记住登录态。
 *
 * 主题：
 *   tod67web/registry        retained 全局账号表 {username: {h, name, ts}}
 *   tod67web/online/<user>   在线心跳 {ts}，离线广播 {on:false}
 *   tod67web/freq/<target>   好友申请 {from, name, ts}
 *   tod67web/fres/<target>   好友回复 {from, name, ok, ts}
 *   tod67web/dm/<user>       私聊消息 {from, name, text, ts}
 */
(function () {
  'use strict';

  const BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081',
  ];
  const BASE = 'tod67web';
  const REG_TOPIC = BASE + '/registry';
  const HB_MS = 5000;
  const OFFLINE_AFTER = 15000;
  const CONNECT_TIMEOUT = 9000;

  function sha256Hex(text) {
    try {
      if (typeof crypto !== 'undefined' && crypto.subtle) {
        return crypto.subtle
          .digest('SHA-256', new TextEncoder().encode(text))
          .then((buf) =>
            Array.from(new Uint8Array(buf))
              .map((b) => b.toString(16).padStart(2, '0'))
              .join('')
          );
      }
    } catch (e) { /* fall through */ }
    return Promise.resolve('fb' + simpleHash(text));
  }
  function simpleHash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(16);
  }

  function SocialNet() {
    this.client = null;
    this.brokerIdx = 0;
    this.user = null;            // {username, name}
    this.registry = null;        // 全局账号表
    this.friends = [];           // [{username, name}]
    this.online = new Map();     // username -> 最后心跳 ts
    this.dms = {};               // friendUsername -> [{from, name, text, ts, mine}]
    this.unread = new Map();     // friendUsername -> 未读数
    this.timers = [];
    this.connected = false;
    this.notifyPending = false;
    this.onFriends = null;       // () => void，好友列表/在线状态变化
    this.onDM = null;            // ({from, name, text, ts})
    this.onFriendRequest = null; // ({from, name, ts})
    this.onFriendResult = null;  // ({from, name, ok})
    this.onRegistryChange = null;
  }

  // ---------- localStorage ----------
  SocialNet.prototype._lsGet = function (key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  };
  SocialNet.prototype._lsSet = function (key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* ignore */ }
  };

  SocialNet.prototype.loadSession = function () {
    return this._lsGet('tod67_auth', null);
  };
  SocialNet.prototype._saveFriends = function () { this._lsSet('tod67_friends', this.friends); };
  SocialNet.prototype._saveDMs = function () { this._lsSet('tod67_dms', this.dms); };

  // ---------- 连接（broker 故障转移） ----------
  SocialNet.prototype.connect = function () {
    if (this.connected) return Promise.resolve();
    if (this._connecting) return this._connecting;
    const self = this;
    const url = BROKERS[this.brokerIdx];

    this._connecting = new Promise((resolve, reject) => {
      let clientId = 'soc' + Date.now().toString(36) + Math.floor(Math.random() * 99999);
      let client;
      try {
        client = mqtt.connect(url, { clientId, keepalive: 30, reconnectPeriod: 2500, connectTimeout: 8000, clean: true });
      } catch (e) { return fail(); }
      this.client = client;

      const timer = setTimeout(() => { if (!client.connected) { client.end(true); fail(); } }, CONNECT_TIMEOUT);

      function fail() {
        clearTimeout(timer);
        self.brokerIdx += 1;
        self._connecting = null;
        if (self.brokerIdx < BROKERS.length) {
          self.connect().then(resolve, reject);
        } else {
          reject(new Error('无法连接消息服务器，请检查网络后刷新页面'));
        }
      }

      client.on('connect', () => {
        clearTimeout(timer);
        self.connected = true;
        client.subscribe([REG_TOPIC, BASE + '/online/+', BASE + '/freq/+', BASE + '/fres/+'], { qos: 0 });
        // 延迟订阅自己的 dm 频道（需要 user，连接时可能还没登录）
        if (self.user) client.subscribe(BASE + '/dm/' + self.user.username, { qos: 0 });
        resolve();
      });
      client.on('reconnect', () => { self.connected = client.connected; });
      client.on('close', () => { self.connected = false; });
      client.on('message', (topic, payload) => {
        let msg;
        try { msg = JSON.parse(payload.toString()); } catch (e) { return; }
        self._route(topic, msg);
      });
    });
    return this._connecting;
  };

  // 订阅自己的私聊频道（登录后调用）
  SocialNet.prototype._subscribeDM = function () {
    if (this.client && this.connected && this.user) {
      this.client.subscribe(BASE + '/dm/' + this.user.username, { qos: 0 });
    }
  };

  // ---------- 消息路由 ----------
  SocialNet.prototype._route = function (topic, msg) {
    if (topic === REG_TOPIC) {
      this.registry = msg || {};
      if (this.onRegistryChange) this.onRegistryChange(this.registry);
      return;
    }
    if (topic.startsWith(BASE + '/online/')) {
      const username = topic.slice((BASE + '/online/').length);
      if (!username || username === (this.user && this.user.username)) return;
      if (msg && msg.on === false) this.online.delete(username);
      else this.online.set(username, Date.now());
      this._notifyFriends();
      return;
    }
    if (topic.startsWith(BASE + '/freq/')) {
      if (!msg || !msg.from) return;
      if (msg.from === (this.user && this.user.username)) return;
      // 已经是好友就自动回执，不弹窗
      if (this.friends.some((f) => f.username === msg.from)) return;
      if (this.onFriendRequest) this.onFriendRequest(msg);
      return;
    }
    if (topic.startsWith(BASE + '/fres/')) {
      if (!msg || !msg.from || msg.from === (this.user && this.user.username)) return;
      if (msg.ok && !this.friends.some((f) => f.username === msg.from)) {
        this.friends.push({ username: msg.from, name: msg.name || msg.from });
        this._saveFriends();
        this._notifyFriends();
      }
      if (this.onFriendResult) this.onFriendResult(msg);
      return;
    }
    if (topic.startsWith(BASE + '/dm/')) {
      if (!msg || !msg.from || msg.from === (this.user && this.user.username)) return;
      const list = this.dms[msg.from] || (this.dms[msg.from] = []);
      list.push({ from: msg.from, name: msg.name || msg.from, text: msg.text, ts: msg.ts || Date.now(), mine: false });
      if (list.length > 200) list.splice(0, list.length - 200);
      this._saveDMs();
      const isOpen = this._dmOpenWith === msg.from;
      if (!isOpen) this.unread.set(msg.from, (this.unread.get(msg.from) || 0) + 1);
      if (this.onDM) this.onDM(msg, isOpen);
      this._notifyFriends();
      return;
    }
  };

  SocialNet.prototype._notifyFriends = function () {
    if (this.notifyPending) return;
    this.notifyPending = true;
    setTimeout(() => {
      this.notifyPending = false;
      if (this.onFriends) this.onFriends();
      // 清理过期在线状态
      const now = Date.now();
      let changed = false;
      for (const [u, ts] of this.online) {
        if (now - ts > OFFLINE_AFTER) { this.online.delete(u); changed = true; }
      }
      if (changed && this.onFriends) this.onFriends();
    }, 400);
  };

  SocialNet.prototype.onlineOf = function (username) {
    const ts = this.online.get(username);
    return ts && Date.now() - ts <= OFFLINE_AFTER;
  };

  // ---------- 注册 / 登录 ----------
  function validateUsername(u) {
    if (!u || u.length < 2 || u.length > 12) return '用户名需要 2-12 个字符';
    return null;
  }

  SocialNet.prototype.register = function (username, password) {
    const err = validateUsername(username);
    if (err) return Promise.reject(new Error(err));
    if (!password || password.length < 4) return Promise.reject(new Error('密码至少 4 位'));
    const self = this;
    return this.connect().then(() => this._waitRegistry()).then(() => {
      const reg = self.registry || {};
      if (reg[username]) throw new Error('这个用户名已经被注册了，换一个或直接登录');
      return sha256Hex('tod67:' + password).then((h) => {
        reg[username] = { h, name: username, ts: Date.now() };
        self.client.publish(REG_TOPIC, JSON.stringify(reg), { qos: 0, retain: true });
        self.registry = reg;
        return self._becomeUser({ username, name: username });
      });
    });
  };

  SocialNet.prototype.login = function (username, password) {
    const err = validateUsername(username);
    if (err) return Promise.reject(new Error(err));
    const self = this;
    return this.connect().then(() => this._waitRegistry()).then(() => {
      const entry = (self.registry || {})[username];
      if (!entry) throw new Error('用户名不存在，先注册一个吧');
      return sha256Hex('tod67:' + password).then((h) => {
        if (h !== entry.h) throw new Error('密码不对哦');
        return self._becomeUser({ username, name: entry.name || username });
      });
    });
  };

  // 本机已有登录态时恢复（不重新校验密码）
  SocialNet.prototype.resume = function (session) {
    const self = this;
    return this.connect().then(() => {
      self.registry = self.registry || {};
      return self._becomeUser(session);
    });
  };

  SocialNet.prototype._waitRegistry = function () {
    const self = this;
    if (self.registry) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(), 4000); // 空注册表（第一个用户）
      const orig = self.onRegistryChange;
      self.onRegistryChange = () => {
        clearTimeout(timer);
        self.onRegistryChange = orig;
        resolve();
      };
    });
  };

  SocialNet.prototype._becomeUser = function (session) {
    this.user = { username: session.username, name: session.name || session.username };
    this._lsSet('tod67_auth', this.user);
    this.friends = this._lsGet('tod67_friends', []);
    this.dms = this._lsGet('tod67_dms', {});
    this._subscribeDM();
    this._startHeartbeat();
    return this.user;
  };

  SocialNet.prototype._startHeartbeat = function () {
    const self = this;
    this._stopHeartbeat();
    const pub = (obj) => {
      if (self.client && self.connected && self.user) {
        self.client.publish(BASE + '/online/' + self.user.username, JSON.stringify(obj), { qos: 0 });
      }
    };
    pub({ ts: Date.now() });
    const hb = setInterval(() => pub({ ts: Date.now() }), HB_MS);
    this._hbTimer = hb;
    this.timers.push(hb);
  };
  SocialNet.prototype._stopHeartbeat = function () {
    if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null; }
  };

  // 页面关闭时广播离线
  SocialNet.prototype.announceOffline = function () {
    if (this.client && this.connected && this.user) {
      this.client.publish(BASE + '/online/' + this.user.username, JSON.stringify({ on: false }), { qos: 0 });
    }
  };

  // ---------- 改名 ----------
  SocialNet.prototype.changeName = function (newName) {
    const err = validateUsername(newName);
    if (err) return Promise.reject(new Error('名字' + err.slice(3)));
    const self = this;
    return this.connect().then(() => {
      const reg = self.registry || {};
      const entry = reg[self.user.username];
      if (!entry) throw new Error('账号信息异常，请重新登录');
      entry.name = newName;
      entry.ts = Date.now();
      self.client.publish(REG_TOPIC, JSON.stringify(reg), { qos: 0, retain: true });
      self.user.name = newName;
      self._lsSet('tod67_auth', self.user);
      return self.user;
    });
  };

  // ---------- 好友 ----------
  SocialNet.prototype.searchUser = function (username) {
    const entry = (this.registry || {})[username];
    return {
      exists: !!entry,
      name: entry ? entry.name || username : null,
      online: entry ? this.onlineOf(username) : false,
    };
  };

  SocialNet.prototype.addFriend = function (username) {
    const self = this;
    if (username === (this.user && this.user.username)) {
      return Promise.reject(new Error('不能加自己为好友'));
    }
    if (this.friends.some((f) => f.username === username)) {
      return Promise.reject(new Error('已经是好友了'));
    }
    const entry = (this.registry || {})[username];
    if (!entry) return Promise.reject(new Error('用户名不存在'));
    return this.connect().then(() => {
      self.client.publish(
        BASE + '/freq/' + username,
        JSON.stringify({ from: self.user.username, name: self.user.name, ts: Date.now() }),
        { qos: 0 }
      );
      return true;
    });
  };

  SocialNet.prototype.acceptFriend = function (from, fromName) {
    const self = this;
    if (!this.friends.some((f) => f.username === from)) {
      this.friends.push({ username: from, name: fromName || from });
      this._saveFriends();
      this._notifyFriends();
    }
    return this.connect().then(() => {
      self.client.publish(
        BASE + '/fres/' + from,
        JSON.stringify({ from: self.user.username, name: self.user.name, ok: true, ts: Date.now() }),
        { qos: 0 }
      );
      return true;
    });
  };

  SocialNet.prototype.declineFriend = function (from) {
    const self = this;
    return this.connect().then(() => {
      self.client.publish(
        BASE + '/fres/' + from,
        JSON.stringify({ from: self.user.username, name: self.user.name, ok: false, ts: Date.now() }),
        { qos: 0 }
      );
      return true;
    });
  };

  // ---------- 私聊 ----------
  SocialNet.prototype.dmHistory = function (friend) {
    return this.dms[friend] || [];
  };

  SocialNet.prototype.sendDM = function (friend, text) {
    const self = this;
    if (!text || !text.trim()) return Promise.reject(new Error('消息不能为空'));
    const msg = { from: this.user.username, name: this.user.name, text: text.trim(), ts: Date.now() };
    const list = this.dms[friend] || (this.dms[friend] = []);
    list.push({ from: msg.from, name: msg.name, text: msg.text, ts: msg.ts, mine: true });
    if (list.length > 200) list.splice(0, list.length - 200);
    this._saveDMs();
    return this.connect().then(() => {
      self.client.publish(BASE + '/dm/' + friend, JSON.stringify(msg), { qos: 0 });
      return true;
    });
  };

  SocialNet.prototype.clearUnread = function (friend) {
    this.unread.delete(friend);
    this._dmOpenWith = friend;
  };

  SocialNet.prototype.closeDM = function () {
    this._dmOpenWith = null;
  };

  SocialNet.prototype.logout = function () {
    this.announceOffline();
    this._stopHeartbeat();
    try {
      localStorage.removeItem('tod67_auth');
      // 好友和聊天记录也一并清掉（跟随账号）
      localStorage.removeItem('tod67_friends');
      localStorage.removeItem('tod67_dms');
    } catch (e) { /* ignore */ }
    this.user = null;
    this.friends = [];
    this.dms = {};
  };

  window.SocialNet = SocialNet;
})();
