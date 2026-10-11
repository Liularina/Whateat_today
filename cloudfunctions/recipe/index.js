/**
 * recipe 云函数 · 基础菜谱库（Phase 6）+ AI 生成做法（Phase 10）
 *
 * 职责：
 *   listRecipes  —— 菜谱列表（分类筛选 / 关键词搜索 / 分页）
 *   getRecipe    —— 菜谱详情
 *   generateCookingSteps —— AI 生成详细烹饪步骤（Phase 10）
 *   seedRecipes  —— 初始化内置菜谱
 *
 * 安全与边界：
 *   1. 内置菜谱是公共只读数据，查询不要求登录、也不涉及家庭权限；
 *   2. 写操作只由初始化脚本（seed-recipes.js）在开发者环境执行，
 *      云函数不提供任何菜谱写接口，客户端无法篡改内置菜谱；
 *   3. 只读 isActive = true 的菜谱，已禁用的菜谱在列表与详情中都不可见；
 *   4. AI 生成的做法保存在独立的 generated_recipes 集合，不覆盖原始菜谱；
 *   5. API Key 使用用户自配密钥，经 AES-256-GCM 解密，不落地日志。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const recipesCol = db.collection('recipes');

const {
  RECIPE_CATEGORIES,
  RECIPE_CATEGORY_ALL,
  RECIPE_PAGE_SIZE,
  RECIPE_PAGE_SIZE_MAX,
} = require('./recipe-data');

const seedRecipeLibrary = require('./seed-recipes').seedRecipes;

const {
  readFullAiConfig,
  chatCompletion,
  extractJson,
  attemptJsonRepair,
  AI_CALL_TIMEOUT_MS,
} = require('./openai-compatible-client');

/** 云数据库「集合不存在」错误码 */
const ERR_COLLECTION_NOT_EXIST = -502005;
/** 云数据库「文档不存在」错误码 */
const ERR_DOC_NOT_EXIST = -502002;

const DB_NOT_READY_MESSAGE = '数据库集合 recipes 不存在，请先在云开发控制台创建';

/** 关键词最大长度，与前端 constants/recipe.ts 保持一致 */
const RECIPE_KEYWORD_MAX_LENGTH = 20;

/* ------------------------------ 统一响应 ------------------------------ */

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

/* ------------------------------ 基础工具 ------------------------------ */

/**
 * 家庭身份校验：绝不直接信任前端传来的 familyId。
 * openid → users → family_members，确认用户确实属于该家庭后才允许继续。
 *
 * Phase 6 的菜谱查询是公共只读数据，用不到这个校验；
 * 保留给后续阶段（generateRecipe / retryRecipe）的按家庭操作使用。
 */
async function requireFamilyMember(openid, familyId) {
  if (!familyId) {
    return { error: fail('INVALID_PARAMS', '缺少 familyId') };
  }

  const userResult = await db.collection('users').where({ openid }).limit(1).get();
  const user = userResult.data[0];
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
    // 不泄露家庭是否存在
    return { error: fail('NOT_IN_FAMILY', '你不是该家庭的成员') };
  }

  return { user, member };
}

/** 仅家庭管理员可执行 */
function requireOwner(member) {
  if (!member || member.role !== 'owner') {
    return fail('FORBIDDEN', '只有家庭管理员可以执行该操作');
  }
  return null;
}

function isCollectionMissing(error) {
  if (!error) {
    return false;
  }
  if (error.errCode === ERR_COLLECTION_NOT_EXIST) {
    return true;
  }
  const text = String(error.errMsg || error.message || '');
  return /collection.+not exists|集合不存在/i.test(text);
}

function isDocMissing(error) {
  if (!error) {
    return false;
  }
  if (error.errCode === ERR_DOC_NOT_EXIST) {
    return true;
  }
  const text = String(error.errMsg || error.message || '');
  return /document.+not exists|document not exists|文档不存在/i.test(text);
}

function toIsoString(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    return value;
  }
  return '';
}

/**
 * 转义正则元字符。
 * 关键词来自用户输入，直接拼进 db.RegExp 会被当成正则执行，
 * 既可能报错也可能拖慢查询，必须先转义。
 */
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ------------------------------ 出参裁剪 ------------------------------ */

/**
 * 列表项：只保留列表页需要的字段。
 * 食材与步骤只在详情里返回，避免列表一次传回大量用不到的数据。
 */
function toRecipeSummary(doc) {
  return {
    _id: doc._id,
    name: doc.name || '',
    description: doc.description || '',
    category: doc.category || '',
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    difficulty: doc.difficulty || 'easy',
    cookTime: Number(doc.cookTime) || 0,
    servings: Number(doc.servings) || 0,
  };
}

/** 详情：在摘要基础上补全食材与步骤 */
function toRecipeDetail(doc) {
  const summary = toRecipeSummary(doc);

  const ingredients = (Array.isArray(doc.ingredients) ? doc.ingredients : []).map((item) => ({
    name: (item && item.name) || '',
    amount: Number(item && item.amount) || 0,
    unit: (item && item.unit) || '',
  }));

  const steps = (Array.isArray(doc.steps) ? doc.steps : [])
    .map((item, index) => ({
      step: Number(item && item.step) || index + 1,
      description: (item && item.description) || '',
      minutes: Number(item && item.minutes) || 0,
    }))
    .sort((a, b) => a.step - b.step);

  return Object.assign(summary, {
    ingredients: ingredients,
    steps: steps,
    source: doc.source || 'builtin',
    isActive: doc.isActive !== false,
    createdAt: toIsoString(doc.createdAt),
    updatedAt: toIsoString(doc.updatedAt),
  });
}

/* ------------------------------ 入参校验 ------------------------------ */

/**
 * 解析并校验列表入参。
 * 服务端不信任前端：类型、范围、枚举全部独立校验一次。
 */
function parseListParams(event) {
  const rawCategory = event.category === undefined || event.category === null ? '' : String(event.category).trim();
  const category = rawCategory === RECIPE_CATEGORY_ALL ? '' : rawCategory;
  if (category && RECIPE_CATEGORIES.indexOf(category) === -1) {
    return { error: fail('INVALID_PARAMS', '分类不存在：' + category) };
  }

  const keyword = event.keyword === undefined || event.keyword === null ? '' : String(event.keyword).trim();
  if (keyword.length > RECIPE_KEYWORD_MAX_LENGTH) {
    return { error: fail('INVALID_PARAMS', '关键词不能超过 ' + RECIPE_KEYWORD_MAX_LENGTH + ' 个字') };
  }

  const page = event.page === undefined || event.page === null ? 1 : Number(event.page);
  if (!Number.isInteger(page) || page < 1) {
    return { error: fail('INVALID_PARAMS', 'page 必须是不小于 1 的整数') };
  }

  const pageSize =
    event.pageSize === undefined || event.pageSize === null ? RECIPE_PAGE_SIZE : Number(event.pageSize);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > RECIPE_PAGE_SIZE_MAX) {
    return {
      error: fail('INVALID_PARAMS', 'pageSize 必须是 1 到 ' + RECIPE_PAGE_SIZE_MAX + ' 之间的整数'),
    };
  }

  return { value: { category, keyword, page, pageSize } };
}

/* ------------------------------ 业务处理 ------------------------------ */

/**
 * 菜谱列表。
 * 只返回启用的内置菜谱（source = 'builtin'）。
 * 说明：本阶段列表页就是「内置家常菜谱库」，用户自建菜谱要到后续阶段才支持；
 * 届时需要放宽这里的 source 过滤，否则自建菜谱会查不到。
 */
async function listRecipes(event) {
  const parsed = parseListParams(event);
  if (parsed.error) {
    return parsed.error;
  }

  const { category, keyword, page, pageSize } = parsed.value;

  const condition = { source: 'builtin', isActive: true };
  if (category) {
    condition.category = category;
  }
  if (keyword) {
    condition.name = db.RegExp({ regexp: escapeRegExp(keyword), options: 'i' });
  }

  try {
    const countResult = await recipesCol.where(condition).count();
    const total = Number(countResult.total) || 0;

    const items = [];
    if (total > 0) {
      const res = await recipesCol
        .where(condition)
        .orderBy('name', 'asc')
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .get();
      for (const doc of res.data || []) {
        items.push(toRecipeSummary(doc));
      }
    }

    return ok({ items: items, total: total, page: page, pageSize: pageSize });
  } catch (error) {
    if (isCollectionMissing(error)) {
      return fail('DB_NOT_READY', DB_NOT_READY_MESSAGE);
    }
    throw error;
  }
}

/**
 * 菜谱详情。
 * 按 _id 精确查询，已禁用的菜谱按「不存在」处理，不泄露其存在。
 */
async function getRecipe(event) {
  const recipeId = event.recipeId === undefined || event.recipeId === null ? '' : String(event.recipeId).trim();
  if (!recipeId) {
    return fail('INVALID_PARAMS', '缺少 recipeId');
  }

  let doc = null;
  try {
    const res = await recipesCol.doc(recipeId).get();
    doc = res && res.data ? res.data : null;
  } catch (error) {
    if (isCollectionMissing(error)) {
      return fail('DB_NOT_READY', DB_NOT_READY_MESSAGE);
    }
    if (isDocMissing(error)) {
      return fail('RECIPE_NOT_FOUND', '菜谱不存在或已下架');
    }
    throw error;
  }

  if (!doc || doc.isActive === false) {
    return fail('RECIPE_NOT_FOUND', '菜谱不存在或已下架');
  }

  return ok({ recipe: toRecipeDetail(doc) });
}

/* ============================== Phase 10：AI 生成做法 ============================== */

const MAX_GENERATED_STEPS_TEXT = 4096;
const MAX_OUTPUT_TOKENS = 2048;

async function handleGenerateCookingSteps(event, wxContext) {
  const openid = wxContext.OPENID || '';
  const recipeId = String(event.recipeId || '').trim();
  if (!recipeId) return fail('INVALID_PARAMS', '缺少 recipeId');

  // 读取菜谱
  let doc;
  try {
    const res = await recipesCol.doc(recipeId).get();
    doc = res && res.data ? res.data : null;
  } catch (error) {
    if (isCollectionMissing(error)) return fail('DB_NOT_READY', DB_NOT_READY_MESSAGE);
    if (isDocMissing(error)) return fail('RECIPE_NOT_FOUND', '菜谱不存在或已下架');
    throw error;
  }
  if (!doc || doc.isActive === false) return fail('RECIPE_NOT_FOUND', '菜谱不存在或已下架');

  // 检查是否已有生成结果
  try {
    const exist = await db.collection('generated_recipes')
      .where({ recipeId: recipeId, userId: openid })
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();
    if (exist.data && exist.data.length > 0) {
      return ok({
        source: 'cached',
        recipeId: recipeId,
        data: exist.data[0].data,
        createdAt: exist.data[0].createdAt,
      });
    }
  } catch (e) {
    if (!isCollectionMissing(e)) throw e;
  }

  // 读 AI 配置
  let aiConfig;
  try {
    const userResult = await db.collection('users').where({ openid }).limit(1).get();
    const user = userResult.data[0];
    if (!user) return fail('UNAUTHORIZED', '请先登录');
    aiConfig = await readFullAiConfig(db, user._id);
  } catch (e) {
    if (isCollectionMissing(e)) {
      return fail('AI_CONFIG_REQUIRED', '尚未配置模型 API，请先去设置');
    }
    throw e;
  }
  if (!aiConfig) return fail('AI_CONFIG_REQUIRED', '尚未配置模型 API');

  const servings = Number.isInteger(event.servings) && event.servings > 0 ? event.servings : (doc.servings || 2);
  const preferences = String(event.preferences || '').trim();

  // 已有数据
  const existingSteps = (Array.isArray(doc.steps) ? doc.steps : [])
    .map((s, i) => ({ step: s.step || i + 1, description: s.description || '', minutes: s.minutes || 0 }));
  const existingIngredients = (Array.isArray(doc.ingredients) ? doc.ingredients : [])
    .map((ing) => ({ name: ing.name || '', amount: ing.amount || 0, unit: ing.unit || '' }));

  const systemPrompt = [
    '你是一个专业的中餐烹饪助手。请根据提供的真实菜谱数据生成详细的烹饪做法。',
    '规则：',
    '1. 食材用量以提供的真实数据为准，可乘以份数比例调整但不得编造或替换主料；',
    '2. 烹饪步骤必须是清晰、可操作的中文描述；',
    '3. 每个步骤附带合理的时间估计（分钟），不确定时填 0；',
    '4. 包含烹饪前准备、成品判断和食品安全提示；',
    '5. 不要编造营养数据；',
    '6. 只输出 JSON，不要输出其他内容。',
    preferences ? '7. 额外要求：' + preferences : '',
    '',
    '输出格式（严格 JSON）：',
    JSON.stringify({
      introduction: '简短介绍',
      ingredients: [{ name: '食材名', amount: 200, unit: 'g' }],
      preparation: ['步骤1', '步骤2'],
      steps: [{ step: 1, description: '说明', minutes: 5 }],
      tips: ['提示'],
      safetyNotes: ['安全提示'],
    }),
  ].filter(Boolean).join('\n');

  const userPrompt = [
    '菜谱名称：' + doc.name,
    '分类：' + (doc.category || ''),
    '原适用人数：' + (doc.servings || 0),
    '当前要求人数：' + servings,
    '烹饪时间：约 ' + (doc.cookTime || 0) + ' 分钟',
    '已有食材：' + JSON.stringify(existingIngredients),
    existingSteps.length > 0 ? '已有步骤：' + JSON.stringify(existingSteps) : '',
    '请生成详细做法。',
  ].filter(Boolean).join('\n');

  let aiText;
  try {
    aiText = await chatCompletion(
      aiConfig,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      { temperature: 0.7, max_tokens: MAX_OUTPUT_TOKENS, timeoutMs: AI_CALL_TIMEOUT_MS },
    );
  } catch (e) {
    const msg = {
      'AI_AUTH_FAILED': '模型认证失败',
      'AI_CONNECTION_FAILED': '无法连接模型',
      'AI_TIMEOUT': '模型响应超时',
      'AI_REQUEST_FAILED': '请求失败',
      'DECRYPT_FAILED': '密钥解密失败',
    };
    return fail('AI_FAILED', msg[e.code] || (e.message || 'AI 调用失败'));
  }

  let parsed = extractJson(aiText);
  if (!parsed) parsed = attemptJsonRepair(aiText);

  if (!parsed || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    return fail('AI_FORMAT_ERROR', '模型返回格式不正确，请重试');
  }

  // 校验与裁剪
  parsed.steps = parsed.steps.map((s, i) => ({
    step: Number(s.step) || i + 1,
    description: String(s.description || '').slice(0, 800),
    minutes: Number.isFinite(s.minutes) ? Math.round(s.minutes) : 0,
  }));
  parsed.ingredients = (Array.isArray(parsed.ingredients) ? parsed.ingredients : []).map((i) => ({
    name: String(i.name || '').slice(0, 100),
    amount: Number.isFinite(i.amount) ? i.amount : 0,
    unit: String(i.unit || '').slice(0, 20),
  }));
  parsed.preparation = (Array.isArray(parsed.preparation) ? parsed.preparation : [])
    .map((p) => String(p || '').slice(0, 500));
  parsed.tips = (Array.isArray(parsed.tips) ? parsed.tips : []).map((t) => String(t || '').slice(0, 500));
  parsed.safetyNotes = (Array.isArray(parsed.safetyNotes) ? parsed.safetyNotes : []).map((n) => String(n || '').slice(0, 500));
  parsed.introduction = String(parsed.introduction || '').slice(0, 500);
  parsed.servings = servings;

  // 保存到 generated_recipes
  const now = new Date().toISOString();
  let savedId;
  try {
    const result = await db.collection('generated_recipes').add({
      data: {
        recipeId: recipeId,
        userId: openid,
        data: parsed,
        createdAt: now,
        updatedAt: now,
      },
    });
    savedId = result._id;
  } catch (e) {
    if (isCollectionMissing(e)) {
      return fail('DB_NOT_READY', '数据库集合 generated_recipes 不存在');
    }
    throw e;
  }

  return ok({
    source: 'generated',
    recipeId: recipeId,
    generatedId: savedId,
    data: parsed,
    createdAt: now,
  });
}

/* ------------------------------ 业务路由 ------------------------------ */

const handlers = {
  /** 健康检查：部署后可用来验证云函数是否可用 */
  ping() {
    return ok({ function: 'recipe', status: 'ok', time: Date.now() });
  },

  /** Phase 6：菜谱列表 */
  listRecipes,

  /** Phase 6：菜谱详情 */
  getRecipe,

  /** Phase 10：AI 生成详细烹饪步骤 */
  generateCookingSteps: handleGenerateCookingSteps,

  /**
   * 初始化内置菜谱（开发者用，幂等）
   * 与 Phase 5 的 seedNutritionFacts 一致：只写内置数据，不触碰用户自建菜谱。
   */
  async seedRecipes() {
    try {
      return ok(await seedRecipeLibrary(db));
    } catch (error) {
      if (isCollectionMissing(error)) {
        return fail('DB_NOT_READY', DB_NOT_READY_MESSAGE);
      }
      console.error('[recipe] 初始化内置菜谱失败', error);
      return fail('SEED_RECIPES_FAILED', '菜谱初始化失败，请稍后重试');
    }
  },

  /**
   * 按最终菜单生成做法（Phase 7/8）
   * TODO: 按开发阶段实现，服务端必须做权限校验与入参校验
   */
  generateRecipe() {
    return fail('NOT_IMPLEMENTED', 'recipe.generateRecipe 尚未实现');
  },

  /**
   * 重新生成单道菜做法（Phase 7/8）
   * TODO: 按开发阶段实现，服务端必须做权限校验与入参校验
   */
  retryRecipe() {
    return fail('NOT_IMPLEMENTED', 'recipe.retryRecipe 尚未实现');
  },

  /**
   * 查询某道菜在当前菜单下的做法（Phase 7/8）
   * TODO: 按开发阶段实现，服务端必须做权限校验与入参校验
   */
  getRecipeDetail() {
    return fail('NOT_IMPLEMENTED', 'recipe.getRecipeDetail 尚未实现');
  },
};

/* ------------------------------ 入口 ------------------------------ */

exports.main = async (event = {}) => {
  const startedAt = Date.now();
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID || '';
  const action = event.action || '';
  const requestId = event.requestId || (Date.now() + '-' + Math.random().toString(36).slice(2, 8));

  let response;
  try {
    const handler = Object.prototype.hasOwnProperty.call(handlers, action) ? handlers[action] : null;
    if (!handler) {
      response = fail('UNKNOWN_ACTION', '未知操作：' + action);
    } else {
      response = await handler(event, wxContext);
    }
  } catch (error) {
    console.error('[' + 'recipe' + '] 未捕获异常', error);
    response = fail('INTERNAL_ERROR', '服务内部异常，请稍后重试');
  }

  // 统一日志：functionName / requestId / userId / familyId / duration / status / error
  console.log(
    JSON.stringify({
      functionName: 'recipe',
      requestId: requestId,
      userId: openid,
      familyId: event.familyId || '',
      action: action,
      duration: Date.now() - startedAt,
      status: response.success ? 'success' : 'fail',
      code: response.code || '',
      error: response.success ? '' : response.message,
    }),
  );

  return response;
};
