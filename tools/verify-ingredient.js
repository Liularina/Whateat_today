/**
 * 食材库存 · 静态结构与云函数行为验证（Phase 4）
 *
 * 运行：npm run verify:ingredient          （完整输出）
 *       npm run verify:ingredient -- --quiet（只输出小节标题、失败项与总计）
 *
 * 用内存版 wx-server-sdk（tools/mock-cloud.js）替换真实云开发，直接驱动
 * cloudfunctions/ingredient/index.js 与 cloudfunctions/family/index.js，
 * 覆盖规范第 4 章的验收流程与家庭数据隔离要求。
 *
 * 不依赖真实云环境，因此可以在本地 / CI 中重复执行。
 */
const path = require('path');
const fs = require('fs');

const { createMockCloud } = require('./mock-cloud');

const mock = createMockCloud();
const store = mock.store;
const resetStore = mock.resetStore;
const setMissingCollections = mock.setMissingCollections;

mock.install();

const familyFn = require(path.join(__dirname, '..', 'cloudfunctions', 'family', 'index.js'));
const ingredientFn = require(path.join(__dirname, '..', 'cloudfunctions', 'ingredient', 'index.js'));
const shelfFilter = require(path.join(
  __dirname,
  '..',
  'cloudfunctions',
  'recommend',
  'shelf-filter.js',
));

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

/* -------- 捕获云函数统一日志，用于验证可追溯性 -------- */

const ingredientLogs = [];
const rawConsoleLog = console.log.bind(console);
console.log = function (...args) {
  const first = args[0];
  if (typeof first === 'string' && first.indexOf('"functionName":"ingredient"') !== -1) {
    ingredientLogs.push(first);
    return; // 统一日志已捕获，不再刷屏
  }
  rawConsoleLog(...args);
};

function lastIngredientLog() {
  const raw = ingredientLogs[ingredientLogs.length - 1];
  return raw ? JSON.parse(raw) : null;
}

/* ============================== 测试辅助 ============================== */

function seedUser(openid, id) {
  store.users.push({
    _id: id,
    openid: openid,
    nickname: '微信用户',
    avatarUrl: '',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function callFamily(openid, action, payload) {
  mock.setOpenid(openid);
  return familyFn.main(Object.assign({ action: action }, payload || {}));
}

async function callIngredient(openid, action, payload) {
  mock.setOpenid(openid);
  return ingredientFn.main(Object.assign({ action: action }, payload || {}));
}

/** 造一个家庭，返回 familyId 与 owner 身份 */
async function setupFamily(prefix) {
  const openidA = prefix + '-openid-a';
  const userA = prefix + '-user-a';
  seedUser(openidA, userA);
  const created = await callFamily(openidA, 'createFamily', { name: prefix + ' 的家' });
  return { familyId: created.data._id, openidA: openidA, userA: userA };
}

/** 造第二个家庭（另一个用户），用于验证跨家庭隔离 */
async function setupOtherFamily(prefix) {
  const openidB = prefix + '-openid-b';
  const userB = prefix + '-user-b';
  seedUser(openidB, userB);
  const created = await callFamily(openidB, 'createFamily', { name: prefix + ' 的另一个家' });
  return { familyId: created.data._id, openidB: openidB, userB: userB };
}

function ingredientsOf(familyId) {
  return mock.store.ingredients.filter((item) => item.familyId === familyId);
}

const VALID_INPUT = {
  name: '鸡蛋',
  quantity: 6,
  unit: '个',
  category: 'meat_egg',
  expireDate: null,
  remark: '',
};

/* ============================== Phase B：前端纯函数加载 ============================== */

const os = require('os');
const { execFileSync } = require('child_process');

/**
 * 前端 utils 是 TS，node 不能直接 require。
 * 这里用项目自带的 tsc 把入口编译到系统临时目录，再加载产物，
 * 从而对前端纯函数（临期计算、分类分组）做真实行为测试，
 * 而不是只看源码里有没有关键字。
 */
function loadFrontendUtils() {
  const root = path.join(__dirname, '..');
  const outDir = path.join(os.tmpdir(), 'wte-verify-ingredient-lib-' + process.pid);
  fs.rmSync(outDir, { recursive: true, force: true });

  // typescript 的 package.json 限制了 exports，不能直接 require.resolve('typescript/bin/tsc')，
  // 改为从包目录拼出真实的 bin 入口（bin/tsc 是 JS 文件，可被 node 直接执行）
  let tscBin = null;
  try {
    const tsPkg = require.resolve('typescript/package.json');
    const candidate = path.join(path.dirname(tsPkg), 'bin', 'tsc');
    if (fs.existsSync(candidate)) {
      tscBin = candidate;
    }
  } catch (error) {
    tscBin = null;
  }

  if (!tscBin) {
    return { error: '找不到 typescript，无法编译前端模块' };
  }

  try {
    execFileSync(
      process.execPath,
      [
        tscBin,
        '--ignoreConfig',
        path.join(root, 'miniprogram', 'utils', 'ingredient-group.ts'),
        '--outDir',
        outDir,
        '--module',
        'commonjs',
        '--target',
        'es2017',
        '--skipLibCheck',
        '--lib',
        'es2017',
      ],
      { stdio: 'pipe' },
    );
  } catch (error) {
    const detail = String((error.stdout || '') + (error.stderr || '')).slice(0, 500);
    return { error: 'tsc 编译前端模块失败: ' + detail };
  }

  return {
    outDir: outDir,
    shelfLife: require(path.join(outDir, 'utils', 'shelf-life.js')),
    ingredientGroup: require(path.join(outDir, 'utils', 'ingredient-group.js')),
  };
}

/* ============================== 静态结构检查 ============================== */

function runStructureChecks() {
  section('静态结构检查');

  const root = path.join(__dirname, '..');
  const appJson = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram', 'app.json'), 'utf8'));

  // 1. 食材页已注册，且四个文件齐全
  check('app.json 已注册 pages/ingredients/index', appJson.pages.indexOf('pages/ingredients/index') !== -1);
  let filesOk = true;
  const missing = [];
  for (const ext of ['.ts', '.wxml', '.json', '.wxss']) {
    const file = path.join(root, 'miniprogram', 'pages', 'ingredients', 'index' + ext);
    if (!fs.existsSync(file)) {
      filesOk = false;
      missing.push('index' + ext);
    }
  }
  check('食材页 .ts/.wxml/.json/.wxss 齐全', filesOk, missing.join(','));

  // 2. TabBar 未被破坏（食材是 5 个标签之一）
  checkEqual('TabBar 仍为 5 个标签', appJson.tabBar.list.length, 5);
  check(
    'TabBar 含食材页',
    appJson.tabBar.list.some((item) => item.pagePath === 'pages/ingredients/index'),
  );

  // 3. service 提供四个方法
  const serviceSource = fs.readFileSync(
    path.join(root, 'miniprogram', 'services', 'ingredient.ts'),
    'utf8',
  );
  const methods = ['list', 'create', 'update', 'remove'];
  check(
    'ingredient service 提供 4 个方法',
    methods.every((m) => new RegExp('\\b' + m + '\\s*\\(').test(serviceSource)),
  );
  check(
    'service 调用 ingredient 云函数的四个 action',
    ['listIngredients', 'createIngredient', 'updateIngredient', 'deleteIngredient'].every(
      (action) => serviceSource.indexOf(action) !== -1,
    ),
  );

  // 4. 页面不直接调用 wx.cloud.callFunction
  const pageSource = fs.readFileSync(
    path.join(root, 'miniprogram', 'pages', 'ingredients', 'index.ts'),
    'utf8',
  );
  check('食材页未直接调用 wx.cloud.callFunction', pageSource.indexOf('wx.cloud.callFunction') === -1);

  // 5. 页面组件接线
  const pageJson = JSON.parse(
    fs.readFileSync(path.join(root, 'miniprogram', 'pages', 'ingredients', 'index.json'), 'utf8'),
  );
  check(
    '食材页注册了 empty-state / error-state / loading-state / ingredient-item',
    ['empty-state', 'error-state', 'loading-state', 'ingredient-item'].every(
      (name) => Boolean(pageJson.usingComponents[name]),
    ),
  );

  const pageWxml = fs.readFileSync(
    path.join(root, 'miniprogram', 'pages', 'ingredients', 'index.wxml'),
    'utf8',
  );
  check(
    '列表使用 ingredient-item 组件并接上编辑 / 删除事件',
    pageWxml.indexOf('ingredient-item') !== -1 &&
      pageWxml.indexOf('bind:edit=') !== -1 &&
      pageWxml.indexOf('bind:delete=') !== -1,
  );
  check('页面提供添加食材入口', pageWxml.indexOf('onOpenCreate') !== -1);
  check(
    '页面含无家庭引导（食材属于家庭）',
    pageWxml.indexOf('你还没有家庭') !== -1 && pageWxml.indexOf('onGoCreateFamily') !== -1,
  );
  check('页面含空状态与错误重试', pageWxml.indexOf('冰箱里还没有食材') !== -1 && pageWxml.indexOf('bind:retry') !== -1);

  // 6. 云函数语法可解析
  const cloudNames = fs.readdirSync(path.join(root, 'cloudfunctions'));
  const badSyntax = [];
  for (const name of cloudNames) {
    const file = path.join(root, 'cloudfunctions', name, 'index.js');
    if (!fs.existsSync(file)) continue;
    try {
      require('vm').compileFunction(fs.readFileSync(file, 'utf8'), [], {});
    } catch (error) {
      badSyntax.push(name);
    }
  }
  check('8 个云函数语法检查通过', badSyntax.length === 0, badSyntax.join(','));

  // 7. §147/§148：本阶段没有任何 LLM / 外部网络调用
  const ingredientSource = fs.readFileSync(
    path.join(root, 'cloudfunctions', 'ingredient', 'index.js'),
    'utf8',
  );
  check(
    'ingredient 云函数无 LLM / 外部网络调用',
    /require\(['"](axios|node-fetch|request|https?)['"]\)|fetch\(/.test(ingredientSource) === false,
  );

  // 8. 权限与白名单是服务端强制的
  check('云函数实现了 requireFamilyMember 家庭权限校验', ingredientSource.indexOf('requireFamilyMember') !== -1);
  check('云函数按 familyId 过滤食材', ingredientSource.indexOf('familyId: familyId') !== -1);
  check('createdBy 由服务端写入', /createdBy:\s*guard\.user\._id/.test(ingredientSource));

  // 9. 前端不读取 openid
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

  // 10. 单位与换算复用既有常量，且 kg → g 已实现
  const unitsSource = fs.readFileSync(
    path.join(root, 'miniprogram', 'constants', 'units.ts'),
    'utf8',
  );
  check('单位仅 g/kg/个/袋/盒', /'g'[\s\S]{0,200}'kg'[\s\S]{0,200}'个'[\s\S]{0,200}'袋'[\s\S]{0,200}'盒'/.test(unitsSource));
  check('kg → g 换算是 ×1000', /amount \* 1000/.test(unitsSource));
  check('个/袋/盒 缺 averageWeight 时不猜测换算', /averageWeight === null[\s\S]{0,200}return null/.test(unitsSource));

  // 11. 新增食材不引入拍照 / OCR / 语音 / 自动扣库存
  // 先剔除注释再扫描，否则「本阶段不做拍照识别」这类说明文字会被误判成已实现
  // （Phase B 已实现临期计算，因此「临期」不再是禁止词）
  const stripComments = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, '');
  const codeText = stripComments(ingredientSource) + stripComments(pageSource);
  const forbidden = /\bocr\b|chooseImage|chooseMedia|startRecord|getRecorderManager|自动扣/i.test(
    codeText,
  );
  check('未实现拍照 / OCR / 语音 / 自动扣库存', forbidden === false);

  /* ---------- Phase B：保质期与分类折叠 ---------- */

  // 12. Phase B 新增的两个前端纯函数模块
  const shelfLifePath = path.join(root, 'miniprogram', 'utils', 'shelf-life.ts');
  const groupPath = path.join(root, 'miniprogram', 'utils', 'ingredient-group.ts');
  check('存在 utils/shelf-life.ts', fs.existsSync(shelfLifePath));
  check('存在 utils/ingredient-group.ts', fs.existsSync(groupPath));

  const shelfLifeSource = fs.existsSync(shelfLifePath) ? fs.readFileSync(shelfLifePath, 'utf8') : '';
  check(
    'SHELF_LIFE_WARNING_DAYS 默认为 3',
    /SHELF_LIFE_WARNING_DAYS\s*=\s*3\b/.test(shelfLifeSource),
  );
  check(
    'shelf-life 导出 getShelfLifeStatus / isExpired / daysUntil',
    ['getShelfLifeStatus', 'isExpired', 'daysUntil'].every(
      (name) => shelfLifeSource.indexOf('export function ' + name) !== -1,
    ),
  );
  check(
    'shelf-life 按 UTC 天数序号计算，避开时区偏移',
    shelfLifeSource.indexOf('Date.UTC') !== -1,
  );

  // 13. 类型与白名单已带上新字段
  const ingredientTypes = fs.readFileSync(
    path.join(root, 'miniprogram', 'types', 'ingredient.ts'),
    'utf8',
  );
  check('Ingredient 类型含 purchaseDate', ingredientTypes.indexOf('purchaseDate') !== -1);
  check('Ingredient 类型含 shelfLifeDays', ingredientTypes.indexOf('shelfLifeDays') !== -1);
  check(
    '云函数白名单写入 purchaseDate / shelfLifeDays',
    /purchaseDate:\s*parsed\.value\.purchaseDate/.test(ingredientSource) &&
      /shelfLifeDays:\s*parsed\.value\.shelfLifeDays/.test(ingredientSource),
  );
  check(
    '云函数支持由购买日 + 保质天数推导到期日',
    /addDays\(purchaseDate,\s*shelfLifeDays\)/.test(ingredientSource),
  );

  // 14. 食材组件提供三个快捷操作
  const itemComponentSource = fs.readFileSync(
    path.join(root, 'miniprogram', 'components', 'ingredient-item', 'index.ts'),
    'utf8',
  );
  check(
    '食材组件提供 已用完 / 补货 / 查看做法 三个快捷操作',
    ['onConsume', 'onRestock', 'onRecipes'].every(
      (name) => itemComponentSource.indexOf(name) !== -1,
    ),
  );
  const itemWxml = fs.readFileSync(
    path.join(root, 'miniprogram', 'components', 'ingredient-item', 'index.wxml'),
    'utf8',
  );
  check(
    '食材组件展示临期 / 过期标识',
    itemWxml.indexOf('ingredient__shelf--warning') !== -1 &&
      itemWxml.indexOf('ingredient__shelf--expired') !== -1,
  );

  // 15. 食材页按分类折叠，并接上快捷操作
  check(
    '食材页渲染分类分组并支持折叠切换',
    pageWxml.indexOf('wx:for="{{groups}}"') !== -1 &&
      pageWxml.indexOf('onToggleCategory') !== -1 &&
      pageWxml.indexOf('group.collapsed') !== -1,
  );
  check(
    '食材页接上 restock / recipes 事件',
    pageWxml.indexOf('bind:restock=') !== -1 && pageWxml.indexOf('bind:recipes=') !== -1,
  );
  check(
    '食材页表单提供购买日期与保质天数输入',
    pageWxml.indexOf('onPurchaseDateChange') !== -1 &&
      pageWxml.indexOf('onShelfLifeInput') !== -1,
  );
  check(
    '食材页用 buildCategoryGroups 构建分组',
    pageSource.indexOf('buildCategoryGroups') !== -1,
  );
  check(
    '食材页展示临期提醒条',
    pageWxml.indexOf('shelf-alert') !== -1 && pageWxml.indexOf('warningCount') !== -1,
  );

  // 16. 推荐排除过期食材（Phase B3）
  const shelfFilterPath = path.join(root, 'cloudfunctions', 'recommend', 'shelf-filter.js');
  check('存在 recommend/shelf-filter.js', fs.existsSync(shelfFilterPath));
  const recommendSource = fs.readFileSync(
    path.join(root, 'cloudfunctions', 'recommend', 'index.js'),
    'utf8',
  );
  check(
    'recommend 复用 shelf-filter 的 filterExpired',
    /require\(['"]\.\/shelf-filter['"]\)/.test(recommendSource) &&
      recommendSource.indexOf('filterExpired(') !== -1,
  );
  check(
    'recommend 在构建库存名单前过滤过期食材',
    recommendSource.indexOf('filterExpired(allIngredients') !== -1,
  );
}

/* ============================== 行为测试 ============================== */

async function runBehaviorTests() {
  /* ---------- 验收流程：建家庭 → 加鸡蛋 → 加番茄 → 改鸡蛋 → 删番茄 ---------- */
  section('验收流程：建家庭 → 添加鸡蛋 6 个 → 添加番茄 3 个 → 改鸡蛋 5 个 → 删番茄');
  resetStore();
  {
    const { familyId, openidA, userA } = await setupFamily('acc');

    // 添加鸡蛋 6 个
    const egg = await callIngredient(openidA, 'createIngredient', {
      familyId: familyId,
      input: { name: '鸡蛋', quantity: 6, unit: '个', category: 'meat_egg', remark: '' },
    });
    check('添加鸡蛋成功', egg.success === true);
    checkEqual('鸡蛋数量 6', egg.data.quantity, 6);
    checkEqual('鸡蛋单位 个', egg.data.unit, '个');
    checkEqual('鸡蛋标准名', egg.data.standardName, '鸡蛋');
    checkEqual('鸡蛋 createdBy = 当前用户', egg.data.createdBy, userA);
    checkEqual('鸡蛋 familyId = 当前家庭', egg.data.familyId, familyId);

    // 添加番茄 3 个
    const tomato = await callIngredient(openidA, 'createIngredient', {
      familyId: familyId,
      input: { name: '番茄', quantity: 3, unit: '个', category: 'vegetable', remark: '' },
    });
    check('添加番茄成功', tomato.success === true);

    // 列表能看到两种食材
    const list = await callIngredient(openidA, 'listIngredients', { familyId: familyId });
    checkEqual('列表中能看到 2 种食材', list.data.length, 2);
    check(
      '列表含鸡蛋与番茄',
      list.data.some((item) => item.standardName === '鸡蛋') &&
        list.data.some((item) => item.standardName === '番茄'),
    );

    // 修改鸡蛋为 5 个
    const updated = await callIngredient(openidA, 'updateIngredient', {
      familyId: familyId,
      id: egg.data._id,
      input: { name: '鸡蛋', quantity: 5, unit: '个', category: 'meat_egg', remark: '' },
    });
    check('修改鸡蛋成功', updated.success === true);
    checkEqual('鸡蛋数量已改为 5', updated.data.quantity, 5);

    const afterUpdate = await callIngredient(openidA, 'listIngredients', { familyId: familyId });
    const eggRow = afterUpdate.data.filter((item) => item._id === egg.data._id)[0];
    checkEqual('落库后鸡蛋数量为 5', eggRow.quantity, 5);

    // 删除番茄
    const removed = await callIngredient(openidA, 'deleteIngredient', {
      familyId: familyId,
      id: tomato.data._id,
    });
    check('删除番茄成功', removed.success === true);

    const afterDelete = await callIngredient(openidA, 'listIngredients', { familyId: familyId });
    checkEqual('删除后只剩 1 种食材', afterDelete.data.length, 1);
    checkEqual('剩下的是鸡蛋', afterDelete.data[0].standardName, '鸡蛋');
    checkEqual('数据库中家庭食材只剩 1 条', ingredientsOf(familyId).length, 1);
  }

  /* ---------- 核心要求：家庭 A 看不到家庭 B 的食材 ---------- */
  section('数据隔离：家庭 A 看不到家庭 B 的食材');
  resetStore();
  {
    const a = await setupFamily('iso-a');
    const b = await setupOtherFamily('iso-b');

    await callIngredient(a.openidA, 'createIngredient', {
      familyId: a.familyId,
      input: { name: '猪肉', quantity: 500, unit: 'g', category: 'meat_egg' },
    });
    await callIngredient(b.openidB, 'createIngredient', {
      familyId: b.familyId,
      input: { name: '西兰花', quantity: 2, unit: '个', category: 'vegetable' },
    });

    const listA = await callIngredient(a.openidA, 'listIngredients', { familyId: a.familyId });
    const listB = await callIngredient(b.openidB, 'listIngredients', { familyId: b.familyId });

    checkEqual('A 只看到 1 种食材', listA.data.length, 1);
    checkEqual('A 看到的是猪肉', listA.data[0].standardName, '猪肉');
    checkEqual('B 只看到 1 种食材', listB.data.length, 1);
    checkEqual('B 看到的是西兰花', listB.data[0].standardName, '西兰花');

    // 关键攻击：B 拿着 A 的 familyId 去读
    const attackList = await callIngredient(b.openidB, 'listIngredients', { familyId: a.familyId });
    checkEqual('B 用 A 的 familyId 查询被拒', attackList.success, false);
    checkEqual('错误码 PERMISSION_DENIED', attackList.code, 'PERMISSION_DENIED');

    // B 拿着自己的 familyId + A 的食材 id 去改 / 删
    const aIngredientId = listA.data[0]._id;

    const attackUpdate = await callIngredient(b.openidB, 'updateIngredient', {
      familyId: b.familyId,
      id: aIngredientId,
      input: { name: '偷来的肉', quantity: 1, unit: 'g', category: 'meat_egg' },
    });
    checkEqual('B 跨家庭修改被拒', attackUpdate.success, false);
    checkEqual('跨家庭修改错误码 INGREDIENT_NOT_FOUND', attackUpdate.code, 'INGREDIENT_NOT_FOUND');

    const attackDelete = await callIngredient(b.openidB, 'deleteIngredient', {
      familyId: b.familyId,
      id: aIngredientId,
    });
    checkEqual('B 跨家庭删除被拒', attackDelete.success, false);
    checkEqual('跨家庭删除错误码 INGREDIENT_NOT_FOUND', attackDelete.code, 'INGREDIENT_NOT_FOUND');

    // B 尝试往 A 的家庭塞食材
    const attackCreate = await callIngredient(b.openidB, 'createIngredient', {
      familyId: a.familyId,
      input: { name: '垃圾', quantity: 1, unit: 'g', category: 'other' },
    });
    checkEqual('B 往 A 家写食材被拒', attackCreate.success, false);

    // A 的数据零改动
    const afterAttack = ingredientsOf(a.familyId);
    checkEqual('攻击后 A 家食材数量不变', afterAttack.length, 1);
    checkEqual('攻击后 A 家食材名称未变', afterAttack[0].standardName, '猪肉');
    checkEqual('攻击后 A 家食材数量值未变', afterAttack[0].quantity, 500);
  }

  /* ---------- 越权尝试可追溯到人 / 家庭 ---------- */
  section('安全：越权尝试在日志中可追溯到 userId 与目标 familyId');
  resetStore();
  {
    const a = await setupFamily('log-a');
    const b = await setupOtherFamily('log-b');

    await callIngredient(b.openidB, 'listIngredients', { familyId: a.familyId });

    const log = lastIngredientLog();
    check('日志存在', Boolean(log));
    checkEqual('日志记录发起者 userId', log.userId, b.userB);
    checkEqual('日志记录目标 familyId', log.familyId, a.familyId);
    checkEqual('日志状态为 fail', log.status, 'fail');
    checkEqual('日志错误码', log.code, 'PERMISSION_DENIED');
  }

  /* ---------- 身份伪造：客户端传的派生字段一律忽略 ---------- */
  section('安全：客户端伪造 familyId / createdBy / standardName 均被忽略');
  resetStore();
  {
    const a = await setupFamily('forge');
    const b = await setupOtherFamily('forge-other');

    const res = await callIngredient(a.openidA, 'createIngredient', {
      familyId: a.familyId,
      input: {
        name: '西红柿',
        quantity: 2,
        unit: '个',
        category: 'vegetable',
        // 以下都是伪造字段，服务端必须忽略
        familyId: b.familyId,
        createdBy: b.userB,
        standardName: '伪造标准名',
        _id: 'fake-id',
        createdAt: '2000-01-01T00:00:00.000Z',
      },
    });

    check('创建成功', res.success === true);
    checkEqual('familyId 取当前家庭，不是伪造值', res.data.familyId, a.familyId);
    checkEqual('createdBy 取当前登录用户，不是伪造值', res.data.createdBy, a.userA);
    checkEqual('standardName 由服务端推导，不是伪造值', res.data.standardName, '番茄');

    const stored = ingredientsOf(a.familyId);
    checkEqual('伪造的 _id 未生效', stored[0]._id === 'fake-id', false);
    checkEqual('伪造的 createdAt 未生效', stored[0].createdAt !== '2000-01-01T00:00:00.000Z', true);
    checkEqual('食材只落在 A 家', ingredientsOf(b.familyId).length, 0);
  }

  /* ---------- 别名标准化 ---------- */
  section('食材标准名称：别名映射与回退');
  resetStore();
  {
    const a = await setupFamily('alias');

    const cases = [
      { input: '西红柿', expected: '番茄' },
      { input: '蕃茄', expected: '番茄' },
      { input: '香葱', expected: '小葱' },
      { input: '青葱', expected: '小葱' },
      { input: '土豆', expected: '土豆' },
      { input: '马铃薯', expected: '土豆' },
      { input: '西蓝花', expected: '西蓝花' },
      { input: '随便什么菜', expected: '随便什么菜' },
    ];

    for (const item of cases) {
      const res = await callIngredient(a.openidA, 'createIngredient', {
        familyId: a.familyId,
        input: { name: item.input, quantity: 1, unit: '个', category: 'vegetable' },
      });
      checkEqual('「' + item.input + '」→「' + item.expected + '」', res.data.standardName, item.expected);
      checkEqual('原始输入 name 保留为「' + item.input + '」', res.data.name, item.input);
    }

    // ingredient_aliases 集合中的记录覆盖内置表
    store.ingredient_aliases.push({ _id: 'alias-custom', alias: '西红柿', standardName: '洋柿子' });
    const override = await callIngredient(a.openidA, 'createIngredient', {
      familyId: a.familyId,
      input: { name: '西红柿', quantity: 1, unit: '个', category: 'vegetable' },
    });
    checkEqual('ingredient_aliases 覆盖内置别名', override.data.standardName, '洋柿子');

    // 别名集合缺失时退回内置表，不影响添加食材
    setMissingCollections(['ingredient_aliases']);
    const fallback = await callIngredient(a.openidA, 'createIngredient', {
      familyId: a.familyId,
      input: { name: '西红柿', quantity: 1, unit: '个', category: 'vegetable' },
    });
    setMissingCollections([]);
    checkEqual('别名集合缺失时仍能添加', fallback.success, true);
    checkEqual('别名集合缺失时退回内置表', fallback.data.standardName, '番茄');
  }

  /* ---------- 修改时重算标准名 ---------- */
  section('修改食材：名称变化会重算标准名');
  resetStore();
  {
    const a = await setupFamily('rename');
    const created = await callIngredient(a.openidA, 'createIngredient', {
      familyId: a.familyId,
      input: { name: '土豆', quantity: 2, unit: '个', category: 'vegetable' },
    });
    checkEqual('初始标准名为土豆', created.data.standardName, '土豆');

    const updated = await callIngredient(a.openidA, 'updateIngredient', {
      familyId: a.familyId,
      id: created.data._id,
      input: { name: '西红柿', quantity: 3, unit: '个', category: 'vegetable' },
    });
    checkEqual('改名后标准名重算为番茄', updated.data.standardName, '番茄');

    const stored = ingredientsOf(a.familyId)[0];
    checkEqual('落库标准名也重算', stored.standardName, '番茄');
    checkEqual('落库原始名同步更新', stored.name, '西红柿');
  }

  /* ---------- 入参校验：服务端独立校验 ---------- */
  section('入参校验：服务端独立校验，不信任前端');
  resetStore();
  {
    const a = await setupFamily('valid');

    const badCases = [
      { label: '空名称', input: { name: '   ', quantity: 1, unit: '个', category: 'other' } },
      { label: '超级长的名称', input: { name: '菜'.repeat(21), quantity: 1, unit: '个', category: 'other' } },
      { label: '数量 0', input: { name: '番茄', quantity: 0, unit: '个', category: 'vegetable' } },
      { label: '数量为负', input: { name: '番茄', quantity: -3, unit: '个', category: 'vegetable' } },
      { label: '数量超上限', input: { name: '番茄', quantity: 100000, unit: 'g', category: 'vegetable' } },
      { label: '数量非数字', input: { name: '番茄', quantity: 'abc', unit: '个', category: 'vegetable' } },
      { label: '非法单位', input: { name: '番茄', quantity: 1, unit: '斤', category: 'vegetable' } },
      { label: '非法分类', input: { name: '番茄', quantity: 1, unit: '个', category: '随便' } },
      { label: '坏日期', input: { name: '番茄', quantity: 1, unit: '个', category: 'vegetable', expireDate: '2026/01/01' } },
      { label: '不存在的日期', input: { name: '番茄', quantity: 1, unit: '个', category: 'vegetable', expireDate: '2026-02-30' } },
      { label: '超长备注', input: { name: '番茄', quantity: 1, unit: '个', category: 'vegetable', remark: '啊'.repeat(51) } },
    ];

    for (const item of badCases) {
      const res = await callIngredient(a.openidA, 'createIngredient', {
        familyId: a.familyId,
        input: item.input,
      });
      checkEqual(item.label + ' → 被拒绝', res.success, false);
      checkEqual(item.label + ' → 错误码 INVALID_PARAMS', res.code, 'INVALID_PARAMS');
    }

    checkEqual('非法入参一条都没落库', ingredientsOf(a.familyId).length, 0);
  }

  /* ---------- 合法边界 ---------- */
  section('入参校验：合法边界可以写入');
  resetStore();
  {
    const a = await setupFamily('bound');

    const okCases = [
      { label: '0.5 kg 小数数量', input: { name: '猪肉', quantity: 0.5, unit: 'kg', category: 'meat_egg' } },
      { label: 'g 大数量', input: { name: '大米', quantity: 9999, unit: 'g', category: 'staple' } },
      { label: '合法保质期', input: { name: '牛奶', quantity: 1, unit: '盒', category: 'dairy', expireDate: '2026-12-31' } },
      { label: '合法备注', input: { name: '香菜', quantity: 1, unit: '袋', category: 'vegetable', remark: '给奶奶留的' } },
    ];

    for (const item of okCases) {
      const res = await callIngredient(a.openidA, 'createIngredient', {
        familyId: a.familyId,
        input: item.input,
      });
      check(item.label + ' → 写入成功', res.success === true, res.message);
    }

    const list = await callIngredient(a.openidA, 'listIngredients', { familyId: a.familyId });
    checkEqual('4 条合法食材都落库', list.data.length, 4);

    const milk = list.data.filter((item) => item.name === '牛奶')[0];
    checkEqual('保质期按 YYYY-MM-DD 保存', milk.expireDate, '2026-12-31');

    const pork = list.data.filter((item) => item.name === '猪肉')[0];
    checkEqual('小数数量保留', pork.quantity, 0.5);
  }

  /* ---------- 写白名单 ---------- */
  section('安全：可写字段白名单');
  resetStore();
  {
    const a = await setupFamily('white');
    const res = await callIngredient(a.openidA, 'createIngredient', {
      familyId: a.familyId,
      input: Object.assign({}, VALID_INPUT, {
        role: 'owner',
        status: 'deleted',
        familyId: 'hacked-family',
      }),
    });

    check('创建成功', res.success === true);

    const stored = ingredientsOf(a.familyId)[0];
    const keys = Object.keys(stored).sort();
    const expectedKeys = [
      '_id',
      'category',
      'createdAt',
      'createdBy',
      'expireDate',
      'familyId',
      'name',
      'purchaseDate',
      'quantity',
      'remark',
      'shelfLifeDays',
      'standardName',
      'unit',
      'updatedAt',
    ].sort();

    checkEqual(
      '落库字段与白名单一致',
      JSON.stringify(keys),
      JSON.stringify(expectedKeys),
    );
    checkEqual('伪造的 status 未落库', stored.status === undefined, true);
    checkEqual('伪造的 role 未落库', stored.role === undefined, true);
  }

  /* ---------- 未登录 / 无家庭 / 缺 familyId ---------- */
  section('异常：未登录、缺 familyId、未加入家庭');
  resetStore();
  {
    const a = await setupFamily('guard');

    const noLogin = await callIngredient('', 'listIngredients', { familyId: a.familyId });
    checkEqual('未登录被拒', noLogin.success, false);
    checkEqual('未登录错误码 AUTH_REQUIRED', noLogin.code, 'AUTH_REQUIRED');

    const stranger = await callIngredient('stranger-openid', 'listIngredients', { familyId: a.familyId });
    checkEqual('未注册用户被拒', stranger.success, false);
    checkEqual('未注册用户错误码 UNAUTHORIZED', stranger.code, 'UNAUTHORIZED');

    const noFamilyId = await callIngredient(a.openidA, 'listIngredients', {});
    checkEqual('缺 familyId 被拒', noFamilyId.success, false);
    checkEqual('缺 familyId 错误码 INVALID_PARAMS', noFamilyId.code, 'INVALID_PARAMS');

    // 已登录但还没有家庭：拿一个不存在的 familyId
    seedUser('lonely-openid', 'lonely-user');
    const lonely = await callIngredient('lonely-openid', 'listIngredients', { familyId: 'not-exist-family' });
    checkEqual('没有家庭时被拒', lonely.success, false);
    checkEqual('没有家庭错误码 PERMISSION_DENIED', lonely.code, 'PERMISSION_DENIED');
  }

  /* ---------- 未知操作 ---------- */
  section('异常：未知 action');
  resetStore();
  {
    const res = await callIngredient('anyone', '让AI猜菜');
    checkEqual('未知 action 被拒', res.success, false);
    checkEqual('错误码 UNKNOWN_ACTION', res.code, 'UNKNOWN_ACTION');
  }

  /* ---------- DB_NOT_READY ---------- */
  section('异常：食材集合缺失时降级为 DB_NOT_READY');
  resetStore();
  {
    const a = await setupFamily('nodb');
    setMissingCollections(['ingredients']);

    const created = await callIngredient(a.openidA, 'createIngredient', {
      familyId: a.familyId,
      input: VALID_INPUT,
    });
    checkEqual('集合缺失 → 添加失败', created.success, false);
    checkEqual('错误码 DB_NOT_READY', created.code, 'DB_NOT_READY');
    check('错误信息提示去控制台建集合', /控制台/.test(created.message));

    const list = await callIngredient(a.openidA, 'listIngredients', { familyId: a.familyId });
    checkEqual('集合缺失 → 列表失败', list.success, false);
    checkEqual('列表错误码 DB_NOT_READY', list.code, 'DB_NOT_READY');

    setMissingCollections([]);
  }

  /* ---------- 家庭不存在 / 已解散 ---------- */
  section('异常：家庭已解散时不可读写食材');
  resetStore();
  {
    const a = await setupFamily('gone');
    await callIngredient(a.openidA, 'createIngredient', { familyId: a.familyId, input: VALID_INPUT });

    // 直接解散家庭
    await callFamily(a.openidA, 'dissolveFamily', { familyId: a.familyId });

    const list = await callIngredient(a.openidA, 'listIngredients', { familyId: a.familyId });
    checkEqual('已解散家庭的食材不可读', list.success, false);
    checkEqual('错误码 PERMISSION_DENIED（成员关系已删除）', list.code, 'PERMISSION_DENIED');
  }

  /* ---------- 响应信封与 requestId ---------- */
  section('响应信封与 requestId');
  resetStore();
  {
    const a = await setupFamily('env');
    const res = await callIngredient(a.openidA, 'listIngredients', { familyId: a.familyId });

    checkEqual('成功时 success = true', res.success, true);
    checkEqual('成功时 error = null', res.error, null);
    check('成功时 data 是数组', Array.isArray(res.data));

    const log = lastIngredientLog();
    check('日志带 requestId', typeof log.requestId === 'string' && log.requestId.length > 0);
    checkEqual('日志 functionName = ingredient', log.functionName, 'ingredient');
    checkEqual('日志 action 正确', log.action, 'listIngredients');
    checkEqual('日志 status = success', log.status, 'success');

    const failed = await callIngredient(a.openidA, 'deleteIngredient', {
      familyId: a.familyId,
      id: 'no-such-id',
    });
    checkEqual('失败时 success = false', failed.success, false);
    check('失败时 error.code 与 code 一致', failed.error.code === failed.code);
    check('失败时 error.message 非空', typeof failed.error.message === 'string' && failed.error.message.length > 0);
  }

  /* ---------- 日志不泄露内容 ---------- */
  section('安全：日志只记录 id，不记录食材内容以外的敏感信息');
  resetStore();
  {
    const a = await setupFamily('logsafe');
    await callIngredient(a.openidA, 'createIngredient', { familyId: a.familyId, input: VALID_INPUT });

    const log = lastIngredientLog();
    checkEqual('日志记录 ingredientId', typeof log.ingredientId, 'string');
    check('日志不含 openid', ingredientLogs.join('').indexOf(a.openidA) === -1);
  }

  /* ---------- 多人家庭共享同一份库存 ---------- */
  section('家庭成员共享同一份库存');
  resetStore();
  {
    const a = await setupFamily('share');

    seedUser('share-openid-b2', 'share-user-b2');
    const myFamily = await callFamily(a.openidA, 'getMyFamily');
    const joinRes = await callFamily('share-openid-b2', 'joinFamily', {
      inviteCode: myFamily.data.family.inviteCode,
    });
    checkEqual('B 加入家庭成功', joinRes.success, true);

    await callIngredient(a.openidA, 'createIngredient', { familyId: a.familyId, input: VALID_INPUT });

    const asB = await callIngredient('share-openid-b2', 'listIngredients', { familyId: a.familyId });
    checkEqual('普通成员能读取家庭库存', asB.success, true);
    checkEqual('普通成员看到同一份库存', asB.data.length, 1);

    // 普通成员也可以添加（本阶段不限制成员写库存）
    const addByB = await callIngredient('share-openid-b2', 'createIngredient', {
      familyId: a.familyId,
      input: { name: '番茄', quantity: 2, unit: '个', category: 'vegetable' },
    });
    checkEqual('普通成员可以添加食材', addByB.success, true);
    checkEqual('添加后家庭库存为 2', ingredientsOf(a.familyId).length, 2);
  }

  /* ---------- Phase B：购买日 + 保质天数自动推导到期日 ---------- */
  section('Phase B：保质期字段与自动到期日');
  resetStore();
  {
    const a = await setupFamily('shelf');

    const auto = await callIngredient(a.openidA, 'createIngredient', {
      familyId: a.familyId,
      input: {
        name: '牛奶',
        quantity: 2,
        unit: '盒',
        category: 'dairy',
        purchaseDate: '2026-01-01',
        shelfLifeDays: 7,
      },
    });
    checkEqual('购买日 + 保质天数创建成功', auto.success, true);
    checkEqual('自动推导到期日为 2026-01-08', auto.data.expireDate, '2026-01-08');
    checkEqual('购买日已落库', auto.data.purchaseDate, '2026-01-01');
    checkEqual('保质天数已落库', auto.data.shelfLifeDays, 7);

    // 跨月
    const crossMonth = await callIngredient(a.openidA, 'createIngredient', {
      familyId: a.familyId,
      input: {
        name: '豆腐',
        quantity: 1,
        unit: '盒',
        category: 'soy_product',
        purchaseDate: '2026-01-28',
        shelfLifeDays: 5,
      },
    });
    checkEqual('跨月推导 2026-02-02', crossMonth.data.expireDate, '2026-02-02');

    // 跨年
    const crossYear = await callIngredient(a.openidA, 'createIngredient', {
      familyId: a.familyId,
      input: {
        name: '速冻饺子',
        quantity: 1,
        unit: '袋',
        category: 'staple',
        purchaseDate: '2026-12-30',
        shelfLifeDays: 5,
      },
    });
    checkEqual('跨年推导 2027-01-04', crossYear.data.expireDate, '2027-01-04');

    // 保质天数 0 表示当天到期，不能被当成「未填」
    const sameDay = await callIngredient(a.openidA, 'createIngredient', {
      familyId: a.familyId,
      input: {
        name: '鲜面条',
        quantity: 1,
        unit: '袋',
        category: 'staple',
        purchaseDate: '2026-03-05',
        shelfLifeDays: 0,
      },
    });
    checkEqual('保质 0 天 → 当天到期', sameDay.data.expireDate, '2026-03-05');
    checkEqual('保质 0 天已落库（非 null）', sameDay.data.shelfLifeDays, 0);

    // 显式到期日优先于自动推导
    const explicit = await callIngredient(a.openidA, 'createIngredient', {
      familyId: a.familyId,
      input: {
        name: '酸奶',
        quantity: 4,
        unit: '盒',
        category: 'dairy',
        purchaseDate: '2026-01-01',
        shelfLifeDays: 7,
        expireDate: '2026-02-01',
      },
    });
    checkEqual('显式到期日优先', explicit.data.expireDate, '2026-02-01');

    // 只给购买日、不给天数：无法推导，到期日应为空
    const noDays = await callIngredient(a.openidA, 'createIngredient', {
      familyId: a.familyId,
      input: {
        name: '苹果',
        quantity: 3,
        unit: '个',
        category: 'fruit',
        purchaseDate: '2026-01-01',
      },
    });
    checkEqual('只给购买日时到期日为空', noDays.data.expireDate, null);
    checkEqual('只给购买日时保质天数为空', noDays.data.shelfLifeDays, null);

    // 完全不给：保持旧行为
    const legacy = await callIngredient(a.openidA, 'createIngredient', {
      familyId: a.familyId,
      input: VALID_INPUT,
    });
    checkEqual('不填保质字段时到期日为空', legacy.data.expireDate, null);
    checkEqual('不填保质字段时购买日为空', legacy.data.purchaseDate, null);
  }

  /* ---------- Phase B：非法保质字段被拒绝 ---------- */
  section('Phase B：非法保质字段校验');
  resetStore();
  {
    const a = await setupFamily('shelfbad');

    const negative = await callIngredient(a.openidA, 'createIngredient', {
      familyId: a.familyId,
      input: {
        name: '牛奶',
        quantity: 1,
        unit: '盒',
        category: 'dairy',
        purchaseDate: '2026-01-01',
        shelfLifeDays: -1,
      },
    });
    checkEqual('负数保质天数被拒绝', negative.success, false);
    checkEqual('负数保质天数错误码', negative.code, 'INVALID_PARAMS');

    const fractional = await callIngredient(a.openidA, 'createIngredient', {
      familyId: a.familyId,
      input: {
        name: '牛奶',
        quantity: 1,
        unit: '盒',
        category: 'dairy',
        shelfLifeDays: 1.5,
      },
    });
    checkEqual('非整数保质天数被拒绝', fractional.success, false);

    const tooLarge = await callIngredient(a.openidA, 'createIngredient', {
      familyId: a.familyId,
      input: {
        name: '牛奶',
        quantity: 1,
        unit: '盒',
        category: 'dairy',
        shelfLifeDays: 3651,
      },
    });
    checkEqual('超大保质天数被拒绝', tooLarge.success, false);

    const badDate = await callIngredient(a.openidA, 'createIngredient', {
      familyId: a.familyId,
      input: {
        name: '牛奶',
        quantity: 1,
        unit: '盒',
        category: 'dairy',
        purchaseDate: '2026-02-30',
      },
    });
    checkEqual('不存在的购买日被拒绝', badDate.success, false);

    checkEqual('非法入参未落库', ingredientsOf(a.familyId).length, 0);
  }

  /* ---------- Phase B：修改时同样推导到期日 ---------- */
  section('Phase B：修改食材时重算到期日');
  resetStore();
  {
    const a = await setupFamily('shelfupdate');

    const created = await callIngredient(a.openidA, 'createIngredient', {
      familyId: a.familyId,
      input: {
        name: '牛奶',
        quantity: 1,
        unit: '盒',
        category: 'dairy',
        purchaseDate: '2026-01-01',
        shelfLifeDays: 3,
      },
    });
    checkEqual('初始到期日 2026-01-04', created.data.expireDate, '2026-01-04');

    const updated = await callIngredient(a.openidA, 'updateIngredient', {
      familyId: a.familyId,
      id: created.data._id,
      input: {
        name: '牛奶',
        quantity: 1,
        unit: '盒',
        category: 'dairy',
        purchaseDate: '2026-01-01',
        shelfLifeDays: 10,
      },
    });
    checkEqual('修改后到期日重算为 2026-01-11', updated.data.expireDate, '2026-01-11');

    const cleared = await callIngredient(a.openidA, 'updateIngredient', {
      familyId: a.familyId,
      id: created.data._id,
      input: {
        name: '牛奶',
        quantity: 1,
        unit: '盒',
        category: 'dairy',
      },
    });
    checkEqual('清空保质字段后到期日为空', cleared.data.expireDate, null);
  }

  /* ---------- Phase B：前端纯函数（临期计算 + 分类分组） ---------- */
  section('Phase B：前端临期计算与分类分组纯函数');
  {
    const lib = loadFrontendUtils();

    if (lib.error) {
      check('前端纯函数模块可编译加载', false, lib.error);
    } else {
      check('前端纯函数模块可编译加载', true);

      const shelf = lib.shelfLife;
      const group = lib.ingredientGroup;
      const today = new Date(2026, 0, 10, 12, 0, 0); // 本地时间 2026-01-10

      checkEqual('SHELF_LIFE_WARNING_DAYS = 3', shelf.SHELF_LIFE_WARNING_DAYS, 3);
      checkEqual('daysUntil 明天 = 1', shelf.daysUntil('2026-01-11', today), 1);
      checkEqual('daysUntil 今天 = 0', shelf.daysUntil('2026-01-10', today), 0);
      checkEqual('daysUntil 昨天 = -1', shelf.daysUntil('2026-01-09', today), -1);
      checkEqual('daysUntil 跨月 = 22', shelf.daysUntil('2026-02-01', today), 22);

      checkEqual('昨天到期 → expired', shelf.getShelfLifeStatus('2026-01-09', today).status, 'expired');
      checkEqual('过期文案带天数', shelf.getShelfLifeStatus('2026-01-09', today).label, '已过期 1 天');
      checkEqual('今天到期 → warning', shelf.getShelfLifeStatus('2026-01-10', today).status, 'warning');
      checkEqual('今天到期文案', shelf.getShelfLifeStatus('2026-01-10', today).label, '今天到期');
      checkEqual('3 天后到期 → warning', shelf.getShelfLifeStatus('2026-01-13', today).status, 'warning');
      checkEqual('4 天后到期 → fresh', shelf.getShelfLifeStatus('2026-01-14', today).status, 'fresh');
      checkEqual('无到期日 → unknown', shelf.getShelfLifeStatus(null, today).status, 'unknown');
      checkEqual('非法日期 → unknown', shelf.getShelfLifeStatus('2026-02-30', today).status, 'unknown');
      checkEqual('isExpired 昨天 = true', shelf.isExpired('2026-01-09', today), true);
      checkEqual('isExpired 今天 = false', shelf.isExpired('2026-01-10', today), false);
      checkEqual('isExpired 空值 = false', shelf.isExpired(null, today), false);

      const sample = [
        {
          _id: 'g1',
          name: '西红柿',
          standardName: '番茄',
          quantity: 3,
          unit: '个',
          category: 'vegetable',
          expireDate: '2026-01-20',
          purchaseDate: '2026-01-01',
          shelfLifeDays: 19,
          remark: '',
        },
        {
          _id: 'g2',
          name: '菠菜',
          standardName: '菠菜',
          quantity: 1,
          unit: '袋',
          category: 'vegetable',
          expireDate: '2026-01-09',
          purchaseDate: null,
          shelfLifeDays: null,
          remark: '',
        },
        {
          _id: 'g3',
          name: '鸡蛋',
          standardName: '鸡蛋',
          quantity: 6,
          unit: '个',
          category: 'meat_egg',
          expireDate: null,
          purchaseDate: null,
          shelfLifeDays: null,
          remark: '',
        },
        {
          _id: 'g4',
          name: '未知物',
          standardName: '未知物',
          quantity: 1,
          unit: 'g',
          category: 'not_a_category',
          expireDate: '2026-01-11',
          purchaseDate: null,
          shelfLifeDays: null,
          remark: '',
        },
      ];

      const groups = group.buildCategoryGroups(sample, {}, today);
      checkEqual('分组数量 = 3（蔬菜/肉蛋/其他）', groups.length, 3);
      checkEqual('分组顺序第 1 个是蔬菜', groups[0].code, 'vegetable');
      checkEqual('未知分类归入其他', groups[2].code, 'other');
      checkEqual('蔬菜组含 2 项', groups[0].count, 2);
      checkEqual('蔬菜组临期+过期计数 = 1', groups[0].warningCount, 1);
      checkEqual('临期组在组内排最前', groups[0].items[0]._id, 'g2');
      checkEqual('过期项被标记', groups[0].items[0].isExpired, true);
      checkEqual('其他组含 1 项', groups[2].count, 1);
      checkEqual('其他组 1 天内到期 → 临期', groups[2].items[0].isWarning, true);

      const collapsed = group.buildCategoryGroups(sample, { vegetable: true }, today);
      checkEqual('折叠状态透传到分组', collapsed[0].collapsed, true);
      checkEqual('未指定分类默认展开', collapsed[1].collapsed, false);

      const view = group.toIngredientView(sample[0], today);
      checkEqual('别名文案带原始名', view.aliasText, '（西红柿）');
      checkEqual('数量文案', view.quantityText, '3 个');
      checkEqual('新鲜食材不标临期', view.isWarning, false);

      const sorted = group.sortByShelfLife([
        group.toIngredientView(sample[2], today), // unknown
        group.toIngredientView(sample[0], today), // fresh
        group.toIngredientView(sample[1], today), // expired
      ]);
      checkEqual('排序：过期最前', sorted[0]._id, 'g2');
      checkEqual('排序：新鲜居中', sorted[1]._id, 'g1');
      checkEqual('排序：无到期日最后', sorted[2]._id, 'g3');
    }
  }

  /* ---------- Phase B：推荐排除过期食材 ---------- */
  section('Phase B：推荐侧过期食材过滤');
  {
    checkEqual(
      '北京时间：UTC 00:30 已是当天',
      shelfFilter.todayInBeijing(Date.UTC(2026, 0, 10, 0, 30, 0)),
      '2026-01-10',
    );
    checkEqual(
      '北京时间：UTC 前一天 17:00 已跨日',
      shelfFilter.todayInBeijing(Date.UTC(2026, 0, 9, 17, 0, 0)),
      '2026-01-10',
    );
    checkEqual(
      '北京时间：UTC 前一天 15:59 仍属前一天',
      shelfFilter.todayInBeijing(Date.UTC(2026, 0, 9, 15, 59, 0)),
      '2026-01-09',
    );

    const today = '2026-01-10';
    checkEqual('昨天到期 → 已过期', shelfFilter.isExpiredIngredient({ expireDate: '2026-01-09' }, today), true);
    checkEqual('今天到期 → 未过期', shelfFilter.isExpiredIngredient({ expireDate: '2026-01-10' }, today), false);
    checkEqual('明天到期 → 未过期', shelfFilter.isExpiredIngredient({ expireDate: '2026-01-11' }, today), false);
    checkEqual('无到期日 → 未过期', shelfFilter.isExpiredIngredient({ expireDate: null }, today), false);

    const filtered = shelfFilter.filterExpired(
      [
        { standardName: '番茄', expireDate: '2026-01-20' },
        { standardName: '菠菜', expireDate: '2026-01-01' },
        { standardName: '鸡蛋', expireDate: null },
        { standardName: '牛奶', expireDate: '2026-01-10' },
      ],
      today,
    );
    checkEqual('过滤后保留 3 项', filtered.kept.length, 3);
    checkEqual('被排除 1 项', filtered.skipped, 1);
    checkEqual(
      '过期食材不在保留名单中',
      filtered.kept.map((item) => item.standardName).indexOf('菠菜'),
      -1,
    );
    checkEqual('当天到期仍参与推荐', filtered.kept[2].standardName, '牛奶');
    checkEqual('空输入不报错', shelfFilter.filterExpired(null, today).kept.length, 0);
  }
}

/* ============================== 入口 ============================== */

(async function main() {
  console.log('Phase 4 食材库存 · 验证开始');

  runStructureChecks();
  await runBehaviorTests();

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
