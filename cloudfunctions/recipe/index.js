/**
 * recipe 云函数 · 基础菜谱库（Phase 6）+ AI 生成做法（Phase 10）+ 家庭菜谱库（Phase D）
 *
 * 职责：
 *   listRecipes       —— 菜谱列表（分类筛选 / 关键词搜索 / 分页）
 *   getRecipe         —— 菜谱详情
 *   generateCookingSteps —— AI 生成详细烹饪步骤（Phase 10，Phase D 重写为走家庭菜谱库）
 *   generateRecipe    —— 为已确认菜单批量生成做法（Phase D）
 *   retryRecipe       —— 重新生成单道菜做法（Phase D）
 *   getRecipeDetail   —— 查询某道菜的做法（Phase D）
 *   editCookbookRecipe—— 编辑做法（Phase D）
 *   listCookbook      —— 家庭菜谱列表（Phase D）
 *   getCookbook       —— 家庭菜谱详情（Phase D）
 *   seedRecipes       —— 初始化内置菜谱
 *
 * 安全与边界：
 *   1. 内置菜谱是公共只读数据，查询不要求登录、也不涉及家庭权限；
 *   2. 写操作只由初始化脚本（seed-recipes.js）在开发者环境执行，
 *      云函数不提供任何菜谱写接口，客户端无法篡改内置菜谱；
 *   3. 只读 isActive = true 的菜谱，已禁用的菜谱在列表与详情中都不可见；
 *   4. AI 生成的做法保存在家庭菜谱库（family_cookbook + cookbook_versions）；
 *   5. API Key 使用统一 AI 路由（ai-service），不在此层处理模式选择；
 *   6. 家庭菜谱库操作必须通过 familyId 校验成员身份。
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
  chatCompletion,
  extractJson,
  attemptJsonRepair,
  AI_CALL_TIMEOUT_MS,
} = require('./openai-compatible-client');

const aiService = require('./ai-service');

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

  const ingredient = event.ingredient === undefined || event.ingredient === null ? '' : String(event.ingredient).trim();
  if (ingredient.length > RECIPE_KEYWORD_MAX_LENGTH) {
    return { error: fail('INVALID_PARAMS', '食材关键词不能超过 ' + RECIPE_KEYWORD_MAX_LENGTH + ' 个字') };
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

  return { value: { category, keyword, ingredient, page, pageSize } };
}

/* ------------------------------ 业务处理 ------------------------------ */

/**
 * 菜谱列表。
 * 只返回启用的内置菜谱（source = 'builtin'）。
 */
async function listRecipes(event) {
  const parsed = parseListParams(event);
  if (parsed.error) {
    return parsed.error;
  }

  const { category, keyword, ingredient, page, pageSize } = parsed.value;

  // 按食材搜索需要匹配 ingredients 数组内字段，云数据库对数组内对象的点号正则支持不稳，
  // 内置菜谱规模有限（当前 150 道），一次读回后内存过滤即可，结果与分页逻辑保持一致。
  if (ingredient) {
    return listRecipesByIngredient({ category, keyword, ingredient, page, pageSize });
  }

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
 * 按食材名搜索菜谱：命中 ingredients[].name（例如食材页「鸡蛋」→ 番茄炒蛋 / 蛋炒饭）。
 * 与 listRecipes 的 keyword（按菜名）互相独立，两者同时存在时取交集。
 */
async function listRecipesByIngredient({ category, keyword, ingredient, page, pageSize }) {
  try {
    const condition = { source: 'builtin', isActive: true };
    if (category) {
      condition.category = category;
    }
    const res = await recipesCol.where(condition).limit(1000).get();

    const lowerKeyword = keyword.toLowerCase();
    let docs = (res.data || []).filter((doc) => {
      const ingredients = Array.isArray(doc.ingredients) ? doc.ingredients : [];
      if (!ingredients.some((item) => item && item.name && String(item.name).indexOf(ingredient) !== -1)) {
        return false;
      }
      if (lowerKeyword && String(doc.name || '').toLowerCase().indexOf(lowerKeyword) === -1) {
        return false;
      }
      return true;
    });

    docs = docs.slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN'));
    const total = docs.length;
    const items = docs.slice((page - 1) * pageSize, page * pageSize).map(toRecipeSummary);

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

/* ============================== Phase 10 / Phase D：AI 生成做法 + 家庭菜谱库 ============================== */

const MAX_GENERATED_STEPS_TEXT = 4096;
const MAX_OUTPUT_TOKENS = 2048;

/** 家庭菜谱列表每页上限 */
const COOKBOOK_PAGE_SIZE = 20;
const COOKBOOK_PAGE_SIZE_MAX = 50;

/* ------------------------------ 家庭菜谱库辅助 ------------------------------ */

const cookbookCol = db.collection('family_cookbook');
const versionsCol = db.collection('cookbook_versions');

/**
 * 查家庭菜谱缓存：按 (familyId, recipeId, servings) 精确匹配。
 * 返回入口文档，没有则返回 null。
 */
async function findCookbookEntry(familyId, recipeId, servings) {
  try {
    const res = await cookbookCol
      .where({ familyId, recipeId, servings, status: 'active' })
      .limit(1)
      .get();
    return res.data[0] || null;
  } catch (e) {
    if (isCollectionMissing(e)) return null;
    throw e;
  }
}

/**
 * 读取某条入口的最新版本做法。
 */
async function getLatestVersion(cookbookId, version) {
  try {
    const res = await versionsCol
      .where({ cookbookId, version })
      .limit(1)
      .get();
    return res.data[0] || null;
  } catch (e) {
    if (isCollectionMissing(e)) return null;
    throw e;
  }
}

/**
 * 生成系统提示词（generateCookingSteps 与批量生成共用）
 */
function buildSystemPrompt(preferences) {
  return [
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
}

/**
 * 用菜谱模板数据构造用户提示词
 */
function buildUserPrompt(doc, servings) {
  const existingSteps = (Array.isArray(doc.steps) ? doc.steps : [])
    .map((s, i) => ({ step: s.step || i + 1, description: s.description || '', minutes: s.minutes || 0 }));
  const existingIngredients = (Array.isArray(doc.ingredients) ? doc.ingredients : [])
    .map((ing) => ({ name: ing.name || '', amount: ing.amount || 0, unit: ing.unit || '' }));

  return [
    '菜谱名称：' + doc.name,
    '分类：' + (doc.category || ''),
    '原适用人数：' + (doc.servings || 0),
    '当前要求人数：' + servings,
    '烹饪时间：约 ' + (doc.cookTime || 0) + ' 分钟',
    '已有食材：' + JSON.stringify(existingIngredients),
    existingSteps.length > 0 ? '已有步骤：' + JSON.stringify(existingSteps) : '',
    '请生成详细做法。',
  ].filter(Boolean).join('\n');
}

/**
 * 调用 AI 生成做法并解析
 */
async function aiGenerateSteps(user, recipeDoc, servings, preferences, event) {
  const systemPrompt = buildSystemPrompt(preferences);
  const userPrompt = buildUserPrompt(recipeDoc, servings);

  const aiText = await aiService.runAiCall(
    db,
    user._id,
    { action: 'generateCookingSteps', requestId: event.requestId || '' },
    (aiConfig) => chatCompletion(
      aiConfig,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      { temperature: 0.7, max_tokens: MAX_OUTPUT_TOKENS, timeoutMs: AI_CALL_TIMEOUT_MS },
    ),
  );

  let parsed = extractJson(aiText);
  if (!parsed) parsed = attemptJsonRepair(aiText);
  if (!parsed || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    throw Object.assign(new Error('模型返回格式不正确，请重试'), { code: 'AI_FORMAT_ERROR' });
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
  return parsed;
}

/**
 * 将生成结果保存到家庭菜谱库。
 * 首次生成：创建 family_cookbook 入口 + cookbook_versions version=1。
 * 重新生成：version+1、新增 cookbook_versions 行、旧版保留。
 */
async function saveCookbookVersion(familyId, recipeDoc, servings, parsedData, createdBy) {
  const now = new Date().toISOString();

  // 查现有入口
  let entry = await findCookbookEntry(familyId, recipeDoc._id, servings);

  if (entry) {
    // 已有入口：版本递增
    const nextVersion = entry.latestVersion + 1;
    await cookbookCol.doc(entry._id).update({
      data: { latestVersion: nextVersion, updatedAt: now },
    });
    await versionsCol.add({
      data: {
        cookbookId: entry._id,
        familyId: familyId,
        version: nextVersion,
        source: 'generated',
        data: parsedData,
        createdAt: now,
        createdBy: createdBy,
      },
    });
    return { cookbookId: entry._id, version: nextVersion, isNew: false };
  }

  // 首次创建入口 + 第一版
  const entryResult = await cookbookCol.add({
    data: {
      familyId: familyId,
      recipeId: recipeDoc._id,
      name: recipeDoc.name || '',
      category: recipeDoc.category || '',
      difficulty: recipeDoc.difficulty || 'easy',
      cookTime: Number(recipeDoc.cookTime) || 0,
      servings: servings,
      latestVersion: 1,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    },
  });

  await versionsCol.add({
    data: {
      cookbookId: entryResult._id,
      familyId: familyId,
      version: 1,
      source: 'generated',
      data: parsedData,
      createdAt: now,
      createdBy: createdBy,
    },
  });

  return { cookbookId: entryResult._id, version: 1, isNew: true };
}

/* ------------------------------ Phase 10：生成做法（重写） ------------------------------ */

/**
 * 为单道菜谱模版生成做法。
 * 入参新增 familyId —— 同一道菜同一人数在同一个家庭里只存一份，全家共享。
 * 旧 generated_recipes 的缓存仍会先查一次以兼容已有数据，但新生成结果写入家庭菜谱库。
 */
async function handleGenerateCookingSteps(event, wxContext) {
  const openid = wxContext.OPENID || '';
  const recipeId = String(event.recipeId || '').trim();
  const familyId = String(event.familyId || '').trim();
  if (!recipeId) return fail('INVALID_PARAMS', '缺少 recipeId');

  // 读取菜谱模板
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

  const servings = Number.isInteger(event.servings) && event.servings > 0 ? event.servings : (doc.servings || 2);

  // 身份校验：传了 familyId 时 requireFamilyMember 内部已读取 users，
  // 不再单独查一次 users，避免同一请求里重复读取同一个文档。
  let user;
  if (familyId) {
    const auth = await requireFamilyMember(openid, familyId);
    if (auth.error) return auth.error;
    user = auth.user;
  } else {
    try {
      const userResult = await db.collection('users').where({ openid }).limit(1).get();
      user = userResult.data[0];
    } catch (e) {
      if (isCollectionMissing(e)) return fail('DB_NOT_READY', '数据库集合 users 不存在');
      throw e;
    }
    if (!user) return fail('UNAUTHORIZED', '请先登录');
  }

  // 1. 未传 familyId 时，先查旧缓存（generated_recipes，兼容已有数据）。
  //    传了 familyId 则跳过旧表，直接走家庭菜谱库，避免命中旧缓存后不保存。
  if (!familyId) {
    let oldCached;
    try {
      oldCached = await db.collection('generated_recipes')
        .where({ recipeId, userId: openid })
        .orderBy('createdAt', 'desc')
        .limit(1)
        .get();
    } catch (e) {
      if (!isCollectionMissing(e)) throw e;
    }
    if (oldCached && oldCached.data && oldCached.data.length > 0) {
      return ok({
        source: 'cached',
        recipeId: recipeId,
        data: oldCached.data[0].data,
        createdAt: oldCached.data[0].createdAt,
      });
    }
  }

  // 2. 查家庭菜谱库缓存
  if (familyId) {
    const entry = await findCookbookEntry(familyId, recipeId, servings);
    if (entry) {
      const versionDoc = await getLatestVersion(entry._id, entry.latestVersion);
      if (versionDoc) {
        return ok({
          source: 'cached',
          recipeId: recipeId,
          cookbookId: entry._id,
          version: entry.latestVersion,
          data: versionDoc.data,
          createdAt: versionDoc.createdAt,
        });
      }
    }
  }

  // 3. 调用 AI 生成
  const preferences = String(event.preferences || '').trim();
  let parsed;
  try {
    parsed = await aiGenerateSteps(user, doc, servings, preferences, event);
  } catch (e) {
    if (aiService.friendlyAiMessage(e.code)) return fail(e.code, aiService.friendlyAiMessage(e.code));
    if (e.code === 'AI_FORMAT_ERROR') return fail('AI_FORMAT_ERROR', e.message);
    const msg = {
      'AI_AUTH_FAILED': '模型认证失败', 'AI_CONNECTION_FAILED': '无法连接模型',
      'AI_TIMEOUT': '模型响应超时。请稍后重试',
      'AI_EMPTY_RESPONSE': '模型没有返回有效内容',
      'AI_REQUEST_FAILED': '请求失败', 'DECRYPT_FAILED': '密钥解密失败',
    };
    return fail('AI_FAILED', msg[e.code] || (e.message || 'AI 调用失败'));
  }

  // 4. 保存到家庭菜谱库（如无 familyId 则退回到 generated_recipes）
  const now = new Date().toISOString();

  if (familyId) {
    try {
      const saved = await saveCookbookVersion(familyId, doc, servings, parsed, user._id);
      return ok({
        source: 'generated',
        recipeId: recipeId,
        cookbookId: saved.cookbookId,
        version: saved.version,
        data: parsed,
        createdAt: now,
      });
    } catch (e) {
      if (isCollectionMissing(e)) {
        return fail('DB_NOT_READY', '数据库集合 family_cookbook 或 cookbook_versions 不存在');
      }
      throw e;
    }
  }

  // 无 familyId → 退回到旧表（客户端尚未适配时的过渡路径）
  let savedId;
  try {
    const result = await db.collection('generated_recipes').add({
      data: { recipeId, userId: openid, data: parsed, createdAt: now, updatedAt: now },
    });
    savedId = result._id;
  } catch (e) {
    if (isCollectionMissing(e)) return fail('DB_NOT_READY', '数据库集合 generated_recipes 不存在');
    throw e;
  }

  return ok({
    source: 'generated', recipeId: recipeId, generatedId: savedId, data: parsed, createdAt: now,
  });
}

/* ------------------------------ Phase D：批量生成菜单做法 ------------------------------ */

/**
 * 为已确认的菜单生成全部菜品的详细做法。
 * 逐道检查家庭菜谱库是否已有做法，有则跳过，无则调用 AI 生成并写入。
 */
async function handleGenerateRecipe(event, wxContext) {
  const openid = wxContext.OPENID || '';
  const menuId = String(event.menuId || '').trim();
  const familyId = String(event.familyId || '').trim();
  if (!menuId) return fail('INVALID_PARAMS', '缺少 menuId');
  if (!familyId) return fail('INVALID_PARAMS', '缺少 familyId');

  const auth = await requireFamilyMember(openid, familyId);
  if (auth.error) return auth.error;
  const user = auth.user;

  // 读取菜单
  let menuDoc;
  try {
    const res = await db.collection('menus').doc(menuId).get();
    menuDoc = res && res.data ? res.data : null;
  } catch (error) {
    if (isDocMissing(error)) return fail('MENU_NOT_FOUND', '菜单不存在');
    if (isCollectionMissing(error)) return fail('DB_NOT_READY', '数据库集合 menus 不存在');
    throw error;
  }
  if (!menuDoc) return fail('MENU_NOT_FOUND', '菜单不存在');
  if (menuDoc.familyId !== familyId) return fail('FORBIDDEN', '无权访问该菜单');

  const items = Array.isArray(menuDoc.items) ? menuDoc.items : [];
  if (items.length === 0) return fail('INVALID_PARAMS', '该菜单没有菜品');

  const preferences = String(event.preferences || '').trim();

  const results = [];
  for (const item of items) {
    const recipeId = item.recipeId || item._id || '';
    if (!recipeId) continue;

    // 读菜谱模板
    let recipeDoc;
    try {
      recipeDoc = await recipesCol.doc(recipeId).get();
      recipeDoc = recipeDoc && recipeDoc.data ? recipeDoc.data : null;
    } catch (e) {
      results.push({ recipeId, name: item.name || '', status: 'skipped', reason: 'recipe_not_found' });
      continue;
    }
    if (!recipeDoc || !recipeDoc.isActive) {
      results.push({ recipeId, name: item.name || '', status: 'skipped', reason: 'recipe_inactive' });
      continue;
    }

    const servings = menuDoc.servings || recipeDoc.servings || 2;

    // 查缓存
    const entry = await findCookbookEntry(familyId, recipeId, servings);
    if (entry) {
      results.push({ recipeId, name: item.name || '', status: 'cached', cookbookId: entry._id, version: entry.latestVersion });
      continue;
    }

    // 生成
    try {
      const parsed = await aiGenerateSteps(user, recipeDoc, servings, preferences + ' 菜名：' + (item.name || ''), event);
      const saved = await saveCookbookVersion(familyId, recipeDoc, servings, parsed, user._id);
      results.push({ recipeId, name: item.name || '', status: 'generated', cookbookId: saved.cookbookId, version: saved.version });
    } catch (e) {
      if (aiService.friendlyAiMessage(e.code)) {
        results.push({ recipeId, name: item.name || '', status: 'failed', reason: e.code });
        break;
      }
      results.push({ recipeId, name: item.name || '', status: 'failed', reason: (e && e.message) || 'AI 调用失败' });
    }
  }

  return ok({
    menuId,
    items: results,
    totalCount: items.length,
    generatedCount: results.filter((r) => r.status === 'generated').length,
    cachedCount: results.filter((r) => r.status === 'cached').length,
  });
}

/* ------------------------------ Phase D：重新生成单道菜 ------------------------------ */

async function handleRetryRecipe(event, wxContext) {
  const openid = wxContext.OPENID || '';
  const cookbookId = String(event.cookbookId || '').trim();
  const familyId = String(event.familyId || '').trim();
  if (!cookbookId) return fail('INVALID_PARAMS', '缺少 cookbookId');
  if (!familyId) return fail('INVALID_PARAMS', '缺少 familyId');

  const auth = await requireFamilyMember(openid, familyId);
  if (auth.error) return auth.error;
  const user = auth.user;

  let entry;
  try {
    const res = await cookbookCol.doc(cookbookId).get();
    entry = res && res.data ? res.data : null;
  } catch (e) {
    if (isDocMissing(e)) return fail('COOKBOOK_NOT_FOUND', '该菜谱不存在');
    if (isCollectionMissing(e)) return fail('DB_NOT_READY', '数据库集合 family_cookbook 不存在');
    throw e;
  }
  if (!entry || entry.familyId !== familyId) return fail('COOKBOOK_NOT_FOUND', '该菜谱不存在');

  let recipeDoc;
  try {
    recipeDoc = await recipesCol.doc(entry.recipeId).get();
    recipeDoc = recipeDoc && recipeDoc.data ? recipeDoc.data : null;
  } catch (e) {
    return fail('RECIPE_NOT_FOUND', '关联的菜谱模板已不存在');
  }
  if (!recipeDoc) return fail('RECIPE_NOT_FOUND', '关联的菜谱模板已不存在');

  const preferences = String(event.preferences || '').trim();
  let parsed;
  try {
    parsed = await aiGenerateSteps(user, recipeDoc, entry.servings, preferences, event);
  } catch (e) {
    if (aiService.friendlyAiMessage(e.code)) return fail(e.code, aiService.friendlyAiMessage(e.code));
    if (e.code === 'AI_FORMAT_ERROR') return fail('AI_FORMAT_ERROR', e.message);
    return fail('AI_FAILED', (e && e.message) || 'AI 调用失败');
  }

  const saved = await saveCookbookVersion(familyId, recipeDoc, entry.servings, parsed, user._id);
  return ok({ cookbookId: saved.cookbookId, version: saved.version, data: parsed, createdAt: new Date().toISOString() });
}

/* ------------------------------ Phase D：查询做法 ------------------------------ */

async function handleGetRecipeDetail(event, wxContext) {
  const openid = wxContext.OPENID || '';
  const cookbookId = String(event.cookbookId || '').trim();
  const familyId = String(event.familyId || '').trim();
  if (!cookbookId) return fail('INVALID_PARAMS', '缺少 cookbookId');
  if (!familyId) return fail('INVALID_PARAMS', '缺少 familyId');

  const auth = await requireFamilyMember(openid, familyId);
  if (auth.error) return auth.error;

  let entry;
  try {
    const res = await cookbookCol.doc(cookbookId).get();
    entry = res && res.data ? res.data : null;
  } catch (e) {
    if (isDocMissing(e)) return fail('COOKBOOK_NOT_FOUND', '该菜谱不存在');
    if (isCollectionMissing(e)) return fail('DB_NOT_READY', '数据库集合 family_cookbook 不存在');
    throw e;
  }
  if (!entry || entry.familyId !== familyId) return fail('COOKBOOK_NOT_FOUND', '该菜谱不存在');

  const versionDoc = await getLatestVersion(entry._id, entry.latestVersion);
  if (!versionDoc) return fail('COOKBOOK_NOT_FOUND', '该菜谱的做法数据缺失');

  return ok({
    cookbookId: entry._id, name: entry.name, category: entry.category,
    difficulty: entry.difficulty, cookTime: entry.cookTime, servings: entry.servings,
    version: entry.latestVersion, source: versionDoc.source,
    data: versionDoc.data, createdAt: versionDoc.createdAt,
  });
}

/* ------------------------------ Phase D：编辑做法 ------------------------------ */

/**
 * 编辑当前版本的做法。编辑直接覆盖当前版本 data，不新增版本行；source 改为 edited。
 */
function sanitizeEditedData(input) {
  const data = input || {};
  return {
    introduction: String(data.introduction || '').slice(0, 500),
    ingredients: (Array.isArray(data.ingredients) ? data.ingredients : []).map((i) => ({
      name: String(i.name || '').slice(0, 100),
      amount: Number.isFinite(i.amount) ? i.amount : 0,
      unit: String(i.unit || '').slice(0, 20),
    })),
    preparation: (Array.isArray(data.preparation) ? data.preparation : []).map((p) => String(p || '').slice(0, 500)),
    steps: (Array.isArray(data.steps) ? data.steps : []).map((s, i) => ({
      step: Number(s.step) || i + 1,
      description: String(s.description || '').slice(0, 800),
      minutes: Number.isFinite(s.minutes) ? Math.round(s.minutes) : 0,
    })),
    tips: (Array.isArray(data.tips) ? data.tips : []).map((t) => String(t || '').slice(0, 500)),
    safetyNotes: (Array.isArray(data.safetyNotes) ? data.safetyNotes : []).map((n) => String(n || '').slice(0, 500)),
    servings: data.servings ? Number(data.servings) : undefined,
  };
}

async function handleEditCookbookRecipe(event, wxContext) {
  const openid = wxContext.OPENID || '';
  const cookbookId = String(event.cookbookId || '').trim();
  const familyId = String(event.familyId || '').trim();
  if (!cookbookId) return fail('INVALID_PARAMS', '缺少 cookbookId');
  if (!familyId) return fail('INVALID_PARAMS', '缺少 familyId');

  const auth = await requireFamilyMember(openid, familyId);
  if (auth.error) return auth.error;

  let entry;
  try {
    entry = await cookbookCol.doc(cookbookId).get();
    entry = entry && entry.data ? entry.data : null;
  } catch (e) {
    if (isDocMissing(e)) return fail('COOKBOOK_NOT_FOUND', '该菜谱不存在');
    if (isCollectionMissing(e)) return fail('DB_NOT_READY', '数据库集合 family_cookbook 不存在');
    throw e;
  }
  if (!entry || entry.familyId !== familyId) return fail('COOKBOOK_NOT_FOUND', '该菜谱不存在');

  const sanitized = sanitizeEditedData(event.data);
  if (!sanitized.steps || sanitized.steps.length === 0) {
    return fail('INVALID_PARAMS', 'steps 不能为空');
  }

  const now = new Date().toISOString();
  try {
    await versionsCol
      .where({ cookbookId, version: entry.latestVersion })
      .update({ data: { source: 'edited', data: sanitized, createdAt: now } });
  } catch (e) {
    if (isCollectionMissing(e)) return fail('DB_NOT_READY', '数据库集合 cookbook_versions 不存在');
    throw e;
  }

  return ok({ cookbookId: cookbookId, version: entry.latestVersion, source: 'edited', updatedAt: now });
}

/* ------------------------------ Phase D：家庭菜谱列表与详情 ------------------------------ */

async function handleListCookbook(event, wxContext) {
  const openid = wxContext.OPENID || '';
  const familyId = String(event.familyId || '').trim();
  if (!familyId) return fail('INVALID_PARAMS', '缺少 familyId');

  const auth = await requireFamilyMember(openid, familyId);
  if (auth.error) return auth.error;

  const page = Math.max(1, Number(event.page) || 1);
  const pageSize = Math.min(COOKBOOK_PAGE_SIZE_MAX, Math.max(1, Number(event.pageSize) || COOKBOOK_PAGE_SIZE));
  const category = String(event.category || '').trim();
  const status = event.status === 'archived' ? 'archived' : 'active';

  let query = cookbookCol.where({ familyId, status });
  if (category) query = query.where({ category });

  let total;
  try {
    total = await query.count();
    total = total.total;
  } catch (e) {
    if (isCollectionMissing(e)) return fail('DB_NOT_READY', '数据库集合 family_cookbook 不存在');
    throw e;
  }

  let docs = [];
  try {
    const res = await query.orderBy('createdAt', 'desc').skip((page - 1) * pageSize).limit(pageSize).get();
    docs = res.data || [];
  } catch (e) {
    if (isCollectionMissing(e)) return fail('DB_NOT_READY', '数据库集合 family_cookbook 不存在');
    throw e;
  }

  const items = docs.map((d) => ({
    _id: d._id, name: d.name || '', category: d.category || '',
    difficulty: d.difficulty || 'easy', cookTime: Number(d.cookTime) || 0,
    servings: Number(d.servings) || 0, latestVersion: d.latestVersion || 1,
    status: d.status || 'active', createdAt: d.createdAt || '',
  }));

  return ok({ items, total, page, pageSize });
}

async function handleGetCookbook(event, wxContext) {
  const openid = wxContext.OPENID || '';
  const cookbookId = String(event.cookbookId || '').trim();
  const familyId = String(event.familyId || '').trim();
  if (!cookbookId) return fail('INVALID_PARAMS', '缺少 cookbookId');
  if (!familyId) return fail('INVALID_PARAMS', '缺少 familyId');

  const auth = await requireFamilyMember(openid, familyId);
  if (auth.error) return auth.error;

  let entry;
  try {
    const res = await cookbookCol.doc(cookbookId).get();
    entry = res && res.data ? res.data : null;
  } catch (e) {
    if (isDocMissing(e)) return fail('COOKBOOK_NOT_FOUND', '该菜谱不存在');
    if (isCollectionMissing(e)) return fail('DB_NOT_READY', '数据库集合 family_cookbook 不存在');
    throw e;
  }
  if (!entry || entry.familyId !== familyId) return fail('COOKBOOK_NOT_FOUND', '该菜谱不存在');

  const currentVersion = await getLatestVersion(entry._id, entry.latestVersion);

  let versions = [];
  try {
    const res = await versionsCol
      .where({ cookbookId })
      .orderBy('version', 'asc')
      .field({ version: true, source: true, createdAt: true })
      .get();
    versions = (res.data || []).map((v) => ({ version: v.version, source: v.source, createdAt: v.createdAt }));
  } catch (e) {
    if (!isCollectionMissing(e)) throw e;
  }

  return ok({
    entry: {
      _id: entry._id, familyId: entry.familyId, recipeId: entry.recipeId,
      name: entry.name, category: entry.category, difficulty: entry.difficulty,
      cookTime: entry.cookTime, servings: entry.servings,
      latestVersion: entry.latestVersion, status: entry.status,
      createdAt: entry.createdAt, updatedAt: entry.updatedAt,
    },
    current: currentVersion ? {
      _id: currentVersion._id, cookbookId: currentVersion.cookbookId,
      familyId: currentVersion.familyId, version: currentVersion.version,
      source: currentVersion.source, data: currentVersion.data,
      createdAt: currentVersion.createdAt, createdBy: currentVersion.createdBy,
    } : null,
    versionList: versions,
  });
}

/* ------------------------------ 业务路由 ------------------------------ */

const handlers = {
  /** 健康检查 */
  ping() {
    return ok({ function: 'recipe', status: 'ok', time: Date.now() });
  },

  /** Phase 6：菜谱列表 */
  listRecipes,

  /** Phase 6：菜谱详情 */
  getRecipe,

  /** Phase 10 / Phase D：AI 生成详细烹饪步骤 */
  generateCookingSteps: handleGenerateCookingSteps,

  /** Phase D：批量生成 */
  generateRecipe: handleGenerateRecipe,

  /** Phase D：重新生成 */
  retryRecipe: handleRetryRecipe,

  /** Phase D：查询做法 */
  getRecipeDetail: handleGetRecipeDetail,

  /** Phase D：编辑做法 */
  editCookbookRecipe: handleEditCookbookRecipe,

  /** Phase D：菜谱列表 */
  listCookbook: handleListCookbook,

  /** Phase D：菜谱详情 */
  getCookbook: handleGetCookbook,

  /** 初始化内置菜谱 */
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
    if (isCollectionMissing(error)) {
      response = fail('DB_NOT_READY', '数据库集合不存在，请先在云开发控制台创建');
    } else {
      console.error('[' + 'recipe' + '] 未捕获异常', error);
      response = fail('INTERNAL_ERROR', '服务内部异常，请稍后重试');
    }
  }

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