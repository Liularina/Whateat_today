/**
 * 基础菜谱库 · 静态结构与云函数行为验证（Phase 6）
 *
 * 运行：npm run verify:recipe          （完整输出）
 *       npm run verify:recipe -- --quiet（只输出小节标题、失败项与总计）
 *
 * 用内存版 wx-server-sdk（tools/mock-cloud.js）替换真实云开发，直接驱动
 * cloudfunctions/recipe/index.js，覆盖规范第 11 章的验收点。
 *
 * 本套件最重要的三条：
 *   1. 初始化可重复执行：不产生重复内置菜谱，也不覆盖用户自建菜谱；
 *   2. 列表只返回「启用的内置菜谱」，且不夹带食材 / 步骤等列表用不到的字段；
 *   3. 查询是公共只读：不要求登录，但客户端也没有任何写菜谱的口子。
 */
const path = require('path');
const fs = require('fs');

const { createMockCloud } = require('./mock-cloud');

const mock = createMockCloud();
const store = mock.store;
const resetStore = mock.resetStore;
const setMissingCollections = mock.setMissingCollections;

mock.install();

const recipeFn = require(path.join(__dirname, '..', 'cloudfunctions', 'recipe', 'index.js'));
const data = require(path.join(__dirname, '..', 'cloudfunctions', 'recipe', 'recipe-data.js'));
const seedModule = require(path.join(__dirname, '..', 'cloudfunctions', 'recipe', 'seed-recipes.js'));

const BUILTIN_RECIPES = data.BUILTIN_RECIPES;

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

/** 菜谱查询是公共只读接口，这里刻意用空 openid 调用 */
async function callRecipe(action, payload) {
  mock.setOpenid('');
  return recipeFn.main(Object.assign({ action: action }, payload || {}));
}

/** 捕获 recipe 统一日志，顺带屏蔽刷屏 */
const recipeLogs = [];
const rawConsoleLog = console.log.bind(console);
console.log = function (...args) {
  const first = args[0];
  if (typeof first === 'string' && first.indexOf('"functionName":"recipe"') !== -1) {
    recipeLogs.push(first);
    return;
  }
  rawConsoleLog(...args);
};

function lastRecipeLog() {
  const raw = recipeLogs[recipeLogs.length - 1];
  return raw ? JSON.parse(raw) : null;
}

/** 造一条用户自建菜谱，用于验证 seed 不会碰它 */
function pushUserRecipe(name) {
  store.recipes.push({
    _id: 'user-recipe-1',
    name: name,
    description: '用户自己加的菜',
    category: '家常菜',
    tags: ['自建'],
    difficulty: 'easy',
    cookTime: 10,
    servings: 1,
    ingredients: [{ name: '鸡蛋', amount: 1, unit: '个' }],
    steps: [{ step: 1, description: '随便炒炒', minutes: 5 }],
    source: 'manual',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/* ============================== 静态结构检查 ============================== */

function runStructureChecks() {
  section('静态结构检查');

  const root = path.join(__dirname, '..');
  const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
  const exists = (...parts) => fs.existsSync(path.join(root, ...parts));

  /* ---------- 页面文件齐全 ---------- */
  for (const ext of ['ts', 'wxml', 'wxss', 'json']) {
    check('存在 pages/recipes/index.' + ext, exists('miniprogram', 'pages', 'recipes', 'index.' + ext));
    check('存在 pages/recipes/detail.' + ext, exists('miniprogram', 'pages', 'recipes', 'detail.' + ext));
  }

  /* ---------- 路由注册：只在必要时新增，且不重复 ---------- */
  const appJson = JSON.parse(read('miniprogram', 'app.json'));
  const pages = appJson.pages;
  check('注册了 pages/recipes/index', pages.indexOf('pages/recipes/index') !== -1);
  check('注册了 pages/recipes/detail', pages.indexOf('pages/recipes/detail') !== -1);
  check('没有重复注册路由', new Set(pages).size === pages.length, 'pages=' + pages.length);

  /* ---------- 不擅自改 TabBar ---------- */
  const tabPaths = appJson.tabBar.list.map((item) => item.pagePath);
  checkEqual('TabBar 仍是 5 项', appJson.tabBar.list.length, 5);
  checkEqual(
    'TabBar 未加入菜谱页',
    tabPaths.join(','),
    ['pages/home/index', 'pages/ingredients/index', 'pages/order/index', 'pages/menu/index', 'pages/mine/index'].join(','),
  );

  /* ---------- 页面不直接调云函数，统一走 service ---------- */
  const listTs = read('miniprogram', 'pages', 'recipes', 'index.ts');
  const detailTs = read('miniprogram', 'pages', 'recipes', 'detail.ts');
  check('列表页未直接调用 wx.cloud.callFunction', listTs.indexOf('wx.cloud.callFunction') === -1);
  check('详情页未直接调用 wx.cloud.callFunction', detailTs.indexOf('wx.cloud.callFunction') === -1);
  check('列表页经由 recipeService', listTs.indexOf('recipeService') !== -1);
  check('详情页经由 recipeService', detailTs.indexOf('recipeService') !== -1);

  /* ---------- service 复用统一封装，且没有用 any 逃逸类型 ---------- */
  const serviceTs = read('miniprogram', 'services', 'recipe.ts');
  check('service 使用 callFunction', serviceTs.indexOf('callFunction') !== -1);
  check('service 未使用 any', !/\bany\b/.test(serviceTs));
  check(
    'service 的菜谱详情动作是 getRecipe',
    /'getRecipe'/.test(serviceTs),
  );
  check(
    '做法查询改用 getRecipeDetail，避免与菜谱详情撞车',
    /'getRecipeDetail'/.test(serviceTs),
  );

  /* ---------- 云函数不提供写菜谱接口 ---------- */
  const fnJs = read('cloudfunctions', 'recipe', 'index.js');
  check('云函数没有 createRecipe 写接口', fnJs.indexOf('createRecipe') === -1);
  check('云函数没有 updateRecipe 写接口', fnJs.indexOf('updateRecipe') === -1);
  check('云函数没有 deleteRecipe 写接口', fnJs.indexOf('deleteRecipe') === -1);

  /* ---------- 云函数仍是 JavaScript，未被改成 TypeScript ---------- */
  check('recipe 云函数仍是 .js', exists('cloudfunctions', 'recipe', 'index.js'));
  check('云函数内没有 TS 类型注解痕迹', fnJs.indexOf(': string') === -1);

  /* ---------- 初始化脚本存在 ---------- */
  check('存在 seed-recipes.js', exists('cloudfunctions', 'recipe', 'seed-recipes.js'));
  check('存在 recipe-data.js', exists('cloudfunctions', 'recipe', 'recipe-data.js'));
}

/* ============================== 菜谱数据完整性 ============================== */

function runDataChecks() {
  section('菜谱数据完整性');

  check(
    '菜谱总数不少于 30 道',
    BUILTIN_RECIPES.length >= 30,
    '实际 ' + BUILTIN_RECIPES.length,
  );

  const names = BUILTIN_RECIPES.map((item) => item.name);
  checkEqual('菜名不重复', new Set(names).size, names.length);

  /* ---------- 分类覆盖 ---------- */
  const byCategory = {};
  for (const item of BUILTIN_RECIPES) {
    byCategory[item.category] = (byCategory[item.category] || 0) + 1;
  }
  for (const category of data.RECIPE_CATEGORIES) {
    check(
      '分类「' + category + '」至少 3 道',
      (byCategory[category] || 0) >= 3,
      '实际 ' + (byCategory[category] || 0),
    );
  }
  check(
    '没有分类枚举之外的菜谱',
    Object.keys(byCategory).every((key) => data.RECIPE_CATEGORIES.indexOf(key) !== -1),
    Object.keys(byCategory).join(','),
  );

  /* ---------- 逐道字段校验 ---------- */
  const badFields = [];
  const badSteps = [];
  const badIngredients = [];
  const badDifficulty = [];
  const badFlags = [];

  for (const item of BUILTIN_RECIPES) {
    if (!item.name || !item.description || !Array.isArray(item.tags) || item.tags.length === 0) {
      badFields.push(item.name);
    }
    if (!Number.isInteger(item.cookTime) || item.cookTime <= 0 || item.cookTime > 300) {
      badFields.push(item.name + '(cookTime)');
    }
    if (!Number.isInteger(item.servings) || item.servings < 1 || item.servings > 12) {
      badFields.push(item.name + '(servings)');
    }
    if (['easy', 'medium', 'hard'].indexOf(item.difficulty) === -1) {
      badDifficulty.push(item.name);
    }
    // source / isActive 由初始化脚本统一写入，数据文件不自带；
    // 这里只拦「自带冲突值」的写法，落库后的断言在 runSeedTests 中。
    if (item.source !== undefined && item.source !== 'builtin') {
      badFlags.push(item.name + '(source)');
    }
    if (item.isActive !== undefined && item.isActive !== true) {
      badFlags.push(item.name + '(isActive)');
    }

    if (!Array.isArray(item.steps) || item.steps.length < 3) {
      badSteps.push(item.name + '(' + (item.steps ? item.steps.length : 'none') + ')');
    } else {
      const seen = new Set();
      item.steps.forEach((step, index) => {
        if (step.step !== index + 1) {
          badSteps.push(item.name + '(步骤序号)');
        }
        if (!step.description || step.description.trim().length < 5) {
          badSteps.push(item.name + '(步骤描述)');
        }
        if (!Number.isInteger(step.minutes) || step.minutes <= 0) {
          badSteps.push(item.name + '(步骤时长)');
        }
        if (seen.has(step.description)) {
          badSteps.push(item.name + '(步骤重复)');
        }
        seen.add(step.description);
      });
    }

    if (!Array.isArray(item.ingredients) || item.ingredients.length === 0) {
      badIngredients.push(item.name);
    } else {
      for (const ing of item.ingredients) {
        if (!ing.name || !ing.unit || typeof ing.amount !== 'number' || ing.amount <= 0) {
          badIngredients.push(item.name + '/' + ing.name);
        }
      }
    }
  }

  check('每道菜都有菜名 / 简介 / 标签 / 时间 / 人数', badFields.length === 0, badFields.join(','));
  check('难度取值合法', badDifficulty.length === 0, badDifficulty.join(','));
  check('基本数据不自带与 builtin 冲突的 source / isActive', badFlags.length === 0, badFlags.join(','));
  check('每道菜至少 3 个步骤，且步骤完整不重复', badSteps.length === 0, badSteps.join(','));
  check('食材用量完整且为正数', badIngredients.length === 0, badIngredients.join(','));

  /* ---------- 单位可量化：不允许「适量」这类无法换算的写法 ---------- */
  const vagueUnits = [];
  for (const item of BUILTIN_RECIPES) {
    for (const ing of item.ingredients) {
      if (/适量|少许|随意|一些/.test(ing.unit)) {
        vagueUnits.push(item.name + '/' + ing.name);
      }
    }
  }
  check('没有「适量 / 少许」这类不可量化单位', vagueUnits.length === 0, vagueUnits.join(','));

  /* ---------- 步骤是逐道写的，不是同一份通用步骤复制 ---------- */
  const signatures = BUILTIN_RECIPES.map((item) => item.steps.map((s) => s.description).join('|'));
  checkEqual('没有两道菜共用同一套步骤', new Set(signatures).size, BUILTIN_RECIPES.length);

  /* ---------- 食材尽量对齐营养库，便于 Phase 7 复用 ---------- */
  const facts = require(path.join(__dirname, '..', 'cloudfunctions', 'nutrition', 'nutrition-data.js'))
    .BUILTIN_NUTRITION_FACTS;
  const knownNames = new Set(facts.map((row) => row.standardName));

  let totalIngredients = 0;
  let knownIngredients = 0;
  for (const item of BUILTIN_RECIPES) {
    for (const ing of item.ingredients) {
      totalIngredients += 1;
      if (knownNames.has(ing.name)) {
        knownIngredients += 1;
      }
    }
  }
  // 调味料（料酒 / 醋 / 豆瓣酱 等）本来就不在营养库里，这里只要求主体食材覆盖面够高
  const ratio = knownIngredients / totalIngredients;
  check(
    '食材名与营养库重合度不低于 60%',
    ratio >= 0.6,
    '实际 ' + Math.round(ratio * 100) + '%',
  );
}

/* ============================== 初始化幂等 ============================== */

async function runSeedTests() {
  section('初始化：可重复执行且不覆盖用户数据');
  resetStore();

  const total = BUILTIN_RECIPES.length;

  /* ---------- 先放一条用户自建菜谱 ---------- */
  pushUserRecipe('我的私房菜');

  const first = await callRecipe('seedRecipes', {});
  check('首次初始化成功', first.success === true, first.message);
  checkEqual('首次全部为新增', first.data.inserted, total);
  checkEqual('首次没有更新', first.data.updated, 0);
  checkEqual('recipes 落库条数 = 内置 + 用户自建', store.recipes.length, total + 1);

  const second = await callRecipe('seedRecipes', {});
  check('重复初始化成功', second.success === true, second.message);
  checkEqual('重复执行不新增', second.data.inserted, 0);
  checkEqual('重复执行全部为更新', second.data.updated, total);
  checkEqual('重复执行不产生重复数据', store.recipes.length, total + 1);
  checkEqual('内置菜谱条数不变', store.recipes.filter((r) => r.source === 'builtin').length, total);

  /* ---------- 用户自建菜谱毫发无损 ---------- */
  const mine = store.recipes.filter((r) => r._id === 'user-recipe-1')[0];
  check('用户自建菜谱仍在', Boolean(mine));
  checkEqual('用户自建菜谱名称未被改写', mine.name, '我的私房菜');
  checkEqual('用户自建菜谱 source 未被改写', mine.source, 'manual');
  checkEqual('用户自建菜谱步骤未被覆盖', mine.steps.length, 1);

  /* ---------- 落库字段 ---------- */
  const builtinRows = store.recipes.filter((r) => r.source === 'builtin');
  checkEqual('落库内置菜谱条数正确', builtinRows.length, total);
  check(
    '每一道内置菜谱落库都带 isActive=true',
    builtinRows.every((r) => r.isActive === true),
    builtinRows.filter((r) => r.isActive !== true).map((r) => r.name).join(','),
  );

  const row = store.recipes.filter((r) => r.name === '番茄炒蛋')[0];
  check('落库字段齐全', Boolean(row && row.category && row.tags && row.ingredients && row.steps));
  checkEqual('落库 source = builtin', row.source, 'builtin');
  checkEqual('落库 isActive 为 true', row.isActive, true);
  check('落库带 createdAt', row.createdAt instanceof Date || typeof row.createdAt === 'string');
  check('落库带 updatedAt', row.updatedAt instanceof Date || typeof row.updatedAt === 'string');
  checkEqual('落库保留数据库生成的 _id', typeof row._id, 'string');

  /* ---------- 直调种子函数（本地调试路径）与云函数动作结果一致 ---------- */
  const direct = await seedModule.seedRecipes(mock.mockCloud.database());
  checkEqual('直调 seedRecipes 仍为全量更新', direct.updated, total);
  checkEqual('直调后条数不变', store.recipes.length, total + 1);
}

/* ============================== listRecipes ============================== */

async function runListTests() {
  section('listRecipes：列表 / 筛选 / 搜索 / 分页');
  resetStore();
  await callRecipe('seedRecipes', {});

  const total = BUILTIN_RECIPES.length;

  /* ---------- 默认分页 ---------- */
  const first = await callRecipe('listRecipes', {});
  check('默认查询成功', first.success === true, first.message);
  checkEqual('total 为全部内置菜谱数', first.data.total, total);
  checkEqual('默认每页 20 条', first.data.pageSize, 20);
  checkEqual('默认返回第 1 页', first.data.page, 1);
  checkEqual('默认返回 20 条', first.data.items.length, 20);

  /* ---------- 列表不夹带列表用不到的字段 ---------- */
  const item = first.data.items[0];
  check('列表项不含 ingredients', item.ingredients === undefined);
  check('列表项不含 steps', item.steps === undefined);
  check(
    '列表项字段正是页面需要的那些',
    ['_id', 'name', 'description', 'category', 'tags', 'difficulty', 'cookTime', 'servings'].every(
      (key) => Object.prototype.hasOwnProperty.call(item, key),
    ),
  );

  /* ---------- 排序稳定（按菜名升序） ---------- */
  const namesAsc = first.data.items.map((r) => r.name);
  const sorted = namesAsc.slice().sort();
  checkEqual('列表按菜名稳定排序', namesAsc.join('|'), sorted.join('|'));

  /* ---------- 分页正确 ---------- */
  const second = await callRecipe('listRecipes', { page: 2 });
  checkEqual('第 2 页返回剩余条数', second.data.items.length, total - 20);
  checkEqual('第 2 页 total 不变', second.data.total, total);
  check(
    '第 2 页与第 1 页无重叠',
    second.data.items.every((r) => namesAsc.indexOf(r.name) === -1),
  );

  const third = await callRecipe('listRecipes', { page: 3 });
  checkEqual('超出范围的页返回空数组', third.data.items.length, 0);
  checkEqual('超出范围的页 total 仍正确', third.data.total, total);

  const tiny = await callRecipe('listRecipes', { pageSize: 5, page: 2 });
  checkEqual('自定义 pageSize 生效', tiny.data.items.length, 5);
  checkEqual('自定义 pageSize 回显正确', tiny.data.pageSize, 5);

  /* ---------- 分类筛选 ---------- */
  for (const category of data.RECIPE_CATEGORIES) {
    const res = await callRecipe('listRecipes', { category: category });
    const expected = BUILTIN_RECIPES.filter((r) => r.category === category).length;
    checkEqual('筛选「' + category + '」total 正确', res.data.total, expected);
    check(
      '筛选「' + category + '」结果分类一致',
      res.data.items.every((r) => r.category === category),
    );
  }

  const all = await callRecipe('listRecipes', { category: '全部' });
  checkEqual('category=全部 等同不筛选', all.data.total, total);

  /* ---------- 关键词搜索 ---------- */
  const tomato = await callRecipe('listRecipes', { keyword: '番茄' });
  check('关键词能搜到菜谱', tomato.data.total > 0);
  check(
    '搜索结果菜名都含关键词',
    tomato.data.items.every((r) => r.name.indexOf('番茄') !== -1),
  );
  checkEqual(
    '番茄相关菜谱数与数据一致',
    tomato.data.total,
    BUILTIN_RECIPES.filter((r) => r.name.indexOf('番茄') !== -1).length,
  );

  const noMatch = await callRecipe('listRecipes', { keyword: '不存在的菜名' });
  checkEqual('搜不到时返回空列表', noMatch.data.items.length, 0);
  checkEqual('搜不到时 total 为 0', noMatch.data.total, 0);

  /* ---------- 关键词按字面量处理，不当正则执行 ---------- */
  const dot = await callRecipe('listRecipes', { keyword: '.' });
  checkEqual('关键词「.」按字面量匹配，不会命中全部', dot.data.total, 0);

  const paren = await callRecipe('listRecipes', { keyword: '(' });
  check('关键词含正则元字符不报错', paren.success === true, paren.message);
  checkEqual('关键词「(」按字面量匹配', paren.data.total, 0);

  const star = await callRecipe('listRecipes', { keyword: '.*' });
  checkEqual('关键词「.*」不会匹配全部', star.data.total, 0);

  /* ---------- 只返回启用的内置菜谱 ---------- */
  store.recipes.push({
    _id: 'disabled-1',
    name: '阿婆红烧肉',
    description: '已下架',
    category: '家常菜',
    tags: [],
    difficulty: 'hard',
    cookTime: 90,
    servings: 4,
    ingredients: [],
    steps: [],
    source: 'builtin',
    isActive: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  pushUserRecipe('我的私房菜');

  const afterHide = await callRecipe('listRecipes', { pageSize: 50 });
  checkEqual('已禁用的内置菜谱不计入 total', afterHide.data.total, total);
  check(
    '已禁用的内置菜谱不出现在列表',
    afterHide.data.items.every((r) => r.name !== '阿婆红烧肉'),
  );
  check(
    '用户自建菜谱不出现在内置菜谱列表',
    afterHide.data.items.every((r) => r.name !== '我的私房菜'),
  );

  /* ---------- 查询不要求登录 ---------- */
  check('空 openid 也能查询（公共只读）', first.success === true);
}

/* ============================== getRecipe ============================== */

async function runDetailTests() {
  section('getRecipe：详情 / 不存在 / 已禁用');
  resetStore();
  await callRecipe('seedRecipes', {});

  const target = store.recipes.filter((r) => r.name === '番茄炒蛋')[0];

  const res = await callRecipe('getRecipe', { recipeId: target._id });
  check('查询详情成功', res.success === true, res.message);
  checkEqual('返回菜名正确', res.data.recipe.name, '番茄炒蛋');
  checkEqual('返回分类正确', res.data.recipe.category, '家常菜');
  checkEqual('返回 source = builtin', res.data.recipe.source, 'builtin');
  checkEqual('返回 isActive = true', res.data.recipe.isActive, true);
  check('详情带食材清单', res.data.recipe.ingredients.length > 0);
  check('详情带烹饪步骤', res.data.recipe.steps.length >= 3);
  check('步骤按序号升序', res.data.recipe.steps.every((s, i, arr) => i === 0 || arr[i - 1].step <= s.step));
  check(
    'createdAt 序列化为 ISO 字符串',
    typeof res.data.recipe.createdAt === 'string' && res.data.recipe.createdAt.length > 0,
    res.data.recipe.createdAt,
  );
  check(
    '食材字段完整',
    res.data.recipe.ingredients.every(
      (i) => typeof i.name === 'string' && typeof i.amount === 'number' && typeof i.unit === 'string',
    ),
  );

  /* ---------- 不存在 / 已禁用 ---------- */
  const missing = await callRecipe('getRecipe', { recipeId: 'no-such-id' });
  checkEqual('不存在的菜谱被拒', missing.success, false);
  checkEqual('错误码 RECIPE_NOT_FOUND', missing.code, 'RECIPE_NOT_FOUND');

  store.recipes.push({
    _id: 'disabled-detail',
    name: '下架菜',
    description: '',
    category: '家常菜',
    tags: [],
    difficulty: 'easy',
    cookTime: 10,
    servings: 1,
    ingredients: [],
    steps: [],
    source: 'builtin',
    isActive: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const disabled = await callRecipe('getRecipe', { recipeId: 'disabled-detail' });
  checkEqual('已禁用菜谱不返回详情', disabled.success, false);
  checkEqual('已禁用菜谱错误码与不存在一致（不泄露存在性）', disabled.code, 'RECIPE_NOT_FOUND');

  /* ---------- 入参校验 ---------- */
  for (const bad of [{}, { recipeId: '' }, { recipeId: '   ' }, { recipeId: null }]) {
    const r = await callRecipe('getRecipe', bad);
    checkEqual('recipeId=' + JSON.stringify(bad.recipeId) + ' → 被拒绝', r.success, false);
    checkEqual('recipeId=' + JSON.stringify(bad.recipeId) + ' → INVALID_PARAMS', r.code, 'INVALID_PARAMS');
  }
}

/* ============================== 入参校验 ============================== */

async function runValidationTests() {
  section('listRecipes 入参校验：服务端独立校验');
  resetStore();
  await callRecipe('seedRecipes', {});

  const badCases = [
    { label: '分类不存在', event: { category: '甜品' } },
    { label: 'page = 0', event: { page: 0 } },
    { label: 'page 为负', event: { page: -1 } },
    { label: 'page 为小数', event: { page: 1.5 } },
    { label: 'page 非数字', event: { page: 'x' } },
    { label: 'pageSize = 0', event: { pageSize: 0 } },
    { label: 'pageSize 超上限 50', event: { pageSize: 51 } },
    { label: 'pageSize 为小数', event: { pageSize: 2.5 } },
    { label: 'pageSize 非数字', event: { pageSize: '很多' } },
    { label: '关键词超过 20 字', event: { keyword: new Array(22).join('菜') } },
  ];

  for (const item of badCases) {
    const res = await callRecipe('listRecipes', item.event);
    checkEqual(item.label + ' → 被拒绝', res.success, false);
    checkEqual(item.label + ' → INVALID_PARAMS', res.code, 'INVALID_PARAMS');
  }

  /* ---------- 合法边界 ---------- */
  const okCases = [
    { label: 'pageSize = 50（上限）', event: { pageSize: 50 } },
    { label: 'pageSize = 1', event: { pageSize: 1 } },
    { label: '空关键词', event: { keyword: '' } },
    { label: '空白关键词', event: { keyword: '   ' } },
    { label: 'page 超出范围但合法', event: { page: 999 } },
  ];
  for (const item of okCases) {
    const res = await callRecipe('listRecipes', item.event);
    check(item.label + ' → 查询成功', res.success === true, res.message);
  }
}

/* ============================== 集合缺失 / 异常 ============================== */

async function runFailureTests() {
  section('集合缺失与异常分支');
  resetStore();
  await callRecipe('seedRecipes', {});

  setMissingCollections(['recipes']);

  const list = await callRecipe('listRecipes', {});
  checkEqual('集合缺失时列表 → DB_NOT_READY', list.code, 'DB_NOT_READY');
  check('提示去控制台创建集合', /控制台/.test(list.message), list.message);

  const detail = await callRecipe('getRecipe', { recipeId: 'x' });
  checkEqual('集合缺失时详情 → DB_NOT_READY', detail.code, 'DB_NOT_READY');

  const noSeed = await callRecipe('seedRecipes', {});
  checkEqual('集合缺失时初始化 → DB_NOT_READY', noSeed.code, 'DB_NOT_READY');

  setMissingCollections([]);

  /* ---------- 未知 action ---------- */
  const unknown = await callRecipe('删掉所有菜谱', {});
  checkEqual('未知 action 被拒', unknown.success, false);
  checkEqual('错误码 UNKNOWN_ACTION', unknown.code, 'UNKNOWN_ACTION');

  /* ---------- 客户端没有任何写菜谱的口子 ---------- */
  for (const action of ['createRecipe', 'updateRecipe', 'deleteRecipe']) {
    const res = await callRecipe(action, { name: '我自己加的' });
    checkEqual('写接口 ' + action + ' 不存在', res.code, 'UNKNOWN_ACTION');
  }
  checkEqual('写尝试没有改变库内容', store.recipes.length, BUILTIN_RECIPES.length);

  /* ---------- 后续阶段的动作仍是未实现 ---------- */
  const gen = await callRecipe('generateRecipe', { menuId: 'm1' });
  checkEqual('generateRecipe 仍未实现', gen.code, 'NOT_IMPLEMENTED');

  /* ---------- ping 与日志 ---------- */
  const ping = await callRecipe('ping', {});
  checkEqual('ping 成功', ping.success, true);
  checkEqual('ping 返回 recipe', ping.data.function, 'recipe');

  await callRecipe('listRecipes', { category: '汤类' });
  const log = lastRecipeLog();
  check('日志带 requestId', typeof log.requestId === 'string' && log.requestId.length > 0);
  checkEqual('日志 functionName = recipe', log.functionName, 'recipe');
  checkEqual('日志 action 正确', log.action, 'listRecipes');
  checkEqual('日志 status = success', log.status, 'success');

  const failed = await callRecipe('getRecipe', { recipeId: 'nope' });
  checkEqual('失败时 success = false', failed.success, false);
  checkEqual('失败时 error.code 与 code 一致', failed.error.code, failed.code);
}

/* ============================== 入口 ============================== */

(async function main() {
  console.log('Phase 6 基础菜谱库 · 验证开始');

  runStructureChecks();
  runDataChecks();
  await runSeedTests();
  await runListTests();
  await runDetailTests();
  await runValidationTests();
  await runFailureTests();

  console.log('\n========================================');
  console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项');
  if (failures.length === 0) {
    console.log('全部通过');
  } else {
    console.log('失败清单：');
    failures.forEach((item) => console.log('  - ' + item));
    process.exitCode = 1;
  }
})();
