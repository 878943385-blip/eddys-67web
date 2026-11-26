/* GitHub Pages 静态版端到端测试：房主引擎 + 2 个玩家走真实公共 MQTT broker */
process.chdir('/Users/s032005/WorkBuddy/eddys-67web');

// 模拟浏览器全局环境加载 questions.js 和 game-core.js
global.window = global;
const q = require('./questions.js');
window.TRUTH_QUESTIONS = q.TRUTH_QUESTIONS;
window.DARE_QUESTIONS = q.DARE_QUESTIONS;
require('./game-core.js');

const mqtt = require('/Users/s032005/.workbuddy/binaries/node/workspace/node_modules/mqtt');
const BROKER = 'wss://broker.emqx.io:8084/mqtt';
const BASE = 'tod67web';
let failed = 0;

function assert(cond, label) {
  if (cond) console.log('  ✅ ' + label);
  else { failed++; console.log('  ❌ ' + label); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mkClient(id) {
  return mqtt.connect(BROKER, { clientId: 'test' + id + Math.floor(Math.random() * 9999), clean: true });
}

function pub(client, topic, obj, retain) {
  client.publish(topic, JSON.stringify(obj), { qos: 0, retain: !!retain });
}

(async () => {
  console.log('\n[1] 连接公共 broker');
  const host = mkClient('host');
  await new Promise((r) => host.on('connect', r));
  console.log('  ✅ broker 已连接 (emqx)');

  // ---- 房主：创建引擎 ----
  let lastSnapshot = null;
  const chatLog = [];
  const errors = [];
  const engine = window.GameCore.createGameEngine({
    hostId: 'host1',
    hostName: '房东',
    maxPlayers: 3,
    emitState: (snap) => {
      lastSnapshot = snap;
      pub(host, `${BASE}/${snap.code}/state`, snap, true); // retained
    },
    emitChat: (msg) => {
      chatLog.push(msg);
      pub(host, `${BASE}/${engine.room.code}/chat`, msg);
    },
    emitError: (pid, text) => {
      errors.push({ pid, text });
      pub(host, `${BASE}/${engine.room.code}/chat`, { type: 'error', to: pid, message: text });
    },
  });
  const CODE = engine.room.code;
  const base = `${BASE}/${CODE}`;
  engine.init();
  assert(engine.room.players.size === 1 && engine.room.hostId === 'host1', '房主创建房间 ' + CODE);

  host.subscribe([`${base}/action`, `${base}/presence/#`]);
  host.on('message', (t, p) => {
    try {
      const m = JSON.parse(p.toString());
      if (t === `${base}/action` && m.from) {
        engine.handleAction(m.from, m); // 模拟 mqtt-net.js 的房主路由
      }
    } catch {}
  });

  // ---- 玩家 g1、g2 加入 ----
  const g1 = mkClient('g1');
  const g2 = mkClient('g2');
  await new Promise((r) => g1.on('connect', r));
  await new Promise((r) => g2.on('connect', r));

  const g1States = [];
  const g2States = [];
  g1.subscribe(`${base}/state`);
  g1.on('message', (t, p) => {
    const m = JSON.parse(p.toString());
    if (t === `${base}/state` && m.type === 'state') g1States.push(m);
  });
  g2.subscribe(`${base}/state`);
  g2.on('message', (t, p) => {
    const m = JSON.parse(p.toString());
    if (t === `${base}/state` && m.type === 'state') g2States.push(m);
  });
  await sleep(800); // 等订阅生效 + retained 快照下发

  assert(g1States.length > 0, 'g1 收到 retained 快照（新玩家秒同步）');
  assert(g1States[0].code === CODE, '快照房间号正确');

  pub(g1, `${base}/action`, { action: 'join', from: 'g1', name: '小虾' });
  pub(g2, `${base}/action`, { action: 'join', from: 'g2', name: '大虾' });
  await sleep(1200);
  assert(lastSnapshot.players.length === 3, '两名玩家已加入（共 3 人）');

  // ---- 人数上限：第 4 人被拒 ----
  pub(g1, `${base}/action`, { action: 'join', from: 'g3', name: '多余' });
  await sleep(600);
  assert(errors.some((e) => e.pid === 'g3' && /人数已满/.test(e.text)), '第 4 人收到「人数已满」');

  // ---- 开始游戏 & 猜拳 ----
  pub(g1, `${base}/action`, { action: 'start', from: 'g1' });
  await sleep(400);
  assert(errors.some((e) => e.pid === 'g1' && /房主/.test(e.text)), '非房主开始被拒绝');

  engine.handleAction('host1', { action: 'start' });
  await sleep(500);
  assert(lastSnapshot.phase === 'rps' && lastSnapshot.round === 1, '猜拳倒计时开始');

  pub(g1, `${base}/action`, { action: 'choice', from: 'g1', choice: 'rock' });
  await sleep(300);
  pub(g2, `${base}/action`, { action: 'choice', from: 'g2', choice: 'scissors' });
  // 房主不出拳 → 超时判输
  await sleep(11000);
  assert(lastSnapshot.phase === 'ask', '超时结算进入出题阶段');
  const hostOutcome = lastSnapshot.lastResult.outcomes.find((o) => o.id === 'host1');
  assert(hostOutcome.status === 'lose', '房主未出拳判输');

  // ---- 出题 & 聊天 & 下一轮 ----
  const askerId = lastSnapshot.askerId;
  const answererId = lastSnapshot.answererId;
  assert(askerId !== answererId, '出题人与回答者不同');
  engine.handleAction(askerId, { action: 'ask_question', qtype: 'truth', text: 'MQTT 测试题：最尴尬的事？' });
  await sleep(400);
  assert(lastSnapshot.phase === 'answer' && lastSnapshot.question.text.includes('最尴尬'), '题目已公布');
  assert(g1States[g1States.length - 1].question && g1States[g1States.length - 1].question.text.includes('最尴尬'), '玩家端同步到题目');

  engine.handleAction('g1', { action: 'chat', text: '我来围观！' });
  await sleep(300);
  assert(chatLog.some((m) => m.text === '我来围观！'), '聊天消息已广播');

  engine.handleAction(answererId, { action: 'next_round' });
  await sleep(300);
  // 回答者若同时是出题人或房主，跳轮是允许的（随机选中导致）
  if (answererId !== askerId && answererId !== engine.room.hostId) {
    assert(errors.some((e) => e.pid === answererId && /出题人/.test(e.text)), '回答者不能跳轮');
  } else {
    assert(errors.every((e) => e.pid !== answererId), '回答者即出题人/房主，允许跳轮');
  }

  engine.handleAction(askerId, { action: 'next_round' });
  await sleep(400);
  assert(lastSnapshot.phase === 'rps' && lastSnapshot.round === 2, '进入第 2 轮');

  // ---- 掉线踢除（心跳超时模拟：直接调 removePlayer）----
  engine.removePlayer('g1');
  await sleep(300);
  assert(lastSnapshot.players.length === 2 && !lastSnapshot.players.some((p) => p.id === 'g1'), '玩家离开后移除');

  console.log('\n========== MQTT 静态版测试' + (failed ? `失败 ${failed} 项 ❌` : '全部通过 🎉') + ' ==========');
  host.end(true); g1.end(true); g2.end(true);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('\n💥 测试异常:', e);
  process.exit(1);
});
