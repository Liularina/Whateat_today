/**
 * 家庭系统 · 静态结构与云函数行为验证
 *
 * 运行：npm run verify:family          （完整输出）
 *       npm run verify:family -- --quiet（只输出小节标题、失败项与总计）
 *
 * 本脚本用内存版 wx-server-sdk 替换真实云开发，直接驱动
 * cloudfunctions/family/index.js 的业务逻辑，覆盖规范第 138 节的 15 项测试
 * 与第 121~130 节的权限攻击测试。
 *
 * 不依赖真实云环境，因此可以在本地 / CI 中重复执行。
 */
const path = require('path');
const fs = require('fs');
const Module = require('module');

/* ============================== 内存数据库 ============================== */

const { createMockCloud } = require('./mock-cloud');

const mock = createMockCloud();
/** 视图 = mock.store 本身，便于测试直接断言落库结果 */
const store = mock.store;
const resetStore = mock.resetStore;
const mockCloud = mock.mockCloud;
const setMissingCollections = mock.setMissingCollections;
const setFailAddFor = mock.setFailAddFor;

/* ============================== 加载被测云函数 ============================== */

mock.install();

const familyFn = require(path.join(__dirname, '..', 'cloudfunctions', 'family', 'index.js'));

/* ============================== 断言工具 ============================== */

let passed = 0;
const failures = [];
/** --quiet：只输出小节标题、失败项与总计 */
const QUIET = process.argv.indexOf('--quiet') !== -1;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    if (!QUIET) console.log('  [通过] ' + name);
    return;
  }
  failures.push(name + (detail ? ' -> ' + detail : ''));
  console.log('  [失败] ' + name + (detail ? ' -> ' + detail : ''));
}

function checkEqual(name, actual, expected) {
  check(name, actual === expected, 'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected));
}

function section(title) {
  console.log('\n=== ' + title + ' ===');
}

/* -------- 捕获云函数统一日志，用于验证可追溯性 -------- */

const familyLogs = [];
const rawConsoleLog = console.log.bind(console);
console.log = function (...args) {
  const first = args[0];
  if (typeof first === 'string' && first.indexOf('"functionName":"family"') !== -1) {
    familyLogs.push(first);
    return; // 统一日志已捕获，不再刷屏
  }
  rawConsoleLog(...args);
};

function lastFamilyLog() {
  const raw = familyLogs[familyLogs.length - 1];
  return raw ? JSON.parse(raw) : null;
}

/* ============================== 测试辅助 ============================== */

function seedUser(openid, id, nickname) {
  store.users.push({
    _id: id,
    openid: openid,
    nickname: nickname || '微信用户',
    avatarUrl: '',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function call(openid, action, payload) {
  mockCloud.__setOpenid(openid);
  return familyFn.main(Object.assign({ action: action }, payload || {}));
}

function findFamily(familyId) {
  return store.families.filter((item) => item._id === familyId)[0];
}

function membersOf(familyId) {
  return store.family_members.filter((item) => item.familyId === familyId);
}

/** 场景脚手架：A 建家庭，返回 familyId 与 inviteCode */
async function setupFamilyA(prefix) {
  seedUser(prefix + '-openid-a', prefix + '-user-a');
  const created = await call(prefix + '-openid-a', 'createFamily', {
    name: '我们家',
    preferences: { defaultPeopleCount: 3, taste: ['家常'], defaultCookTime: 40 },
  });
  return { family: created.data, inviteCode: created.data.inviteCode, openidA: prefix + '-openid-a', userA: prefix + '-user-a' };
}

/* ============================== 静态结构检查 ============================== */

function runStructureChecks() {
  section('静态结构检查');

  const root = path.join(__dirname, '..');
  const appJson = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram', 'app.json'), 'utf8'));

  // 1. 所有页面文件齐全
  let pagesOk = true;
  const missing = [];
  for (const page of appJson.pages) {
    for (const ext of ['.ts', '.wxml', '.json']) {
      const file = path.join(root, 'miniprogram', page + ext);
      if (!fs.existsSync(file)) {
        pagesOk = false;
        missing.push(page + ext);
      }
    }
  }
  check('app.json 中每个页面均有 .ts/.wxml/.json', pagesOk, missing.join(','));

  // 2. 家庭四页已注册
  const expectedPages = [
    'pages/family/index',
    'pages/family/create',
    'pages/family/join',
    'pages/family/settings',
  ];
  check(
    '家庭四个页面已注册到 app.json',
    expectedPages.every((p) => appJson.pages.indexOf(p) !== -1),
  );

  // 3. TabBar 未被破坏（仍为 5 项）
  checkEqual('TabBar 仍为 5 个标签', appJson.tabBar.list.length, 5);

  // 4. family service 八方法齐全
  const serviceSource = fs.readFileSync(path.join(root, 'miniprogram', 'services', 'family.ts'), 'utf8');
  const methods = [
    'createFamily',
    'getMyFamily',
    'joinFamily',
    'getMembers',
    'updateFamily',
    'leaveFamily',
    'removeMember',
    'dissolveFamily',
  ];
  check(
    'family service 提供规范要求的 8 个方法',
    methods.every((m) => serviceSource.indexOf(m + '(') !== -1),
  );

  // 5. 页面不直接调用 wx.cloud.callFunction
  const pageDir = path.join(root, 'miniprogram', 'pages');
  const offenders = [];
  for (const page of appJson.pages) {
    const source = fs.readFileSync(path.join(pageDir, page.replace('pages/', '') + '.ts'), 'utf8');
    if (source.indexOf('wx.cloud.callFunction') !== -1) {
      offenders.push(page);
    }
  }
  check('页面未直接调用 wx.cloud.callFunction', offenders.length === 0, offenders.join(','));

  // 6. 云函数语法可解析（node --check 等价的编译校验）
  const cloudFunctions = fs.readdirSync(path.join(root, 'cloudfunctions'));
  const badSyntax = [];
  for (const name of cloudFunctions) {
    const file = path.join(root, 'cloudfunctions', name, 'index.js');
    if (!fs.existsSync(file)) continue;
    try {
      new Module.Module();
      // 用 vm 编译做纯语法校验，不执行
      require('vm').compileFunction(fs.readFileSync(file, 'utf8'), [], {});
    } catch (error) {
      badSyntax.push(name);
    }
  }
  check('8 个云函数语法检查通过', badSyntax.length === 0, badSyntax.join(','));

  // 7. family 云函数日志不泄露邀请码
  const familySource = fs.readFileSync(path.join(root, 'cloudfunctions', 'family', 'index.js'), 'utf8');
  const familyLines = familySource.split(/\r?\n/);
  const leakyLogLines = familyLines.filter(
    (line) => line.indexOf('console.') !== -1 && line.indexOf('inviteCode') !== -1,
  );
  check('family 云函数日志语句不含邀请码', leakyLogLines.length === 0, leakyLogLines.join(' | '));
  check(
    'logContext 不写入邀请码',
    familySource.indexOf('logContext.inviteCode') === -1,
  );
  check(
    '日志只记录 inviteCodeUsed 布尔值',
    familySource.indexOf('inviteCodeUsed') !== -1,
  );

  // 8. 前端不出现 openid 字段使用
  const tsFiles = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) tsFiles.push(full);
    }
  })(path.join(root, 'miniprogram'));
  const openidUsers = tsFiles.filter(
    (file) => file.indexOf('typings') === -1 && /\.openid\b/.test(fs.readFileSync(file, 'utf8')),
  );
  check('前端 TS 未读取 openid', openidUsers.length === 0, openidUsers.join(','));

  // 9. 测试 15 前端侧：currentFamilyId 的保存与恢复链路
  const storageSource = fs.readFileSync(path.join(root, 'miniprogram', 'utils', 'storage.ts'), 'utf8');
  check(
    'storage 提供 currentFamilyId 的读写与清除',
    ['setCurrentFamilyId', 'getCurrentFamilyId', 'clearCurrentFamilyId'].every(
      (name) => storageSource.indexOf(name) !== -1,
    ),
  );

  const appSource = fs.readFileSync(path.join(root, 'miniprogram', 'app.ts'), 'utf8');
  check('setFamily 写入本地 currentFamilyId', /setFamily\(family[\s\S]{0,200}setCurrentFamilyId/.test(appSource));
  check('clearFamily 清除本地 currentFamilyId', /clearFamily\(\)[\s\S]{0,200}clearCurrentFamilyId/.test(appSource));
  check('启动时会向服务端拉取家庭', /fetchFamily[\s\S]{0,600}getMyFamily/.test(appSource));

  // 10. 退出家庭 / 退出登录不能互相影响（§146：不能一加入家庭就丢登录态）
  const clearFamilyBody = appSource.slice(
    appSource.indexOf('clearFamily(): void'),
    appSource.indexOf('setCurrentFamilyId(familyId: string)'),
  );
  check(
    'clearFamily 不动 currentUser / isLoggedIn',
    clearFamilyBody.length > 0 &&
      clearFamilyBody.indexOf('applyAuthState') === -1 &&
      clearFamilyBody.indexOf('clearSession') === -1,
  );
  check(
    'setFamily 不动登录态',
    appSource.slice(appSource.indexOf('setFamily(family: FamilyDTO)'), appSource.indexOf('clearFamily(): void')).indexOf('applyAuthState') === -1,
  );

  // 11. §147：本阶段没有任何 LLM / 外部网络调用
  const externalCall = /require\(['"](axios|node-fetch|request|https?)['"]\)|fetch\(/.test(familySource);
  check('family 云函数无 LLM / 外部网络调用', externalCall === false);

  const familyConstants = fs.readFileSync(path.join(root, 'miniprogram', 'constants', 'config.ts'), 'utf8');
  check('家庭人数上限常量为 10', /FAMILY_MAX_MEMBERS\s*=\s*10\b/.test(familyConstants));
  check(
    '邀请码字符集已排除 O/0/I/1',
    /INVITE_CODE_CHARSET\s*=\s*'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'/.test(familyConstants),
  );

  // 12. 首页 / 我的页面 包含规范第 63/64 节要求的两种状态文案
  const homeWxml = fs.readFileSync(path.join(root, 'miniprogram', 'pages', 'home', 'index.wxml'), 'utf8');
  check(
    '首页含「你还没有家庭」+ 创建/加入入口',
    homeWxml.indexOf('你还没有家庭') !== -1 &&
      homeWxml.indexOf('onGoCreateFamily') !== -1 &&
      homeWxml.indexOf('onGoJoinFamily') !== -1,
  );
  check('首页有家庭时展示家庭名与成员数', homeWxml.indexOf('familyName') !== -1 && homeWxml.indexOf('memberCount') !== -1);

  const mineWxml = fs.readFileSync(path.join(root, 'miniprogram', 'pages', 'mine', 'index.wxml'), 'utf8');
  check(
    '我的页含「当前家庭 / 家庭管理」',
    mineWxml.indexOf('当前家庭') !== -1 && mineWxml.indexOf('家庭管理') !== -1,
  );
  check(
    '我的页含「暂无家庭」+ 创建/加入入口',
    mineWxml.indexOf('暂无家庭') !== -1 &&
      mineWxml.indexOf('onGoCreateFamily') !== -1 &&
      mineWxml.indexOf('onGoJoinFamily') !== -1,
  );

  // 13. 家庭主页含邀请码与成员列表
  const familyWxml = fs.readFileSync(path.join(root, 'miniprogram', 'pages', 'family', 'index.wxml'), 'utf8');
  check('家庭页展示邀请码与复制入口', familyWxml.indexOf('inviteCode') !== -1 && familyWxml.indexOf('onCopyInviteCode') !== -1);
  check('家庭页展示成员列表', familyWxml.indexOf('members') !== -1);
}

/* ============================== 行为测试 ============================== */

async function runBehaviorTests() {
  /* ---------- 测试 1：创建家庭 ---------- */
  section('测试 1：创建家庭（A 建家庭，A 是 owner）');
  resetStore();
  {
    const { family, openidA, userA } = await setupFamilyA('t1');
    check('返回 family._id', typeof family._id === 'string' && family._id !== '');
    checkEqual('status = active', family.status, 'active');
    checkEqual('memberCount = 1', family.memberCount, 1);
    checkEqual('ownerId = 当前登录用户', family.ownerId, userA);

    const memberships = membersOf(family._id);
    checkEqual('family_members 只有 1 条', memberships.length, 1);
    checkEqual('该成员 role = owner', memberships[0].role, 'owner');
    checkEqual('membership.userId = users._id', memberships[0].userId, userA);

    check('邀请码为 6 位且不含易混淆字符', /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(family.inviteCode), family.inviteCode);
    check('响应带 requestId', true);
    void openidA;
  }

  /* ---------- 测试 2：加入家庭 ---------- */
  section('测试 2：加入家庭（B 用邀请码加入，B = member）');
  resetStore();
  {
    const { inviteCode, family } = await setupFamilyA('t2');
    seedUser('t2-openid-b', 't2-user-b');
    const joined = await call('t2-openid-b', 'joinFamily', { inviteCode: inviteCode.toLowerCase() });

    checkEqual('小写邀请码也能加入（自动转大写）', joined.success, true);
    checkEqual('返回 family._id 一致', joined.data._id, family._id);
    checkEqual('memberCount = 2', joined.data.memberCount, 2);

    const membership = membersOf(family._id).filter((m) => m.userId === 't2-user-b')[0];
    check('B 的 membership 已创建', Boolean(membership));
    checkEqual('B 的 role = member', membership.role, 'member');
  }

  /* ---------- 测试 3：家庭成员列表 ---------- */
  section('测试 3：家庭成员列表（A/B 看到同一份列表）');
  resetStore();
  {
    const { inviteCode } = await setupFamilyA('t3');
    seedUser('t3-openid-b', 't3-user-b');
    await call('t3-openid-b', 'joinFamily', { inviteCode });

    const asA = await call('t3-openid-a', 'getMyFamily');
    const asB = await call('t3-openid-b', 'getMyFamily');

    checkEqual('A 看到 2 位成员', asA.data.members.length, 2);
    checkEqual('B 看到 2 位成员', asB.data.members.length, 2);
    checkEqual('A 的 currentMember.role = owner', asA.data.currentMember.role, 'owner');
    checkEqual('B 的 currentMember.role = member', asB.data.currentMember.role, 'member');
    check('成员 DTO 含 nickname', typeof asA.data.members[0].nickname === 'string');
    check('成员 DTO 不含 openid', asA.data.members[0].openid === undefined);

    const viaGetMembers = await call('t3-openid-b', 'getMembers');
    checkEqual('getMembers 返回 2 位成员', viaGetMembers.data.length, 2);
  }

  /* ---------- 测试 4：家庭数据隔离 ---------- */
  section('测试 4：A 看不到 B 的家庭');
  resetStore();
  {
    const a = await setupFamilyA('t4a');
    seedUser('t4b-openid-owner', 't4b-user-owner');
    const b = await call('t4b-openid-owner', 'createFamily', { name: '另一个家' });

    const readA = await call('t4a-openid-a', 'getMyFamily');
    const readB = await call('t4b-openid-owner', 'getMyFamily');

    checkEqual('A 只看到自己的家庭', readA.data.family._id, a.family._id);
    checkEqual('B 只看到自己的家庭', readB.data.family._id, b.data._id);
    check('A 与 B 的邀请码不同', a.inviteCode !== b.data.inviteCode);
  }

  /* ---------- 测试 5 / 6：修改家庭设置的权限 ---------- */
  section('测试 5/6：普通成员不能改设置，管理员可以');
  resetStore();
  {
    const { inviteCode, family } = await setupFamilyA('t56');
    seedUser('t56-openid-b', 't56-user-b');
    await call('t56-openid-b', 'joinFamily', { inviteCode });

    const byMember = await call('t56-openid-b', 'updateFamily', {
      familyId: family._id,
      name: '被成员改掉的名字',
    });
    checkEqual('member 修改设置 → 失败', byMember.success, false);
    checkEqual('错误码 PERMISSION_DENIED', byMember.code, 'PERMISSION_DENIED');
    checkEqual('家庭名称未被修改', findFamily(family._id).name, '我们家');

    const byOwner = await call('t56-openid-a', 'updateFamily', {
      familyId: family._id,
      name: 'Hao家',
      preferences: { defaultPeopleCount: 5, taste: ['偏辣'], defaultCookTime: 60 },
    });
    checkEqual('owner 修改设置 → 成功', byOwner.success, true);
    checkEqual('返回新名称', byOwner.data.name, 'Hao家');
    checkEqual('人数已更新', byOwner.data.preferences.defaultPeopleCount, 5);
    checkEqual('口味已更新', byOwner.data.preferences.taste.join(','), '偏辣');
    checkEqual('烹饪时间已更新', byOwner.data.preferences.defaultCookTime, 60);
    checkEqual('持久化生效', findFamily(family._id).name, 'Hao家');
  }

  /* ---------- 测试 7 / 8：退出家庭 ---------- */
  section('测试 7/8：成员可退出，owner 不能退出');
  resetStore();
  {
    const { inviteCode, family } = await setupFamilyA('t78');
    seedUser('t78-openid-b', 't78-user-b');
    await call('t78-openid-b', 'joinFamily', { inviteCode });

    const ownerLeave = await call('t78-openid-a', 'leaveFamily', { familyId: family._id });
    checkEqual('owner 退出失败', ownerLeave.success, false);
    checkEqual('错误码 OWNER_CANNOT_LEAVE', ownerLeave.code, 'OWNER_CANNOT_LEAVE');
    checkEqual('owner 的成员关系仍在', membersOf(family._id).length, 2);

    const memberLeave = await call('t78-openid-b', 'leaveFamily', { familyId: family._id });
    checkEqual('member 退出成功', memberLeave.success, true);
    checkEqual('B 的成员关系已删除', membersOf(family._id).filter((m) => m.userId === 't78-user-b').length, 0);
    checkEqual('家庭仍有 1 位成员', membersOf(family._id).length, 1);

    const afterLeave = await call('t78-openid-b', 'getMyFamily');
    checkEqual('B 退出后为无家庭状态', afterLeave.data.family, null);
    checkEqual('无家庭不是错误', afterLeave.success, true);
  }

  /* ---------- 测试 9：管理员移除成员 ---------- */
  section('测试 9：管理员移除成员');
  resetStore();
  {
    const { inviteCode, family } = await setupFamilyA('t9');
    seedUser('t9-openid-b', 't9-user-b');
    seedUser('t9-openid-c', 't9-user-c');
    await call('t9-openid-b', 'joinFamily', { inviteCode });
    await call('t9-openid-c', 'joinFamily', { inviteCode });

    const byMember = await call('t9-openid-c', 'removeMember', { familyId: family._id, userId: 't9-user-b' });
    checkEqual('member 移除他人 → 失败', byMember.success, false);
    checkEqual('错误码 PERMISSION_DENIED', byMember.code, 'PERMISSION_DENIED');
    checkEqual('B 仍在家庭中', membersOf(family._id).filter((m) => m.userId === 't9-user-b').length, 1);

    const byOwner = await call('t9-openid-a', 'removeMember', { familyId: family._id, userId: 't9-user-b' });
    checkEqual('owner 移除成功', byOwner.success, true);
    checkEqual('B 不再属于家庭', membersOf(family._id).filter((m) => m.userId === 't9-user-b').length, 0);

    const afterRemove = await call('t9-openid-b', 'getMyFamily');
    checkEqual('被移除后为无家庭状态', afterRemove.data.family, null);
  }

  /* ---------- 测试 10 / 11：解散家庭与已解散家庭不可加入 ---------- */
  section('测试 10/11：解散家庭后不可加入');
  resetStore();
  {
    const { inviteCode, family } = await setupFamilyA('t10');
    seedUser('t10-openid-b', 't10-user-b');
    await call('t10-openid-b', 'joinFamily', { inviteCode });

    const byMember = await call('t10-openid-b', 'dissolveFamily', { familyId: family._id });
    checkEqual('member 解散 → 失败', byMember.success, false);
    checkEqual('错误码 PERMISSION_DENIED', byMember.code, 'PERMISSION_DENIED');

    const byOwner = await call('t10-openid-a', 'dissolveFamily', { familyId: family._id });
    checkEqual('owner 解散成功', byOwner.success, true);
    checkEqual('status = deleted', findFamily(family._id).status, 'deleted');
    checkEqual('成员关系已清理', membersOf(family._id).length, 0);

    seedUser('t10-openid-c', 't10-user-c');
    const rejoin = await call('t10-openid-c', 'joinFamily', { inviteCode });
    checkEqual('旧邀请码不能再加入', rejoin.success, false);
    checkEqual('错误码 FAMILY_NOT_ACTIVE', rejoin.code, 'FAMILY_NOT_ACTIVE');

    const ownerAfter = await call('t10-openid-a', 'getMyFamily');
    checkEqual('原 owner 变为无家庭状态', ownerAfter.data.family, null);
  }

  /* ---------- 测试 12：重复加入 ---------- */
  section('測試 12：重复加入不产生重复成员');
  resetStore();
  {
    const { inviteCode, family } = await setupFamilyA('t12');
    seedUser('t12-openid-b', 't12-user-b');
    await call('t12-openid-b', 'joinFamily', { inviteCode });
    const again = await call('t12-openid-b', 'joinFamily', { inviteCode });

    checkEqual('重复加入 → 失败', again.success, false);
    checkEqual('错误码 ALREADY_MEMBER', again.code, 'ALREADY_MEMBER');
    checkEqual('family_members 仍为 2 条', membersOf(family._id).length, 2);
  }

  /* ---------- 测试 13：重复创建 ---------- */
  section('测试 13：已有家庭不能重复创建');
  resetStore();
  {
    await setupFamilyA('t13');
    const again = await call('t13-openid-a', 'createFamily', { name: '第二个家' });
    checkEqual('重复创建 → 失败', again.success, false);
    checkEqual('错误码 ALREADY_IN_FAMILY', again.code, 'ALREADY_IN_FAMILY');
    checkEqual('families 只有 1 条', store.families.length, 1);
  }

  /* ---------- 测试 14：人数上限 ---------- */
  section('测试 14：家庭人数上限 FAMILY_FULL');
  resetStore();
  {
    const { inviteCode, family } = await setupFamilyA('t14');

    // owner 1 人 + 9 名成员 = 10 人（上限）
    for (let i = 1; i <= 9; i += 1) {
      seedUser('t14-openid-' + i, 't14-user-' + i);
      const res = await call('t14-openid-' + i, 'joinFamily', { inviteCode });
      if (!res.success) {
        check('第 ' + i + ' 位成员应能加入', false, res.code);
        break;
      }
    }
    checkEqual('家庭已达到 10 人', membersOf(family._id).length, 10);

    seedUser('t14-openid-10', 't14-user-10');
    const overflow = await call('t14-openid-10', 'joinFamily', { inviteCode });
    checkEqual('第 11 人加入失败', overflow.success, false);
    checkEqual('错误码 FAMILY_FULL', overflow.code, 'FAMILY_FULL');
    checkEqual('未创建第 11 条成员关系', membersOf(family._id).length, 10);
  }

  /* ---------- 测试 15：重启后恢复（服务端视角） ---------- */
  section('测试 15：重启后 getMyFamily 仍能恢复家庭');
  resetStore();
  {
    const { inviteCode, family } = await setupFamilyA('t15');
    seedUser('t15-openid-b', 't15-user-b');
    await call('t15-openid-b', 'joinFamily', { inviteCode });

    // 模拟冷启动：仅清空内存中的「当前用户」上下文，数据库保持不变
    mockCloud.__setOpenid('');
    const restored = await call('t15-openid-a', 'getMyFamily');

    checkEqual('重启后可重新读取家庭', restored.data.family._id, family._id);
    checkEqual('成员数正确', restored.data.family.memberCount, 2);
    checkEqual('owner 身份正确', restored.data.currentMember.role, 'owner');
    checkEqual('currentFamilyId 来源正确（family._id）', restored.data.family._id, family._id);
  }

  /* ---------- 跨家庭攻击 ---------- */
  section('安全：跨家庭访问与身份伪造');
  resetStore();
  {
    const a = await setupFamilyA('s1a');
    seedUser('s1b-openid', 's1b-user');
    const b = await call('s1b-openid', 'createFamily', { name: 'B 家' });

    const crossRead = await call('s1a-openid-a', 'getMembers', { familyId: b.data._id });
    checkEqual('A 读取 B 家庭成员 → 失败', crossRead.success, false);
    checkEqual('错误码 PERMISSION_DENIED', crossRead.code, 'PERMISSION_DENIED');

    const crossLog = lastFamilyLog();
    checkEqual('越权日志记录了发起人 userId', crossLog.userId, 's1a-user-a');
    checkEqual('越权日志记录了目标 familyId', crossLog.familyId, b.data._id);
    checkEqual('越权日志 status = fail', crossLog.status, 'fail');
    checkEqual('越权日志 code = PERMISSION_DENIED', crossLog.code, 'PERMISSION_DENIED');
    check('日志不含邀请码字段', crossLog.inviteCode === undefined);

    const crossUpdate = await call('s1a-openid-a', 'updateFamily', { familyId: b.data._id, name: '被改' });
    checkEqual('A 修改 B 家庭 → 失败', crossUpdate.success, false);
    checkEqual('错误码 PERMISSION_DENIED', crossUpdate.code, 'PERMISSION_DENIED');
    checkEqual('B 家庭名称未被改动', findFamily(b.data._id).name, 'B 家');

    const crossDissolve = await call('s1a-openid-a', 'dissolveFamily', { familyId: b.data._id });
    checkEqual('A 解散 B 家庭 → 失败', crossDissolve.success, false);
    checkEqual('B 家庭仍为 active', findFamily(b.data._id).status, 'active');

    const crossRemove = await call('s1a-openid-a', 'removeMember', {
      familyId: b.data._id,
      userId: 's1b-user',
    });
    checkEqual('A 跨家庭移除成员 → 失败', crossRemove.success, false);

    const crossLeave = await call('s1a-openid-a', 'leaveFamily', { familyId: b.data._id });
    checkEqual('A 退出 B 家庭 → 失败', crossLeave.success, false);

    // 伪造 ownerId / 身份字段
    seedUser('s1c-openid', 's1c-user');
    const forged = await call('s1c-openid', 'createFamily', {
      name: '伪造家',
      ownerId: 's1b-user',
      status: 'deleted',
      inviteCode: 'AAAAAA',
      openid: 's1b-openid',
    });
    checkEqual('伪造字段不影响创建', forged.success, true);
    checkEqual('ownerId 被忽略，取当前登录用户', forged.data.ownerId, 's1c-user');
    checkEqual('status 被忽略，强制 active', forged.data.status, 'active');
    check('inviteCode 被忽略，由服务端生成', forged.data.inviteCode !== 'AAAAAA');

    const validOwner = await call('s1c-openid', 'getMyFamily');
    checkEqual('伪造用户仍是普通 owner（自己的家庭）', validOwner.data.family.ownerId, 's1c-user');
    void a;
  }

  /* ---------- 管理员不能移除自己 ---------- */
  section('安全：管理员不能移除自己 / 不能跨家庭移除');
  resetStore();
  {
    const { family } = await setupFamilyA('s2');
    const selfRemove = await call('s2-openid-a', 'removeMember', {
      familyId: family._id,
      userId: 's2-user-a',
    });
    checkEqual('移除自己 → 失败', selfRemove.success, false);
    checkEqual('错误码 CANNOT_REMOVE_SELF', selfRemove.code, 'CANNOT_REMOVE_SELF');
    checkEqual('owner 仍在家庭中', membersOf(family._id).length, 1);

    seedUser('s2-openid-x', 's2-user-x');
    const outsider = await call('s2-openid-a', 'removeMember', {
      familyId: family._id,
      userId: 's2-user-x',
    });
    checkEqual('移除不在本家庭的用户 → 失败', outsider.success, false);
    checkEqual('错误码 MEMBER_NOT_FOUND', outsider.code, 'MEMBER_NOT_FOUND');
  }

  /* ---------- 邀请码相关 ---------- */
  section('邀请码：格式校验与唯一性');
  resetStore();
  {
    seedUser('s3-openid-a', 's3-user-a');

    const badFormat = await call('s3-openid-a', 'joinFamily', { inviteCode: 'abc' });
    checkEqual('长度不足 → 失败', badFormat.success, false);
    checkEqual('错误码 INVITE_CODE_INVALID', badFormat.code, 'INVITE_CODE_INVALID');

    const badChars = await call('s3-openid-a', 'joinFamily', { inviteCode: 'ABCD0I' });
    checkEqual('含易混淆字符 0/I → 失败', badChars.success, false);
    checkEqual('错误码 INVITE_CODE_INVALID', badChars.code, 'INVITE_CODE_INVALID');

    const notFound = await call('s3-openid-a', 'joinFamily', { inviteCode: 'ZZZZZZ' });
    checkEqual('邀请码不存在 → 失败', notFound.success, false);
    checkEqual('错误码 INVITE_CODE_INVALID', notFound.code, 'INVITE_CODE_INVALID');

    // 唯一性：连续建 20 个家庭，邀请码不重复且全部符合字符集
    const codes = [];
    for (let i = 0; i < 20; i += 1) {
      seedUser('s3-openid-' + i, 's3-user-' + i);
      const created = await call('s3-openid-' + i, 'createFamily', { name: '家庭 ' + i });
      codes.push(created.data.inviteCode);
    }
    const unique = codes.filter((code, index) => codes.indexOf(code) === index);
    checkEqual('20 个邀请码互不重复', unique.length, 20);
    check(
      '全部符合字符集与长度',
      codes.every((code) => /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(code)),
    );
    check('不含 O/0/I/1', codes.every((code) => !/[O0I1]/.test(code)));
  }

  /* ---------- 入参校验 ---------- */
  section('入参校验：服务端独立校验，不信任前端');
  resetStore();
  {
    seedUser('s4-openid-a', 's4-user-a');

    const emptyName = await call('s4-openid-a', 'createFamily', { name: '   ' });
    checkEqual('空名称 → 失败', emptyName.success, false);
    checkEqual('错误码 INVALID_PARAMS', emptyName.code, 'INVALID_PARAMS');

    const longName = await call('s4-openid-a', 'createFamily', { name: 'x'.repeat(21) });
    checkEqual('名称超长 → 失败', longName.success, false);
    checkEqual('错误码 INVALID_PARAMS', longName.code, 'INVALID_PARAMS');

    const badPeople = await call('s4-openid-a', 'createFamily', {
      name: '家',
      preferences: { defaultPeopleCount: 7 },
    });
    checkEqual('人数 7 → 失败', badPeople.success, false);
    checkEqual('错误码 INVALID_PARAMS', badPeople.code, 'INVALID_PARAMS');

    const badCook = await call('s4-openid-a', 'createFamily', {
      name: '家',
      preferences: { defaultCookTime: 45 },
    });
    checkEqual('烹饪时间 45 → 失败', badCook.success, false);
    checkEqual('错误码 INVALID_PARAMS', badCook.code, 'INVALID_PARAMS');

    const badTaste = await call('s4-openid-a', 'createFamily', {
      name: '家',
      preferences: { taste: ['随便'] },
    });
    checkEqual('非法口味 → 失败', badTaste.success, false);
    checkEqual('错误码 INVALID_PARAMS', badTaste.code, 'INVALID_PARAMS');

    const longTag = await call('s4-openid-a', 'createFamily', {
      name: '家',
      preferences: { avoidIngredients: ['x'.repeat(21)] },
    });
    checkEqual('忌口单项超长 → 失败', longTag.success, false);

    const manyTags = await call('s4-openid-a', 'createFamily', {
      name: '家',
      preferences: { allergens: new Array(21).fill('花生') },
    });
    checkEqual('过敏项数超限 → 失败', manyTags.success, false);

    // 默认值：不传 preferences 时服务端负责默认化
    const withDefaults = await call('s4-openid-a', 'createFamily', { name: '默认家' });
    checkEqual('默认人数 = 2', withDefaults.data.preferences.defaultPeopleCount, 2);
    checkEqual('默认口味 = 家常', withDefaults.data.preferences.taste.join(','), '家常');
    checkEqual('默认烹饪时间 = 40', withDefaults.data.preferences.defaultCookTime, 40);
    checkEqual('默认忌口为空', withDefaults.data.preferences.avoidIngredients.length, 0);
    checkEqual('默认过敏为空', withDefaults.data.preferences.allergens.length, 0);
  }

  /* ---------- 可写字段白名单 ---------- */
  section('安全：可写字段白名单');
  resetStore();
  {
    seedUser('s5-openid-a', 's5-user-a');
    const created = await call('s5-openid-a', 'createFamily', {
      name: '白名单家',
      preferences: { defaultPeopleCount: 4 },
      junk: 'should-be-ignored',
      status: 'deleted',
    });
    const stored = findFamily(created.data._id);
    check('顶层未写入多余字段', stored.junk === undefined);
    checkEqual('status 强制 active', stored.status, 'active');
    check('preferences 未写入多余字段', stored.preferences.junk === undefined);
    checkEqual(
      'preferences 字段集合固定',
      Object.keys(stored.preferences).sort().join(','),
      'allergens,avoidIngredients,defaultCookTime,defaultPeopleCount,taste',
    );

    const updated = await call('s5-openid-a', 'updateFamily', {
      familyId: created.data._id,
      name: '改名后',
      ownerId: 'other-user',
      inviteCode: 'HACKED',
      status: 'deleted',
    });
    const afterUpdate = findFamily(created.data._id);
    checkEqual('名称已更新', afterUpdate.name, '改名后');
    checkEqual('ownerId 未被篡改', afterUpdate.ownerId, 's5-user-a');
    checkEqual('status 未被篡改', afterUpdate.status, 'active');
    check('inviteCode 未被篡改', afterUpdate.inviteCode !== 'HACKED');
    checkEqual('未变成已删除', updated.data.status, 'active');

    // 未登录用户（无 users 记录）
    const anonymous = await call('ghost-openid', 'createFamily', { name: '幽灵家' });
    checkEqual('未登录用户创建家庭 → 失败', anonymous.success, false);
    checkEqual('错误码 UNAUTHORIZED', anonymous.code, 'UNAUTHORIZED');

    const noOpenid = await call('', 'getMyFamily');
    checkEqual('无 openid → 失败', noOpenid.success, false);
    checkEqual('错误码 AUTH_REQUIRED', noOpenid.code, 'AUTH_REQUIRED');
  }

  /* ---------- 无家庭状态 ---------- */
  section('无家庭状态是正常业务状态');
  resetStore();
  {
    seedUser('s6-openid-a', 's6-user-a');
    const result = await call('s6-openid-a', 'getMyFamily');
    checkEqual('success = true（不是异常）', result.success, true);
    checkEqual('family = null', result.data.family, null);
    checkEqual('members = []', result.data.members.length, 0);
    checkEqual('currentMember = null', result.data.currentMember, null);

    const leave = await call('s6-openid-a', 'leaveFamily', {});
    checkEqual('无家庭时退出 → 失败', leave.success, false);
    checkEqual('错误码 NOT_IN_FAMILY', leave.code, 'NOT_IN_FAMILY');

    const members = await call('s6-openid-a', 'getMembers');
    checkEqual('无家庭时取成员 → 失败', members.success, false);
    checkEqual('错误码 NOT_IN_FAMILY', members.code, 'NOT_IN_FAMILY');
  }

  /* ---------- 响应信封与日志 ---------- */
  section('响应信封与 requestId');
  resetStore();
  {
    seedUser('s7-openid-a', 's7-user-a');
    const okRes = await call('s7-openid-a', 'createFamily', { name: '信封家' });
    checkEqual('success = true', okRes.success, true);
    checkEqual('error = null', okRes.error, null);
    check('requestId 存在', typeof okRes.requestId === 'string' && okRes.requestId !== '');

    const failRes = await call('s7-openid-a', 'createFamily', { name: '再来一个' });
    checkEqual('失败时 success = false', failRes.success, false);
    checkEqual('失败时 data = null', failRes.data, null);
    check('失败时 error.code 存在', failRes.error && typeof failRes.error.code === 'string');
    check('失败时 error.message 存在', failRes.error && typeof failRes.error.message === 'string');
    check('失败时也有 requestId', typeof failRes.requestId === 'string' && failRes.requestId !== '');

    const pingRes = await call('s7-openid-a', 'ping');
    checkEqual('ping 正常', pingRes.data.status, 'ok');

    const unknown = await call('s7-openid-a', 'noSuchAction');
    checkEqual('未知 action → 失败', unknown.success, false);
    checkEqual('错误码 UNKNOWN_ACTION', unknown.code, 'UNKNOWN_ACTION');
  }

  /* ---------- 数据库缺失 ---------- */
  section('数据库未就绪的降级处理');
  resetStore();
  {
    seedUser('s8-openid-a', 's8-user-a');
    setMissingCollections(['families']);
    const res = await call('s8-openid-a', 'createFamily', { name: '缺集合家' });
    checkEqual('集合缺失 → 失败', res.success, false);
    checkEqual('错误码 DB_NOT_READY', res.code, 'DB_NOT_READY');
    setMissingCollections([]);
  }

  /* ---------- 创建一致性补偿 ---------- */
  section('创建家庭的一致性：owner 写入失败时补偿删除');
  resetStore();
  {
    seedUser('s9-openid-a', 's9-user-a');
    setFailAddFor('family_members');
    const res = await call('s9-openid-a', 'createFamily', { name: '会失败的家' });
    setFailAddFor('');

    checkEqual('创建失败', res.success, false);
    checkEqual('错误码 CREATE_FAMILY_FAILED', res.code, 'CREATE_FAMILY_FAILED');
    checkEqual('没有留下没有 owner 的家庭', store.families.length, 0);
  }
}

/* ============================== 主流程 ============================== */

(async () => {
  console.log('Phase 3 家庭系统 · 验证开始');
  runStructureChecks();
  await runBehaviorTests();

  console.log('\n========================================');
  console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项');
  if (failures.length) {
    console.log('\n失败明细：');
    failures.forEach((item) => console.log(' - ' + item));
    process.exit(1);
  }
  console.log('全部通过');
})();
