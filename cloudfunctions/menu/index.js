/**
 * menu 云函数 · 菜单管理与调整（Phase 8）
 *
 * 职责：
 *   saveMenu          —— 将 AI 推荐结果保存为草稿菜单
 *   getMenu           —— 查询菜单详情
 *   setMenuItemLocked —— 锁定 / 取消锁定菜品
 *   replaceMenuItem   —— 换一道菜（通过 AI 选择替换）
 *   regenerateUnlockedItems —— 重新推荐所有未锁定菜品
 *   confirmMenu       —— 确认菜单
 *
 * 安全：
 *   1. 身份只来自 cloud.getWXContext().OPENID；
 *   2. 必须经 requireFamilyMember 复核家庭归属；
 *   3. 所有新菜 recipeId 必须来自 recipes 集合，拒绝 AI 编造；
 *   4. API Key 使用用户自配密钥，经 AES-256-GCM 解密；
 *   5. 日志不记录 API Key 或 Authorization 头。
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

const { BUILTIN_NUTRITION_FACTS } = require('./nutrition-data');
const { calculateNutrition } = require('./nutrition-core');

/* ============================== 过敏原 / 忌口硬过滤（Phase E2） ============================== */

const { buildDiet, filterRecipes } = require('./diet-filter');

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

const ERR_COLLECTION_NOT_EXIST = -502005;
const ERR_DOC_NOT_EXIST = -502002;

function isCollectionMissing(err) {
  if (!err) return false;
  // 有 errCode 时以错误码为准，避免把「document not exists」误判为集合缺失
  if (typeof err.errCode === 'number') {
    return err.errCode === ERR_COLLECTION_NOT_EXIST;
  }
  return typeof err.message === 'string' && err.message.indexOf('not exist') !== -1;
}

function generateId() {
  return Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

/* ============================== 用户与家庭校验 ============================== */

async function findUserByOpenid(openid) {
  const result = await db.collection('users').where({ openid }).limit(1).get();
  return result.data[0] || null;
}

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
  if (!memberResult.data[0]) {
    return { error: fail('NOT_IN_FAMILY', '你不是该家庭的成员') };
  }
  return { user, member: memberResult.data[0] };
}

/**
 * 读取家庭偏好（Phase E2）。读取失败按「无偏好」处理，不阻塞菜单操作。
 */
async function loadFamilyPreferences(familyId) {
  try {
    const res = await db.collection('families').doc(familyId).get();
    const family = res && res.data;
    return (family && family.preferences) || {};
  } catch (e) {
    if (!isCollectionMissing(e)) {
      console.error('[menu] 读取家庭偏好失败，按无偏好处理', e && e.message);
    }
    return {};
  }
}

/* ============================== 业务约束 ============================== */

const MAX_CANDIDATES = 50;
const MAX_OUTPUT_TOKENS = 1024;

/* ============================== 菜单读写 ============================== */

async function readMenu(menuId) {
  try {
    const result = await db.collection('menus').doc(menuId).get();
    return result.data || null;
  } catch (err) {
    // 文档不存在（-502002）返回 null，交给调用方给出 MENU_NOT_FOUND；
    // 集合缺失（-502005）继续抛出，由入口统一降级为 DB_NOT_READY。
    if (err && err.errCode === ERR_DOC_NOT_EXIST) return null;
    if (err && typeof err.errCode !== 'number' &&
      typeof err.message === 'string' && err.message.indexOf('document not exists') !== -1) {
      return null;
    }
    throw err;
  }
}

/** 校验菜单归属：存在 + 家庭匹配 */
async function requireMenuOwnership(openid, menuId, familyId) {
  const auth = await requireFamilyMember(openid, familyId);
  if (auth.error) return auth;

  const menu = await readMenu(menuId);
  if (!menu) {
    return { error: fail('MENU_NOT_FOUND', '菜单不存在或已被删除') };
  }
  if (menu.familyId !== familyId) {
    return { error: fail('FORBIDDEN', '无权操作该菜单') };
  }
  return { ...auth, menu };
}

/* ============================== 菜谱工具 ============================== */

function toRecipeView(recipe) {
  return {
    recipeId: recipe._id,
    name: recipe.name,
    description: recipe.description || '',
    category: recipe.category || '',
    tags: recipe.tags || [],
    difficulty: recipe.difficulty || 'medium',
    cookTime: recipe.cookTime || 0,
    servings: recipe.servings || 2,
    ingredients: (recipe.ingredients || []).map((i) => ({
      name: i.name || '',
      amount: i.amount !== undefined ? i.amount : 0,
      unit: i.unit || '',
    })),
  };
}

function toCandidateSummary(recipe, inventoryNames) {
  const names = (recipe.ingredients || []).map((i) => i.name);
  const matched = names.filter((n) => inventoryNames.has(n));
  return {
    id: recipe._id,
    name: recipe.name,
    category: recipe.category,
    difficulty: recipe.difficulty,
    cookTime: recipe.cookTime,
    ingredients: names,
    matchedIngredients: matched.length,
    missingIngredients: names.filter((n) => !inventoryNames.has(n)),
  };
}

async function loadRecipes() {
  try {
    const result = await db.collection('recipes')
      .where({ source: 'builtin', isActive: true })
      .limit(200)
      .get();
    return result.data || [];
  } catch (e) {
    if (isCollectionMissing(e)) return [];
    throw e;
  }
}

async function loadIngredients(familyId) {
  try {
    const result = await db.collection('ingredients')
      .where({ familyId })
      .limit(200)
      .get();
    return result.data || [];
  } catch (e) {
    if (isCollectionMissing(e)) return [];
    throw e;
  }
}

/* ============================== AI 调用辅助 ============================== */

/**
 * 调用 AI，用候选菜谱列表做选菜。
 * 返回 AI 选择的 recipeId 数组。
 */
async function aiPickRecipes(aiConfig, systemInstructions, candidates, count, excludeNames) {
  const candidateJson = candidates.map((c) => ({
    id: c.id,
    name: c.name,
    category: c.category,
    cookTime: c.cookTime + '分钟',
    ingredients: c.ingredients,
    matchedIngredients: c.matchedIngredients,
    missingIngredients: c.missingIngredients,
  }));

  const excludeHint = excludeNames && excludeNames.length > 0
    ? '\n已选菜品（不可重复）：' + excludeNames.join('、')
    : '';

  const userPrompt = [
    '候选菜谱列表（JSON）：',
    JSON.stringify(candidateJson),
    excludeHint,
    '',
    '请以 JSON 格式返回选择结果：',
    '{"selectedIds": ["recipe_id_1"' + (count > 1 ? ', "recipe_id_2"' : '') + ']}',
  ].join('\n');

  const aiText = await chatCompletion(
    aiConfig,
    [
      { role: 'system', content: systemInstructions },
      { role: 'user', content: userPrompt },
    ],
    { temperature: 0.7, max_tokens: MAX_OUTPUT_TOKENS, timeoutMs: AI_CALL_TIMEOUT_MS },
  );

  let parsed = extractJson(aiText);
  if (!parsed) parsed = attemptJsonRepair(aiText);

  if (!parsed || !Array.isArray(parsed.selectedIds)) {
    throw Object.assign(new Error('模型返回格式不正确，请稍后重试'), { code: 'AI_FORMAT_ERROR' });
  }

  return parsed.selectedIds.filter((id) => typeof id === 'string');
}

/* ============================== saveMenu ============================== */

async function handleSaveMenu(event, wxContext) {
  const openid = wxContext.OPENID || '';
  const auth = await requireFamilyMember(openid, event.familyId || '');
  if (auth.error) return auth.error;

  const items = event.items || [];
  if (!Array.isArray(items) || items.length === 0) {
    return fail('INVALID_PARAMS', '菜品列表不能为空');
  }

  // 校验每个 recipeId 都在库中存在
  const recipes = await loadRecipes();
  const recipeMap = {};
  for (const r of recipes) recipeMap[r._id] = r;

  const validItems = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const recipeId = item.recipeId || item._id || '';
    const recipe = recipeMap[recipeId];
    if (!recipe) continue;

    validItems.push({
      recipeId: recipe._id,
      name: recipe.name,
      description: recipe.description || '',
      category: recipe.category || '',
      tags: recipe.tags || [],
      difficulty: recipe.difficulty || 'medium',
      cookTime: recipe.cookTime || 0,
      servings: recipe.servings || 2,
      ingredients: (recipe.ingredients || []).map((ing) => ({
        name: ing.name || '',
        amount: ing.amount !== undefined ? ing.amount : 0,
        unit: ing.unit || '',
      })),
      locked: false,
      position: i,
      source: 'ai_recommendation',
    });
  }

  if (validItems.length === 0) {
    return fail('INVALID_PARAMS', '没有有效的菜谱 ID');
  }

  const now = new Date().toISOString();
  const doc = {
    familyId: event.familyId,
    userId: auth.user._id,
    mealType: event.mealType || 'dinner',
    servings: Number(event.servings) || 2,
    items: validItems,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  };

  const result = await db.collection('menus').add({ data: doc });

  return ok({
    menuId: result._id,
    ...doc,
    _id: result._id,
  });
}

/* ============================== getMenu ============================== */

async function handleGetMenu(event, wxContext) {
  const openid = wxContext.OPENID || '';
  const menuId = event.menuId || '';
  if (!menuId) {
    return fail('INVALID_PARAMS', '缺少 menuId');
  }

  const menu = await readMenu(menuId);
  if (!menu) {
    return fail('MENU_NOT_FOUND', '菜单不存在或已被删除');
  }

  // Phase 11：强制校验家庭归属——必须由该家庭成员发起，且菜单确属该家庭
  const familyId = event.familyId || '';
  if (!familyId) {
    return fail('INVALID_PARAMS', '缺少 familyId');
  }
  const auth = await requireFamilyMember(openid, familyId);
  if (auth.error) return auth.error;
  if (menu.familyId !== familyId) {
    return fail('FORBIDDEN', '无权查看该菜单');
  }

  return ok(menu);
}

/* ============================== setMenuItemLocked ============================== */

async function handleSetMenuItemLocked(event, wxContext) {
  const openid = wxContext.OPENID || '';
  const { menuId, recipeId, locked } = event;
  const familyId = event.familyId || '';

  if (!menuId) return fail('INVALID_PARAMS', '缺少 menuId');
  if (!recipeId) return fail('INVALID_PARAMS', '缺少 recipeId');
  if (typeof locked !== 'boolean') return fail('INVALID_PARAMS', '缺少 locked（true/false）');

  const auth = await requireMenuOwnership(openid, menuId, familyId);
  if (auth.error) return auth.error;

  const menu = auth.menu;
  const itemIndex = (menu.items || []).findIndex((it) => it.recipeId === recipeId);
  if (itemIndex === -1) {
    return fail('ITEM_NOT_IN_MENU', '该菜品不属于此菜单');
  }

  const now = new Date().toISOString();
  // 原子更新：用位置索引定位
  await db.collection('menus').doc(menuId).update({
    data: {
      ['items.' + itemIndex + '.locked']: locked,
      updatedAt: now,
    },
  });

  return ok({
    menuId: menuId,
    recipeId: recipeId,
    locked: locked,
    updatedAt: now,
  });
}

/* ============================== replaceMenuItem ============================== */

async function handleReplaceMenuItem(event, wxContext) {
  const openid = wxContext.OPENID || '';
  const { menuId, recipeId } = event;
  const familyId = event.familyId || '';
  const preferences = (event.preferences || '').trim();

  if (!menuId) return fail('INVALID_PARAMS', '缺少 menuId');
  if (!recipeId) return fail('INVALID_PARAMS', '缺少 recipeId');

  // 1. 权限校验 & 读取菜单
  const auth = await requireMenuOwnership(openid, menuId, familyId);
  if (auth.error) return auth.error;

  const menu = auth.menu;
  if (menu.status === 'confirmed' || menu.status === 'completed') {
    return fail('MENU_CONFIRMED', '菜单已确认，不能更换菜品');
  }

  // 2. 找到目标菜品
  const targetIndex = (menu.items || []).findIndex((it) => it.recipeId === recipeId);
  if (targetIndex === -1) {
    return fail('ITEM_NOT_IN_MENU', '该菜品不属于此菜单');
  }

  const target = menu.items[targetIndex];
  if (target.locked) {
    return fail('ITEM_LOCKED', '该菜品已锁定，请先取消锁定后再替换');
  }

  // 3. 读取家庭食材 / 菜谱库 / 家庭偏好：三者互不依赖，并行读取省两次数据库往返
  const [ingredients, recipes, familyPrefs] = await Promise.all([
    loadIngredients(familyId),
    loadRecipes(),
    loadFamilyPreferences(familyId),
  ]);

  const inventoryNames = new Set(ingredients.map((i) => (i.standardName || i.name || '').trim()).filter(Boolean));
  if (recipes.length === 0) {
    return fail('NO_RECIPES', '菜谱库为空');
  }

  // E2：按家庭过敏原 / 忌口硬过滤，AI 只能从安全菜谱里选
  const diet = buildDiet(familyPrefs);
  const dietFiltered = filterRecipes(recipes, diet);
  if (diet.rules.length > 0 && dietFiltered.kept.length === 0) {
    return fail('DIET_BLOCKED', '按家庭过敏原与忌口过滤后没有可替换的菜谱，请调整家庭偏好');
  }

  // 4. 候选列表：排除当前菜单已有菜品和 target 本身
  const usedIds = new Set((menu.items || []).map((it) => it.recipeId));
  const candidates = dietFiltered.kept
    .filter((r) => !usedIds.has(r._id))
    .map((r) => toCandidateSummary(r, inventoryNames))
    .sort((a, b) => {
      const aScore = a.ingredients.length > 0 ? a.matchedIngredients / a.ingredients.length : 0;
      const bScore = b.ingredients.length > 0 ? b.matchedIngredients / b.ingredients.length : 0;
      return bScore - aScore;
    })
    .slice(0, MAX_CANDIDATES);

  if (candidates.length === 0) {
    return fail('NO_REPLACEMENT', '暂无合适的替换菜品，请取消部分锁定或调整偏好');
  }

  // 5. AI 选菜（凭据解析、额度扣减、用量日志均在 runAiCall 内完成）
  const systemInstructions = [
    '你是一个饮食推荐助手。请从候选菜谱中选择 1 道菜替换当前菜品。',
    '要求：',
    '1. 优先选择食材匹配度高的（matchedIngredients 多的）；',
    '2. 考虑荤素搭配，不要选和已锁定菜品同类型的；',
    preferences ? '3. 遵守偏好：' + preferences : '',
    '只输出 JSON，不要输出其他内容。',
  ].filter(Boolean).join('\n');

  const otherNames = (menu.items || [])
    .filter((it) => it.recipeId !== recipeId)
    .map((it) => it.name);

  let selectedIds;
  try {
    selectedIds = await aiService.runAiCall(
      db,
      auth.user._id,
      { action: 'replaceMenuItem', requestId: event.requestId || '' },
      (aiConfig) => aiPickRecipes(aiConfig, systemInstructions, candidates, 1, otherNames),
    );
  } catch (e) {
    // 模式相关错误（内置未就绪 / 额度用尽 / 未配置）：文案由 ai-service 统一维护
    if (aiService.friendlyAiMessage(e.code)) {
      return fail(e.code, aiService.friendlyAiMessage(e.code));
    }
    // AI 调用失败：保留原菜单
    const errorMessages = {
      'AI_AUTH_FAILED': '模型认证失败，请检查 API 配置',
      'AI_CONNECTION_FAILED': '无法连接到模型服务',
      'AI_NOT_FOUND': '模型不存在，请检查模型名称',
      'AI_TIMEOUT': '模型响应超时。请稍后重试；若持续出现，请在「模型 API 设置」中改用响应更快的模型',
      'AI_EMPTY_RESPONSE': '模型没有返回有效内容，请检查该模型是否兼容 OpenAI 对话接口',
      'AI_REQUEST_FAILED': '模型请求失败',
      'DECRYPT_FAILED': '密钥解密失败',
    };
    return fail('AI_FAILED', errorMessages[e.code] || (e.message || 'AI 调用失败'));
  }

  if (!selectedIds || selectedIds.length === 0) {
    return fail('NO_REPLACEMENT', '暂无合适的替换菜品');
  }

  // 6. 校验新 recipeId
  const recipeMap = {};
  for (const r of dietFiltered.kept) recipeMap[r._id] = r;

  const newRecipeId = selectedIds[0];
  const newRecipe = recipeMap[newRecipeId];
  if (!newRecipe) {
    return fail('AI_INVALID', '模型返回的菜品无效，请重试');
  }

  // 7. 写入菜单
  const newItem = {
    ...toRecipeView(newRecipe),
    locked: false,
    position: target.position,
    source: 'manual_replacement',
  };

  const now = new Date().toISOString();
  await db.collection('menus').doc(menuId).update({
    data: {
      ['items.' + targetIndex]: newItem,
      updatedAt: now,
    },
  });

  return ok({
    menuId: menuId,
    replaced: { recipeId: recipeId, name: target.name },
    newItem: newItem,
    updatedAt: now,
  });
}

/* ============================== regenerateUnlockedItems ============================== */

async function handleRegenerateUnlockedItems(event, wxContext) {
  const openid = wxContext.OPENID || '';
  const { menuId } = event;
  const familyId = event.familyId || '';
  const preferences = (event.preferences || '').trim();

  if (!menuId) return fail('INVALID_PARAMS', '缺少 menuId');

  // 1. 权限校验 & 读取菜单
  const auth = await requireMenuOwnership(openid, menuId, familyId);
  if (auth.error) return auth.error;

  const menu = auth.menu;
  if (menu.status === 'confirmed' || menu.status === 'completed') {
    return fail('MENU_CONFIRMED', '菜单已确认，不能重新推荐');
  }

  const items = menu.items || [];
  const lockedItems = items.filter((it) => it.locked);
  const unlockedItems = items.filter((it) => !it.locked);

  if (unlockedItems.length === 0) {
    return fail('ALL_LOCKED', '所有菜品均已锁定，无需重新推荐');
  }

  // 2. 读取食材 / 菜谱 / 家庭偏好：三者互不依赖，并行读取省两次数据库往返
  const [ingredients, recipes, familyPrefs] = await Promise.all([
    loadIngredients(familyId),
    loadRecipes(),
    loadFamilyPreferences(familyId),
  ]);

  const inventoryNames = new Set(ingredients.map((i) => (i.standardName || i.name || '').trim()).filter(Boolean));
  if (recipes.length === 0) {
    return fail('NO_RECIPES', '菜谱库为空');
  }

  // E2：按家庭过敏原 / 忌口硬过滤，AI 只能从安全菜谱里选
  const diet = buildDiet(familyPrefs);
  const dietFiltered = filterRecipes(recipes, diet);
  if (diet.rules.length > 0 && dietFiltered.kept.length === 0) {
    return fail('DIET_BLOCKED', '按家庭过敏原与忌口过滤后没有可重新推荐的菜谱，请调整家庭偏好');
  }

  // 3. 候选列表：排除所有锁定菜品
  const lockedIds = new Set(lockedItems.map((it) => it.recipeId));
  const candidates = dietFiltered.kept
    .filter((r) => !lockedIds.has(r._id))
    .map((r) => toCandidateSummary(r, inventoryNames))
    .sort((a, b) => {
      const aScore = a.ingredients.length > 0 ? a.matchedIngredients / a.ingredients.length : 0;
      const bScore = b.ingredients.length > 0 ? b.matchedIngredients / b.ingredients.length : 0;
      return bScore - aScore;
    })
    .slice(0, MAX_CANDIDATES);

  if (candidates.length < unlockedItems.length) {
    return fail('NO_REPLACEMENT', '候选菜品不足，无法为所有未锁定菜品找到替换');
  }

  // 4. AI 选择（凭据解析、额度扣减、用量日志均在 runAiCall 内完成）
  const systemInstructions = [
    '你是一个饮食推荐助手。请从候选菜谱中选择 ' + unlockedItems.length + ' 道菜替换当前菜品。',
    '已锁定菜品：' + lockedItems.map((it) => it.name).join('、'),
    '要求：',
    '1. 优先选择食材匹配度高的；',
    '2. 尽量荤素搭配，避免与已锁定菜品重复；',
    preferences ? '3. 遵守偏好：' + preferences : '',
    '只输出 JSON。',
  ].filter(Boolean).join('\n');

  let selectedIds;
  try {
    selectedIds = await aiService.runAiCall(
      db,
      auth.user._id,
      { action: 'regenerateUnlockedItems', requestId: event.requestId || '' },
      (aiConfig) => aiPickRecipes(aiConfig, systemInstructions, candidates, unlockedItems.length, lockedItems.map((it) => it.name)),
    );
  } catch (e) {
    if (aiService.friendlyAiMessage(e.code)) {
      return fail(e.code, aiService.friendlyAiMessage(e.code));
    }
    return fail('AI_FAILED', e.message || 'AI 调用失败');
  }

  // 5. 校验
  const recipeMap = {};
  for (const r of dietFiltered.kept) recipeMap[r._id] = r;

  const validIds = selectedIds.filter((id) => recipeMap[id] && !lockedIds.has(id));
  if (validIds.length === 0) {
    return fail('AI_INVALID', '模型返回的菜品均无效，原菜单保持不变');
  }

  // 6. 构建新 items 数组：锁定项保留，解锁项替换
  const newItems = [];
  let validIdx = 0;
  for (const item of items) {
    if (item.locked) {
      newItems.push(item);
    } else if (validIdx < validIds.length) {
      const recipe = recipeMap[validIds[validIdx]];
      newItems.push({
        ...toRecipeView(recipe),
        locked: false,
        position: item.position,
        source: 'ai_recommendation',
      });
      validIdx++;
    } else {
      // 候选不足：保留原菜
      newItems.push(item);
    }
  }

  // 7. 原子写入
  const now = new Date().toISOString();
  await db.collection('menus').doc(menuId).update({
    data: {
      items: newItems,
      updatedAt: now,
    },
  });

  return ok({
    menuId: menuId,
    items: newItems,
    lockedCount: lockedItems.length,
    replacedCount: validIdx,
    updatedAt: now,
  });
}

/* ============================== 营养事实加载（Phase A1） ============================== */

/**
 * 单次云函数调用内的营养数据缓存。
 * 先以内置基础数据打底，数据库中的同名记录覆盖内置项；
 * 集合缺失或读取失败时不阻塞确认，直接退回内置表。
 */
const factsCol = db.collection('nutrition_facts');
let nutritionFactMapCache = null;

async function loadNutritionFactMap() {
  if (nutritionFactMapCache) return nutritionFactMapCache;

  const map = {};
  for (const row of BUILTIN_NUTRITION_FACTS) {
    map[row.standardName] = row;
  }

  try {
    const res = await factsCol.limit(1000).get();
    for (const row of res.data || []) {
      const name = (row.standardName || '').trim();
      if (name) map[name] = row;
    }
  } catch (e) {
    if (!isCollectionMissing(e)) {
      console.error('[menu] 读取 nutrition_facts 失败，已退回内置基础数据', e);
    }
  }

  nutritionFactMapCache = map;
  return map;
}

/* ============================== confirmMenu ============================== */

async function handleConfirmMenu(event, wxContext) {
  const openid = wxContext.OPENID || '';
  const { menuId } = event;
  const familyId = event.familyId || '';

  if (!menuId) return fail('INVALID_PARAMS', '缺少 menuId');

  const auth = await requireMenuOwnership(openid, menuId, familyId);
  if (auth.error) return auth.error;

  const menu = auth.menu;
  if (menu.status === 'confirmed') {
    return fail('ALREADY_CONFIRMED', '菜单已确认');
  }

  const items = menu.items || [];
  if (items.length === 0) {
    return fail('EMPTY_MENU', '菜单没有菜品，无法确认');
  }

  // 校验所有 recipeId 仍在 recipes 中存在且启用
  const recipes = await loadRecipes();
  const recipeMap = {};
  for (const r of recipes) recipeMap[r._id] = r;

  const invalidIds = items
    .filter((it) => !recipeMap[it.recipeId])
    .map((it) => it.name || it.recipeId);

  if (invalidIds.length > 0) {
    return fail('INVALID_ITEMS', '以下菜品已失效：' + invalidIds.join('、'));
  }

  // ---- 营养快照：确认时计算每道菜的热量 ----
  const factMap = await loadNutritionFactMap();
  let overallNutritionStatus = 'complete';

  const itemsWithNutrition = items.map((item) => {
    const scale = item.servings > 0 ? menu.servings / item.servings : 1;
    const ingredients = (item.ingredients || []).map((ing) => ({
      name: ing.name || '',
      amount: (ing.amount || 0) * scale,
      unit: ing.unit || '',
    }));

    if (ingredients.length === 0) {
      return { ...item, nutrition: null, nutritionStatus: 'partial' };
    }

    const result = calculateNutrition(
      { ingredients, peopleCount: menu.servings },
      factMap,
    );

    if (result.nutritionStatus !== 'complete') {
      overallNutritionStatus = 'partial';
    }

    return {
      ...item,
      nutrition: {
        calories: result.calories,
        protein: result.protein,
        fat: result.fat,
        carbohydrate: result.carbohydrate,
      },
      nutritionStatus: result.nutritionStatus,
    };
  });

  const now = new Date().toISOString();
  await db.collection('menus').doc(menuId).update({
    data: {
      status: 'confirmed',
      nutritionStatus: overallNutritionStatus,
      items: itemsWithNutrition,
      updatedAt: now,
    },
  });

  return ok({
    menuId: menuId,
    status: 'confirmed',
    nutritionStatus: overallNutritionStatus,
    updatedAt: now,
  });
}

/* ============================== getTodayMenu（Phase 11） ============================== */

async function handleGetTodayMenu(event, wxContext) {
  const openid = wxContext.OPENID || '';
  const familyId = event.familyId || '';

  const auth = await requireFamilyMember(openid, familyId);
  if (auth.error) return auth.error;

  let docs;
  try {
    const res = await db.collection('menus')
      .where({ familyId: familyId, status: 'confirmed' })
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();
    docs = res.data || [];
  } catch (e) {
    if (isCollectionMissing(e)) {
      return fail('DB_NOT_READY', '数据库集合 menus 不存在');
    }
    throw e;
  }

  const menu = docs.length > 0 ? docs[0] : null;
  return ok({ menu: menu, recipeGenerated: false });
}

/* ============================== getMenuHistory（Phase 11） ============================== */

async function handleGetMenuHistory(event, wxContext) {
  const openid = wxContext.OPENID || '';
  const familyId = event.familyId || '';

  const auth = await requireFamilyMember(openid, familyId);
  if (auth.error) return auth.error;

  const page = Number.isInteger(event.page) && event.page > 0 ? event.page : 1;
  const pageSize = Math.min(
    Number.isInteger(event.pageSize) && event.pageSize > 0 ? event.pageSize : 20,
    50,
  );

  const condition = { familyId: familyId };
  // 默认只看已确认菜单；支持按状态筛选
  if (event.status && ['draft', 'confirmed', 'completed'].indexOf(event.status) !== -1) {
    condition.status = event.status;
  } else {
    condition.status = 'confirmed';
  }

  // 日期范围（ISO 字符串可直接比较）
  if (event.startDate) {
    condition.createdAt = _.gte(String(event.startDate));
  }
  if (event.endDate) {
    condition.createdAt = condition.createdAt
      ? _.and(condition.createdAt, _.lte(String(event.endDate)))
      : _.lte(String(event.endDate));
  }

  let total, docs;
  try {
    const countResult = await db.collection('menus').where(condition).count();
    total = countResult.total || 0;
    docs = [];
    if (total > 0) {
      const res = await db.collection('menus')
        .where(condition)
        .orderBy('createdAt', 'desc')
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .get();
      docs = res.data || [];
    }
  } catch (e) {
    if (isCollectionMissing(e)) {
      return fail('DB_NOT_READY', '数据库集合 menus 不存在');
    }
    throw e;
  }

  const items = docs.map((doc) => {
    const menuItems = doc.items || [];
    let totalCalories = 0;
    let dishNutritionStatus = 'complete';
    for (const it of menuItems) {
      if (it.nutrition && typeof it.nutrition.calories === 'number') {
        totalCalories += it.nutrition.calories;
      }
      if (it.nutritionStatus === 'partial') {
        dishNutritionStatus = 'partial';
      }
    }
    return {
      _id: doc._id,
      menuId: doc._id,
      mealType: doc.mealType || 'dinner',
      servings: doc.servings || 0,
      status: doc.status || '',
      dateLabel: (doc.createdAt || '').slice(0, 10),
      dishCount: menuItems.length,
      dishNames: menuItems.map((it) => it.name).filter(Boolean),
      totalCalories: totalCalories > 0 ? totalCalories : 0,
      nutritionStatus: doc.nutritionStatus || dishNutritionStatus || 'unknown',
      createdAt: doc.createdAt || '',
      updatedAt: doc.updatedAt || '',
    };
  });

  return ok({ items: items, total: total, page: page, pageSize: pageSize });
}

/* ============================== 业务路由 ============================== */

const handlers = {
  ping() {
    return ok({ function: 'menu', status: 'ok', time: Date.now() });
  },

  saveMenu: handleSaveMenu,
  getMenu: handleGetMenu,
  setMenuItemLocked: handleSetMenuItemLocked,
  replaceMenuItem: handleReplaceMenuItem,
  regenerateUnlockedItems: handleRegenerateUnlockedItems,
  confirmMenu: handleConfirmMenu,

  /** 旧版桩，保留给后续 */
  getTodayMenu: handleGetTodayMenu,
  getMenuHistory: handleGetMenuHistory,
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
      response = await handler(event, wxContext);
    }
  } catch (error) {
    if (isCollectionMissing(error)) {
      response = fail('DB_NOT_READY', '数据库集合不存在，请先在云开发控制台创建');
    } else if (aiService.friendlyAiMessage(error.code)) {
      response = fail(error.code, aiService.friendlyAiMessage(error.code));
    } else {
      console.error('[menu] 未捕获异常', error.code || '', error.message || '');
      response = fail('INTERNAL_ERROR', '服务内部异常，请稍后重试');
    }
  }

  console.log(
    JSON.stringify({
      functionName: 'menu',
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