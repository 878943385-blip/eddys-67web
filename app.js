/* 真心话大冒险 — GitHub Pages 静态版客户端 */
(function () {
  'use strict';

  // ---------- 状态 ----------
  let myId = null;
  let state = null; // 服务器同步的房间快照
  let myChoice = null;
  let selectedQtype = 'truth';
  let selectedBankText = '';
  let chatCache = [];
  let countdownRAF = null;
  let bankPool = [];
  let isHostMode = false;
  let staleWarned = false;

  const net = new MqttNet();
  const social = new SocialNet();
  let account = null; // {username, name}

  const $ = (id) => document.getElementById(id);

  const CHOICE_EMOJI = { rock: '✊', scissors: '✌️', paper: '✋' };

  // ---------- 工具 ----------
  let toastTimer = null;
  function toast(text, isError) {
    const el = $('toast');
    el.textContent = text;
    el.style.display = 'block';
    el.style.background = isError ? 'rgba(200,40,40,.92)' : 'rgba(62,42,28,.92)';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.style.display = 'none'), 2600);
  }

  function esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // ---------- 传输 ----------
  function setConnStatus(st) {
    const dot = $('conn-dot');
    const text = $('conn-text');
    dot.classList.remove('ok', 'bad');
    if (st === 'ok') { dot.classList.add('ok'); text.textContent = '已连接'; }
    else if (st === 'bad') { dot.classList.add('bad'); text.textContent = '连接失败，重试中…'; }
    else { text.textContent = '连接中…'; }
  }

  function handleMsg(msg) {
    if (!msg) return;
    switch (msg.type) {
      case 'state':
        // 玩家模式：检测房主是否掉线
        if (!isHostMode && msg.serverTime && Date.now() - msg.serverTime > 15000 && !staleWarned) {
          staleWarned = true;
          toast('房主已离开，房间失效，即将返回首页…', true);
          setTimeout(() => location.reload(), 2000);
          return;
        }
        if (msg.serverTime && Date.now() - msg.serverTime <= 15000) staleWarned = false;
        state = msg;
        render();
        break;
      case 'chat':
        chatCache.push(msg.msg);
        if (chatCache.length > 100) chatCache.shift();
        renderChat();
        break;
      case 'error':
        toast(msg.message, true);
        break;
    }
  }

  net.onMessage = handleMsg;
  net.onStatus = setConnStatus;

  function send(obj) {
    return net.send(obj);
  }

  // ---------- 首页 ----------
  let homeTab = 'create';
  let selectedMaxPlayers = 12;

  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      homeTab = t.dataset.tab;
      $('code-field').style.display = homeTab === 'join' ? 'block' : 'none';
      $('enter-btn').textContent = homeTab === 'join' ? '加入房间' : '下一步：设置房间';
      $('home-error').textContent = '';
    });
  });

  $('enter-btn').addEventListener('click', () => {
    if (homeTab === 'join') {
      const code = $('code-input').value.trim();
      if (!/^\d{4}$/.test(code)) return showError('home-error', '房间号是 4 位数字');
      $('enter-btn').disabled = true;
      $('enter-btn').textContent = '连接中…';
      net.connect(myId, async () => {
        const res = await net.joinRoom(myId, account.name, code);
        $('enter-btn').disabled = false;
        $('enter-btn').textContent = '加入房间';
        if (!res.ok) {
          showError('home-error', res.error);
          net.leave();
          net.connect(myId, () => {});
        }
      });
    } else {
      $('step2-nick').textContent = account.name;
      $('home-step1').style.display = 'none';
      $('home-step2').style.display = 'block';
    }
  });
  $('code-input').addEventListener('keydown', (e) => e.key === 'Enter' && $('enter-btn').click());

  document.querySelectorAll('.mp-btn').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.mp-btn').forEach((x) => x.classList.remove('selected'));
      b.classList.add('selected');
      selectedMaxPlayers = parseInt(b.dataset.mp, 10);
    });
  });

  $('confirm-create-btn').addEventListener('click', () => {
    $('confirm-create-btn').disabled = true;
    $('confirm-create-btn').textContent = '正在开房…';
    net.connect(myId, () => {
      isHostMode = true;
      net.hostRoom(myId, account.name, selectedMaxPlayers);
      $('confirm-create-btn').disabled = false;
      $('confirm-create-btn').textContent = '✅ 确认创建房间';
    });
  });

  $('back-step1-btn').addEventListener('click', () => {
    $('home-step2').style.display = 'none';
    $('home-step1').style.display = 'block';
  });

  function showError(id, text) {
    $(id).textContent = text;
    setTimeout(() => ($(id).textContent = ''), 4000);
  }

  // ---------- 房间操作 ----------
  $('copy-code').addEventListener('click', () => {
    if (!state) return;
    const text = `【真心话大冒险】邀请你加入房间，房间号：${state.code}，链接：${location.origin}${location.pathname}`;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => toast('邀请已复制，发给朋友吧！'));
    } else {
      prompt('复制以下内容发给朋友：', text);
    }
  });

  $('leave-btn').addEventListener('click', () => {
    net.leave();
    location.reload();
  });

  // 页面关闭时通知
  window.addEventListener('pagehide', () => {
    net.leave();
    social.announceOffline();
  });

  $('start-btn').addEventListener('click', () => send({ action: 'start' }));

  document.querySelectorAll('.rps-btn').forEach((b) => {
    b.addEventListener('click', () => {
      const choice = b.dataset.choice;
      myChoice = choice;
      send({ action: 'choice', choice });
    });
  });

  $('vote-restart').addEventListener('click', () => send({ action: 'vote_restart' }));

  $('next-round-btn').addEventListener('click', () => send({ action: 'next_round' }));

  $('chat-send').addEventListener('click', sendChat);
  $('chat-input').addEventListener('keydown', (e) => e.key === 'Enter' && sendChat());
  function sendChat() {
    const text = $('chat-input').value.trim();
    if (!text) return;
    send({ action: 'chat', text });
    $('chat-input').value = '';
  }

  // ---------- 渲染 ----------
  function render() {
    if (!state) return;
    $('home-view').style.display = 'none';
    $('room-view').style.display = 'block';

    $('room-code').textContent = state.code;
    $('lobby-code').textContent = state.code;
    $('lobby-max').textContent = state.maxPlayers || 12;
    $('online-count').textContent = `${state.playerCount} 人在线`;
    $('player-count').textContent = state.playerCount;

    ['lobby', 'rps', 'ask', 'answer'].forEach((p) => {
      $('phase-' + p).style.display = state.phase === p ? 'block' : 'none';
    });

    renderPlayers();
    renderLobby();
    renderRps();
    renderAsk();
    renderAnswer();
    renderChat();
  }

  function isHost() { return state && myId === state.hostId; }
  function isAsker() { return state && myId === state.askerId; }
  function isAnswerer() { return state && myId === state.answererId; }

  function renderPlayers() {
    const el = $('player-list');
    el.innerHTML = '';
    for (const p of state.players) {
      const row = document.createElement('div');
      row.className = 'player-row' + (p.connected ? '' : ' offline');
      let badges = '';
      if (p.isHost) badges += '<span class="badge host">👑 房主</span>';
      if (p.isAsker) badges += '<span class="badge asker">🎤 出题人</span>';
      if (p.isAnswerer) badges += '<span class="badge answerer">🎯 回答者</span>';
      let right = '';
      if (state.phase === 'rps') {
        right = p.chosen ? '<span class="chosen-dot">已出拳 ✓</span>' : '<span class="chosen-dot" style="color:#b3aee0">思考中…</span>';
      } else if (p.choice && CHOICE_EMOJI[p.choice]) {
        right = `<span class="hand-mini">${CHOICE_EMOJI[p.choice]}</span>`;
      }
      row.innerHTML = `<span>${esc(p.name)}</span>${badges}${right}`;
      el.appendChild(row);
    }
  }

  function renderLobby() {
    if (state.phase !== 'lobby') return;
    const grid = $('lobby-players');
    grid.innerHTML = '';
    for (const p of state.players) {
      const chip = document.createElement('div');
      chip.className = 'player-chip';
      chip.innerHTML = `${p.isHost ? '<span class="crown">👑</span>' : ''}${esc(p.name)}`;
      grid.appendChild(chip);
    }
    $('start-btn').style.display = isHost() ? 'inline-block' : 'none';
    if (!isHost() && state.playerCount >= 2) {
      $('start-error').textContent = '等待房主开始游戏…';
    }
  }

  // ---- 倒计时 ----
  const RING_LEN = 2 * Math.PI * 52;
  function startCountdown() {
    cancelAnimationFrame(countdownRAF);
    const tick = () => {
      if (!state || state.phase !== 'rps') return;
      const remain = Math.max(0, (state.countdownEndsAt - Date.now()) / 1000);
      const total = state.rpsSeconds || 10;
      const frac = Math.max(0, remain / total);
      const ring = $('ring-fg');
      const num = $('countdown-num');
      num.textContent = Math.ceil(remain);
      ring.style.strokeDashoffset = String(RING_LEN * (1 - frac));
      const urgent = remain <= 3.05;
      ring.classList.toggle('urgent', urgent);
      num.classList.toggle('urgent', urgent);
      if (remain > 0) countdownRAF = requestAnimationFrame(tick);
    };
    tick();
  }

  function renderRps() {
    if (state.phase !== 'rps') return;
    $('rps-title').textContent = `第 ${state.round} 轮 · 石头剪刀布`;

    const picked = state.players.find((p) => p.id === myId);
    const hasPicked = picked && picked.chosen;
    document.querySelectorAll('.rps-btn').forEach((b) => {
      b.classList.toggle('selected', b.dataset.choice === myChoice && hasPicked);
      b.disabled = false;
    });
    $('rps-mine').style.display = hasPicked ? 'none' : 'flex';
    $('rps-picked').style.display = hasPicked ? 'block' : 'none';

    const wrap = $('rps-players');
    wrap.innerHTML = '';
    for (const p of state.players) {
      const d = document.createElement('div');
      d.className = 'rps-player' + (p.chosen ? '' : ' waiting');
      d.innerHTML = `<span>${esc(p.name)}</span><span class="hand">${p.chosen ? '✅' : '⏳'}</span>`;
      wrap.appendChild(d);
    }

    const voteBox = $('restart-vote');
    const total = state.playerCount;
    if (state.restartVoteCount > 0) {
      $('restart-text').textContent = `重新开始投票：${state.restartVoteCount}/${total}`;
      $('vote-restart').style.display = 'none';
    } else {
      $('restart-text').textContent = '手滑了？对这局不满意？';
      $('vote-restart').style.display = 'inline-block';
      $('vote-restart').disabled = false;
    }

    startCountdown();
  }

  function renderAsk() {
    if (state.phase !== 'ask') return;

    const box = $('rps-result-box');
    box.innerHTML = '';
    if (state.lastResult) {
      const note = document.createElement('div');
      const isBad = /判输|没有及时/.test(state.lastResult.note || '');
      note.className = 'result-banner ' + (state.lastResult.note ? (isBad ? 'lose-note' : 'tie-note') : 'ok');
      note.textContent = state.lastResult.note || '猜拳结束！';
      box.appendChild(note);

      const outcomes = state.lastResult.outcomes || [];
      if (outcomes.length) {
        const wrap = document.createElement('div');
        wrap.className = 'rps-players';
        for (const o of outcomes) {
          const d = document.createElement('div');
          d.className = 'rps-player status-' + o.status;
          const mark = o.status === 'win' ? '🏆' : o.status === 'lose' ? '💀' : '🤝';
          d.innerHTML = `<span>${esc(o.name)}</span><span class="hand">${o.choice ? CHOICE_EMOJI[o.choice] : '❌'}</span><span>${mark}</span>`;
          wrap.appendChild(d);
        }
        box.appendChild(wrap);
      }
    }

    const asker = state.players.find((p) => p.id === state.askerId);
    const answerer = state.players.find((p) => p.id === state.answererId);
    const roles = document.createElement('div');
    roles.className = 'role-cards';
    roles.innerHTML = `
      <div class="role-card asker"><div class="role">🎤 出题人</div><div class="who">${esc(asker ? asker.name : '?')}</div></div>
      <div class="role-card answerer"><div class="role">🎯 回答者</div><div class="who">${esc(answerer ? answerer.name : '?')}</div></div>`;
    box.appendChild(roles);

    const panel = $('ask-panel');
    panel.innerHTML = '';
    if (isAsker()) {
      panel.className = 'ask-panel';
      panel.innerHTML = `
        <p class="hint" style="text-align:center">轮到你出题！选择类型，可以自己写，也可以从题库里挑一道</p>
        <div class="qtype-toggle">
          <button class="qtype-btn truth ${selectedQtype === 'truth' ? 'active' : ''}" data-q="truth">💬 真心话</button>
          <button class="qtype-btn dare ${selectedQtype === 'dare' ? 'active' : ''}" data-q="dare">🔥 大冒险</button>
        </div>
        <textarea id="q-input" maxlength="300" placeholder="自己想一道题目写在这里…"></textarea>
        <p class="hint" style="margin:0 0 6px">或从题库里选（点击即选中，也可以改几个字）：</p>
        <div class="bank-list" id="bank-list"></div>
        <button id="submit-q" class="btn primary big">📢 公布题目</button>`;

      panel.querySelectorAll('.qtype-btn').forEach((b) => {
        b.addEventListener('click', () => {
          selectedQtype = b.dataset.q;
          selectedBankText = '';
          bankPool = [];
          renderAsk();
        });
      });

      renderBank();
      $('submit-q').addEventListener('click', () => {
        const text = $('q-input').value.trim() || selectedBankText;
        if (!text) return toast('先写题目或从题库里选一个', true);
        send({ action: 'ask_question', qtype: selectedQtype, text });
      });
    } else {
      panel.className = '';
      panel.innerHTML = `<p class="hint">等待 <b>${esc(asker ? asker.name : '')}</b> 出题中… 出题人可以从题库里选，也可以自由发挥</p>`;
    }
  }

  function renderBank() {
    const listEl = $('bank-list');
    if (!listEl) return;
    const bank = selectedQtype === 'truth' ? window.TRUTH_QUESTIONS : window.DARE_QUESTIONS;
    if (!bankPool.length || bankPool[0].qtype !== selectedQtype) {
      bankPool = [...bank]
        .sort(() => Math.random() - 0.5)
        .slice(0, 8)
        .map((text) => ({ text, qtype: selectedQtype }));
    }
    listEl.innerHTML = '';
    for (const item of bankPool) {
      const b = document.createElement('button');
      b.className = 'bank-item' + (selectedBankText === item.text ? ' selected' : '');
      b.textContent = item.text;
      b.addEventListener('click', () => {
        selectedBankText = item.text;
        const input = $('q-input');
        if (input) input.value = item.text;
        renderBank();
      });
      listEl.appendChild(b);
    }
  }

  function renderAnswer() {
    if (state.phase !== 'answer') return;
    const q = state.question;
    const card = $('question-card');
    card.className = 'question-card ' + (q.qtype === 'dare' ? 'dare' : 'truth');
    card.innerHTML = `
      <span class="qtag">${q.qtype === 'dare' ? '🔥 大冒险' : '💬 真心话'}</span><br/>
      ${esc(q.text)}`;

    const answerer = state.players.find((p) => p.id === state.answererId);
    const answered = !!state.lastAnswer;

    const box = $('answer-box');
    if (isAnswerer()) {
      box.style.display = 'block';
      box.innerHTML = `
        <div class="answer-box-title">🎯 你的答案</div>
        <textarea id="answer-input" maxlength="500" placeholder="${answered ? '想修改答案可以再次提交，会覆盖上一条' : '认真作答，或者点麦克风用说的…'}">${answered ? esc(state.lastAnswer.text) : ''}</textarea>
        <div class="answer-actions">
          <button id="voice-btn" class="btn mini">🎤 语音输入</button>
          <button id="submit-answer" class="btn primary">${answered ? '📤 重新提交' : '📤 提交答案'}</button>
        </div>
        <div class="voice-status" id="voice-status" style="display:none">🎙️ 正在聆听，请说话…（再点一次结束）</div>`;
      $('submit-answer').addEventListener('click', () => {
        const text = $('answer-input').value.trim();
        if (!text) return toast('先写下你的答案，或用语音输入', true);
        send({ action: 'submit_answer', text });
        toast('✅ 答案已提交，大家都看到了！');
      });
      $('voice-btn').addEventListener('click', () => toggleVoiceInput('answer-input'));
    } else {
      box.style.display = 'block';
      box.innerHTML = answered
        ? `<div class="answer-wait">📌 <b>${esc(answerer ? answerer.name : '')}</b> 已提交答案，看聊天区的答案卡！</div>`
        : `<div class="answer-wait">⏳ 等待 <b>${esc(answerer ? answerer.name : '')}</b> 在答题框里作答… 大家可以在聊天区围观、起哄、催更！</div>`;
    }

    $('answer-hint').innerHTML = isAnswerer()
      ? '<b>🎯 到你了！</b>在下方答题框写下答案（可语音输入），点「提交答案」后所有人都能看到'
      : `🎯 回答者是 <b>${esc(answerer ? answerer.name : '')}</b>，他的答案提交后会以大卡片出现在聊天区`;

    const btn = $('next-round-btn');
    btn.style.display = isAsker() || isHost() ? 'inline-block' : 'none';
  }

  // ---- 语音输入（Web Speech API）----
  let recog = null;
  let recogActive = false;
  function toggleVoiceInput(targetId) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return toast('这个浏览器不支持语音输入，请用 Chrome / Edge / Safari 较新版本', true);
    const statusEl = $('voice-status');
    if (recogActive) {
      try { recog.stop(); } catch (e) { /* ignore */ }
      return;
    }
    const input = $(targetId);
    let base = input.value;
    recog = new SR();
    recog.lang = 'zh-CN';
    recog.continuous = true;
    recog.interimResults = true;
    recog.onstart = () => {
      recogActive = true;
      if (statusEl) statusEl.style.display = 'block';
      const btn = $('voice-btn');
      if (btn) { btn.classList.add('recording'); btn.textContent = '⏹ 停止语音'; }
    };
    recog.onresult = (e) => {
      let finalText = '', interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t; else interim += t;
      }
      if (input) input.value = (base + finalText + interim).slice(0, 500);
    };
    recog.onerror = (e) => {
      if (e.error === 'not-allowed') toast('麦克风权限被拒绝，请在浏览器设置里允许', true);
    };
    recog.onend = () => {
      recogActive = false;
      if (statusEl) statusEl.style.display = 'none';
      const btn = $('voice-btn');
      if (btn) { btn.classList.remove('recording'); btn.textContent = '🎤 语音输入'; }
    };
    try { recog.start(); } catch (err) { recogActive = false; toast('语音输入启动失败：' + err.message, true); }
  }

  function renderChat() {
    const list = $('chat-list');
    if (!list) return;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    list.innerHTML = '';
    for (const m of chatCache) {
      const d = document.createElement('div');
      if (m.from === 'system') {
        d.className = 'chat-msg system';
        d.innerHTML = `<div class="bubble">${esc(m.text)}</div>`;
      } else if (m.answer) {
        d.className = 'chat-msg answer-card' + (m.from === myId ? ' mine' : '');
        d.innerHTML = `<div class="meta">🎯 ${esc(m.name)} 的答案</div><div class="bubble">${esc(m.text)}</div>`;
      } else {
        d.className = 'chat-msg' + (m.from === myId ? ' mine' : '');
        d.innerHTML = `<div class="meta">${esc(m.name)}</div><div class="bubble">${esc(m.text)}</div>`;
      }
      list.appendChild(d);
    }
    if (nearBottom) list.scrollTop = list.scrollHeight;
  }

  // ---------- 账号：注册/登录二合一 ----------

  $('auth-btn').addEventListener('click', () => {
    const username = $('auth-user').value.trim();
    const password = $('auth-pass').value;
    if (!username) return showError('auth-error', '先输入用户名');
    if (!password) return showError('auth-error', '先输入密码');
    $('auth-btn').disabled = true;
    $('auth-btn').textContent = '连接中…';
    social.registerOrLogin(username, password)
      .then((user) => {
        account = user;
        enterHome();
      })
      .catch((err) => {
        showError('auth-error', err.message || '操作失败，请重试');
      })
      .finally(() => {
        $('auth-btn').disabled = false;
        $('auth-btn').textContent = '🚀 进入游戏';
      });
  });

  function setAuthConn(st) {
    const bar = $('auth-conn-status');
    const dot = $('auth-conn-dot');
    const text = $('auth-conn-text');
    if (st === 'hidden') return (bar.style.display = 'none');
    bar.style.display = 'flex';
    dot.classList.remove('ok', 'bad');
    if (st === 'ok') { dot.classList.add('ok'); text.textContent = '已连接'; }
    else if (st === 'bad') { dot.classList.add('bad'); text.textContent = '连接失败，重试中…'; }
    else { text.textContent = '连接中…'; }
  }

  $('auth-pass').addEventListener('keydown', (e) => e.key === 'Enter' && $('auth-btn').click());
  $('auth-user').addEventListener('keydown', (e) => e.key === 'Enter' && $('auth-btn').click());

  function enterHome() {
    $('auth-view').style.display = 'none';
    $('home-view').style.display = 'block';
    $('account-bar').style.display = 'flex';
    $('acc-name').textContent = account.name;
    $('home-identity').textContent = account.name;
    renderFriends();
  }

  $('rename-btn').addEventListener('click', () => {
    const newName = prompt('输入新的名字（2-12 个字符）', account.name);
    if (!newName) return;
    const name = newName.trim();
    if (!name) return;
    social.changeName(name).then((user) => {
      account = user;
      $('acc-name').textContent = account.name;
      $('home-identity').textContent = account.name;
      toast('改名成功！以后进房间都用这个名字');
    }).catch((err) => toast(err.message, true));
  });

  $('logout-btn').addEventListener('click', () => {
    if (!confirm('退出登录？好友和聊天记录已同步到云端，换设备/重新登录都不会丢失')) return;
    social.logout();
    location.reload();
  });

  // ---------- 好友 ----------
  function renderFriends() {
    const el = $('friend-list');
    if (!el) return;
    el.innerHTML = '';
    const friends = social.friends || [];
    $('friend-hint').textContent = friends.length
      ? '点击好友开始私聊 🟢 在线 · ⚪ 离线'
      : '还没有好友，用上面的搜索加一个吧（对方在线才能收到申请）';
    for (const f of friends) {
      const online = social.onlineOf(f.username);
      const unread = social.unread.get(f.username) || 0;
      const row = document.createElement('div');
      row.className = 'friend-row';
      row.innerHTML = `
        <span class="fdot ${online ? 'on' : ''}"></span>
        <span class="fname">${esc(f.name)}</span>
        ${unread ? `<span class="fbadge">${unread}</span>` : ''}
        <span class="fchat">${online ? '💬 私聊' : '💤 离线'}</span>`;
      row.addEventListener('click', () => openDM(f));
      el.appendChild(row);
    }
  }

  let searchResultUser = null;
  $('friend-search-btn').addEventListener('click', () => {
    const username = $('friend-search').value.trim();
    const el = $('friend-result');
    el.innerHTML = '';
    searchResultUser = null;
    if (!username) return;
    if (account && username === account.username) {
      el.innerHTML = '<span class="fr-hint">😄 这是你自己的账号</span>';
      return;
    }
    const res = social.searchUser(username);
    if (!res.exists) {
      el.innerHTML = '<span class="fr-hint">没有找到这个用户名，检查一下拼写？</span>';
      return;
    }
    const isFriend = (social.friends || []).some((f) => f.username === username);
    searchResultUser = username;
    el.innerHTML = `
      <div class="friend-row result">
        <span class="fdot ${res.online ? 'on' : ''}"></span>
        <span class="fname">${esc(res.name)}</span>
        <button id="add-friend-btn" class="btn primary mini" ${isFriend ? 'disabled' : ''}>
          ${isFriend ? '✅ 已是好友' : '➕ 加好友'}
        </button>
      </div>`;
    const btn = $('add-friend-btn');
    if (btn && !isFriend) {
      btn.addEventListener('click', () => {
        social.addFriend(username)
          .then(() => {
            btn.disabled = true;
            btn.textContent = '📤 申请已发送';
            toast(res.online ? `已向 ${res.name} 发送好友申请` : `已发送申请（${res.name} 当前离线，上线后才能收到）`);
          })
          .catch((err) => toast(err.message, true));
      });
    }
  });
  $('friend-search').addEventListener('keydown', (e) => e.key === 'Enter' && $('friend-search-btn').click());

  function handleFriendRequest(msg) {
    if (confirm(`💌 ${msg.name || msg.from} 请求加你为好友，同意吗？`)) {
      social.acceptFriend(msg.from, msg.name).then(() => toast(`已添加 ${msg.name || msg.from} 为好友 🎉`));
    } else {
      social.declineFriend(msg.from);
    }
  }

  function handleFriendResult(msg) {
    if (msg.ok) {
      toast(`${msg.name || msg.from} 已同意你的好友申请 🎉`);
      $('friend-result').innerHTML = '';
      $('friend-search').value = '';
    } else {
      toast(`${msg.name || msg.from} 拒绝了好友申请`, true);
    }
  }

  // ---------- 私聊 ----------
  let dmWith = null;

  function openDM(friend) {
    dmWith = friend.username;
    social.clearUnread(dmWith);
    $('dm-title').textContent = `与 ${friend.name} 聊天${social.onlineOf(dmWith) ? ' 🟢' : '（离线）'}`;
    renderDM();
    $('dm-modal').style.display = 'flex';
    renderFriends();
    setTimeout(() => $('dm-input').focus(), 50);
  }

  function closeDM() {
    dmWith = null;
    social.closeDM();
    $('dm-modal').style.display = 'none';
    renderFriends();
  }

  function renderDM() {
    if (!dmWith) return;
    const list = $('dm-list');
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    const msgs = social.dmHistory(dmWith);
    list.innerHTML = '';
    for (const m of msgs) {
      const d = document.createElement('div');
      d.className = 'chat-msg' + (m.mine ? ' mine' : '');
      d.innerHTML = `<div class="meta">${esc(m.name)} · ${new Date(m.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</div><div class="bubble">${esc(m.text)}</div>`;
      list.appendChild(d);
    }
    if (nearBottom || list.childElementCount) list.scrollTop = list.scrollHeight;
  }

  $('dm-close').addEventListener('click', closeDM);
  $('dm-modal').addEventListener('click', (e) => { if (e.target === $('dm-modal')) closeDM(); });

  $('dm-send').addEventListener('click', sendDM);
  $('dm-input').addEventListener('keydown', (e) => e.key === 'Enter' && sendDM());
  function sendDM() {
    const text = $('dm-input').value.trim();
    if (!text || !dmWith) return;
    const friend = social.friends.find((f) => f.username === dmWith);
    social.sendDM(dmWith, text)
      .then(() => {
        $('dm-input').value = '';
        renderDM();
        if (friend && !social.onlineOf(friend.username)) toast('对方当前离线，上线后可能看不到这条消息', true);
      })
      .catch((err) => toast(err.message, true));
  }

  // ---------- 通话 ----------
  const callManager = new CallManager({
    social,
    getName: () => (account && account.name) || '玩家',
  });

  function startCallFromDM(kind) {
    if (!dmWith) return;
    const friend = social.friends.find((f) => f.username === dmWith);
    if (!friend) return toast('找不到这个好友', true);
    if (!social.onlineOf(dmWith)) return toast('对方不在线，无法呼叫', true);
    callManager.startCall(dmWith, friend.name, kind).catch((err) => toast(err.message, true));
  }
  $('dm-call-audio').addEventListener('click', () => startCallFromDM('audio'));
  $('dm-call-video').addEventListener('click', () => startCallFromDM('video'));

  function handleDM(msg, isOpen) {
    if (isOpen && dmWith === msg.from) {
      renderDM();
    } else {
      toast(`💬 ${msg.name || msg.from}：${msg.text}`);
    }
    renderFriends();
  }

  // ---------- 启动 ----------
  myId = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  social.onFriends = renderFriends;
  social.onDM = handleDM;
  social.onFriendRequest = handleFriendRequest;
  social.onFriendResult = handleFriendResult;
  social.onHistory = () => { if (dmWith) renderDM(); };

  // 已有本机登录态 → 直接进首页；否则先注册/登录
  const saved = social.loadSession();
  if (saved && saved.username) {
    setAuthConn('hidden');
    social.resume(saved).then((user) => {
      account = user;
      enterHome();
      setAuthConn('hidden');
    }).catch(() => {
      // 恢复失败（如连不上）仍显示注册页
      $('auth-view').style.display = 'block';
      setAuthConn('hidden');
    });
  } else {
    $('auth-view').style.display = 'block';
    social.connect().catch(() => {});
  }
})();
