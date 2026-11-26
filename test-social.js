/**
 * test-social.js — 账号/好友/私聊端到端测试（Node + 真实公共 MQTT broker）
 * 模拟浏览器环境：window / localStorage / mqtt 全局
 * 每次运行使用随机用户名，结束时清理测试账号，不污染真实注册表
 */
global.window = global;

// localStorage shim
const _store = new Map();
global.localStorage = {
  getItem: (k) => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => _store.set(k, String(v)),
  removeItem: (k) => _store.delete(k),
};

global.mqtt = require('/Users/s032005/.workbuddy/binaries/node/workspace/node_modules/mqtt');

require('/Users/s032005/WorkBuddy/eddys-67web/social.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function assert(cond, desc) {
  if (cond) { passed++; console.log('  ✅', desc); }
  else { failed++; console.log('  ❌', desc); }
}

// 每次运行唯一的用户名前缀
const SUF = 't' + Date.now().toString(36).slice(-6) + Math.floor(Math.random() * 999);
const U_ALICE = 'a' + SUF;
const U_BOB = 'b' + SUF;
const U_CAROL = 'c' + SUF;

function makeSocial() {
  return new SocialNet();
}

(async () => {
  console.log('== [1] 注册 ==');
  const alice = makeSocial();
  const bob = makeSocial();

  let regErrA = null;
  const uA = await alice.register(U_ALICE, 'pass1234').catch((e) => { regErrA = e; });
  assert(!regErrA, U_ALICE + ' 注册成功' + (regErrA ? '（' + regErrA.message + '）' : ''));
  assert(uA && uA.username === U_ALICE, '注册返回账号信息');

  let regErrB = null;
  const uB = await bob.register(U_BOB, 'bobpass').catch((e) => { regErrB = e; });
  assert(!regErrB, U_BOB + ' 注册成功' + (regErrB ? '（' + regErrB.message + '）' : ''));

  await sleep(1200);
  const dupErr = await alice.register(U_ALICE, 'xxxx').catch((e) => e);
  assert(dupErr && /已经/.test(dupErr.message), '重复用户名被拒绝: ' + (dupErr && dupErr.message));

  console.log('== [2] 登录 ==');
  const alice2 = makeSocial();
  const badErr = await alice2.login(U_ALICE, 'wrongpass').catch((e) => e);
  assert(badErr && /密码/.test(badErr.message), '错误密码被拒绝');
  const okUser = await alice2.login(U_ALICE, 'pass1234').catch((e) => { console.log(e.message); });
  assert(okUser && okUser.username === U_ALICE, '正确密码登录成功');
  const noUser = await alice2.login('nobody999', 'pass1234').catch((e) => e);
  assert(noUser && /不存在/.test(noUser.message), '不存在用户名被拒绝');

  console.log('== [3] 搜索用户 ==');
  await sleep(1500); // 等 registry retained 传到 bob
  const found = bob.searchUser(U_ALICE);
  assert(found.exists, 'bob 能搜到 ' + U_ALICE);
  const notFound = bob.searchUser('ghost12345');
  assert(!notFound.exists, '搜不到不存在的用户');

  console.log('== [4] 好友申请 → 同意 ==');
  let aliceGotReq = null;
  alice.onFriendRequest = (msg) => {
    aliceGotReq = msg;
    alice.acceptFriend(msg.from, msg.name);
  };
  let bobGotResult = null;
  bob.onFriendResult = (msg) => { bobGotResult = msg; };

  await bob.addFriend(U_ALICE).catch((e) => console.log('addFriend err:', e.message));
  await sleep(2500);
  assert(aliceGotReq && aliceGotReq.from === U_BOB, 'alice 收到好友申请');
  assert(bobGotResult && bobGotResult.ok === true, 'bob 收到同意回执');
  assert(alice.friends.some((f) => f.username === U_BOB), 'alice 好友列表里有 bob');
  assert(bob.friends.some((f) => f.username === U_ALICE), 'bob 好友列表里有 alice');

  console.log('== [5] 拒绝申请 ==');
  const carol2 = makeSocial();
  await carol2.register(U_CAROL, 'carolpass').catch((e) => console.log('carol reg err:', e.message));
  let carolGotDecline = null;
  carol2.onFriendResult = (msg) => { if (!msg.ok) carolGotDecline = msg; };
  let bobSawRequest = false;
  bob.onFriendRequest = (msg) => {
    if (msg.from === U_CAROL) {
      bobSawRequest = true;
      bob.declineFriend(msg.from);
    }
  };
  await carol2.addFriend(U_BOB).catch((e) => console.log('addFriend err:', e.message));
  await sleep(2500);
  assert(bobSawRequest, 'bob 收到 carol 的申请');
  assert(carolGotDecline && carolGotDecline.from === U_BOB, 'carol 收到拒绝回执');
  assert(!bob.friends.some((f) => f.username === U_CAROL), '拒绝后不是好友');

  console.log('== [6] 私聊 ==');
  let aliceGotDM = null;
  alice.onDM = (msg, isOpen) => { aliceGotDM = { msg, isOpen }; };
  await bob.sendDM(U_ALICE, '你好呀，晚上开黑吗？').catch((e) => console.log('sendDM err:', e.message));
  await sleep(2000);
  assert(aliceGotDM && aliceGotDM.msg.text === '你好呀，晚上开黑吗？', 'alice 收到私聊消息');
  assert(alice.dmHistory(U_BOB).some((m) => m.text === '你好呀，晚上开黑吗？'), '消息进了 alice 的历史记录');
  assert(bob.dmHistory(U_ALICE).some((m) => m.mine), 'bob 本地也保存了自己发的消息');
  const unreadBefore = alice.unread.get(U_BOB) || 0;
  assert(unreadBefore >= 1, '未读计数 ≥ 1');
  alice.clearUnread(U_BOB);
  assert((alice.unread.get(U_BOB) || 0) === 0, '打开会话后未读清零');

  console.log('== [7] 在线状态 ==');
  // 心跳在 register/login 时已启动，等心跳传播
  await sleep(7000);
  assert(bob.onlineOf(U_ALICE) === true, 'bob 看到 alice 在线');
  assert(alice.onlineOf(U_BOB) === true, 'alice 看到 bob 在线');

  console.log('== [8] 改名 ==');
  const newName = '小爱' + SUF.slice(-3);
  await alice.changeName(newName).catch((e) => console.log('rename err:', e.message));
  assert(alice.user.name === newName, '本地名字已更新');
  await sleep(2000);
  const after = bob.searchUser(U_ALICE);
  assert(after.exists && after.name === newName, 'bob 搜到的新名字: ' + after.name);

  console.log('== [9] 退出登录 ==');
  alice2.logout();
  assert(alice2.loadSession() === null, '退出后本机登录态清除');

  console.log('== [清理] 删除测试账号，还原注册表 ==');
  try {
    const reg = bob.registry || {};
    delete reg[U_ALICE];
    delete reg[U_BOB];
    delete reg[U_CAROL];
    bob.client.publish('tod67web/registry', JSON.stringify(reg), { qos: 0, retain: true });
    console.log('  🧹 已清理', U_ALICE, U_BOB, U_CAROL);
  } catch (e) {
    console.log('  ⚠️ 清理失败（不影响测试结果）:', e.message);
  }

  console.log(`\n========== 测试${failed ? `失败 ${failed} 项 ❌` : '全部通过 🎉'}（通过 ${passed}） ==========`);
  process.exit(failed ? 1 : 0);
})();
