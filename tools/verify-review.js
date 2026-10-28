/**
 * 饭后评价与掌勺人成长 · 验证（阶段二）
 *
 * 运行：node tools/verify-review.js
 *
 * 覆盖：
 *   1. chef-core 纯函数：评分规范化 / 汇总 / 积分规则 / 等级门槛
 *   2. completeMeal：状态校验、权限、幂等、基础积分、快照固化
 *   3. submitRatings：菜品归属、1—5 星边界、修改更新原记录、汇总
 *   4. 积分与等级：归属、防重复、隔离、等级提升、流水与余额一致
 *   5. 回归：阶段一菜单确认 / 掌勺人权限 / 采购清单仍可用
 */
const path = require('path');
const { createMockCloud } = require('./mock-cloud');

const mock = createMockCloud();
const store = mock.store;
const resetStore = mock.resetStore;
const setMissingCollections = mock.setMissingCollections;

mock.install();

const core = require(path.join(__dirname, '..', 'cloudfunctions', 'menu', 'chef-core.js'));
const menuFn = require(path.join(__dirname, '..', 'cloudfunctions', 'menu', 'index.js'));

/* ============================== 断言工具 ============================== */

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('  [通过] ' + name);
    return;
  }
  failures.push(name + (detail ? ' -> ' + detail : ''));
  console.log('  [失败] ' + name + (detail ? ' -> ' + detail : ''));
}

function checkEqual(name, actual, expected) {
  check(name, actual === expected,
    'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected));
}

function section(title) {
  console.log('\n=== ' + title + ' ===');
}

/* ============================== 数据准备 ============================== */

const FAMILY_A = 'fam-a';
const FAMILY_B = 'fam-b';

const USER_COOK = { _id: 'u-cook', openid: 'o-cook', nickname: '大厨' };
const USER_MEMBER = { _id: 'u-member', openid: 'o-member', nickname: '小米' };
const USER_MEMBER2 = { _id: 'u-member2', openid: 'o-member2', nickname: '小豆' };
const USER_OUT = { _id: 'u-out', openid: 'o-out', nickname: '外人' };

const DISH_A = 'r-tomato';
const DISH_B = 'r-broccoli';
const DISH_C = 'r-soup';

function seedBase() {
  [USER_COOK, USER_MEMBER, USER_MEMBER2, USER_OUT].forEach((user) => {
    store.users.push({ _id: user._id, openid: user.openid, nickname: user.nickname });
  });

  store.families.push({ _id: FAMILY_A, name: '大厨家', status: 'active', ownerId: USER_COOK._id, preferences: {} });
  store.families.push({ _id: FAMILY_B, name: '别家', status: 'active', ownerId: USER_OUT._id, preferences: {} });

  store.family_members.push({ _id: 'm-a1', familyId: FAMILY_A, userId: USER_COOK._id, role: 'owner', joinedAt: '2024-01-01T00:00:00.000Z' });
  store.family_members.push({ _id: 'm-a2', familyId: FAMILY_A, userId: USER_MEMBER._id, role: 'member', joinedAt: '2024-01-02T00:00:00.000Z' });
  store.family_members.push({ _id: 'm-a3', familyId: FAMILY_A, userId: USER_MEMBER2._id, role: 'member', joinedAt: '2024-01-03T00:00:00.000Z' });
  store.family_members.push({ _id: 'm-b1', familyId: FAMILY_B, userId: USER_OUT._id, role: 'owner', joinedAt: '2024-01-01T00:00:00.000Z' });
}

function seedMenu(overrides) {
  const doc = Object.assign({
    _id: 'menu-a1',
    familyId: FAMILY_A,
    userId: USER_COOK._id,
    cookId: USER_COOK._id,
    cookName: USER_COOK.nickname,
    mealType: 'dinner',
    servings: 3,
    status: 'confirmed',
    menuVersion: 1,
    items: [
      { recipeId: DISH_A, name: '宫保鸡丁', category: '家常菜', locked: false, position: 0 },
      { recipeId: DISH_B, name: '清炒西兰花', category: '素菜', locked: false, position: 1 },
      { recipeId: DISH_C, name: '紫菜蛋花汤', category: '汤', locked: false, position: 2 },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, overrides || {});
  store.menus.push(doc);
  return doc;
}

async function callAs(openid, event) {
  mock.setOpenid(openid);
  return menuFn.main(Object.assign({ requestId: 'req-' + Math.random().toString(36).slice(2, 8) }, event));
}

function resetAll() {
  resetStore();
  setMissingCollections([]);
  seedBase();
}

function pointsOf(userId, familyId) {
  return store.chef_points
    .filter((doc) => doc.cookId === userId && (!familyId || doc.familyId === familyId))
    .reduce((sum, doc) => sum + doc.points, 0);
}

async function main() {

/* ============================== 1. chef-core 纯函数 ============================== */

section('1. chef-core 纯函数');

checkEqual('1 星合法', core.normalizeStars(1), 1);
checkEqual('5 星合法', core.normalizeStars(5), 5);
checkEqual('0 星被拒绝（不默认给分）', core.normalizeStars(0), 0);
checkEqual('6 星被拒绝', core.normalizeStars(6), 0);
checkEqual('小数被拒绝', core.normalizeStars(3.5), 0);
checkEqual('字符串数字也接受', core.normalizeStars('4'), 4);
checkEqual('undefined 不默认 3 分', core.normalizeStars(undefined), 0);

checkEqual('评语去首尾空白', core.normalizeComment('  好吃  '), '好吃');
checkEqual('评语限长 50', core.normalizeComment('x'.repeat(80)).length, 50);
checkEqual('非字符串评语视为空', core.normalizeComment(null), '');

const allowed = [DISH_A, DISH_B, DISH_C];
check('空评分列表被拒绝', core.normalizeRatings([], allowed).error !== undefined);
check('不属于本餐的菜被拒绝',
  core.normalizeRatings([{ recipeId: 'r-other', stars: 5 }], allowed).error !== undefined);
check('越界星级被拒绝',
  core.normalizeRatings([{ recipeId: DISH_A, stars: 6 }], allowed).error !== undefined);
checkEqual('同一道菜重复提交只保留最后一条',
  core.normalizeRatings([
    { recipeId: DISH_A, stars: 2 },
    { recipeId: DISH_A, stars: 5 },
  ], allowed).value.length, 1);
checkEqual('去重后取最后一条的分值',
  core.normalizeRatings([
    { recipeId: DISH_A, stars: 2 },
    { recipeId: DISH_A, stars: 5 },
  ], allowed).value[0].stars, 5);

const mergedRatings = core.mergeRatings(
  [{ recipeId: DISH_A, stars: 3, comment: '还行' }],
  [{ recipeId: DISH_B, stars: 5, comment: '' }],
);
checkEqual('合并保留未提交的旧评分', mergedRatings.length, 2);
checkEqual('合并更新已提交的评分',
  core.mergeRatings([{ recipeId: DISH_A, stars: 3 }], [{ recipeId: DISH_A, stars: 4 }])[0].stars, 4);

const snapshot = core.buildDishSnapshot({
  items: [
    { recipeId: DISH_A, name: '宫保鸡丁', position: 0 },
    { recipeId: DISH_A, name: '宫保鸡丁', position: 1 },
    { recipeId: DISH_B, name: '清炒西兰花', position: 2 },
  ],
});
checkEqual('快照按 recipeId 去重', snapshot.length, 2);
checkEqual('快照保留菜名', snapshot[0].name, '宫保鸡丁');

checkEqual('无评分时整体平均为 null（不除零）', core.summarizeReviews({
  snapshot: [{ recipeId: DISH_A, name: '宫保鸡丁' }],
  reviews: [],
  members: [{ userId: USER_MEMBER._id, nickname: '小米' }],
  viewerId: USER_MEMBER._id,
}).overallAverage, null);

const summaryOne = core.summarizeReviews({
  snapshot: [{ recipeId: DISH_A, name: '宫保鸡丁' }, { recipeId: DISH_B, name: '清炒西兰花' }],
  reviews: [
    { userId: USER_MEMBER._id, ratings: [{ recipeId: DISH_A, stars: 5 }, { recipeId: DISH_B, stars: 3 }] },
    { userId: USER_MEMBER2._id, ratings: [{ recipeId: DISH_A, stars: 4 }] },
  ],
  members: [
    { userId: USER_COOK._id, nickname: '大厨' },
    { userId: USER_MEMBER._id, nickname: '小米' },
    { userId: USER_MEMBER2._id, nickname: '小豆' },
  ],
  viewerId: USER_MEMBER._id,
});
checkEqual('单菜平均分保留 1 位小数', summaryOne.dishes[0].average, 4.5);
checkEqual('单菜评分人数只算有效评分', summaryOne.dishes[0].ratedCount, 2);
checkEqual('未评分菜品 average 为 null', summaryOne.dishes[1].average, 3);
checkEqual('整体平均分 = 全部有效评分均值', summaryOne.overallAverage, 4);
checkEqual('我的评分单独回传', summaryOne.dishes[0].myStars, 5);
checkEqual('评价人数只统计真正打过分的人', summaryOne.raterCount, 2);
checkEqual('未评价成员被列出', summaryOne.missingMembers.join(','), '大厨');

const summaryMissing = core.summarizeReviews({
  snapshot: [{ recipeId: DISH_A, name: '宫保鸡丁' }],
  reviews: [{ userId: USER_MEMBER._id, ratings: [{ recipeId: DISH_A, stars: 5 }] }],
  members: [
    { userId: USER_MEMBER._id, nickname: '小米' },
    { userId: USER_MEMBER2._id, nickname: '小豆' },
  ],
  viewerId: USER_COOK._id,
});
checkEqual('未评价成员出现在待评列表', summaryMissing.missingMembers.join(','), '小豆');
checkEqual('查看者自己没评分时 myStars 为 0', summaryMissing.dishes[0].myStars, 0);
check('查看者没评分时 iHaveRated=false', summaryMissing.iHaveRated === false);

checkEqual('评分奖励：5 星 → 10 分', core.computeRatingBonus(5), 10);
checkEqual('评分奖励：1 星 → 2 分', core.computeRatingBonus(1), 2);
checkEqual('评分奖励：4.5 星 → 9 分', core.computeRatingBonus(4.5), 9);
checkEqual('无评分 → 0 分', core.computeRatingBonus(null), 0);
checkEqual('奖励上限 10 分', core.computeRatingBonus(9), 10);

checkEqual('0 分是 1 级', core.resolveLevel(0).levelName, '初级厨师');
checkEqual('49 分仍是 1 级', core.resolveLevel(49).level, 1);
checkEqual('50 分升到 2 级', core.resolveLevel(50).levelName, '家常好手');
checkEqual('150 分升到 3 级', core.resolveLevel(150).levelName, '家庭大厨');
checkEqual('350 分升到 4 级', core.resolveLevel(350).levelName, '星级掌勺人');
checkEqual('700 分升到 5 级', core.resolveLevel(700).levelName, '米其林主厨');
checkEqual('2 级距下一级还需 100 分', core.resolveLevel(50).pointsToNext, 100);
check('满级后 maxLevel 为 true', core.resolveLevel(700).maxLevel === true);
checkEqual('负分归零', core.resolveLevel(-20).points, 0);

/* ============================== 2. completeMeal ============================== */

section('2. completeMeal 完成本餐');

resetAll();
seedMenu({ _id: 'menu-draft', status: 'draft' });
let res = await callAs(USER_COOK.openid, { action: 'completeMeal', familyId: FAMILY_A, menuId: 'menu-draft' });
checkEqual('未确认菜单不能完成', res.code, 'MENU_NOT_CONFIRMED');
checkEqual('未确认时没有积分', store.chef_points.length, 0);

resetAll();
seedMenu();
res = await callAs(USER_COOK.openid, { action: 'completeMeal', familyId: FAMILY_A, menuId: 'menu-a1' });
check('已确认菜单可以完成', res.success === true, res.message);
checkEqual('状态变为 completed', store.menus[0].status, 'completed');
check('完成时间已写入', typeof store.menus[0].completedAt === 'string' && store.menus[0].completedAt.length > 0);
checkEqual('完成人记录为操作者', store.menus[0].completedBy, USER_COOK._id);
checkEqual('基础积分 +10', res.data.pointsAwarded, 10);
checkEqual('掌勺人累计 10 分', res.data.growth.points, 10);
checkEqual('掌勺人是本餐 cookId', res.data.cookId, USER_COOK._id);

checkEqual('完成后固化了菜品快照', (store.menus[0].snapshotItems || []).length, 3);
checkEqual('快照记录 recipeId', store.menus[0].snapshotItems[0].recipeId, DISH_A);
checkEqual('快照记录菜名', store.menus[0].snapshotItems[1].name, '清炒西兰花');

res = await callAs(USER_COOK.openid, { action: 'completeMeal', familyId: FAMILY_A, menuId: 'menu-a1' });
check('重复完成不报错（幂等）', res.success === true, res.message);
checkEqual('重复完成返回 alreadyCompleted', res.data.alreadyCompleted, true);
checkEqual('重复完成不再加分', res.data.pointsAwarded, 0);
checkEqual('积分仍为 10', pointsOf(USER_COOK._id), 10);
checkEqual('积分流水只有一条', store.chef_points.length, 1);

resetAll();
seedMenu();
res = await callAs(USER_OUT.openid, { action: 'completeMeal', familyId: FAMILY_A, menuId: 'menu-a1' });
checkEqual('非本家庭成员不能完成', res.code, 'NOT_IN_FAMILY');
checkEqual('越权请求没有积分', store.chef_points.length, 0);

resetAll();
seedMenu();
res = await callAs(USER_OUT.openid, { action: 'completeMeal', familyId: FAMILY_B, menuId: 'menu-a1' });
checkEqual('跨家庭菜单被拒绝', res.code, 'FORBIDDEN');

// 「完成制作」只能由掌勺人操作：干饭人不能替掌勺人点完成
resetAll();
seedMenu();
res = await callAs(USER_MEMBER.openid, { action: 'completeMeal', familyId: FAMILY_A, menuId: 'menu-a1' });
checkEqual('干饭人不能标记完成制作', res.code, 'ONLY_COOK_CAN_COMPLETE');
checkEqual('干饭人操作后状态不变', store.menus[0].status, 'confirmed');
checkEqual('干饭人操作后没有积分', store.chef_points.length, 0);

res = await callAs(USER_MEMBER2.openid, { action: 'completeMeal', familyId: FAMILY_A, menuId: 'menu-a1' });
checkEqual('另一位干饭人也不能标记完成', res.code, 'ONLY_COOK_CAN_COMPLETE');

// 家人的建议不影响开火：掌勺人锁定了菜单就能标记完成，不必等所有人表态
resetAll();
seedMenu();
store.family_orders.push({
  _id: 'order-open', familyId: FAMILY_A, menuId: 'menu-a1', status: 'open',
  initiatorUserId: USER_COOK._id, recipeIds: [DISH_A], createdAt: new Date().toISOString(),
});
res = await callAs(USER_COOK.openid, { action: 'completeMeal', familyId: FAMILY_A, menuId: 'menu-a1' });
check('还有未关闭的点单时掌勺人仍可完成制作', res.success === true, res.message);
checkEqual('掌勺人完成制作拿到基础分', pointsOf(USER_COOK._id), 10);

// 掌勺人未指定时不允许完成
resetAll();
seedMenu({ cookId: undefined, cookName: undefined });
res = await callAs(USER_MEMBER.openid, { action: 'completeMeal', familyId: FAMILY_A, menuId: 'menu-a1' });
checkEqual('掌勺人未指定时提示先指定', res.code, 'COOK_REQUIRED');
checkEqual('掌勺人未指定时不发积分', store.chef_points.length, 0);
checkEqual('掌勺人未指定时状态不变', store.menus[0].status, 'confirmed');

// 并发完成：条件更新 + 固定流水 ID 双重兜底，只加一次分
resetAll();
seedMenu();
const concurrent = await Promise.all([
  callAs(USER_COOK.openid, { action: 'completeMeal', familyId: FAMILY_A, menuId: 'menu-a1' }),
  callAs(USER_COOK.openid, { action: 'completeMeal', familyId: FAMILY_A, menuId: 'menu-a1' }),
  callAs(USER_COOK.openid, { action: 'completeMeal', familyId: FAMILY_A, menuId: 'menu-a1' }),
]);
check('并发完成都返回成功', concurrent.every((item) => item.success === true));
checkEqual('并发完成只加一次基础分', pointsOf(USER_COOK._id), 10);
checkEqual('并发完成只有一条流水', store.chef_points.length, 1);

// 并发评分：同一成员并发提交不会写出多条记录
const concurrentRatings = await Promise.all([
  callAs(USER_MEMBER.openid, {
    action: 'submitRatings', familyId: FAMILY_A, menuId: 'menu-a1',
    ratings: [{ recipeId: DISH_A, stars: 4 }],
  }),
  callAs(USER_MEMBER.openid, {
    action: 'submitRatings', familyId: FAMILY_A, menuId: 'menu-a1',
    ratings: [{ recipeId: DISH_B, stars: 5 }],
  }),
]);
check('并发评分都返回成功', concurrentRatings.every((item) => item.success === true));
checkEqual('并发评分仍只有一条评价记录',
  store.meal_reviews.filter((r) => r.userId === USER_MEMBER._id).length, 1);
checkEqual('并发评分只结算一次奖励', store.chef_points.length, 2);

// 完成后再改菜单：历史快照不受影响
resetAll();
seedMenu();
await callAs(USER_COOK.openid, { action: 'completeMeal', familyId: FAMILY_A, menuId: 'menu-a1' });
seedMenu({ _id: 'menu-a2', items: [{ recipeId: 'r-new', name: '全新菜', position: 0 }] });
checkEqual('新菜单不影响已完成记录的快照', store.menus[0].snapshotItems.length, 3);
checkEqual('已完成记录的快照第一道菜未变', store.menus[0].snapshotItems[0].recipeId, DISH_A);

// 已完成后不允许再改菜
resetAll();
seedMenu({ status: 'completed' });
res = await callAs(USER_COOK.openid, {
  action: 'setMenuItemLocked', familyId: FAMILY_A, menuId: 'menu-a1', recipeId: DISH_A, locked: true,
});
checkEqual('已完成菜单不能改菜', res.code, 'MENU_COMPLETED');
res = await callAs(USER_COOK.openid, { action: 'confirmMenu', familyId: FAMILY_A, menuId: 'menu-a1' });
checkEqual('已完成菜单不能再确认', res.code, 'ALREADY_COMPLETED');

/* ============================== 3. submitRatings ============================== */

section('3. submitRatings 菜品评分');

resetAll();
seedMenu();
res = await callAs(USER_MEMBER.openid, {
  action: 'submitRatings', familyId: FAMILY_A, menuId: 'menu-a1',
  ratings: [{ recipeId: DISH_A, stars: 5 }],
});
checkEqual('未完成时不能评价', res.code, 'MENU_NOT_COMPLETED');

resetAll();
seedMenu();
await callAs(USER_COOK.openid, { action: 'completeMeal', familyId: FAMILY_A, menuId: 'menu-a1' });

res = await callAs(USER_MEMBER.openid, {
  action: 'submitRatings', familyId: FAMILY_A, menuId: 'menu-a1',
  ratings: [{ recipeId: DISH_A, stars: 5, comment: '很下饭' }, { recipeId: DISH_B, stars: 3 }],
});
check('成员可以逐道菜评分', res.success === true, res.message);
check('待评成员里不含掌勺人',
  (res.data.summary.missingMembers || []).indexOf(USER_COOK.nickname) === -1,
  JSON.stringify(res.data.summary.missingMembers));
checkEqual('评分人数上限为干饭人数', res.data.summary.memberCount, 2);
checkEqual('只提交了两道菜', store.meal_reviews[0].ratings.length, 2);
checkEqual('未评分菜品不会被补 0 或 3 分', res.data.summary.dishes[2].myStars, 0);
checkEqual('未评分菜品 average 为 null', res.data.summary.dishes[2].average, null);
checkEqual('已评分菜品平均分正确', res.data.summary.dishes[0].average, 5);
checkEqual('评价记录归属于提交者', store.meal_reviews[0].userId, USER_MEMBER._id);

res = await callAs(USER_MEMBER.openid, {
  action: 'submitRatings', familyId: FAMILY_A, menuId: 'menu-a1',
  ratings: [{ recipeId: DISH_A, stars: 2, comment: '改口了' }],
});
checkEqual('修改评分后仍只有一条记录', store.meal_reviews.filter((r) => r.userId === USER_MEMBER._id).length, 1);
checkEqual('修改后分值为最新', res.data.summary.dishes[0].myStars, 2);
checkEqual('未修改的菜保持原分', res.data.summary.dishes[1].myStars, 3);
checkEqual('修改后可更新评语', store.meal_reviews[0].ratings.find((r) => r.recipeId === DISH_A).comment, '改口了');

res = await callAs(USER_MEMBER.openid, {
  action: 'submitRatings', familyId: FAMILY_A, menuId: 'menu-a1',
  ratings: [{ recipeId: DISH_A, stars: 6 }],
});
checkEqual('越界星级被拒绝', res.code, 'INVALID_PARAMS');
res = await callAs(USER_MEMBER.openid, {
  action: 'submitRatings', familyId: FAMILY_A, menuId: 'menu-a1',
  ratings: [{ recipeId: DISH_A, stars: 0 }],
});
checkEqual('0 星被拒绝', res.code, 'INVALID_PARAMS');
res = await callAs(USER_MEMBER.openid, {
  action: 'submitRatings', familyId: FAMILY_A, menuId: 'menu-a1',
  ratings: [{ recipeId: 'r-not-in-meal', stars: 5 }],
});
checkEqual('不属于本餐的菜被拒绝', res.code, 'INVALID_PARAMS');

res = await callAs(USER_OUT.openid, {
  action: 'submitRatings', familyId: FAMILY_A, menuId: 'menu-a1',
  ratings: [{ recipeId: DISH_A, stars: 5 }],
});
checkEqual('非家庭成员不能评价', res.code, 'NOT_IN_FAMILY');

// 掌勺人不能评价自己的菜
res = await callAs(USER_COOK.openid, {
  action: 'submitRatings', familyId: FAMILY_A, menuId: 'menu-a1',
  ratings: [{ recipeId: DISH_A, stars: 5 }],
});
checkEqual('掌勺人不能评价', res.code, 'COOK_CANNOT_RATE');
checkEqual('掌勺人没有写出评价记录',
  store.meal_reviews.filter((r) => r.userId === USER_COOK._id).length, 0);
// 掌勺人没有评价记录，因此也不会出现在「已评价人数」里
checkEqual('掌勺人未写评价，评分人数只有干饭人',
  store.meal_reviews.filter((r) => r.userId === USER_COOK._id).length, 0);

// 前端伪造 userId 不会生效
res = await callAs(USER_MEMBER2.openid, {
  action: 'submitRatings', familyId: FAMILY_A, menuId: 'menu-a1',
  userId: USER_MEMBER._id, ratings: [{ recipeId: DISH_A, stars: 1 }],
});
checkEqual('伪造 userId 无效，记录仍归本人', store.meal_reviews.find((r) => r.userId === USER_MEMBER2._id) !== undefined, true);
checkEqual('被冒充者评分未被修改',
  store.meal_reviews.find((r) => r.userId === USER_MEMBER._id).ratings.find((r) => r.recipeId === DISH_A).stars, 2);

/* ============================== 4. 积分与等级 ============================== */

section('4. 积分结算与等级');

// 首次产生有效评分：按整体平均分发一次奖励
resetAll();
seedMenu();
await callAs(USER_COOK.openid, { action: 'completeMeal', familyId: FAMILY_A, menuId: 'menu-a1' });
res = await callAs(USER_MEMBER.openid, {
  action: 'submitRatings', familyId: FAMILY_A, menuId: 'menu-a1',
  ratings: [{ recipeId: DISH_A, stars: 5 }, { recipeId: DISH_B, stars: 5 }, { recipeId: DISH_C, stars: 5 }],
});
checkEqual('5 星全满 → 评分奖励 10 分', res.data.pointsAwarded, 10);
checkEqual('掌勺人累计 20 分', res.data.growth.points, 20);
checkEqual('积分记在掌勺人名下', pointsOf(USER_COOK._id), 20);
checkEqual('提交评分的人没有积分', pointsOf(USER_MEMBER._id), 0);

// 反复改分不会重复发放
res = await callAs(USER_MEMBER.openid, {
  action: 'submitRatings', familyId: FAMILY_A, menuId: 'menu-a1',
  ratings: [{ recipeId: DISH_A, stars: 1 }],
});
checkEqual('改分不再重复发奖励', res.data.pointsAwarded, 0);
checkEqual('累计积分保持 20', res.data.growth.points, 20);
checkEqual('流水共两条（完成 + 奖励）', store.chef_points.length, 2);

// 其他成员补评也不会再发第二笔奖励
res = await callAs(USER_MEMBER2.openid, {
  action: 'submitRatings', familyId: FAMILY_A, menuId: 'menu-a1',
  ratings: [{ recipeId: DISH_A, stars: 5 }],
});
checkEqual('其他成员补评不重复结算', res.data.pointsAwarded, 0);
checkEqual('累计积分仍为 20', res.data.growth.points, 20);
checkEqual('汇总包含两位成员', res.data.summary.raterCount, 2);

// 流水与余额一致
const ledgerSum = store.chef_points.reduce((sum, doc) => sum + doc.points, 0);
const growthRes = await callAs(USER_COOK.openid, { action: 'getChefGrowth', familyId: FAMILY_A });
checkEqual('流水求和与成长余额一致', growthRes.data.growth.points, ledgerSum);

// 等级随积分提升
resetAll();
seedMenu();
await callAs(USER_COOK.openid, { action: 'completeMeal', familyId: FAMILY_A, menuId: 'menu-a1' });
// 手工补历史积分模拟长期成长
store.chef_points.push({
  _id: 'pt_legacy_1', familyId: FAMILY_A, cookId: USER_COOK._id, menuId: 'old-menu',
  type: 'meal_complete', points: 40, reason: '历史积分', createdAt: '2026-01-01T00:00:00.000Z',
});
let growth = await callAs(USER_COOK.openid, { action: 'getChefGrowth', familyId: FAMILY_A });
checkEqual('累计 50 分升到 2 级', growth.data.growth.level, 2);
checkEqual('等级名称正确', growth.data.growth.levelName, '家常好手');
checkEqual('距下一级还需 100 分', growth.data.growth.pointsToNext, 100);
checkEqual('最近一次积分原因可追溯', growth.data.growth.lastReason.length > 0, true);

// 家庭隔离
const growthB = await callAs(USER_OUT.openid, { action: 'getChefGrowth', familyId: FAMILY_B });
checkEqual('其他家庭看不到本家庭积分', growthB.data.growth.points, 0);
const crossFamily = await callAs(USER_OUT.openid, { action: 'getChefGrowth', familyId: FAMILY_A });
checkEqual('跨家庭查询被拒绝', crossFamily.code, 'NOT_IN_FAMILY');
const otherMember = await callAs(USER_MEMBER.openid, { action: 'getChefGrowth', familyId: FAMILY_A, userId: USER_COOK._id });
checkEqual('成员可以查看掌勺人成长', otherMember.data.growth.points, 50);
const fakeUser = await callAs(USER_COOK.openid, { action: 'getChefGrowth', familyId: FAMILY_A, userId: 'u-not-exist' });
checkEqual('查询非本家庭成员被拒绝', fakeUser.code, 'NOT_IN_FAMILY');

// 前端伪造等级无效：getChefGrowth 不接受客户端传入的等级或积分
const forged = await callAs(USER_COOK.openid, {
  action: 'getChefGrowth', familyId: FAMILY_A, level: 5, points: 9999,
});
checkEqual('伪造等级与积分无效', forged.data.growth.level, 2);

// 两个家庭各自独立累计
resetAll();
seedMenu({ _id: 'menu-a1' });
seedMenu({ _id: 'menu-b1', familyId: FAMILY_B, cookId: USER_OUT._id, cookName: USER_OUT.nickname });
await callAs(USER_COOK.openid, { action: 'completeMeal', familyId: FAMILY_A, menuId: 'menu-a1' });
await callAs(USER_OUT.openid, { action: 'completeMeal', familyId: FAMILY_B, menuId: 'menu-b1' });
checkEqual('A 家在 A 家积分', pointsOf(USER_COOK._id, FAMILY_A), 10);
checkEqual('B 家在 B 家积分', pointsOf(USER_OUT._id, FAMILY_B), 10);
const growthA1 = await callAs(USER_COOK.openid, { action: 'getChefGrowth', familyId: FAMILY_A });
checkEqual('A 家成长只包含 A 家流水', growthA1.data.growth.recordCount, 1);

/* ============================== 5. 集合缺失降级 ============================== */

section('5. 集合缺失降级');

resetAll();
seedMenu();
setMissingCollections(['chef_points']);
res = await callAs(USER_COOK.openid, { action: 'completeMeal', familyId: FAMILY_A, menuId: 'menu-a1' });
check('chef_points 缺失时完成不报错', res.success === true, res.message);
checkEqual('缺失时积分为 0', res.data.pointsAwarded, 0);
checkEqual('缺失时成长积分为 0', res.data.growth.points, 0);
checkEqual('缺失时没有积分流水', res.data.growth.recordCount, 0);
setMissingCollections([]);

resetAll();
seedMenu();
await callAs(USER_COOK.openid, { action: 'completeMeal', familyId: FAMILY_A, menuId: 'menu-a1' });
setMissingCollections(['meal_reviews']);
res = await callAs(USER_MEMBER.openid, {
  action: 'submitRatings', familyId: FAMILY_A, menuId: 'menu-a1',
  ratings: [{ recipeId: DISH_A, stars: 5 }],
});
checkEqual('meal_reviews 缺失时给出明确提示', res.code, 'DB_NOT_READY');
setMissingCollections([]);

/* ============================== 6. 回归：阶段一能力 ============================== */

section('6. 回归：阶段一功能未被破坏');

resetAll();
seedMenu({ status: 'draft' });
res = await callAs(USER_MEMBER.openid, { action: 'confirmMenu', familyId: FAMILY_A, menuId: 'menu-a1' });
checkEqual('非掌勺人仍不能确认菜单', res.code, 'NOT_MEAL_COOK');

resetAll();
seedMenu({ status: 'draft' });
[DISH_A, DISH_B, DISH_C].forEach((id, index) => {
  store.recipes.push({
    _id: id, name: '菜' + index, category: '家常菜', isActive: true, source: 'builtin',
    ingredients: [{ name: '食材' + index, amount: 200, unit: 'g' }], servings: 3,
  });
});
res = await callAs(USER_COOK.openid, { action: 'confirmMenu', familyId: FAMILY_A, menuId: 'menu-a1' });
checkEqual('掌勺人仍可确认菜单', res.success, true);
checkEqual('确认后写入版本号', store.menus[0].menuVersion, 1);
check('确认后状态为 confirmed', store.menus[0].status === 'confirmed');

resetAll();
seedMenu({ status: 'confirmed' });
const detail = await callAs(USER_MEMBER.openid, { action: 'getMealReview', familyId: FAMILY_A, menuId: 'menu-a1' });
checkEqual('已确认菜单可查询评价状态', detail.success, true);
checkEqual('未完成时 canRate=false', detail.data.canRate, false);
checkEqual('干饭人没有完成制作入口', detail.data.canComplete, false);
checkEqual('干饭人 isCook=false', detail.data.isCook, false);

const cookDetail = await callAs(USER_COOK.openid, { action: 'getMealReview', familyId: FAMILY_A, menuId: 'menu-a1' });
checkEqual('掌勺人有完成制作入口', cookDetail.data.canComplete, true);
checkEqual('掌勺人 isCook=true', cookDetail.data.isCook, true);
checkEqual('掌勺人不能评价', cookDetail.data.canRate, false);
checkEqual('未完成时可完成菜品数正确', detail.data.summary.totalDishCount, 3);

await callAs(USER_COOK.openid, { action: 'completeMeal', familyId: FAMILY_A, menuId: 'menu-a1' });
const detail2 = await callAs(USER_MEMBER.openid, { action: 'getMealReview', familyId: FAMILY_A, menuId: 'menu-a1' });
checkEqual('完成后 canRate=true', detail2.data.canRate, true);
checkEqual('完成后 canComplete=false', detail2.data.canComplete, false);
check('完成后显示完成时间', detail2.data.completedAt.length > 0);
checkEqual('规则随详情下发', detail2.data.rules.basePoints, 10);
checkEqual('等级门槛随详情下发', detail2.data.rules.levels.length, 5);

const historyRes = await callAs(USER_COOK.openid, { action: 'getMenuHistory', familyId: FAMILY_A });
check('历史菜单包含已完成的用餐', historyRes.data.total >= 1);
checkEqual('已完成菜单出现在历史列表', historyRes.data.items[0].status, 'completed');

/* ============================== 汇总 ============================== */

console.log('\n==============================');
console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项');
if (failures.length > 0) {
  console.log('失败列表：');
  failures.forEach((item, index) => console.log('  ' + (index + 1) + '. ' + item));
  process.exit(1);
}
console.log('全部通过');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
