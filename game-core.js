/**
 * game-core.js — 运行在房主浏览器内的权威游戏引擎
 * GitHub Pages 静态版：没有后端，由房主充当服务器，通过 MQTT 中转消息
 */
(function () {
  'use strict';

  const RPS_SECONDS = 10;
  const TRUTH = window.TRUTH_QUESTIONS;
  const DARE = window.DARE_QUESTIONS;

  const rand = (n) => Math.floor(Math.random() * n);
  const pickRandom = (arr) => arr[rand(arr.length)];
  const genRoomCode = () => String(1000 + rand(9000));

  function beats(c, o) {
    return (
      (c === 'rock' && o === 'scissors') ||
      (c === 'scissors' && o === 'paper') ||
      (c === 'paper' && o === 'rock')
    );
  }

  /**
   * 创建游戏引擎（每个房主一个实例 = 一个房间）
   * opts: {
   *   hostId: 房主 playerId,
   *   maxPlayers: 最大人数,
   *   emitState(snapshot),        // 广播房间快照（房主本地 + MQTT）
   *   emitChat(msg),              // 广播聊天/系统消息
   *   emitError(playerId, text),  // 定向错误
   * }
   */
  function createGameEngine(opts) {
    const room = {
      code: genRoomCode(),
      maxPlayers: Math.min(12, Math.max(2, parseInt(opts.maxPlayers, 10) || 12)),
      hostId: opts.hostId,
      players: new Map(), // id -> {id, name, choice, connected}
      phase: 'lobby', // lobby | rps | ask | answer
      round: 0,
      askerId: null,
      answererId: null,
      countdownEndsAt: 0,
      timer: null,
      restartVotes: new Set(),
      lastResult: null,
      losers: [],
      question: null,
      chat: [],
    };

    function onlinePlayers() {
      return [...room.players.values()].filter((p) => p.connected);
    }

    function sysChat(text) {
      const msg = { from: 'system', name: '系统', text, ts: Date.now() };
      room.chat.push(msg);
      if (room.chat.length > 100) room.chat.shift();
      opts.emitChat(msg);
    }

    function snapshot() {
      const revealed = ['ask', 'answer'].includes(room.phase) || room.lastResult;
      return {
        type: 'state',
        serverTime: Date.now(),
        code: room.code,
        phase: room.phase,
        round: room.round,
        maxPlayers: room.maxPlayers,
        hostId: room.hostId,
        askerId: room.askerId,
        answererId: room.answererId,
        countdownEndsAt: room.countdownEndsAt,
        rpsSeconds: RPS_SECONDS,
        restartVoteCount: room.restartVotes.size,
        playerCount: onlinePlayers().length,
        lastResult: room.lastResult,
        question: room.question,
        players: [...room.players.values()].map((p) => ({
          id: p.id,
          name: p.name,
          isHost: p.id === room.hostId,
          connected: p.connected,
          isAsker: p.id === room.askerId,
          isAnswerer: p.id === room.answererId,
          votedRestart: room.restartVotes.has(p.id),
          chosen: p.choice !== null,
          choice: room.lastResult ? p.choice : null,
        })),
        truthCount: TRUTH.length,
        dareCount: DARE.length,
      };
    }

    function broadcast() {
      opts.emitState(snapshot());
    }

    function startRps() {
      room.phase = 'rps';
      room.restartVotes.clear();
      room.lastResult = null;
      room.question = null;
      room.askerId = null;
      room.answererId = null;
      room.losers = [];
      for (const p of room.players.values()) p.choice = null;
      beginCountdown();
      broadcast();
    }

    function beginCountdown() {
      room.countdownEndsAt = Date.now() + RPS_SECONDS * 1000;
      if (room.timer) clearTimeout(room.timer);
      room.timer = setTimeout(finishRps, RPS_SECONDS * 1000 + 300);
    }

    function finishRps() {
      if (room.phase !== 'rps') return;
      const players = onlinePlayers();
      const noPick = players.filter((p) => !p.choice);
      const picked = players.filter((p) => p.choice);
      const choices = [...new Set(picked.map((p) => p.choice))];
      const outcomes = players.map((p) => ({ id: p.id, name: p.name, choice: p.choice, status: 'tie' }));
      const byId = Object.fromEntries(outcomes.map((o) => [o.id, o]));

      let rpsLosers = [];
      let note = '';

      if (choices.length === 0) {
        note = '没有人出拳，全员判输！';
        rpsLosers = players.map((p) => p.id);
        for (const o of outcomes) o.status = 'lose';
      } else if (choices.length === 1) {
        if (noPick.length === 0) {
          note = '大家出的一样，平局！';
        } else {
          note = `${noPick.map((p) => p.name).join('、')} 没有及时出拳，自动判输！`;
          rpsLosers = noPick.map((p) => p.id);
          for (const o of outcomes) o.status = o.choice ? 'win' : 'lose';
        }
      } else if (choices.length === 3) {
        note = '石头剪刀布全都齐了，平局！';
        for (const o of outcomes) o.status = o.choice ? 'tie' : 'lose';
        rpsLosers = noPick.map((p) => p.id);
      } else {
        const [a, b] = choices;
        const losingChoice = beats(a, b) ? b : a;
        for (const p of picked) {
          if (p.choice === losingChoice) {
            rpsLosers.push(p.id);
            byId[p.id].status = 'lose';
          } else {
            byId[p.id].status = 'win';
          }
        }
        for (const p of noPick) {
          rpsLosers.push(p.id);
          byId[p.id].status = 'lose';
        }
        note = noPick.length
          ? `${noPick.map((p) => p.name).join('、')} 没有及时出拳，自动判输！`
          : '';
      }

      if (rpsLosers.length === 0) {
        room.lastResult = { outcomes, note: (note ? note + ' ' : '') + '本轮平局，自动重新开始！' };
        for (const p of players) p.choice = null;
        room.restartVotes.clear();
        beginCountdown();
        broadcast();
        return;
      }

      room.losers = rpsLosers;
      const answerer = pickRandom(rpsLosers.map((id) => room.players.get(id)).filter(Boolean));
      room.answererId = answerer ? answerer.id : null;
      const others = players.filter((p) => p.id !== room.answererId);
      const asker = others.length ? pickRandom(others) : answerer;
      room.askerId = asker.id;

      room.lastResult = { outcomes, note };
      room.phase = 'ask';
      broadcast();
      sysChat(`第 ${room.round} 轮猜拳结束：${answerer.name} 被选中，由 ${asker.name} 出题！`);
    }

    function restartRound() {
      if (room.phase !== 'rps') return;
      if (room.timer) clearTimeout(room.timer);
      for (const p of room.players.values()) p.choice = null;
      room.restartVotes.clear();
      room.lastResult = null;
      beginCountdown();
      sysChat('全员同意，本局猜拳重新开始！');
      broadcast();
    }

    function startNextRound() {
      room.round += 1;
      sysChat(`—— 第 ${room.round} 轮 · 猜拳开始（${RPS_SECONDS} 秒内出拳）——`);
      startRps();
    }

    // 玩家加入（房主创建时也走这里）
    function addPlayer(playerId, name) {
      if (room.players.has(playerId)) {
        room.players.get(playerId).connected = true;
        broadcast();
        return null;
      }
      if (room.players.size >= room.maxPlayers) {
        return `房间人数已满（最多 ${room.maxPlayers} 人）`;
      }
      let finalName = name;
      const names = new Set([...room.players.values()].map((p) => p.name));
      if (names.has(finalName)) {
        let i = 2;
        while (names.has(`${name}${i}`)) i++;
        finalName = `${name}${i}`;
      }
      room.players.set(playerId, { id: playerId, name: finalName, choice: null, connected: true });
      sysChat(`${finalName} 加入了房间`);
      broadcast();
      return null;
    }

    // 玩家离开（掉线 LWT / 主动退出）
    function removePlayer(playerId) {
      const player = room.players.get(playerId);
      if (!player) return;
      room.players.delete(playerId);
      room.restartVotes.delete(playerId);
      sysChat(`${player.name} 离开了房间`);

      const online = onlinePlayers();
      if (online.length === 0) {
        destroy();
        return;
      }
      if (room.hostId === playerId) {
        // 房主离开：房间解散（静态版限制，见 README）
        sysChat('房主离开，房间解散');
        destroy();
        return;
      }
      if (online.length < 2 && room.phase !== 'lobby') {
        if (room.timer) clearTimeout(room.timer);
        room.phase = 'lobby';
        room.round = 0;
        room.question = null;
        room.lastResult = null;
        room.askerId = null;
        room.answererId = null;
        sysChat('人数不足，已回到大厅');
        broadcast();
        return;
      }
      if (room.phase === 'rps') {
        if (room.restartVotes.size >= online.length && room.restartVotes.size > 0) restartRound();
        else broadcast();
        return;
      }
      if (room.phase === 'ask' && room.askerId === playerId) {
        const candidates = online.filter((p) => p.id !== room.answererId);
        const newAsker = pickRandom(candidates.length ? candidates : online);
        room.askerId = newAsker.id;
        sysChat(`出题人离开，改由 ${newAsker.name} 出题`);
      }
      if ((room.phase === 'ask' || room.phase === 'answer') && room.answererId === playerId) {
        const pool = (room.losers || []).map((id) => room.players.get(id)).filter(Boolean)
          .filter((p) => p.connected && p.id !== playerId);
        const candidates = pool.length ? pool : onlinePlayers().filter((p) => p.id !== room.askerId);
        if (candidates.length) {
          const newAnswerer = pickRandom(candidates);
          room.answererId = newAnswerer.id;
          sysChat(`回答者离开，改由 ${newAnswerer.name} 回答`);
        }
      }
      broadcast();
    }

    function destroy() {
      if (room.timer) clearTimeout(room.timer);
      room.phase = 'closed';
      broadcast();
    }

    // 处理任意玩家（含房主自己）的动作
    function handleAction(playerId, data) {
      const player = room.players.get(playerId);
      const online = onlinePlayers();

      switch (data.action) {
        case 'join': {
          const err = addPlayer(playerId, String(data.name || '').trim().slice(0, 12) || '玩家');
          if (err) opts.emitError(playerId, err);
          break;
        }
        case 'chat': {
          if (!player) return opts.emitError(playerId, '请先加入房间');
          const text = String(data.text || '').trim();
          if (!text) return;
          const msg = { from: playerId, name: player.name, text: String(text).slice(0, 300), ts: Date.now() };
          room.chat.push(msg);
          if (room.chat.length > 100) room.chat.shift();
          opts.emitChat(msg);
          break;
        }
        case 'start': {
          if (!player) return opts.emitError(playerId, '请先加入房间');
          if (playerId !== room.hostId) return opts.emitError(playerId, '只有房主可以开始游戏');
          if (room.phase !== 'lobby') return opts.emitError(playerId, '游戏已在进行中');
          if (online.length < 2) return opts.emitError(playerId, '至少需要 2 名玩家才能开始');
          room.round = 0;
          sysChat('游戏开始！');
          startNextRound();
          break;
        }
        case 'choice': {
          if (!player) return opts.emitError(playerId, '请先加入房间');
          if (room.phase !== 'rps') return opts.emitError(playerId, '当前不是出拳阶段');
          if (!['rock', 'scissors', 'paper'].includes(data.choice)) return opts.emitError(playerId, '无效的出拳');
          player.choice = data.choice;
          broadcast();
          break;
        }
        case 'vote_restart': {
          if (!player) return opts.emitError(playerId, '请先加入房间');
          if (room.phase !== 'rps') return opts.emitError(playerId, '当前不是出拳阶段');
          room.restartVotes.add(playerId);
          if (room.restartVotes.size >= online.length) {
            restartRound();
          } else {
            sysChat(`${player.name} 同意重新开始本局（${room.restartVotes.size}/${online.length}）`);
            broadcast();
          }
          break;
        }
        case 'ask_question': {
          if (!player) return opts.emitError(playerId, '请先加入房间');
          if (room.phase !== 'ask') return opts.emitError(playerId, '当前不是出题阶段');
          if (playerId !== room.askerId) return opts.emitError(playerId, '只有出题人可以出题');
          const qtype = data.qtype === 'dare' ? 'dare' : 'truth';
          const text = String(data.text || '').trim().slice(0, 300);
          if (!text) return opts.emitError(playerId, '题目不能为空');
          room.question = { qtype, text, askerName: player.name };
          room.phase = 'answer';
          broadcast();
          sysChat(`${player.name} 已出题，大家可以在聊天区交流，${room.players.get(room.answererId)?.name || '回答者'} 快来回答！`);
          break;
        }
        case 'next_round': {
          if (!player) return opts.emitError(playerId, '请先加入房间');
          if (room.phase !== 'answer') return opts.emitError(playerId, '本轮尚未结束');
          if (playerId !== room.askerId && playerId !== room.hostId) {
            return opts.emitError(playerId, '由出题人（或房主）决定进入下一轮');
          }
          sysChat('本轮结束，进入下一轮！');
          startNextRound();
          break;
        }
        case 'end_game': {
          if (!player) return opts.emitError(playerId, '请先加入房间');
          if (playerId !== room.hostId) return opts.emitError(playerId, '只有房主可以结束游戏');
          if (room.timer) clearTimeout(room.timer);
          room.phase = 'lobby';
          room.round = 0;
          room.question = null;
          room.lastResult = null;
          room.askerId = null;
          room.answererId = null;
          sysChat('房主结束了游戏，回到大厅');
          broadcast();
          break;
        }
        default:
          opts.emitError(playerId, '未知指令');
      }
    }

    // 房主创建房间
    function init() {
      room.players.set(room.hostId, { id: room.hostId, name: opts.hostName, choice: null, connected: true });
      sysChat(`${opts.hostName} 创建了房间（最多 ${room.maxPlayers} 人）`);
      broadcast();
    }

    function dispose() {
      if (room.timer) clearTimeout(room.timer);
    }

    return {
      room,
      snapshot,
      handleAction,
      addPlayer,
      removePlayer,
      init,
      dispose,
      isHost: true,
    };
  }

  window.GameCore = { createGameEngine, genRoomCode, RPS_SECONDS };
})();
