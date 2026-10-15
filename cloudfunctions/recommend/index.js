/**
 * recommend 云函数 · AI 智能推荐（Phase 7）
 *
 * 职责：
 *   recommendMenus —— 根据家庭食材与现有菜谱库，AI 推荐 3 套菜单
 *
 * 后续阶段保留：
 *   generateRecommendations / replaceDish —— 仍为桩
 *
 * 安全：
 *   1. 身份只来自 cloud.getWXContext().OPENID；
 *   2. 必须经 requireFamilyMember 复核家庭归属；
 *   3. 食材和菜谱以服务端 DB 数据为准，不信任客户端提交的内容；
 *   4. AI 调用使用用户自配的 API 密钥，从 user_ai_configs 解密后使用；
 *   5. 营养值由 Phase 5 营养计算得出，不信任 AI 输出；
 *   6. 日志不记录 API Key、Authorization 头或完整请求体。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const {
  chatCompletion,
  extractJson,
  attemptJsonRepair,
  AI_CALL_TIMEOUT_MS,
} = require('./openai-compatible-client');

const aiService = require('./ai-service');

/* ============================== 统一响应 ============================== */

function ok(data) {
  return { success: true, data: data === undefined ? null : data, error: null };
}

function fail(code, message, details) {
  return {
    success: false,
    data: null,
    code: code,
    message: message,
    error: { code: code, message: message },
    details: details || null,
  };
}

/* ============================== 基础工具 ============================== */

/** 云数据库「集合不存在」错误码 */
const ERR_COLLECTION_NOT_EXIST = -502005;

function isCollectionMissing(err) {
  return err && (err.errCode === ERR_COLLECTION_NOT_EXIST ||
    (typeof err.message === 'string' && err.message.indexOf('not exist') !== -1));
}

function generateId() {
  return Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

function toIsoString(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  return d.toISOString();
}

/* ============================== 食材过期过滤（Phase B） ============================== */

const { todayInBeijing, filterExpired } = require('./shelf-filter');

/* ============================== 过敏原 / 忌口硬过滤（Phase E2） ============================== */

const { buildDiet, filterRecipes, summarizeDiet } = require('./diet-filter');

/* ============================== 用户与家庭校验 ============================== */

async function findUserByOpenid(openid) {
  const result = await db.collection('users').where({ openid }).limit(1).get();
  return result.data[0] || null;
}

/**
 * 家庭身份校验：openid → users → family_members，确认用户属于该家庭
 */
async function requireFamilyMember(openid, familyId) {
  if (!familyId) {
    return { error: fail('INVALID_PARAMS', '缺少 familyId') };
  }

  const user = await findUserByOpenid(openid);
  if (!user) {
    return { error: fail('UNAUTHORIZED', '请先登录') };
  }

  const memberResult = await db
    .collection('family_members')
    .where({ familyId, userId: user._id })
    .limit(1)
    .get();
  const member = memberResult.data[0];
  if (!member) {
    return { error: fail('NOT_IN_FAMILY', '你不是该家庭的成员') };
  }

  return { user, member };
}

/**
 * 读取家庭偏好（Phase E2）。
 * families 文档不存在或读取失败时按「无偏好」处理，不阻塞推荐；
 * 过敏原硬过滤依赖这里返回的 allergens / avoidIngredients。
 */
async function loadFamilyPreferences(familyId) {
  try {
    const res = await db.collection('families').doc(familyId).get();
    const family = res && res.data;
    return (family && family.preferences) || {};
  } catch (e) {
    if (!isCollectionMissing(e)) {
      console.error('[recommend] 读取家庭偏好失败，按无偏好处理', e && e.message);
    }
    return {};
  }
}

/* ============================== 业务约束 ============================== */

/** 候选菜谱数量上限 */
const MAX_CANDIDATES = 50;

/**
 * 真正写进提示词的候选数量。
 * 候选列表已按食材匹配度降序排列，取前 N 条即可；全部塞进去会明显拖慢预填充，
 * 对选菜质量帮助有限。
 */
const MAX_PROMPT_CANDIDATES = 25;

/** 每次推荐的菜单套数 */
const MENU_COUNT = 3;

/** 单次模型输出 token 上限 */
const MAX_OUTPUT_TOKENS = 2048;

/** 餐次映射 */
const MEAL_TYPE_LABELS = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  midnight_snack: '夜宵',
};

/* ============================== 菜谱摘要 ============================== */

/**
 * 将菜谱文档转为 AI 提示词用的精简摘要。
 * 只包含 AI 选菜需要的信息，不包含完整步骤。
 */
function toCandidateSummary(recipe, inventoryNames) {
  const ingredientNames = (recipe.ingredients || []).map((i) => i.name);
  const matched = ingredientNames.filter((n) => inventoryNames.has(n));
  const missing = ingredientNames.filter((n) => !inventoryNames.has(n));

  return {
    id: recipe._id,
    name: recipe.name,
    category: recipe.category,
    difficulty: recipe.difficulty,
    cookTime: recipe.cookTime,
    servings: recipe.servings,
    ingredients: ingredientNames,
    // 匹配度辅助信息
    totalIngredients: ingredientNames.length,
    matchedIngredients: matched.length,
    missingIngredients: missing,
  };
}

/**
 * 将菜谱文档转为详情视图（返回给前端）
 */
function toRecipeView(recipe) {
  return {
    _id: recipe._id,
    name: recipe.name,
    description: recipe.description,
    category: recipe.category,
    tags: recipe.tags || [],
    difficulty: recipe.difficulty,
    cookTime: recipe.cookTime,
    servings: recipe.servings,
    ingredients: (recipe.ingredients || []).map((i) => ({
      name: i.name,
      amount: i.amount,
      unit: i.unit,
    })),
  };
}

/* ============================== AI 推荐 ============================== */

/**
 * 把「固定要求 + 可选要求」拼成带序号的提示词要求列表。
 * 可选行为空时会被剔除，序号仍然连续，避免出现「5. 」后直接跳到「7. 」。
 */
function buildRequirementText(baseLines, optionalLines) {
  const lines = [];
  (baseLines || []).forEach((line) => {
    if (line) lines.push(line);
  });
  (optionalLines || []).forEach((line) => {
    if (line) lines.push(line);
  });
  return lines.map((line, index) => (index + 1) + '. ' + line).join('\n');
}

/**
 * 根据家庭食材和菜谱库，通过 AI 推荐 3 套菜单。
 *
 * 入参：
 *   mealType   —— 餐次
 *   servings   —— 用餐人数
 *   preferences —— 口味/偏好（可选）
 *   excludeRecipeIds —— 排除的菜谱 ID（可选）
 *
 * 服务端自行读取：家庭食材、菜谱库、AI 配置。
 */
async function handleRecommendMenus(event, wxContext) {
  const openid = wxContext.OPENID || '';

  // 1. 身份校验
  // 家庭偏好只依赖 familyId，与成员校验无依赖关系，并行发起以省一次数据库往返
  const familyId = event.familyId || '';
  const authPromise = requireFamilyMember(openid, familyId);
  const prefsPromise = loadFamilyPreferences(familyId);
  const auth = await authPromise;
  if (auth.error) {
    // 成员校验失败时不再等待偏好读取结果，避免无谓挂起
    void prefsPromise.catch(() => {});
    return auth.error;
  }
  const user = auth.user;

  // E2：家庭偏好是过敏原 / 忌口硬过滤的唯一来源，只读服务端数据，不信任客户端
  const familyPrefs = await prefsPromise;
  const diet = buildDiet(familyPrefs);
  const tasteHint = Array.isArray(familyPrefs.taste)
    ? familyPrefs.taste.filter((item) => typeof item === 'string' && item.trim()).join('、')
    : '';

  // 2. 解析入参
  const mealType = event.mealType || 'dinner';
  if (!MEAL_TYPE_LABELS[mealType]) {
    return fail('INVALID_PARAMS', '无效的餐次：' + mealType);
  }

  const servings = Number(event.servings) || 2;
  if (!Number.isInteger(servings) || servings < 1 || servings > 20) {
    return fail('INVALID_PARAMS', '人数需在 1~20 之间');
  }

  const preferences = (event.preferences || '').trim();
  const excludeIds = new Set((event.excludeRecipeIds || []).filter((id) => typeof id === 'string' && id.length > 0));

  // 3. 读取家庭食材
  let ingredients;
  let recipes;

  // 3 + 4. 食材与菜谱库互不依赖，并行读取，省一次数据库往返（对 AI 调用前的等待时间敏感）
  try {
    const [ingResult, recipeResult] = await Promise.all([
      db.collection('ingredients').where({ familyId }).limit(200).get(),
      db.collection('recipes').where({ source: 'builtin', isActive: true }).limit(200).get(),
    ]);

    // Phase B：已过期的食材不参与推荐，避免拿坏掉的菜去匹配
    const allIngredients = ingResult.data || [];
    const filtered = filterExpired(allIngredients, todayInBeijing());
    ingredients = filtered.kept;
    if (filtered.skipped > 0) {
      console.log('[recommend] 已跳过 ' + filtered.skipped + ' 种过期食材');
    }
    recipes = recipeResult.data || [];
  } catch (e) {
    if (isCollectionMissing(e)) {
      // 无法区分是哪个集合缺失时，给出包含两者的提示
      return fail('DB_NOT_READY', '数据库集合 ingredients 或 recipes 不存在，请先在云开发控制台创建');
    }
    throw e;
  }

  const inventoryNames = new Set(ingredients.map((i) => (i.standardName || i.name || '').trim()).filter(Boolean));

  if (recipes.length === 0) {
    return fail('NO_RECIPES', '菜谱库还是空的，请先初始化菜谱数据');
  }

  // 4.1 E2：先按家庭过敏原 / 忌口做程序硬过滤，AI 只能看到过滤后的安全菜谱
  const dietFiltered = filterRecipes(recipes, diet);
  const blockedIds = new Set(dietFiltered.blocked.map((item) => item.recipeId));
  if (blockedIds.size > 0) {
    console.log('[recommend] 过敏原/忌口已过滤 ' + blockedIds.size + ' 道菜');
  }
  if (diet.rules.length > 0 && dietFiltered.kept.length === 0) {
    return fail('DIET_BLOCKED', '按家庭过敏原与忌口过滤后已没有可推荐的菜谱，请调整家庭偏好');
  }

  // 5. 生成候选列表（只用安全菜谱）
  const candidates = dietFiltered.kept
    .filter((r) => !excludeIds.has(r._id))
    .map((r) => toCandidateSummary(r, inventoryNames))
    .sort((a, b) => {
      // 优先食材匹配度高的
      const aScore = a.totalIngredients > 0 ? a.matchedIngredients / a.totalIngredients : 0;
      const bScore = b.totalIngredients > 0 ? b.matchedIngredients / b.totalIngredients : 0;
      return bScore - aScore;
    })
    .slice(0, MAX_CANDIDATES);

  if (candidates.length === 0) {
    return fail('NO_CANDIDATES', '没有找到可推荐的菜谱');
  }

  // 6. 构建 AI 提示词
  const inventoryList = ingredients
    .map((i) => `${i.standardName || i.name}（${i.amount || 0}${i.unit || 'g'}）`)
    .join('、') || '暂无食材';

  const systemPrompt = [
    '你是一个家庭饮食推荐助手。',
    '请根据以下信息，从提供的候选菜谱中选择菜品，推荐 ' + MENU_COUNT + ' 套不同的菜单组合。',
    '',
    '要求：',
    buildRequirementText([
      '每套菜单包含 1~3 道菜，尽量荤素搭配；',
      '优先选择能利用现有食材的菜谱（matchedIngredients 越多的越好）；',
      '结合餐次（' + MEAL_TYPE_LABELS[mealType] + '）选择合适菜品；',
      '现有食材不足以组成完整菜单时，可以推荐需要额外采购食材的菜谱；',
      '额外采购的食材应是常见易买的，且每套菜单新增食材尽量少；',
      '三套菜单之间菜品不重复，且尽量覆盖不同的现有食材；',
    ], [
      preferences ? '遵守以下饮食偏好：' + preferences : '',
      tasteHint ? '家庭口味偏好：' + tasteHint : '',
      diet.allergenTags.length > 0
        ? '严禁选择含以下过敏原的菜品：' + diet.allergenTags.join('、')
        : '',
      diet.avoidTags.length > 0
        ? '严禁选择家庭忌口的菜品：' + diet.avoidTags.join('、')
        : '',
    ]),
    '',
    '只输出 JSON，不要输出解释、Markdown 代码围栏或其他内容。',
  ].join('\n');

  const userPrompt = [
    '当前家庭食材：' + inventoryList,
    '',
    '候选菜谱列表（JSON）：',
    JSON.stringify(candidates.slice(0, MAX_PROMPT_CANDIDATES).map((c) => ({
      id: c.id,
      name: c.name,
      category: c.category,
      difficulty: c.difficulty,
      cookTime: c.cookTime + '分钟',
      servings: c.servings + '人份',
      ingredients: c.ingredients,
      matchedIngredients: c.matchedIngredients,
      missingIngredients: c.missingIngredients,
    }))),
    '',
    '请以 JSON 格式返回 ' + MENU_COUNT + ' 套菜单，格式如下：',
    '{' +
      '"menus": [' +
        '{' +
          '"title": "菜单名称",' +
          '"reason": "推荐理由（一句话）",' +
          '"recipeIds": ["recipe_id_1", "recipe_id_2"]' +
        '}' +
      ']' +
    '}',
  ].join('\n');

  // 7. 调用 AI（凭据解析、额度扣减、用量日志均在 runAiCall 内完成）
  let aiText;
  try {
    aiText = await aiService.runAiCall(
      db,
      user._id,
      { action: 'recommendMenus', requestId: event.requestId || '' },
      (aiConfig) => chatCompletion(
        aiConfig,
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        { temperature: 0.7, max_tokens: MAX_OUTPUT_TOKENS, timeoutMs: AI_CALL_TIMEOUT_MS },
      ),
    );
  } catch (e) {
    // 模式相关错误（内置未就绪 / 额度用尽 / 未配置）：文案由 ai-service 统一维护
    if (aiService.friendlyAiMessage(e.code)) {
      return fail(e.code, aiService.friendlyAiMessage(e.code));
    }
    // 映射 AI 调用错误
    const errorMessages = {
      'AI_AUTH_FAILED': '模型认证失败，请检查 API 配置',
      'AI_CONNECTION_FAILED': '无法连接到模型服务，请检查 API 地址',
      'AI_NOT_FOUND': '模型不存在，请检查模型名称',
      'AI_TIMEOUT': '模型响应超时。请稍后重试；若持续出现，请在「模型 API 设置」中改用响应更快的模型',
      'AI_EMPTY_RESPONSE': '模型没有返回有效内容，请检查该模型是否兼容 OpenAI 对话接口',
      'AI_REQUEST_FAILED': '模型请求失败，请检查 API 配置',
      'DECRYPT_FAILED': '密钥解密失败，请重新配置 API Key',
    };
    const friendly = errorMessages[e.code] || e.message || 'AI 调用失败';
    return fail('AI_FAILED', friendly);
  }

  // 8. 解析 AI 输出
  let parsed = extractJson(aiText);
  if (!parsed) {
    // 尝试一次修复
    parsed = attemptJsonRepair(aiText);
  }

  if (!parsed || !Array.isArray(parsed.menus)) {
    return fail('AI_FORMAT_ERROR', '模型返回格式不正确，请稍后重试或检查 API 兼容性');
  }

  // 9. 校验结果（只接受过滤后的安全菜谱）
  const recipeMap = {};
  for (const r of dietFiltered.kept) {
    recipeMap[r._id] = r;
  }

  let blockedAfterAi = 0;
  const validMenus = [];
  for (const menu of parsed.menus) {
    if (!menu.title || !Array.isArray(menu.recipeIds)) continue;

    // 校验每个 recipeId 都在安全候选里；命中过敏原 / 忌口的一律丢弃并计数
    const validIds = menu.recipeIds.filter((id) => {
      if (blockedIds.has(id)) {
        blockedAfterAi += 1;
        return false;
      }
      return !!recipeMap[id];
    });
    if (validIds.length === 0) continue;

    const items = validIds.map((id) => toRecipeView(recipeMap[id]));

    // 服务端自行计算「还需采购的食材」，不采信 AI 输出：
    // 汇总该套菜单所有菜品的食材，去掉库存中已有的，剩下的即为需新增的食材。
    const menuIngredientNames = new Set();
    for (const item of items) {
      for (const ing of item.ingredients || []) {
        const name = (ing.name || '').trim();
        if (name) menuIngredientNames.add(name);
      }
    }
    const missingIngredients = [];
    for (const name of menuIngredientNames) {
      if (!inventoryNames.has(name)) missingIngredients.push(name);
    }
    const matchedCount = menuIngredientNames.size - missingIngredients.length;

    validMenus.push({
      title: menu.title,
      reason: menu.reason || '',
      recipeIds: validIds,
      items: items,
      totalCookTime: items.reduce((sum, item) => sum + (item.cookTime || 0), 0),
      // 库存覆盖情况：供前端展示「现有食材可做 / 还需采购 N 种」
      inventoryMatchedCount: matchedCount,
      missingCount: missingIngredients.length,
      missingIngredients: missingIngredients,
      fullyCovered: missingIngredients.length === 0,
    });

    if (validMenus.length >= MENU_COUNT) break;
  }

  if (validMenus.length === 0) {
    return fail('AI_FORMAT_ERROR', '模型推荐的菜谱均不可用，请重试');
  }

  const recommendationId = generateId();

  return ok({
    recommendationId: recommendationId,
    mealType: mealType,
    servings: servings,
    inventoryCount: ingredients.length,
    candidateCount: candidates.length,
    diet: summarizeDiet(diet, dietFiltered.blocked),
    blockedByDietAfterAi: blockedAfterAi,
    menus: validMenus,
    createdAt: new Date().toISOString(),
  });
}

/* ============================== 业务路由 ============================== */

const handlers = {
  ping() {
    return ok({ function: 'recommend', status: 'ok', time: Date.now() });
  },

  recommendMenus: handleRecommendMenus,

  /** 旧版动作，Phase 7 不实现，保留给后续阶段 */
  generateRecommendations() {
    return fail('NOT_IMPLEMENTED', 'recommend.generateRecommendations 尚未实现');
  },

  replaceDish() {
    return fail('NOT_IMPLEMENTED', 'recommend.replaceDish 尚未实现');
  },
};

/* ============================== 入口 ============================== */

exports.main = async (event = {}) => {
  const startedAt = Date.now();
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID || '';
  const action = event.action || '';
  const requestId = event.requestId || generateId();

  let response;
  try {
    const handler = Object.prototype.hasOwnProperty.call(handlers, action) ? handlers[action] : null;
    if (!handler) {
      response = fail('UNKNOWN_ACTION', '未知操作：' + action);
    } else {
      response = await handler(event, wxContext, requestId);
    }
  } catch (error) {
    if (isCollectionMissing(error)) {
      response = fail('DB_NOT_READY', '数据库集合不存在，请先在云开发控制台创建');
    } else {
      console.error('[recommend] 未捕获异常', error.code || '', error.message || '');
      response = fail('INTERNAL_ERROR', '服务内部异常，请稍后重试');
    }
  }

  // 统一日志
  console.log(
    JSON.stringify({
      functionName: 'recommend',
      requestId: requestId,
      userId: openid,
      familyId: event.familyId || '',
      action: action,
      duration: Date.now() - startedAt,
      status: response.success ? 'success' : 'fail',
      code: response.code || '',
      error: response.success ? '' : (response.message || ''),
    }),
  );

  return response;
};