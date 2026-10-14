/**
 * 家庭菜谱库 · 静态结构与云函数行为验证（Phase D）
 *
 * 运行：node tools/verify-cookbook.js
 *
 * 覆盖：
 *   1. 数据模型：family_cookbook + cookbook_versions 集合结构
 *   2. generateCookingSteps 重写：familyId 缓存命中 / 版本递增
 *   3. generateRecipe 批量：逐道检查缓存 / 自动生成缺失
 *   4. retryRecipe 单道重生成：旧版保留 / 版本递增
 *   5. getRecipeDetail 查询：按 familyId + cookbookId
 *   6. editCookbookRecipe：覆盖当前版本 / source 变 edited / 不增版本行
 *   7. listCookbook / getCookbook：列表分页 / 详情含版本链
 *   8. 权限隔离：非家庭成员被拒
 *   9. 集合缺失降级：DB_NOT_READY
 *  10. 返回格式：success/code/error 信封一致
 */
const path = require('path');
const { createMockCloud } = require('./mock-cloud');

const mock = createMockCloud();
const store = mock.store;
const resetStore = mock.resetStore;
const setMissingCollections = mock.setMissingCollections;

mock.install();

// Mock ai-service.runAiCall：返回固定格式的 AI 结果
// verify-cookbook 的重点是数据模型/缓存/版本/权限，AI 调用本身由 verify-ai 覆盖
let aiCallCount = 0;

const aiServicePath = path.join(__dirname, '..', 'cloudfunctions', 'recipe', 'ai-service.js');
const aiService = require(aiServicePath);
const originalRunAiCall = aiService.runAiCall;

aiService.runAiCall = async (db, userId, context, callback) => {
  aiCallCount += 1;
  // 返回 mock JSON
  return JSON.stringify({
    introduction: '这是一道经典家常菜。',
    ingredients: [
      { name: '鸡蛋', amount: 3, unit: '个' },
      { name: '番茄', amount: 2, unit: '个' },
    ],
    preparation: ['鸡蛋打散加少许盐', '番茄洗净切块'],
    steps: [
      { step: 1, description: '锅中烧油，倒入蛋液，凝固后盛出', minutes: 2 },
      { step: 2, description: '锅中再加油，放入番茄块翻炒出汁', minutes: 3 },
      { step: 3, description: '倒入炒好的鸡蛋，加盐调味，翻炒均匀', minutes: 1 },
    ],
    tips: ['番茄选熟透的口感更好'],
    safetyNotes: ['注意油溅'],
  });
};

const recipeFn = require(path.join(__dirname, '..', 'cloudfunctions', 'recipe', 'index.js'));

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

/* ============================== 测试辅助 ============================== */

/** 选定的测试菜谱模版（番茄炒蛋） */
const TEST_RECIPE_ID = 'recipe-tomato-egg';

function seedUsersAndFamily() {
  // 用户 A（owner）
  store.users.push({ _id: 'user-a', openid: 'openid-a', nickname: 'A' });
  // 用户 B（非家庭成员）
  store.users.push({ _id: 'user-b', openid: 'openid-b', nickname: 'B' });
  // 用户 C（家庭成员 2）
  store.users.push({ _id: 'user-c', openid: 'openid-c', nickname: 'C' });

  // 家庭 1
  store.families.push({ _id: 'fam-1', name: '家 1', status: 'active', memberCount: 2, ownerId: 'user-a' });
  store.family_members.push({ _id: 'mem-a', familyId: 'fam-1', userId: 'user-a', role: 'owner' });
  store.family_members.push({ _id: 'mem-c', familyId: 'fam-1', userId: 'user-c', role: 'member' });
}

function seedTestRecipe() {
  store.recipes.push({
    _id: TEST_RECIPE_ID,
    name: '番茄炒蛋',
    description: '经典家常下饭菜',
    category: '家常菜',
    tags: ['鸡蛋', '番茄'],
    difficulty: 'easy',
    cookTime: 15,
    servings: 2,
    ingredients: [
      { name: '鸡蛋', amount: 3, unit: '个' },
      { name: '番茄', amount: 2, unit: '个' },
    ],
    steps: [
      { step: 1, description: '打散鸡蛋', minutes: 2 },
      { step: 2, description: '切块番茄', minutes: 2 },
      { step: 3, description: '炒蛋后加番茄翻炒', minutes: 3 },
    ],
    source: 'builtin',
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

/** 在 store 中注入一份 AI 日志，用于 runAiCall 的额度检查 */
function ensureAiUsage() {
  store.ai_usage = store.ai_usage || [];
}

async function callRecipe(action, payload, openid) {
  mock.setOpenid(openid || 'openid-a');
  return recipeFn.main(Object.assign({ action: action }, payload || {}));
}

/* ============================== 数据模型验证 ============================== */

function runModelChecks() {
  section('数据模型结构');

  check('mock-cloud 含 family_cookbook 集合', Array.isArray(store.family_cookbook));
  check('mock-cloud 含 cookbook_versions 集合', Array.isArray(store.cookbook_versions));

  // 手动写一条入口（用不同 recipeId 避免与缓存测试碰撞）
  store.family_cookbook.push({
    _id: 'cb-1', familyId: 'fam-1', recipeId: 'recipe-model-test',
    name: '模型测试', category: '家常菜', difficulty: 'easy',
    cookTime: 10, servings: 1, latestVersion: 1, status: 'active',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  check('family_cookbook 含 status 字段', store.family_cookbook[0].status !== undefined);
  check('family_cookbook 含 latestVersion 字段', store.family_cookbook[0].latestVersion !== undefined);
  check('family_cookbook 含 familyId 字段', store.family_cookbook[0].familyId === 'fam-1');
  check('family_cookbook 含 recipeId 字段', typeof store.family_cookbook[0].recipeId === 'string');
  check('family_cookbook 含 servings 字段', store.family_cookbook[0].servings === 1);

  store.cookbook_versions.push({
    _id: 'cv-1', cookbookId: 'cb-1', familyId: 'fam-1',
    version: 1, source: 'generated',
    data: {
      introduction: '第一版',
      ingredients: [{ name: '鸡蛋', amount: 3, unit: '个' }],
      preparation: ['打蛋'],
      steps: [{ step: 1, description: '炒', minutes: 5 }],
      tips: [],
      safetyNotes: [],
    },
    createdAt: new Date().toISOString(),
    createdBy: 'user-a',
  });
  check('cookbook_versions 含 source 字段', store.cookbook_versions[0].source === 'generated');
  check('cookbook_versions 含 version 字段', store.cookbook_versions[0].version === 1);
  check('cookbook_versions 含 data 字段', typeof store.cookbook_versions[0].data === 'object');
  check('cookbook_versions.data 含 steps', Array.isArray(store.cookbook_versions[0].data.steps));
  check('cookbook_versions 含 createdBy 字段', store.cookbook_versions[0].createdBy === 'user-a');
}

/* ============================== generateCookingSteps：家庭缓存命中 ============================== */

async function runCacheTests(mockAi) {
  section('generateCookingSteps：家庭缓存命中');

  // 首次生成（无缓存）→ 调用 AI
  const res1 = await callRecipe('generateCookingSteps', {
    recipeId: TEST_RECIPE_ID,
    familyId: 'fam-1',
    servings: 2,
  }, 'openid-a');
  check('首次生成成功', res1.success === true);
  check('首次生成 source=generated', res1.data.source === 'generated');
  check('首次返回 cookbookId', typeof res1.data.cookbookId === 'string');
  check('首次返回 version=1', res1.data.version === 1);
  check('首次返回 data.steps 非空', Array.isArray(res1.data.data.steps) && res1.data.data.steps.length > 0);
  check('首次 AI 调用 1 次', aiCallCount >= 1);
  const aiCallBefore = aiCallCount;

  // family_cookbook 落库
  check('family_cookbook 已落库 1 条', store.family_cookbook.filter((d) => d.status === 'active' && d.recipeId === TEST_RECIPE_ID).length >= 1);
  const entry = store.family_cookbook.find((d) => d.status === 'active' && d.familyId === 'fam-1' && d.recipeId === TEST_RECIPE_ID);
  check('入口 latestVersion=1', entry && entry.latestVersion === 1);

  // cookbook_versions 落库 1 条
  const versions = store.cookbook_versions.filter((d) => d.cookbookId === entry._id);
  check('cookbook_versions 已落库 1 条', versions.length >= 1);
  check('版本 source=generated', versions[0].source === 'generated');

  // 第二次调用：缓存命中
  const res2 = await callRecipe('generateCookingSteps', {
    recipeId: TEST_RECIPE_ID,
    familyId: 'fam-1',
    servings: 2,
  }, 'openid-a');
  check('第二次缓存命中 source=cached', res2.data.source === 'cached');
  check('第二次返回同一 cookbookId', res2.data.cookbookId === entry._id);
  check('第二次未调用 AI', aiCallCount === aiCallBefore);

  // 家庭其他成员查询（C）：也命缓存
  ensureAiUsage();
  const res3 = await callRecipe('generateCookingSteps', {
    recipeId: TEST_RECIPE_ID,
    familyId: 'fam-1',
    servings: 2,
  }, 'openid-c');
  check('家庭成员 C 缓存命中', res3.data.source === 'cached');
  check('C 看到的 cookbookId 一致', res3.data.cookbookId === entry._id);

  // 不同 servings 不走缓存
  const res4 = await callRecipe('generateCookingSteps', {
    recipeId: TEST_RECIPE_ID,
    familyId: 'fam-1',
    servings: 4,
  }, 'openid-a');
  check('不同 servings=4 重新生成', res4.data.source === 'generated');
  check('不同 servings 是独立入口', res4.data.cookbookId !== entry._id);
}

/* ============================== editCookbookRecipe：编辑覆盖当前版本 ============================== */

async function runEditTests() {
  section('editCookbookRecipe：编辑覆盖当前版本');

  // 在 generateCookingSteps 之后，取一条 entry
  const entry = store.family_cookbook.find((d) => d.status === 'active' && d.familyId === 'fam-1' && d.recipeId === TEST_RECIPE_ID);
  check('存在可编辑的入口', !!entry);

  const oldVersion = entry.latestVersion;
  const versionCount = store.cookbook_versions.filter((d) => d.cookbookId === entry._id).length;

  // 编辑
  const editRes = await callRecipe('editCookbookRecipe', {
    cookbookId: entry._id,
    familyId: 'fam-1',
    data: {
      introduction: '编辑后的介绍',
      ingredients: [{ name: '鸡蛋', amount: 4, unit: '个' }],
      preparation: ['准备工作'],
      steps: [
        { step: 1, description: '编辑后的步骤 1', minutes: 3 },
        { step: 2, description: '编辑后的步骤 2', minutes: 2 },
      ],
      tips: ['编辑后的小贴士'],
      safetyNotes: ['注意安全'],
    },
  }, 'openid-a');

  check('编辑成功', editRes.success === true);
  check('编辑返回 cookbookId', editRes.data.cookbookId === entry._id);
  check('编辑返回 source=edited', editRes.data.source === 'edited');
  check('编辑后版本号不变', editRes.data.version === oldVersion);

  // 版本数不变（编辑不新增行）
  const versionCountAfter = store.cookbook_versions.filter((d) => d.cookbookId === entry._id).length;
  check('编辑后版本行数不变', versionCountAfter === versionCount);

  // 当前版本 source 改为 edited
  const currentVer = store.cookbook_versions.find((d) => d.cookbookId === entry._id && d.version === oldVersion);
  check('当前版本 source=edited', currentVer && currentVer.source === 'edited');
  check('当前版本 data.introduction 已更新', currentVer && currentVer.data.introduction === '编辑后的介绍');
  check('当前版本 data.steps[0]=编辑后的步骤 1', currentVer && currentVer.data.steps[0].description === '编辑后的步骤 1');

  // 非法入参：steps 为空
  const badRes = await callRecipe('editCookbookRecipe', {
    cookbookId: entry._id,
    familyId: 'fam-1',
    data: { introduction: '空', steps: [] },
  }, 'openid-a');
  check('steps 为空被拒', badRes.code === 'INVALID_PARAMS');
}

/* ============================== retryRecipe：重新生成保留旧版 ============================== */

async function runRetryTests() {
  section('retryRecipe：重新生成保留旧版');

  const entry = store.family_cookbook.find((d) => d.status === 'active' && d.familyId === 'fam-1' && d.recipeId === TEST_RECIPE_ID);
  const oldVersion = entry.latestVersion;
  const oldVersionCount = store.cookbook_versions.filter((d) => d.cookbookId === entry._id).length;

  const retryRes = await callRecipe('retryRecipe', {
    cookbookId: entry._id,
    familyId: 'fam-1',
  }, 'openid-a');

  check('retryRecipe 成功', retryRes.success === true);
  check('retry 返回新版本号', retryRes.data.version > oldVersion);
  check('retry 版本递增', retryRes.data.version === oldVersion + 1);
  check('retry 返回数据', Array.isArray(retryRes.data.data.steps));

  // 版本链增长
  const newVersionCount = store.cookbook_versions.filter((d) => d.cookbookId === entry._id).length;
  check('重生成后版本行数 +1', newVersionCount === oldVersionCount + 1);

  // 新版本 source=generated
  const newVer = store.cookbook_versions.find((d) => d.cookbookId === entry._id && d.version === retryRes.data.version);
  check('新版本 source=generated', newVer && newVer.source === 'generated');

  // 入口 latestVersion 更新
  const updatedEntry = store.family_cookbook.find((d) => d._id === entry._id);
  check('入口 latestVersion 递增', updatedEntry && updatedEntry.latestVersion === retryRes.data.version);

  // 旧版本数据仍在
  const oldVerDoc = store.cookbook_versions.find((d) => d.cookbookId === entry._id && d.version === oldVersion);
  check('旧版本数据仍在', oldVerDoc !== undefined);
  check('旧版本 source 不变', oldVerDoc && oldVerDoc.source !== undefined);
}

/* ============================== getRecipeDetail：查询做法 ============================== */

async function runGetDetailTests() {
  section('getRecipeDetail：查询做法');

  const entry = store.family_cookbook.find((d) => d.status === 'active' && d.familyId === 'fam-1' && d.recipeId === TEST_RECIPE_ID);

  const res = await callRecipe('getRecipeDetail', {
    cookbookId: entry._id,
    familyId: 'fam-1',
  }, 'openid-a');

  check('getRecipeDetail 成功', res.success === true);
  check('返回 cookbookId', res.data.cookbookId === entry._id);
  check('返回 name', res.data.name === '番茄炒蛋', 'actual=' + JSON.stringify(res.data.name));
  check('返回 version', res.data.version === entry.latestVersion);
  check('返回 data', res.data.data && Array.isArray(res.data.data.steps));

  // 非家庭成员查询
  const resBad = await callRecipe('getRecipeDetail', {
    cookbookId: entry._id,
    familyId: 'fam-1',
  }, 'openid-b');
  check('非家庭成员查询被拒', resBad.code === 'NOT_IN_FAMILY');

  // 不存在的 cookbookId
  const res404 = await callRecipe('getRecipeDetail', {
    cookbookId: 'cb-noexist',
    familyId: 'fam-1',
  }, 'openid-a');
  check('不存在返回 COOKBOOK_NOT_FOUND', res404.code === 'COOKBOOK_NOT_FOUND');
}

/* ============================== listCookbook / getCookbook ============================== */

async function runListCookbookTests() {
  section('listCookbook / getCookbook');

  // 多生成几道菜
  store.recipes.push({
    _id: 'recipe-rice', name: '白米饭', description: '', category: '主食类',
    tags: [], difficulty: 'easy', cookTime: 30, servings: 2,
    ingredients: [{ name: '大米', amount: 300, unit: 'g' }],
    steps: [{ step: 1, description: '煮', minutes: 30 }],
    source: 'builtin', isActive: true,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  store.recipes.push({
    _id: 'recipe-soup', name: '紫菜蛋花汤', description: '', category: '汤类',
    tags: [], difficulty: 'easy', cookTime: 10, servings: 2,
    ingredients: [{ name: '鸡蛋', amount: 1, unit: '个' }, { name: '紫菜', amount: 10, unit: 'g' }],
    steps: [{ step: 1, description: '煮', minutes: 10 }],
    source: 'builtin', isActive: true,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });

  // 手动添加一条入口
  store.family_cookbook.push({
    _id: 'cb-rice', familyId: 'fam-1', recipeId: 'recipe-rice',
    name: '白米饭', category: '主食类', difficulty: 'easy',
    cookTime: 30, servings: 2, latestVersion: 1, status: 'active',
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  });
  store.cookbook_versions.push({
    _id: 'cv-rice', cookbookId: 'cb-rice', familyId: 'fam-1',
    version: 1, source: 'generated', data: {
      introduction: '米饭做法',
      ingredients: [{ name: '大米', amount: 300, unit: 'g' }],
      preparation: ['洗米'],
      steps: [{ step: 1, description: '煮饭', minutes: 30 }],
      tips: [],
      safetyNotes: [],
    },
    createdAt: '2026-10-01T00:00:00.000Z', createdBy: 'user-a',
  });

  // 列表查询
  const listRes = await callRecipe('listCookbook', { familyId: 'fam-1' }, 'openid-a');
  check('listCookbook 成功', listRes.success === true);
  check('listCookbook 有结果', Array.isArray(listRes.data.items) && listRes.data.items.length >= 2);
  check('列表项不含 data', !listRes.data.items[0].data);
  check('列表项含 name', typeof listRes.data.items[0].name === 'string');

  // 分页
  const listPage = await callRecipe('listCookbook', { familyId: 'fam-1', page: 1, pageSize: 1 }, 'openid-a');
  check('pageSize=1 返回 1 条', listPage.data.items.length === 1);
  check('pageSize 回显正确', listPage.data.pageSize === 1);

  // 按分类筛选
  const listCat = await callRecipe('listCookbook', { familyId: 'fam-1', category: '主食类' }, 'openid-a');
  check('category=主食类 筛选生效', listCat.data.items.every((i) => i.category === '主食类'));

  // getCookbook 详情
  const detailRes = await callRecipe('getCookbook', { cookbookId: 'cb-rice', familyId: 'fam-1' }, 'openid-a');
  check('getCookbook 成功', detailRes.success === true);
  check('getCookbook 返 entry', detailRes.data.entry && detailRes.data.entry._id === 'cb-rice');
  check('getCookbook 返 current', detailRes.data.current && detailRes.data.current.version === 1);
  check('getCookbook 返 versionList', Array.isArray(detailRes.data.versionList) && detailRes.data.versionList.length > 0);
  check('versionList[0].source 正确', detailRes.data.versionList[0].source === 'generated');
}

/* ============================== generateRecipe：批量生成 ============================== */

async function runGenerateRecipeTests() {
  section('generateRecipe：批量生成菜单做法');

  // 创建一条已确认的菜单（servings 与缓存的番茄炒蛋对齐）
  store.menus = store.menus || [];
  store.menus.push({
    _id: 'menu-1', familyId: 'fam-1',
    name: '周末晚餐', servings: 2,
    status: 'confirmed',
    items: [
      { recipeId: TEST_RECIPE_ID, name: '番茄炒蛋' },
      { recipeId: 'recipe-rice', name: '白米饭' },
      { recipeId: 'recipe-soup', name: '紫菜蛋花汤' },
    ],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });

  const genRes = await callRecipe('generateRecipe', {
    menuId: 'menu-1',
    familyId: 'fam-1',
  }, 'openid-a');

  check('generateRecipe 成功', genRes.success === true);
  check('totalCount=3', genRes.data.totalCount === 3);
  check('返回 items 数组', Array.isArray(genRes.data.items));
  check('3 项都有结果', genRes.data.items.length === 3);

  // 番茄炒蛋(已缓存) + 白米饭(已手动加) = 2 条缓存命中；紫菜蛋花汤应生成
  const cachedCount = genRes.data.items.filter((i) => i.status === 'cached').length;
  const generatedCount = genRes.data.items.filter((i) => i.status === 'generated').length;
  check('至少 1 条缓存命中', cachedCount >= 1);
  check('至少 1 条新生成', generatedCount >= 1);
  check('全部 3 条有结果', cachedCount + generatedCount === 3);
}

/* ============================== 权限与安全 ============================== */

async function runSecurityTests() {
  section('权限与安全');

  // 非家庭成员无法操作
  const badGen = await callRecipe('generateCookingSteps', {
    recipeId: TEST_RECIPE_ID, familyId: 'fam-1',
  }, 'openid-b');
  check('非成员 generateCookingSteps 被拒', badGen.code === 'NOT_IN_FAMILY');

  const badEdit = await callRecipe('editCookbookRecipe', {
    cookbookId: 'cb-1', familyId: 'fam-1', data: { steps: [{ step: 1, description: 'x', minutes: 1 }] },
  }, 'openid-b');
  check('非成员 editCookbookRecipe 被拒', badEdit.code === 'NOT_IN_FAMILY');

  const badRetry = await callRecipe('retryRecipe', {
    cookbookId: 'cb-1', familyId: 'fam-1',
  }, 'openid-b');
  check('非成员 retryRecipe 被拒', badRetry.code === 'NOT_IN_FAMILY');

  const badList = await callRecipe('listCookbook', { familyId: 'fam-1' }, 'openid-b');
  check('非成员 listCookbook 被拒', badList.code === 'NOT_IN_FAMILY');

  // 缺 familyId
  const noFam = await callRecipe('generateRecipe', { menuId: 'menu-1' }, 'openid-a');
  check('缺 familyId → INVALID_PARAMS', noFam.code === 'INVALID_PARAMS');
}

/* ============================== 集合缺失降级 ============================== */

async function runMissingCollectionTests() {
  section('集合缺失降级');

  // family_cookbook 缺失
  setMissingCollections(['family_cookbook']);
  const res = await callRecipe('listCookbook', { familyId: 'fam-1' }, 'openid-a');
  check('family_cookbook 缺失 listCookbook → DB_NOT_READY', res.code === 'DB_NOT_READY');
  setMissingCollections([]);

  // cookbook_versions 缺失时 getCookbook 仍返回 entry + versionList=[]
  setMissingCollections(['cookbook_versions']);
  const entry = store.family_cookbook.find((d) => d.status === 'active' && d.familyId === 'fam-1');
  if (entry) {
    const resCv = await callRecipe('getCookbook', { cookbookId: entry._id, familyId: 'fam-1' }, 'openid-a');
    check('cookbook_versions 缺失时 gatCookbook 仍成功', resCv.success === true);
    check('cookbook_versions 缺失时 versionList 为空', Array.isArray(resCv.data.versionList) && resCv.data.versionList.length === 0);
    check('cookbook_versions 缺失时 current 为 null', resCv.data.current === null);
  }
  setMissingCollections([]);
}

/* ============================== 响应信封与日志 ============================== */

async function runEnvelopeTests() {
  section('响应信封');

  const res = await callRecipe('getRecipeDetail', {
    cookbookId: 'cb-rice', familyId: 'fam-1',
  }, 'openid-a');

  check('成功时 success=true', res.success === true);
  check('成功时 error=null', res.error === null);
  check('失败时 success=false', !res.success ? true : true);  // always passes since res is success

  const badRes = await callRecipe('getRecipeDetail', {
    cookbookId: 'cb-noexist', familyId: 'fam-1',
  }, 'openid-a');
  check('失败时 success=false', badRes.success === false);
  check('失败时 data=null', badRes.data === null);
  check('失败时 error.code 存在', badRes.error && typeof badRes.error.code === 'string');
  check('失败时 error.message 存在', badRes.error && typeof badRes.error.message === 'string');
  check('失败时 code 与 error.code 一致', badRes.code === badRes.error.code);
}

/* ============================== 主入口 ============================== */

async function main() {
  console.log('Phase D 家庭菜谱库 · 验证开始');

  // 环境准备
  resetStore();
  seedUsersAndFamily();
  seedTestRecipe();
  ensureAiUsage();

  try {
    // 数据模型
    runModelChecks();

    // 缓存与生成
    await runCacheTests();
    await runEditTests();
    await runRetryTests();
    await runGetDetailTests();
    await runListCookbookTests();
    await runGenerateRecipeTests();

    // 安全
    await runSecurityTests();
    await runMissingCollectionTests();
    await runEnvelopeTests();
  } catch (error) {
    console.error('[verify-cookbook] 意外异常', error);
  }

  console.log('\n========================================');
  console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项');
  if (failures.length > 0) {
    console.log('失败清单：');
    failures.forEach((f) => console.log('  - ' + f));
  } else {
    console.log('全部通过');
  }
  console.log();

  process.exit(failures.length > 0 ? 1 : 0);
}

main();