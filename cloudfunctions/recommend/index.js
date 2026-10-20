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
 *   4. AI 调用由 ai-service 统一管理（内置或自定义），不在此处直连 API；
 *   5. 营养值由 Phase 5 营养计算得出，不信任 AI 输出；
 *   6. 日志不记录 API Key、Authorization 头或完整请求体。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const _ = db.command;

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

/** 在 YYYY-MM-DD 基础上加天数，用于计算临期区间 */
function shiftDate(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00.000Z');
  if (isNaN(d.getTime())) return dateStr;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
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
 * 取前 N 条即可；全部塞进去会明显拖慢预填充，对选菜质量帮助有限。
 * 取 40（而非更少）是为了给模型足够的换菜空间：候选太窄时，
 * 模型只能在小批常见菜里反复选择。
 */
const MAX_PROMPT_CANDIDATES = 40;

/** 近期菜单回看的自然日天数 */
const RECENT_MENU_DAYS = 7;

/** 最多读取几份近期菜单 */
const MAX_RECENT_MENUS = 10;

/** 近期做过的菜仍保留少量在候选末尾，供用户「明确想吃」时使用 */
const RECENT_CANDIDATE_LIMIT = 5;

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
function toCandidateSummary(recipe, inventoryNames, recentIds) {
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
    // 近 7 天是否已经做过：只作为模型判断依据，不落库、不返回前端
    recentlyUsed: recentIds ? recentIds.has(recipe._id) : false,
  };
}

/**
 * 读取该家庭最近 7 天的菜单记录。
 * 集合缺失时降级为空数组——历史菜单只是推荐的辅助信息，不能阻断推荐。
 */
async function loadRecentMenus(familyId) {
  const since = new Date(Date.now() - RECENT_MENU_DAYS * 24 * 60 * 60 * 1000).toISOString();
  try {
    const result = await db.collection('menus')
      .where({ familyId, createdAt: _.gte(since) })
      .orderBy('createdAt', 'desc')
      .limit(MAX_RECENT_MENUS)
      .get();
    return result.data || [];
  } catch (e) {
    // 历史菜单只用于避免重复，任何读取问题都降级为空，不阻断推荐
    if (!isCollectionMissing(e)) {
      console.warn('[recommend] 读取近期菜单失败，已跳过历史去重', e && e.message);
    }
    return [];
  }
}

/** 近期菜单里出现过的 recipeId，用于给候选打 recentlyUsed 标记 */
function collectRecentIds(recentMenus) {
  const ids = new Set();
  (recentMenus || []).forEach((menu) => {
    (menu.items || []).forEach((item) => {
      if (item && item.recipeId) ids.add(item.recipeId);
    });
  });
  return ids;
}

/**
 * 近期菜单摘要：只保留日期、餐次、菜名和主要食材。
 * 不传完整菜品结构与做法，避免提示词过长。
 */
function summarizeRecentMenus(recentMenus) {
  const seen = new Set();
  const list = [];
  (recentMenus || []).forEach((menu) => {
    const dishes = (menu.items || [])
      .map((item) => (item && item.name ? String(item.name).trim() : ''))
      .filter(Boolean);
    if (dishes.length === 0) return;

    const date = (menu.createdAt || '').slice(0, 10);
    const key = date + '|' + dishes.join('|');
    if (seen.has(key)) return;
    seen.add(key);

    const ingredients = [];
    (menu.items || []).forEach((item) => {
      (item.ingredients || []).forEach((ing) => {
        const name = (ing && ing.name ? String(ing.name).trim() : '');
        if (name && name.indexOf('适量') === -1 && ingredients.indexOf(name) === -1) {
          ingredients.push(name);
        }
      });
    });

    list.push({
      date: date,
      mealType: menu.mealType || '',
      dishes: dishes.slice(0, 5),
      mainIngredients: ingredients.slice(0, 8),
    });
  });
  return list;
}

/** 把字符串散列成非负整数，用于让不同请求拿到不同候选顺序 */
function hashSeed(text) {
  const source = String(text || '');
  let hash = 0;
  for (let i = 0; i < source.length; i++) {
    hash = (hash * 31 + source.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/** 按 seed 旋转数组：内容不变，只改变顺序 */
function rotateList(list, seed) {
  if (!list || list.length <= 1) return list || [];
  const offset = seed % list.length;
  if (offset === 0) return list.slice();
  return list.slice(offset).concat(list.slice(0, offset));
}

/**
 * 从候选池中挑出写进提示词的菜品。
 *
 * 直接取「匹配度前 40」会让番茄蛋汤这类高匹配常见菜长期占据列表头部，
 * 模型因此反复推荐它们。这里改为：
 *   1. 高匹配的前 60% 固定保留，保证库存利用率；
 *   2. 剩余名额从其余候选里按请求种子轮转抽取，扩大选择面；
 *   3. 最终整体再轮转一次，削弱模型的位置偏好。
 */
function pickPromptCandidates(candidates, limit, seed) {
  if (!candidates || candidates.length <= limit) {
    return rotateList(candidates || [], seed);
  }

  const headCount = Math.max(1, Math.ceil(limit * 0.5));
  const head = candidates.slice(0, headCount);
  const rest = rotateList(candidates.slice(headCount), seed);
  const picked = head.concat(rest.slice(0, limit - headCount));
  return rotateList(picked, seed);
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

  // 3. 读取家庭食材、菜谱库与近期菜单
  let ingredients;
  let recipes;
  let recentMenuIds = new Set();
  let recentMenusForPrompt = [];

  // 3 + 4. 食材与菜谱库互不依赖，并行读取，省一次数据库往返（对 AI 调用前的等待时间敏感）
  try {
    const [ingResult, recipeResult, recentResult] = await Promise.all([
      db.collection('ingredients').where({ familyId }).limit(200).get(),
      db.collection('recipes').where({ source: 'builtin', isActive: true }).limit(200).get(),
      loadRecentMenus(familyId),
    ]);

    // Phase B：已过期的食材不参与推荐，避免拿坏掉的菜去匹配
    const allIngredients = ingResult.data || [];
    const filtered = filterExpired(allIngredients, todayInBeijing());
    ingredients = filtered.kept;
    if (filtered.skipped > 0) {
      console.log('[recommend] 已跳过 ' + filtered.skipped + ' 种过期食材');
    }
    recipes = recipeResult.data || [];

    const recentIds = collectRecentIds(recentResult);
    const recentSummary = summarizeRecentMenus(recentResult);
    recentMenuIds = recentIds;
    recentMenusForPrompt = recentSummary;
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
  //    近 7 天已经做过的菜排到末尾：仍保留少量，供「用户明确想吃」时选择，
  //    但不再占据候选前列。
  const scored = dietFiltered.kept
    .filter((r) => !excludeIds.has(r._id))
    .map((r) => toCandidateSummary(r, inventoryNames, recentMenuIds))
    .sort((a, b) => {
      const aScore = a.totalIngredients > 0 ? a.matchedIngredients / a.totalIngredients : 0;
      const bScore = b.totalIngredients > 0 ? b.matchedIngredients / b.totalIngredients : 0;
      return bScore - aScore;
    });

  const freshCandidates = scored.filter((c) => !c.recentlyUsed).slice(0, MAX_CANDIDATES);
  const recentCandidates = scored.filter((c) => c.recentlyUsed).slice(0, RECENT_CANDIDATE_LIMIT);
  const candidates = freshCandidates.concat(recentCandidates);

  if (candidates.length === 0) {
    return fail('NO_CANDIDATES', '没有找到可推荐的菜谱');
  }

  // 只把一部分候选写进提示词，并按请求变化轮转，避免模型长期只看到同一批常见菜；
  // 近期菜固定放在末尾，并带 recentlyUsed 标记。
  const freshQuota = Math.max(1, MAX_PROMPT_CANDIDATES - recentCandidates.length);
  const promptCandidates = pickPromptCandidates(
    freshCandidates,
    freshQuota,
    hashSeed(event.requestId || String(Date.now())),
  ).concat(recentCandidates);

  // 6. 构建 AI 提示词
  //    库存数量字段是 quantity（不是 amount），否则会全部显示 0，模型无法判断余量
  const inventoryList = ingredients
    .map((i) => {
      const quantity = i.quantity !== undefined ? i.quantity : (i.amount || 0);
      return (i.standardName || i.name) + '（' + quantity + (i.unit || 'g') + '）';
    })
    .join('、') || '暂无食材';

  // 临期食材（3 天内到期，已过期的在读取阶段被过滤掉）
  const today = todayInBeijing();
  const expiringList = ingredients
    .filter((i) => i.expireDate && i.expireDate >= today && i.expireDate <= shiftDate(today, 3))
    .map((i) => i.standardName || i.name)
    .join('、') || '无';

  const systemPrompt = [
    '你是一名家庭饮食规划助手。',
    '请根据本次家庭需求、餐次、冰箱可用食材、烹饪条件和历史菜单，从候选菜谱中选择菜品，推荐 ' + MENU_COUNT + ' 套合理、多样、实际可做的家常菜单。',
    '',
    '【多样性要求】',
    buildRequirementText([
      '不要默认推荐番茄炒蛋、番茄鸡蛋汤、番茄蛋汤等常见菜，也不要在多套菜单里重复同一道菜；',
      '同一套菜单里，最多出现 1 道以鸡蛋为主要蛋白质的菜，最多 1 道番茄类菜品，避免食材组合雷同；',
      '番茄和鸡蛋是正常食材，可以推荐，但不能因为常见或库存里有就反复组合成番茄鸡蛋类菜品；',
      '先检查「最近菜单」：尽量避开近 7 天出现过的菜；不仅比较菜名，还要比较主要食材和烹饪方式是否高度相似；',
      '「番茄炒蛋 / 西红柿炒鸡蛋」「番茄蛋汤 / 番茄鸡蛋汤 / 西红柿蛋汤」视为同一道菜；',
      '候选充足时，优先选择与近期菜单不同的菜，并在合理范围内改变蛋白质来源、蔬菜搭配和烹饪方式；',
      '用户本次明确提出的菜品优先，以上多样性规则不得覆盖用户的明确要求；',
      '不得为了追求变化而推荐不合理、不符合家庭口味或无法实际制作的菜。',
    ]),
    '',
    '【搭配与库存要求】',
    buildRequirementText([
      '每套菜单包含 1~3 道菜，尽量荤素搭配；',
      '在不违反多样性的前提下，优先选择能利用现有食材的菜谱（matchedIngredients 越多的越好）；',
      '结合餐次（' + MEAL_TYPE_LABELS[mealType] + '）选择合适菜品；',
      '现有食材不足以组成完整菜单时，可以推荐需要额外采购食材的菜谱；',
      '额外采购的食材应是常见易买的，且每套菜单新增食材尽量少；',
      '三套菜单之间菜品不重复，且尽量覆盖不同的现有食材；',
      '不得虚构库存中不存在的食材；缺少关键食材的菜品需要如实标注为需采购。',
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
    '输出前请在内部检查：是否与近期菜单重复、是否多道菜食材组合雷同、是否因常见菜偏好而过度推荐番茄鸡蛋类菜品。检查过程不必输出。',
    '只输出 JSON，不要输出解释、Markdown 代码围栏或其他内容。',
  ].join('\n');

  const userPrompt = [
    '当前家庭食材：' + inventoryList,
    '临期食材（3 天内到期，可优先使用，但不得虚构）：' + expiringList,
    '',
    '最近 ' + RECENT_MENU_DAYS + ' 天菜单（用于避免重复，可能为空）：',
    JSON.stringify(recentMenusForPrompt),
    '',
    '请结合最近菜单历史，尽量避免重复近期出现的菜品及相似食材组合。',
    '不要默认推荐番茄炒蛋、番茄鸡蛋汤等常见菜。番茄和鸡蛋可以正常使用，但不能因为其常见而反复推荐。',
    '候选中的 recentlyUsed=true 表示近 7 天已经做过，除非用户明确要求，否则优先选择其他菜。',
    '请根据本次库存、家庭需求和历史菜单重新选择合理的菜品。',
    '',
    '候选菜谱列表（JSON）：',
    JSON.stringify(promptCandidates.map((c) => ({
      id: c.id,
      name: c.name,
      category: c.category,
      difficulty: c.difficulty,
      cookTime: c.cookTime + '分钟',
      servings: c.servings + '人份',
      ingredients: c.ingredients,
      matchedIngredients: c.matchedIngredients,
      missingIngredients: c.missingIngredients,
      recentlyUsed: c.recentlyUsed,
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
  // 跨菜单去重：同一道菜不在多套菜单里重复出现，避免「三套菜单看起来一模一样」
  const usedAcrossMenus = new Set();
  for (const menu of parsed.menus) {
    if (!menu.title || !Array.isArray(menu.recipeIds)) continue;

    // 校验每个 recipeId 都在安全候选里；命中过敏原 / 忌口的一律丢弃并计数
    const validIds = [];
    for (const id of menu.recipeIds) {
      if (blockedIds.has(id)) {
        blockedAfterAi += 1;
        continue;
      }
      if (!recipeMap[id]) continue;
      if (usedAcrossMenus.has(id)) continue;
      usedAcrossMenus.add(id);
      validIds.push(id);
    }
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