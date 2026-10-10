/**
 * ai-config 云函数 · 用户自定义模型 API 配置（Phase 7）
 *
 * 职责：
 *   getAiConfig    —— 获取当前用户的非敏感 API 配置
 *   saveAiConfig   —— 保存或更新 API 配置（服务端 AES-256-GCM 加密 Key）
 *   deleteAiConfig —— 删除当前用户的 API 配置
 *   testAiConfig   —— 测试当前配置的连通性
 *
 * 安全：
 *   1. 身份只来自 cloud.getWXContext().OPENID，绝不信任客户端传入的 userId；
 *   2. API Key 仅以 AES-256-GCM 密文存入数据库，加密密钥来自环境变量；
 *   3. 查询接口绝不返回完整密钥或加密材料；
 *   4. 日志不记录 API Key、Authorization 头或完整请求体；
 *   5. URL 仅允许 HTTPS，拒绝内网 / 回环 / 元数据地址。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const configsCol = db.collection('user_ai_configs');

const {
  encryptApiKey,
  maskApiKey,
  validateAndBuildUrl,
  readAiConfig,
  readFullAiConfig,
  chatCompletion,
  AI_TEST_TIMEOUT_MS,
  ENV_ENCRYPTION_KEY,
} = require('./openai-compatible-client');

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

/** 根据 openid 查找用户业务 ID */
async function findUserByOpenid(openid) {
  const result = await db.collection('users').where({ openid }).limit(1).get();
  return result.data[0] || null;
}

/** 生成请求 ID */
function generateId() {
  return Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

/* ============================== 业务约束 ============================== */

const BASE_URL_MAX_LENGTH = 256;
const MODEL_MAX_LENGTH = 128;
const API_KEY_MAX_LENGTH = 512;
const API_KEY_MIN_LENGTH = 8;

/** 校验 Base URL */
function validateBaseUrl(url) {
  if (!url || typeof url !== 'string' || url.trim().length === 0) {
    return 'API Base URL 不能为空';
  }
  const trimmed = url.trim();
  if (trimmed.length > BASE_URL_MAX_LENGTH) {
    return 'API Base URL 过长';
  }
  if (!trimmed.startsWith('https://')) {
    return 'API Base URL 必须以 https:// 开头';
  }
  // 用 openai client 的 URL 校验进一步检查
  try {
    validateAndBuildUrl(trimmed);
  } catch (e) {
    return e.message;
  }
  return null;
}

/** 校验模型名称 */
function validateModel(model) {
  if (!model || typeof model !== 'string' || model.trim().length === 0) {
    return 'Model 不能为空';
  }
  if (model.trim().length > MODEL_MAX_LENGTH) {
    return 'Model 名称过长';
  }
  return null;
}

/** 校验 API Key */
function validateApiKey(apiKey) {
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    return 'API Key 不能为空';
  }
  if (apiKey.trim().length < API_KEY_MIN_LENGTH) {
    return 'API Key 长度不足';
  }
  if (apiKey.trim().length > API_KEY_MAX_LENGTH) {
    return 'API Key 过长';
  }
  return null;
}

/* ============================== 业务处理器 ============================== */

/**
 * 获取当前用户的非敏感配置。
 * 返回 baseUrl / model / maskedApiKey，不返回任何加密材料或完整 Key。
 */
async function handleGetAiConfig(event, wxContext) {
  const openid = wxContext.OPENID || '';
  if (!openid) {
    return fail('AUTH_REQUIRED', '请先登录');
  }

  const user = await findUserByOpenid(openid);
  if (!user) {
    return fail('USER_NOT_FOUND', '用户不存在，请重新登录');
  }

  try {
    const config = await readAiConfig(db, user._id);
    return ok({
      configured: config.configured,
      baseUrl: config.baseUrl || '',
      model: config.model || '',
      maskedApiKey: config.maskedApiKey || '',
    });
  } catch (e) {
    if (e.code === 'ENCRYPTION_KEY_MISSING' || e.code === 'ENCRYPTION_KEY_INVALID') {
      return fail('ENCRYPTION_KEY_MISSING', '服务端加密密钥未正确配置，请联系管理员');
    }
    throw e;
  }
}

/**
 * 保存或更新当前用户的 API 配置。
 *
 * 保存时：
 *   - baseUrl / model 必填
 *   - apiKey 首次必填；更新时若留空则保留已有密钥
 *   - API Key 在服务端用 AES-256-GCM 加密后存入数据库
 */
async function handleSaveAiConfig(event, wxContext) {
  const openid = wxContext.OPENID || '';
  if (!openid) {
    return fail('AUTH_REQUIRED', '请先登录');
  }

  const user = await findUserByOpenid(openid);
  if (!user) {
    return fail('USER_NOT_FOUND', '用户不存在，请重新登录');
  }

  const baseUrl = (event.baseUrl || '').trim();
  const model = (event.model || '').trim();
  const apiKey = (event.apiKey || '').trim();

  // 入参校验
  const urlError = validateBaseUrl(baseUrl);
  if (urlError) return fail('INVALID_PARAMS', urlError);

  const modelError = validateModel(model);
  if (modelError) return fail('INVALID_PARAMS', modelError);

  // 检查是否已有配置
  let existing = null;
  try {
    const result = await configsCol.where({ userId: user._id }).limit(1).get();
    existing = result.data[0] || null;
  } catch (e) {
    if (isCollectionMissing(e)) {
      return fail('DB_NOT_READY', '数据库集合 user_ai_configs 不存在，请先在云开发控制台创建');
    }
    throw e;
  }

  // apiKey 校验：首次必填；更新时若未传则保留旧密钥
  let finalEncrypted;
  let finalNonce;
  let finalAuthTag;

  if (apiKey) {
    const keyError = validateApiKey(apiKey);
    if (keyError) return fail('INVALID_PARAMS', keyError);

    try {
      const encrypted = encryptApiKey(apiKey);
      finalEncrypted = encrypted.encrypted;
      finalNonce = encrypted.nonce;
      finalAuthTag = encrypted.authTag;
    } catch (e) {
      if (e.code === 'ENCRYPTION_KEY_MISSING' || e.code === 'ENCRYPTION_KEY_INVALID') {
        return fail('ENCRYPTION_KEY_MISSING', '服务端加密密钥未正确配置，请检查云函数环境变量 ' + ENV_ENCRYPTION_KEY);
      }
      throw e;
    }
  } else if (existing && existing.encryptedApiKey) {
    // 保留已有密钥
    finalEncrypted = existing.encryptedApiKey;
    finalNonce = existing.keyNonce;
    finalAuthTag = existing.keyAuthTag;
  } else {
    return fail('INVALID_PARAMS', '首次配置时 API Key 不能为空');
  }

  const now = new Date();

  try {
    if (existing) {
      await configsCol.doc(existing._id).update({
        data: {
          baseUrl: baseUrl,
          model: model,
          encryptedApiKey: finalEncrypted,
          keyNonce: finalNonce,
          keyAuthTag: finalAuthTag,
          keyVersion: 1,
          updatedAt: now,
        },
      });
    } else {
      await configsCol.add({
        data: {
          userId: user._id,
          baseUrl: baseUrl,
          model: model,
          encryptedApiKey: finalEncrypted,
          keyNonce: finalNonce,
          keyAuthTag: finalAuthTag,
          keyVersion: 1,
          createdAt: now,
          updatedAt: now,
        },
      });
    }
  } catch (e) {
    if (isCollectionMissing(e)) {
      return fail('DB_NOT_READY', '数据库集合 user_ai_configs 不存在，请先在云开发控制台创建');
    }
    throw e;
  }

  // 查询脱敏后的 Key 用于返回
  const masked = maskApiKey(apiKey || 'placeholder');
  // 注意：不能把 encryptApiKey(apiKey) 的结果返回给前端

  return ok({
    baseUrl: baseUrl,
    model: model,
    maskedApiKey: masked,
  });
}

/**
 * 删除当前用户的 API 配置。
 * 二次确认由前端完成；删除后在日志中不输出旧密钥。
 */
async function handleDeleteAiConfig(event, wxContext) {
  const openid = wxContext.OPENID || '';
  if (!openid) {
    return fail('AUTH_REQUIRED', '请先登录');
  }

  const user = await findUserByOpenid(openid);
  if (!user) {
    return fail('USER_NOT_FOUND', '用户不存在，请重新登录');
  }

  let existing;
  try {
    const result = await configsCol.where({ userId: user._id }).limit(1).get();
    existing = result.data[0] || null;
  } catch (e) {
    if (isCollectionMissing(e)) {
      return fail('DB_NOT_READY', '数据库集合 user_ai_configs 不存在，请先在云开发控制台创建');
    }
    throw e;
  }

  if (!existing) {
    return ok({ deleted: false, message: '没有可删除的配置' });
  }

  try {
    await configsCol.doc(existing._id).remove();
  } catch (e) {
    if (isCollectionMissing(e)) {
      return fail('DB_NOT_READY', '数据库集合 user_ai_configs 不存在，请先在云开发控制台创建');
    }
    throw e;
  }

  return ok({ deleted: true });
}

/**
 * 测试当前用户的 API 配置连通性。
 *
 * 发送一条最小化测试请求，只报告连接结果，不把业务数据发给模型。
 */
async function handleTestAiConfig(event, wxContext) {
  const openid = wxContext.OPENID || '';
  if (!openid) {
    return fail('AUTH_REQUIRED', '请先登录');
  }

  const user = await findUserByOpenid(openid);
  if (!user) {
    return fail('USER_NOT_FOUND', '用户不存在，请重新登录');
  }

  // 支持两种模式：
  //   1. 传入临时 baseUrl / model / apiKey —— 保存前测试
  //   2. 不传参数 —— 测试已保存的配置
  const hasTemp = !!(event.tempBaseUrl || event.tempModel || event.tempApiKey);

  let baseUrl, model, encryptedApiKey, keyNonce, keyAuthTag;

  if (hasTemp) {
    baseUrl = (event.tempBaseUrl || '').trim();
    model = (event.tempModel || '').trim();
    const apiKey = (event.tempApiKey || '').trim();

    const urlError = validateBaseUrl(baseUrl);
    if (urlError) return fail('INVALID_PARAMS', urlError);

    const modelError = validateModel(model);
    if (modelError) return fail('INVALID_PARAMS', modelError);

    const keyError = validateApiKey(apiKey);
    if (keyError) return fail('INVALID_PARAMS', keyError);

    // 临时测试不做持久化：原地加密 → 测试 → 丢弃
    try {
      const enc = encryptApiKey(apiKey);
      encryptedApiKey = enc.encrypted;
      keyNonce = enc.nonce;
      keyAuthTag = enc.authTag;
    } catch (e) {
      if (e.code === 'ENCRYPTION_KEY_MISSING' || e.code === 'ENCRYPTION_KEY_INVALID') {
        return fail('ENCRYPTION_KEY_MISSING', '服务端加密密钥未正确配置，请检查云函数环境变量 ' + ENV_ENCRYPTION_KEY);
      }
      throw e;
    }
  } else {
    // 读取已保存的配置
    const config = await readFullAiConfig(db, user._id);
    if (!config) {
      return fail('AI_CONFIG_REQUIRED', '尚未配置 API，请先保存配置后再测试');
    }
    baseUrl = config.baseUrl;
    model = config.model;
    encryptedApiKey = config.encryptedApiKey;
    keyNonce = config.keyNonce;
    keyAuthTag = config.keyAuthTag;
  }

  const aiConfig = { baseUrl, model, encryptedApiKey, keyNonce, keyAuthTag };

  // 最小化测试：发一条简单的对话
  try {
    const content = await chatCompletion(
      aiConfig,
      [{ role: 'user', content: 'Hi' }],
      { temperature: 0, max_tokens: 5, timeoutMs: AI_TEST_TIMEOUT_MS },
    );

    return ok({
      connected: true,
      message: '连接成功，模型返回正常',
      // 不返回模型具体回复内容，仅确认连通
    });
  } catch (e) {
    // 映射错误码为用户可理解的信息
    const errorMessages = {
      'AI_AUTH_FAILED': 'API 认证失败，请检查 API Key 是否正确',
      'AI_CONNECTION_FAILED': '无法连接到 API 地址，请检查 Base URL 是否正确',
      'AI_NOT_FOUND': '模型不存在，请检查 Model 名称是否正确',
      'AI_TIMEOUT': '连接超时，请检查网络或 API 地址是否可达',
      'AI_REDIRECT': 'API 地址返回了重定向，请检查 Base URL 是否完整',
      'AI_SERVER_ERROR': '模型服务异常，请稍后重试',
      'AI_INVALID_RESPONSE': 'API 返回了无法识别的格式，可能不兼容 OpenAI 格式',
      'AI_RESPONSE_TOO_LARGE': 'API 返回数据过大',
      'AI_REQUEST_FAILED': 'API 请求失败，请检查 Base URL 和配置',
      'INVALID_URL': 'Base URL 格式无效',
      'URL_NOT_HTTPS': 'Base URL 必须以 https:// 开头',
      'URL_BLOCKED': '不允许使用该地址',
      'ENCRYPTION_KEY_MISSING': '服务端加密密钥未配置',
      'ENCRYPTION_KEY_INVALID': '服务端加密密钥格式错误',
      'DECRYPT_FAILED': '密钥解密失败，请重新配置 API Key',
    };

    const friendly = errorMessages[e.code] || e.message || '测试失败，请检查配置';

    return ok({
      connected: false,
      message: friendly,
      errorCode: e.code || 'UNKNOWN',
    });
  }
}

/* ============================== 业务路由 ============================== */

const handlers = {
  ping() {
    return ok({ function: 'ai-config', status: 'ok', time: Date.now() });
  },

  getAiConfig: handleGetAiConfig,
  saveAiConfig: handleSaveAiConfig,
  deleteAiConfig: handleDeleteAiConfig,
  testAiConfig: handleTestAiConfig,
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
      response = fail('DB_NOT_READY', '数据库集合 user_ai_configs 不存在，请先在云开发控制台创建');
    } else {
      // 不输出加密 / 解密错误细节到日志
      const isCryptoError = error.code === 'ENCRYPTION_KEY_MISSING' ||
        error.code === 'ENCRYPTION_KEY_INVALID' ||
        error.code === 'DECRYPT_FAILED';
      if (isCryptoError) {
        response = fail('INTERNAL_ERROR', '服务端配置异常，请联系管理员');
      } else {
        console.error('[ai-config] 未捕获异常', error.code || '', error.message || '');
        response = fail('INTERNAL_ERROR', '服务内部异常，请稍后重试');
      }
    }
  }

  // 统一日志：不记录密钥相关内容
  console.log(
    JSON.stringify({
      functionName: 'ai-config',
      requestId: requestId,
      userId: openid,
      action: action,
      duration: Date.now() - startedAt,
      status: response.success ? 'success' : 'fail',
      code: response.code || '',
      error: response.success ? '' : (response.message || ''),
    }),
  );

  return response;
};