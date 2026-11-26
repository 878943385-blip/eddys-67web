/**
 * call.js — 好友语音/视频通话（WebRTC P2P + MQTT 信令）
 *
 * 信令走 tod67web/call/<username>（非 retained，仅双方各自订阅自己的主题）：
 *   invite  {from, name, kind}          呼叫方 → 被叫（被叫弹大来电通知+铃声）
 *   accept  {from}                      被叫同意 → 呼叫方开始建连
 *   offer   {from, sdp}                 呼叫方 WebRTC offer
 *   answer  {from, sdp}                 被叫 WebRTC answer
 *   ice     {from, candidate}           双方 ICE 候选（trickle）
 *   reject  {from, reason}              拒绝/忙线
 *   hangup  {from}                      挂断
 *
 * 只有当对方"人在网页上"（在线心跳活跃）才可能收到 invite —— 离线不响铃。
 */
(function () {
  'use strict';

  const BASE = 'tod67web';
  const CALL_PREFIX = BASE + '/call/';
  const ICE_SERVERS = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
  ];
  const RING_TIMEOUT = 45000;

  function CallManager(opts) {
    this.social = opts.social;
    this.getName = opts.getName || (() => '玩家');
    this.headless = !!opts.headless; // Node 测试模式：不构建 DOM
    this.state = 'idle'; // idle | outgoing | incoming | active
    this.kind = null; // audio | video
    this.peer = null; // {username, name}
    this.pc = null;
    this.localStream = null;
    this.pendingIce = [];
    this.muted = false;
    this.camOff = false;
    this.timers = [];
    this._ringAudio = null;

    if (this.headless) {
      // 万能空 UI 桩：任意属性读/写/调用都不报错
      const handler = {
        get(target, prop) {
          if (prop === 'style') return new Proxy({}, handler);
          if (!(prop in target)) target[prop] = new Proxy(function () {}, handler);
          return target[prop];
        },
        set() { return true; },
        apply() { return undefined; },
      };
      this.ui = new Proxy({}, handler);
    } else {
      this._buildUI();
    }

    const self = this;
    this.social.onCallSignal = (topicSuffix, msg) => self._onSignal(topicSuffix, msg);
  }

  // ---------- 基础 ----------
  CallManager.prototype._send = function (target, payload) {
    const self = this;
    return this.social.connect().then(() => {
      payload.from = self.social.user ? self.social.user.username : '';
      payload.to = target;
      self.social.client.publish(CALL_PREFIX + target, JSON.stringify(payload), { qos: 0 });
    });
  };

  CallManager.prototype._timer = function (fn, ms) {
    const t = setTimeout(fn, ms);
    this.timers.push(t);
    return t;
  };
  CallManager.prototype._clearTimers = function () {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers = [];
  };

  // ---------- 铃声（WebAudio 生成，无音频文件） ----------
  CallManager.prototype._startRing = function (mode) {
    this._stopRing();
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      if (ctx.resume) ctx.resume().catch(() => {});
      const master = ctx.createGain();
      master.gain.value = 0.0;
      master.connect(ctx.destination);
      let beep = null;
      if (mode === 'incoming') {
        // 被叫铃：微信式双音，响 0.9s 停 1.1s
        beep = setInterval(() => {
          [0, 0.35].forEach((off) => {
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.type = 'sine';
            o.frequency.value = 830;
            o.connect(g); g.connect(master);
            const t0 = ctx.currentTime + off;
            g.gain.setValueAtTime(0.0001, t0);
            g.gain.exponentialRampToValueAtTime(0.35, t0 + 0.03);
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3);
            o.start(t0); o.stop(t0 + 0.32);
          });
        }, 2000);
        master.gain.value = 1;
      } else {
        // 呼叫方回铃：单音 1s，停 3s
        beep = setInterval(() => {
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.type = 'sine';
          o.frequency.value = 460;
          o.connect(g); g.connect(master);
          const t0 = ctx.currentTime;
          g.gain.setValueAtTime(0.0001, t0);
          g.gain.exponentialRampToValueAtTime(0.18, t0 + 0.05);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.9);
          o.start(t0); o.stop(t0 + 1);
        }, 3000);
        master.gain.value = 1;
      }
      this._ringAudio = { ctx, beep, master };
    } catch (e) { /* 铃声失败不影响通话 */ }
  };
  CallManager.prototype._stopRing = function () {
    if (this._ringAudio) {
      try { clearInterval(this._ringAudio.beep); this._ringAudio.ctx.close(); } catch (e) { /* ignore */ }
      this._ringAudio = null;
    }
  };

  // ---------- UI ----------
  CallManager.prototype._buildUI = function () {
    const wrap = document.createElement('div');
    wrap.id = 'call-overlay';
    wrap.style.display = 'none';
    wrap.innerHTML = `
      <div class="call-stage" id="call-stage-audio">
        <div class="call-avatar" id="call-avatar">👤</div>
        <div class="call-name" id="call-peer-name"></div>
        <div class="call-status" id="call-status"></div>
        <div class="call-actions" id="call-actions-incoming">
          <button id="call-decline" class="call-btn danger">✕ 拒绝</button>
          <button id="call-accept" class="call-btn ok">✅ 接听</button>
        </div>
        <div class="call-actions" id="call-actions-outgoing">
          <button id="call-cancel" class="call-btn danger">✕ 取消</button>
        </div>
        <div class="call-actions" id="call-actions-active">
          <button id="call-mute" class="call-btn neutral">🎤 麦克风</button>
          <button id="call-camera" class="call-btn neutral" style="display:none">📷 摄像头</button>
          <button id="call-hangup" class="call-btn danger">📞 挂断</button>
        </div>
      </div>
      <video id="call-remote-video" class="call-remote-video" autoplay playsinline style="display:none"></video>
      <video id="call-local-video" class="call-local-video" autoplay playsinline muted style="display:none"></video>`;
    document.body.appendChild(wrap);

    const $ = (id) => document.getElementById(id);
    this.ui = {
      overlay: $('call-overlay'),
      avatar: $('call-avatar'),
      peerName: $('call-peer-name'),
      status: $('call-status'),
      actionsIncoming: $('call-actions-incoming'),
      actionsOutgoing: $('call-actions-outgoing'),
      actionsActive: $('call-actions-active'),
      acceptBtn: $('call-accept'),
      declineBtn: $('call-decline'),
      cancelBtn: $('call-cancel'),
      muteBtn: $('call-mute'),
      cameraBtn: $('call-camera'),
      hangupBtn: $('call-hangup'),
      remoteVideo: $('call-remote-video'),
      localVideo: $('call-local-video'),
    };

    const self = this;
    this.ui.acceptBtn.addEventListener('click', () => self._accept());
    this.ui.declineBtn.addEventListener('click', () => self._decline(''));
    this.ui.cancelBtn.addEventListener('click', () => self._cancel(''));
    this.ui.hangupBtn.addEventListener('click', () => self.endCall());
    this.ui.muteBtn.addEventListener('click', () => {
      self.muted = !self.muted;
      if (self.localStream) self.localStream.getAudioTracks().forEach((t) => (t.enabled = !self.muted));
      self.ui.muteBtn.textContent = self.muted ? '🔇 已静音' : '🎤 麦克风';
      self.ui.muteBtn.classList.toggle('off', self.muted);
    });
    this.ui.cameraBtn.addEventListener('click', () => {
      self.camOff = !self.camOff;
      if (self.localStream) self.localStream.getVideoTracks().forEach((t) => (t.enabled = !self.camOff));
      self.ui.cameraBtn.textContent = self.camOff ? '📷 已关闭' : '📷 摄像头';
      self.ui.cameraBtn.classList.toggle('off', self.camOff);
      self.ui.localVideo.style.display = self.camOff ? 'none' : 'block';
    });
  };

  CallManager.prototype._render = function () {
    const u = this.ui;
    u.overlay.style.display = this.state === 'idle' ? 'none' : 'flex';
    if (this.state === 'idle') return;
    u.peerName.textContent = this.peer ? this.peer.name || this.peer.username : '';
    u.avatar.textContent = this.kind === 'video' ? '🎥' : '📞';
    u.actionsIncoming.style.display = this.state === 'incoming' ? 'flex' : 'none';
    u.actionsOutgoing.style.display = this.state === 'outgoing' ? 'flex' : 'none';
    u.actionsActive.style.display = this.state === 'active' ? 'flex' : 'none';
    u.remoteVideo.style.display = this.state === 'active' && this.kind === 'video' ? 'block' : 'none';
    u.localVideo.style.display = this.state === 'active' && this.kind === 'video' && !this.camOff ? 'block' : 'none';
    if (this.state === 'incoming') u.status.textContent = this.kind === 'video' ? '邀请你视频通话…' : '邀请你语音通话…';
    else if (this.state === 'outgoing') u.status.textContent = '正在呼叫，等待接听…';
    else if (this.state === 'active') u.status.textContent = '已接通';
  };

  CallManager.prototype._setStatus = function (text) {
    this.ui.status.textContent = text;
  };

  // ---------- 呼叫入口 ----------
  CallManager.prototype.startCall = function (username, name, kind) {
    if (this.state !== 'idle') return Promise.reject(new Error('正在通话中，先挂断再拨'));
    if (!this.social.user) return Promise.reject(new Error('请先登录'));
    if (!this.social.onlineOf(username)) return Promise.reject(new Error('对方不在线，无法呼叫'));

    this.state = 'outgoing';
    this.kind = kind;
    this.peer = { username, name: name || username };
    this.muted = false;
    this.camOff = false;
    this._render();
    this._startRing('ringback');
    this._timer(() => {
      if (this.state === 'outgoing') this._cancel('对方无应答');
    }, RING_TIMEOUT);
    return this._send(username, { t: 'invite', name: this.getName(), kind });
  };

  CallManager.prototype._accept = function () {
    if (this.state !== 'incoming') return;
    this._stopRing();
    this._clearTimers();
    this.state = 'active';
    this._render();
    this._setStatus('正在连接…');
    this._send(this.peer.username, { t: 'accept' });
  };

  CallManager.prototype._decline = function (reason) {
    if (this.peer) this._send(this.peer.username, { t: 'reject', reason: reason || '' });
    this.endCall(false);
  };

  CallManager.prototype._cancel = function (notice) {
    if (this.peer) this._send(this.peer.username, { t: 'reject', reason: notice || '对方取消了呼叫' });
    if (notice) this._toastSafe(notice);
    this.endCall(false);
  };

  CallManager.prototype.endCall = function (notifyPeer) {
    if (notifyPeer !== false && this.state !== 'idle' && this.peer) {
      this._send(this.peer.username, { t: 'hangup' });
    }
    this._teardown();
  };

  CallManager.prototype._teardown = function () {
    this._clearTimers();
    this._stopRing();
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }
    if (this.pc) {
      try { this.pc.close(); } catch (e) { /* ignore */ }
      this.pc = null;
    }
    this.pendingIce = [];
    this.ui.remoteVideo.srcObject = null;
    this.ui.localVideo.srcObject = null;
    this.ui.muteBtn.textContent = '🎤 麦克风';
    this.ui.cameraBtn.textContent = '📷 摄像头';
    this.peer = null;
    this.kind = null;
    this.state = 'idle';
    this._render();
  };

  CallManager.prototype._toastSafe = function (text) {
    if (this.headless || typeof document === 'undefined') {
      console.log('[call-toast]', text);
      return;
    }
    const el = document.getElementById('toast');
    if (el && typeof el.style !== 'undefined') {
      el.textContent = text;
      el.style.display = 'block';
      el.style.background = 'rgba(62,42,28,.92)';
      setTimeout(() => (el.style.display = 'none'), 2600);
    }
  };

  // ---------- WebRTC ----------
  CallManager.prototype._media = function () {
    const constraints = { audio: true, video: this.kind === 'video' ? { facingMode: 'user', width: { ideal: 1280 } } : false };
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      return navigator.mediaDevices.getUserMedia(constraints);
    }
    return Promise.reject(new Error('当前浏览器不支持采集麦克风/摄像头'));
  };

  CallManager.prototype._setupPC = function () {
    const self = this;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.onicecandidate = (e) => {
      if (e.candidate) self._send(self.peer.username, { t: 'ice', candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate });
    };
    pc.ontrack = (e) => {
      self.ui.remoteVideo.srcObject = e.streams[0];
      self.ui.remoteVideo.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].indexOf(pc.connectionState) !== -1 && self.state === 'active') {
        self._toastSafe('通话连接已断开');
        self.endCall();
      }
    };
    if (this.localStream) this.localStream.getTracks().forEach((t) => pc.addTrack(t, this.localStream));
    this.pc = pc;
    return pc;
  };

  CallManager.prototype._drainIce = function () {
    const pc = this.pc;
    if (!pc) return;
    const list = this.pendingIce;
    this.pendingIce = [];
    list.forEach((c) => pc.addIceCandidate(c).catch(() => {}));
  };

  // ---------- 信令处理 ----------
  CallManager.prototype._onSignal = function (targetUser, msg) {
    if (!msg || !msg.t) return;
    if (msg.to !== (this.social.user && this.social.user.username)) return;
    if (this.state !== 'idle' && msg.from !== (this.peer && this.peer.username) && msg.t !== 'invite') return;

    const self = this;
    switch (msg.t) {
      case 'invite': {
        if (this.state !== 'idle') {
          this._send(msg.from, { t: 'reject', reason: '对方正在通话中，请稍后再拨' });
          return;
        }
        this.state = 'incoming';
        this.kind = msg.kind === 'video' ? 'video' : 'audio';
        this.peer = { username: msg.from, name: msg.name || msg.from };
        this._render();
        this._startRing('incoming');
        this._timer(() => {
          if (this.state === 'incoming') {
            this._send(this.peer.username, { t: 'reject', reason: '无应答' });
            this.endCall(false);
          }
        }, RING_TIMEOUT);
        break;
      }
      case 'accept': {
        if (this.state !== 'outgoing') return;
        this._stopRing();
        this._clearTimers();
        this._setStatus('对方已接听，正在连接…');
        this._media()
          .then((stream) => {
            self.localStream = stream;
            self.ui.localVideo.srcObject = stream;
            const pc = self._setupPC();
            return pc.createOffer().then((offer) => {
              pc.setLocalDescription(offer);
              return self._send(self.peer.username, { t: 'offer', sdp: { type: offer.type, sdp: offer.sdp } });
            });
          })
          .catch((err) => {
            self._toastSafe('无法访问麦克风/摄像头：' + err.message);
            self._send(self.peer.username, { t: 'reject', reason: '呼叫方设备问题' });
            self.endCall(false);
          });
        break;
      }
      case 'offer': {
        if (this.state !== 'active') return;
        this._media()
          .then((stream) => {
            self.localStream = stream;
            self.ui.localVideo.srcObject = stream;
            const pc = self._setupPC();
            return pc.setRemoteDescription(new RTCSessionDescription(msg.sdp)).then(() => {
              self._drainIce();
              return pc.createAnswer();
            }).then((answer) => {
              pc.setLocalDescription(answer);
              return self._send(self.peer.username, { t: 'answer', sdp: { type: answer.type, sdp: answer.sdp } });
            });
          })
          .catch((err) => {
            self._toastSafe('无法访问麦克风/摄像头：' + err.message);
            self._send(self.peer.username, { t: 'reject', reason: '被叫方设备问题' });
            self.endCall(false);
          });
        break;
      }
      case 'answer': {
        if (this.state !== 'active' && this.state !== 'outgoing') return;
        this.state = 'active';
        this._render();
        if (this.pc) {
          this.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp)).then(() => self._drainIce()).catch(() => {});
        }
        break;
      }
      case 'ice': {
        if (this.pc) this.pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
        else this.pendingIce.push(msg.candidate);
        break;
      }
      case 'reject': {
        const reason = msg.reason || '对方拒绝了通话';
        if (this.state === 'outgoing' || this.state === 'incoming') {
          this._toastSafe(reason);
          this.endCall(false);
        }
        break;
      }
      case 'hangup': {
        if (this.state !== 'idle') {
          this._toastSafe('对方已挂断');
          this.endCall(false);
        }
        break;
      }
    }
  };

  window.CallManager = CallManager;
})();
