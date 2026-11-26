/**
 * test-new.js — 本轮新功能测试：
 *  A. game-core submit_answer（答题框动作，纯本地引擎测试）
 *  B. 好友列表/私聊记录云端同步（真实 MQTT，模拟换设备）
 */
global.window = global;
const _store = new Map();
global.localStorage = {
  getItem: (k) => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => _store.set(k, String(v)),
  removeItem: (k) => _store.delete(k),
};
global.mqtt = require('/Users/s032005/.workbuddy/binaries/node/workspace/node_modules/mqtt');

const q = require('/Users/s032005/WorkBuddy/eddys-67web/questions.js');
window.TRUTH_QUESTIONS = q.TRUTH_QUESTIONS;
window.DARE_QUESTIONS = q.DARE_QUESTIONS;
require('/Users/s032005/WorkBuddy/eddys-67web/game-core.js');
require('/Users/s032005/WorkBuddy/eddys-67web/social.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function assert(cond, desc) {
  if (cond) { passed++; console.log('  ✅', desc); }
  else { failed++; console.log('  ❌', desc); }
}

const SUF = 'w' + Date.now().toString(36).slice(-6) + Math.floor(Math.random() * 999);
const U_ALICE = 'a' + SUF;
const U_BOB = 'b' + SUF;

// ===== A. submit_answer（引擎单元测试，无需网络） =====
(async () => {
  console.log('== [A] 答题框 submit_answer ==');
  const chats = [];
  const errors = [];
  let snap = null;
  const engine = window.GameCore.createGameEngine({
    hostId: 'h1', hostName: '房东', maxPlayers: 4,
    emitState: (s) => { snap = s; },
    emitChat: (m) => chats.push(m),
    emitError: (pid, t) => errors.push({ pid, t }),
  });
  engine.init();
  engine.handleAction('p2', { action: 'join', name: '小明' });
  engine.handleAction('p3', { action: 'join', name: '小红' });
  engine.handleAction('h1', { action: 'start' });
  // 全员出拳（h1 rock, p2 scissors → p2 胜, p3 不出判输；倒计时结束才结算）
  engine.handleAction('h1', { action: 'choice', choice: 'rock' });
  engine.handleAction('p2', { action: 'choice', choice: 'scissors' });
  await sleep(10600); // 等 10 秒倒计时结束触发 finishRps
  assert(snap.phase === 'ask', '猜拳后进入出题阶段');
  const askerId = snap.askerId;
  const answererId = snap.answererId;
  assert(!!answererId, '回答者已产生');
  assert(answererId !== askerId, '出题人不是回答者');

  // 非回答者提交 → 报错
  const other = ['h1', 'p2', 'p3'].find((id) => id !== answererId);
  const errCountBefore = errors.length;
  engine.handleAction(other, { action: 'submit_answer', text: '我不是回答者' });
  assert(errors.length > errCountBefore && /回答/.test(errors[errors.length - 1].t), '非回答者提交被拒绝');
  assert(snap.phase === 'ask', '拒绝后仍在出题阶段');

  // 出题 → 回答阶段
  engine.handleAction(askerId, { action: 'ask_question', qtype: 'truth', text: '测试问题：你最喜欢的颜色？' });
  await sleep(100);
  assert(snap.phase === 'answer', '公布题目后进入回答阶段');

  // 回答者提交答案
  const chatCountBefore = chats.length;
  engine.handleAction(answererId, { action: 'submit_answer', text: '我最喜欢蓝色！' });
  await sleep(100);
  const ansMsg = chats[chats.length - 2]; // 最后一条是系统提示
  assert(ansMsg && ansMsg.answer === true && ansMsg.text === '我最喜欢蓝色！', '答案以 answer 标记广播');
  assert(snap.lastAnswer && snap.lastAnswer.text === '我最喜欢蓝色！', '快照 lastAnswer 已记录');
  assert(snap.phase === 'answer', '提交答案后仍在回答阶段');

  // 再提交覆盖
  engine.handleAction(answererId, { action: 'submit_answer', text: '改口：绿色！' });
  await sleep(100);
  assert(snap.lastAnswer && snap.lastAnswer.text === '改口：绿色！', '重复提交覆盖上一条答案');

  // 空答案
  const errB = errors.length;
  engine.handleAction(answererId, { action: 'submit_answer', text: '   ' });
  assert(errors.length > errB, '空答案被拒绝');

  // 下一轮后清空
  engine.handleAction(askerId, { action: 'next_round' });
  await sleep(100);
  assert(snap.lastAnswer === null, '下一轮答案已清空');
  assert(snap.phase === 'rps', '下一轮进入猜拳');

  console.log('== [B] 好友/私聊云端同步（真实 MQTT） ==');
  const alice = new SocialNet();
  const bob = new SocialNet();
  const uA = await alice.register(U_ALICE, 'pass-a').catch((e) => { console.log(e.message); return null; });
  assert(uA && uA.username === U_ALICE, 'alice 注册');
  const uB = await bob.register(U_BOB, 'pass-b').catch((e) => { console.log(e.message); return null; });
  assert(uB && uB.username === U_BOB, 'bob 注册');
  await sleep(1800);

  // 加好友：bob 申请，alice 同意（freq 发给 alice，fres 回给 bob）
  alice.onFriendRequest = (m) => alice.acceptFriend(m.from, m.name);
  let bobGotResult = null;
  bob.onFriendResult = (m) => { bobGotResult = m; };
  await bob.addFriend(U_ALICE);
  await sleep(2500);
  assert(bob.friends.some((f) => f.username === U_ALICE), 'bob 本地有 alice');
  assert(alice.friends.some((f) => f.username === U_BOB), 'alice 本地有 bob');
  assert(bobGotResult && bobGotResult.ok, 'bob 收到同意回执');

  // 私聊一条消息
  await bob.sendDM(U_ALICE, '云端同步测试消息');
  await sleep(2500);
  assert(alice.dmHistory(U_BOB).some((m) => m.text === '云端同步测试消息'), 'alice 收到私聊');

  // 模拟 alice 换设备：清空本机缓存，全新实例登录
  _store.delete('tod67_auth');
  _store.delete('tod67_friends_' + U_ALICE);
  _store.delete('tod67_dms_' + U_ALICE);
  _store.delete('tod67_friends');
  const alice2 = new SocialNet();
  const login2 = await alice2.login(U_ALICE, 'pass-a').catch((e) => { console.log(e.message); return null; });
  assert(login2 && login2.username === U_ALICE, '换设备重新登录成功');
  assert(alice2.friends.some((f) => f.username === U_BOB), '⭐ 好友从云端恢复（bug 修复验证）');
  assert(alice2.dmHistory(U_BOB).some((m) => m.text === '云端同步测试消息'), '⭐ 私聊记录从云端恢复');

  // 换设备再发消息，原设备也能收到（alice2 → bob，bob 的旧实例实时收到）
  const gotOnOld = new Promise((resolve) => { bob.onDM = (m) => resolve(m); });
  await alice2.sendDM(U_BOB, '换设备也能聊');
  const dmOld = await Promise.race([gotOnOld, sleep(5000).then(() => null)]);
  assert(dmOld && dmOld.text === '换设备也能聊', '旧设备实时收到新设备发的消息');

  // 清理
  console.log('== [清理] ==');
  try {
    const reg = alice.registry || {};
    delete reg[U_ALICE];
    delete reg[U_BOB];
    await new Promise((res) => bob.client.publish('tod67web/registry', JSON.stringify(reg), { qos: 0, retain: true }, res));
    await new Promise((res) => bob.client.publish('tod67web/friends/' + U_ALICE, '', { qos: 0, retain: true }, res));
    await new Promise((res) => bob.client.publish('tod67web/friends/' + U_BOB, '', { qos: 0, retain: true }, res));
    await new Promise((res) => bob.client.publish('tod67web/dmhist/' + U_ALICE, '', { qos: 0, retain: true }, res));
    await new Promise((res) => bob.client.publish('tod67web/dmhist/' + U_BOB, '', { qos: 0, retain: true }, res));
    console.log('  🧹 已清理', U_ALICE, U_BOB);
  } catch (e) {
    console.log('  ⚠️ 清理失败:', e.message);
  }

  console.log(`\n========== 测试${failed ? `失败 ${failed} 项 ❌` : '全部通过 🎉'}（通过 ${passed}） ==========`);
  alice.logout(); bob.logout();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
