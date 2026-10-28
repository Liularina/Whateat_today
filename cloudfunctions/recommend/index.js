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
const {
  buildSignature,
  compareSignature,
  findConflict,
  dishesOf,
} = require('./dish-signature');
const { parseDishSelections, checkNewDishDiet, isNewDishRepeated } = require('./new-dish');
const { matchRecipe } = require('./diet-filter');

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

/**
 * 真正写进提示词的候选数量。
 *
 * 菜谱库有 200 道，之前只给模型看 40 道 —— 意味着每轮有 160 道菜它根本没见过，
 * 模型只能在剩下的几十道里反复挑，这是「总是那几道菜」的直接原因。
 * 提到 60 道后仍能控制预填充耗时（单条约 150 字节），但候选覆盖面翻了 1.5 倍。
 */
const MAX_PROMPT_CANDIDATES = 60;

/** 近期菜单回看的自然日天数 */
const RECENT_MENU_DAYS = 7;

/** 最多读取几份近期菜单 */
const MAX_RECENT_MENUS = 10;

/** 近期做过的菜仍保留少量在候选末尾，供用户「明确想吃」时使用 */
const RECENT_CANDIDATE_LIMIT = 5;

/** 每次推荐的菜单套数 */
const MENU_COUNT = 3;

/**
 * 每套菜单的菜品数下限 / 上限。
 * 一餐只有 1—2 道菜不成席，AI 给少了由服务端从安全候选里补齐（不额外消耗 AI 额度）。
 */
const MIN_DISHES_PER_PLAN = 4;
const MAX_DISHES_PER_PLAN = 6;

/** 单次模型输出 token 上限 */
const MAX_OUTPUT_TOKENS = 2048;

/** 餐次映射 */
const MEAL_TYPE_LABELS = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  midnight_snack: '夜宵',
};

/* ============================== 共享推荐方案 ============================== */

/**
 * 同一家庭、同一日期、同一餐次只保留一份有效方案，供所有成员共享。
 * 集合缺失时不阻塞推荐：仍然把结果返回给发起人，只是不落库。
 */
const PLAN_COLLECTION = 'menu_plans';
const CN_OFFSET_MS = 8 * 60 * 60 * 1000;
/** 同一餐次只允许一个生成任务；锁 3 分钟自动过期，避免异常退出后永久占用 */
const PLAN_LOCK_TTL_MS = 3 * 60 * 1000;
/** requestId -> 锁文档 id，由入口统一释放 */
const activeRequestLocks = new Map();

/** 北京时间的自然日，YYYY-MM-DD */
function beijingDateString(input) {
  const base = input ? new Date(input) : new Date();
  return new Date(base.getTime() + CN_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 读取本餐次的有效方案。
 * 只认 open / confirmed：已被新方案取代（superseded）的历史方案不再复用。
 */
async function readMealPlan(familyId, date, mealType) {
  try {
    const res = await db.collection(PLAN_COLLECTION)
      .where({
        familyId: familyId,
        date: date,
        mealType: mealType,
        status: _.in(['open', 'confirmed']),
      })
      .orderBy('updatedAt', 'desc')
      .limit(1)
      .get();
    return (res.data && res.data[0]) || null;
  } catch (e) {
    if (isCollectionMissing(e)) {
      console.warn('[recommend] menu_plans 集合不存在，本次不共享方案');
      return null;
    }
    console.error('[recommend] 读取共享方案失败，按无方案处理', e && e.message);
    return null;
  }
}

/**
 * 获取本餐次生成锁：固定 _id + 过期时间，属于 best-effort 的互斥。
 * 集合缺失时跳过加锁，保证推荐本身可用。
 * @returns {{id:string, acquired:boolean}}
 */
async function acquirePlanLock(familyId, date, mealType, userId) {
  const lockId = 'lock_' + familyId + '_' + date + '_' + mealType;
  const now = Date.now();
  try {
    await db.collection(PLAN_COLLECTION).add({
      data: {
        _id: lockId,
        type: 'plan_lock',
        familyId: familyId,
        date: date,
        mealType: mealType,
        owner: userId,
        expiresAt: now + PLAN_LOCK_TTL_MS,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      },
    });
    return { id: lockId, acquired: true };
  } catch (e) {
    if (e && e.errCode === -501001) {
      // 已有锁：过期则可接管，否则说明家人正在生成
      try {
        const res = await db.collection(PLAN_COLLECTION).doc(lockId).get();
        const lock = res.data;
        if (!lock || !lock.expiresAt || lock.expiresAt < now) {
          await db.collection(PLAN_COLLECTION).doc(lockId).update({
            data: {
              owner: userId,
              expiresAt: now + PLAN_LOCK_TTL_MS,
              updatedAt: new Date(now).toISOString(),
            },
          });
          return { id: lockId, acquired: true };
        }
      } catch (_e) {
        // 锁刚好被释放：让本次请求直接失败并提示稍后重试，避免重复消耗额度
      }
      return { id: '', acquired: false };
    }
    if (isCollectionMissing(e)) return { id: '', acquired: true };
    console.error('[recommend] 获取生成锁失败，按未加锁继续', e && e.message);
    return { id: '', acquired: true };
  }
}

async function releasePlanLock(lockId, ownerId) {
  if (!lockId) return;
  try {
    // 只释放自己的锁：如果本次执行超过 TTL 且锁已被别人接管，不能删掉别人的锁
    const res = await db.collection(PLAN_COLLECTION).doc(lockId).get();
    if (!res.data || res.data.owner !== ownerId) return;
    await db.collection(PLAN_COLLECTION).doc(lockId).remove();
  } catch (_e) {
    // 释放失败由 TTL 兜底
  }
}

/**
 * 写入 / 更新本餐次方案。失败只记日志，不影响本次推荐结果。
 * @returns {Promise<string|null>} 方案文档 id
 */
async function saveMealPlan(payload, existing) {
  const now = new Date().toISOString();
  try {
    const collection = db.collection(PLAN_COLLECTION);

    // 重新生成时先写新方案，再把旧方案标记为 superseded：
    // 这样即使写入失败，旧方案仍然有效，家人不会突然「没有菜单」。
    // 新方案使用新的文档 ID，旧偏好不会错误地继承到一批全新的菜上。
    const added = await collection.add({
      data: Object.assign({}, payload, {
        status: 'open',
        version: existing ? (existing.version || 1) + 1 : 1,
        createdAt: now,
        updatedAt: now,
      }),
    });

    if (existing) {
      await collection.doc(existing._id).update({
        data: {
          status: 'superseded',
          supersededBy: added._id,
          updatedAt: now,
        },
      });
    }

    return added._id;
  } catch (e) {
    if (isCollectionMissing(e)) {
      console.warn('[recommend] menu_plans 集合不存在，方案未落库');
    } else {
      console.error('[recommend] 写入共享方案失败', e && e.message);
    }
    return null;
  }
}

/** 把方案文档转成前端可用的返回结构（与 AI 原始结果同形） */
function toPlanResponse(planDoc, meta) {
  return {
    recommendationId: planDoc._id,
    planId: planDoc._id,
    planStatus: planDoc.status,
    planVersion: planDoc.version || 1,
    shared: true,
    reused: !!(meta && meta.reused),
    cookId: planDoc.cookId || '',
    cookName: planDoc.cookName || '',
    generatedBy: planDoc.generatedBy || '',
    menuId: planDoc.menuId || '',
    date: planDoc.date,
    mealType: planDoc.mealType,
    servings: planDoc.servings,
    menus: planDoc.plans || [],
    createdAt: planDoc.createdAt || '',
    updatedAt: planDoc.updatedAt || '',
  };
}

/* ============================== 菜谱摘要 ============================== */

/**
 * 将菜谱文档转为 AI 提示词用的精简摘要。
 * 只包含 AI 选菜需要的信息，不包含完整步骤。
 */
function toCandidateSummary(recipe, inventoryNames, recentIds) {
  const ingredientNames = (recipe.ingredients || []).map((i) => i.name);
  const matched = ingredientNames.filter((n) => inventoryNames.has(n));
  const missing = ingredientNames.filter((n) => !inventoryNames.has(n));
  // 主料/做法/菜系放进提示词，模型才能真正按「换主料换做法」而不是按菜名去重
  const signature = buildSignature(recipe);

  return {
    id: recipe._id,
    name: recipe.name,
    category: recipe.category,
    cuisine: signature.cuisine,
    protein: signature.protein,
    method: signature.method,
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

/**
 * 近期菜单的「主料|做法」签名摘要，喂给提示词做结构化去重。
 *
 * 光把菜名丢给模型并不可靠 —— 模型不会自己把「青椒肉丝」和「鱼香肉丝」
 * 归成同一类。先在前端算好签名，模型只需要避开这些组合。
 */
function summarizeRecentSignatures(recentMenus) {
  const seen = {};
  const list = [];
  (recentMenus || []).forEach((menu) => {
    dishesOf(menu).forEach((dish) => {
      const sig = buildSignature(dish);
      if (!sig.name || sig.key === '?|?') return;
      if (seen[sig.key]) return;
      seen[sig.key] = true;
      const date = (menu.createdAt || '').slice(0, 10);
      list.push(sig.key + '（' + sig.name + (date ? '，' + date : '') + '）');
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
 * 分层候选池。
 *
 * 原来的做法是把全部候选按「库存匹配度」倒序后取前 50 条，再从中挑 40 条送进提示词。
 * 后果是：匹配度低的菜（也就是需要买菜、可能来自其他菜系的菜）永远进不了模型视野，
 * 模型只在高匹配的常见菜里打转，于是连续几天都是番茄炒蛋、青椒肉丝这一批。
 *
 * 这里改成三层，各层独立轮转后再合并：
 *   full    —— 库存全覆盖：最好用，但数量少、容易重复
 *   partial —— 部分覆盖：需要少量采购，选择面最大
 *   explore —— 几乎用不上库存：真正的「跳出冰箱」，带来跨菜系和换口味
 *
 * 每套菜单至少要能摸到 explore 层的菜，否则「没食材就换菜系」就只是提示词里的空话。
 */
const LAYER_FULL_RATIO = 0.3;
const LAYER_PARTIAL_RATIO = 0.45;
const LAYER_EXPLORE_RATIO = 0.25;

/** 按库存覆盖度给候选分层 */
function splitCandidateLayers(candidates) {
  const full = [];
  const partial = [];
  const explore = [];

  (candidates || []).forEach((cand) => {
    if (cand.totalIngredients === 0) {
      explore.push(cand);
      return;
    }
    const ratio = cand.matchedIngredients / cand.totalIngredients;
    if (ratio >= 0.999) full.push(cand);
    else if (ratio >= 0.3) partial.push(cand);
    else explore.push(cand);
  });

  return { full: full, partial: partial, explore: explore };
}

/**
 * 从候选池中挑出写进提示词的菜品（分层版）。
 *
 * 各层按比例分配名额，层内按请求种子轮转，层与层之间保持「全覆盖 → 部分 → 探索」的顺序，
 * 让模型既能先看到好用的菜，也一定看得到需要换菜系的选项。
 *
 * 关键细节：如果某层候选数少于它分到的名额，绝不把这一层「全部塞进去」。
 * 全覆盖层往往只有十来道菜，一旦全量进入提示词，轮转就只是换了个顺序，
 * 模型每次看到的内容完全一样 —— 这正是「连续几天推荐同一批菜」的根因。
 * 所以这里给每层留 30% 作为轮转余量，用不完的名额再让给其他层。
 */
function pickLayeredCandidates(candidates, limit, seed) {
  const list = candidates || [];
  if (list.length <= limit) {
    return rotateList(list, seed);
  }

  const layers = splitCandidateLayers(list);
  const quotas = [
    { key: 'full', ratio: LAYER_FULL_RATIO, items: layers.full },
    { key: 'partial', ratio: LAYER_PARTIAL_RATIO, items: layers.partial },
    { key: 'explore', ratio: LAYER_EXPLORE_RATIO, items: layers.explore },
  ];

  const picked = [];
  const leftover = [];
  let reserved = 0;

  // 第一轮：按比例分配，轮转后取该层的前 N 条
  quotas.forEach((layer, index) => {
    const isLast = index === quotas.length - 1;
    const quota = isLast ? Math.max(0, limit - reserved) : Math.floor(limit * layer.ratio);
    const rotated = rotateList(layer.items, seed + index * 7919);

    // 单道候选的层（例如库存只够做一道菜时）不参与主挑选：
    // 固定塞进去只会让每次请求都出现同一道菜。这类菜统一放回 leftover，
    // 只有其他层凑不满名额时才补上。
    const usable = rotated.length >= 2;
    // 层内候选不足时留出轮转余量，保证不同请求能看到不同组合
    const takeCap = usable ? Math.max(1, Math.ceil(rotated.length * 0.7)) : 0;
    const take = Math.min(quota, takeCap);

    picked.push.apply(picked, rotated.slice(0, take));
    leftover.push.apply(leftover, rotated.slice(take));
    reserved += take;
  });

  // 第二轮：某一层候选不足时，名额留给其他层，避免提示词条数缩水
  if (picked.length < limit) {
    const rotatedLeft = rotateList(leftover, seed + 104729);
    picked.push.apply(picked, rotatedLeft.slice(0, limit - picked.length));
  }

  return picked;
}

/**
 * 把 AI 生成的库外菜落库到 recipes，返回新文档 _id。
 *
 * 为什么要落库而不是只在内存里传递：
 *   做法生成（recipe 云函数）按 recipeId 读 recipes 表；
 *   营养计算按 recipeId 查营养库；
 *   采购清单按菜单里的 ingredients 汇总。
 *   不落库这三条链路都会断，用户点进详情就会看到「菜谱不存在」。
 *
 * source 用 'ai_generated' 与内置菜谱区分：
 *   - 不参与「菜谱库浏览」的 builtin 过滤；
 *   - 家庭换菜时可以正常被选中（loadRecipes 只读 builtin，
 *     所以这里额外按 familyId 归属，避免被别的家庭看到）。
 *
 * @returns {Promise<string>} 新文档 _id；写入失败返回空字符串
 */
async function persistNewDish(dish, userId, familyId) {
  try {
    // 同名菜已经存在时直接复用，避免反复推荐同一道菜时写出一堆重复文档。
    // 只能复用自己的：内置菜谱是公共的，AI 生成菜谱归属单个家庭，
    // 按名字全局查会串到别人家的菜单上。
    const exists = await db.collection('recipes')
      .where({ name: dish.name, isActive: true })
      .limit(20)
      .get();
    const reusable = (exists.data || []).find((item) => (
      item.source === 'builtin' ||
      (item.source === 'ai_generated' && item.familyId === familyId)
    ));
    if (reusable) return reusable._id;

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
      // 库外菜没有步骤，进入详情页时由 recipe 云函数按需生成
      steps: [],
      source: 'ai_generated',
      // 记录来源家庭：这类菜只应被本家庭看到
      familyId: familyId || '',
      createdBy: userId || '',
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };

    const added = await db.collection('recipes').add({ data: doc });
    return added._id || '';
  } catch (e) {
    // 落库失败不该让整次推荐失败：这道菜会被丢弃，其余菜单照常返回
    console.warn('[recommend] 库外菜落库失败，已跳过：' + dish.name, e && (e.errMsg || e.message));
    return '';
  }
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
async function handleRecommendMenus(event, wxContext, requestId) {
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

  // 2.1 本餐次共享方案：已有有效方案时直接复用，避免每个成员各生成一套、重复消耗额度。
  //     force=true 表示家人明确要求换一批；已确认的菜单不允许被覆盖。
  const planDate = beijingDateString();
  const force = event.force === true;
  const existingPlan = await readMealPlan(familyId, planDate, mealType);
  if (existingPlan && existingPlan.status === 'confirmed') {
    if (!force) return ok(toPlanResponse(existingPlan, { reused: true }));

    // 已确认菜单的替换：必须由掌勺人明确发起，旧方案保留为历史（superseded），
    // 新方案以 version+1 落库，确认后才会成为新的最终菜单。
    if (existingPlan.cookId && existingPlan.cookId !== user._id) {
      return fail('NOT_MEAL_COOK', '只有本餐次掌勺人可以重新生成本餐次方案');
    }
    if (event.confirmReplace !== true) {
      return fail('CONFIRM_REQUIRED', '本餐次菜单已确认，重新生成需要掌勺人二次确认');
    }
  }
  if (existingPlan && !force) {
    return ok(toPlanResponse(existingPlan, { reused: true }));
  }
  // 换一批会重置家人已经表达的偏好，因此只允许本餐次掌勺人操作；
  // 管理员身份不等于掌勺人，不能绕过。
  if (existingPlan && force && existingPlan.cookId && existingPlan.cookId !== user._id) {
    return fail('NOT_MEAL_COOK', '只有本餐次掌勺人可以换一批方案');
  }

  // 2.2 并发锁：同一餐次只允许一个生成任务在跑，避免两个人同时点「换一批」
  //     各自消耗一次 AI 额度、写入两份方案。
  const lock = await acquirePlanLock(familyId, planDate, mealType, user._id);
  if (!lock.acquired) {
    return fail('PLAN_GENERATING', '家人正在生成本餐次方案，请稍后刷新');
  }
  if (lock.id && requestId) activeRequestLocks.set(requestId, { id: lock.id, owner: user._id });

  // 3. 读取家庭食材、菜谱库与近期菜单
  let ingredients;
  let recipes;
  let recentMenuIds = new Set();
  let recentMenusForPrompt = [];
  let recentSignatureList = [];

  // 3 + 4. 食材与菜谱库互不依赖，并行读取，省一次数据库往返（对 AI 调用前的等待时间敏感）
  try {
    const [ingResult, recipeResult, recentResult] = await Promise.all([
      db.collection('ingredients').where({ familyId }).limit(200).get(),
      db.collection('recipes').where({ source: 'builtin', isActive: true }).limit(300).get(),
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
    recentSignatureList = summarizeRecentSignatures(recentResult);
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

  // 不再把候选池砍到 50 条：那会让低匹配（需要买菜、跨菜系）的菜永远进不了视野。
  // 近期做过的菜单独放最后，只作为「用户明确想吃」时的备选，不参与主候选抢占名额。
  const freshCandidates = scored.filter((c) => !c.recentlyUsed);
  const recentCandidates = scored
    .filter((c) => c.recentlyUsed)
    .slice(0, RECENT_CANDIDATE_LIMIT);

  if (freshCandidates.length === 0 && recentCandidates.length === 0) {
    return fail('NO_CANDIDATES', '没有找到可推荐的菜谱');
  }

  const requestSeed = hashSeed(event.requestId || String(Date.now()));
  const promptCandidates = pickLayeredCandidates(
    freshCandidates,
    Math.max(1, MAX_PROMPT_CANDIDATES - recentCandidates.length),
    requestSeed,
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
    '你是一位精通中国各大菜系（川、粤、鲁、苏、浙、闽、湘、徽、东北、西北）以及常见西式家常菜的大厨，',
    '同时熟悉营养搭配和家庭厨房的实际条件。你的任务是为这个家庭设计 ' + MENU_COUNT + ' 套今晚就能落地的好菜单。',
    '',
    '【核心心态】',
    buildRequirementText([
      '先像一个真正的厨师那样思考「这家人连着吃了几天类似的菜，今晚该换点什么口味」，再去看冰箱；',
      '不要把自己当成「只会组合冰箱现有食材的机器人」。冰箱是起点，不是边界；',
      '如果冰箱里的食材只能撑起重复、单调的搭配，就主动换菜系、换主料、换烹饪方式，给出真正让人有食欲的选择；',
      '用户想看到的是「今天又吃到不一样的好菜」，而不是「今天的番茄炒蛋换了个摆盘」。',
    ]),
    '',
    '【第一层：优先用得上冰箱】',
    buildRequirementText([
      '在不牺牲多样性的前提下，优先选择能消化现有食材的菜（matchedIngredients 越多越好）；',
      '临期食材优先安排，避免浪费；',
      '每套菜单必须包含 ' + MIN_DISHES_PER_PLAN + '~' + MAX_DISHES_PER_PLAN + ' 道菜（不得少于 ' + MIN_DISHES_PER_PLAN + ' 道），荤素搭配，有主菜也有配菜或汤；',
      '结合餐次（' + MEAL_TYPE_LABELS[mealType] + '）选择合适菜品。',
    ]),
    '',
    '【第二层：库存不够就跳出菜谱库】',
    buildRequirementText([
      '候选菜谱列表不是唯一允许的范围。当候选里找不到合适又有新意的菜时，你必须主动推荐库外的菜；',
      '库外菜允许使用冰箱里没有的食材，但必须是常见、容易买到的；',
      '库外菜必须给出准确的主料和用量，系统要据此生成采购清单，不能只写「适量」；',
      '严禁推荐需要专业设备、稀有食材或家庭厨房难以完成的菜；',
      '库外菜同样受下面所有过敏原、忌口和多样性规则约束。',
    ]),
    '',
    '【第三层：强力去重（最容易失败的地方，请严格执行）】',
    buildRequirementText([
      '逐条对照「最近菜单」和「近期主料/做法签名」：近 7 天做过的菜，不要原样再上一次；',
      '不仅要比菜名，还要比「主要蛋白质 + 烹饪方式」：如果近期刚做过「猪|炒」，这次就换「牛|炖」「鸡|蒸」；',
      '「番茄炒蛋 / 西红柿炒鸡蛋」「番茄蛋汤 / 番茄鸡蛋汤 / 西红柿蛋汤」视为同一道菜；',
      '同一套菜单里：最多 1 道以鸡蛋为主要蛋白质的菜，最多 1 道番茄类菜品，最多 1 道汤；',
      '三套菜单之间菜品不得重复；',
      '不要连续两套菜单都用同一个主料（例如三套全是猪肉菜）；',
      '「换汤不换药」不算换菜：清炒西兰花 → 蒜蓉炒西兰花 属于同一道菜，必须换成真正不同的菜。',
    ]),
    '',
    '【安全与执行约束（优先级高于一切多样性要求）】',
    buildRequirementText([
      '过敏原和忌口是硬红线，违反即视为本次推荐失败；',
      '不得虚构库存中不存在的食材；缺少关键食材的菜需要在 missingIngredients 里如实列出；',
      '不得为了追求变化而推荐不合理、不符合家庭口味或无法实际制作的菜；',
      '用户本次明确提出的菜品优先，多样性规则不得覆盖用户的明确要求。',
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
    '输出前请在内部自检：① 有没有跟近期菜单重复；② 三套菜单之间有没有同一道菜或用同一主料堆满；',
    '③ 每套是否够 ' + MIN_DISHES_PER_PLAN + ' 道且荤素搭配；④ 有没有踩到过敏原/忌口。自检过程不要输出。',
    '只输出 JSON，不要输出解释、Markdown 代码围栏或其他内容。',
  ].join('\n');

  const userPrompt = [
    '当前家庭食材：' + inventoryList,
    '临期食材（3 天内到期，可优先使用，但不得虚构）：' + expiringList,
    '',
    '最近 ' + RECENT_MENU_DAYS + ' 天菜单（用于避免重复，可能为空）：',
    JSON.stringify(recentMenusForPrompt),
    '',
    '近期主料/做法签名（key = 主要蛋白质|烹饪方式，近期出现过的组合请换掉）：',
    recentSignatureList.length > 0 ? recentSignatureList.join('；') : '无',
    '',
    '选菜步骤（请按顺序思考，不要输出过程）：',
    '1. 先看近期菜单，确定今晚要换掉哪些口味和主料；',
    '2. 再看候选菜谱里有没有能满足的菜，优先用得上冰箱；',
    '3. 如果候选不够或太雷同，直接用库外菜补足，换菜系、换主料、换做法；',
    '4. 最后检查过敏原、忌口和每套菜的道数。',
    '',
    '候选中的 recentlyUsed=true 表示近 7 天已经做过，除非用户明确要求，否则不要选。',
    '',
    '候选菜谱列表（JSON）：',
    JSON.stringify(promptCandidates.map((c) => ({
      id: c.id,
      name: c.name,
      category: c.category,
      cuisine: c.cuisine || '',
      protein: c.protein || '',
      method: c.method || '',
      difficulty: c.difficulty,
      cookTime: c.cookTime + '分钟',
      servings: c.servings + '人份',
      ingredients: c.ingredients,
      matchedIngredients: c.matchedIngredients,
      missingIngredients: c.missingIngredients,
      recentlyUsed: c.recentlyUsed,
    }))),
    '',
    '请以 JSON 格式返回 ' + MENU_COUNT + ' 套菜单。dishes 里每项二选一：',
    '- 从候选里选：{"recipeId": "候选里的 id"}',
    '- 库外新菜：{"newDish": {"name": "菜名", "category": "家常菜|蔬菜类|汤类|主食类", "tags": ["川味"], ' +
      '"cookTime": 20, "servings": 2, "ingredients": [{"name": "主料", "amount": 200, "unit": "g"}]}}',
    '格式：',
    '{' +
      '"menus": [' +
        '{' +
          '"title": "菜单名称",' +
          '"reason": "推荐理由（一句话）",' +
          '"dishes": [{"recipeId": "候选 id"}, {"newDish": { ... }}]' +
        '}' +
      ']' +
    '}',
    '每套 dishes 数量必须在 ' + MIN_DISHES_PER_PLAN + '~' + MAX_DISHES_PER_PLAN + ' 之间。',
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

  // 9. 校验结果（库内只接受过滤后的安全菜谱；库外菜按同一套安全规则现校验）
  const recipeMap = {};
  for (const r of dietFiltered.kept) {
    recipeMap[r._id] = r;
  }

  // 近期做过的菜（含签名），用于对库外菜做同名 / 同主料同做法去重
  const recentDishList = [];
  (recentMenusForPrompt || []).forEach((menu) => {
    // recentMenusForPrompt 只保留了菜名和食材，签名用的是菜名 + 食材，足够判定
    (menu.dishes || []).forEach((name) => {
      recentDishList.push({
        name: name,
        ingredients: (menu.mainIngredients || []).map((n) => ({ name: n })),
        tags: [],
      });
    });
  });

  let blockedAfterAi = 0;
  let rejectedNewDish = 0;
  const validMenus = [];
  // 本次新落库的库外菜：id → 菜谱文档，供 toRecipeView 使用
  const persistedRecipeMap = {};

  // 补菜候选：按请求轮转，避免每次补的都是同一批高匹配菜（会让多轮推荐完全一样）。
  // 近期做过的菜单独放一份，只在新鲜候选凑不齐时才用。
  const fillSeed = hashSeed(event.requestId || String(Date.now()) + '-fill');
  const fillFresh = rotateList(scored.filter((c) => !c.recentlyUsed), fillSeed);
  const fillRecent = scored.filter((c) => c.recentlyUsed);
  // 跨菜单去重：同一道菜不在多套菜单里重复出现，避免「三套菜单看起来一模一样」
  const usedAcrossMenus = new Set();
  // 库外菜也要跨菜单去重：签名为键
  const usedNewDishKeys = new Set();

  for (const menu of parsed.menus) {
    if (!menu.title) continue;

    // 兼容两种返回格式：新的 dishes（支持库外菜）与旧的 recipeIds
    const selections = parseDishSelections(
      Array.isArray(menu.dishes) ? menu.dishes : (menu.recipeIds || []).map((id) => ({ recipeId: id })),
    );

    // 9.1 库内菜：命中过敏原 / 忌口的一律丢弃并计数
    const picked = [];
    for (const id of selections.recipeIds) {
      if (blockedIds.has(id)) {
        blockedAfterAi += 1;
        continue;
      }
      if (!recipeMap[id]) continue;
      if (usedAcrossMenus.has(id)) continue;
      if (picked.indexOf(id) !== -1) continue;
      picked.push(id);
      if (picked.length >= MAX_DISHES_PER_PLAN) break;
    }

    // 9.2 库外菜：字段校验 → 过敏原硬校验 → 近期重复校验
    const acceptedNewDishes = [];
    for (const dish of selections.newDishes) {
      if (picked.length + acceptedNewDishes.length >= MAX_DISHES_PER_PLAN) break;

      const dietCheck = checkNewDishDiet(dish, diet, matchRecipe);
      if (!dietCheck.ok) {
        // 命中过敏原 / 忌口：直接丢弃，安全优先
        rejectedNewDish += 1;
        blockedAfterAi += 1;
        continue;
      }

      const repeat = isNewDishRepeated(dish, recentDishList, findConflict);
      if (repeat) {
        // 与近期菜单同名或同主料同做法，视为「换汤不换药」
        rejectedNewDish += 1;
        continue;
      }

      const signature = buildSignature(dish);
      if (usedNewDishKeys.has(signature.key)) {
        rejectedNewDish += 1;
        continue;
      }

      usedNewDishKeys.add(signature.key);
      acceptedNewDishes.push(dish);
    }

    if (picked.length === 0 && acceptedNewDishes.length === 0) continue;

    // 9.3 不足下限时补齐：只用库内安全候选，避免凭空再生成菜
    for (const pool of [fillFresh, fillRecent]) {
      const need = MIN_DISHES_PER_PLAN - picked.length - acceptedNewDishes.length;
      if (need <= 0) break;
      for (let i = 0; i < pool.length && (MIN_DISHES_PER_PLAN - picked.length - acceptedNewDishes.length) > 0; i += 1) {
        const cand = pool[i];
        if (blockedIds.has(cand.id)) continue;
        if (usedAcrossMenus.has(cand.id)) continue;
        if (picked.indexOf(cand.id) !== -1) continue;
        picked.push(cand.id);
      }
    }
    if (picked.length + acceptedNewDishes.length < MIN_DISHES_PER_PLAN) continue;

    // 补菜也算进跨方案去重，避免三套菜单互相重复
    for (const id of picked) usedAcrossMenus.add(id);

    // 库外菜落库后才能与做法生成 / 营养 / 采购衔接
    const persistedNewDishes = [];
    for (const dish of acceptedNewDishes) {
      const recipeId = await persistNewDish(dish, auth.user._id, familyId);
      if (recipeId) {
        persistedNewDishes.push(recipeId);
        if (!persistedRecipeMap[recipeId]) {
          persistedRecipeMap[recipeId] = Object.assign({ _id: recipeId }, dish);
        }
      } else {
        rejectedNewDish += 1;
      }
    }

    const validIds = picked.concat(persistedNewDishes);
    if (validIds.length < MIN_DISHES_PER_PLAN) continue;

    const items = validIds.map((id) => {
      if (recipeMap[id]) return toRecipeView(recipeMap[id]);
      // 刚落库的库外菜：用 persisted 映射表取回
      return toRecipeView(persistedRecipeMap[id]);
    }).filter(Boolean);

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

  // 10. 落库为「本餐次共享方案」：所有家庭成员随后看到的是同一批方案。
  //     掌勺人默认是本次发起人；餐次已有掌勺人时保持不变，避免重新生成改变决策权。
  //     planId 由服务端生成，前端只用来表达「喜欢哪一套」，不能作为权限依据。
  const plansWithId = validMenus.map((menu, index) => Object.assign({}, menu, {
    planId: 'plan-' + (index + 1),
  }));

  const planPayload = {
    familyId: familyId,
    date: planDate,
    mealType: mealType,
    servings: servings,
    plans: plansWithId,
    // 只记录与本次生成有关的上下文，不落 AI 原始输出
    inventoryCount: ingredients.length,
    candidateCount: promptCandidates.length,
    generatedBy: auth.user._id,
    cookId: (existingPlan && existingPlan.cookId) || auth.user._id,
    cookName: (existingPlan && existingPlan.cookName) || (auth.user.nickname || ''),
  };
  const planDocId = await saveMealPlan(planPayload, existingPlan);

  const createdAt = new Date().toISOString();

  return ok({
    recommendationId: planDocId || generateId(),
    planId: planDocId || '',
    planStatus: 'open',
    planVersion: existingPlan ? (existingPlan.version || 1) + 1 : 1,
    shared: !!planDocId,
    reused: false,
    cookId: planPayload.cookId,
    cookName: planPayload.cookName,
    date: planDate,
    mealType: mealType,
    servings: servings,
    inventoryCount: ingredients.length,
    candidateCount: promptCandidates.length,
    diet: summarizeDiet(diet, dietFiltered.blocked),
    blockedByDietAfterAi: blockedAfterAi,
    menus: plansWithId,
    createdAt: createdAt,
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
  } finally {
    // 无论成功、失败还是提前返回，都释放本餐次生成锁
    const lock = activeRequestLocks.get(requestId);
    if (lock) {
      activeRequestLocks.delete(requestId);
      await releasePlanLock(lock.id, lock.owner);
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