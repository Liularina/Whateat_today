/**
 * ingredient 云函数 · 家庭食材库存（Phase 4）
 *
 * 职责：
 *   listIngredients / createIngredient / updateIngredient / deleteIngredient
 *
 * 安全约束：
 *   1. 身份只来自 cloud.getWXContext().OPENID，绝不读取、也绝不信任客户端传入的
 *      openid / familyId / createdBy / standardName 等身份与派生字段；
 *   2. 所有操作都必须经 requireFamilyMember 复核，前端传入的 familyId 只作为
 *      「想操作哪个家庭」的意图，绝不作为权限依据；
 *   3. 修改 / 删除前必须确认该食材确实属于当前家庭，杜绝跨家庭越权；
 *   4. 只允许写白名单字段（name / quantity / unit / category / expireDate / remark），
 *      standardName / createdBy / familyId / 时间戳一律由服务端生成；
 *   5. LLM API Key 只存在于云函数环境变量中，绝不下发到小程序前端。
 *
 * 本阶段刻意不做的事：拍照识别、OCR、语音、临期算法、自动扣库存、复杂单位、库存统计。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const usersCol = db.collection('users');
const familiesCol = db.collection('families');
const membersCol = db.collection('family_members');
const ingredientsCol = db.collection('ingredients');
const aliasesCol = db.collection('ingredient_aliases');

/** 云数据库「集合不存在」错误码 */
const ERR_COLLECTION_NOT_EXIST = -502005;

const DB_NOT_READY_MESSAGE =
  '数据库集合 ingredients 不存在，请先在云开发控制台创建';

/* ------------------------------ 业务约束 ------------------------------ */
/* 与 miniprogram 侧保持一致，服务端必须独立校验，不能相信前端 */

const INGREDIENT_NAME_MAX_LENGTH = 20;
const INGREDIENT_REMARK_MAX_LENGTH = 50;
const INGREDIENT_QUANTITY_MAX = 9999;
/** 一次最多返回的食材条数，第一阶段不做分页 */
const INGREDIENT_LIST_LIMIT = 200;

const UNITS = ['g', 'kg', '个', '袋', '盒'];
const CATEGORIES = [
  'vegetable',
  'meat_egg',
  'seafood',
  'staple',
  'soy_product',
  'seasoning',
  'dairy',
  'fruit',
  'other',
];

/**
 * 内置别名表：常见口语叫法 → 标准名。
 * 只做「查表映射」，不做任何分词 / 语义推断。
 * ingredient_aliases 集合中的记录会覆盖这里的同名项，方便后续不改代码补充。
 */
const DEFAULT_ALIASES = {
  西红柿: '番茄',
  蕃茄: '番茄',
  圣女果: '圣女果',
  小番茄: '圣女果',
  香葱: '小葱',
  青葱: '小葱',
  小葱: '小葱',
  土豆: '土豆',
  马铃薯: '土豆',
  洋芋: '土豆',
  地瓜: '红薯',
  番薯: '红薯',
  红薯: '红薯',
  土鸡蛋: '鸡蛋',
  鸡子: '鸡蛋',
  五花肉: '猪肉',
  里脊肉: '猪肉',
  前腿肉: '猪肉',
  尖椒: '青椒',
  柿子椒: '青椒',
  蒜头: '大蒜',
  蒜: '大蒜',
  芫荽: '香菜',
  红萝卜: '胡萝卜',
  大白菜: '白菜',
};

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

function toIsoString(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    return value;
  }
  return '';
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 数量保留 2 位小数，避免浮点尾差落库 */
function roundQuantity(value) {
  return Math.round(value * 100) / 100;
}

/**
 * 严格校验 YYYY-MM-DD。
 * 不能用 new Date(text) 直接判：JS 会把 2026-02-30 自动进位成 3 月 2 日，
 * 必须把解析结果再拆回年月日做回环比对。
 */
function isRealDateString(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return false;
  }
  const parts = text.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/* ------------------------------ 查询工具 ------------------------------ */

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
    // 文档不存在时按「查不到」处理，不向调用方抛出
    return null;
  }
}

/**
 * 家庭身份校验：绝不直接信任前端传来的 familyId。
 * openid → users → family_members → families，确认用户确实属于该家庭后才允许继续。
 */
async function requireFamilyMember(openid, familyId, logContext) {
  try {
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

    const requestedFamilyId = normalizeText(familyId);
    if (!requestedFamilyId) {
      return { error: fail('INVALID_PARAMS', '缺少 familyId') };
    }
    // 先记录「想操作哪个家庭」，越权时日志里才有可追溯的目标
    if (logContext) {
      logContext.familyId = requestedFamilyId;
    }

    const res = await membersCol
      .where({ familyId: requestedFamilyId, userId: user._id })
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

    return { user: user, membership: membership, family: family };
  } catch (error) {
    if (isCollectionMissing(error)) {
      return { error: fail('DB_NOT_READY', DB_NOT_READY_MESSAGE) };
    }
    throw error;
  }
}

/** 按 家庭 + id 查询食材：家庭归属是这里唯一的事实来源 */
async function findIngredient(familyId, id) {
  const res = await ingredientsCol
    .where({ _id: id, familyId: familyId })
    .limit(1)
    .get();
  return (res.data && res.data[0]) || null;
}

/* ------------------------------ 别名标准化 ------------------------------ */

/**
 * 单次调用内的别名表缓存：避免同一请求里重复读库。
 * 每次 main() 入口都会重置，保证在控制台改了 ingredient_aliases 后
 * 下一次请求就能生效（否则热容器会一直用旧表）。
 */
let aliasCache = null;

async function loadAliasMap() {
  if (aliasCache) {
    return aliasCache;
  }

  const map = Object.assign({}, DEFAULT_ALIASES);
  try {
    const res = await aliasesCol.limit(1000).get();
    for (const row of res.data || []) {
      const alias = normalizeText(row.alias);
      const standardName = normalizeText(row.standardName);
      if (alias && standardName) {
        map[alias] = standardName;
      }
    }
  } catch (error) {
    // 别名集合缺失或读取失败都不应阻塞添加食材：退回内置别名表
    if (!isCollectionMissing(error)) {
      console.error('[ingredient] 读取 ingredient_aliases 失败，已退回内置别名表', error);
    }
  }

  aliasCache = map;
  return map;
}

/** 查表得到标准名；查不到就用用户输入的名称 */
async function resolveStandardName(name) {
  const map = await loadAliasMap();
  return map[name] || name;
}

/* ------------------------------ 入参校验 ------------------------------ */

/**
 * 校验并归一化食材入参。
 * 只取白名单字段，多余字段直接丢弃（例如客户端伪造的 familyId / createdBy / standardName）。
 */
function buildIngredientPayload(input) {
  const source = input && typeof input === 'object' ? input : {};

  const name = normalizeText(source.name);
  if (!name) {
    return { error: '请填写食材名称' };
  }
  if (name.length > INGREDIENT_NAME_MAX_LENGTH) {
    return { error: '食材名称不要超过 ' + INGREDIENT_NAME_MAX_LENGTH + ' 个字' };
  }

  const quantity = typeof source.quantity === 'number' ? source.quantity : Number(source.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { error: '请填写大于 0 的数量' };
  }
  if (quantity > INGREDIENT_QUANTITY_MAX) {
    return { error: '数量不能超过 ' + INGREDIENT_QUANTITY_MAX };
  }

  const unit = normalizeText(source.unit);
  if (UNITS.indexOf(unit) === -1) {
    return { error: '请选择单位' };
  }

  const category = normalizeText(source.category);
  if (CATEGORIES.indexOf(category) === -1) {
    return { error: '请选择食材分类' };
  }

  let expireDate = normalizeText(source.expireDate);
  if (expireDate) {
    if (!isRealDateString(expireDate)) {
      return { error: '保质期格式不正确，应为 YYYY-MM-DD' };
    }
  } else {
    expireDate = null;
  }

  const remark = normalizeText(source.remark);
  if (remark.length > INGREDIENT_REMARK_MAX_LENGTH) {
    return { error: '备注不要超过 ' + INGREDIENT_REMARK_MAX_LENGTH + ' 个字' };
  }

  return {
    value: {
      name: name,
      quantity: roundQuantity(quantity),
      unit: unit,
      category: category,
      expireDate: expireDate,
      remark: remark,
    },
  };
}

/* ------------------------------ DTO 拼装 ------------------------------ */

function toIngredientDTO(doc) {
  return {
    _id: doc._id,
    familyId: doc.familyId,
    name: doc.name,
    standardName: doc.standardName || doc.name,
    quantity: doc.quantity,
    unit: doc.unit,
    category: doc.category,
    expireDate: doc.expireDate || null,
    remark: doc.remark || '',
    createdBy: doc.createdBy,
    createdAt: toIsoString(doc.createdAt),
    updatedAt: toIsoString(doc.updatedAt),
  };
}

/* ------------------------------ 业务实现 ------------------------------ */

async function handleListIngredients(event, wxContext, requestId, logContext) {
  const guard = await requireFamilyMember(wxContext.OPENID, event.familyId, logContext);
  if (guard.error) {
    return guard.error;
  }

  try {
    const res = await ingredientsCol
      .where({ familyId: guard.family._id })
      .orderBy('createdAt', 'desc')
      .limit(INGREDIENT_LIST_LIMIT)
      .get();

    return ok((res.data || []).map(toIngredientDTO));
  } catch (error) {
    if (isCollectionMissing(error)) {
      return fail('DB_NOT_READY', DB_NOT_READY_MESSAGE);
    }
    console.error('[ingredient] 查询食材失败 requestId=' + requestId, error);
    return fail('INTERNAL_ERROR', '食材列表加载失败，请稍后重试');
  }
}

async function handleCreateIngredient(event, wxContext, requestId, logContext) {
  const guard = await requireFamilyMember(wxContext.OPENID, event.familyId, logContext);
  if (guard.error) {
    return guard.error;
  }

  const parsed = buildIngredientPayload(event.input);
  if (parsed.error) {
    return fail('INVALID_PARAMS', parsed.error);
  }

  const standardName = await resolveStandardName(parsed.value.name);
  const now = new Date();
  const doc = {
    familyId: guard.family._id,
    name: parsed.value.name,
    standardName: standardName,
    quantity: parsed.value.quantity,
    unit: parsed.value.unit,
    category: parsed.value.category,
    expireDate: parsed.value.expireDate,
    remark: parsed.value.remark,
    // createdBy 由服务端决定，客户端传什么都不看
    createdBy: guard.user._id,
    createdAt: now,
    updatedAt: now,
  };

  let newId;
  try {
    const added = await ingredientsCol.add({ data: doc });
    newId = added._id;
  } catch (error) {
    if (isCollectionMissing(error)) {
      return fail('DB_NOT_READY', DB_NOT_READY_MESSAGE);
    }
    console.error('[ingredient] 新增食材失败 requestId=' + requestId, error);
    return fail('CREATE_INGREDIENT_FAILED', '添加食材失败，请稍后重试');
  }

  doc._id = newId;
  logContext.ingredientId = newId;

  return ok(toIngredientDTO(doc));
}

async function handleUpdateIngredient(event, wxContext, requestId, logContext) {
  const guard = await requireFamilyMember(wxContext.OPENID, event.familyId, logContext);
  if (guard.error) {
    return guard.error;
  }

  const id = normalizeText(event.id);
  if (!id) {
    return fail('INVALID_PARAMS', '缺少食材 id');
  }

  const parsed = buildIngredientPayload(event.input);
  if (parsed.error) {
    return fail('INVALID_PARAMS', parsed.error);
  }

  try {
    // 先确认该食材属于当前家庭，再执行更新（跨家庭一律按「不存在」处理）
    const existing = await findIngredient(guard.family._id, id);
    if (!existing) {
      return fail('INGREDIENT_NOT_FOUND', '食材不存在或不属于当前家庭');
    }

    const standardName = await resolveStandardName(parsed.value.name);
    const now = new Date();

    await ingredientsCol.doc(id).update({
      data: {
        name: parsed.value.name,
        standardName: standardName,
        quantity: parsed.value.quantity,
        unit: parsed.value.unit,
        category: parsed.value.category,
        expireDate: parsed.value.expireDate,
        remark: parsed.value.remark,
        updatedAt: now,
      },
    });

    logContext.ingredientId = id;

    return ok(
      toIngredientDTO(
        Object.assign({}, existing, parsed.value, { standardName: standardName, updatedAt: now }),
      ),
    );
  } catch (error) {
    if (isCollectionMissing(error)) {
      return fail('DB_NOT_READY', DB_NOT_READY_MESSAGE);
    }
    console.error('[ingredient] 修改食材失败 requestId=' + requestId, error);
    return fail('UPDATE_INGREDIENT_FAILED', '保存食材失败，请稍后重试');
  }
}

async function handleDeleteIngredient(event, wxContext, requestId, logContext) {
  const guard = await requireFamilyMember(wxContext.OPENID, event.familyId, logContext);
  if (guard.error) {
    return guard.error;
  }

  const id = normalizeText(event.id);
  if (!id) {
    return fail('INVALID_PARAMS', '缺少食材 id');
  }

  try {
    const existing = await findIngredient(guard.family._id, id);
    if (!existing) {
      return fail('INGREDIENT_NOT_FOUND', '食材不存在或不属于当前家庭');
    }

    await ingredientsCol.doc(id).remove();
    logContext.ingredientId = id;

    return ok(null);
  } catch (error) {
    if (isCollectionMissing(error)) {
      return fail('DB_NOT_READY', DB_NOT_READY_MESSAGE);
    }
    console.error('[ingredient] 删除食材失败 requestId=' + requestId, error);
    return fail('DELETE_INGREDIENT_FAILED', '删除食材失败，请稍后重试');
  }
}

/* ------------------------------ 业务路由 ------------------------------ */

const handlers = {
  /** 健康检查：部署后可用来验证云函数是否可用 */
  ping() {
    return ok({ function: 'ingredient', status: 'ok', time: Date.now() });
  },

  listIngredients: handleListIngredients,
  createIngredient: handleCreateIngredient,
  updateIngredient: handleUpdateIngredient,
  deleteIngredient: handleDeleteIngredient,
};

/* ------------------------------ 入口 ------------------------------ */

exports.main = async (event = {}) => {
  const startedAt = Date.now();
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID || '';
  const action = event.action || '';
  const requestId = event.requestId || (Date.now() + '-' + Math.random().toString(36).slice(2, 8));

  // 每次调用重置别名缓存，保证控制台修改 ingredient_aliases 后下次请求即生效
  aliasCache = null;

  // 本次调用的可追溯上下文：越权尝试也能在日志里定位到人 / 家庭 / 食材
  const logContext = { userId: '', familyId: '', ingredientId: '' };

  let response;
  try {
    const handler = Object.prototype.hasOwnProperty.call(handlers, action) ? handlers[action] : null;
    if (!handler) {
      response = fail('UNKNOWN_ACTION', '未知操作：' + action);
    } else {
      response = await handler(event, wxContext, requestId, logContext);
    }
  } catch (error) {
    console.error('[ingredient] 未捕获异常 requestId=' + requestId, error);
    response = fail('INTERNAL_ERROR', '服务内部异常，请稍后重试');
  }

  const failInfo = response.error || null;

  // 统一日志：functionName / requestId / userId / familyId / action / duration / status / error
  console.log(
    JSON.stringify({
      functionName: 'ingredient',
      requestId: requestId,
      userId: logContext.userId || openid,
      familyId: logContext.familyId,
      ingredientId: logContext.ingredientId,
      action: action,
      duration: Date.now() - startedAt,
      status: response.success ? 'success' : 'fail',
      code: (failInfo && failInfo.code) || '',
      error: response.success ? '' : (failInfo && failInfo.message) || '',
    }),
  );

  return response;
};
