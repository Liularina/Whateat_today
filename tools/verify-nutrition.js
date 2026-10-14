/**
 * 营养计算 · 静态结构与云函数行为验证（Phase 5）
 *
 * 运行：npm run verify:nutrition          （完整输出）
 *       npm run verify:nutrition -- --quiet（只输出小节标题、失败项与总计）
 *
 * 用内存版 wx-server-sdk（tools/mock-cloud.js）替换真实云开发，直接驱动
 * cloudfunctions/nutrition/index.js 与 cloudfunctions/family/index.js，
 * 覆盖规范第 5 章的验收流程。
 *
 * 本套件最重要的两条：
 *   1. 营养值只能由程序按 nutrition_facts 计算，客户端 / AI 传进来的值一律被丢弃；
 *   2. 缺数据的食材不编数值，返回 nutritionStatus = partial。
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
const nutritionFn = require(path.join(__dirname, '..', 'cloudfunctions', 'nutrition', 'index.js'));
const core = require(path.join(__dirname, '..', 'cloudfunctions', 'nutrition', 'nutrition-core.js'));
const data = require(path.join(__dirname, '..', 'cloudfunctions', 'nutrition', 'nutrition-data.js'));

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

async function callNutrition(openid, action, payload) {
  mock.setOpenid(openid);
  return nutritionFn.main(Object.assign({ action: action }, payload || {}));
}

/** 造一个家庭，返回 familyId 与 owner 身份 */
async function setupFamily(prefix) {
  const openidA = prefix + '-openid-a';
  const userA = prefix + '-user-a';
  seedUser(openidA, userA);
  const created = await callFamily(openidA, 'createFamily', { name: prefix + ' 的家' });
  return { familyId: created.data._id, openidA: openidA, userA: userA };
}

/* ============================== 静态结构检查 ============================== */

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, '');
}

/* -------- 捕获 nutrition 统一日志（顺带屏蔽 family 日志），用于验证可追溯性 -------- */

/** nutrition 云函数的统一日志 */
const nutritionLogs = [];
const rawConsoleLog = console.log.bind(console);
console.log = function (...args) {
  const first = args[0];
  if (typeof first === 'string' && first.indexOf('"functionName":"family"') !== -1) {
    return;
  }
  if (typeof first === 'string' && first.indexOf('"functionName":"nutrition"') !== -1) {
    nutritionLogs.push(first);
    return; // 统一日志已捕获，不再刷屏
  }
  rawConsoleLog(...args);
};

function lastNutritionLog() {
  const raw = nutritionLogs[nutritionLogs.length - 1];
  return raw ? JSON.parse(raw) : null;
}

function runStructureChecks() {
  section('静态结构检查');

  const root = path.join(__dirname, '..');
  const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
  const appJson = JSON.parse(read('miniprogram', 'app.json'));

  // 1. 营养页已注册，且四个文件齐全
  check('app.json 已注册 pages/nutrition/index', appJson.pages.indexOf('pages/nutrition/index') !== -1);
  const missingFiles = [];
  for (const ext of ['.ts', '.wxml', '.json', '.wxss']) {
    const file = path.join(root, 'miniprogram', 'pages', 'nutrition', 'index' + ext);
    if (!fs.existsSync(file)) missingFiles.push('index' + ext);
  }
  check('营养页 .ts/.wxml/.json/.wxss 齐全', missingFiles.length === 0, missingFiles.join(','));

  // 2. TabBar 未被破坏
  checkEqual('TabBar 仍为 5 个标签', appJson.tabBar.list.length, 5);

  // 3. 云函数三个文件齐全
  const fnMissing = [];
  for (const name of ['index.js', 'nutrition-core.js', 'nutrition-data.js']) {
    if (!fs.existsSync(path.join(root, 'cloudfunctions', 'nutrition', name))) fnMissing.push(name);
  }
  check('nutrition 云函数含 index / core / data', fnMissing.length === 0, fnMissing.join(','));

  // 4. service 只暴露 calculate，且调用云函数的 calculateNutrition
  const serviceSource = read('miniprogram', 'services', 'nutrition.ts');
  check('nutrition service 提供 calculate', /\bcalculate\s*\(/.test(serviceSource));
  check("service 调用 action 'calculateNutrition'", serviceSource.indexOf('calculateNutrition') !== -1);
  check("service 调用云函数 'nutrition'", /['"]nutrition['"]/.test(serviceSource));

  // 5. 页面不直接调用 wx.cloud.callFunction
  const pageSource = read('miniprogram', 'pages', 'nutrition', 'index.ts');
  const pageWxml = read('miniprogram', 'pages', 'nutrition', 'index.wxml');
  check('营养页未直接调用 wx.cloud.callFunction', pageSource.indexOf('wx.cloud.callFunction') === -1);

  // 6. 页面组件接线
  const pageJson = JSON.parse(read('miniprogram', 'pages', 'nutrition', 'index.json'));
  check(
    '营养页注册了 nutrition-card / empty-state / error-state / loading-state',
    ['nutrition-card', 'empty-state', 'error-state', 'loading-state'].every(
      (name) => Boolean(pageJson.usingComponents[name]),
    ),
  );
  check('页面使用 nutrition-card 展示总量与人均', pageWxml.indexOf('nutrition-card') !== -1);
  check(
    '页面把 total 与 perPerson 都传给卡片',
    pageWxml.indexOf('total="{{total}}"') !== -1 && pageWxml.indexOf('perPerson="{{perPerson}}"') !== -1,
  );

  // 7. 人数选择与人均展示
  check('页面提供人数选择', pageWxml.indexOf('peopleLabels') !== -1 && pageWxml.indexOf('onPeopleChange') !== -1);

  // 8. 缺失数据提示使用规范指定文案
  const configSource = read('miniprogram', 'constants', 'config.ts');
  check('config 定义了 NUTRITION_PARTIAL_MESSAGE', configSource.indexOf('NUTRITION_PARTIAL_MESSAGE') !== -1);
  check(
    '缺失提示文案为「部分营养数据缺失，仅供参考。」',
    configSource.indexOf('部分营养数据缺失，仅供参考。') !== -1,
  );
  check('页面展示 partialMessage', pageWxml.indexOf('{{partialMessage}}') !== -1);

  // 9. 免责声明：常量文案与组件接线
  check(
    '免责声明常量为「营养数据为估算值，仅供饮食参考。」',
    configSource.indexOf('营养数据为估算值，仅供饮食参考。') !== -1,
  );
  const cardTs = read('miniprogram', 'components', 'nutrition-card', 'index.ts');
  const cardWxml = read('miniprogram', 'components', 'nutrition-card', 'index.wxml');
  check('nutrition-card 默认免责声明取自全局常量', cardTs.indexOf('NUTRITION_DISCLAIMER') !== -1);
  check('nutrition-card 渲染 disclaimer 与 perPerson', cardWxml.indexOf('{{disclaimer}}') !== -1 && cardWxml.indexOf('perPerson.calories') !== -1);

  // 10. 热量统一展示为「约 XXX kcal」
  check('KCAL_PREFIX 为「约」', /KCAL_PREFIX\s*=\s*'约'/.test(configSource));
  const formatterSource = read('miniprogram', 'utils', 'formatter.ts');
  check('formatKcal 使用 KCAL_PREFIX', formatterSource.indexOf('KCAL_PREFIX') !== -1);

  // 11. 页面不自己算营养：只能通过 service 拿结果（先剔注释，避免说明文字被误判）
  const pageCode = stripComments(pageSource);
  check('页面未直接读写 nutrition_facts 集合', pageCode.indexOf('nutrition_facts') === -1);
  check('页面未做 /100 之类的营养换算', !/\/\s*100\b/.test(pageCode));

  // 12. 复用既有类型，不另立字段名
  const nutritionType = read('miniprogram', 'types', 'nutrition.ts');
  check(
    'NutritionResult 复用 NutritionSummary',
    nutritionType.indexOf('NutritionSummary') !== -1 && nutritionType.indexOf('perPerson: NutritionSummary') !== -1,
  );
  const ingredientType = read('miniprogram', 'types', 'ingredient.ts');
  check(
    'nutrition_facts 类型仍为 standardName / per100g / edibleRate / averageWeight',
    ['standardName', 'per100g', 'edibleRate', 'averageWeight'].every(
      (field) => ingredientType.indexOf(field) !== -1,
    ),
  );

  // 13. §规范：AI 不得作为营养数据来源 —— 云函数没有任何 LLM / 外部网络调用
  const fnSource = read('cloudfunctions', 'nutrition', 'index.js');
  check(
    'nutrition 云函数无 LLM / 外部网络调用',
    /require\(['"](axios|node-fetch|request|https?)['"]\)|fetch\(|openai|anthropic/i.test(fnSource) === false,
  );
  check('云函数注释明确 AI 结果不参与计算', fnSource.indexOf('AI') !== -1 && fnSource.indexOf('程序') !== -1);

  // 14. 家庭权限是服务端强制的
  check('云函数实现了 requireFamilyMember 家庭权限校验', fnSource.indexOf('requireFamilyMember') !== -1);
  check('身份只取 cloud.getWXContext().OPENID', fnSource.indexOf('getWXContext()') !== -1 && fnSource.indexOf('.OPENID') !== -1);

  // 15. 入参白名单：只取 name / amount / unit
  const coreSource = read('cloudfunctions', 'nutrition', 'nutrition-core.js');
  check(
    'core 只从入参取 name / amount / unit',
    /source\.name/.test(coreSource) && /source\.amount/.test(coreSource) && /source\.unit/.test(coreSource),
  );
  check('core 不读取入参里的 calories / nutrition', coreSource.indexOf('source.calories') === -1 && coreSource.indexOf('source.nutrition') === -1);
  check('kg → g 换算是 ×1000', /amount \* 1000/.test(coreSource));
  check('缺 averageWeight 时不猜测换算', /Number\.isFinite\(averageWeight\)/.test(coreSource) && /return null/.test(coreSource));
  check('计算含可食比例 edibleRate', coreSource.indexOf('edibleRate') !== -1);
  check('公式为 克数 ÷ 100 × 每100g值', /\/ 100/.test(coreSource));

  // 16. 本阶段不做医疗 / 减肥 / 疾病 / 每日每周营养分析
  const forbidden = /每日营养|一周营养|周报|减肥方案|疾病营养方案|营养师|医疗建议|热量缺口|增肌|减脂/i;
  const scanned = stripComments(fnSource) + stripComments(pageSource) + stripComments(pageWxml);
  const hit = scanned.match(forbidden);
  check('未实现医疗 / 减肥 / 疾病 / 每日每周营养分析', hit === null, hit ? hit[0] : '');

  // 17. 云函数语法可解析
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
  check('全部云函数语法检查通过', badSyntax.length === 0, badSyntax.join(','));

  // 18. 前端 TS 未读取 openid
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

  // 19. 基础数据覆盖度与字段完整性
  check('内置营养数据不少于 50 条', data.BUILTIN_NUTRITION_FACTS.length >= 50, String(data.BUILTIN_NUTRITION_FACTS.length));
  const badRows = data.BUILTIN_NUTRITION_FACTS.filter(
    (row) =>
      !row.standardName ||
      !row.per100g ||
      typeof row.per100g.calories !== 'number' ||
      typeof row.per100g.protein !== 'number' ||
      typeof row.per100g.fat !== 'number' ||
      typeof row.per100g.carbohydrate !== 'number' ||
      typeof row.edibleRate !== 'number' ||
      (row.averageWeight !== null && typeof row.averageWeight !== 'number'),
  );
  check('基础数据字段完整', badRows.length === 0, badRows.map((row) => row.standardName).join(','));
  check(
    '缺少单个重量的食材 averageWeight 为 null（不编造）',
    data.BUILTIN_NUTRITION_FACTS.filter((row) => row.averageWeight === null).length > 0,
  );
  const veg = data.BUILTIN_NUTRITION_FACTS.filter((row) => ['番茄', '鸡蛋', '猪肉', '大米', '牛奶', '土豆'].indexOf(row.standardName) !== -1);
  check('覆盖常见食材（番茄 / 鸡蛋 / 猪肉 / 大米 / 牛奶 / 土豆）', veg.length === 6);
}

/* ============================== 纯函数：单位换算 ============================== */

function runUnitTests() {
  section('单位换算：g / kg / 个·袋·盒（缺重量不猜）');

  checkEqual('g 直接取原值', core.toGram(300, 'g', null), 300);
  checkEqual('kg 换算为克（×1000）', core.toGram(0.5, 'kg', null), 500);
  checkEqual('个 有平均重量时换算', core.toGram(2, '个', 50), 100);
  checkEqual('袋 有平均重量时换算', core.toGram(1, '袋', 250), 250);
  checkEqual('盒 有平均重量时换算', core.toGram(3, '盒', 200), 600);
  checkEqual('个 缺平均重量 → 不换算（null）', core.toGram(2, '个', null), null);
  checkEqual('袋 缺平均重量 → 不换算（null）', core.toGram(1, '袋', null), null);
  checkEqual('盒 缺平均重量 → 不换算（null）', core.toGram(1, '盒', undefined), null);
  checkEqual('平均重量为 0 视为未知', core.toGram(1, '个', 0), null);
  checkEqual('数量为 0 → null', core.toGram(0, 'g', null), null);
  checkEqual('数量为负 → null', core.toGram(-1, 'g', null), null);
  checkEqual('非法单位 → null', core.toGram(1, '斤', null), null);
}

/* ============================== 行为测试 ============================== */

async function runBehaviorTests() {
  /* ---------- 验收主流程：输入食材 → 程序算出基础营养 → 总量 → 人均 ---------- */
  section('验收流程：番茄 300g + 鸡蛋 2 个，3 人吃');
  resetStore();
  {
    const a = await setupFamily('acc');

    const res = await callNutrition(a.openidA, 'calculateNutrition', {
      ingredients: [
        { name: '番茄', amount: 300, unit: 'g' },
        { name: '鸡蛋', amount: 2, unit: '个' },
      ],
      peopleCount: 3,
    });

    check('计算成功', res.success === true, res.message);

    // 番茄：300g ÷ 100 × 15 = 45 kcal；蛋白质 3 × 0.9 = 2.7；脂肪 3 × 0.2 = 0.6；碳水 3 × 3.3 = 9.9
    const tomato = res.data.items[0];
    checkEqual('番茄可食克数 300', tomato.grams, 300);
    checkEqual('番茄热量 45 kcal', tomato.nutrition.calories, 45);
    checkEqual('番茄蛋白质 2.7 g', tomato.nutrition.protein, 2.7);

    // 鸡蛋：2 个 × 50g × 0.88 = 88g 可食 → 88 ÷ 100 × 144 = 126.72 → 126.7 kcal
    const egg = res.data.items[1];
    checkEqual('鸡蛋按「个数 × 平均重量 × 可食比例」= 88 g', egg.grams, 88);
    checkEqual('鸡蛋热量 126.7 kcal', egg.nutrition.calories, 126.7);
    checkEqual('鸡蛋蛋白质 11.7 g', egg.nutrition.protein, 11.7);

    // 合约：items 与入参顺序一一对应、长度一致
    // （食材列表页就是靠这个位置对齐把热量挂回每一条食材的）
    checkEqual('items 长度与入参一致', res.data.items.length, 2);
    checkEqual('items[0] 对应入参第 1 项', res.data.items[0].name, '番茄');
    checkEqual('items[1] 对应入参第 2 项', res.data.items[1].name, '鸡蛋');
    checkEqual('items 回显 amount / unit', res.data.items[1].amount + res.data.items[1].unit, '2个');

    // 总量 = 45 + 126.72
    checkEqual('总量热量 172 kcal', res.data.calories, 172);
    checkEqual('总量蛋白质 14.4 g', res.data.protein, 14.4);
    checkEqual('总量脂肪 8.3 g', res.data.fat, 8.3);
    checkEqual('总量碳水 12.4 g', res.data.carbohydrate, 12.4);

    // 人均 = 总量 ÷ 3
    checkEqual('人均热量 57 kcal', res.data.perPerson.calories, 57);
    checkEqual('人均蛋白质 4.8 g', res.data.perPerson.protein, 4.8);
    checkEqual('人均脂肪 2.8 g', res.data.perPerson.fat, 2.8);
    checkEqual('人均碳水 4.1 g', res.data.perPerson.carbohydrate, 4.1);
    checkEqual('人数回显 3', res.data.peopleCount, 3);

    checkEqual('全部食材都能算 → complete', res.data.nutritionStatus, 'complete');
    checkEqual('缺失清单为空', res.data.missing.length, 0);
    checkEqual('无法换算清单为空', res.data.unconvertible.length, 0);
    checkEqual('参与计算食材数 2', res.data.computedCount, 2);
  }

  /* ---------- 人均 = 总量 ÷ 人数（换人数只影响人均） ---------- */
  section('人均：换了人数，总量不变、人均按比例变化');
  resetStore();
  {
    const a = await setupFamily('people');
    const payload = { ingredients: [{ name: '大米', amount: 200, unit: 'g' }] };

    const two = await callNutrition(a.openidA, 'calculateNutrition', Object.assign({ peopleCount: 2 }, payload));
    const four = await callNutrition(a.openidA, 'calculateNutrition', Object.assign({ peopleCount: 4 }, payload));

    // 大米 200g ÷ 100 × 346 = 692 kcal
    checkEqual('2 人时总量 692 kcal', two.data.calories, 692);
    checkEqual('4 人时总量仍是 692 kcal', four.data.calories, 692);
    checkEqual('2 人时人均 346 kcal', two.data.perPerson.calories, 346);
    checkEqual('4 人时人均 173 kcal', four.data.perPerson.calories, 173);

    const one = await callNutrition(a.openidA, 'calculateNutrition', Object.assign({ peopleCount: 1 }, payload));
    checkEqual('1 人时人均等于总量', one.data.perPerson.calories, one.data.calories);
    checkEqual('人均蛋白质 = 总量 ÷ 人数', one.data.perPerson.protein, one.data.protein);
  }

  /* ---------- 规范核心：客户端 / AI 传入的营养值一律被忽略 ---------- */
  section('规范核心：AI / 客户端传入的营养值不得作为结果');
  resetStore();
  {
    const a = await setupFamily('ignore');

    const clean = await callNutrition(a.openidA, 'calculateNutrition', {
      ingredients: [{ name: '番茄', amount: 300, unit: 'g' }],
      peopleCount: 2,
    });

    // 伪造：食材项里塞 calories / nutrition，顶层再塞一份汇总
    const forged = await callNutrition(a.openidA, 'calculateNutrition', {
      ingredients: [
        {
          name: '番茄',
          amount: 300,
          unit: 'g',
          calories: 99999,
          nutrition: { calories: 99999, protein: 8888, fat: 7777, carbohydrate: 6666 },
          per100g: { calories: 99999 },
        },
      ],
      peopleCount: 2,
      // 顶层伪造字段
      calories: 88888,
      protein: 88888,
      fat: 88888,
      carbohydrate: 88888,
      perPerson: { calories: 44444, protein: 44444, fat: 44444, carbohydrate: 44444 },
      nutritionStatus: 'complete',
      nutritionResult: { calories: 55555 },
    });

    check('伪造入参下仍然计算成功', forged.success === true, forged.message);
    checkEqual('热量取程序计算值 45，不取 99999 / 88888', forged.data.calories, 45);
    checkEqual('蛋白质取程序计算值 2.7', forged.data.protein, 2.7);
    checkEqual('脂肪取程序计算值 0.6', forged.data.fat, 0.6);
    checkEqual('碳水取程序计算值 9.9', forged.data.carbohydrate, 9.9);
    checkEqual('人均热量 23 kcal（45 ÷ 2）', forged.data.perPerson.calories, 23);
    check('人均热量不等于伪造的 44444', forged.data.perPerson.calories !== 44444);
    checkEqual('逐项热量也是程序值 45', forged.data.items[0].nutrition.calories, 45);
    checkEqual('nutritionStatus 由程序判定', forged.data.nutritionStatus, 'complete');

    checkEqual(
      '带伪造字段与不带的结果完全一致',
      JSON.stringify(forged.data),
      JSON.stringify(clean.data),
    );
  }

  /* ---------- 缺失食材：不编数值，partial ---------- */
  section('缺失食材：不编数值，返回 partial');
  resetStore();
  {
    const a = await setupFamily('missing');

    const res = await callNutrition(a.openidA, 'calculateNutrition', {
      ingredients: [
        { name: '番茄', amount: 100, unit: 'g' },
        { name: '龙肝凤髓', amount: 200, unit: 'g' },
      ],
      peopleCount: 1,
    });

    check('计算成功（缺失不报错，只是不完整）', res.success === true, res.message);
    checkEqual('nutritionStatus = partial', res.data.nutritionStatus, 'partial');
    checkEqual('缺失清单含该食材', res.data.missing.join(','), '龙肝凤髓');
    checkEqual('无法换算清单为空', res.data.unconvertible.length, 0);

    const unknown = res.data.items[1];
    checkEqual('缺失项 status = missing', unknown.status, 'missing');
    checkEqual('缺失项 nutrition 为 null（绝不编数值）', unknown.nutrition, null);
    checkEqual('缺失项 grams 为 null', unknown.grams, null);

    // 已知食材照常计入
    checkEqual('番茄照常计入 15 kcal', res.data.items[0].nutrition.calories, 15);
    checkEqual('参与计算食材数为 1', res.data.computedCount, 1);
    checkEqual('总量只含番茄 15 kcal', res.data.calories, 15);
  }

  /* ---------- 单位无法换算：不猜，partial ---------- */
  section('单位无法换算：缺 averageWeight 时不猜，返回 partial');
  resetStore();
  {
    const a = await setupFamily('unconv');

    // 猪肉在基础数据里 averageWeight = null，「1 个」无法换算
    const res = await callNutrition(a.openidA, 'calculateNutrition', {
      ingredients: [
        { name: '猪肉', amount: 1, unit: '个' },
        { name: '番茄', amount: 100, unit: 'g' },
      ],
      peopleCount: 1,
    });

    check('计算成功', res.success === true, res.message);
    checkEqual('nutritionStatus = partial', res.data.nutritionStatus, 'partial');
    checkEqual('无法换算清单含猪肉', res.data.unconvertible.join(','), '猪肉');
    checkEqual('缺失清单为空（食材有数据，只是单位换算不了）', res.data.missing.length, 0);

    const pork = res.data.items[0];
    checkEqual('无法换算项 status = unconvertible', pork.status, 'unconvertible');
    checkEqual('无法换算项 nutrition 为 null', pork.nutrition, null);
    checkEqual('无法换算项 grams 为 null', pork.grams, null);

    checkEqual('番茄照常计入', res.data.calories, 15);
    checkEqual('参与计算食材数为 1', res.data.computedCount, 1);

    // 同一食材换成 g 就能算
    const byGram = await callNutrition(a.openidA, 'calculateNutrition', {
      ingredients: [{ name: '猪肉', amount: 500, unit: 'g' }],
      peopleCount: 1,
    });
    checkEqual('猪肉 500g 可正常计算 1975 kcal', byGram.data.calories, 1975);
    checkEqual('换成 g 后 status = complete', byGram.data.nutritionStatus, 'complete');
  }

  /* ---------- 两种问题同时存在 ---------- */
  section('同时存在缺失与无法换算时，两个清单都要给全');
  resetStore();
  {
    const a = await setupFamily('both');
    const res = await callNutrition(a.openidA, 'calculateNutrition', {
      ingredients: [
        { name: '不存在的食材', amount: 100, unit: 'g' },
        { name: '猪肉', amount: 1, unit: '个' },
        { name: '番茄', amount: 100, unit: 'g' },
      ],
      peopleCount: 2,
    });

    checkEqual('nutritionStatus = partial', res.data.nutritionStatus, 'partial');
    checkEqual('missing 只有 1 项', res.data.missing.length, 1);
    checkEqual('unconvertible 只有 1 项', res.data.unconvertible.length, 1);
    checkEqual('只有番茄计入', res.data.computedCount, 1);
    checkEqual('items 仍然逐个回传 3 项', res.data.items.length, 3);
    checkEqual('items 顺序与入参一致', res.data.items.map((item) => item.status).join(','), 'missing,unconvertible,ok');
  }

  /* ---------- nutrition_facts 覆盖内置数据 ---------- */
  section('nutrition_facts：数据库记录覆盖内置基础数据');
  resetStore();
  {
    const a = await setupFamily('override');

    const before = await callNutrition(a.openidA, 'calculateNutrition', {
      ingredients: [{ name: '番茄', amount: 100, unit: 'g' }],
      peopleCount: 1,
    });
    checkEqual('覆盖前用内置值 15 kcal', before.data.calories, 15);

    // 控制台改过数据后，以数据库为准
    store.nutrition_facts.push({
      _id: 'fact-tomato',
      standardName: '番茄',
      per100g: { calories: 100, protein: 10, fat: 5, carbohydrate: 2 },
      edibleRate: 0.5,
      averageWeight: null,
      source: 'external',
    });

    const after = await callNutrition(a.openidA, 'calculateNutrition', {
      ingredients: [{ name: '番茄', amount: 100, unit: 'g' }],
      peopleCount: 1,
    });
    // 100g × 0.5 可食 = 50g → 50 ÷ 100 × 100 = 50 kcal
    checkEqual('覆盖后按数据库值计算 50 kcal', after.data.calories, 50);
    checkEqual('覆盖后可食克数为 50', after.data.items[0].grams, 50);

    // 数据库里多出的食材也能算
    store.nutrition_facts.push({
      _id: 'fact-durian',
      standardName: '榴莲',
      per100g: { calories: 147, protein: 2.6, fat: 3.3, carbohydrate: 28.3 },
      edibleRate: 1,
      averageWeight: null,
      source: 'external',
    });
    const durian = await callNutrition(a.openidA, 'calculateNutrition', {
      ingredients: [{ name: '榴莲', amount: 200, unit: 'g' }],
      peopleCount: 1,
    });
    checkEqual('数据库新增食材可参与计算', durian.data.calories, 294);
    checkEqual('不因覆盖而丢失其他内置食材', durian.data.nutritionStatus, 'complete');
  }

  /* ---------- 集合缺失时退回内置数据 ---------- */
  section('nutrition_facts 集合缺失时退回内置基础数据');
  resetStore();
  {
    const a = await setupFamily('nofacts');
    setMissingCollections(['nutrition_facts']);

    const res = await callNutrition(a.openidA, 'calculateNutrition', {
      ingredients: [{ name: '番茄', amount: 300, unit: 'g' }],
      peopleCount: 1,
    });
    check('集合缺失不影响计算', res.success === true, res.message);
    checkEqual('仍用内置数据算出 45 kcal', res.data.calories, 45);

    setMissingCollections([]);
  }

  /* ---------- seedNutritionFacts ---------- */
  section('seedNutritionFacts：基础数据可重复写入');
  resetStore();
  {
    const a = await setupFamily('seed');
    const total = data.BUILTIN_NUTRITION_FACTS.length;

    const first = await callNutrition(a.openidA, 'seedNutritionFacts', {});
    check('首次写入成功', first.success === true, first.message);
    checkEqual('首次全部为新增', first.data.inserted, total);
    checkEqual('首次没有更新', first.data.updated, 0);
    checkEqual('nutrition_facts 落库条数正确', store.nutrition_facts.length, total);

    const second = await callNutrition(a.openidA, 'seedNutritionFacts', {});
    check('重复写入成功', second.success === true, second.message);
    checkEqual('重复执行不新增', second.data.inserted, 0);
    checkEqual('重复执行全部为更新', second.data.updated, total);
    checkEqual('不会写重复数据', store.nutrition_facts.length, total);

    const row = store.nutrition_facts.filter((item) => item.standardName === '鸡蛋')[0];
    check('落库字段齐全', Boolean(row && row.per100g && typeof row.edibleRate === 'number'));
    checkEqual('source 标记为 internal', row.source, 'internal');
    check(
      'averageWeight 为 null 时照实存 null',
      store.nutrition_facts.filter((item) => item.standardName === '猪肉')[0].averageWeight === null,
    );

    // 集合缺失时给出明确提示
    setMissingCollections(['nutrition_facts']);
    const noDb = await callNutrition(a.openidA, 'seedNutritionFacts', {});
    checkEqual('集合缺失 → DB_NOT_READY', noDb.code, 'DB_NOT_READY');
    check('提示去控制台建集合', /控制台/.test(noDb.message));
    setMissingCollections([]);
  }

  /* ---------- 鉴权 ---------- */
  section('鉴权：未登录 / 未注册 / 非家庭成员');
  resetStore();
  {
    const a = await setupFamily('guard');
    const payload = { ingredients: [{ name: '番茄', amount: 100, unit: 'g' }], peopleCount: 1 };

    const noLogin = await callNutrition('', 'calculateNutrition', payload);
    checkEqual('未登录被拒', noLogin.success, false);
    checkEqual('错误码 AUTH_REQUIRED', noLogin.code, 'AUTH_REQUIRED');

    const stranger = await callNutrition('stranger-openid', 'calculateNutrition', payload);
    checkEqual('未注册用户被拒', stranger.success, false);
    checkEqual('错误码 UNAUTHORIZED', stranger.code, 'UNAUTHORIZED');

    // 不传 familyId 的纯计算请求：登录即可
    const pure = await callNutrition(a.openidA, 'calculateNutrition', payload);
    checkEqual('不传 familyId 时登录即可计算', pure.success, true);

    // 传了 familyId：必须是该家庭成员
    const owner = await callNutrition(a.openidA, 'calculateNutrition', Object.assign({ familyId: a.familyId }, payload));
    checkEqual('家庭成员带 familyId 计算成功', owner.success, true);

    seedUser('guard-openid-b', 'guard-user-b');
    const outsider = await callNutrition('guard-openid-b', 'calculateNutrition', Object.assign({ familyId: a.familyId }, payload));
    checkEqual('非成员带他人 familyId 被拒', outsider.success, false);
    checkEqual('错误码 PERMISSION_DENIED', outsider.code, 'PERMISSION_DENIED');

    // 越权尝试可追溯
    const log = lastNutritionLog();
    checkEqual('日志记录发起者 userId', log.userId, 'guard-user-b');
    checkEqual('日志记录目标 familyId', log.familyId, a.familyId);
    checkEqual('日志状态 fail', log.status, 'fail');
  }

  /* ---------- 入参校验 ---------- */
  section('入参校验：服务端独立校验，不信任前端');
  resetStore();
  {
    const a = await setupFamily('valid');

    const badCases = [
      { label: 'ingredients 不是数组', event: { ingredients: '番茄', peopleCount: 2 } },
      { label: '缺少 ingredients', event: { peopleCount: 2 } },
      { label: '食材项不是对象', event: { ingredients: ['番茄'], peopleCount: 2 } },
      { label: '名称为空', event: { ingredients: [{ name: '  ', amount: 1, unit: 'g' }], peopleCount: 2 } },
      { label: '数量为 0', event: { ingredients: [{ name: '番茄', amount: 0, unit: 'g' }], peopleCount: 2 } },
      { label: '数量为负', event: { ingredients: [{ name: '番茄', amount: -3, unit: 'g' }], peopleCount: 2 } },
      { label: '数量非数字', event: { ingredients: [{ name: '番茄', amount: 'abc', unit: 'g' }], peopleCount: 2 } },
      { label: '数量超上限', event: { ingredients: [{ name: '番茄', amount: 100000, unit: 'g' }], peopleCount: 2 } },
      { label: '单位非法', event: { ingredients: [{ name: '番茄', amount: 1, unit: '斤' }], peopleCount: 2 } },
      { label: '单位缺失', event: { ingredients: [{ name: '番茄', amount: 1 }], peopleCount: 2 } },
      { label: '人数为 0', event: { ingredients: [{ name: '番茄', amount: 100, unit: 'g' }], peopleCount: 0 } },
      { label: '人数为负', event: { ingredients: [{ name: '番茄', amount: 100, unit: 'g' }], peopleCount: -2 } },
      { label: '人数为小数', event: { ingredients: [{ name: '番茄', amount: 100, unit: 'g' }], peopleCount: 2.5 } },
      { label: '人数超上限', event: { ingredients: [{ name: '番茄', amount: 100, unit: 'g' }], peopleCount: 21 } },
      { label: '人数非数字', event: { ingredients: [{ name: '番茄', amount: 100, unit: 'g' }], peopleCount: '两人' } },
      { label: '人数缺失', event: { ingredients: [{ name: '番茄', amount: 100, unit: 'g' }] } },
      {
        label: '食材条数超过 100',
        event: {
          ingredients: new Array(101).fill({ name: '番茄', amount: 100, unit: 'g' }),
          peopleCount: 2,
        },
      },
    ];

    for (const item of badCases) {
      const res = await callNutrition(a.openidA, 'calculateNutrition', item.event);
      checkEqual(item.label + ' → 被拒绝', res.success, false);
      checkEqual(item.label + ' → 错误码 INVALID_PARAMS', res.code, 'INVALID_PARAMS');
    }
  }

  /* ---------- 合法边界 ---------- */
  section('入参校验：合法边界可以计算');
  resetStore();
  {
    const a = await setupFamily('bound');

    const cases = [
      { label: '0.5 kg 小数数量', ingredients: [{ name: '大米', amount: 0.5, unit: 'kg' }], peopleCount: 1 },
      { label: '人数下限 1', ingredients: [{ name: '大米', amount: 100, unit: 'g' }], peopleCount: 1 },
      { label: '人数上限 20', ingredients: [{ name: '大米', amount: 100, unit: 'g' }], peopleCount: 20 },
      { label: '100 条食材', ingredients: new Array(100).fill({ name: '番茄', amount: 100, unit: 'g' }), peopleCount: 6 },
      { label: '空数组', ingredients: [], peopleCount: 2 },
    ];

    for (const item of cases) {
      const res = await callNutrition(a.openidA, 'calculateNutrition', {
        ingredients: item.ingredients,
        peopleCount: item.peopleCount,
      });
      check(item.label + ' → 计算成功', res.success === true, res.message);
    }

    const kg = await callNutrition(a.openidA, 'calculateNutrition', {
      ingredients: [{ name: '大米', amount: 0.5, unit: 'kg' }],
      peopleCount: 1,
    });
    checkEqual('0.5 kg = 500 g → 1730 kcal', kg.data.calories, 1730);

    const empty = await callNutrition(a.openidA, 'calculateNutrition', { ingredients: [], peopleCount: 2 });
    checkEqual('空数组总量为 0', empty.data.calories, 0);
    checkEqual('空数组人均为 0', empty.data.perPerson.calories, 0);
    checkEqual('空数组仍是 complete', empty.data.nutritionStatus, 'complete');
    checkEqual('空数组 items 为空', empty.data.items.length, 0);

    const max = await callNutrition(a.openidA, 'calculateNutrition', {
      ingredients: new Array(100).fill({ name: '番茄', amount: 100, unit: 'g' }),
      peopleCount: 6,
    });
    checkEqual('100 条食材全部计入', max.data.computedCount, 100);
    checkEqual('100 条番茄 = 1500 kcal', max.data.calories, 1500);
  }

  /* ---------- 未知 action ---------- */
  section('异常：未知 action');
  resetStore();
  {
    const res = await callNutrition('anyone', '让AI直接给热量', {});
    checkEqual('未知 action 被拒', res.success, false);
    checkEqual('错误码 UNKNOWN_ACTION', res.code, 'UNKNOWN_ACTION');
  }

  /* ---------- ping ---------- */
  section('健康检查：ping');
  resetStore();
  {
    const a = await setupFamily('ping');
    const res = await callNutrition(a.openidA, 'ping', {});
    checkEqual('ping 成功', res.success, true);
    checkEqual('ping 返回 nutrition', res.data.function, 'nutrition');
  }

  /* ---------- 响应信封与日志 ---------- */
  section('响应信封与日志可追溯');
  resetStore();
  {
    const a = await setupFamily('env');
    await callNutrition(a.openidA, 'calculateNutrition', {
      ingredients: [{ name: '番茄', amount: 100, unit: 'g' }],
      peopleCount: 2,
    });

    const log = lastNutritionLog();
    check('日志带 requestId', typeof log.requestId === 'string' && log.requestId.length > 0);
    checkEqual('日志 functionName = nutrition', log.functionName, 'nutrition');
    checkEqual('日志 action 正确', log.action, 'calculateNutrition');
    checkEqual('日志 status = success', log.status, 'success');
    checkEqual('日志记录参与计算的食材数', log.computedCount, 1);
    checkEqual('日志记录 nutritionStatus', log.nutritionStatus, 'complete');
    check('日志不含 openid', nutritionLogs.join('').indexOf(a.openidA) === -1);

    const failed = await callNutrition(a.openidA, 'calculateNutrition', { ingredients: [], peopleCount: 0 });
    checkEqual('失败时 success = false', failed.success, false);
    check('失败时 error.code 与 code 一致', failed.error.code === failed.code);
    check('失败时 error.message 非空', typeof failed.error.message === 'string' && failed.error.message.length > 0);
    check('成功时 error 为 null', lastNutritionLog() !== null);
  }

  /* ---------- 家庭成员共用同一套计算结果 ---------- */
  section('家庭成员：同一家庭任一成员都能算');
  resetStore();
  {
    const a = await setupFamily('share');

    seedUser('share-openid-b2', 'share-user-b2');
    const myFamily = await callFamily(a.openidA, 'getMyFamily');
    const joinRes = await callFamily('share-openid-b2', 'joinFamily', {
      inviteCode: myFamily.data.family.inviteCode,
    });
    checkEqual('B 加入家庭成功', joinRes.success, true);

    const res = await callNutrition('share-openid-b2', 'calculateNutrition', {
      familyId: a.familyId,
      ingredients: [{ name: '番茄', amount: 100, unit: 'g' }],
      peopleCount: 1,
    });
    checkEqual('普通成员可以计算', res.success, true);
    checkEqual('普通成员得到同一结果', res.data.calories, 15);
  }

  /* ---------- 基础数据可覆盖性：每条都能算 ---------- */
  section('基础数据自检：每条内置数据都能独立算出正数热量');
  resetStore();
  {
    const a = await setupFamily('selfcheck');
    const bad = [];

    for (const row of data.BUILTIN_NUTRITION_FACTS) {
      const res = await callNutrition(a.openidA, 'calculateNutrition', {
        ingredients: [{ name: row.standardName, amount: 100, unit: 'g' }],
        peopleCount: 1,
      });
      if (!res.success || res.data.computedCount !== 1 || res.data.nutritionStatus !== 'complete') {
        bad.push(row.standardName);
      }
    }

    check('全部内置食材都能按 g 计算', bad.length === 0, bad.join(','));
  }
}

/* ============================== 入口 ============================== */

(async function main() {
  console.log('Phase 5 营养计算 · 验证开始');

  runStructureChecks();
  runUnitTests();
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
