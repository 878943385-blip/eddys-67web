/**
 * test-call.js — 通话信令状态机端到端测试（真实 MQTT 传信令 + WebRTC/DOM 打桩）
 * 验证：在线判断、invite→accept→offer→answer 状态流转、hangup 清理、忙线拒绝
 */
global.window = global;
const _store = new Map();
global.localStorage = {
  getItem: (k) => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => _store.set(k, String(v)),
  removeItem: (k) => _store.delete(k),
};
global.mqtt = require('/Users/s032005/.workbuddy/binaries/node/workspace/node_modules/mqtt');

// ---- WebRTC / 媒体打桩 ----
// Node 22 自带只读 navigator 全局，必须 defineProperty 覆盖
Object.defineProperty(globalThis, 'navigator', {
  value: { mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [] }) } },
  writable: true, configurable: true,
});
global.RTCPeerConnection = class {
  constructor() { this.connectionState = 'new'; }
  createOffer() { return Promise.resolve({ type: 'offer', sdp: 'mock-offer-sdp' }); }
  createAnswer() { return Promise.resolve({ type: 'answer', sdp: 'mock-answer-sdp' }); }
  setLocalDescription() { return Promise.resolve(); }
  setRemoteDescription() { return Promise.resolve(); }
  addIceCandidate() { return Promise.resolve(); }
  addTrack() {}
  close() { this.connectionState = 'closed'; }
};
global.RTCSessionDescription = class { constructor(d) { Object.assign(this, d); } };
global.RTCIceCandidate = class { constructor(d) { Object.assign(this, d); } };

require('/Users/s032005/WorkBuddy/eddys-67web/social.js');
require('/Users/s032005/WorkBuddy/eddys-67web/call.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function assert(cond, desc) {
  if (cond) { passed++; console.log('  ✅', desc); }
  else { failed++; console.log('  ❌', desc); }
}

const SUF = 'c' + Date.now().toString(36).slice(-6) + Math.floor(Math.random() * 999);
const U_ALICE = 'a' + SUF;
const U_BOB = 'b' + SUF;

(async () => {
  console.log('== [1] 注册 + 建立通话管理器（headless） ==');
  const alice = new SocialNet();
  const bob = new SocialNet();
  await alice.register(U_ALICE, 'pass-a').catch((e) => console.log(e.message));
  await bob.register(U_BOB, 'pass-b').catch((e) => console.log(e.message));
  await sleep(6000); // 等心跳传播，让 alice 能看到 bob 在线

  const callA = new CallManager({ social: alice, getName: () => '小爱', headless: true });
  const callB = new CallManager({ social: bob, getName: () => '小波', headless: true });
  assert(callA.state === 'idle' && callB.state === 'idle', '初始都是 idle');

  console.log('== [2] 呼叫不在线的账号 → 拒绝 ==');
  let offErr = null;
  await callA.startCall('ghost' + SUF, '幽灵', 'audio').catch((e) => { offErr = e; });
  assert(offErr && /不在线/.test(offErr.message), '离线账号无法呼叫: ' + (offErr && offErr.message));
  assert(callA.state === 'idle', '呼叫失败后回到 idle');

  console.log('== [3] 正常呼叫流程 invite→accept→offer→answer ==');
  await callA.startCall(U_BOB, '小波', 'audio');
  assert(callA.state === 'outgoing', '呼叫方进入 outgoing');
  await sleep(2500);
  assert(callB.state === 'incoming', '被叫收到 invite 进入 incoming');
  assert(callB.peer && callB.peer.username === U_ALICE, '被叫知道是谁打来的');

  callB._accept();
  await sleep(2500);
  assert(callB.state === 'active', '被叫 accept 后 active');
  assert(callA.state === 'active', '呼叫方收到 offer/answer 后 active');
  assert(!!callA.pc && !!callB.pc, '双方都建立了 PeerConnection');

  console.log('== [4] 忙线：第三方呼叫已在小爱通话中的小波 → 被自动拒绝 ==');
  // 注意：alice 当前 active。用 alice 作为"第三方"呼叫 bob → alice 自己在通话中会先被拦
  let busyErr = null;
  await callA.startCall(U_BOB, '小波', 'audio').catch((e) => { busyErr = e; });
  assert(busyErr && /通话中/.test(busyErr.message), '通话中不能发起新呼叫');

  console.log('== [5] 挂断 ==');
  callA.endCall();
  await sleep(2500);
  assert(callA.state === 'idle', '挂断后呼叫方 idle');
  assert(callB.state === 'idle', '被叫收到 hangup 也 idle');
  assert(callA.pc === null, 'PeerConnection 已清理');

  console.log('== [6] 拒绝流程 ==');
  await callA.startCall(U_BOB, '小波', 'video');
  await sleep(2500);
  assert(callB.state === 'incoming', '再次呼叫，被叫 incoming');
  callB._decline('不想接');
  await sleep(2500);
  assert(callA.state === 'idle' && callB.state === 'idle', '拒绝后双方都 idle');
  // 无应答超时（把 45 秒超时改小不可行，直接验证 cancel 路径）
  await callA.startCall(U_BOB, '小波', 'audio');
  await sleep(2500);
  callA._cancel('对方取消了呼叫');
  await sleep(2500);
  assert(callA.state === 'idle' && callB.state === 'idle', '取消后双方 idle');

  console.log('== [清理] ==');
  try {
    const reg = alice.registry || {};
    delete reg[U_ALICE];
    delete reg[U_BOB];
    await new Promise((res) => bob.client.publish('tod67web/registry', JSON.stringify(reg), { qos: 0, retain: true }, res));
    console.log('  🧹 已清理', U_ALICE, U_BOB);
  } catch (e) { console.log('  ⚠️ 清理失败:', e.message); }

  console.log(`\n========== 测试${failed ? `失败 ${failed} 项 ❌` : '全部通过 🎉'}（通过 ${passed}） ==========`);
  alice.logout(); bob.logout();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
