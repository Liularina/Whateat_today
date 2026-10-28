/**
 * AI 菜单推荐 · 多样性验证（离线，不发起真实模型请求）
 *
 * 运行：node tools/verify-recommend-diversity.js
 *
 * 覆盖：
 *   1. 提示词确实包含多样性规则与最近 7 天菜单；
 *   2. 近期做过的菜会被标记 recentlyUsed 并排到候选列表后部；
 *   3. 连续 5 次推荐，菜品结果出现可观察的变化；
 *   4. 不同库存得到不同的候选与结果；
 *   5. 库存含番茄 / 鸡蛋时，相关菜品仍在候选中（不被简单屏蔽）；
 *   6. 过敏原 / 忌口硬过滤仍然生效；
 *   7. 「重新生成未锁定菜品」不会返回当前菜单里的原菜；
 *   8. 锁定菜品在重新生成时保持不变。
 *
 * 说明：模型行为用「位置偏好」模拟（总是挑候选列表最前面的菜）。
 * 这是对模型最不利的假设——即使模型只会挑前排，候选轮转与历史排除也必须带来变化。
 */
const path = require('path');
const { createMockCloud } = require('./mock-cloud');

const mock = createMockCloud();
mock.install();

const store = mock.store;
const RECIPE_DATA = require(path.join(__dirname, '..', 'cloudfunctions', 'recipe', 'recipe-data.js'));

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
  check(name, actual === expected, 'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected));
}

function section(title) {
  console.log('\n=== ' + title + ' ===');
}

/* ============================== 模拟模型 ============================== */

let recommendCalls = [];
let menuCalls = [];

/** 从用户提示词里取出候选 JSON 数组 */
function extractCandidates(userContent) {
  const marker = '候选菜谱列表（JSON）：';
  const start = userContent.indexOf(marker);
  if (start === -1) return [];
  const rest = userContent.slice(start + marker.length).replace(/^\s+/, '');
  const newline = rest.indexOf('\n');
  const line = newline === -1 ? rest : rest.slice(0, newline);
  try {
    return JSON.parse(line.trim());
  } catch (_e) {
    return [];
  }
}

function userContentOf(messages) {
  const item = (messages || []).find((m) => m.role === 'user');
  return item ? item.content : '';
}

function systemContentOf(messages) {
  const item = (messages || []).find((m) => m.role === 'system');
  return item ? item.content : '';
}

/** 模拟推荐：按位置顺序，每套菜单取 3 道不重复的菜 */
function simulateRecommend(messages) {
  const candidates = extractCandidates(userContentOf(messages));
  const chosen = [];
  const menus = [];
  let cursor = 0;

  for (let m = 0; m < 3; m++) {
    const ids = [];
    while (ids.length < 3 && cursor < candidates.length) {
      const id = candidates[cursor].id;
      cursor += 1;
      if (chosen.indexOf(id) !== -1) continue;
      chosen.push(id);
      ids.push(id);
    }
    if (ids.length > 0) {
      menus.push({ title: '模拟菜单' + (m + 1), reason: '模拟', recipeIds: ids });
    }
  }
  return JSON.stringify({ menus: menus });
}

/** 模拟换菜 / 重新推荐：按位置顺序取前 N 道 */
function simulatePick(messages) {
  const candidates = extractCandidates(userContentOf(messages));
  const system = systemContentOf(messages);
  // 兼容两种提示词写法：「选择 N 道菜」与「换成 N 道真正不同的菜」
  const matched = system.match(/(?:选择|换成)\s*(\d+)\s*道/);
  const count = matched ? Number(matched[1]) : 1;
  return JSON.stringify({ selectedIds: candidates.slice(0, count).map((c) => c.id) });
}

/* ============================== 注入替身（必须在加载云函数之前） ============================== */

const recClient = require(path.join(__dirname, '..', 'cloudfunctions', 'recommend', 'openai-compatible-client.js'));
const recAi = require(path.join(__dirname, '..', 'cloudfunctions', 'recommend', 'ai-service.js'));
const menuClient = require(path.join(__dirname, '..', 'cloudfunctions', 'menu', 'openai-compatible-client.js'));
const menuAi = require(path.join(__dirname, '..', 'cloudfunctions', 'menu', 'ai-service.js'));

const FAKE_AI_CONFIG = { apiKey: 'test-key', baseUrl: 'https://api.example.com/v1', model: 'test-model' };

recClient.chatCompletion = async (_config, messages) => {
  recommendCalls.push({ messages: messages });
  return simulateRecommend(messages);
};
recAi.runAiCall = async (_db, _userId, _meta, fn) => fn(FAKE_AI_CONFIG);

menuClient.chatCompletion = async (_config, messages) => {
  menuCalls.push({ messages: messages });
  return simulatePick(messages);
};
menuAi.runAiCall = async (_db, _userId, _meta, fn) => fn(FAKE_AI_CONFIG);

const recommendFn = require(path.join(__dirname, '..', 'cloudfunctions', 'recommend', 'index.js'));
const menuFn = require(path.join(__dirname, '..', 'cloudfunctions', 'menu', 'index.js'));

/* ============================== 造数据 ============================== */

const FAMILY_ID = 'fam-rec';
const OPENID = 'openid-rec';

/** 把内置菜谱复制成数据库文档 */
function seedRecipes() {
  RECIPE_DATA.BUILTIN_RECIPES.forEach((recipe, index) => {
    store.recipes.push(Object.assign({}, recipe, {
      _id: 'r' + index,
      source: 'builtin',
      isActive: true,
    }));
  });
}

function ingredient(id, name, category) {
  return {
    _id: id,
    familyId: FAMILY_ID,
    name: name,
    standardName: name,
    quantity: 2,
    unit: '份',
    category: category || 'other',
    purchaseDate: '2026-10-18',
    expireDate: null,
  };
}

function seedBase(preferences) {
  store.users.push({ _id: 'u-rec', openid: OPENID, nickname: '测试用户' });
  store.families.push({
    _id: FAMILY_ID,
    name: '测试家庭',
    status: 'active',
    preferences: preferences || { taste: ['家常'], avoidIngredients: [], allergens: [] },
  });
  store.family_members.push({ _id: 'm-rec', familyId: FAMILY_ID, userId: 'u-rec', role: 'owner' });
  seedRecipes();
  mock.setOpenid(OPENID);
}

function setInventory(names) {
  store.ingredients.length = 0;
  names.forEach((name, index) => {
    store.ingredients.push(ingredient('i' + index, name, name === '鸡蛋' ? 'meat_egg' : 'vegetable'));
  });
}

function recentMenu(id, daysAgo, dishNames, dateLabel) {
  const createdAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  const items = dishNames.map((name, index) => {
    const recipe = store.recipes.find((r) => r.name === name);
    return {
      recipeId: recipe ? recipe._id : 'missing-' + index,
      name: name,
      ingredients: recipe ? recipe.ingredients : [],
      locked: false,
      position: index,
    };
  });
  store.menus.push({
    _id: id,
    familyId: FAMILY_ID,
    userId: 'u-rec',
    mealType: 'dinner',
    servings: 3,
    status: 'confirmed',
    items: items,
    createdAt: dateLabel || createdAt,
    updatedAt: createdAt,
  });
}

function dishNamesOf(result) {
  const names = [];
  (result.data.menus || []).forEach((menu) => {
    (menu.items || []).forEach((item) => names.push(item.name));
  });
  return names;
}

function unique(list) {
  return list.filter((item, index) => list.indexOf(item) === index);
}

async function recommend(requestId) {
  return recommendFn.main({
    action: 'recommendMenus',
    familyId: FAMILY_ID,
    mealType: 'dinner',
    servings: 3,
    requestId: requestId,
    // Phase 1：同餐次默认复用共享方案；本测试关注每次都真实生成时的多样性与提示词
    force: true,
  });
}

/* ============================== 1. 提示词内容 ============================== */

async function runPromptTests() {
  section('提示词与候选生成');

  setInventory(['番茄', '鸡蛋', '小葱', '食用油', '食盐']);
  // 番茄设为 3 份且明天到期：验证库存数量与临期信息真正进入提示词
  store.ingredients[0].quantity = 3;
  store.ingredients[0].expireDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  recommendCalls = [];
  const res = await recommend('prompt-1');

  check('推荐成功', res.success === true, res.message || '');
  check('返回 3 套菜单', (res.data.menus || []).length === 3,
    'actual=' + (res.data.menus || []).length);

  const system = systemContentOf(recommendCalls[0].messages);
  const user = userContentOf(recommendCalls[0].messages);

  check('系统提示词包含多菜系大厨角色', system.indexOf('菜系') !== -1 && system.indexOf('大厨') !== -1);
  check('系统提示词包含强去重规则', system.indexOf('【第三层：强力去重') !== -1);
  check('系统提示词要求比较主要食材与烹饪方式', system.indexOf('主要蛋白质 + 烹饪方式') !== -1);
  check('系统提示词允许跳出菜谱库', system.indexOf('【第二层：库存不够就跳出菜谱库】') !== -1);
  check('系统提示词声明番茄鸡蛋仍可推荐', system.indexOf('番茄炒蛋 / 西红柿炒鸡蛋') !== -1);
  check('系统提示词要求换汤不换药不算换菜', system.indexOf('换汤不换药') !== -1);
  check('系统提示词保留过敏原硬约束', system.indexOf('硬红线') !== -1);
  check('用户提示词包含最近 7 天菜单', user.indexOf('最近 7 天菜单') !== -1);
  check('用户提示词包含 recentlyUsed 说明', user.indexOf('recentlyUsed=true') !== -1);
  check('库存数量进入提示词', user.indexOf('番茄（3份）') !== -1);
  check('临期食材进入提示词', user.indexOf('临期食材') !== -1 && user.indexOf('临期食材（3 天内到期，可优先使用，但不得虚构）：番茄') !== -1);

  const candidates = extractCandidates(user);
  check('提示词候选数量为 60', candidates.length === 60, 'actual=' + candidates.length);
  check('候选包含 recentlyUsed 字段',
    candidates.every((c) => typeof c.recentlyUsed === 'boolean'));

  // 当前没有历史菜单，所有候选都不应标记为近期做过
  check('无历史菜单时 recentlyUsed 全为 false',
    candidates.every((c) => c.recentlyUsed === false));

  const names = candidates.map((c) => c.name);
  check('候选覆盖多个分类（不是只有番茄鸡蛋）',
    unique(candidates.map((c) => c.category)).length >= 3,
    unique(candidates.map((c) => c.category)).join('/'));
  check('候选未简单屏蔽番茄炒蛋', names.indexOf('番茄炒蛋') !== -1 || names.indexOf('番茄蛋汤') !== -1);
}

/* ============================== 2. 历史菜单排除 ============================== */

async function runHistoryTests() {
  section('历史菜单去重');

  store.menus.length = 0;
  recentMenu('recent-1', 1, ['番茄炒蛋', '番茄蛋汤']);
  recentMenu('recent-2', 3, ['蛋炒饭', '紫菜蛋花汤']);

  recommendCalls = [];
  const res = await recommend('history-1');
  check('带历史菜单仍推荐成功', res.success === true, res.message || '');

  const user = userContentOf(recommendCalls[0].messages);
  const candidates = extractCandidates(user);

  check('提示词包含历史菜单菜名', user.indexOf('番茄炒蛋') !== -1);
  check('提示词包含历史菜单主要食材', user.indexOf('mainIngredients') !== -1);

  const tomatoEgg = candidates.find((c) => c.name === '番茄炒蛋');
  const tomatoSoup = candidates.find((c) => c.name === '番茄蛋汤');
  check('番茄炒蛋被标记 recentlyUsed', !!tomatoEgg && tomatoEgg.recentlyUsed === true);
  check('番茄蛋汤被标记 recentlyUsed', !!tomatoSoup && tomatoSoup.recentlyUsed === true);

  const tomatoIndex = candidates.findIndex((c) => c.name === '番茄炒蛋');
  check('历史菜品被排到候选后部', tomatoIndex === -1 || tomatoIndex >= 10,
    'index=' + tomatoIndex);

  const names = dishNamesOf(res);
  check('本次结果未重复历史菜单中的番茄炒蛋', names.indexOf('番茄炒蛋') === -1, names.join('/'));
  check('本次结果未重复历史菜单中的番茄蛋汤', names.indexOf('番茄蛋汤') === -1, names.join('/'));
}

/* ============================== 3. 连续 5 次推荐 ============================== */

async function runFiveTimesTests() {
  section('连续 5 次推荐');

  store.menus.length = 0;
  setInventory(['番茄', '鸡蛋', '小葱', '食用油', '食盐']);

  const rounds = [];
  for (let i = 1; i <= 5; i++) {
    const res = await recommend('repeat-' + i);
    rounds.push(dishNamesOf(res));
  }

  rounds.forEach((names, index) => {
    console.log('  第 ' + (index + 1) + ' 次：' + names.join('、'));
  });

  const signatures = unique(rounds.map((names) => names.slice().sort().join('|')));
  check('5 次出现至少 3 种不同组合', signatures.length >= 3, 'distinct=' + signatures.length);

  const tomatoEggCount = rounds.filter((names) => names.indexOf('番茄炒蛋') !== -1).length;
  const tomatoSoupCount = rounds.filter((names) => names.indexOf('番茄蛋汤') !== -1).length;
  check('番茄炒蛋未在 5 次里全部出现', tomatoEggCount < 5, 'count=' + tomatoEggCount);
  check('番茄蛋汤未在 5 次里全部出现', tomatoSoupCount < 5, 'count=' + tomatoSoupCount);
  check('没有两次结果完全相同', signatures.length > 1);
}

/* ============================== 4. 不同库存 ============================== */

async function runInventoryTests() {
  section('不同库存的推荐差异');

  store.menus.length = 0;
  setInventory(['番茄', '鸡蛋', '小葱', '食用油', '食盐']);
  recommendCalls = [];
  await recommend('inv-a');
  const userA = userContentOf(recommendCalls[0].messages);
  const candidatesA = extractCandidates(userA);

  setInventory(['牛肉', '土豆', '胡萝卜', '青椒', '食用油', '食盐']);
  recommendCalls = [];
  const resB = await recommend('inv-b');
  const candidatesB = extractCandidates(userContentOf(recommendCalls[0].messages));

  const topA = candidatesA.slice(0, 10).map((c) => c.name).join('|');
  const topB = candidatesB.slice(0, 10).map((c) => c.name).join('|');
  check('两种库存的前 10 候选不同', topA !== topB);

  const beefOrPotatoInTop = candidatesB.slice(0, 10).some((c) =>
    c.ingredients.some((n) => n.indexOf('牛肉') !== -1 || n.indexOf('土豆') !== -1));
  check('牛肉/土豆库存进入前 10 候选', beefOrPotatoInTop, topB);

  const namesB = dishNamesOf(resB);
  const usesBeefOrPotato = namesB.some((name) => name.indexOf('牛肉') !== -1 || name.indexOf('土豆') !== -1);
  check('结果体现库存差异（出现牛肉/土豆菜）', usesBeefOrPotato, namesB.join('/'));
}

/* ============================== 5. 番茄鸡蛋仍可推荐 ============================== */

async function runTomatoAllowedTests() {
  section('番茄鸡蛋不被屏蔽');

  store.menus.length = 0;
  setInventory(['番茄', '鸡蛋', '小葱', '食用油', '食盐']);

  // 候选池按请求轮转采样（这正是避免「每次都是那几道菜」的机制），
  // 因此单次请求看不到某道菜属于正常，需要多采样几次才能验证「没有被屏蔽」。
  recommendCalls = [];
  let res = null;
  const seen = new Set();
  for (let i = 0; i < 8; i++) {
    store.menu_plans.length = 0;
    res = await recommend('tomato-allowed-' + i);
    const candidates = extractCandidates(userContentOf(recommendCalls[recommendCalls.length - 1].messages));
    candidates.forEach((c) => seen.add(c.name));
  }
  const names = Array.from(seen);

  check('多次采样后番茄炒蛋出现在候选里（未被屏蔽）', names.indexOf('番茄炒蛋') !== -1,
    '样本数=' + names.length);
  check('候选池仍保留其他鸡蛋菜', names.some((n) => /蛋/.test(n)));
  check('单次候选不会塞入全部菜谱（说明确有轮转采样）', names.length > 60,
    '累计候选=' + names.length);
  check('推荐成功且返回菜单', res.success === true && (res.data.menus || []).length > 0);
}

/* ============================== 6. 过敏原回归 ============================== */

async function runDietTests() {
  section('过敏原 / 忌口回归');

  store.menus.length = 0;
  setInventory(['番茄', '鸡蛋', '小葱', '食用油', '食盐', '花生米']);

  const family = store.families.find((f) => f._id === FAMILY_ID);
  family.preferences = { taste: ['家常'], avoidIngredients: [], allergens: ['花生'] };

  recommendCalls = [];
  const res = await recommend('diet-1');
  check('配置过敏原后仍能推荐', res.success === true, res.message || '');

  const candidates = extractCandidates(userContentOf(recommendCalls[0].messages));
  check('候选列表已过滤花生类菜品',
    candidates.every((c) => c.name.indexOf('花生') === -1));
  check('结果未出现花生类菜品', dishNamesOf(res).every((n) => n.indexOf('花生') === -1));

  family.preferences = { taste: ['家常'], avoidIngredients: [], allergens: [] };
}

/* ============================== 7. 重新生成未锁定菜品 ============================== */

function seedDraftMenu(id, dishNames, lockedName) {
  const items = dishNames.map((name, index) => {
    const recipe = store.recipes.find((r) => r.name === name);
    return {
      recipeId: recipe._id,
      name: recipe.name,
      description: recipe.description || '',
      category: recipe.category || '',
      tags: recipe.tags || [],
      difficulty: recipe.difficulty || 'easy',
      cookTime: recipe.cookTime || 20,
      servings: recipe.servings || 2,
      ingredients: recipe.ingredients || [],
      locked: lockedName === name,
      position: index,
      source: 'ai_recommendation',
    };
  });

  store.menus.push({
    _id: id,
    familyId: FAMILY_ID,
    userId: 'u-rec',
    mealType: 'dinner',
    servings: 3,
    status: 'draft',
    items: items,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

async function regenerate(menuId) {
  return menuFn.main({
    action: 'regenerateUnlockedItems',
    familyId: FAMILY_ID,
    menuId: menuId,
  });
}

async function runMenuRegenerateTests() {
  section('重新生成未锁定菜品');

  store.menus.length = 0;
  setInventory(['番茄', '鸡蛋', '小葱', '食用油', '食盐', '土豆', '牛肉']);

  seedDraftMenu('menu-draft-1', ['番茄炒蛋', '番茄蛋汤', '蛋炒饭'], '番茄炒蛋');

  const rounds = [];
  menuCalls = [];

  for (let i = 1; i <= 5; i++) {
    const res = await regenerate('menu-draft-1');
    check('第 ' + i + ' 次重新生成成功', res.success === true, res.message || '');
    const menu = store.menus.find((m) => m._id === 'menu-draft-1');
    const names = menu.items.map((item) => item.name);
    rounds.push(names);
    console.log('  第 ' + i + ' 次：' + names.join('、'));
    check('第 ' + i + ' 次保留锁定菜品', names.indexOf('番茄炒蛋') !== -1, names.join('/'));
    check('第 ' + i + ' 次锁定菜品仍在原位', menu.items[0].locked === true && menu.items[0].name === '番茄炒蛋');
  }

  // 候选池在每次请求里都不应包含当前菜单的菜
  const firstPrompt = userContentOf(menuCalls[0].messages);
  const firstCandidates = extractCandidates(firstPrompt);
  const currentIds = ['番茄炒蛋', '番茄蛋汤', '蛋炒饭'];
  const leaked = firstCandidates.filter((c) => currentIds.indexOf(c.name) !== -1);
  check('候选列表排除当前菜单菜品', leaked.length === 0,
    leaked.map((c) => c.name).join('/'));

  for (let i = 1; i < rounds.length; i++) {
    const overlap = rounds[i].filter((name) => rounds[i - 1].indexOf(name) !== -1 && name !== '番茄炒蛋');
    check('第 ' + (i + 1) + ' 次与上一次不重复', overlap.length === 0, overlap.join('/'));
  }

  const signatures = unique(rounds.map((names) => names.slice().sort().join('|')));
  check('5 次重新生成出现至少 4 种组合', signatures.length >= 4, 'distinct=' + signatures.length);

  const system = systemContentOf(menuCalls[0].messages);
  check('换菜提示词说明要换掉哪些菜', system.indexOf('【要换掉的菜】') !== -1);
  check('换菜提示词要求换汤不换药不算换菜', system.indexOf('换汤不换药') !== -1);
  check('换菜提示词禁止同主料同做法', system.indexOf('同主料同做法') !== -1);
  check('换菜提示词包含近期菜单提示', system.indexOf('近期菜单') !== -1);
  check('换菜提示词保留过敏原硬约束', system.indexOf('硬红线') !== -1);
}

/* ============================== 主流程 ============================== */

async function main() {
  seedBase();
  await runPromptTests();
  await runHistoryTests();
  await runFiveTimesTests();
  await runInventoryTests();
  await runTomatoAllowedTests();
  await runDietTests();
  await runMenuRegenerateTests();

  console.log('\n========================================');
  if (failures.length === 0) {
    console.log('通过 ' + passed + ' 项，失败 0 项');
    console.log('全部通过');
    process.exit(0);
  } else {
    console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项');
    failures.forEach((name) => console.log('  - ' + name));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('测试异常：', error);
  process.exit(1);
});