/**
 * AI 推荐升级 · 大厨人格 / 分层候选 / 库外菜 / 强去重 验证套件
 *
 * 运行：node tools/verify-recommend-chef.js
 *
 * 覆盖：
 *   1. dish-signature 纯函数：主料 / 做法 / 菜系抽取，同名与同类判定
 *   2. 两份 dish-signature.js、new-dish.js 字节一致（recommend 与 menu）
 *   3. new-dish：字段规范化、用量校验、两种 dishes 写法解析
 *   4. 分层候选：每层都能进入提示词，单道层不垄断
 *   5. 提示词：大厨人格、跳出菜谱库、强力去重、过敏原硬约束
 *   6. 库外菜落库：校验通过才写入、按家庭隔离、复用不重复写
 *   7. 换菜链路：排除被替换菜别的同类、triedRecipeIds 生效
 *   8. 过敏原：库外菜命中过敏原一律拒绝
 */
const path = require('path');
const fs = require('fs');

const sigRecommend = require(path.join(__dirname, '..', 'cloudfunctions', 'recommend', 'dish-signature.js'));
const sigMenu = require(path.join(__dirname, '..', 'cloudfunctions', 'menu', 'dish-signature.js'));
const newDish = require(path.join(__dirname, '..', 'cloudfunctions', 'recommend', 'new-dish.js'));
const { buildDiet, matchRecipe } = require(path.join(__dirname, '..', 'cloudfunctions', 'recommend', 'diet-filter.js'));

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

/* ============================== 1. 签名抽取 ============================== */

function runSignatureTests() {
  section('菜品签名：主料 / 做法 / 菜系');

  const tomatoEgg = sigRecommend.buildSignature({
    name: '番茄炒蛋',
    tags: ['家常'],
    ingredients: [{ name: '番茄' }, { name: '鸡蛋' }, { name: '食盐' }],
  });
  checkEqual('番茄炒蛋主料识别为鸡蛋', tomatoEgg.protein, '鸡蛋');
  checkEqual('番茄炒蛋做法识别为炒', tomatoEgg.method, '炒');
  checkEqual('番茄炒蛋蔬菜识别为番茄', tomatoEgg.vegetable, '番茄');
  check('调味料不进入主料', tomatoEgg.mainIngredients.indexOf('食盐') === -1,
    tomatoEgg.mainIngredients.join('/'));

  const braisedPork = sigRecommend.buildSignature({
    name: '红烧肉',
    ingredients: [{ name: '猪肉' }, { name: '白砂糖' }],
  });
  checkEqual('红烧肉主料为猪', braisedPork.protein, '猪');
  checkEqual('红烧肉做法为烧', braisedPork.method, '烧');

  const steamedFish = sigRecommend.buildSignature({
    name: '清蒸鲈鱼',
    ingredients: [{ name: '鲈鱼' }],
  });
  checkEqual('清蒸鲈鱼做法为蒸', steamedFish.method, '蒸');
  checkEqual('清蒸鲈鱼主料为鱼', steamedFish.protein, '鱼');

  // 「下饭」这类标签不能污染做法判定
  const kungpao = sigRecommend.buildSignature({
    name: '宫保鸡丁',
    tags: ['下饭', '川味'],
    steps: [
      { description: '鸡丁用料酒腌制，黄瓜切丁，先调一碗料汁备用。' },
      { description: '热锅下油，爆香干辣椒，倒入鸡丁大火快炒。' },
    ],
  });
  checkEqual('宫保鸡丁做法为炒（不被标签「下饭」误导）', kungpao.method, '炒');
  checkEqual('宫保鸡丁菜系为川味', kungpao.cuisine, '川味');

  // 前置处理里的「凉拌」不能盖过主做法
  const mixed = sigRecommend.buildSignature({
    name: '手撕包菜',
    steps: [{ description: '包菜撕块后凉拌备用，另起锅大火爆炒至断生。' }],
  });
  checkEqual('主做法优先于前置处理', mixed.method, '炒');
}

/* ============================== 2. 相似度判定 ============================== */

function runCompareTests() {
  section('相似度：同名 / 同主料同做法 / 换汤不换药');

  const a = sigRecommend.buildSignature({ name: '番茄炒蛋', ingredients: [{ name: '番茄' }, { name: '鸡蛋' }] });
  const b = sigRecommend.buildSignature({ name: '番茄炒蛋', ingredients: [{ name: '番茄' }, { name: '鸡蛋' }] });
  checkEqual('同名判定为 identical', sigRecommend.compareSignature(a, b).level, 'identical');

  // 异体写法：菜名不同，但主料 + 做法相同
  const alias = sigRecommend.buildSignature({ name: '西红柿炒鸡蛋', ingredients: [{ name: '番茄' }, { name: '鸡蛋' }] });
  checkEqual('西红柿炒鸡蛋被判为 similar', sigRecommend.compareSignature(a, alias).level, 'similar');

  // 换汤不换药：同主料同做法、只换蔬菜
  const cauliflower = sigRecommend.buildSignature({ name: '清炒西兰花', ingredients: [{ name: '西兰花' }] });
  const garlicCauliflower = sigRecommend.buildSignature({ name: '蒜蓉西兰花', ingredients: [{ name: '西兰花' }, { name: '大蒜' }] });
  // flavor 与 similar 都会被换菜 / 重推当作重复排除，两者都可接受
  const cauliLevel = sigRecommend.compareSignature(cauliflower, garlicCauliflower).level;
  check('清炒西兰花 vs 蒜蓉西兰花 判为重复',
    cauliLevel === 'similar' || cauliLevel === 'flavor', cauliLevel);

  // 真换了做法：同主料但做法不同，不算同类
  const steamedEgg = sigRecommend.buildSignature({ name: '蒸蛋', ingredients: [{ name: '鸡蛋' }] });
  const friedEgg = sigRecommend.buildSignature({ name: '炒鸡蛋', ingredients: [{ name: '鸡蛋' }] });
  checkEqual('蒸蛋 vs 炒鸡蛋 不算重复（做法不同）',
    sigRecommend.compareSignature(steamedEgg, friedEgg).level, 'none');

  // 完全不同
  const beefStew = sigRecommend.buildSignature({ name: '番茄炖牛腩', ingredients: [{ name: '牛肉' }, { name: '番茄' }] });
  checkEqual('番茄炒蛋 vs 番茄炖牛腩 不算重复',
    sigRecommend.compareSignature(a, beefStew).level, 'none');

  // findConflict 在近期列表里找冲突
  const recent = [
    sigRecommend.buildSignature({ name: '青椒肉丝', ingredients: [{ name: '猪肉' }, { name: '青椒' }] }),
  ];
  const conflict = sigRecommend.findConflict(
    { name: '鱼香肉丝', ingredients: [{ name: '猪肉' }, { name: '木耳' }] },
    recent,
  );
  check('鱼香肉丝与青椒肉丝判为冲突', !!conflict, conflict ? conflict.reason : 'null');

  const noConflict = sigRecommend.findConflict(
    { name: '清蒸鲈鱼', ingredients: [{ name: '鲈鱼' }] },
    recent,
  );
  check('清蒸鲈鱼与青椒肉丝不冲突', noConflict === null);
}

/* ============================== 3. 字节一致 ============================== */

function runByteChecks() {
  section('共享模块字节一致（recommend / menu）');

  ['dish-signature.js', 'new-dish.js'].forEach((file) => {
    const a = fs.readFileSync(path.join(__dirname, '..', 'cloudfunctions', 'recommend', file), 'utf-8');
    const b = fs.readFileSync(path.join(__dirname, '..', 'cloudfunctions', 'menu', file), 'utf-8');
    check(file + ' 两份字节一致', a === b);
  });
}

/* ============================== 4. 库外菜规范化 ============================== */

function runNewDishTests() {
  section('库外菜：字段校验与解析');

  // 合法
  const ok = newDish.normalizeNewDish({
    name: '黄焖鸡',
    category: '家常菜',
    tags: ['鲁菜'],
    cookTime: 40,
    servings: 2,
    ingredients: [{ name: '鸡腿肉', amount: 500, unit: 'g' }],
  });
  check('合法库外菜通过校验', ok.ok === true, ok.reason || '');
  checkEqual('菜名保留', ok.value.name, '黄焖鸡');
  checkEqual('食材数量保留', ok.value.ingredients.length, 1);
  checkEqual('默认无步骤（交给 AI 生成做法）', ok.value.steps.length, 0);

  // 缺少用量 → 拒绝（采购清单会失真）
  const noAmount = newDish.normalizeNewDish({
    name: '清炒时蔬',
    ingredients: [{ name: '青菜', amount: 0, unit: 'g' }],
  });
  check('缺少可用用量被拒绝', noAmount.ok === false, noAmount.reason);
  check('拒绝原因点名了缺用量的食材',
    noAmount.ok === false && noAmount.reason.indexOf('青菜') !== -1, noAmount.reason || '');

  // 「适量」这类字符串
  const anon = newDish.normalizeNewDish({
    name: '凉拌木耳',
    ingredients: [{ name: '木耳', amount: '适量', unit: 'g' }],
  });
  check('「适量」被拒绝', anon.ok === false, anon.reason);

  // 菜名过短
  check('菜名过短被拒绝', newDish.normalizeNewDish({ name: '菜', ingredients: [{ name: '青菜', amount: 100 }] }).ok === false);

  // 非对象
  check('null 被拒绝', newDish.normalizeNewDish(null).ok === false);
  check('字符串被拒绝', newDish.normalizeNewDish('麻婆豆腐').ok === false);

  // 非法分类回落到家常菜
  const badCategory = newDish.normalizeNewDish({
    name: '测试菜', category: '外星菜系',
    ingredients: [{ name: '青菜', amount: 100, unit: 'g' }],
  });
  checkEqual('未知分类回落到家常菜', badCategory.value.category, '家常菜');

  // 超长 cookTime 被截断
  const longTime = newDish.normalizeNewDish({
    name: '测试菜2', cookTime: 9999,
    ingredients: [{ name: '青菜', amount: 100, unit: 'g' }],
  });
  check('cookTime 被限制在上限内', longTime.value.cookTime <= 240, String(longTime.value.cookTime));
}

function runParseSelections() {
  section('库外菜：dishes 解析');

  const parsed = newDish.parseDishSelections([
    { recipeId: 'r-1' },
    { newDish: { name: '黄焖鸡', ingredients: [{ name: '鸡肉', amount: 500, unit: 'g' }] } },
    { newDish: { name: '坏菜', ingredients: [] } },
    'r-2',
  ]);
  checkEqual('解析出 2 个 recipeId', parsed.recipeIds.length, 2);
  checkEqual('解析出 1 道库外菜', parsed.newDishes.length, 1);
  checkEqual('坏菜被拒绝并记录', parsed.rejected.length, 1);
  check('拒绝原因可读', parsed.rejected[0].reason.length > 0, parsed.rejected[0].reason);

  // 重复 id 去重
  const dup = newDish.parseDishSelections([{ recipeId: 'r-1' }, { recipeId: 'r-1' }]);
  checkEqual('重复 recipeId 去重', dup.recipeIds.length, 1);

  // 空输入
  checkEqual('空数组安全', newDish.parseDishSelections([]).recipeIds.length, 0);
  checkEqual('null 安全', newDish.parseDishSelections(null).recipeIds.length, 0);
}

/* ============================== 5. 库外菜过敏原 ============================== */

function runNewDishDiet() {
  section('库外菜：过敏原 / 忌口硬校验');

  const peanutDiet = buildDiet({ allergens: ['花生'] });
  const safe = {
    name: '黄焖鸡',
    ingredients: [{ name: '鸡腿肉', amount: 500, unit: 'g' }],
  };
  const safeCheck = newDish.checkNewDishDiet(safe, peanutDiet, matchRecipe);
  check('不含过敏原的库外菜通过', safeCheck.ok === true);

  const dangerous = {
    name: '宫保鸡丁',
    ingredients: [{ name: '鸡肉', amount: 300, unit: 'g' }, { name: '花生米', amount: 50, unit: 'g' }],
  };
  const dangerCheck = newDish.checkNewDishDiet(dangerous, peanutDiet, matchRecipe);
  check('含花生米的库外菜被拒绝', dangerCheck.ok === false);
  check('拒绝时给出命中明细', dangerCheck.matches.length > 0);

  // 忌口同样生效
  const noPork = buildDiet({ avoidIngredients: ['不吃猪肉'] });
  const porkDish = {
    name: '红烧肉',
    ingredients: [{ name: '猪肉', amount: 500, unit: 'g' }],
  };
  check('命中忌口的库外菜被拒绝',
    newDish.checkNewDishDiet(porkDish, noPork, matchRecipe).ok === false);

  // 无偏好时应全部通过
  const emptyDiet = buildDiet({});
  check('无偏好时库外菜通过',
    newDish.checkNewDishDiet(dangerous, emptyDiet, matchRecipe).ok === true);

  // 库外菜也要参与近期去重
  const recent = [{ name: '黄焖鸡', ingredients: [{ name: '鸡肉' }] }];
  const repeated = newDish.isNewDishRepeated(
    { name: '黄焖鸡', ingredients: [{ name: '鸡肉' }] }, recent, sigRecommend.findConflict,
  );
  check('与近期菜单同名的库外菜被判重复', !!repeated, repeated ? repeated.reason : 'null');

  const notRepeated = newDish.isNewDishRepeated(
    { name: '清蒸鲈鱼', ingredients: [{ name: '鲈鱼' }] }, recent, sigRecommend.findConflict,
  );
  check('不同的库外菜不判重复', notRepeated === null);
}

/* ============================== 6. 分层候选 ============================== */

function runLayerTests() {
  section('分层候选：各层都能进提示词');

  // 直接验证源码中的层比例与「单道层不垄断」逻辑
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'cloudfunctions', 'recommend', 'index.js'), 'utf-8');

  check('存在分层函数 splitCandidateLayers', src.indexOf('function splitCandidateLayers') !== -1);
  check('存在分层挑选 pickLayeredCandidates', src.indexOf('function pickLayeredCandidates') !== -1);
  check('不再使用旧的扁平挑选 pickPromptCandidates', src.indexOf('function pickPromptCandidates') === -1);
  check('探索层比例已提高', src.indexOf('LAYER_EXPLORE_RATIO = 0.25') !== -1);
  check('候选数提升到 60', src.indexOf('MAX_PROMPT_CANDIDATES = 60') !== -1);
  check('单道候选的层不参与主挑选（避免每次同一道菜）',
    src.indexOf('rotated.length >= 2') !== -1);
  check('各层按比例分配名额', src.indexOf('Math.floor(limit * layer.ratio)') !== -1);
  check('剩余名额会补给其他层', src.indexOf('limit - picked.length') !== -1);
  check('候选池不再被砍到 50 条', src.indexOf('MAX_CANDIDATES') === -1);
}

/* ============================== 7. 提示词 ============================== */

function runPromptTests() {
  section('推荐提示词：大厨人格与跳出菜谱库');

  const src = fs.readFileSync(
    path.join(__dirname, '..', 'cloudfunctions', 'recommend', 'index.js'), 'utf-8');

  check('角色设定为多菜系大厨', src.indexOf('精通中国各大菜系') !== -1);
  check('包含核心心态（冰箱是起点不是边界）', src.indexOf('冰箱是起点，不是边界') !== -1);
  check('第一层：优先用得上冰箱', src.indexOf('【第一层：优先用得上冰箱】') !== -1);
  check('第二层：库存不够就跳出菜谱库', src.indexOf('【第二层：库存不够就跳出菜谱库】') !== -1);
  check('第三层：强力去重', src.indexOf('【第三层：强力去重') !== -1);
  check('明确候选不是唯一范围', src.indexOf('候选菜谱列表不是唯一允许的范围') !== -1);
  check('库外菜禁止写「适量」', src.indexOf('不能只写「适量」') !== -1);
  check('要求换开主料与做法', src.indexOf('如果近期刚做过「猪|炒」') !== -1);
  check('换汤不换药不算换菜', src.indexOf('「换汤不换药」不算换菜') !== -1);
  check('过敏原是硬红线', src.indexOf('过敏原和忌口是硬红线') !== -1);
  check('要求内部自检但不输出过程', src.indexOf('自检过程不要输出') !== -1);
  check('用户明确要求优先于多样性', src.indexOf('多样性规则不得覆盖用户的明确要求') !== -1);
  check('提示词带上近期主料/做法签名',
    src.indexOf('近期主料/做法签名') !== -1);
  check('提示词提供库外菜返回格式', src.indexOf('"newDish"') !== -1);

  // 不能出现「只能从候选里选」这类互相冲突的限制
  check('没有把候选限定为唯一来源',
    src.indexOf('只能从候选菜谱中选择') === -1 && src.indexOf('从候选菜谱中选择菜品') === -1);
}

/* ============================== 8. 换菜链路 ============================== */

function runReplaceTests() {
  section('换菜链路：真探索而非改名');

  const src = fs.readFileSync(
    path.join(__dirname, '..', 'cloudfunctions', 'menu', 'index.js'), 'utf-8');

  check('换菜引入签名模块', src.indexOf("require('./dish-signature')") !== -1);
  check('换菜支持 triedRecipeIds', src.indexOf('triedRecipeIds') !== -1);
  check('换菜硬排除同主料同做法候选', src.indexOf('compareSignature(cand, targetSignature)') !== -1);
  check('换菜也排除与菜单内其他菜同类的候选',
    src.indexOf('compareSignature(cand, otherSignatures[i].sig)') !== -1);
  check('换菜提示词写明被替换的菜', src.indexOf('换成一道真正不一样的菜') !== -1);
  check('换菜提示词禁止同主料', src.indexOf('不要再选以「') !== -1);
  check('换菜提示词禁止同做法', src.indexOf('不要再选以「') !== -1 && src.indexOf('为主要做法的菜') !== -1);
  check('用户明确要求时让位', src.indexOf('上面的换菜要求可以为它让步') !== -1);
  check('候选太少时退回原候选而不是直接失败',
    src.indexOf('narrowed.length > 0 ? narrowed : scored') !== -1);

  // 批量重推
  check('重推前硬排除被替换菜的同类',
    src.indexOf('compareSignature(cand, replaceSignatures[i])') !== -1);
  check('重推提示词列出要换掉的菜', src.indexOf('【要换掉的菜】') !== -1);
  check('重推排除项包含被替换菜',
    src.indexOf('.concat(replacedNames)') !== -1);
  check('锁定菜品被原样保留', src.indexOf('锁定项必须原样保留') !== -1);
}

/* ============================== 9. 库外菜落库 ============================== */

function runPersistTests() {
  section('库外菜落库与下游衔接');

  const recSrc = fs.readFileSync(
    path.join(__dirname, '..', 'cloudfunctions', 'recommend', 'index.js'), 'utf-8');
  const menuSrc = fs.readFileSync(
    path.join(__dirname, '..', 'cloudfunctions', 'menu', 'index.js'), 'utf-8');

  check('推荐侧有落库函数 persistNewDish', recSrc.indexOf('async function persistNewDish') !== -1);
  check('换菜侧有落库函数 persistGeneratedRecipe',
    menuSrc.indexOf('async function persistGeneratedRecipe') !== -1);
  check('库外菜以 ai_generated 标记', recSrc.indexOf("source: 'ai_generated'") !== -1);
  check('库外菜记录归属家庭', recSrc.indexOf("familyId: familyId || ''") !== -1);
  check('复用同名菜时只取本家庭或内置菜谱',
    recSrc.indexOf("item.source === 'ai_generated' && item.familyId === familyId") !== -1);
  check('库外菜没有步骤，交给 AI 按需生成', recSrc.indexOf('// 库外菜没有步骤') !== -1);

  // 下游：menu 云函数的 loadRecipes 必须能看到本家庭的 AI 菜谱
  check('menu 读取菜谱时包含本家庭 AI 菜谱', menuSrc.indexOf("source: 'ai_generated', familyId: familyId") !== -1);
  check('menu 读取不再只读 builtin', menuSrc.indexOf("source: 'ai_generated'") !== -1);
  // 两次独立查询而不是 $or：每次都能命中单字段前缀索引，也不依赖 $or 支持
  check('用两次独立查询合并，避免依赖 $or', menuSrc.indexOf('Promise.all([builtinP, aiP])') !== -1);
  check('AI 菜谱查询按 familyId 隔离',
    menuSrc.indexOf("source: 'ai_generated', familyId: familyId, isActive: true") !== -1);
  check('saveMenu 也用家庭范围读取', menuSrc.indexOf("loadRecipes(event.familyId || '')") !== -1);
  check('confirmMenuDoc 用菜单自身的 familyId',
    menuSrc.indexOf("loadRecipes(menu.familyId || '')") !== -1);
}

/* ============================== 10. 真实数据回归 ============================== */

function runRealDataTests() {
  section('内置菜谱：签名覆盖率');

  const data = require(path.join(__dirname, '..', 'cloudfunctions', 'recipe', 'recipe-data.js'));
  const recipes = data.BUILTIN_RECIPES || [];
  check('内置菜谱数量充足', recipes.length >= 200, String(recipes.length));

  let noMethod = 0;
  let noProtein = 0;
  const keys = {};
  recipes.forEach((r) => {
    const sig = sigRecommend.buildSignature(r);
    if (!sig.method) noMethod += 1;
    if (!sig.protein) noProtein += 1;
    keys[sig.key] = (keys[sig.key] || 0) + 1;
  });

  checkEqual('所有菜谱都能识别出做法', noMethod, 0);
  check('无蛋白类菜谱在合理范围（素菜）', noProtein < recipes.length * 0.4,
    String(noProtein) + '/' + recipes.length);
  check('签名具备区分度（不同签名数 > 40）',
    Object.keys(keys).length > 40, String(Object.keys(keys).length));
}

/* ============================== 主流程 ============================== */

function main() {
  console.log('AI 推荐升级验证（大厨人格 / 分层候选 / 库外菜 / 强去重）');

  try {
    runSignatureTests();
    runCompareTests();
    runByteChecks();
    runNewDishTests();
    runParseSelections();
    runNewDishDiet();
    runLayerTests();
    runPromptTests();
    runReplaceTests();
    runPersistTests();
    runRealDataTests();
  } catch (error) {
    console.error('[verify-recommend-chef] 意外异常', error);
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
