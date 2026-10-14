/**
 * 过敏原 / 忌口硬过滤 · 静态结构与纯函数验证（Phase E2）
 *
 * 运行：node tools/verify-diet.js
 *
 * 覆盖：
 *   1. 两份 diet-filter.js 字节一致（recommend 与 menu 目录）
 *   2. 关键词表全覆盖（allergen + avoid 每个标签都有对应匹配项）
 *   3. stripAvoidPrefix 去前缀
 *   4. buildDiet 规则生成
 *   5. matchRecipe 菜名 + 食材两层匹配
 *   6. filterRecipes 分组输出 kept / blocked
 *   7. 边界：空偏好 / 空菜谱 / 空食材 / 缺失偏好字段
 *   8. isBlocked 快捷判断
 *   9. summarizeDiet 摘要结构
 */
const path = require('path');
const fs = require('fs');

const dfRecommend = require(path.join(__dirname, '..', 'cloudfunctions', 'recommend', 'diet-filter.js'));
const dfMenu = require(path.join(__dirname, '..', 'cloudfunctions', 'menu', 'diet-filter.js'));

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

/* ============================== 辅助函数 ============================== */

function recipeWithIngredients(ingredients) {
  return {
    _id: 'r-test',
    name: '测试菜谱',
    ingredients: ingredients,
  };
}

function recipeWithName(name, ingredients) {
  return {
    _id: 'r-' + name,
    name: name,
    ingredients: ingredients,
  };
}

/* ============================== 字节一致性 ============================== */

function runByteCheck() {
  section('两份 diet-filter.js 字节一致');

  const contentRec = fs.readFileSync(
    path.join(__dirname, '..', 'cloudfunctions', 'recommend', 'diet-filter.js'), 'utf-8');
  const contentMenu = fs.readFileSync(
    path.join(__dirname, '..', 'cloudfunctions', 'menu', 'diet-filter.js'), 'utf-8');

  checkEqual('recommend 与 menu 的 diet-filter.js 字节一致',
    contentRec, contentMenu);
}

/* ============================== 静态结构 ============================== */

function runStructureChecks() {
  section('静态结构');

  check('导出 ALLERGEN_KEYWORDS', typeof dfRecommend.ALLERGEN_KEYWORDS === 'object');
  check('导出 AVOID_EXPANSIONS', typeof dfRecommend.AVOID_EXPANSIONS === 'object');
  check('导出 AVOID_PREFIXES', Array.isArray(dfRecommend.AVOID_PREFIXES));
  check('导出 buildDiet', typeof dfRecommend.buildDiet === 'function');
  check('导出 matchRecipe', typeof dfRecommend.matchRecipe === 'function');
  check('导出 isBlocked', typeof dfRecommend.isBlocked === 'function');
  check('导出 filterRecipes', typeof dfRecommend.filterRecipes === 'function');
  check('导出 summarizeDiet', typeof dfRecommend.summarizeDiet === 'function');
  check('导出 stripAvoidPrefix', typeof dfRecommend.stripAvoidPrefix === 'function');
  check('导出 expandAllergen', typeof dfRecommend.expandAllergen === 'function');
  check('导出 expandAvoid', typeof dfRecommend.expandAvoid === 'function');

  // 过敏原分组数量
  const allergenKeys = Object.keys(dfRecommend.ALLERGEN_KEYWORDS);
  check('ALLERGEN_KEYWORDS 至少 8 组', allergenKeys.length >= 8);
}

/* ============================== stripAvoidPrefix ============================== */

function runStripPrefix() {
  section('stripAvoidPrefix 去前缀');

  checkEqual('不吃香菜 → 香菜', dfRecommend.stripAvoidPrefix('不吃香菜'), '香菜');
  checkEqual('不能吃辣 → 辣', dfRecommend.stripAvoidPrefix('不能吃辣'), '辣');
  checkEqual('忌牛肉 → 牛肉', dfRecommend.stripAvoidPrefix('忌牛肉'), '牛肉');
  checkEqual('不喜欢吃海鲜 → 海鲜', dfRecommend.stripAvoidPrefix('不喜欢吃海鲜'), '海鲜');
  checkEqual('禁食辣椒 → 辣椒', dfRecommend.stripAvoidPrefix('禁食辣椒'), '辣椒');
  checkEqual('无前缀保持原样', dfRecommend.stripAvoidPrefix('芒果'), '芒果');
  checkEqual('空字符串', dfRecommend.stripAvoidPrefix(''), '');
  check('非字符串不崩溃', dfRecommend.stripAvoidPrefix(123) !== undefined);
}

/* ============================== expandAllergen ============================== */

function runExpandAllergen() {
  section('expandAllergen 展开');

  const peanut = dfRecommend.expandAllergen('花生');
  check('花生展开含花生', peanut.includes('花生'));
  check('花生展开含花生米', peanut.includes('花生米'));

  const egg = dfRecommend.expandAllergen('鸡蛋');
  check('鸡蛋展开含蛋', egg.includes('蛋'));

  const soy = dfRecommend.expandAllergen('大豆');
  check('大豆展开含豆腐', soy.includes('豆腐'));
  check('大豆展开含酱油', soy.includes('酱油'));

  const wheat = dfRecommend.expandAllergen('小麦');
  check('小麦展开含面条', wheat.includes('面条'));

  const fish = dfRecommend.expandAllergen('鱼类');
  check('鱼类展开含鱼', fish.includes('鱼'));

  const crustacean = dfRecommend.expandAllergen('甲壳类');
  check('甲壳类展开含虾', crustacean.includes('虾'));

  const dairy = dfRecommend.expandAllergen('牛奶');
  check('牛奶展开含黄油', dairy.includes('黄油'));
  check('牛奶展开含芝士', dairy.includes('芝士'));

  // 未知过敏原返回标签本身
  const custom = dfRecommend.expandAllergen('枸杞');
  checkEqual('未知过敏原返回标签本身', custom.join(','), '枸杞');
}

/* ============================== expandAvoid ============================== */

function runExpandAvoid() {
  section('expandAvoid 展开忌口');

  const avoidPork = dfRecommend.expandAvoid('不吃猪肉');
  check('不吃猪肉展开含猪肉', avoidPork.includes('猪肉'));
  check('不吃猪肉展开含排骨', avoidPork.includes('排骨'));

  const avoidChicken = dfRecommend.expandAvoid('不吃鸡肉');
  check('不吃鸡肉展开含鸡翅', avoidChicken.includes('鸡翅'));

  const avoidSeafood = dfRecommend.expandAvoid('不吃海鲜');
  check('不吃海鲜展开含虾', avoidSeafood.includes('虾'));
  check('不吃海鲜展开含鱼', avoidSeafood.includes('鱼'));

  const avoidMeat = dfRecommend.expandAvoid('不吃肉');
  check('不吃肉展开含猪肉', avoidMeat.includes('猪肉'));
  check('不吃肉展开含鸡肉', avoidMeat.includes('鸡肉'));
}

/* ============================== buildDiet ============================== */

function runBuildDiet() {
  section('buildDiet 规则生成');

  // 空偏好
  const diet0 = dfRecommend.buildDiet({});
  checkEqual('空偏好 rules 为空数组', diet0.rules.length, 0);
  checkEqual('空偏好 allergenTags 为空', diet0.allergenTags.length, 0);

  // 只有过敏原
  const diet1 = dfRecommend.buildDiet({ allergens: ['花生', '大豆'] });
  check('allergen 规则 > 0', diet1.rules.length > 0);
  check('allergenTags 含花生', diet1.allergenTags.includes('花生'));
  check('rules 含 allergen 种类标记', diet1.rules.some((r) => r.kind === 'allergen' && r.tag === '花生'));
  check('rules 含 avoid=-', !diet1.rules.some((r) => r.kind === 'avoid'));

  // 只有忌口
  const diet2 = dfRecommend.buildDiet({ avoidIngredients: ['不吃香菜', '不吃辣'] });
  check('avoid 规则 > 0', diet2.rules.length > 0);
  check('avoidTags 含不吃香菜', diet2.avoidTags.includes('不吃香菜'));
  check('rules 全是 avoid', diet2.rules.every((r) => r.kind === 'avoid'));

  // 混合
  const diet3 = dfRecommend.buildDiet({
    allergens: ['花生'],
    avoidIngredients: ['不吃香菜'],
  });
  const hasA = diet3.rules.some((r) => r.kind === 'allergen');
  const hasV = diet3.rules.some((r) => r.kind === 'avoid');
  check('混合规则含 allergen + avoid', hasA && hasV);

  // 参数为 null / undefined 不崩溃
  const diet4 = dfRecommend.buildDiet(null);
  checkEqual('null 偏好 rules 为空', diet4.rules.length, 0);
  const diet5 = dfRecommend.buildDiet(undefined);
  checkEqual('undefined 偏好 rules 为空', diet5.rules.length, 0);

  // preferences 不存在不崩溃
  const diet6 = dfRecommend.buildDiet({});
  check('纯空对象不崩溃', Array.isArray(diet6.rules));
}

/* ============================== matchRecipe ============================== */

function runMatchRecipe() {
  section('matchRecipe 匹配');

  const diet = dfRecommend.buildDiet({ allergens: ['花生'] });

  // 花生命中药名（宫保鸡丁含「花生米」）
  const res1 = dfRecommend.matchRecipe(
    recipeWithName('宫保鸡丁', [{ name: '花生米', amount: 50, unit: 'g' }, { name: '鸡肉', amount: 200, unit: 'g' }]),
    diet,
  );
  check('宫保鸡丁被花生过敏原命中', res1.length > 0);
  const hit1 = res1.find((r) => r.keyword === '花生');
  check('命中的 keyword=花生', !!hit1);

  // 花生在菜名中
  const res2 = dfRecommend.matchRecipe(
    recipeWithName('花生炖猪蹄', [{ name: '猪蹄', amount: 500, unit: 'g' }]),
    diet,
  );
  check('菜名含「花生」被命中', res2.length > 0);

  // 不命中
  const res3 = dfRecommend.matchRecipe(
    recipeWithName('番茄炒蛋', [{ name: '番茄', amount: 2, unit: '个' }, { name: '鸡蛋', amount: 3, unit: '个' }]),
    diet,
  );
  checkEqual('番茄炒蛋不命中花生过敏原', res3.length, 0);

  // 大豆过敏 → 豆腐 / 酱油
  const soyDiet = dfRecommend.buildDiet({ allergens: ['大豆'] });
  const res4 = dfRecommend.matchRecipe(
    recipeWithName('麻婆豆腐', [{ name: '豆腐', amount: 400, unit: 'g' }, { name: '酱油', amount: 10, unit: 'g' }]),
    soyDiet,
  );
  check('麻婆豆腐被大豆过敏原命中', res4.length > 0);

  // 牛奶过敏 → 黄油 / 芝士
  const dairyDiet = dfRecommend.buildDiet({ allergens: ['牛奶'] });
  const res5 = dfRecommend.matchRecipe(
    recipeWithName('芝士焗饭', [{ name: '芝士', amount: 50, unit: 'g' }, { name: '米饭', amount: 200, unit: 'g' }]),
    dairyDiet,
  );
  check('芝士被牛奶过敏原命中', res5.length > 0);

  // 空菜谱
  const res6 = dfRecommend.matchRecipe(null, diet);
  checkEqual('null 菜谱不命中', res6.length, 0);

  // 空食材列表
  const res7 = dfRecommend.matchRecipe(
    recipeWithName('测试', []),
    diet,
  );
  checkEqual('空食材不命中', res7.length, 0);

  // 没有偏好
  const res8 = dfRecommend.matchRecipe(
    recipeWithName('番茄炒蛋', [{ name: '鸡蛋', amount: 3, unit: '个' }]),
    dfRecommend.buildDiet({}),
  );
  checkEqual('无偏好不命中', res8.length, 0);

  // 返回结构
  const res9 = dfRecommend.matchRecipe(
    recipeWithName('宫保鸡丁', [{ name: '花生米', amount: 50, unit: 'g' }]),
    diet,
  );
  check('返回含 kind', res9[0] && typeof res9[0].kind === 'string');
  check('返回含 tag', res9[0] && typeof res9[0].tag === 'string');
  check('返回含 keyword', res9[0] && typeof res9[0].keyword === 'string');
  check('返回含 field', res9[0] && typeof res9[0].field === 'string');
  check('返回含 value', res9[0] && typeof res9[0].value === 'string');
}

/* ============================== isBlocked ============================== */

function runIsBlocked() {
  section('isBlocked 快捷判断');

  const diet = dfRecommend.buildDiet({ allergens: ['花生'] });
  const blocked = dfRecommend.isBlocked(
    recipeWithName('宫保鸡丁', [{ name: '花生米', amount: 50, unit: 'g' }]),
    diet,
  );
  check('宫保鸡丁被 blocked', blocked);

  const notBlocked = dfRecommend.isBlocked(
    recipeWithName('番茄炒蛋', [{ name: '鸡蛋', amount: 3, unit: '个' }]),
    diet,
  );
  check('番茄炒蛋未 blocked', !notBlocked);

  check('无偏好不 blocked', !dfRecommend.isBlocked(
    recipeWithName('宫保鸡丁', [{ name: '花生米', amount: 50, unit: 'g' }]),
    dfRecommend.buildDiet({}),
  ));
}

/* ============================== filterRecipes ============================== */

function runFilterRecipes() {
  section('filterRecipes 过滤列表');

  const diet = dfRecommend.buildDiet({ allergens: ['花生'] });

  const recipes = [
    recipeWithName('番茄炒蛋', [{ name: '鸡蛋', amount: 3, unit: '个' }]),
    recipeWithName('宫保鸡丁', [{ name: '花生米', amount: 50, unit: 'g' }]),
    recipeWithName('青椒肉丝', [{ name: '猪肉', amount: 200, unit: 'g' }]),
  ];

  const result = dfRecommend.filterRecipes(recipes, diet);
  checkEqual('kept 长度 = 2', result.kept.length, 2);
  checkEqual('blocked 长度 = 1', result.blocked.length, 1);
  check('番茄炒蛋在 kept 中', result.kept.some((r) => r.name === '番茄炒蛋'));
  check('青椒肉丝在 kept 中', result.kept.some((r) => r.name === '青椒肉丝'));
  check('宫保鸡丁在 blocked 中', result.blocked.some((r) => r.name === '宫保鸡丁'));
  check('blocked 含 recipeId', result.blocked[0] && result.blocked[0].recipeId === 'r-宫保鸡丁');

  // 全部拦截
  const allBlocked = dfRecommend.filterRecipes(
    [recipeWithName('宫保鸡丁', [{ name: '花生米', amount: 50, unit: 'g' }])],
    diet,
  );
  checkEqual('全拦截 kept=0', allBlocked.kept.length, 0);
  checkEqual('全拦截 blocked=1', allBlocked.blocked.length, 1);

  // 空列表不崩溃
  const empty = dfRecommend.filterRecipes([], diet);
  checkEqual('空列表 kept=0', empty.kept.length, 0);

  // 无偏好全部保留
  const noDiet = dfRecommend.filterRecipes(recipes, dfRecommend.buildDiet({}));
  checkEqual('无偏好 kept=3', noDiet.kept.length, 3);
  checkEqual('无偏好 blocked=0', noDiet.blocked.length, 0);

  // undefined 不崩溃
  const undef = dfRecommend.filterRecipes(undefined, diet);
  check('undefined 不崩溃', Array.isArray(undef.kept));
}

/* ============================== summarizeDiet ============================== */

function runSummarizeDiet() {
  section('summarizeDiet 摘要');

  const diet = dfRecommend.buildDiet({ allergens: ['花生'] });
  const blocked = [{ recipeId: 'r1', name: '宫保鸡丁', matches: [] }];
  const summary = dfRecommend.summarizeDiet(diet, blocked);

  check('allergenTags 含花生', summary.allergenTags.includes('花生'));
  checkEqual('blockedCount = 1', summary.blockedCount, 1);
  check('blockedRecipeIds 含 r1', summary.blockedRecipeIds.includes('r1'));

  // 空 blocked
  const empty = dfRecommend.summarizeDiet(diet, []);
  checkEqual('空 blockedCount = 0', empty.blockedCount, 0);
}

/* ============================== 忌口实际菜谱测试 ============================== */

function runRealRecipeTests() {
  section('实际内置菜谱验证');

  const diet = dfRecommend.buildDiet({
    allergens: ['花生'],
    avoidIngredients: ['不吃香菜', '不吃海鲜'],
  });

  // 真实菜名 + 食材（对齐 recipe-data.js）
  const tests = [
    { name: '宫保鸡丁', ing: ['花生米', '鸡肉'], blocked: true, reason: '花生过敏原' },
    { name: '番茄炒蛋', ing: ['番茄', '鸡蛋'], blocked: false, reason: '' },
    { name: '紫菜蛋花汤', ing: ['紫菜', '鸡蛋'], blocked: true, reason: '紫菜 → 海鲜' },
    { name: '海带豆腐汤', ing: ['海带', '豆腐'], blocked: true, reason: '海带 → 海鲜' },
    { name: '虾仁蛋炒饭', ing: ['虾仁', '鸡蛋'], blocked: true, reason: '虾仁 → 海鲜' },
    { name: '青椒肉丝', ing: ['猪肉', '青椒'], blocked: false, reason: '' },
    { name: '手撕包菜', ing: ['包菜', '干辣椒'], blocked: false, reason: '' },
    { name: '香菜拌黄瓜', ing: ['香菜', '黄瓜'], blocked: true, reason: '香菜 → 忌口' },
  ];

  let blockedCount = 0;
  tests.forEach((t) => {
    const recipe = recipeWithName(t.name, t.ing.map((n) => ({ name: n, amount: 100, unit: 'g' })));
    const result = dfRecommend.isBlocked(recipe, diet);
    if (t.blocked && result) blockedCount += 1;
    check(
      t.name + (t.blocked ? ' 被拦截' : ' 放行') + (t.reason ? '（' + t.reason + '）' : ''),
      result === t.blocked,
      t.blocked ? '应被拦截但放行' : '应放行但被拦截',
    );
  });

  check('拦截数量 > 0', blockedCount > 0);
}

/* ============================== 主入口 ============================== */

function main() {
  console.log('Phase E2 过敏原 / 忌口硬过滤 · 验证开始');

  try {
    runByteCheck();
    runStructureChecks();
    runStripPrefix();
    runExpandAllergen();
    runExpandAvoid();
    runBuildDiet();
    runMatchRecipe();
    runIsBlocked();
    runFilterRecipes();
    runSummarizeDiet();
    runRealRecipeTests();
  } catch (error) {
    console.error('[verify-diet] 意外异常', error);
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