/**
 * nutrition 云函数 · 营养计算（Phase 5）
 *
 * 职责：
 *   calculateNutrition  根据 nutrition_facts 重新计算热量 / 蛋白质 / 脂肪 / 碳水
 *   seedNutritionFacts  把内置基础数据写入 nutrition_facts（部署后调用一次即可）
 *   ping                健康检查
 *
 * 安全与口径约束：
 *   1. 身份只来自 cloud.getWXContext().OPENID，绝不信任客户端传入的身份字段；
 *   2. 传了 familyId 时按 openid → users → family_members → families 复核成员身份；
 *   3. **最终营养只由本函数根据 nutrition_facts 计算**：
 *      客户端或 AI 一并传来的 calories / nutrition 等字段在入参归一化阶段就被丢弃，
 *      绝不可能覆盖程序结果；
 *   4. 数据库里没有的食材一律不猜数值，返回 nutritionStatus = partial；
 *   5. nutrition_facts 集合缺失或读取失败时退回内置基础数据，不影响使用。
 *
 * 本阶段刻意不做的事：医疗建议、减肥方案、疾病营养方案、每日营养分析、一周营养报告。
 */
const cloud = require('wx-server-sdk');

const { BUILTIN_NUTRITION_FACTS } = require('./nutrition-data');
const {
  MAX_INGREDIENTS,
  MAX_PEOPLE_COUNT,
  validateCalculateInput,
  calculateNutrition,
} = require('./nutrition-core');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const usersCol = db.collection('users');
const familiesCol = db.collection('families');
const membersCol = db.collection('family_members');
const factsCol = db.collection('nutrition_facts');

/** 云数据库「集合不存在」错误码 */
const ERR_COLLECTION_NOT_EXIST = -502005;

/** 一次最多读取的营养数据条数，第一阶段不做分页 */
const FACTS_READ_LIMIT = 1000;

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

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/* ------------------------------ 身份与权限 ------------------------------ */

async function findUserByOpenid(openid) {
  const res = await usersCol.where({ openid: openid }).orderBy('createdAt', 'asc').limit(1).get();
  return (res.data && res.data[0]) || null;
}

async function findFamilyById(familyId) {
  if (!familyId) {
    return null;
  }
  try {
    const res = await familiesCol.doc(familyId).get();
    return res.data || null;
  } catch (error) {
    // 文档不存在时按「查不到」处理
    return null;
  }
}

/** 登录校验：营养计算不依赖家庭数据，因此只要求已登录 */
async function requireUser(openid, logContext) {
  if (!openid) {
    return { error: fail('AUTH_REQUIRED', '无法获取微信用户身份，请重新进入小程序') };
  }

  const user = await findUserByOpenid(openid);
  if (!user) {
    return { error: fail('UNAUTHORIZED', '请先登录') };
  }

  if (logContext) {
    logContext.userId = user._id;
  }
  return { user: user };
}

/** 家庭身份复核：与 ingredient 云函数同一套判定，绝不直接相信前端传来的 familyId */
async function requireFamilyMember(userId, familyId, logContext) {
  const requestedFamilyId = normalizeText(familyId);
  if (!requestedFamilyId) {
    return { error: fail('INVALID_PARAMS', '缺少 familyId') };
  }
  // 先记录目标家庭，越权时日志里才有可追溯的对象
  if (logContext) {
    logContext.familyId = requestedFamilyId;
  }

  const res = await membersCol
    .where({ familyId: requestedFamilyId, userId: userId })
    .limit(1)
    .get();
  const membership = (res.data && res.data[0]) || null;
  if (!membership) {
    // 不区分「家庭不存在」与「不是成员」，避免探测他人家庭
    return { error: fail('PERMISSION_DENIED', '你没有权限访问该家庭') };
  }

  const family = await findFamilyById(requestedFamilyId);
  if (!family) {
    return { error: fail('FAMILY_NOT_FOUND', '家庭不存在') };
  }
  if (family.status !== 'active') {
    return { error: fail('FAMILY_NOT_ACTIVE', '该家庭已不可用') };
  }

  return { family: family };
}

/* ------------------------------ 营养数据加载 ------------------------------ */

/**
 * 单次调用内的营养数据缓存。
 * 每次 main() 入口重置，保证在控制台改了 nutrition_facts 后下一次请求即生效。
 */
let factsCache = null;

/**
 * 加载「标准名 → 营养数据」映射。
 * 以内置基础数据打底，数据库中的同名记录覆盖内置项；
 * 集合缺失或读取失败都不阻塞计算，直接退回内置表。
 */
async function loadFactsMap() {
  if (factsCache) {
    return factsCache;
  }

  const map = {};
  for (const row of BUILTIN_NUTRITION_FACTS) {
    map[row.standardName] = row;
  }

  try {
    const res = await factsCol.limit(FACTS_READ_LIMIT).get();
    for (const row of res.data || []) {
      const name = normalizeText(row.standardName);
      if (name) {
        map[name] = row;
      }
    }
  } catch (error) {
    if (!isCollectionMissing(error)) {
      console.error('[nutrition] 读取 nutrition_facts 失败，已退回内置基础数据', error);
    }
  }

  factsCache = map;
  return map;
}

/* ------------------------------ 业务实现 ------------------------------ */

async function handleCalculateNutrition(event, requestId, logContext) {
  // 入参校验放在读库之前：非法入参不必访问数据库
  const parsed = validateCalculateInput(event);
  if (parsed.error) {
    return fail('INVALID_PARAMS', parsed.error);
  }

  const facts = await loadFactsMap();

  // 注意：只使用 parsed.value（name / amount / unit），
  // 客户端或 AI 传来的任何营养值都进不来，程序算多少就是多少。
  const result = calculateNutrition(parsed.value, facts);

  logContext.itemCount = result.items.length;
  logContext.computedCount = result.computedCount;
  logContext.nutritionStatus = result.nutritionStatus;

  return ok(result);
}

async function handleSeedNutritionFacts(requestId, logContext) {
  let res;
  try {
    res = await factsCol.limit(FACTS_READ_LIMIT).get();
  } catch (error) {
    if (isCollectionMissing(error)) {
      return fail('DB_NOT_READY', '数据库集合 nutrition_facts 不存在，请先在云开发控制台创建');
    }
    console.error('[nutrition] 写入前读取 nutrition_facts 失败 requestId=' + requestId, error);
    return fail('INTERNAL_ERROR', '营养数据初始化失败，请稍后重试');
  }

  const existingByName = {};
  for (const row of res.data || []) {
    const name = normalizeText(row.standardName);
    if (name) {
      existingByName[name] = row;
    }
  }

  let inserted = 0;
  let updated = 0;

  try {
    for (const row of BUILTIN_NUTRITION_FACTS) {
      const existing = existingByName[row.standardName];
      const payload = {
        standardName: row.standardName,
        per100g: row.per100g,
        edibleRate: row.edibleRate,
        averageWeight: row.averageWeight,
        source: row.source,
        updatedAt: new Date(),
      };

      if (existing) {
        await factsCol.doc(existing._id).update({ data: payload });
        updated += 1;
      } else {
        await factsCol.add({ data: Object.assign({}, payload, { createdAt: new Date() }) });
        inserted += 1;
      }
    }
  } catch (error) {
    console.error('[nutrition] 写入 nutrition_facts 失败 requestId=' + requestId, error);
    return fail('SEED_NUTRITION_FAILED', '营养数据初始化失败，请稍后重试');
  }

  // 数据已变更，本次调用之后不应再命中旧缓存
  factsCache = null;
  logContext.inserted = inserted;
  logContext.updated = updated;

  return ok({
    inserted: inserted,
    updated: updated,
    total: BUILTIN_NUTRITION_FACTS.length,
  });
}

/* ------------------------------ 业务路由 ------------------------------ */

const handlers = {
  /** 健康检查：部署后可用来验证云函数是否可用 */
  ping() {
    return ok({ function: 'nutrition', status: 'ok', time: Date.now() });
  },

  calculateNutrition: handleCalculateNutrition,
  seedNutritionFacts: handleSeedNutritionFacts,
};

/* ------------------------------ 入口 ------------------------------ */

exports.main = async (event = {}) => {
  const startedAt = Date.now();
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID || '';
  const action = event.action || '';
  const requestId = event.requestId || (Date.now() + '-' + Math.random().toString(36).slice(2, 8));

  // 每次调用重置缓存，保证控制台改数据后下次请求即生效
  factsCache = null;

  const logContext = {
    userId: '',
    familyId: '',
    itemCount: 0,
    computedCount: 0,
    nutritionStatus: '',
    inserted: 0,
    updated: 0,
  };

  let response;
  try {
    const handler = Object.prototype.hasOwnProperty.call(handlers, action) ? handlers[action] : null;
    if (!handler) {
      response = fail('UNKNOWN_ACTION', '未知操作：' + action);
    } else {
      // 所有 action 都要求已登录
      const guard = await requireUser(openid, logContext);
      if (guard.error) {
        response = guard.error;
      } else if (event.familyId) {
        // 只有传了 familyId 才复核家庭身份；营养计算本身不依赖家庭数据
        const member = await requireFamilyMember(guard.user._id, event.familyId, logContext);
        response = member.error ? member.error : await handler(event, requestId, logContext);
      } else {
        response = await handler(event, requestId, logContext);
      }
    }
  } catch (error) {
    console.error('[nutrition] 未捕获异常 requestId=' + requestId, error);
    response = fail('INTERNAL_ERROR', '服务内部异常，请稍后重试');
  }

  const failInfo = response.error || null;

  // 统一日志：functionName / requestId / userId / familyId / action / duration / status / error
  console.log(
    JSON.stringify({
      functionName: 'nutrition',
      requestId: requestId,
      userId: logContext.userId || openid,
      familyId: logContext.familyId,
      action: action,
      duration: Date.now() - startedAt,
      status: response.success ? 'success' : 'fail',
      code: (failInfo && failInfo.code) || '',
      error: response.success ? '' : (failInfo && failInfo.message) || '',
      itemCount: logContext.itemCount,
      computedCount: logContext.computedCount,
      nutritionStatus: logContext.nutritionStatus,
    }),
  );

  return response;
};

/** 供后续阶段（recommend / menu）复用同一套计算口径 */
exports.core = { validateCalculateInput, calculateNutrition, MAX_INGREDIENTS, MAX_PEOPLE_COUNT };
