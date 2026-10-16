/**
 * ai-service · 统一 AI 服务入口（Phase C）
 *
 * 职责：所有 AI 云函数都通过这里决定「这次调用用哪套凭据」，不再各自去读
 * user_ai_configs。加模式、加额度只需要改这一处。
 *
 * 两种模式：
 *   builtin —— 平台内置通道。凭据来自云函数环境变量：明文、不落库、不回传。
 *              默认模式。未配置或额度用尽时**明确报错**，不静默回退到用户自配，
 *              否则用户会以为在用内置通道，实际在消耗自己的额度。
 *   custom  —— 用户自配 OpenAI 兼容 API，Key 以 AES-256-GCM 密文存 user_ai_configs。
 *
 * 内置通道环境变量：
 *   AI_BUILTIN_ENABLED      'false' 才禁用；不设视为启用（fail open，方便运维）
 *   AI_BUILTIN_BASE_URL     供应商 Base URL，必须 https 且非内网地址
 *   AI_BUILTIN_MODEL        模型名
 *   AI_BUILTIN_API_KEY      供应商 Key（明文，绝不写入日志或响应）
 *   AI_BUILTIN_DAILY_QUOTA  每用户每日调用上限，默认 20
 *
 * 数据集合：
 *   user_ai_prefs  { userId, mode, createdAt, updatedAt }          —— 模式偏好
 *   ai_usage       { _id: userId_日期, userId, day, count, ... }   —— 每日额度计数器
 *
 * 安全约定：
 *   1. 明文 Key 只在 resolveAiCall 的返回值里出现一次，直接交给 chatCompletion，
 *      不经过日志、不进数据库、不进任何响应体；
 *   2. aiConfig 必须由本模块构造，绝不接受客户端传入的凭据对象；
 *   3. 额度按「北京时间自然日」计，`_id` 固定为 userId_日期，同日同用户只有一行。
 */
const { readFullAiConfig, validateAndBuildUrl } = require('./openai-compatible-client');

/* ============================== 模式 ============================== */

/** 平台内置通道 */
const AI_MODE_BUILTIN = 'builtin';
/** 用户自配通道 */
const AI_MODE_CUSTOM = 'custom';

/** 所有合法模式 */
const AI_MODES = [AI_MODE_BUILTIN, AI_MODE_CUSTOM];

/** 默认模式：内置（开箱即用） */
const DEFAULT_AI_MODE = AI_MODE_BUILTIN;

function isValidAiMode(mode) {
  return typeof mode === 'string' && AI_MODES.indexOf(mode) !== -1;
}

/* ============================== 常量 ============================== */

const AI_PREFS_COLLECTION = 'user_ai_prefs';
const AI_USAGE_COLLECTION = 'ai_usage';
/** AI 调用日志（规范第 12.13 节），只存脱敏后的可观测字段 */
const AI_LOGS_COLLECTION = 'ai_logs';

const ENV_BUILTIN_ENABLED = 'AI_BUILTIN_ENABLED';
const ENV_BUILTIN_BASE_URL = 'AI_BUILTIN_BASE_URL';
const ENV_BUILTIN_MODEL = 'AI_BUILTIN_MODEL';
const ENV_BUILTIN_API_KEY = 'AI_BUILTIN_API_KEY';
const ENV_BUILTIN_DAILY_QUOTA = 'AI_BUILTIN_DAILY_QUOTA';

/** 未配置 AI_BUILTIN_DAILY_QUOTA 时的每日上限 */
const DEFAULT_BUILTIN_DAILY_QUOTA = 20;

/** 每日上限的合理区间，防止环境变量写错把额度放到无上限 */
const MIN_BUILTIN_DAILY_QUOTA = 1;
const MAX_BUILTIN_DAILY_QUOTA = 1000;

/** 云数据库「集合不存在」错误码 */
const ERR_COLLECTION_NOT_EXIST = -502005;

/** 北京时间相对 UTC 的偏移（毫秒） */
const CN_OFFSET_MS = 8 * 60 * 60 * 1000;

/* ============================== 错误码 ============================== */

const ERROR_MESSAGES = {
  AI_BUILTIN_NOT_READY: '内置 AI 暂不可用，请稍后重试',
  AI_QUOTA_EXCEEDED: '今日内置 AI 次数已用完，可明天再试，或到「模型 API 设置」启用自定义 API',
  AI_CONFIG_REQUIRED: '尚未配置自定义 API，请先在「模型 API 设置」中配置',
  AI_MODE_INVALID: '无效的 AI 模式',
  AI_DB_NOT_READY: '数据库集合不存在，请先在云开发控制台创建',
};

/** 构造带 code 的错误（与 client 里的抛错风格一致） */
function aiError(code, message) {
  return Object.assign(new Error(message || ERROR_MESSAGES[code] || code), { code });
}

/**
 * 把错误码映射为用户可理解的中文提示。
 * 未收录的 code 返回空串，由调用方决定兜底文案。
 */
function friendlyAiMessage(code) {
  return ERROR_MESSAGES[code] || '';
}

/* ============================== 工具 ============================== */

function isCollectionMissing(err) {
  return !!err && (err.errCode === ERR_COLLECTION_NOT_EXIST ||
    (typeof err.message === 'string' && err.message.indexOf('not exist') !== -1));
}

/**
 * 主键冲突判定。
 *
 * 计数器用固定 `_id`（userId_日期）保证同日同用户只有一行，
 * 并发首次创建时后到的 add 会因主键冲突失败，这里识别出来转为「已存在」路径。
 */
function isDuplicateKey(err) {
  if (!err) return false;
  const code = err.errCode;
  if (code === -501001 || code === -502002) return true;
  const msg = typeof err.message === 'string' ? err.message : '';
  return msg.indexOf('duplicate') !== -1 || msg.indexOf('already exists') !== -1;
}

/** 北京时间自然日，格式 YYYY-MM-DD */
function dayKeyUtc8(now) {
  const base = now ? now.getTime() : Date.now();
  return new Date(base + CN_OFFSET_MS).toISOString().slice(0, 10);
}

/** 读取并校验内置通道的每日上限 */
function readDailyQuota() {
  const raw = process.env[ENV_BUILTIN_DAILY_QUOTA];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_BUILTIN_DAILY_QUOTA;
  }
  const parsed = Number(String(raw).trim());
  if (!Number.isFinite(parsed) || Math.floor(parsed) !== parsed) {
    return DEFAULT_BUILTIN_DAILY_QUOTA;
  }
  return Math.min(MAX_BUILTIN_DAILY_QUOTA, Math.max(MIN_BUILTIN_DAILY_QUOTA, parsed));
}

/* ============================== 内置通道配置 ============================== */

/**
 * 读取内置通道配置。**返回值含明文 Key，只能在服务端内部使用。**
 *
 * `ready` 为 false 时 `reason` 说明原因（只用于服务端日志，不回传前端）。
 *
 * @returns {{ enabled:boolean, ready:boolean, reason:string, baseUrl:string, model:string, apiKey:string, dailyQuota:number }}
 */
function getBuiltinConfig() {
  const dailyQuota = readDailyQuota();

  // AI_BUILTIN_ENABLED 只在显式设为 'false' 时才禁用；
  // 缺失或空值视为「已启用」—— 毕竟运维已经把 API_KEY / BASE_URL / MODEL 配上了。
  const rawEnabled = (process.env[ENV_BUILTIN_ENABLED] || '').trim().toLowerCase();
  const enabled = rawEnabled !== 'false';

  const empty = {
    enabled: enabled,
    ready: false,
    reason: '',
    baseUrl: '',
    model: '',
    apiKey: '',
    dailyQuota: dailyQuota,
  };

  if (!enabled) {
    return Object.assign({}, empty, { reason: 'disabled' });
  }

  const baseUrl = String(process.env[ENV_BUILTIN_BASE_URL] || '').trim();
  const model = String(process.env[ENV_BUILTIN_MODEL] || '').trim();
  const apiKey = String(process.env[ENV_BUILTIN_API_KEY] || '').trim();

  if (!baseUrl || !model || !apiKey) {
    return Object.assign({}, empty, { reason: 'missing_credentials' });
  }

  // 运维配错地址（http、内网、回环）在这里就拦住，不要等调用时才炸
  try {
    validateAndBuildUrl(baseUrl);
  } catch (e) {
    return Object.assign({}, empty, { reason: 'invalid_base_url' });
  }

  return {
    enabled: true,
    ready: true,
    reason: '',
    baseUrl: baseUrl,
    model: model,
    apiKey: apiKey,
    dailyQuota: dailyQuota,
  };
}

/**
 * 内置通道对外状态：**不含任何凭据或供应商细节**，供前端展示。
 * 不返回 Base URL / 模型名，避免把供应商信息暴露给客户端。
 */
function getBuiltinStatus() {
  const config = getBuiltinConfig();
  return {
    enabled: config.enabled,
    ready: config.ready,
    dailyQuota: config.dailyQuota,
  };
}

/* ============================== 模式偏好 ============================== */

/**
 * 读取用户选择的 AI 模式。
 *
 * 表里没有记录（含用户从未进过设置页、集合尚未创建）时返回默认模式，
 * 不抛错 —— 模式偏好缺失不应该让 AI 功能整个不可用。
 */
async function readAiMode(db, userId) {
  try {
    const res = await db.collection(AI_PREFS_COLLECTION).where({ userId }).limit(1).get();
    const row = res.data[0];
    if (row && isValidAiMode(row.mode)) {
      return row.mode;
    }
    return DEFAULT_AI_MODE;
  } catch (e) {
    if (isCollectionMissing(e)) {
      return DEFAULT_AI_MODE;
    }
    throw e;
  }
}

/**
 * 保存用户选择的 AI 模式（upsert）。
 *
 * @param {object} db cloud.database() 实例
 * @param {string} userId 用户业务 ID
 * @param {string} mode 'builtin' | 'custom'
 */
async function saveAiMode(db, userId, mode) {
  if (!isValidAiMode(mode)) {
    throw aiError('AI_MODE_INVALID');
  }

  const col = db.collection(AI_PREFS_COLLECTION);
  let existing;
  try {
    const res = await col.where({ userId }).limit(1).get();
    existing = res.data[0] || null;
  } catch (e) {
    if (isCollectionMissing(e)) {
      throw aiError('AI_DB_NOT_READY', '数据库集合 ' + AI_PREFS_COLLECTION + ' 不存在，请先在云开发控制台创建');
    }
    throw e;
  }

  const now = new Date();
  try {
    if (existing) {
      await col.doc(existing._id).update({ data: { mode, updatedAt: now } });
    } else {
      await col.add({ data: { userId, mode, createdAt: now, updatedAt: now } });
    }
  } catch (e) {
    if (isCollectionMissing(e)) {
      throw aiError('AI_DB_NOT_READY', '数据库集合 ' + AI_PREFS_COLLECTION + ' 不存在，请先在云开发控制台创建');
    }
    throw e;
  }

  return mode;
}

/* ============================== 额度 ============================== */

/**
 * 读取用户某天的额度用量。集合缺失按 0 处理（尚未用过）。
 */
async function readUsageCount(db, userId, day) {
  let used = 0;
  try {
    const res = await db.collection(AI_USAGE_COLLECTION).where({ userId, day }).limit(1).get();
    const row = res.data[0];
    used = row && Number.isFinite(row.count) ? row.count : 0;
  } catch (e) {
    if (!isCollectionMissing(e)) {
      throw e;
    }
  }
  return used;
}

/**
 * 查看用户今日内置额度用量。额度阈值取自环境变量。
 *
 * @returns {Promise<{ dailyQuota:number, used:number, remaining:number }>}
 */
async function getQuotaStatus(db, userId, now) {
  const dailyQuota = readDailyQuota();
  const day = dayKeyUtc8(now);
  const used = await readUsageCount(db, userId, day);

  return {
    dailyQuota: dailyQuota,
    used: used,
    remaining: Math.max(0, dailyQuota - used),
  };
}

/**
 * 占一次内置额度。
 *
 * 「检查是否超限」和「扣掉一次」必须是一次原子写，否则并发请求会一起越过上限，
 * 因此用 `where(count: _.lt(quota)).update({ count: _.inc(1) })`：
 * 只有当前计数仍低于上限时才 +1，updated=0 即表示这次没抢到。
 *
 * 抢占式计数（先扣再调用）：调用失败也不退还。请求可能已经到达供应商并产生费用，
 * 退还等于给出一个可被重试循环滥用的免费额度。
 *
 * @returns {Promise<{ allowed:boolean, used:number, remaining:number, dailyQuota:number }>}
 */
async function consumeBuiltinQuota(db, userId, dailyQuota, now) {
  const _ = db.command;
  const day = dayKeyUtc8(now);
  const id = userId + '_' + day;
  const col = db.collection(AI_USAGE_COLLECTION);
  const nowDate = now || new Date();

  // 首次尝试建档：同一 _id 天然互斥，并发时只有一个 add 能成功
  try {
    await col.add({ data: { _id: id, userId: userId, day: day, count: 1, updatedAt: nowDate } });
    return {
      allowed: true,
      used: 1,
      remaining: Math.max(0, dailyQuota - 1),
      dailyQuota: dailyQuota,
    };
  } catch (e) {
    if (!isDuplicateKey(e)) {
      if (isCollectionMissing(e)) {
        throw aiError('AI_DB_NOT_READY', '数据库集合 ' + AI_USAGE_COLLECTION + ' 不存在，请先在云开发控制台创建');
      }
      throw e;
    }
    // 已存在当天记录 → 走下面的条件自增
  }

  const res = await col
    .where({ _id: id, userId: userId, day: day, count: _.lt(dailyQuota) })
    .update({ data: { count: _.inc(1), updatedAt: nowDate } });

  const updated = res && res.stats ? res.stats.updated : 0;
  if (updated !== 1) {
    return {
      allowed: false,
      used: dailyQuota,
      remaining: 0,
      dailyQuota: dailyQuota,
    };
  }

  // 回读真实计数，并且用本次传入的额度算剩余。
  // 不能图省事去调 getQuotaStatus：它读的是环境变量里的额度，
  // 与调用方传入的阈值可能不是同一个数（例如按套餐临时调整时），算出来的剩余会偏。
  const used = await readUsageCount(db, userId, day);
  return {
    allowed: true,
    used: used,
    remaining: Math.max(0, dailyQuota - used),
    dailyQuota: dailyQuota,
  };
}

/* ============================== 统一解析入口 ============================== */

/**
 * 决定这次 AI 调用用哪套凭据。
 *
 * @param {object} db cloud.database() 实例
 * @param {string} userId 用户业务 ID（不是 openid）
 * @param {object} [options] { mode?: 'builtin'|'custom' } 显式指定模式；缺省用用户偏好
 * @param {Date}   [now] 注入当前时间，便于按北京时间日切测试
 * @returns {Promise<{ mode:string, aiConfig:object, quota:(object|null) }>}
 *          aiConfig 可直接交给 chatCompletion；quota 仅内置模式有值
 * @throws {Error} AI_MODE_INVALID / AI_BUILTIN_NOT_READY / AI_QUOTA_EXCEEDED / AI_CONFIG_REQUIRED
 */
async function resolveAiCall(db, userId, options, now) {
  const opts = options || {};
  let mode;

  if (opts.mode !== undefined && opts.mode !== null && opts.mode !== '') {
    if (!isValidAiMode(opts.mode)) {
      throw aiError('AI_MODE_INVALID');
    }
    mode = opts.mode;
  } else {
    mode = await readAiMode(db, userId);
  }

  if (mode === AI_MODE_CUSTOM) {
    let config;
    try {
      config = await readFullAiConfig(db, userId);
    } catch (e) {
      if (isCollectionMissing(e)) {
        throw aiError('AI_DB_NOT_READY', '数据库集合 user_ai_configs 不存在，请先在云开发控制台创建');
      }
      throw e;
    }
    if (!config) {
      throw aiError('AI_CONFIG_REQUIRED');
    }
    return { mode: mode, aiConfig: config, quota: null };
  }

  // 内置通道
  const builtin = getBuiltinConfig();
  if (!builtin.ready) {
    // 未就绪一律拒绝：不回退到 custom，避免用户在不知情时消耗自己的 Key
    throw aiError('AI_BUILTIN_NOT_READY');
  }

  const quota = await consumeBuiltinQuota(db, userId, builtin.dailyQuota, now);
  if (!quota.allowed) {
    throw aiError('AI_QUOTA_EXCEEDED');
  }

  const aiConfig = { baseUrl: builtin.baseUrl, model: builtin.model, apiKey: builtin.apiKey };
  return { mode: mode, aiConfig: aiConfig, quota: quota };
}

/* ============================== 统一调用入口 ============================== */

/**
 * 统一执行一次 AI 调用：解析凭据 → 调用 → 记录用量日志。
 *
 * 各云函数只需要把「真正的模型调用」写成回调传进来，模式选择、额度扣减、
 * 耗时与结果日志都在这里完成，避免每个函数各写一遗。
 *
 * @param {object} db cloud.database() 实例
 * @param {string} userId 用户业务 ID
 * @param {object} options { action, requestId, mode }
 * @param {function} fn (aiConfig, resolution) => Promise<any>
 * @returns {Promise<any>} fn 的返回值
 * @throws 直接透传 resolveAiCall 与 fn 的错误，失败调用也会记一条日志
 */
async function runAiCall(db, userId, options, fn) {
  const opts = options || {};
  const startedAt = Date.now();

  // 解析失败（未就绪 / 超额 / 未配置）也会走到下面的 fail 日志
  const resolution = await resolveAiCall(db, userId, opts);

  const base = {
    userId: userId,
    action: opts.action || '',
    requestId: opts.requestId || '',
    mode: resolution.mode,
    quotaUsed: resolution.quota ? resolution.quota.used : null,
    quotaRemaining: resolution.quota ? resolution.quota.remaining : null,
  };

  try {
    const result = await fn(resolution.aiConfig, resolution);
    await recordAiCall(db, base, { status: 'success', duration: Date.now() - startedAt });
    return result;
  } catch (e) {
    await recordAiCall(db, base, {
      status: 'fail',
      code: (e && e.code) || 'AI_FAILED',
      error: (e && e.message) || '',
      duration: Date.now() - startedAt,
    });
    throw e;
  }
}

/* ============================== 用量日志 ============================== */

/** 会出现在日志里的敏感字段名，命中即打码（双保险，正常路径不应传进来） */
const REDACTED_KEYS = ['apiKey', 'api_key', 'authtoken', 'authorization', 'authorization header', 'apikey'];

/** 对日志对象做浅层脱敏：敏感键替换为 *** */
function redact(entry) {
  const out = {};
  Object.keys(entry || {}).forEach(function (key) {
    const lower = String(key).toLowerCase();
    if (REDACTED_KEYS.indexOf(lower) !== -1) {
      out[key] = '***';
    } else {
      out[key] = entry[key];
    }
  });
  return out;
}

/**
 * 记录一次 AI 调用。
 *
 * 只记录可观测字段（模式、耗时、结果、额度），**不记录提示词、不记录 Key**。
 * 提示词可能含用户家庭数据，Key 更是绝不允许出现。
 *
 * @param {object} entry { functionName, requestId, userId, action, mode, duration, status, code, error, quotaUsed, quotaRemaining }
 */
function logAiCall(entry) {
  const payload = Object.assign({ event: 'ai_call' }, redact(entry));
  console.log(JSON.stringify(payload));
}

/** ai_logs 写入失败只警告一次，避免集合未创建时每次调用都刷屏 */
let warnedUsageLogFailure = false;

/**
 * 记录一次 AI 调用：云日志（便于实时排查）+ ai_logs 集合（可统计、可追溯）。
 *
 * 两条通道都不允许失败影响本次调用 —— 日志是观测手段，不是业务前置条件。
 *
 * @param {object} db cloud.database() 实例
 * @param {object} base { userId, action, requestId, mode, quotaUsed, quotaRemaining }
 * @param {object} outcome { status, code?, error?, duration }
 */
async function recordAiCall(db, base, outcome) {
  const entry = Object.assign({}, base, outcome);

  logAiCall(entry);

  try {
    await db.collection(AI_LOGS_COLLECTION).add({
      data: Object.assign({ createdAt: new Date() }, entry),
    });
  } catch (e) {
    if (!warnedUsageLogFailure) {
      warnedUsageLogFailure = true;
      console.error(
        '[ai-service] 写入 ' + AI_LOGS_COLLECTION + ' 失败（不影响 AI 调用）：' +
        ((e && e.message) || '') + '；请确认该集合已创建',
      );
    }
  }
}

module.exports = {
  // 模式
  AI_MODE_BUILTIN,
  AI_MODE_CUSTOM,
  AI_MODES,
  DEFAULT_AI_MODE,
  isValidAiMode,

  // 集合名与错误码
  AI_PREFS_COLLECTION,
  AI_USAGE_COLLECTION,
  AI_LOGS_COLLECTION,
  ERROR_MESSAGES,
  friendlyAiMessage,

  // 内置通道
  getBuiltinConfig,
  getBuiltinStatus,
  DEFAULT_BUILTIN_DAILY_QUOTA,
  MIN_BUILTIN_DAILY_QUOTA,
  MAX_BUILTIN_DAILY_QUOTA,

  // 模式偏好
  readAiMode,
  saveAiMode,

  // 额度
  getQuotaStatus,
  consumeBuiltinQuota,
  readUsageCount,

  // 统一入口
  resolveAiCall,
  runAiCall,

  // 用量日志
  recordAiCall,

  // 日志
  logAiCall,
  redact,

  // 环境变量名（供部署文档与验证脚本引用）
  ENV_BUILTIN_ENABLED,
  ENV_BUILTIN_BASE_URL,
  ENV_BUILTIN_MODEL,
  ENV_BUILTIN_API_KEY,
  ENV_BUILTIN_DAILY_QUOTA,

  // 工具（供验证脚本使用）
  dayKeyUtc8,
};
