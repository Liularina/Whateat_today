/**
 * 餐次协作 · 静态结构与云函数行为验证（Phase 1）
 *
 * 运行：node tools/verify-meal-plan.js
 *
 * 覆盖：
 *   1. meal-plan-core 纯函数：日期口径 / 入参规范化 / 偏好汇总 / 方案转菜单快照
 *   2. getMealBoard：无方案 / 有方案 / 集合缺失降级
 *   3. submitPreference：权限、入参、方案归属、菜品归属、幂等更新、确认后拒绝
 *   4. setMealCook：管理员 / 当前掌勺人可交接，普通成员不可抢占
 *   5. confirmPlan：只有掌勺人能确认；生成已确认菜单并回写方案
 *   6. confirmMenu / setMenuItemLocked：掌勺人校验与旧菜单兼容
 */
const path = require('path');
const { createMockCloud } = require('./mock-cloud');

const mock = createMockCloud();
const store = mock.store;
const resetStore = mock.resetStore;
const setMissingCollections = mock.setMissingCollections;

mock.install();

const core = require(path.join(__dirname, '..', 'cloudfunctions', 'menu', 'meal-plan-core.js'));
const menuFn = require(path.join(__dirname, '..', 'cloudfunctions', 'menu', 'index.js'));
const recommendFn = require(path.join(__dirname, '..', 'cloudfunctions', 'recommend', 'index.js'));

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

const FAMILY_ID = 'fam-1';
const PLAN_DOC_ID = 'plan-doc-1';
const TODAY = core.beijingDateString();

function seedBase() {
  store.users.push({ _id: 'u-owner', openid: 'o-owner', nickname: '大厨' });
  store.users.push({ _id: 'u-member', openid: 'o-member', nickname: '小米' });
  store.users.push({ _id: 'u-out', openid: 'o-out', nickname: '外人' });

  store.families.push({
    _id: FAMILY_ID, name: '测试家', status: 'active', ownerId: 'u-owner',
    preferences: { defaultPeopleCount: 2, taste: ['家常'], avoidIngredients: [], allergens: [], defaultCookTime: 40 },
  });

  store.family_members.push({
    _id: 'm-owner', familyId: FAMILY_ID, userId: 'u-owner', role: 'owner',
    joinedAt: '2024-01-01T00:00:00.000Z',
  });
  store.family_members.push({
    _id: 'm-member', familyId: FAMILY_ID, userId: 'u-member', role: 'member',
    joinedAt: '2024-01-02T00:00:00.000Z',
  });

  store.recipes.push({
    _id: 'r1', source: 'builtin', isActive: true, name: '番茄炒蛋',
    description: '经典家常', category: '家常菜', tags: [], difficulty: 'easy',
    cookTime: 15, servings: 2,
    ingredients: [{ name: '番茄', amount: 2, unit: '个' }, { name: '鸡蛋', amount: 3, unit: '个' }],
  });
  store.recipes.push({
    _id: 'r2', source: 'builtin', isActive: true, name: '清炒时蔬',
    description: '清淡', category: '素菜', tags: [], difficulty: 'easy',
    cookTime: 10, servings: 2,
    ingredients: [{ name: '青菜', amount: 300, unit: 'g' }],
  });
}

function seedPlan(overrides) {
  const doc = Object.assign({
    _id: PLAN_DOC_ID,
    familyId: FAMILY_ID,
    date: TODAY,
    mealType: 'dinner',
    servings: 2,
    status: 'open',
    version: 1,
    cookId: 'u-owner',
    cookName: '大厨',
    generatedBy: 'u-owner',
    plans: [
      {
        planId: 'plan-1',
        title: '家常两菜',
        reason: '有蛋有菜',
        totalCookTime: 25,
        fullyCovered: true,
        missingCount: 0,
        missingIngredients: [],
        items: [
          { _id: 'r1', name: '番茄炒蛋', cookTime: 15 },
          { _id: 'r2', name: '清炒时蔬', cookTime: 10 },
        ],
      },
      {
        planId: 'plan-2',
        title: '清淡一菜',
        reason: '轻负担',
        totalCookTime: 10,
        fullyCovered: false,
        missingCount: 1,
        missingIngredients: ['青菜'],
        items: [{ _id: 'r2', name: '清炒时蔬', cookTime: 10 }],
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, overrides || {});
  store.menu_plans.push(doc);
  return doc;
}

function seedMenu(overrides) {
  const doc = Object.assign({
    _id: 'menu-1',
    familyId: FAMILY_ID,
    userId: 'u-owner',
    cookId: 'u-owner',
    cookName: '大厨',
    mealType: 'dinner',
    servings: 2,
    status: 'draft',
    items: [
      {
        recipeId: 'r1', name: '番茄炒蛋', description: '', category: '家常菜', tags: [],
        difficulty: 'easy', cookTime: 15, servings: 2,
        ingredients: [{ name: '番茄', amount: 2, unit: '个' }, { name: '鸡蛋', amount: 3, unit: '个' }],
        locked: false, position: 0, source: 'ai_recommendation',
      },
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

async function callRecommendAs(openid, event) {
  mock.setOpenid(openid);
  return recommendFn.main(Object.assign({ requestId: 'req-' + Math.random().toString(36).slice(2, 8) }, event));
}

function resetAll() {
  resetStore();
  setMissingCollections([]);
  seedBase();
}

/* ============================== 1. core 纯函数 ============================== */

async function main() {
resetAll();
section('1. meal-plan-core');

checkEqual('北京时间跨日：UTC 16:30 属于次日',
  core.beijingDateString('2026-10-23T16:30:00.000Z'), '2026-10-24');
checkEqual('北京时间同日：UTC 08:00 仍是当天',
  core.beijingDateString('2026-10-23T08:00:00.000Z'), '2026-10-23');

const dedup = core.normalizeDishVotes([
  { recipeId: 'r1', vote: 'want' },
  { recipeId: 'r1', vote: 'avoid' },
]);
checkEqual('菜品建议按 recipeId 去重，后者覆盖', JSON.stringify(dedup.value),
  JSON.stringify([{ recipeId: 'r1', vote: 'avoid' }]));
check('非法菜品建议被拒绝',
  core.normalizeDishVotes([{ recipeId: 'r1', vote: 'love' }]).error !== undefined);
checkEqual('留言限长 50 且去空白', core.normalizeNote('  ' + 'x'.repeat(80) + '  ').length, 50);

// 建议只针对掌勺人已保存的那份点单，不再有方案级投票
const summary = core.summarizePreferences({
  menuItems: [
    { recipeId: 'r1', name: '番茄炒蛋' },
    { recipeId: 'r2', name: '清炒时蔬' },
  ],
  preferences: [
    { familyId: FAMILY_ID, userId: 'u-owner', dishVotes: [{ recipeId: 'r1', vote: 'want' }], updatedAt: '2026-10-23T10:00:00.000Z' },
    { familyId: FAMILY_ID, userId: 'u-member', dishVotes: [{ recipeId: 'r1', vote: 'avoid' }, { recipeId: 'r2', vote: 'want' }], updatedAt: '2026-10-23T10:00:00.000Z' },
    { familyId: FAMILY_ID, userId: 'u-out', dishVotes: [{ recipeId: 'r1', vote: 'want' }], updatedAt: '2026-10-23T10:00:00.000Z' },
    { familyId: FAMILY_ID, userId: 'u-owner', dishVotes: [{ recipeId: 'r2', vote: 'avoid' }], updatedAt: '2026-10-23T09:00:00.000Z' },
  ],
  members: [
    { userId: 'u-owner', nickname: '大厨' },
    { userId: 'u-member', nickname: '小米' },
  ],
  viewerId: 'u-member',
  familyId: FAMILY_ID,
});

const dish1Stat = summary.dishes.find((item) => item.recipeId === 'r1');
const dish2Stat = summary.dishes.find((item) => item.recipeId === 'r2');
checkEqual('想吃人数只统计家庭成员', dish1Stat.wantCount, 1);
checkEqual('不想吃人数', dish1Stat.avoidCount, 1);
checkEqual('想吃的家人被点名', JSON.stringify(dish1Stat.wantBy), JSON.stringify(['大厨']));
checkEqual('同一成员按最新记录计票', dish2Stat.wantCount, 1);
checkEqual('旧记录不叠加', dish2Stat.avoidCount, 0);
checkEqual('参与人数按成员去重', summary.participantCount, 2);
checkEqual('全员表态后无人被点名', JSON.stringify(summary.missingMembers), JSON.stringify([]));
checkEqual('我的建议正确回填', summary.my.dishVotes.length, 2);

const straySummary = core.summarizePreferences({
  menuItems: [{ recipeId: 'r1', name: '番茄炒蛋' }],
  preferences: [
    { familyId: FAMILY_ID, userId: 'u-owner', dishVotes: [{ recipeId: 'r9', vote: 'want' }], updatedAt: '2026-10-23T10:00:00.000Z' },
  ],
  members: [{ userId: 'u-owner', nickname: '大厨' }],
  viewerId: 'u-owner',
  familyId: FAMILY_ID,
});
checkEqual('不在点单里的菜不产生统计', straySummary.dishes.length, 1);
checkEqual('幽灵菜的票数不计入', straySummary.dishes[0].wantCount, 0);

/* ============================== 2. getMealBoard ============================== */

section('2. getMealBoard');

resetAll();

let res = await callAs('o-owner', { action: 'getMealBoard', familyId: FAMILY_ID, mealType: 'dinner' });
check('无方案时接口成功', res.success === true, res.message);
checkEqual('无方案时 plan 为 null', res.data.plan, null);
checkEqual('无方案时 available 为 true', res.data.available, true);

res = await callAs('o-out', { action: 'getMealBoard', familyId: FAMILY_ID, mealType: 'dinner' });
checkEqual('非家庭成员被拒', res.code, 'NOT_IN_FAMILY');

seedPlan();
res = await callAs('o-member', { action: 'getMealBoard', familyId: FAMILY_ID, mealType: 'dinner' });
checkEqual('成员可读取本餐次方案', res.data.plan.planId, PLAN_DOC_ID);
checkEqual('普通成员不是掌勺人', res.data.isCook, false);
checkEqual('普通成员不是管理员', res.data.isOwner, false);
checkEqual('普通成员不能锁定菜单', res.data.canConfirm, false);
checkEqual('普通成员不能交接掌勺人', res.data.canSetCook, false);
checkEqual('尚未保存点单时 draft 为 null', res.data.draft, null);
checkEqual('尚未保存点单时没有菜品建议', res.data.summary.dishes.length, 0);

res = await callAs('o-owner', { action: 'getMealBoard', familyId: FAMILY_ID, mealType: 'dinner' });
checkEqual('掌勺人在保存点单前也不能锁定', res.data.canConfirm, false);
checkEqual('掌勺人可重新生成', res.data.canRegenerate, true);
checkEqual('掌勺人可交接', res.data.canSetCook, true);
checkEqual('管理员标记正确', res.data.isOwner, true);

// 掌勺人保存点单后，看板才有可建议的菜品
const saved = await callAs('o-owner', {
  action: 'saveMenu', familyId: FAMILY_ID, mealType: 'dinner',
  items: [{ recipeId: 'r1' }, { recipeId: 'r2' }],
});
check('掌勺人保存点单成功', saved.success === true, saved.message);

res = await callAs('o-member', { action: 'getMealBoard', familyId: FAMILY_ID, mealType: 'dinner' });
checkEqual('保存后 family 都能看到点单', res.data.draft.items.length, 2);
checkEqual('点单菜品带出菜名', res.data.draft.items[0].name, '番茄炒蛋');
checkEqual('建议范围与点单一致', res.data.summary.dishes.length, 2);
checkEqual('普通成员仍不能锁定', res.data.canConfirm, false);

res = await callAs('o-owner', { action: 'getMealBoard', familyId: FAMILY_ID, mealType: 'dinner' });
checkEqual('掌勺人此时可锁定', res.data.canConfirm, true);
checkEqual('方案记录草稿点单', res.data.plan.draftMenuId, saved.data.menuId);

// 首页场景：不传 mealType，取当天最近一份
res = await callAs('o-owner', { action: 'getMealBoard', familyId: FAMILY_ID });
checkEqual('不传 mealType 时返回当天方案', res.data.plan.mealType, 'dinner');

/* ============================== 3. submitPreference ============================== */

section('3. submitPreference');

resetAll();
seedPlan();

const baseVote = {
  action: 'submitPreference',
  familyId: FAMILY_ID,
  mealType: 'dinner',
  planId: PLAN_DOC_ID,
  dishVotes: [{ recipeId: 'r1', vote: 'want' }],
  note: '少放盐',
};

res = await callAs('o-out', baseVote);
checkEqual('非成员不能提交建议', res.code, 'NOT_IN_FAMILY');

res = await callAs('o-member', baseVote);
checkEqual('掌勺人未保存点单时不能建议', res.code, 'NO_DRAFT_MENU');

const savedForVote = await callAs('o-owner', {
  action: 'saveMenu', familyId: FAMILY_ID, mealType: 'dinner',
  items: [{ recipeId: 'r1' }, { recipeId: 'r2' }],
});

res = await callAs('o-member', Object.assign({}, baseVote, {
  dishVotes: [{ recipeId: 'r9', vote: 'want' }],
}));
checkEqual('不在点单里的菜被拒', res.code, 'INVALID_PARAMS');

res = await callAs('o-member', baseVote);
check('成员提交建议成功', res.success === true, res.message);
checkEqual('建议落库一条', store.meal_preferences.length, 1);
checkEqual('留言已保存', store.meal_preferences[0].note, '少放盐');
checkEqual('建议绑定草稿点单', store.meal_preferences[0].menuId, savedForVote.data.menuId);

res = await callAs('o-member', Object.assign({}, baseVote, {
  dishVotes: [{ recipeId: 'r1', vote: 'avoid' }],
}));
checkEqual('重复提交仍是同一条记录', store.meal_preferences.length, 1);
checkEqual('建议被更新', store.meal_preferences[0].dishVotes[0].vote, 'avoid');

// 建议不会改变菜单内容
const draftMenu = store.menus.find((doc) => doc._id === savedForVote.data.menuId);
checkEqual('家人建议没有改动菜单菜品', draftMenu.items.length, 2);
checkEqual('菜单仍是草稿', draftMenu.status, 'draft');

store.menu_plans[0].status = 'confirmed';
res = await callAs('o-member', baseVote);
checkEqual('已锁定菜单拒绝修改建议', res.code, 'PLAN_CONFIRMED');

store.menu_plans[0].status = 'superseded';
res = await callAs('o-member', baseVote);
checkEqual('已取代方案拒绝修改建议', res.code, 'PLAN_NOT_FOUND');
store.menu_plans[0].status = 'open';

/* ============================== 4. setMealCook ============================== */

section('4. setMealCook');

res = await callAs('o-member', {
  action: 'setMealCook', familyId: FAMILY_ID, mealType: 'dinner', cookId: 'u-member',
});
checkEqual('普通成员不能自行成为掌勺人', res.code, 'NOT_MEAL_COOK');

res = await callAs('o-owner', {
  action: 'setMealCook', familyId: FAMILY_ID, mealType: 'dinner', cookId: 'u-out',
});
checkEqual('掌勺人必须是家庭成员', res.code, 'INVALID_PARAMS');

res = await callAs('o-owner', {
  action: 'setMealCook', familyId: FAMILY_ID, mealType: 'dinner', cookId: 'u-member',
});
check('当前掌勺人可以交接', res.success === true, res.message);
checkEqual('方案掌勺人已更新', store.menu_plans[0].cookId, 'u-member');
checkEqual('交接写入审计', store.menu_plans[0].cookHistory.length, 1);

// 交接后原管理员已经不再是掌勺人，不能凭 owner 身份抢回来
res = await callAs('o-owner', {
  action: 'setMealCook', familyId: FAMILY_ID, mealType: 'dinner', cookId: 'u-owner',
});
checkEqual('管理员不能抢占别人发起的这一餐', res.code, 'NOT_MEAL_COOK');
checkEqual('掌勺人没有被管理员改回去', store.menu_plans[0].cookId, 'u-member');

res = await callAs('o-member', {
  action: 'setMealCook', familyId: FAMILY_ID, mealType: 'dinner', cookId: 'u-owner',
});
check('新掌勺人可以再交回', res.success === true, res.message);
checkEqual('两次交接都有审计', store.menu_plans[0].cookHistory.length, 2);

// ---- 兜底：掌勺人已不在家庭里时，管理员可以接管，否则这一餐会永久卡死 ----
resetAll();
seedPlan({ cookId: 'u-gone', cookName: '已退群' });

res = await callAs('o-member', {
  action: 'setMealCook', familyId: FAMILY_ID, mealType: 'dinner', cookId: 'u-member',
});
checkEqual('掌勺人离群时普通成员仍不能自封', res.code, 'NOT_MEAL_COOK');

res = await callAs('o-owner', {
  action: 'setMealCook', familyId: FAMILY_ID, mealType: 'dinner', cookId: 'u-owner',
});
check('掌勺人离群时管理员可以接管', res.success === true, res.message);
checkEqual('接管后掌勺人已更新', store.menu_plans[0].cookId, 'u-owner');
checkEqual('接管写入审计', store.menu_plans[0].cookHistory.length, 1);
checkEqual('审计记录原掌勺人', store.menu_plans[0].cookHistory[0].fromCookId, 'u-gone');

res = await callAs('o-owner', { action: 'getMealBoard', familyId: FAMILY_ID, mealType: 'dinner' });
checkEqual('接管后管理员成为掌勺人', res.data.isCook, true);
checkEqual('接管后不再需要兜底', res.data.canTakeOver, false);

// 兜底接管也要同步菜单上的掌勺人，否则完成制作 / 评价归属会错位
resetAll();
seedPlan({ cookId: 'u-gone', cookName: '已退群' });
const orphanDraft = await callAs('o-owner', {
  action: 'saveMenu', familyId: FAMILY_ID, mealType: 'dinner', items: [{ recipeId: 'r1' }],
});
checkEqual('离群掌勺人不影响管理员保存点单', orphanDraft.success, true);

res = await callAs('o-owner', {
  action: 'setMealCook', familyId: FAMILY_ID, mealType: 'dinner', cookId: 'u-owner',
});
check('兜底接管成功', res.success === true, res.message);
checkEqual('草稿菜单掌勺人已同步',
  store.menus.find((doc) => doc._id === orphanDraft.data.menuId).cookId, 'u-owner');

// 掌勺人还在家庭里时，管理员看板不出现兜底入口
resetAll();
seedPlan({ cookId: 'u-member', cookName: '小米' });
res = await callAs('o-owner', { action: 'getMealBoard', familyId: FAMILY_ID, mealType: 'dinner' });
checkEqual('掌勺人在家庭里时管理员没有兜底入口', res.data.canTakeOver, false);
checkEqual('掌勺人在家庭里时管理员不能交接', res.data.canSetCook, false);

/* ============================== 5. 锁定菜单（不必等家人建议） ============================== */

section('5. 掌勺人可强制锁定菜单');

resetAll();
seedPlan();
const savedForLock = await callAs('o-owner', {
  action: 'saveMenu', familyId: FAMILY_ID, mealType: 'dinner',
  items: [{ recipeId: 'r1' }, { recipeId: 'r2' }],
});
const draftId = savedForLock.data.menuId;

// 只有成员提了部分建议，掌勺人不等其余家人
await callAs('o-member', {
  action: 'submitPreference', familyId: FAMILY_ID, mealType: 'dinner',
  planId: PLAN_DOC_ID, dishVotes: [{ recipeId: 'r1', vote: 'want' }],
});

res = await callAs('o-member', { action: 'confirmMenu', familyId: FAMILY_ID, menuId: draftId });
checkEqual('普通成员不能锁定菜单', res.code, 'NOT_MEAL_COOK');

res = await callAs('o-owner', { action: 'confirmMenu', familyId: FAMILY_ID, menuId: draftId });
check('家人没提完建议时掌勺人仍可锁定', res.success === true, res.message);
checkEqual('菜单变为已锁定', store.menus.find((doc) => doc._id === draftId).status, 'confirmed');
checkEqual('方案回写为已确认', store.menu_plans[0].status, 'confirmed');
checkEqual('方案关联最终菜单', store.menu_plans[0].menuId, draftId);
checkEqual('方案记录锁定人', store.menu_plans[0].confirmedBy, 'u-owner');

// 重复保存点单：复用同一份草稿，不堆积
resetAll();
seedPlan();
const firstSave = await callAs('o-owner', {
  action: 'saveMenu', familyId: FAMILY_ID, mealType: 'dinner', items: [{ recipeId: 'r1' }],
});
const secondSave = await callAs('o-owner', {
  action: 'saveMenu', familyId: FAMILY_ID, mealType: 'dinner',
  items: [{ recipeId: 'r1' }, { recipeId: 'r2' }],
});
checkEqual('重复保存复用同一份草稿', secondSave.data.menuId, firstSave.data.menuId);
checkEqual('草稿菜品被更新', store.menus.find((doc) => doc._id === firstSave.data.menuId).items.length, 2);
checkEqual('没有堆积多份草稿', store.menus.length, 1);

/* ============================== 6. confirmMenu / 修改权限 ============================== */

section('6. confirmMenu / setMenuItemLocked 掌勺人校验');

resetAll();
seedPlan();
res = await callAs('o-member', {
  action: 'saveMenu', familyId: FAMILY_ID, mealType: 'dinner', items: [{ recipeId: 'r1' }],
});
checkEqual('非掌勺人不能创建本餐次草稿', res.code, 'NOT_MEAL_COOK');
res = await callAs('o-owner', {
  action: 'saveMenu', familyId: FAMILY_ID, mealType: 'dinner', items: [{ recipeId: 'r1' }],
});
check('掌勺人可以保存草稿', res.success === true, res.message);
checkEqual('草稿沿用方案掌勺人', store.menus[0].cookId, 'u-owner');

resetAll();
seedMenu();

res = await callAs('o-member', { action: 'confirmMenu', familyId: FAMILY_ID, menuId: 'menu-1' });
checkEqual('非掌勺人不能确认菜单', res.code, 'NOT_MEAL_COOK');

res = await callAs('o-member', {
  action: 'setMenuItemLocked', familyId: FAMILY_ID, menuId: 'menu-1', recipeId: 'r1', locked: true,
});
checkEqual('非掌勺人不能锁定菜品', res.code, 'NOT_MEAL_COOK');

res = await callAs('o-owner', {
  action: 'setMenuItemLocked', familyId: FAMILY_ID, menuId: 'menu-1', recipeId: 'r1', locked: true,
});
check('掌勺人可锁定菜品', res.success === true, res.message);

res = await callAs('o-owner', { action: 'confirmMenu', familyId: FAMILY_ID, menuId: 'menu-1' });
check('掌勺人可确认菜单', res.success === true, res.message);
checkEqual('菜单状态为 confirmed', store.menus[0].status, 'confirmed');

// 旧菜单没有 cookId：保持历史行为
resetAll();
seedMenu({ _id: 'menu-legacy', cookId: undefined, cookName: undefined });
res = await callAs('o-member', { action: 'confirmMenu', familyId: FAMILY_ID, menuId: 'menu-legacy' });
check('旧菜单（无 cookId）仍允许家庭成员确认', res.success === true, res.message);

// 交接掌勺人后，旧草稿以方案当前掌勺人为准
resetAll();
seedPlan();
seedMenu({ cookId: 'u-member', cookName: '小助手', planId: PLAN_DOC_ID });
res = await callAs('o-member', { action: 'confirmMenu', familyId: FAMILY_ID, menuId: 'menu-1' });
checkEqual('交接后旧掌勺人不能再确认', res.code, 'NOT_MEAL_COOK');
res = await callAs('o-owner', { action: 'confirmMenu', familyId: FAMILY_ID, menuId: 'menu-1' });
check('交接后新掌勺人可以确认', res.success === true, res.message);
checkEqual('确认人记录为实际掌勺人', store.menu_plans[0].confirmedBy, 'u-owner');
checkEqual('菜单掌勺人同步为当前掌勺人', store.menus[0].cookId, 'u-owner');

/* ============================== 7. 集合缺失降级 ============================== */

section('7. 集合缺失降级');

resetAll();
setMissingCollections(['menu_plans', 'meal_preferences']);
res = await callAs('o-owner', { action: 'getMealBoard', familyId: FAMILY_ID, mealType: 'dinner' });
check('集合缺失时接口不报错', res.success === true, res.message);
checkEqual('集合缺失时 available=false', res.data.available, false);
checkEqual('集合缺失时 plan 为 null', res.data.plan, null);
setMissingCollections([]);

/* ============================== 8. 已确认方案的复用与替换 ============================== */

section('8. recommendMenus 复用 / 替换');

resetAll();
seedPlan({ status: 'confirmed', menuId: 'menu-old' });

let rec = await callRecommendAs('o-member', {
  action: 'recommendMenus', familyId: FAMILY_ID, mealType: 'dinner', servings: 2,
});
check('已确认方案直接复用，不重复调用 AI', rec.success === true, rec.message);
checkEqual('复用结果标记 confirmed', rec.data.planStatus, 'confirmed');
checkEqual('复用结果带回 menuId', rec.data.menuId, 'menu-old');

rec = await callRecommendAs('o-member', {
  action: 'recommendMenus', familyId: FAMILY_ID, mealType: 'dinner', servings: 2, force: true,
});
checkEqual('非掌勺人不能替换已确认方案', rec.code, 'NOT_MEAL_COOK');

rec = await callRecommendAs('o-owner', {
  action: 'recommendMenus', familyId: FAMILY_ID, mealType: 'dinner', servings: 2, force: true,
});
checkEqual('掌勺人替换已确认方案需要二次确认', rec.code, 'CONFIRM_REQUIRED');

/* ============================== 9. 生成锁 ============================== */

section('9. 同一餐次生成锁');

resetAll();
const lockId = 'lock_' + FAMILY_ID + '_' + TODAY + '_dinner';
store.menu_plans.push({
  _id: lockId, type: 'plan_lock', familyId: FAMILY_ID, date: TODAY, mealType: 'dinner',
  owner: 'u-member', expiresAt: Date.now() + 60000,
});

rec = await callRecommendAs('o-owner', {
  action: 'recommendMenus', familyId: FAMILY_ID, mealType: 'dinner', servings: 2,
});
checkEqual('已有生成任务时返回忙碌', rec.code, 'PLAN_GENERATING');
checkEqual('忙碌时不新增方案', store.menu_plans.filter((doc) => doc.status === 'open').length, 0);

res = await callAs('o-owner', { action: 'getMealBoard', familyId: FAMILY_ID, mealType: 'dinner' });
checkEqual('锁文档不会被当成方案', res.data.plan, null);

// 过期锁可被接管；用「ingredients 缺失」让流程在 AI 之前结束，同时验证锁会被释放
store.menu_plans[0].expiresAt = Date.now() - 1000;
setMissingCollections(['ingredients']);
rec = await callRecommendAs('o-owner', {
  action: 'recommendMenus', familyId: FAMILY_ID, mealType: 'dinner', servings: 2,
});
checkEqual('过期锁可接管并继续执行', rec.code, 'DB_NOT_READY');
check('执行结束后锁已释放',
  store.menu_plans.filter((doc) => doc.type === 'plan_lock').length === 0);
setMissingCollections([]);

/* ============================== 10. 首页最终菜单优先 ============================== */

section('10. getTodayMenu 优先返回最终菜单');

resetAll();
seedMenu({ _id: 'menu-confirmed', status: 'confirmed', createdAt: TODAY + 'T01:00:00.000Z' });
seedMenu({ _id: 'menu-draft', status: 'draft', createdAt: TODAY + 'T02:00:00.000Z' });
res = await callAs('o-owner', { action: 'getTodayMenu', familyId: FAMILY_ID });
checkEqual('草稿不会挤掉已确认菜单', res.data.menu._id, 'menu-confirmed');

resetAll();
seedMenu({ _id: 'menu-draft-only', status: 'draft' });
res = await callAs('o-owner', { action: 'getTodayMenu', familyId: FAMILY_ID });
checkEqual('没有最终菜单时展示草稿', res.data.menu._id, 'menu-draft-only');

/* ============================== 11. cleanup 超时自动关闭 ============================== */

section('11. cleanup：48 小时自动关闭');

const cleanupFn = require(path.join(__dirname, '..', 'cloudfunctions', 'cleanup', 'index.js'));

function hoursAgoIso(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

resetAll();

// 未锁定、已超时 → expired
store.menu_plans.push({
  _id: 'plan-stale', familyId: FAMILY_ID, date: TODAY, mealType: 'lunch',
  status: 'open', type: 'plan', cookId: 'u-owner',
  createdAt: hoursAgoIso(50), updatedAt: hoursAgoIso(50),
});
// 未锁定、刚更新 → 必须保留
store.menu_plans.push({
  _id: 'plan-fresh', familyId: FAMILY_ID, date: TODAY, mealType: 'dinner',
  status: 'open', type: 'plan', cookId: 'u-owner',
  createdAt: hoursAgoIso(50), updatedAt: hoursAgoIso(1),
});

// 已锁定、超时 → completed
store.menus.push({
  _id: 'menu-stale', familyId: FAMILY_ID, status: 'confirmed', cookId: 'u-owner',
  items: [{ recipeId: 'r1', name: '番茄炒蛋' }],
  createdAt: hoursAgoIso(50), updatedAt: hoursAgoIso(50),
});
// 草稿不会被自动完成
store.menus.push({
  _id: 'menu-draft-stale', familyId: FAMILY_ID, status: 'draft',
  items: [{ recipeId: 'r1', name: '番茄炒蛋' }],
  createdAt: hoursAgoIso(50), updatedAt: hoursAgoIso(50),
});

const cleanupResult = await cleanupFn.main({});
check('cleanup 正常返回', !!cleanupResult, JSON.stringify(cleanupResult));

const stalePlan = store.menu_plans.find((d) => d._id === 'plan-stale');
const freshPlan = store.menu_plans.find((d) => d._id === 'plan-fresh');
checkEqual('超时未锁定方案变为 expired', stalePlan.status, 'expired');
checkEqual('刚刚更新过的方案保留 open', freshPlan.status, 'open');
check('过期方案记录过期时间', !!stalePlan.expiredAt);

const staleMenu = store.menus.find((d) => d._id === 'menu-stale');
const untouchedDraft = store.menus.find((d) => d._id === 'menu-draft-stale');
checkEqual('超时已锁定菜单自动完成', staleMenu.status, 'completed');
checkEqual('自动完成标记为系统操作', staleMenu.completedBy, 'system');
checkEqual('自动完成记录原因', staleMenu.completionReason, 'auto_timeout');
check('自动完成写入完成时间', !!staleMenu.completedAt);
checkEqual('草稿菜单不受自动完成影响', untouchedDraft.status, 'draft');

// 作废的方案不能再被当成「本餐次有效方案」
const boardAfterExpire = await callAs('o-owner', {
  action: 'getMealBoard', familyId: FAMILY_ID, mealType: 'lunch',
});
checkEqual('过期方案不再出现在看板', boardAfterExpire.data.plan, null);

// 作废后可以重新发起这一餐
const reopened = await callRecommendAs('o-member', {
  action: 'recommendMenus', familyId: FAMILY_ID, mealType: 'lunch', servings: 2,
});
check('过期后可以重新发起（不再被旧方案占位）',
  reopened.code !== 'PLAN_EXISTS', reopened.code || 'ok');

// 老数据兼容：Phase 11 之前的菜单只有 createdAt、没有 updatedAt，
// 若只按 updatedAt 查询会把这些最该收尾的数据永久漏掉。
resetAll();
store.menus.push({
  _id: 'menu-legacy-noupdated', familyId: FAMILY_ID, status: 'confirmed',
  cookId: 'u-owner', items: [{ recipeId: 'r1', name: '番茄炒蛋' }],
  createdAt: hoursAgoIso(72),
});
await cleanupFn.main({});
checkEqual('缺少 updatedAt 的老菜单也能自动完成',
  store.menus.find((d) => d._id === 'menu-legacy-noupdated').status, 'completed');

// 刚创建但也没有 updatedAt 的，不该被误伤
resetAll();
store.menus.push({
  _id: 'menu-legacy-fresh', familyId: FAMILY_ID, status: 'confirmed',
  cookId: 'u-owner', items: [{ recipeId: 'r1', name: '番茄炒蛋' }],
  createdAt: hoursAgoIso(1),
});
await cleanupFn.main({});
checkEqual('缺少 updatedAt 但刚创建的菜单保持 confirmed',
  store.menus.find((d) => d._id === 'menu-legacy-fresh').status, 'confirmed');

// 幂等：再跑一次不会重复处理已经 completed 的菜单
const again = await cleanupFn.main({});
checkEqual('重复执行不再产生新的自动完成', again.autoCompleted, 0);

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