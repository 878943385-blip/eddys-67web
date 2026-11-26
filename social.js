/**
 * social.js — 账号 + 好友 + 私聊（GitHub Pages 静态版，无后端）
 *
 * 无服务器方案：全局账号注册表用 MQTT retained 主题充当"数据库"，
 * 密码只存 SHA-256 哈希，本机 localStorage 记住登录态。
 *
 * 主题：
 *   tod67web/registry        retained 全局账号表 {username: {h, name, ts, role?}}
 *   tod67web/banned          retained 封禁名单 {username: {reason, by, ts}}（管理员站维护）
 *   tod67web/questions       retained 动态题库 {truth:[], dare:[], updatedBy, ts}（管理员站维护，空载荷=清除）
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
  const BANNED_TOPIC = BASE + '/banned';
  const QUESTIONS_TOPIC = BASE + '/questions';
  const FRIENDS_PREFIX = BASE + '/friends/';   // retained：每个账号自己的好友列表 {list, ts}
  const DMHIST_PREFIX = BASE + '/dmhist/';     // retained：每个账号自己的私聊记录 {dms, ts}（仅自己订阅）
  const HB_MS = 5000;
  const OFFLINE_AFTER = 15000;
  const CONNECT_TIMEOUT = 9000;

  // 内置题库快照（questions.js 先于本文件加载）：管理员清除自定义题库时恢复用
  const BUILTIN_TRUTH = window.TRUTH_QUESTIONS || [];
  const BUILTIN_DARE = window.DARE_QUESTIONS || [];

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
    this.banned = null;          // 封禁名单（管理员站维护）
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
  SocialNet.prototype._saveFriends = function () { this._lsSet('tod67_friends_' + (this.user ? this.user.username : 'anon'), this.friends); };
  SocialNet.prototype._saveDMs = function () { this._lsSet('tod67_dms_' + (this.user ? this.user.username : 'anon'), this.dms); };

  // 云端同步：好友列表 / 私聊记录（retained，换设备、重登都不丢）
  SocialNet.prototype._publishFriends = function () {
    if (this.client && this.connected && this.user) {
      this.client.publish(
        FRIENDS_PREFIX + this.user.username,
        JSON.stringify({ list: this.friends, ts: Date.now() }),
        { qos: 0, retain: true }
      );
    }
  };
  SocialNet.prototype._publishDMs = function () {
    if (this.client && this.connected && this.user) {
      this.client.publish(
        DMHIST_PREFIX + this.user.username,
        JSON.stringify({ dms: this.dms, ts: Date.now() }),
        { qos: 0, retain: true }
      );
    }
  };

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
        client.subscribe([REG_TOPIC, BANNED_TOPIC, QUESTIONS_TOPIC, BASE + '/online/+', BASE + '/freq/+', BASE + '/fres/+'], { qos: 0 });
        // 延迟订阅自己的 dm 频道（需要 user，连接时可能还没登录）
        if (self.user) client.subscribe(BASE + '/dm/' + self.user.username, { qos: 0 });
        resolve();
      });
      client.on('reconnect', () => { self.connected = client.connected; });
      client.on('close', () => { self.connected = false; });
      client.on('message', (topic, payload) => {
        const raw = payload.toString();
        if (!raw) {
          // 空载荷 = 管理员清除了自定义题库 → 恢复内置题库
          if (topic === QUESTIONS_TOPIC) {
            window.TRUTH_QUESTIONS = BUILTIN_TRUTH;
            window.DARE_QUESTIONS = BUILTIN_DARE;
          }
          return;
        }
        let msg;
        try { msg = JSON.parse(raw); } catch (e) { return; }
        self._route(topic, msg);
      });
    });
    return this._connecting;
  };

  // 订阅自己的私聊/记录/好友列表/通话信令频道（登录后调用）
  SocialNet.prototype._subscribeDM = function () {
    if (this.client && this.connected && this.user) {
      this.client.subscribe(
        [
          BASE + '/dm/' + this.user.username,
          DMHIST_PREFIX + this.user.username,
          FRIENDS_PREFIX + this.user.username,
          BASE + '/call/' + this.user.username,
        ],
        { qos: 0 }
      );
    }
  };

  // ---------- 消息路由 ----------
  SocialNet.prototype._route = function (topic, msg) {
    if (topic === REG_TOPIC) {
      this.registry = msg || {};
      if (this.onRegistryChange) this.onRegistryChange(this.registry);
      return;
    }
    if (topic === BANNED_TOPIC) {
      this.banned = msg || {};
      return;
    }
    if (topic === QUESTIONS_TOPIC) {
      // 管理员站发布的动态题库：空载荷或字段缺失 = 恢复内置题库
      try {
        if (Array.isArray(msg.truth) && msg.truth.length) window.TRUTH_QUESTIONS = msg.truth;
        if (Array.isArray(msg.dare) && msg.dare.length) window.DARE_QUESTIONS = msg.dare;
      } catch (e) { /* ignore */ }
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
        this._publishFriends();
        this._notifyFriends();
      }
      if (this.onFriendResult) this.onFriendResult(msg);
      return;
    }
    if (topic.startsWith(DMHIST_PREFIX)) {
      const u = topic.slice(DMHIST_PREFIX.length);
      if (u === (this.user && this.user.username) && msg && msg.dms) {
        this._dmsCloudArrived = true;
        this.dms = msg.dms;
        this._saveDMs();
        if (this.onHistory) this.onHistory();
      }
      return;
    }
    if (topic.startsWith(FRIENDS_PREFIX)) {
      const u = topic.slice(FRIENDS_PREFIX.length);
      if (u === (this.user && this.user.username) && msg && Array.isArray(msg.list)) {
        this._friendsCloudArrived = true;
        this.friends = msg.list;
        this._saveFriends();
        this._notifyFriends();
      }
      return;
    }
    if (topic.startsWith(BASE + '/dm/')) {
      if (!msg || !msg.from || msg.from === (this.user && this.user.username)) return;
      const list = this.dms[msg.from] || (this.dms[msg.from] = []);
      list.push({ from: msg.from, name: msg.name || msg.from, text: msg.text, ts: msg.ts || Date.now(), mine: false });
      if (list.length > 200) list.splice(0, list.length - 200);
      this._saveDMs();
      this._publishDMs();
      const isOpen = this._dmOpenWith === msg.from;
      if (!isOpen) this.unread.set(msg.from, (this.unread.get(msg.from) || 0) + 1);
      if (this.onDM) this.onDM(msg, isOpen);
      this._notifyFriends();
      return;
    }
    if (topic.startsWith(BASE + '/call/')) {
      if (this.onCallSignal) this.onCallSignal(topic.slice((BASE + '/call/').length), msg);
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
    return this.connect().then(() => Promise.all([this._waitRegistry(), this._waitBanned()])).then(() => {
      if (self.isBanned(username)) throw self._banError(username);
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
    return this.connect().then(() => Promise.all([this._waitRegistry(), this._waitBanned()])).then(() => {
      if (self.isBanned(username)) throw self._banError(username);
      const entry = (self.registry || {})[username];
      if (!entry) throw new Error('用户名不存在，先注册一个吧');
      return sha256Hex('tod67:' + password).then((h) => {
        if (h !== entry.h) throw new Error('密码不对哦');
        return self._becomeUser({ username, name: entry.name || username });
      }).then((u) => self._waitCloudSocial().then(() => u));
    });
  };

  // 二合一：用户名不存在 → 注册；已存在 → 校验密码登录
  SocialNet.prototype.registerOrLogin = function (username, password) {
    const self = this;
    return this.connect()
      .then(() => this._waitRegistry())
      .then(() => {
        if ((self.registry || {})[username]) return self.login(username, password);
        return self.register(username, password);
      });
  };

  // 本机已有登录态时恢复（不重新校验密码，但校验封禁状态）
  SocialNet.prototype.resume = function (session) {
    const self = this;
    return this.connect()
      .then(() => Promise.all([this._waitRegistry(), this._waitBanned()]))
      .then(() => {
        if (session && self.isBanned(session.username)) throw self._banError(session.username);
        self.registry = self.registry || {};
        return self._becomeUser(session);
      })
      .then((u) => self._waitCloudSocial().then(() => u));
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

  // ---------- 封禁名单（管理员站维护） ----------
  SocialNet.prototype.isBanned = function (username) {
    return !!(this.banned && this.banned[username]);
  };

  // 等待封禁名单到达（retained，最多 2 秒；超时视为无名单）
  SocialNet.prototype._waitBanned = function () {
    const self = this;
    if (self.banned) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearInterval(poll);
        clearTimeout(timer);
        resolve();
      };
      const poll = setInterval(() => { if (self.banned) finish(); }, 100);
      const timer = setTimeout(finish, 2000);
    });
  };

  SocialNet.prototype._banError = function (username) {
    const info = this.banned && this.banned[username];
    const reason = info && info.reason ? '，理由：' + info.reason : '';
    return new Error('该账号已被管理员封禁' + reason);
  };

  SocialNet.prototype._becomeUser = function (session) {
    this.user = { username: session.username, name: session.name || session.username };
    this._lsSet('tod67_auth', this.user);
    // 旧版共享 key 迁移到按账号分 key（老用户升级无损）
    const legacyFriends = this._lsGet('tod67_friends', null);
    const legacyDms = this._lsGet('tod67_dms', null);
    const keyF = 'tod67_friends_' + this.user.username;
    const keyD = 'tod67_dms_' + this.user.username;
    if (legacyFriends && !this._lsGet(keyF, null)) this._lsSet(keyF, legacyFriends);
    if (legacyDms && !this._lsGet(keyD, null)) this._lsSet(keyD, legacyDms);
    this._friendsCloudArrived = false;
    this._dmsCloudArrived = false;
    this.friends = this._lsGet(keyF, []);
    this.dms = this._lsGet(keyD, {});
    this._subscribeDM();
    this._startHeartbeat();
    return this.user;
  };

  // 等云端好友列表与私聊记录到达（retained，最多 2.2 秒；超时用本地缓存）
  SocialNet.prototype._waitCloudSocial = function () {
    const self = this;
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearInterval(poll);
        clearTimeout(timer);
        resolve();
      };
      const poll = setInterval(() => {
        if (self._friendsCloudArrived && self._dmsCloudArrived) finish();
      }, 100);
      const timer = setTimeout(finish, 2200);
    });
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
      this._publishFriends();
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
      self._publishDMs();
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
      // 只清除登录态；好友与聊天记录按账号保留在本机 + 云端，重登/换设备都不丢
      localStorage.removeItem('tod67_auth');
    } catch (e) { /* ignore */ }
    this.user = null;
    this.friends = [];
    this.dms = {};
  };

  window.SocialNet = SocialNet;
})();
