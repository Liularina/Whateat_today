/**
 * 历史记录 · 静态结构与云函数行为验证（Phase 11）
 *
 * 运行：npm run verify:history            （完整输出）
 *       npm run verify:history -- --quiet （只输出小节标题、失败项与总计）
 *
 * 用内存版 wx-server-sdk（tools/mock-cloud.js）替换真实云开发，直接驱动
 * cloudfunctions/menu/index.js 与 cloudfunctions/order/index.js，覆盖：
 *   1. 历史菜单：分页、状态筛选、日期范围、家庭隔离、集合缺失降级；
 *   2. 历史点单：跨家庭隔离、已关闭订单只读、汇总来自服务端；
 *   3. 静态检查：页面文件齐全、接口没有被重复命名、返回不含敏感字段。
 */
const path = require('path');
const fs = require('fs');

const { createMockCloud } = require('./mock-cloud');

const mock = createMockCloud();
const store = mock.store;
const resetStore = mock.resetStore;
const setMissingCollections = mock.setMissingCollections;

mock.install();

const menuFn = require(path.join(__dirname, '..', 'cloudfunctions', 'menu', 'index.js'));
const orderFn = require(path.join(__dirname, '..', 'cloudfunctions', 'order', 'index.js'));

/* ============================== 断言工具 ============================== */

let passed = 0;
const failures = [];
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
  check(
    name,
    actual === expected,
    'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected),
  );
}

function section(title) {
  console.log('\n=== ' + title + ' ===');
}

/* ============================== 测试辅助 ============================== */

/** 屏蔽云函数自身日志，避免刷屏 */
const rawLog = console.log.bind(console);
const captured = [];
console.log = function (...args) {
  const first = args[0];
  if (typeof first === 'string' && first.charAt(0) === '{' && first.indexOf('"functionName"') !== -1) {
    captured.push(first);
    return;
  }
  rawLog(...args);
};

async function callMenu(openid, action, payload) {
  mock.setOpenid(openid);
  return menuFn.main(Object.assign({ action: action }, payload || {}));
}

async function callOrder(openid, action, payload) {
  mock.setOpenid(openid);
  return orderFn.main(Object.assign({ action: action }, payload || {}));
}

/* ============================== 造数据 ============================== */

const FAMILY_A = 'family-a';
const FAMILY_B = 'family-b';

const USER_A = { _id: 'user-a', openid: 'openid-a', nickName: '小明' };
const USER_B = { _id: 'user-b', openid: 'openid-b', nickName: '小红' };
const USER_C = { _id: 'user-c', openid: 'openid-c', nickName: '外人' };

function seedUsersAndFamilies() {
  resetStore();
  store.users.push(clone(USER_A), clone(USER_B), clone(USER_C));

  store.family_members.push(
    { _id: 'm-a', familyId: FAMILY_A, userId: USER_A._id, role: 'owner' },
    { _id: 'm-b', familyId: FAMILY_A, userId: USER_B._id, role: 'member' },
    { _id: 'm-c', familyId: FAMILY_B, userId: USER_C._id, role: 'owner' },
  );

  store.families.push(
    { _id: FAMILY_A, name: '小明家', ownerUserId: USER_A._id },
    { _id: FAMILY_B, name: '别人家', ownerUserId: USER_C._id },
  );
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** 造一份菜单（默认已确认） */
function pushMenu(options) {
  const opt = options || {};
  const items = opt.items || [
    { recipeId: 'r-1', name: '番茄炒蛋', category: '家常菜', cookTime: 15, difficulty: 'easy', ingredients: [{ name: '番茄' }, { name: '鸡蛋' }], locked: false },
    { recipeId: 'r-2', name: '紫菜蛋花汤', category: '汤类', cookTime: 10, difficulty: 'easy', ingredients: [{ name: '紫菜' }], locked: false },
  ];
  store.menus.push({
    _id: opt._id,
    familyId: opt.familyId || FAMILY_A,
    userId: opt.userId || USER_A._id,
    mealType: opt.mealType || 'dinner',
    servings: opt.servings || 2,
    items: items,
    status: opt.status || 'confirmed',
    createdAt: opt.createdAt || '2026-10-01T10:00:00.000Z',
    updatedAt: opt.updatedAt || opt.createdAt || '2026-10-01T10:00:00.000Z',
  });
}

/** 造一份点单 */
function pushOrder(options) {
  const opt = options || {};
  store.family_orders.push({
    _id: opt._id,
    familyId: opt.familyId || FAMILY_A,
    menuId: opt.menuId || 'menu-1',
    menuName: opt.menuName || 'dinner · 2人份',
    title: opt.title || '今晚吃什么',
    status: opt.status || 'open',
    deadline: opt.deadline || '',
    note: opt.note || '',
    initiatorUserId: opt.initiatorUserId || USER_A._id,
    recipeIds: opt.recipeIds || ['r-1', 'r-2'],
    createdAt: opt.createdAt || '2026-10-01T10:00:00.000Z',
    updatedAt: opt.updatedAt || '2026-10-01T10:00:00.000Z',
    closedAt: opt.closedAt,
  });
}

/* ============================== 静态结构检查 ============================== */

function runStructureChecks() {
  section('静态结构检查');

  const root = path.join(__dirname, '..');
  const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
  const exists = (...parts) => fs.existsSync(path.join(root, ...parts));

  for (const ext of ['ts', 'wxml', 'wxss', 'json']) {
    check('存在 pages/menu/index.' + ext, exists('miniprogram', 'pages', 'menu', 'index.' + ext));
    check('存在 pages/menu-detail/index.' + ext, exists('miniprogram', 'pages', 'menu-detail', 'index.' + ext));
  }

  const menuService = read('miniprogram', 'services', 'menu.ts');
  check('menu 服务暴露 getMenuHistory', menuService.indexOf('getMenuHistory') !== -1);
  check('menu 服务暴露 getTodayMenu', menuService.indexOf('getTodayMenu') !== -1);

  const menuPage = read('miniprogram', 'pages', 'menu', 'index.ts');
  check('历史菜单页调用 getMenuHistory', menuPage.indexOf('getMenuHistory') !== -1);
  check('历史菜单页支持触底分页', menuPage.indexOf('onReachBottom') !== -1);

  const menuDetailPage = read('miniprogram', 'pages', 'menu-detail', 'index.ts');
  check('菜单详情页可跳菜谱详情', menuDetailPage.indexOf('/pages/recipes/detail') !== -1);

  const orderDetailPage = read('miniprogram', 'pages', 'order-detail', 'index.ts');
  check('点单详情页可跳菜谱详情', orderDetailPage.indexOf('/pages/recipes/detail') !== -1);

  const recipeDetailPage = read('miniprogram', 'pages', 'recipes', 'detail.ts');
  check('菜谱详情页支持历史快照兜底菜名', recipeDetailPage.indexOf('fallbackName') !== -1);

  const mineWxml = read('miniprogram', 'pages', 'mine', 'index.wxml');
  check('我的页提供历史菜单入口', mineWxml.indexOf('历史菜单') !== -1);
  check('我的页提供历史点单入口', mineWxml.indexOf('历史点单') !== -1);

  /* 不重复建设：order 云函数只有一个 listOrders 定义 */
  const orderFnSrc = read('cloudfunctions', 'order', 'index.js');
  const listOrdersDefs = orderFnSrc.split('function handleListOrders').length - 1;
  checkEqual('order 只有一个 listOrders 实现', listOrdersDefs, 1);

  /* 历史查询不返回敏感字段 */
  const menuFnSrc = read('cloudfunctions', 'menu', 'index.js');
  check('menu 历史查询不返回 apiKey', menuFnSrc.indexOf('apiKey') === -1);
}

/* ============================== 历史菜单行为 ============================== */

async function runMenuHistoryTests() {
  section('历史菜单：列表 / 排序 / 分页 / 筛选 / 隔离');

  seedUsersAndFamilies();

  pushMenu({ _id: 'menu-1', createdAt: '2026-10-01T10:00:00.000Z' });
  pushMenu({ _id: 'menu-2', createdAt: '2026-10-03T10:00:00.000Z', mealType: 'lunch' });
  pushMenu({ _id: 'menu-3', createdAt: '2026-10-05T10:00:00.000Z' });
  pushMenu({ _id: 'menu-draft', createdAt: '2026-10-06T10:00:00.000Z', status: 'draft' });
  pushMenu({ _id: 'menu-other', familyId: FAMILY_B, userId: USER_C._id, createdAt: '2026-10-07T10:00:00.000Z' });

  /* ---------- 默认只返回本家庭已确认菜单，按时间倒序 ---------- */
  const list = await callMenu(USER_A.openid, 'getMenuHistory', { familyId: FAMILY_A });
  checkEqual('历史列表成功', list.success, true);
  checkEqual('只返回本家庭已确认菜单（草稿与别家都排除）', list.data.total, 3);
  checkEqual('倒序第一条是最新的 menu-3', list.data.items[0].menuId, 'menu-3');
  checkEqual('倒序最后一条是 menu-1', list.data.items[2].menuId, 'menu-1');
  checkEqual('第一条菜品数量正确', list.data.items[0].dishCount, 2);
  checkEqual('菜品名称摘要正确', list.data.items[0].dishNames.join('、'), '番茄炒蛋、紫菜蛋花汤');
  checkEqual('日期标签为 ISO 前 10 位', list.data.items[0].dateLabel, '2026-10-05');
  checkEqual('返回状态字段', list.data.items[0].status, 'confirmed');
  checkEqual('返回餐次字段', list.data.items[1].mealType, 'lunch');

  /* ---------- 分页不重复 ---------- */
  const p1 = await callMenu(USER_A.openid, 'getMenuHistory', { familyId: FAMILY_A, page: 1, pageSize: 2 });
  const p2 = await callMenu(USER_A.openid, 'getMenuHistory', { familyId: FAMILY_A, page: 2, pageSize: 2 });
  checkEqual('第一页返回 2 条', p1.data.items.length, 2);
  checkEqual('第二页返回 1 条', p2.data.items.length, 1);
  const idsP1 = p1.data.items.map((i) => i.menuId);
  const idsP2 = p2.data.items.map((i) => i.menuId);
  check('两页之间没有重复记录', idsP1.every((id) => idsP2.indexOf(id) === -1));
  checkEqual('分页 total 与总数一致', p1.data.total, 3);

  /* ---------- pageSize 上限 ---------- */
  const huge = await callMenu(USER_A.openid, 'getMenuHistory', { familyId: FAMILY_A, pageSize: 9999 });
  checkEqual('pageSize 被限制到 50', huge.data.pageSize, 50);

  /* ---------- 状态筛选 ---------- */
  const drafts = await callMenu(USER_A.openid, 'getMenuHistory', { familyId: FAMILY_A, status: 'draft' });
  checkEqual('按 draft 筛选返回 1 条', drafts.data.total, 1);
  checkEqual('筛选结果就是草稿菜单', drafts.data.items[0].menuId, 'menu-draft');
  const badStatus = await callMenu(USER_A.openid, 'getMenuHistory', { familyId: FAMILY_A, status: 'hacked' });
  checkEqual('非法状态回退为 confirmed', badStatus.data.total, 3);

  /* ---------- 日期范围筛选 ---------- */
  const range = await callMenu(USER_A.openid, 'getMenuHistory', {
    familyId: FAMILY_A,
    startDate: '2026-10-02',
    endDate: '2026-10-04',
  });
  checkEqual('日期范围内只返回 1 条', range.data.total, 1);
  checkEqual('日期范围的记录正确', range.data.items[0].menuId, 'menu-2');

  /* ---------- 家庭成员共享 ---------- */
  const listB = await callMenu(USER_B.openid, 'getMenuHistory', { familyId: FAMILY_A });
  checkEqual('同家庭另一位成员看到相同历史', listB.data.total, 3);

  /* ---------- 权限隔离 ---------- */
  const cross = await callMenu(USER_C.openid, 'getMenuHistory', { familyId: FAMILY_A });
  checkEqual('外人读取别家历史被拒', cross.success, false);
  checkEqual('错误码 NOT_IN_FAMILY', cross.code, 'NOT_IN_FAMILY');

  const otherFamily = await callMenu(USER_A.openid, 'getMenuHistory', { familyId: FAMILY_B });
  checkEqual('本家庭成员读取别家历史也被拒', otherFamily.code, 'NOT_IN_FAMILY');

  const noFamily = await callMenu(USER_A.openid, 'getMenuHistory', {});
  checkEqual('缺少 familyId 被拒', noFamily.code, 'INVALID_PARAMS');

  const notLoggedIn = await callMenu('', 'getMenuHistory', { familyId: FAMILY_A });
  checkEqual('未登录被拒', notLoggedIn.code, 'UNAUTHORIZED');

  /* ---------- 新菜单确认后旧历史仍在 ---------- */
  pushMenu({ _id: 'menu-new', createdAt: '2026-10-08T10:00:00.000Z' });
  const afterNew = await callMenu(USER_A.openid, 'getMenuHistory', { familyId: FAMILY_A });
  checkEqual('新增菜单后历史总数 +1', afterNew.data.total, 4);
  check('旧菜单 menu-1 仍可查看', afterNew.data.items.some((i) => i.menuId === 'menu-1'));
  checkEqual('最新确认的排在最前', afterNew.data.items[0].menuId, 'menu-new');

  /* ---------- 集合缺失降级 ---------- */
  setMissingCollections(['menus']);
  const missing = await callMenu(USER_A.openid, 'getMenuHistory', { familyId: FAMILY_A });
  checkEqual('menus 集合缺失返回 DB_NOT_READY', missing.code, 'DB_NOT_READY');
  setMissingCollections([]);

  /* ---------- getMenu：家庭归属强制校验 ---------- */
  const okMenu = await callMenu(USER_A.openid, 'getMenu', { menuId: 'menu-1', familyId: FAMILY_A });
  checkEqual('本家庭读取菜单详情成功', okMenu.success, true);
  checkEqual('详情返回菜单 ID', okMenu.data._id, 'menu-1');

  const foreignMenu = await callMenu(USER_A.openid, 'getMenu', { menuId: 'menu-other', familyId: FAMILY_A });
  checkEqual('读取别家菜单详情被拒', foreignMenu.success, false);
  checkEqual('别家菜单返回 FORBIDDEN', foreignMenu.code, 'FORBIDDEN');

  const menuNoFamily = await callMenu(USER_A.openid, 'getMenu', { menuId: 'menu-1' });
  checkEqual('菜单详情缺少 familyId 被拒', menuNoFamily.code, 'INVALID_PARAMS');

  const menuNotFound = await callMenu(USER_A.openid, 'getMenu', { menuId: 'nope', familyId: FAMILY_A });
  checkEqual('不存在的菜单返回 MENU_NOT_FOUND', menuNotFound.code, 'MENU_NOT_FOUND');

  setMissingCollections(['menus']);
  const menuDbDown = await callMenu(USER_A.openid, 'getMenu', { menuId: 'menu-1', familyId: FAMILY_A });
  checkEqual('集合缺失时 getMenu 降级 DB_NOT_READY', menuDbDown.code, 'DB_NOT_READY');
  setMissingCollections([]);
}

/* ============================== 历史点单行为 ============================== */

async function runOrderHistoryTests() {
  section('历史点单：列表 / 详情 / 只读 / 汇总 / 隔离');

  seedUsersAndFamilies();

  pushMenu({ _id: 'menu-1', status: 'confirmed' });
  pushMenu({ _id: 'menu-b', familyId: FAMILY_B, userId: USER_C._id, status: 'confirmed' });

  pushOrder({
    _id: 'order-open',
    menuId: 'menu-1',
    status: 'open',
    deadline: '2999-01-01T00:00:00.000Z',
    // 用「刚刚创建」：未超时的点单仍要求全员点单才能关闭
    createdAt: new Date().toISOString(),
  });
  pushOrder({
    _id: 'order-closed',
    menuId: 'menu-1',
    status: 'closed',
    closedAt: '2026-10-06T20:00:00.000Z',
    createdAt: '2026-10-04T10:00:00.000Z',
  });
  pushOrder({ _id: 'order-other', familyId: FAMILY_B, menuId: 'menu-b', userId: USER_C._id, initiatorUserId: USER_C._id });

  // 两个家庭成员都提交了点单
  store.family_order_items.push(
    {
      _id: 'oi-a', orderId: 'order-closed', familyId: FAMILY_A, userId: USER_A._id,
      items: [{ recipeId: 'r-1', quantity: 2, note: '' }, { recipeId: 'r-2', quantity: 1, note: '少放盐' }],
      createdAt: '2026-10-04T11:00:00.000Z', updatedAt: '2026-10-04T11:00:00.000Z',
    },
    {
      _id: 'oi-b', orderId: 'order-closed', familyId: FAMILY_A, userId: USER_B._id,
      items: [{ recipeId: 'r-1', quantity: 1, note: '' }],
      createdAt: '2026-10-04T12:00:00.000Z', updatedAt: '2026-10-04T12:00:00.000Z',
    },
  );
  store.recipes.push(
    { _id: 'r-1', name: '番茄炒蛋' },
    { _id: 'r-2', name: '紫菜蛋花汤' },
  );

  /* ---------- 列表 ---------- */
  const all = await callOrder(USER_A.openid, 'listOrders', { familyId: FAMILY_A });
  checkEqual('点单列表成功', all.success, true);
  checkEqual('只返回本家庭点单', all.data.total, 2);
  checkEqual('倒序第一条是最新的', all.data.items[0].orderId, 'order-open');

  const closedOnly = await callOrder(USER_A.openid, 'listOrders', { familyId: FAMILY_A, status: 'closed' });
  checkEqual('按 closed 筛选返回 1 条', closedOnly.data.total, 1);

  // openTotal 不受筛选影响：前端据此决定是否显示「收尾进行中」入口
  checkEqual('全部筛选下返回进行中总数', all.data.openTotal, 1);
  checkEqual('按已关闭筛选时仍返回进行中总数', closedOnly.data.openTotal, 1);
  checkEqual('筛选出已关闭点单', closedOnly.data.items[0].orderId, 'order-closed');
  check('列表包含 closedAt', closedOnly.data.items[0].closedAt === '2026-10-06T20:00:00.000Z');

  const crossList = await callOrder(USER_C.openid, 'listOrders', { familyId: FAMILY_A });
  checkEqual('外人读取别家点单列表被拒', crossList.code, 'NOT_IN_FAMILY');

  /* ---------- 详情 ---------- */
  const detail = await callOrder(USER_B.openid, 'getOrder', { orderId: 'order-closed' });
  checkEqual('历史点单详情成功', detail.success, true);
  checkEqual('详情状态为 closed', detail.data.order.status, 'closed');
  checkEqual('详情保留关闭时间', detail.data.order.closedAt, '2026-10-06T20:00:00.000Z');
  checkEqual('详情返回当时菜单菜品', detail.data.recipes.length, 2);
  checkEqual('已关闭订单不可编辑', detail.data.editable, false);

  const crossDetail = await callOrder(USER_C.openid, 'getOrder', { orderId: 'order-closed' });
  checkEqual('外人读取别家点单详情被拒', crossDetail.code, 'NOT_IN_FAMILY');

  const notFound = await callOrder(USER_A.openid, 'getOrder', { orderId: 'nope' });
  checkEqual('不存在的点单返回 ORDER_NOT_FOUND', notFound.code, 'ORDER_NOT_FOUND');

  /* ---------- 已关闭订单只读：提交被拒，且数据不变 ---------- */
  const before = clone(store.family_order_items.find((d) => d._id === 'oi-a').items);
  const submitClosed = await callOrder(USER_A.openid, 'submitOrderItems', {
    orderId: 'order-closed',
    items: [{ recipeId: 'r-1', quantity: 99, note: '篡改' }],
  });
  checkEqual('关闭后提交被拒', submitClosed.success, false);
  checkEqual('错误码 ORDER_CLOSED', submitClosed.code, 'ORDER_CLOSED');
  const after = store.family_order_items.find((d) => d._id === 'oi-a').items;
  check('关闭后数据未被修改', JSON.stringify(before) === JSON.stringify(after));

  /* ---------- 汇总来自服务端 ---------- */
  const summary = await callOrder(USER_A.openid, 'getOrderSummary', { orderId: 'order-closed' });
  checkEqual('汇总查询成功', summary.success, true);
  checkEqual('参与人数 = 2', summary.data.totalParticipants, 2);
  checkEqual('菜品汇总数量 = 2', summary.data.dishSummary.length, 2);
  const dishR1 = summary.data.dishSummary.find((d) => d.recipeId === 'r-1');
  checkEqual('番茄炒蛋共 2 人选择', dishR1.peopleCount, 2);
  checkEqual('番茄炒蛋共 3 份', dishR1.totalQuantity, 3);
  checkEqual('成员汇总数量 = 2', summary.data.memberSummary.length, 2);
  const memberA = summary.data.memberSummary.find((m) => m.userId === USER_A._id);
  checkEqual('成员昵称来自 users 集合', memberA.displayName, '小明');
  check('成员汇总不暴露 openid', JSON.stringify(summary.data).indexOf('openid') === -1);

  const crossSummary = await callOrder(USER_C.openid, 'getOrderSummary', { orderId: 'order-closed' });
  checkEqual('外人读取汇总被拒', crossSummary.code, 'NOT_IN_FAMILY');

  /* ---------- 全员点单才能关闭 ---------- */
  // 新开一单：order-open 还没有任何人提交
  let openClose = await callOrder(USER_A.openid, 'closeOrder', { orderId: 'order-open' });
  checkEqual('无人点单时不能关闭', openClose.code, 'ORDER_NOT_ALL_COMPLETED');
  check('提示里点名了还没点单的家人',
    openClose.message.indexOf('小明') !== -1 || openClose.message.indexOf('小红') !== -1,
    openClose.message);
  checkEqual('关闭失败后订单仍是 open',
    store.family_orders.find((o) => o._id === 'order-open').status, 'open');

  // 只有一个人点完，仍然不能关闭
  store.family_order_items.push({
    _id: 'oi-open-a', orderId: 'order-open', familyId: FAMILY_A, userId: USER_A._id,
    items: [{ recipeId: 'r-1', quantity: 1, note: '' }],
    createdAt: '2026-10-05T11:00:00.000Z', updatedAt: '2026-10-05T11:00:00.000Z',
  });
  openClose = await callOrder(USER_A.openid, 'closeOrder', { orderId: 'order-open' });
  checkEqual('只完成一个人时仍不能关闭', openClose.code, 'ORDER_NOT_ALL_COMPLETED');
  check('提示里指出剩余成员', openClose.message.indexOf('小红') !== -1, openClose.message);

  // 第二个人也点完（即使全 0 份也算完成）就能关闭
  store.family_order_items.push({
    _id: 'oi-open-b', orderId: 'order-open', familyId: FAMILY_A, userId: USER_B._id,
    items: [],
    createdAt: '2026-10-05T12:00:00.000Z', updatedAt: '2026-10-05T12:00:00.000Z',
  });
  openClose = await callOrder(USER_A.openid, 'closeOrder', { orderId: 'order-open' });
  checkEqual('全员点完后可以关闭', openClose.success, true);
  checkEqual('关闭后订单状态为 closed',
    store.family_orders.find((o) => o._id === 'order-open').status, 'closed');

  /* ---------- 超时点单：等不到人也能关闭，否则永远删不掉 ---------- */
  // 新流程已无「提交份数」入口，历史 open 点单若还要求全员点单，就会永久卡死。
  pushOrder({
    _id: 'order-stale',
    menuId: 'menu-1',
    status: 'open',
    deadline: '2999-01-01T00:00:00.000Z',
    createdAt: new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString(),
  });
  const staleClose = await callOrder(USER_A.openid, 'closeOrder', { orderId: 'order-stale' });
  check('超过 48 小时的点单无需全员点单即可关闭', staleClose.success === true, staleClose.message);
  checkEqual('超时点单已关闭',
    store.family_orders.find((o) => o._id === 'order-stale').status, 'closed');

  /* ---------- 已关闭订单保持只读：重复关闭是幂等的，不会重开或改写历史 ---------- */
  const closedBefore = clone(store.family_orders.find((o) => o._id === 'order-closed'));
  const reclose = await callOrder(USER_A.openid, 'closeOrder', { orderId: 'order-closed' });
  checkEqual('重复关闭是幂等的（返回成功但不改写）', reclose.success, true);
  checkEqual('幂等返回仍是 closed', reclose.data.status, 'closed');
  const closedAfter = store.family_orders.find((o) => o._id === 'order-closed');
  check('重复关闭没有改写订单', JSON.stringify(closedBefore) === JSON.stringify(closedAfter));
  checkEqual('订单状态仍为 closed（未被重新打开）', closedAfter.status, 'closed');

  /* ---------- 存量清理：一次性关闭卡住的 open 点单 ---------- */
  // 份数点单功能已移除，旧 open 点单永远等不到「全员提交」，必须能批量收尾。
  pushOrder({
    _id: 'order-legacy-1',
    menuId: 'menu-1',
    status: 'open',
    createdAt: '2026-10-05T10:00:00.000Z',
  });
  pushOrder({
    _id: 'order-legacy-2',
    menuId: 'menu-1',
    status: 'open',
    createdAt: '2026-10-05T11:00:00.000Z',
  });
  store.family_order_items.push({
    _id: 'oi-legacy-1', orderId: 'order-legacy-1', familyId: FAMILY_A, userId: USER_A._id,
    items: [{ recipeId: 'r-1', quantity: 2, note: '' }],
    createdAt: '2026-10-05T10:05:00.000Z', updatedAt: '2026-10-05T10:05:00.000Z',
  });

  const forbiddenCleanup = await callOrder(USER_B.openid, 'cleanupOpenOrders', { familyId: FAMILY_A });
  checkEqual('普通成员不能触发存量清理', forbiddenCleanup.code, 'FORBIDDEN');

  const cleanup = await callOrder(USER_A.openid, 'cleanupOpenOrders', { familyId: FAMILY_A });
  check('管理员触发存量清理成功', cleanup.success === true, cleanup.message);

  const legacy1 = store.family_orders.find((o) => o._id === 'order-legacy-1');
  const legacy2 = store.family_orders.find((o) => o._id === 'order-legacy-2');
  checkEqual('存量点单 1 已关闭', legacy1.status, 'closed');
  checkEqual('存量点单 2 已关闭', legacy2.status, 'closed');
  checkEqual('标记为系统关闭', legacy1.closedBy, 'system');
  checkEqual('记录清理原因', legacy1.closeReason, 'legacy_cleanup');
  check('写入关闭时间', !!legacy1.closedAt);
  checkEqual('汇总沿用 closeOrder 口径：2 份',
    legacy1.finalSummary[0].totalQuantity, 2);
  checkEqual('汇总记录人数', legacy1.finalSummary[0].peopleCount, 1);
  checkEqual('无明细的点单汇总为空', (legacy2.finalSummary || []).length, 0);

  // 幂等：再跑一次不再处理已关闭的点单
  const cleanupAgain = await callOrder(USER_A.openid, 'cleanupOpenOrders', { familyId: FAMILY_A });
  checkEqual('重复清理关闭 0 条', cleanupAgain.data.closedCount, 0);

  // 清理只影响本家庭：FAMILY_B 的点单在 A 家清理后仍应是 open
  const otherFamilyOrder = store.family_orders.find((o) => o._id === 'order-other');
  checkEqual('其他家庭点单未被误改', otherFamilyOrder.status, 'open');

  // 各家庭管理员只能清理自己的家庭
  const otherFamilyCleanup = await callOrder(USER_C.openid, 'cleanupOpenOrders', { familyId: FAMILY_B });
  check('管理员可以清理自己家庭', otherFamilyCleanup.success === true, otherFamilyCleanup.message);
  checkEqual('B 家点单被 B 家管理员关闭',
    store.family_orders.find((o) => o._id === 'order-other').status, 'closed');

  // 已关闭的点单现在可以正常删除（这正是清理的目的）
  const delAfter = await callOrder(USER_A.openid, 'deleteOrders', {
    familyId: FAMILY_A, orderIds: ['order-legacy-1'],
  });
  check('清理后可正常删除', delAfter.success === true, delAfter.message);
  checkEqual('点单已从库中移除',
    store.family_orders.some((o) => o._id === 'order-legacy-1'), false);
}

/* ============================== 主流程 ============================== */

async function main() {
  console.log('Phase 11 历史记录 · 验证开始');

  runStructureChecks();
  await runMenuHistoryTests();
  await runOrderHistoryTests();

  console.log('\n========================================');
  console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项');
  if (failures.length === 0) {
    console.log('全部通过');
    process.exit(0);
  }
  console.log('失败明细：');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}

main().catch((error) => {
  console.error('验证脚本异常：', error);
  process.exit(1);
});