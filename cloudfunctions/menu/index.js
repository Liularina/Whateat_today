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
const { buildSignature, compareSignature, findConflict } = require('./dish-signature');
const { normalizeNewDish, checkNewDishDiet, isNewDishRepeated } = require('./new-dish');
const { matchRecipe } = require('./diet-filter');

/* ============================== 餐次协作（Phase 1） ============================== */

const {
  beijingDateString,
  isPlanOpen,
  isMealCook,
  normalizeDishVotes,
  normalizeNote,
  summarizePreferences,
} = require('./meal-plan-core');

/* ============================== 饭后评价与掌勺人成长（阶段二） ============================== */

const {
  BASE_POINTS,
  POINTS_PER_STAR,
  RATING_BONUS_MAX,
  LEVELS,
  resolveLevel,
  normalizeRatings,
  mergeRatings,
  buildDishSnapshot,
  resolveDishSnapshot,
  summarizeReviews,
  computeRatingBonus,
  pointsDocId,
  reviewDocId,
} = require('./chef-core');

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

/** 近期菜单回看的自然日天数与读取条数 */
const RECENT_MENU_DAYS = 7;
const MAX_RECENT_MENUS = 10;

/** 近期做过的菜保留少量在候选末尾，供用户明确要求时选择 */
const RECENT_CANDIDATE_LIMIT = 5;

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

function toCandidateSummary(recipe, inventoryNames, recentIds) {
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
    // 近 7 天是否已经做过：仅作为模型判断依据，不落库、不返回前端
    recentlyUsed: recentIds ? recentIds.has(recipe._id) : false,
  };
}

/**
 * 读取该家庭最近 7 天的菜单记录。
 * 历史菜单只用于避免重复，任何读取问题都降级为空，不阻断换菜 / 重新推荐。
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
    if (!isCollectionMissing(e)) {
      console.warn('[menu] 读取近期菜单失败，已跳过历史去重', e && e.message);
    }
    return [];
  }
}

function collectRecentIds(recentMenus) {
  const ids = new Set();
  (recentMenus || []).forEach((menu) => {
    (menu.items || []).forEach((item) => {
      if (item && item.recipeId) ids.add(item.recipeId);
    });
  });
  return ids;
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
 * 组装换菜 / 重新推荐的候选：
 *   - 近 7 天做过的菜排到末尾（保留少量，不能简单屏蔽）；
 *   - 其余候选按食材匹配度排序后按请求轮转，
 *     避免模型的位置偏好总是选中排在最前的固定几道菜。
 */
function buildCandidates(scored, seed) {
  const fresh = scored.filter((c) => !c.recentlyUsed).slice(0, MAX_CANDIDATES);
  const recent = scored.filter((c) => c.recentlyUsed).slice(0, RECENT_CANDIDATE_LIMIT);
  return rotateList(fresh, seed).concat(recent);
}

/** 近期菜单摘要：只保留菜名与主要食材，避免提示词过长 */
function summarizeRecentMenus(recentMenus) {
  return (recentMenus || [])
    .map((menu) => {
      const dishes = (menu.items || [])
        .map((item) => (item && item.name ? String(item.name).trim() : ''))
        .filter(Boolean);
      if (dishes.length === 0) return null;

      const ingredients = [];
      (menu.items || []).forEach((item) => {
        (item.ingredients || []).forEach((ing) => {
          const name = (ing && ing.name ? String(ing.name).trim() : '');
          if (name && ingredients.indexOf(name) === -1) ingredients.push(name);
        });
      });

      return {
        date: (menu.createdAt || '').slice(0, 10),
        dishes: dishes.slice(0, 5),
        mainIngredients: ingredients.slice(0, 8),
      };
    })
    .filter(Boolean);
}

/**
 * 读取可用菜谱：公共内置菜谱 + 本家庭由 AI 生成的菜谱。
 *
 * 只读 builtin 会有两个致命后果：
 *   1. 推荐阶段刚落库的库外菜，在「确认菜单」时会被判定为「菜谱不存在」，
 *      整份菜单确认失败；
 *   2. 换菜 / 重推时候选里永远没有这些新菜，等于库外扩展白做。
 *
 * ai_generated 必须按 familyId 隔离，否则会串到别人家的菜单上。
 */
async function loadRecipes(familyId) {
  const builtinP = db.collection('recipes')
    .where({ source: 'builtin', isActive: true })
    .limit(400)
    .get();
  const aiP = familyId
    ? db.collection('recipes')
      .where({ source: 'ai_generated', familyId: familyId, isActive: true })
      .limit(100)
      .get()
    : Promise.resolve({ data: [] });

  try {
    const [builtin, ai] = await Promise.all([builtinP, aiP]);
    return (builtin.data || []).concat(ai.data || []);
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

/**
 * 把 AI 生成的库外菜写入 recipes，返回菜谱文档。
 *
 * 与 recommend 云函数的落库逻辑保持一致：做法生成、营养计算、采购清单
 * 都按 recipeId 读 recipes 表，不落库这三条链路都会断。
 */
async function persistGeneratedRecipe(dish, userId, familyId) {
  try {
    const exists = await db.collection('recipes')
      .where({ name: dish.name, isActive: true })
      .limit(20)
      .get();
    // 只复用自己的：内置菜谱公共可用，AI 生成的按家庭隔离
    const reusable = (exists.data || []).find((item) => (
      item.source === 'builtin' ||
      (item.source === 'ai_generated' && item.familyId === familyId)
    ));
    if (reusable) return reusable;

    const now = new Date().toISOString();
    const doc = {
      name: dish.name,
      description: '',
      category: dish.category,
      tags: dish.tags || [],
      difficulty: dish.difficulty,
      cookTime: dish.cookTime,
      servings: dish.servings,
      ingredients: dish.ingredients,
      steps: [],
      source: 'ai_generated',
      familyId: familyId || '',
      createdBy: userId || '',
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };

    const added = await db.collection('recipes').add({ data: doc });
    return Object.assign({ _id: added._id }, doc);
  } catch (e) {
    console.warn('[menu] 库外菜落库失败：' + dish.name, e && (e.errMsg || e.message));
    return null;
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
    recentlyUsed: !!c.recentlyUsed,
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
    '',
    '如果候选里没有合适的菜，也可以给出库外新菜（主料必须带准确用量，不能写适量）：',
    '{"newDish": {"name": "菜名", "category": "家常菜", "tags": ["川味"], ' +
      '"cookTime": 20, "servings": 2, "ingredients": [{"name": "主料", "amount": 200, "unit": "g"}]}}',
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

  // 兼容两种返回：从候选里选（selectedIds）或给出库外新菜（newDish）
  if (parsed && parsed.newDish !== undefined) {
    return { selectedIds: [], newDishes: parsed.newDish ? [parsed.newDish] : [] };
  }

  if (!parsed || !Array.isArray(parsed.selectedIds)) {
    throw Object.assign(new Error('模型返回格式不正确，请稍后重试'), { code: 'AI_FORMAT_ERROR' });
  }

  return {
    selectedIds: parsed.selectedIds.filter((id) => typeof id === 'string'),
    newDishes: [],
  };
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

  // 校验每个 recipeId 都在库中存在（含本家庭 AI 生成的菜）
  const recipes = await loadRecipes(event.familyId || '');
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

  // 掌勺人：优先沿用本餐次已有方案的掌勺人；没有方案时由发起人担任。
  // 这样「干饭人先保存了一份草稿」也不会顺带拿到确认权。
  const mealType = event.mealType || 'dinner';
  let planDoc = null;
  try {
    planDoc = await readMealPlan(event.familyId, beijingDateString(), mealType);
  } catch (e) {
    if (!isCollectionMissing(e)) {
      console.error('[menu] 读取本餐次方案失败，按无方案处理', e && e.message);
    }
  }

  const cookId = (planDoc && planDoc.cookId) || auth.user._id;
  const cookName = (planDoc && planDoc.cookName) || (auth.user.nickname || '');

  // 已确认的最终菜单不允许再被新草稿覆盖
  if (planDoc && planDoc.status === PLAN_STATUS_CONFIRMED) {
    return fail('PLAN_CONFIRMED', '本餐次菜单已确认，如需更换请先由掌勺人重新确认');
  }

  // 本餐次已有方案时，只有掌勺人可以调整菜单；普通成员只能表达偏好。
  // 掌勺人已离群时允许管理员兜底，否则这一餐再也没人能保存点单。
  if (planDoc && planDoc.cookId) {
    const authority = resolveCookAuthority(
      planDoc, auth.user._id, auth.member.role, await loadFamilyMembers(event.familyId),
    );
    if (!authority.allowed) {
      return fail('NOT_MEAL_COOK', '只有本餐次掌勺人可以调整菜单');
    }
  }

  const doc = {
    familyId: event.familyId,
    userId: auth.user._id,
    cookId: cookId,
    cookName: cookName,
    planId: (planDoc && planDoc._id) || '',
    planTitle: typeof event.planTitle === 'string' ? event.planTitle.slice(0, 40) : '',
    mealType: mealType,
    servings: Number(event.servings) || 2,
    items: validItems,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  };

  // 同一餐次只保留一份草稿点单：
  //   掌勺人来回调整菜品时反复保存，不该在 menus 里堆出一串互相矛盾的草稿。
  //   已有草稿且还没锁定时，原地更新菜品。
  let menuId = '';
  const draftId = (planDoc && planDoc.draftMenuId) || '';
  let draftDoc = null;
  if (draftId) {
    try {
      const res = await db.collection('menus').doc(draftId).get();
      draftDoc = res && res.data ? res.data : null;
    } catch (_e) {
      draftDoc = null;
    }
  }

  if (draftDoc && draftDoc.status === 'draft' && draftDoc.familyId === event.familyId) {
    await db.collection('menus').doc(draftId).update({
      data: {
        items: validItems,
        servings: doc.servings,
        planTitle: doc.planTitle,
        updatedAt: now,
      },
    });
    menuId = draftId;
  } else {
    const result = await db.collection('menus').add({ data: doc });
    menuId = result._id;
  }

  // 回写方案：看板据此判断「掌勺人是否已经保存点单」，
  // 干饭人的建议也从这份草稿菜单读取菜品范围。
  if (planDoc) {
    try {
      await db.collection(PLAN_COLLECTION).doc(planDoc._id).update({
        data: { draftMenuId: menuId, updatedAt: now },
      });
    } catch (e) {
      console.error('[menu] 回写草稿点单失败', e && e.message);
    }
  }

  return ok({
    menuId: menuId,
    ...doc,
    _id: menuId,
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
  const cookError = await requireMealCook(menu, auth.user);
  if (cookError) return cookError;
  // 已完成的用餐记录作为历史快照保留，不再接受任何改动
  if (menu.status === 'completed') {
    return fail('MENU_COMPLETED', '本餐已完成，不能再修改菜品');
  }

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
  const cookError = await requireMealCook(menu, auth.user);
  if (cookError) return cookError;
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

  // 3. 读取家庭食材 / 菜谱库 / 家庭偏好 / 近期菜单：互不依赖，并行读取
  const [ingredients, recipes, familyPrefs, recentMenus] = await Promise.all([
    loadIngredients(familyId),
    loadRecipes(familyId),
    loadFamilyPreferences(familyId),
    loadRecentMenus(familyId),
  ]);

  const inventoryNames = new Set(ingredients.map((i) => (i.standardName || i.name || '').trim()).filter(Boolean));
  if (recipes.length === 0) {
    return fail('NO_RECIPES', '菜谱库为空');
  }
  const recentIds = collectRecentIds(recentMenus);
  const recentSummary = summarizeRecentMenus(recentMenus);

  // E2：按家庭过敏原 / 忌口硬过滤，AI 只能从安全菜谱里选
  const diet = buildDiet(familyPrefs);
  const dietFiltered = filterRecipes(recipes, diet);
  if (diet.rules.length > 0 && dietFiltered.kept.length === 0) {
    return fail('DIET_BLOCKED', '按家庭过敏原与忌口过滤后没有可替换的菜谱，请调整家庭偏好');
  }

  // 4. 候选列表：排除当前菜单已有菜品和 target 本身
  const usedIds = new Set((menu.items || []).map((it) => it.recipeId));
  const scored = dietFiltered.kept
    .filter((r) => !usedIds.has(r._id))
    .map((r) => toCandidateSummary(r, inventoryNames, recentIds))
    .sort((a, b) => {
      const aScore = a.ingredients.length > 0 ? a.matchedIngredients / a.ingredients.length : 0;
      const bScore = b.ingredients.length > 0 ? b.matchedIngredients / b.ingredients.length : 0;
      return bScore - aScore;
    });
  // 4.1 被替换菜品与其他菜品的签名：换菜的核心约束是「别再给我同一类」
  const targetSignature = buildSignature(target);
  const otherSignatures = (menu.items || [])
    .filter((it) => it.recipeId !== recipeId)
    .map((it) => ({ name: it.name, sig: buildSignature(it) }));

  // 4.2 「已试过」的菜：用户连点几次换菜，每次都应拿到不同的答案。
  //     客户端可通过 triedRecipeIds 把前几轮换出来的菜带上来，
  //     否则连点三次很可能三次都拿到同一道菜。
  const triedIds = new Set(
    (Array.isArray(event.triedRecipeIds) ? event.triedRecipeIds : [])
      .filter((id) => typeof id === 'string' && id.length > 0),
  );
  triedIds.add(recipeId);

  // 4.3 硬去重：与被替换菜 / 菜单内其他菜「同主料同做法」的候选直接剔除。
  //     模型不一定遵守提示词，这一层不能只靠它。
  const narrowed = scored.filter((cand) => {
    if (triedIds.has(cand.id)) return false;

    const related = compareSignature(cand, targetSignature);
    if (related.level === 'identical' || related.level === 'similar') return false;

    // 一道菜单里不该出现两个「猪|炒」
    for (let i = 0; i < otherSignatures.length; i++) {
      const conflict = compareSignature(cand, otherSignatures[i].sig);
      if (conflict.level === 'identical' || conflict.level === 'similar') return false;
    }
    return true;
  });

  // 硬去重后候选太少时退回原候选：宁可给出同类菜，也不能让换菜直接失败
  const pool = narrowed.length > 0 ? narrowed : scored;
  const candidates = buildCandidates(pool, hashSeed(menuId + '|' + recipeId + '|' + Date.now()));

  if (candidates.length === 0) {
    return fail('NO_REPLACEMENT', '暂无合适的替换菜品，请取消部分锁定或调整偏好');
  }

  // 5. AI 选菜（凭据解析、额度扣减、用量日志均在 runAiCall 内完成）
  const recentHint = recentSummary.length > 0
    ? '近期菜单（避免重复）：' + recentSummary.map((m) => m.dishes.join('、')).join('；')
    : '近期菜单：无';

  const otherNames = (menu.items || [])
    .filter((it) => it.recipeId !== recipeId)
    .map((it) => it.name);

  // 用户明确写了要求（例如「想吃鱼」）时，探索要求要为它让步
  const userAskedSomething = preferences.length > 0;

  const systemInstructions = [
    '你是一位精通各大菜系的大厨，正在为家庭调整今晚的菜单。',
    '',
    '【这次的任务】',
    '把「' + (target.name || '当前菜品') + '」换成一道真正不一样的菜。',
    '用户已经对这道菜不满意，所以「清炒西兰花 → 蒜蓉炒西兰花」这种换法没有任何意义。',
    '',
    '【必须做到】',
    '1. ' + (targetSignature.protein
      ? '不要再选以「' + targetSignature.protein + '」为主料的菜'
      : '不要再选同类主料的菜') + '；',
    '2. ' + (targetSignature.method
      ? '不要再选以「' + targetSignature.method + '」为主要做法的菜'
      : '尽量换一种烹饪方式') + '；',
    '3. 与菜单里其他菜也不能撞主料和做法：' +
      (otherNames.length > 0 ? otherNames.join('、') : '（本菜单暂无其他菜）') + '；',
    '4. 近期菜单里出现过的菜，以及「同主料 + 同做法」的变体，都不要选；',
    '5. 候选里 recentlyUsed=true 表示近 7 天做过，除非用户明确要求，否则不要选。',
    '',
    recentHint,
    '',
    '【探索方向】',
    userAskedSomething
      ? '用户这次明确提了要求，请优先满足用户要求，上面的换菜要求可以为它让步。'
      : '优先换一个菜系、换一种蛋白质来源、换一种烹饪方式，让这顿饭有新鲜感；' +
        '如果候选里全是同类菜，就选与原菜差别最大的那道。',
    '',
    '【底线】',
    '过敏原和忌口是硬红线。',
    preferences ? '用户要求：' + preferences : '',
    '只输出 JSON，不要输出其他内容。',
  ].filter(Boolean).join('\n');

  let selection;
  try {
    selection = await aiService.runAiCall(
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

  const selectedIds = (selection && selection.selectedIds) || [];
  const newDishes = (selection && selection.newDishes) || [];
  if (selectedIds.length === 0 && newDishes.length === 0) {
    return fail('NO_REPLACEMENT', '暂无合适的替换菜品');
  }

  // 6. 校验新菜：库内菜必须在安全白名单里；库外菜走同一套安全与去重校验
  const recipeMap = {};
  for (const r of dietFiltered.kept) recipeMap[r._id] = r;

  let newRecipe = null;
  if (selectedIds.length > 0) {
    newRecipe = recipeMap[selectedIds[0]];
    if (!newRecipe) {
      return fail('AI_INVALID', '模型返回的菜品无效，请重试');
    }
  } else {
    // 6.1 库外新菜：字段校验 → 过敏原硬校验 → 近期/同类去重
    const normalized = normalizeNewDish(newDishes[0]);
    if (!normalized.ok) {
      return fail('AI_INVALID', '模型给出的新菜信息不完整：' + normalized.reason);
    }
    const dish = normalized.value;

    const dietCheck = checkNewDishDiet(dish, diet, matchRecipe);
    if (!dietCheck.ok) {
      return fail('AI_INVALID', '模型给出的新菜含有家庭忌口或过敏原，已拒绝');
    }

    const recentDishList = (recentMenus || []).reduce((acc, menu) => {
      (menu.items || []).forEach((item) => {
        if (item && item.name) acc.push(item);
      });
      return acc;
    }, []);
    const repeat = isNewDishRepeated(dish, recentDishList, findConflict);
    if (repeat) {
      return fail('AI_INVALID', '模型给出的新菜与近期菜单重复：' + repeat.reason);
    }

    const created = await persistGeneratedRecipe(dish, auth.user._id, familyId);
    if (!created) {
      return fail('AI_INVALID', '新菜保存失败，请重试');
    }
    newRecipe = created;
  }

  // 7. 写入菜单
  const newItem = {
    ...toRecipeView(newRecipe),
    locked: false,
    position: target.position,
    source: selectedIds.length > 0 ? 'manual_replacement' : 'ai_recommendation',
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
  const cookError = await requireMealCook(menu, auth.user);
  if (cookError) return cookError;
  if (menu.status === 'confirmed' || menu.status === 'completed') {
    return fail('MENU_CONFIRMED', '菜单已确认，不能重新推荐');
  }

  const items = menu.items || [];
  const lockedItems = items.filter((it) => it.locked);
  const unlockedItems = items.filter((it) => !it.locked);

  if (unlockedItems.length === 0) {
    return fail('ALL_LOCKED', '所有菜品均已锁定，无需重新推荐');
  }

  // 2. 读取食材 / 菜谱 / 家庭偏好 / 近期菜单：互不依赖，并行读取
  const [ingredients, recipes, familyPrefs, recentMenus] = await Promise.all([
    loadIngredients(familyId),
    loadRecipes(familyId),
    loadFamilyPreferences(familyId),
    loadRecentMenus(familyId),
  ]);

  const inventoryNames = new Set(ingredients.map((i) => (i.standardName || i.name || '').trim()).filter(Boolean));
  if (recipes.length === 0) {
    return fail('NO_RECIPES', '菜谱库为空');
  }
  const recentIds = collectRecentIds(recentMenus);
  const recentSummary = summarizeRecentMenus(recentMenus);

  // E2：按家庭过敏原 / 忌口硬过滤，AI 只能从安全菜谱里选
  const diet = buildDiet(familyPrefs);
  const dietFiltered = filterRecipes(recipes, diet);
  if (diet.rules.length > 0 && dietFiltered.kept.length === 0) {
    return fail('DIET_BLOCKED', '按家庭过敏原与忌口过滤后没有可重新推荐的菜谱，请调整家庭偏好');
  }

  // 3. 候选列表：排除当前菜单的全部菜品（含未锁定项）
  //    只排除锁定项会让「重新生成」把原来的菜原样返回，这是菜品长期不变的核心原因之一。
  const lockedIds = new Set(lockedItems.map((it) => it.recipeId));
  const currentIds = new Set(items.map((it) => it.recipeId));
  const scored = dietFiltered.kept
    .filter((r) => !currentIds.has(r._id))
    .map((r) => toCandidateSummary(r, inventoryNames, recentIds))
    .sort((a, b) => {
      const aScore = a.ingredients.length > 0 ? a.matchedIngredients / a.ingredients.length : 0;
      const bScore = b.ingredients.length > 0 ? b.matchedIngredients / b.ingredients.length : 0;
      return bScore - aScore;
    });
  // 3.1 硬去重：与「即将被替换掉的菜」同主料同做法的候选直接剔除，
  //     否则「重新推荐」只是把青椒肉丝换成鱼香肉丝，用户看到的还是同一顿饭。
  const replaceSignatures = unlockedItems.map((it) => buildSignature(it));
  const narrowed = scored.filter((cand) => {
    for (let i = 0; i < replaceSignatures.length; i++) {
      const conflict = compareSignature(cand, replaceSignatures[i]);
      if (conflict.level === 'identical' || conflict.level === 'similar') return false;
    }
    return true;
  });
  // 硬去重后不够替换所有未锁定项时退回原候选，避免直接失败
  const pool = narrowed.length >= unlockedItems.length ? narrowed : scored;
  const candidates = buildCandidates(pool, hashSeed(menuId + '|' + Date.now()));

  if (candidates.length < unlockedItems.length) {
    return fail('NO_REPLACEMENT', '候选菜品不足，无法为所有未锁定菜品找到替换');
  }

  // 4. AI 选择（凭据解析、额度扣减、用量日志均在 runAiCall 内完成）
  const recentHint = recentSummary.length > 0
    ? '近期菜单（避免重复）：' + recentSummary.map((m) => m.dishes.join('、')).join('；')
    : '近期菜单：无';

  // 被替换掉的菜：告诉模型「这些是用户不要的」，而不是只说「换几道」
  const replacedNames = unlockedItems.map((it) => it.name).filter(Boolean);

  const systemInstructions = [
    '你是一位精通各大菜系的大厨，正在重做这顿饭里还没定下来的菜。',
    '',
    '【要换掉的菜】',
    (replacedNames.length > 0 ? replacedNames.join('、') : '（无）'),
    '这些菜用户不满意，请换成 ' + unlockedItems.length + ' 道真正不同的菜。',
    '换汤不换药（例如清炒西兰花 → 蒜蓉西兰花）不算换菜。',
    '',
    '【必须做到】',
    '1. 不要与上面被换掉的菜同主料同做法；',
    '2. 已锁定菜品（保留不动）：' + (lockedItems.map((it) => it.name).join('、') || '无') + '，新菜不能与它们撞主料和做法；',
    '3. 新选出的 ' + unlockedItems.length + ' 道菜之间也不能高度相似：换开蛋白质来源、蔬菜搭配和烹饪方式；',
    '4. 近期菜单里出现过的菜，以及「同主料 + 同做法」的变体，都不要选；',
    '5. 候选里 recentlyUsed=true 表示近 7 天做过，除非用户明确要求，否则不要选；',
    '6. 在不违反以上要求的前提下，优先选食材匹配度高的，并注意荤素搭配。',
    '',
    recentHint,
    '',
    '【底线】',
    '过敏原和忌口是硬红线。',
    preferences ? '用户要求：' + preferences : '',
    '只输出 JSON。',
  ].filter(Boolean).join('\n');

  // 排除项同时包含锁定菜与被替换菜，避免模型把刚被否掉的菜又选回来
  const excludeNamesForAi = lockedItems.map((it) => it.name).concat(replacedNames);

  let selection;
  try {
    selection = await aiService.runAiCall(
      db,
      auth.user._id,
      { action: 'regenerateUnlockedItems', requestId: event.requestId || '' },
      (aiConfig) => aiPickRecipes(aiConfig, systemInstructions, candidates, unlockedItems.length, excludeNamesForAi),
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

  const selectedIds = (selection && selection.selectedIds) || [];

  // 5.1 库外新菜：与单道换菜同一套安全与去重校验
  const regeneratedNewRecipes = [];
  for (const rawDish of ((selection && selection.newDishes) || [])) {
    if (regeneratedNewRecipes.length >= unlockedItems.length) break;
    const normalized = normalizeNewDish(rawDish);
    if (!normalized.ok) continue;

    const dietCheck = checkNewDishDiet(normalized.value, diet, matchRecipe);
    if (!dietCheck.ok) continue;

    const repeat = isNewDishRepeated(normalized.value, items, findConflict);
    if (repeat) continue;

    const created = await persistGeneratedRecipe(normalized.value, auth.user._id, familyId);
    if (created) regeneratedNewRecipes.push(created);
  }

  const validIds = selectedIds.filter((id) => recipeMap[id] && !lockedIds.has(id));
  if (validIds.length === 0) {
    return fail('AI_INVALID', '模型返回的菜品均无效，原菜单保持不变');
  }

  // 6. 构建新 items 数组：锁定项保留，解锁项替换（先用库内菜，再用库外新菜）
  const replacementRecipes = validIds
    .map((id) => recipeMap[id])
    .filter(Boolean)
    .concat(regeneratedNewRecipes);

  const newItems = [];
  let validIdx = 0;
  for (const item of items) {
    if (item.locked) {
      // 锁定项必须原样保留，不能被本次重推覆盖
      newItems.push(item);
    } else if (validIdx < replacementRecipes.length) {
      const recipe = replacementRecipes[validIdx];
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

/**
 * 菜单确认的公共实现：确认草稿菜单、写入营养快照。
 * confirmMenu（草稿点单 → 最终锁定）使用，避免两套营养口径。
 */
async function confirmMenuDoc(menu) {
  if (menu.status === 'confirmed') {
    return fail('ALREADY_CONFIRMED', '菜单已确认');
  }

  const items = menu.items || [];
  if (items.length === 0) {
    return fail('EMPTY_MENU', '菜单没有菜品，无法确认');
  }

  // 校验所有 recipeId 仍在 recipes 中存在且启用（含本家庭 AI 生成的菜）
  const recipes = await loadRecipes(menu.familyId || '');
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
  const menuVersion = menu.menuVersion || 1;
  await db.collection('menus').doc(menu._id).update({
    data: {
      status: 'confirmed',
      nutritionStatus: overallNutritionStatus,
      items: itemsWithNutrition,
      // 版本号在确认时定型：完成用餐后评价对象绑定「这份菜单 + 这个版本」
      menuVersion: menuVersion,
      updatedAt: now,
    },
  });

  return ok({
    menuId: menu._id,
    status: 'confirmed',
    nutritionStatus: overallNutritionStatus,
    updatedAt: now,
  });
}

/**
 * 本餐次掌勺人权限的统一判定。
 *
 * 「一顿餐只有一个发起人（即掌勺人）」是默认规则，所以：
 *   - 本人是掌勺人 → 正常掌勺；
 *   - 掌勺人已不在家庭里（退出 / 方案没有 cookId）→ 管理员兜底接管，
 *     否则这一餐永远没人能保存点单、锁定菜单、标记完成；
 *   - 掌勺人还在家庭里 → 管理员也**不能**抢占。
 *
 * 所有涉及掌勺人权限的入口都走这里，避免各处判断不一致。
 *
 * @returns {{isCook:boolean, canTakeOver:boolean, cookStillInFamily:boolean}}
 */
function resolveCookAuthority(planDoc, userId, memberRole, members) {
  const cookId = (planDoc && planDoc.cookId) || '';
  const isCook = !!cookId && cookId === userId;
  const cookStillInFamily = !!cookId && (members || []).some((m) => m.userId === cookId);
  const canTakeOver = memberRole === 'owner' && !cookStillInFamily;
  return {
    isCook: isCook,
    canTakeOver: canTakeOver,
    cookStillInFamily: cookStillInFamily,
    // 可以行使掌勺人权力的最终结论
    allowed: isCook || canTakeOver,
  };
}

/**
 * 掌勺人校验：菜单若关联了本餐次方案，以方案当前的 cookId 为准，
 * 这样交接掌勺人之后，旧草稿也能由新掌勺人继续确认 / 调整。
 * 没有方案、也没有 cookId 的旧菜单保持历史行为（家庭成员可确认）。
 */
async function requireMealCook(menu, user) {
  let cookId = menu.cookId || '';
  if (menu.planId) {
    try {
      const plan = await readPlanById(menu.planId, menu.familyId);
      if (plan && plan.status !== 'superseded' && plan.cookId) {
        cookId = plan.cookId;
      }
    } catch (_e) {
      // 方案读取失败时退回菜单自身记录的掌勺人
    }
  }
  if (!cookId) return null;
  if (cookId === user._id) return null;
  return fail('NOT_MEAL_COOK', '只有本餐次掌勺人可以确认或修改菜单');
}

async function handleConfirmMenu(event, wxContext) {
  const openid = wxContext.OPENID || '';
  const { menuId } = event;
  const familyId = event.familyId || '';

  if (!menuId) return fail('INVALID_PARAMS', '缺少 menuId');

  const auth = await requireMenuOwnership(openid, menuId, familyId);
  if (auth.error) return auth.error;

  const menu = auth.menu;
  if (menu.status === 'completed') {
    return fail('ALREADY_COMPLETED', '本餐已经完成，历史记录不能再确认或修改');
  }
  const cookError = await requireMealCook(menu, auth.user);
  if (cookError) return cookError;

  // 方案被新一批取代后，旧草稿不应再被确认，否则最终菜单会与家人正在看的方案脱节
  if (menu.planId) {
    const plan = await readPlanById(menu.planId, familyId);
    if (plan && plan.status === 'superseded') {
      return fail('PLAN_SUPERSEDED', '本餐次方案已更新，请重新选择方案后再确认');
    }
    // 掌勺人可能已经交接：确认时把菜单上的掌勺人同步为方案当前掌勺人
    if (plan && plan.cookId && plan.cookId !== menu.cookId) {
      menu.cookId = plan.cookId;
      menu.cookName = plan.cookName || menu.cookName || '';
      try {
        await db.collection('menus').doc(menu._id).update({
          data: { cookId: menu.cookId, cookName: menu.cookName, updatedAt: new Date().toISOString() },
        });
      } catch (_e) {
        // 同步失败不影响确认，菜单详情可能仍显示旧掌勺人
      }
    }
  }

  const result = await confirmMenuDoc(menu);
  // 方案确认后同步状态，点菜页据此判断「已确定，不再接受偏好修改」
  if (result.success && menu.planId) {
    await markPlanConfirmed(menu.planId, menu._id, menu.familyId, auth.user._id);
  }
  return result;
}

/* ============================== getTodayMenu（Phase 11） ============================== */

/**
 * 当前北京时间自然日的 UTC 区间。
 * createdAt 存的是 UTC ISO 字符串，直接按字符串比较需要换算成北京日边界。
 */
function getBeijingDayRange(now) {
  const CN_OFFSET_MS = 8 * 60 * 60 * 1000;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const base = (now ? now.getTime() : Date.now()) + CN_OFFSET_MS;
  const startMs = Math.floor(base / DAY_MS) * DAY_MS - CN_OFFSET_MS;
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + DAY_MS).toISOString(),
  };
}

async function handleGetTodayMenu(event, wxContext) {
  const openid = wxContext.OPENID || '';
  const familyId = event.familyId || '';

  const auth = await requireFamilyMember(openid, familyId);
  if (auth.error) return auth.error;

  // 已确认 / 已完成的菜单优先于草稿：避免一份未确认的草稿把最终菜单挤下首页
  const range = getBeijingDayRange();

  let docs;
  try {
    const query = (statuses) => db.collection('menus')
      .where({
        familyId: familyId,
        status: _.in(statuses),
        createdAt: _.gte(range.start).and(_.lt(range.end)),
      })
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();
    let res = await query(['confirmed', 'completed']);
    if (!res.data || res.data.length === 0) {
      res = await query(['draft']);
    }
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
  // 默认展示已确认 + 已完成的用餐记录；完成后的菜单仍可回看和评价
  if (event.status && ['draft', 'confirmed', 'completed'].indexOf(event.status) !== -1) {
    condition.status = event.status;
  } else {
    condition.status = _.in(['confirmed', 'completed']);
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
    let totalProtein = 0;
    let totalFat = 0;
    let totalCarbs = 0;
    let dishNutritionStatus = 'complete';
    for (const it of menuItems) {
      if (it.nutrition && typeof it.nutrition.calories === 'number') {
        totalCalories += it.nutrition.calories;
      }
      if (it.nutrition && typeof it.nutrition.protein === 'number') {
        totalProtein += it.nutrition.protein;
      }
      if (it.nutrition && typeof it.nutrition.fat === 'number') {
        totalFat += it.nutrition.fat;
      }
      if (it.nutrition && typeof it.nutrition.carbohydrate === 'number') {
        totalCarbs += it.nutrition.carbohydrate;
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
      // 统计值一律取整：浮点累加会出现 84.30000000000001 这类尾数
      totalCalories: totalCalories > 0 ? Math.round(totalCalories) : 0,
      totalProtein: totalProtein > 0 ? Math.round(totalProtein) : 0,
      totalFat: totalFat > 0 ? Math.round(totalFat) : 0,
      totalCarbs: totalCarbs > 0 ? Math.round(totalCarbs) : 0,
      nutritionStatus: doc.nutritionStatus || dishNutritionStatus || 'unknown',
      createdAt: doc.createdAt || '',
      updatedAt: doc.updatedAt || '',
    };
  });

  return ok({ items: items, total: total, page: page, pageSize: pageSize });
}

/* ============================== 餐次协作：共享方案 / 偏好 / 掌勺人确认 ============================== */

const PLAN_COLLECTION = 'menu_plans';
const PREFERENCE_COLLECTION = 'meal_preferences';
const PLAN_STATUS_CONFIRMED = 'confirmed';

/** 家庭成员的展示信息：只取 userId / nickname，不读 openid */
async function loadFamilyMembers(familyId) {
  const membersRes = await db.collection('family_members')
    .where({ familyId: familyId })
    .orderBy('joinedAt', 'asc')
    .limit(20)
    .get();
  const memberships = membersRes.data || [];
  if (memberships.length === 0) return [];

  const userIds = memberships.map((item) => item.userId);
  const usersRes = await db.collection('users').where({ _id: _.in(userIds) }).get();
  const userMap = {};
  for (const user of usersRes.data || []) userMap[user._id] = user;

  return memberships.map((item) => {
    const user = userMap[item.userId];
    return {
      userId: item.userId,
      // 历史数据里昵称字段可能是 nickName，两种都要认
      nickname: (user && (user.nickname || user.nickName)) || '家人',
      isOwner: item.role === 'owner',
    };
  });
}

/** 读取本餐次有效方案（open / confirmed）；mealType 为空时取当天最近更新的一份 */
async function readMealPlan(familyId, date, mealType) {
  const condition = {
    familyId: familyId,
    date: date,
    status: _.in(['open', PLAN_STATUS_CONFIRMED]),
  };
  if (mealType) condition.mealType = mealType;

  const res = await db.collection(PLAN_COLLECTION)
    .where(condition)
    .orderBy('updatedAt', 'desc')
    .limit(1)
    .get();
  return (res.data && res.data[0]) || null;
}

/** 按 id 读取方案并校验家庭归属 */
async function readPlanById(planId, familyId) {
  try {
    const res = await db.collection(PLAN_COLLECTION).doc(planId).get();
    const plan = res.data || null;
    if (!plan) return null;
    if (plan.familyId !== familyId) return null;
    return plan;
  } catch (e) {
    if (isCollectionMissing(e)) return null;
    if (e && e.errCode === ERR_DOC_NOT_EXIST) return null;
    if (e && typeof e.message === 'string' &&
      e.message.indexOf('document not exists') !== -1) return null;
    throw e;
  }
}

/** 方案确认后回写状态，失败只记日志（菜单已经确认，不因附属动作回滚） */
async function markPlanConfirmed(planId, menuId, familyId, confirmedBy) {
  try {
    const plan = await readPlanById(planId, familyId);
    if (!plan) return;
    const now = new Date().toISOString();
    await db.collection(PLAN_COLLECTION).doc(planId).update({
      data: {
        status: PLAN_STATUS_CONFIRMED,
        menuId: menuId,
        confirmedBy: confirmedBy || plan.cookId || '',
        confirmedAt: now,
        updatedAt: now,
      },
    });
  } catch (e) {
    console.error('[menu] 回写方案确认状态失败', e && e.message);
  }
}

/** 读取本餐次全部偏好记录 */
async function loadPreferences(familyId, date, mealType) {
  const res = await db.collection(PREFERENCE_COLLECTION)
    .where({ familyId: familyId, date: date, mealType: mealType })
    .limit(20)
    .get();
  return res.data || [];
}

/**
 * 餐次看板视图。
 *
 * 只表达「掌勺人保存了点单没有 → 家人建议了什么 → 能不能锁定」，
 * 不再展示候选方案：选哪套方案是掌勺人的事，家人只对已保存的菜单提建议。
 */
function toBoardView(planDoc, draftMenu, members, preferences, viewerId, isOwner) {
  const cookId = (planDoc && planDoc.cookId) || '';
  const isCook = !!cookId && cookId === viewerId;
  const open = isPlanOpen(planDoc);
  // 兜底接管入口：掌勺人已不在家庭里时，管理员可以接手这一餐
  const authority = resolveCookAuthority(planDoc, viewerId, isOwner ? 'owner' : 'member', members);
  const canTakeOver = authority.canTakeOver;

  const memberViews = members.map((m) => ({
    userId: m.userId,
    nickname: m.nickname,
    isCook: m.userId === cookId,
  }));

  if (!planDoc) {
    return {
      plan: null,
      members: memberViews,
      draft: null,
      summary: {
        dishes: [],
        participantCount: 0,
        memberCount: members.length,
        totalMembers: members.length,
        missingMembers: members.map((m) => m.nickname),
        my: null,
      },
      isCook: false,
      isOwner: !!isOwner,
      canConfirm: false,
      canRegenerate: false,
      canSetCook: false,
      canTakeOver: false,
    };
  }

  const menuItems = (draftMenu && Array.isArray(draftMenu.items)) ? draftMenu.items : [];
  const summary = summarizePreferences({
    menuItems: menuItems,
    preferences: preferences,
    members: members,
    viewerId: viewerId,
    familyId: planDoc.familyId,
  });

  return {
    plan: {
      planId: planDoc._id,
      familyId: planDoc.familyId,
      date: planDoc.date,
      mealType: planDoc.mealType,
      servings: planDoc.servings || 0,
      status: planDoc.status,
      cookId: cookId,
      cookName: planDoc.cookName || '',
      menuId: planDoc.menuId || '',
      draftMenuId: planDoc.draftMenuId || '',
      planTitle: (draftMenu && draftMenu.planTitle) || '',
      generatedBy: planDoc.generatedBy || '',
      createdAt: planDoc.createdAt || '',
      updatedAt: planDoc.updatedAt || '',
    },
    members: memberViews,
    draft: draftMenu ? {
      menuId: draftMenu._id,
      title: draftMenu.planTitle || '',
      status: draftMenu.status,
      items: menuItems.map((item) => ({
        recipeId: item.recipeId,
        name: item.name,
        category: item.category || '',
        cookTime: item.cookTime || 0,
        difficulty: item.difficulty || '',
      })),
    } : null,
    summary: summary,
    isCook: isCook,
    isOwner: !!isOwner,
    canConfirm: open && isCook && !!draftMenu,
    canRegenerate: open && isCook,
    canSetCook: open && (isCook || canTakeOver),
    /** 管理员在掌勺人已离群时的兜底接管 */
    canTakeOver: open && canTakeOver,
  };
}

/* ------------------------------ getMealBoard ------------------------------ */

/**
 * 点菜页 / 首页的餐次看板：共享方案 + 偏好汇总 + 当前掌勺人。
 * 未传 planDate 时按北京时间当天。
 */
async function handleGetMealBoard(event, wxContext) {
  const openid = wxContext.OPENID || '';
  const familyId = event.familyId || '';
  // mealType 为空 = 首页场景：取当天最近更新的一份方案，不限定餐次
  const mealType = typeof event.mealType === 'string' ? event.mealType : '';
  const date = typeof event.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(event.date)
    ? event.date
    : beijingDateString();

  const auth = await requireFamilyMember(openid, familyId);
  if (auth.error) return auth.error;

  let planDoc = null;
  let preferences = [];
  try {
    planDoc = await readMealPlan(familyId, date, mealType);
    if (planDoc) {
      preferences = await loadPreferences(familyId, date, planDoc.mealType);
    }
  } catch (e) {
    if (isCollectionMissing(e)) {
      // 集合还没建：按「暂无共享方案」返回，不阻塞页面与旧流程
      return ok({
        available: false,
        date: date,
        mealType: mealType || 'dinner',
        plan: null,
        members: [],
        summary: null,
        isCook: false,
        isOwner: auth.member.role === 'owner',
        canConfirm: false,
        canRegenerate: false,
      });
    }
    throw e;
  }

  // 掌勺人已保存的点单：家人的建议只能针对这份菜单提
  let draftMenu = null;
  if (planDoc && planDoc.draftMenuId) {
    draftMenu = await readMenu(planDoc.draftMenuId);
    if (draftMenu && draftMenu.familyId !== familyId) draftMenu = null;
  }

  const members = await loadFamilyMembers(familyId);
  const board = toBoardView(
    planDoc, draftMenu, members, preferences, auth.user._id, auth.member.role === 'owner',
  );

  return ok(Object.assign({
    available: true,
    date: date,
    mealType: (planDoc && planDoc.mealType) || mealType || 'dinner',
  }, board));
}

/* ------------------------------ submitPreference ------------------------------ */

/**
 * 提交 / 修改自己对「掌勺人已保存点单」的菜品建议。
 *
 * 权限：任何家庭成员都能建议，但只是建议——
 *   最终菜单由掌勺人锁定，这里写入的 want/avoid 不会自动改变菜单内容。
 * 前置：掌勺人必须先保存点单（plan.draftMenuId），否则没有可建议的菜品。
 * 同一成员同餐次只保留一条记录；菜单锁定后不再接受修改。
 */
async function handleSubmitPreference(event, wxContext) {
  const openid = wxContext.OPENID || '';
  const familyId = event.familyId || '';
  const mealType = event.mealType || 'dinner';

  const auth = await requireFamilyMember(openid, familyId);
  if (auth.error) return auth.error;

  const dishResult = normalizeDishVotes(event.dishVotes);
  if (dishResult.error) return fail('INVALID_PARAMS', dishResult.error);

  const planId = typeof event.planId === 'string' ? event.planId : '';
  if (!planId) return fail('INVALID_PARAMS', '缺少 planId');

  const planDoc = await readPlanById(planId, familyId);
  if (!planDoc) return fail('PLAN_NOT_FOUND', '方案不存在或已失效');
  if (planDoc.status === 'superseded') {
    return fail('PLAN_NOT_FOUND', '方案已更新，请刷新后再选');
  }
  if (planDoc.status === PLAN_STATUS_CONFIRMED) {
    return fail('PLAN_CONFIRMED', '本餐次菜单已锁定，不能再修改建议');
  }

  // 掌勺人还没保存点单时，没有可用于建议的菜品范围
  const draftMenuId = planDoc.draftMenuId || '';
  if (!draftMenuId) {
    return fail('NO_DRAFT_MENU', '掌勺人还没有保存点单，暂时不能提建议');
  }
  const draftMenu = await readMenu(draftMenuId);
  if (!draftMenu || draftMenu.status !== 'draft') {
    return fail('NO_DRAFT_MENU', '点单已更新，请刷新后再看');
  }

  // 建议必须落在掌勺人已保存的菜品范围内，
  // 否则旧建议会「复活」到新菜单上，或被人塞进菜单里没有的菜。
  const allowedRecipeIds = {};
  for (const item of draftMenu.items || []) {
    if (item && item.recipeId) allowedRecipeIds[item.recipeId] = true;
  }
  for (const vote of dishResult.value) {
    if (!allowedRecipeIds[vote.recipeId]) {
      return fail('INVALID_PARAMS', '这道菜不在本次点单里：' + vote.recipeId);
    }
  }

  const date = planDoc.date;
  const note = normalizeNote(event.note);
  const now = new Date().toISOString();

  try {
    const existing = await db.collection(PREFERENCE_COLLECTION)
      .where({ familyId: familyId, date: date, mealType: planDoc.mealType, userId: auth.user._id })
      .limit(1)
      .get();
    const current = existing.data && existing.data[0];

    const payload = {
      familyId: familyId,
      date: date,
      mealType: planDoc.mealType,
      userId: auth.user._id,
      planId: planId,
      menuId: draftMenuId,
      dishVotes: dishResult.value,
      note: note,
      updatedAt: now,
    };

    if (current) {
      await db.collection(PREFERENCE_COLLECTION).doc(current._id).update({ data: payload });
      return ok({ preference: Object.assign({}, payload, { _id: current._id }) });
    }

    const added = await db.collection(PREFERENCE_COLLECTION).add({
      data: Object.assign({}, payload, { createdAt: now }),
    });
    return ok({ preference: Object.assign({}, payload, { _id: added._id, createdAt: now }) });
  } catch (e) {
    if (isCollectionMissing(e)) {
      return fail('DB_NOT_READY', '数据库集合 meal_preferences 不存在，请先在云开发控制台创建');
    }
    throw e;
  }
}

/* ------------------------------ setMealCook ------------------------------ */

/**
 * 交接本餐次掌勺人。
 *
 * 「发起人就是掌勺人」是这一餐的唯一决策人，所以正常只有当前掌勺人能主动交出去。
 *
 * 唯一例外是兜底：掌勺人已经退群（或方案里根本没有掌勺人）时，
 * 这一餐否则会永远卡死、没人能开火，此时允许家庭管理员接管。
 * 掌勺人还在家庭里时，管理员**不能**抢占——「一个人拍板」这条不成立就没有意义。
 */
async function handleSetMealCook(event, wxContext) {
  const openid = wxContext.OPENID || '';
  const familyId = event.familyId || '';
  const mealType = event.mealType || 'dinner';
  const cookId = typeof event.cookId === 'string' ? event.cookId : '';
  const date = typeof event.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(event.date)
    ? event.date
    : beijingDateString();

  const auth = await requireFamilyMember(openid, familyId);
  if (auth.error) return auth.error;

  if (!cookId) return fail('INVALID_PARAMS', '缺少 cookId');

  const planDoc = await readMealPlan(familyId, date, mealType);
  if (!planDoc) return fail('PLAN_NOT_FOUND', '本餐次还没有推荐方案');

  const members = await loadFamilyMembers(familyId);

  const authority = resolveCookAuthority(planDoc, auth.user._id, auth.member.role, members);
  if (!authority.allowed) {
    return fail('NOT_MEAL_COOK', '只有本餐次掌勺人可以交接掌勺人');
  }

  if (planDoc.status === PLAN_STATUS_CONFIRMED) {
    return fail('PLAN_CONFIRMED', '本餐次菜单已确认，不能再更换掌勺人');
  }

  const target = members.find((item) => item.userId === cookId);
  if (!target) return fail('INVALID_PARAMS', '掌勺人必须是当前家庭成员');

  const now = new Date().toISOString();
  // 交接审计：只保留最近 20 条，随方案文档一起留存
  const cookHistory = Array.isArray(planDoc.cookHistory) ? planDoc.cookHistory.slice(-19) : [];
  cookHistory.push({
    at: now,
    by: auth.user._id,
    fromCookId: planDoc.cookId || '',
    toCookId: target.userId,
  });

  await db.collection(PLAN_COLLECTION).doc(planDoc._id).update({
    data: {
      cookId: target.userId,
      cookName: target.nickname,
      cookHistory: cookHistory,
      updatedAt: now,
    },
  });

  // 菜单上的 cookId 是「完成制作 / 评价归属」的唯一依据，
  // 交接后不同步就会出现「方案里换了人、菜单还认旧掌勺人」的错位。
  const linkedMenuIds = [planDoc.draftMenuId, planDoc.menuId].filter(Boolean);
  for (const menuId of linkedMenuIds) {
    try {
      await db.collection('menus').doc(menuId).update({
        data: { cookId: target.userId, cookName: target.nickname, updatedAt: now },
      });
    } catch (e) {
      console.error('[menu] 同步菜单掌勺人失败', menuId, e && e.message);
    }
  }

  return ok({ cookId: target.userId, cookName: target.nickname });
}

/* ============================== 饭后评价与掌勺人成长（阶段二） ============================== */

const REVIEW_COLLECTION = 'meal_reviews';
const POINTS_COLLECTION = 'chef_points';
const ORDER_COLLECTION = 'family_orders';
const ORDER_ITEM_COLLECTION = 'family_order_items';

/** 读取单个文档，不存在或集合缺失时返回 null（用于幂等预检） */
/** 「文档不存在」在各种 SDK / 环境的文案都不完全一样，统一按正则匹配 */
const DOC_NOT_EXIST_PATTERN = /document\s+(with\s+_id\s+\S+\s+)?(does\s+not\s+exist|not\s+exists)|DOCUMENT_NOT_FOUND/i;

function isDocNotExistError(err) {
  if (!err) return false;
  if (err.errCode === ERR_DOC_NOT_EXIST) return true;
  const text = String(err.errMsg || err.message || '');
  return DOC_NOT_EXIST_PATTERN.test(text);
}

async function readDocOrNull(collection, docId) {
  try {
    const res = await db.collection(collection).doc(docId).get();
    return res.data || null;
  } catch (e) {
    if (isDocNotExistError(e)) return null;
    if (isCollectionMissing(e)) return null;
    throw e;
  }
}

/** 能参与评价的人：去掉掌勺人（做饭的人不评自己的菜） */
function ratersOf(members, cookId) {
  if (!cookId) return members.slice();
  return members.filter((item) => item.userId !== cookId);
}

/**
 * 本菜单的点单进度：谁已经提交过自己的份数。
 *
 * 只统计当前家庭成员；退群成员的旧记录不计入，
 * 否则「全员完成」永远无法满足。
 */
async function loadOrderProgress(menuId, familyId, members) {
  try {
    const res = await db.collection(ORDER_COLLECTION)
      .where({ menuId: menuId, familyId: familyId })
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();
    const order = (res.data && res.data[0]) || null;
    if (!order) {
      return { orderId: '', status: '', orderedCount: 0, memberCount: members.length, missingMembers: members.map((m) => m.nickname), allDone: false };
    }

    let rows = [];
    try {
      const itemsRes = await db.collection(ORDER_ITEM_COLLECTION)
        .where({ orderId: order._id })
        .limit(50)
        .get();
      rows = itemsRes.data || [];
    } catch (e) {
      console.warn('[menu] 读取点单明细失败', e && (e.errMsg || e.message));
    }

    const memberIds = {};
    for (const m of members) memberIds[m.userId] = true;
    const orderedIds = {};
    for (const row of rows) {
      if (row && row.userId && memberIds[row.userId]) orderedIds[row.userId] = true;
    }

    const missingMembers = members
      .filter((m) => !orderedIds[m.userId])
      .map((m) => m.nickname || '家人');

    return {
      orderId: order._id,
      status: order.status || '',
      orderedCount: Object.keys(orderedIds).length,
      memberCount: members.length,
      missingMembers: order.status === 'closed' ? [] : missingMembers,
      allDone: order.status === 'closed' || missingMembers.length === 0,
    };
  } catch (e) {
    console.warn('[menu] 读取点单进度失败', e && (e.errMsg || e.message));
    return { orderId: '', status: '', orderedCount: 0, memberCount: members.length, missingMembers: members.map((m) => m.nickname), allDone: false };
  }
}

/** 主键冲突：并发写入同一固定 _id 时的结果，按「已处理过」对待 */
function isDuplicateKeyError(err) {
  if (!err) return false;
  const message = typeof err.message === 'string' ? err.message : '';
  return err.errCode === -501001 ||
    err.errCode === -502001 ||
    message.indexOf('duplicate') !== -1 ||
    message.indexOf('already exists') !== -1;
}

/** 本餐所有成员的评分记录 */
async function loadReviews(familyId, menuId) {
  try {
    const res = await db.collection(REVIEW_COLLECTION)
      .where({ familyId: familyId, menuId: menuId })
      .limit(20)
      .get();
    return res.data || [];
  } catch (e) {
    // 读不到历史评分时按「还没人评分」处理，不用 500 挡住用户打分
    console.warn('[menu] 读取评价失败，按无评价处理', e && (e.errMsg || e.message));
    return [];
  }
}

/** 按 createdAt 倒序（内存排序，用于索引缺失时的兜底） */
function sortByCreatedAtDesc(rows) {
  return rows.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

/**
 * 掌勺人在本家庭的积分流水（按时间倒序）。
 *
 * 优先使用带 orderBy 的分页查询；真实环境里如果没有建复合索引，
 * 云开发会直接报错，这里退化为「不带 orderBy + 内存排序」，
 * 保证成长卡不会因为缺索引就整页 500。
 */
async function loadPointsLedger(familyId, cookId, maxRecords) {
  const limit = maxRecords || 1000;
  const pageSize = 100;
  const rows = [];

  try {
    for (let skip = 0; skip < limit; skip += pageSize) {
      const res = await db.collection(POINTS_COLLECTION)
        .where({ familyId: familyId, cookId: cookId })
        .orderBy('createdAt', 'desc')
        .skip(skip)
        .limit(pageSize)
        .get();
      const page = res.data || [];
      rows.push.apply(rows, page);
      if (page.length < pageSize) break;
    }
    return rows;
  } catch (e) {
    if (isCollectionMissing(e)) return [];
    console.warn('[menu] 积分流水有序查询失败，退回内存排序', e && (e.errMsg || e.message));
  }

  try {
    const res = await db.collection(POINTS_COLLECTION)
      .where({ familyId: familyId, cookId: cookId })
      .limit(limit)
      .get();
    return sortByCreatedAtDesc(res.data || []);
  } catch (e) {
    // 积分只是附加信息，任何读取失败都不应该让评价 / 成长接口整体失败
    console.warn('[menu] 积分流水读取失败，按 0 分处理', e && (e.errMsg || e.message));
    return [];
  }
}

/**
 * 掌勺人成长快照。
 * 累计积分直接由积分流水求和，余额与流水天然一致，不依赖缓存字段。
 */
async function loadGrowth(familyId, cookId) {
  const ledger = await loadPointsLedger(familyId, cookId);
  let points = 0;
  for (const row of ledger) points += Number(row.points) || 0;
  const level = resolveLevel(points);
  const latest = ledger[0];

  return Object.assign({ familyId: familyId, userId: cookId, nickname: '' }, level, {
    lastReason: latest ? (latest.reason || '') : '',
    lastPoints: latest ? (Number(latest.points) || 0) : 0,
    lastAt: latest ? (latest.createdAt || '') : '',
    recordCount: ledger.length,
  });
}

/**
 * 发放一笔积分。
 * 流水使用固定 _id（一餐一类型一条），先查后插 + 主键冲突兜底，
 * 因此重复点击 / 重试 / 并发请求都不会重复加分。
 */
async function awardPoints(payload) {
  const points = Math.floor(Number(payload.points) || 0);
  if (!payload.familyId || !payload.cookId || !payload.menuId || points <= 0) {
    return { points: 0, skipped: true };
  }

  const docId = pointsDocId(payload.menuId, payload.type);
  const existing = await readDocOrNull(POINTS_COLLECTION, docId);
  if (existing) return { points: 0, skipped: true };

  const now = new Date().toISOString();
  try {
    await db.collection(POINTS_COLLECTION).add({
      data: {
        _id: docId,
        familyId: payload.familyId,
        cookId: payload.cookId,
        menuId: payload.menuId,
        type: payload.type,
        points: points,
        reason: payload.reason || '',
        avgStars: payload.avgStars === undefined ? null : payload.avgStars,
        ratingCount: payload.ratingCount === undefined ? null : payload.ratingCount,
        createdBy: payload.createdBy || '',
        createdAt: now,
      },
    });
    return { points: points, skipped: false };
  } catch (e) {
    if (isDuplicateKeyError(e)) return { points: 0, skipped: true };
    if (isCollectionMissing(e)) {
      console.warn('[menu] chef_points 集合不存在，积分未记录');
      return { points: 0, skipped: true, collectionMissing: true };
    }
    throw e;
  }
}

/* ------------------------------ completeMeal ------------------------------ */

/**
 * 标记本餐已完成。
 *
 * 权限：该家庭成员；状态只允许 confirmed → completed。
 * 幂等：状态条件更新保证只有一次生效；基础积分用固定流水 ID 兜底。
 */
async function handleCompleteMeal(event, wxContext) {
  const openid = wxContext.OPENID || '';
  const familyId = event.familyId || '';
  const menuId = event.menuId || '';

  if (!menuId) return fail('INVALID_PARAMS', '缺少 menuId');

  const auth = await requireFamilyMember(openid, familyId);
  if (auth.error) return auth.error;

  const menu = await readMenu(menuId);
  if (!menu) return fail('MENU_NOT_FOUND', '菜单不存在或已被删除');
  if (menu.familyId !== familyId) return fail('FORBIDDEN', '无权操作该菜单');

  if (menu.status === 'draft') {
    return fail('MENU_NOT_CONFIRMED', '菜单还没有确认，不能标记本餐已完成');
  }
  if (menu.status !== 'confirmed' && menu.status !== 'completed') {
    return fail('MENU_STATUS_INVALID', '当前菜单状态不能标记完成');
  }

  // 掌勺人未确定时不擅自选人发积分，提示先走现有交接流程
  if (!menu.cookId) {
    return fail('COOK_REQUIRED', '本餐还没有指定掌勺人，请先在「点菜」页指定掌勺人');
  }
  // 「完成制作」只能由掌勺人操作：做法是掌勺人做的，完成也只有他知道
  if (menu.cookId !== auth.user._id) {
    return fail('ONLY_COOK_CAN_COMPLETE', '只有本餐掌勺人可以标记完成制作');
  }

  // 家人的菜品建议随时可以补，但不能卡住掌勺人开火：
  // 掌勺人已经锁定菜单，就该能标记完成，不必等所有人点完。

  const now = new Date().toISOString();
  let justCompleted = false;

  if (menu.status === 'confirmed') {

    // 条件更新：并发时只有一个请求能把 confirmed 改成 completed
    const updated = await db.collection('menus')
      .where({ _id: menuId, familyId: familyId, status: 'confirmed' })
      .update({
        data: {
          status: 'completed',
          completedAt: now,
          completedBy: auth.user._id,
          // 固化本次用餐的菜品快照：之后任何菜单改动都不影响评价对象
          snapshotItems: buildDishSnapshot(menu),
          menuVersion: menu.menuVersion || 1,
          updatedAt: now,
        },
      });

    justCompleted = !!(updated && updated.stats && updated.stats.updated > 0);
    const latest = await readMenu(menuId);
    if (latest) {
      menu.status = latest.status;
      menu.completedAt = latest.completedAt;
      menu.completedBy = latest.completedBy;
      menu.cookId = latest.cookId;
      menu.cookName = latest.cookName;
      menu.snapshotItems = latest.snapshotItems;
      menu.menuVersion = latest.menuVersion;
    }
    if (!justCompleted && menu.status !== 'completed') {
      return fail('MENU_STATUS_CHANGED', '菜单状态已变化，请刷新后重试');
    }
  }

  // 旧数据兼容：早先已完成的菜单没有快照，补写一次（只补缺失字段，不覆盖评价对象）
  if (!justCompleted && !Array.isArray(menu.snapshotItems)) {
    const snapshot = buildDishSnapshot(menu);
    if (snapshot.length > 0) {
      try {
        await db.collection('menus').doc(menuId).update({
          data: { snapshotItems: snapshot, menuVersion: menu.menuVersion || 1 },
        });
        menu.snapshotItems = snapshot;
      } catch (_e) {
        // 补写失败不阻塞完成操作，评价时再按当前菜品兜底
      }
    }
  }

  // 基础积分：固定流水 ID，重复完成 / 网络重试都只会有一条
  const baseAward = await awardPoints({
    familyId: familyId,
    cookId: menu.cookId,
    menuId: menuId,
    type: 'meal_complete',
    points: BASE_POINTS,
    reason: '完成本餐',
    createdBy: auth.user._id,
  });

  const growth = menu.cookId ? await loadGrowth(familyId, menu.cookId) : null;

  return ok({
    menuId: menuId,
    status: 'completed',
    alreadyCompleted: !justCompleted,
    completedAt: menu.completedAt || now,
    completedBy: menu.completedBy || auth.user._id,
    cookId: menu.cookId || '',
    cookName: menu.cookName || '',
    pointsAwarded: baseAward.points,
    growth: growth,
  });
}

/* ------------------------------ submitRatings ------------------------------ */

/**
 * 提交 / 修改自己对本次用餐菜品的评分。
 *
 * - 只能评价已完成的用餐记录；
 * - 只能写自己的记录（userId 取自登录态，不接受前端传入）；
 * - 同一道菜更新原评分，不新增有效记录；
 * - 评分奖励按「一餐一次」结算，反复改分不会重复加分。
 */
async function handleSubmitRatings(event, wxContext) {
  const openid = wxContext.OPENID || '';
  const familyId = event.familyId || '';
  const menuId = event.menuId || '';

  if (!menuId) return fail('INVALID_PARAMS', '缺少 menuId');

  const auth = await requireFamilyMember(openid, familyId);
  if (auth.error) return auth.error;

  const menu = await readMenu(menuId);
  if (!menu) return fail('MENU_NOT_FOUND', '菜单不存在或已被删除');
  if (menu.familyId !== familyId) return fail('FORBIDDEN', '无权评价该菜单');
  if (menu.status !== 'completed') {
    return fail('MENU_NOT_COMPLETED', '本餐还没有标记完成，暂时不能评价');
  }

  // 掌勺人是做饭的人，不参与评价自己的菜，避免自评刷分
  if (menu.cookId && menu.cookId === auth.user._id) {
    return fail('COOK_CANNOT_RATE', '掌勺人负责做菜，这一餐由家人来评价');
  }

  const snapshot = resolveDishSnapshot(menu);
  if (snapshot.length === 0) {
    return fail('EMPTY_MENU', '这份菜单没有可评价的菜品');
  }

  const normalized = normalizeRatings(event.ratings, snapshot.map((item) => item.recipeId));
  if (normalized.error) return fail('INVALID_PARAMS', normalized.error);

  const docId = reviewDocId(menuId, auth.user._id);
  const now = new Date().toISOString();
  const ratingPayload = {
    _id: docId,
    familyId: familyId,
    menuId: menuId,
    userId: auth.user._id,
    nickname: auth.user.nickname || '',
    ratings: normalized.value,
    createdAt: now,
    updatedAt: now,
  };

  let current = await readDocOrNull(REVIEW_COLLECTION, docId);
  if (!current) {
    try {
      await db.collection(REVIEW_COLLECTION).add({ data: ratingPayload });
      current = ratingPayload;
    } catch (e) {
      if (!isDuplicateKeyError(e)) {
        if (isCollectionMissing(e)) {
          return fail('DB_NOT_READY', '数据库集合 meal_reviews 不存在，请先在云开发控制台创建');
        }
        throw e;
      }
      // 并发插入：本次输给了另一条同用户的请求，改为更新已有记录
      current = await readDocOrNull(REVIEW_COLLECTION, docId);
      if (!current) return fail('RETRY_REQUIRED', '提交失败，请重试');
    }
  }

  const merged = mergeRatings(current.ratings, normalized.value);
  await db.collection(REVIEW_COLLECTION).doc(docId).update({
    data: {
      ratings: merged,
      nickname: auth.user.nickname || current.nickname || '',
      updatedAt: now,
    },
  });

  const members = ratersOf(await loadFamilyMembers(familyId), menu.cookId);
  const reviews = await loadReviews(familyId, menuId);
  const summary = summarizeReviews({
    snapshot: snapshot,
    reviews: reviews,
    members: members,
    viewerId: auth.user._id,
  });

  // 评分奖励：只有第一次产生有效评分汇总时才结算一次（固定流水 ID 防重复）
  let bonusAward = { points: 0, skipped: true };
  if (summary.overallAverage !== null && menu.cookId) {
    bonusAward = await awardPoints({
      familyId: familyId,
      cookId: menu.cookId,
      menuId: menuId,
      type: 'rating_bonus',
      points: computeRatingBonus(summary.overallAverage),
      reason: '本餐评分奖励（平均 ' + summary.overallAverage.toFixed(1) + ' 星）',
      avgStars: summary.overallAverage,
      ratingCount: summary.ratingCount,
      createdBy: auth.user._id,
    });
  }

  const growth = menu.cookId ? await loadGrowth(familyId, menu.cookId) : null;

  return ok({
    menuId: menuId,
    summary: summary,
    myRatings: merged,
    cookId: menu.cookId || '',
    cookName: menu.cookName || '',
    pointsAwarded: bonusAward.points,
    growth: growth,
  });
}

/* ------------------------------ getMealReview ------------------------------ */

/** 用餐详情：完成状态 + 评价汇总 + 掌勺人成长 */
async function handleGetMealReview(event, wxContext) {
  const openid = wxContext.OPENID || '';
  const familyId = event.familyId || '';
  const menuId = event.menuId || '';

  if (!menuId) return fail('INVALID_PARAMS', '缺少 menuId');

  const auth = await requireFamilyMember(openid, familyId);
  if (auth.error) return auth.error;

  const menu = await readMenu(menuId);
  if (!menu) return fail('MENU_NOT_FOUND', '菜单不存在或已被删除');
  if (menu.familyId !== familyId) return fail('FORBIDDEN', '无权查看该用餐记录');

  const snapshot = resolveDishSnapshot(menu);
  const allMembers = await loadFamilyMembers(familyId);
  const members = ratersOf(allMembers, menu.cookId);
  const reviews = await loadReviews(familyId, menuId);
  const summary = summarizeReviews({
    snapshot: snapshot,
    reviews: reviews,
    members: members,
    viewerId: auth.user._id,
  });
  const growth = menu.cookId ? await loadGrowth(familyId, menu.cookId) : null;
  const mine = reviews.find((item) => item.userId === auth.user._id);
  const isCook = !!menu.cookId && menu.cookId === auth.user._id;
  const orderProgress = await loadOrderProgress(menuId, familyId, allMembers);

  return ok({
    menuId: menuId,
    menuStatus: menu.status,
    menuVersion: menu.menuVersion || 1,
    completedAt: menu.completedAt || '',
    completedBy: menu.completedBy || '',
    cookId: menu.cookId || '',
    cookName: menu.cookName || '',
    isCook: isCook,
    // 只有掌勺人能看到「完成制作」入口
    canComplete: menu.status === 'confirmed' && isCook,
    // 掌勺人不参与评价
    canRate: menu.status === 'completed' && !isCook,
    orderProgress: orderProgress,
    myRatings: mine ? (mine.ratings || []) : [],
    summary: summary,
    growth: growth,
    rules: {
      basePoints: BASE_POINTS,
      pointsPerStar: POINTS_PER_STAR,
      maxRatingBonus: RATING_BONUS_MAX,
      levels: LEVELS,
    },
  });
}

/* ------------------------------ getChefGrowth ------------------------------ */

/** 掌勺人成长：默认看自己，也可以查看同家庭其他成员（跨家庭一律拒绝） */
async function handleGetChefGrowth(event, wxContext) {
  const openid = wxContext.OPENID || '';
  const familyId = event.familyId || '';
  const targetUserId = typeof event.userId === 'string' ? event.userId : '';

  const auth = await requireFamilyMember(openid, familyId);
  if (auth.error) return auth.error;

  const members = await loadFamilyMembers(familyId);
  const target = targetUserId || auth.user._id;
  const member = members.find((item) => item.userId === target);
  if (!member) return fail('NOT_IN_FAMILY', '该成员不属于本家庭');

  const growth = await loadGrowth(familyId, target);
  growth.nickname = member.nickname;

  return ok({
    growth: growth,
    levels: LEVELS,
    rules: {
      basePoints: BASE_POINTS,
      pointsPerStar: POINTS_PER_STAR,
      maxRatingBonus: RATING_BONUS_MAX,
    },
  });
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

  /* Phase 1：餐次协作 */
  getMealBoard: handleGetMealBoard,
  submitPreference: handleSubmitPreference,
  setMealCook: handleSetMealCook,

  /* 阶段二：饭后评价与掌勺人成长 */
  completeMeal: handleCompleteMeal,
  submitRatings: handleSubmitRatings,
  getMealReview: handleGetMealReview,
  getChefGrowth: handleGetChefGrowth,

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