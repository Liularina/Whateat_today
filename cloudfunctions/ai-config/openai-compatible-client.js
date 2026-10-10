/**
 * OpenAI 兼容 Chat Completions 统一客户端（Phase 7）
 *
 * 两个云函数共用：
 *   ai-config  → testAiConfig 用本模块测试连通性
 *   recommend  → recommendMenus 用本模块调用 AI
 *
 * 职责：
 *   1. URL 校验与规范化（防 SSRF）
 *   2. AES-256-GCM API Key 解密（密钥来自环境变量）
 *   3. OpenAI Chat Completions 调用
 *   4. 超时 / 错误处理 / 响应大小限制
 *   5. JSON 解析与结构校验
 *   6. 敏感信息过滤（日志不记录密钥 / 完整请求体）
 *
 * 约束：
 *   - 只允许 HTTPS
 *   - 拒绝 localhost / 回环 / 私有 / 链路本地 / 云元数据地址
 *   - 限制响应体大小（MAX_RESPONSE_BYTES）
 *   - 限制重定向（不跟随重定向，返回错误）
 *   - 不在日志中输出 API Key 或 Authorization 头
 */
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

/* ============================== 配置常量 ============================== */

/** 模型调用超时（毫秒）：build + connect + response */
const AI_CALL_TIMEOUT_MS = 45000;

/** 连接测试专用超时（毫秒），比业务调用更短 */
const AI_TEST_TIMEOUT_MS = 15000;

/** 模型响应体最大字节数 */
const MAX_RESPONSE_BYTES = 512 * 1024;

/** Chat Completions 路径后缀 */
const CHAT_COMPLETIONS_PATH = '/chat/completions';

/** 环境变量：AES-256-GCM 加密密钥（64 位 hex → 32 字节） */
const ENV_ENCRYPTION_KEY = 'USER_API_KEY_ENCRYPTION_SECRET';

/** 加密算法标识 */
const CIPHER_ALGO = 'aes-256-gcm';

/** nonce / authTag 的 hex 编码长度 */
const NONCE_HEX_LENGTH = 24; // 12 字节
const AUTH_TAG_HEX_LENGTH = 32; // 16 字节

/* ============================== URL 安全校验 ============================== */

/** 内网 / 敏感地址块 */
const BLOCKED_IPV4_PATTERNS = [
  /^127\./,                     // 回环
  /^10\./,                      // A 类私有
  /^172\.(1[6-9]|2\d|3[01])\./,  // B 类私有
  /^192\.168\./,                // C 类私有
  /^169\.254\./,                // 链路本地
  /^0\.0\.0\.0$/,               // 全零
];

/** 云元数据地址 */
const BLOCKED_HOSTS = [
  'metadata.google.internal',
  '169.254.169.254',
  '100.100.100.200',            // 阿里云
];

/** 禁止的 hostname 模式 */
const BLOCKED_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /\.local$/i,
  /\.internal$/i,
];

/**
 * 校验 Base URL 并返回规范化的完整 Chat Completions 地址。
 * 拒绝所有不安全的地址；若一切正常则返回拼接好的完整 URL 字符串。
 */
function validateAndBuildUrl(baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string') {
    throw Object.assign(new Error('API Base URL 不能为空'), { code: 'INVALID_URL' });
  }

  let trimmed = baseUrl.trim();

  // 只允许 HTTPS
  if (!trimmed.startsWith('https://')) {
    throw Object.assign(
      new Error('API Base URL 必须以 https:// 开头'),
      { code: 'URL_NOT_HTTPS' },
    );
  }

  // 去掉尾部斜杠
  trimmed = trimmed.replace(/\/+$/, '');

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (_e) {
    throw Object.assign(new Error('API Base URL 格式无效'), { code: 'INVALID_URL' });
  }

  const hostname = parsed.hostname;

  // 检查 hostname 黑名单
  for (const blocked of BLOCKED_HOSTS) {
    if (hostname === blocked) {
      throw Object.assign(
        new Error('不允许使用该地址'),
        { code: 'URL_BLOCKED' },
      );
    }
  }

  // 检查 hostname 模式黑名单
  for (const pattern of BLOCKED_HOSTNAME_PATTERNS) {
    if (pattern.test(hostname)) {
      throw Object.assign(
        new Error('不允许使用内网或本地地址'),
        { code: 'URL_BLOCKED' },
      );
    }
  }

  // DNS 层无法在校验阶段拦截，但 IPv4 白名单检查作为最后一道防线
  // 注意：这里只校验原始 hostname 是域名的情况；若用户传入 IP，直接检查
  const looksLikeIp = /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
  if (looksLikeIp) {
    for (const pattern of BLOCKED_IPV4_PATTERNS) {
      if (pattern.test(hostname)) {
        throw Object.assign(
          new Error('不允许使用内网 IP 地址'),
          { code: 'URL_BLOCKED' },
        );
      }
    }
  }

  // 仅允许标准端口 443 或不指定端口
  if (parsed.port && parsed.port !== '443') {
    throw Object.assign(
      new Error('仅允许 HTTPS 默认端口 443'),
      { code: 'URL_BLOCKED' },
    );
  }

  // 避免 path 里已有 /chat/completions 导致重复拼接
  let path = parsed.pathname.replace(/\/+$/, '');
  if (path.endsWith('/v1') || path.endsWith('/v1/')) {
    // 正常：baseUrl = https://api.example.com/v1 → 拼接 /chat/completions
  } else if (path.indexOf('/chat/completions') !== -1) {
    // 用户已经在 URL 里带了 /chat/completions，不再拼
    return trimmed + (parsed.search || '');
  }
  // else: 直接拼接

  return trimmed + CHAT_COMPLETIONS_PATH;
}

/* ============================== AES-256-GCM 加密 ============================== */

function getEncryptionKey() {
  const raw = process.env[ENV_ENCRYPTION_KEY];
  if (!raw || typeof raw !== 'string' || raw.trim().length === 0) {
    throw Object.assign(
      new Error('服务端加密密钥未配置，请联系管理员设置环境变量 ' + ENV_ENCRYPTION_KEY),
      { code: 'ENCRYPTION_KEY_MISSING' },
    );
  }

  // 必须是 64 位 hex → 32 字节（AES-256）
  const hex = raw.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw Object.assign(
      new Error('加密密钥格式不正确：需要 64 位十六进制字符串（32 字节）'),
      { code: 'ENCRYPTION_KEY_INVALID' },
    );
  }

  return Buffer.from(hex, 'hex');
}

/**
 * 加密 API Key → { encrypted, nonce, authTag }（均为 hex 字符串）
 */
function encryptApiKey(plaintext) {
  const key = getEncryptionKey();
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(CIPHER_ALGO, key, nonce);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  return {
    encrypted: encrypted,
    nonce: nonce.toString('hex'),
    authTag: authTag.toString('hex'),
  };
}

/**
 * 解密 API Key → 明文
 *
 * @param {object} encryptedFields { encrypted, nonce, authTag }
 * @returns {string} 明文 API Key
 */
function decryptApiKey(encryptedFields) {
  if (!encryptedFields || !encryptedFields.encrypted || !encryptedFields.nonce || !encryptedFields.authTag) {
    throw Object.assign(
      new Error('加密数据不完整，无法解密'),
      { code: 'DECRYPT_FAILED' },
    );
  }

  const key = getEncryptionKey();
  const nonce = Buffer.from(encryptedFields.nonce, 'hex');
  const authTag = Buffer.from(encryptedFields.authTag, 'hex');

  if (nonce.length !== 12 || authTag.length !== 16) {
    throw Object.assign(
      new Error('加密数据格式不正确'),
      { code: 'DECRYPT_FAILED' },
    );
  }

  let decipher;
  try {
    decipher = crypto.createDecipheriv(CIPHER_ALGO, key, nonce);
    decipher.setAuthTag(authTag);
  } catch (_e) {
    throw Object.assign(
      new Error('解密初始化失败，密钥可能已更换'),
      { code: 'DECRYPT_FAILED' },
    );
  }

  try {
    let decrypted = decipher.update(encryptedFields.encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (_e) {
    throw Object.assign(
      new Error('API Key 解密失败，密钥可能已更换，请重新配置'),
      { code: 'DECRYPT_FAILED' },
    );
  }
}

/**
 * 脱敏展示 API Key：保留前 3 位 + 后 4 位，中间用 * 替代
 */
function maskApiKey(plaintext) {
  if (!plaintext || plaintext.length < 8) {
    return '****';
  }
  return plaintext.slice(0, 3) + '****' + plaintext.slice(-4);
}

/* ============================== HTTP 请求 ============================== */

/**
 * 发送 Chat Completions 请求并返回原始响应文本。
 *
 * 安全措施：
 *   - 不跟随重定向（3xx 视为错误）
 *   - 限制响应体大小
 *   - 不在日志中输出 Authorization 头
 *
 * @param {string} url 完整的 Chat Completions URL
 * @param {string} apiKey 解密后的 API Key
 * @param {object} body 请求体（model / messages / temperature 等）
 * @param {number} timeoutMs 超时毫秒数
 * @returns {Promise<string>} 响应体文本
 */
function chatCompletionsRequest(url, apiKey, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const bodyJson = JSON.stringify(body);

    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + (parsed.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'Content-Length': Buffer.byteLength(bodyJson),
        'Accept': 'application/json',
      },
      timeout: timeoutMs,
      // 关键：不允许重定向到内网
      rejectUnauthorized: true,
    };

    const req = https.request(options, (res) => {
      // 不跟随重定向
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        req.destroy();
        reject(Object.assign(
          new Error('服务端返回重定向，不支持（状态码 ' + res.statusCode + '）'),
          { code: 'AI_REDIRECT', statusCode: res.statusCode },
        ));
        return;
      }

      const chunks = [];
      let totalLength = 0;

      res.on('data', (chunk) => {
        totalLength += chunk.length;
        if (totalLength > MAX_RESPONSE_BYTES) {
          req.destroy();
          reject(Object.assign(
            new Error('模型返回数据过大'),
            { code: 'AI_RESPONSE_TOO_LARGE' },
          ));
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        const bodyText = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 401 || res.statusCode === 403) {
          reject(Object.assign(
            new Error('API 认证失败，请检查 API Key 是否正确'),
            { code: 'AI_AUTH_FAILED', statusCode: res.statusCode },
          ));
          return;
        }
        if (res.statusCode === 404) {
          reject(Object.assign(
            new Error('模型接口不存在（404），请检查 Base URL 和 Model 名称'),
            { code: 'AI_NOT_FOUND', statusCode: res.statusCode },
          ));
          return;
        }
        if (res.statusCode && res.statusCode >= 500) {
          reject(Object.assign(
            new Error('模型服务异常（状态码 ' + res.statusCode + '），请稍后重试'),
            { code: 'AI_SERVER_ERROR', statusCode: res.statusCode },
          ));
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          let detail = '';
          try {
            const json = JSON.parse(bodyText);
            detail = json.error?.message || json.error?.code || '';
          } catch (_e) { /* ignore */ }
          reject(Object.assign(
            new Error(detail || '模型请求失败（状态码 ' + res.statusCode + '）'),
            { code: 'AI_REQUEST_FAILED', statusCode: res.statusCode },
          ));
          return;
        }
        resolve(bodyText);
      });
    });

    req.on('error', (err) => {
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        reject(Object.assign(
          new Error('无法连接到 API 地址，请检查 Base URL 是否正确'),
          { code: 'AI_CONNECTION_FAILED' },
        ));
      } else if (err.code === 'ETIMEDOUT' || err.code === 'ESOCKETTIMEDOUT') {
        reject(Object.assign(
          new Error('API 请求超时，请检查网络或稍后重试'),
          { code: 'AI_TIMEOUT' },
        ));
      } else {
        reject(Object.assign(
          new Error('API 请求失败：' + (err.message || '未知网络错误')),
          { code: 'AI_REQUEST_FAILED' },
        ));
      }
    });

    req.on('timeout', () => {
      req.destroy();
      reject(Object.assign(
        new Error('API 请求超时，请检查网络或稍后重试'),
        { code: 'AI_TIMEOUT' },
      ));
    });

    req.write(bodyJson);
    req.end();
  });
}

/* ============================== Chat Completions 高层接口 ============================== */

/**
 * 发送 Chat Completions 请求并返回解析后的消息文本。
 *
 * 必需参数通过 aiConfig 传入，可选的 response_format 等由 caller 在 extra 中指定。
 *
 * @param {object} aiConfig { baseUrl, model, encryptedApiKey, keyNonce, keyAuthTag }
 * @param {Array<{role:string,content:string}>} messages
 * @param {object} options { temperature?, response_format?, max_tokens?, timeoutMs? }
 * @returns {Promise<string>} 模型返回的文本内容
 */
async function chatCompletion(aiConfig, messages, options = {}) {
  const { temperature = 0.7, response_format, max_tokens, timeoutMs = AI_CALL_TIMEOUT_MS } = options;

  if (!aiConfig || !aiConfig.baseUrl || !aiConfig.model) {
    throw Object.assign(
      new Error('AI 配置不完整'),
      { code: 'AI_CONFIG_INCOMPLETE' },
    );
  }

  // 1. URL 校验
  const url = validateAndBuildUrl(aiConfig.baseUrl);

  // 2. 解密 API Key
  const apiKey = decryptApiKey({
    encrypted: aiConfig.encryptedApiKey,
    nonce: aiConfig.keyNonce,
    authTag: aiConfig.keyAuthTag,
  });

  // 3. 构造请求体
  const body = {
    model: aiConfig.model,
    messages: messages,
    temperature: temperature,
  };

  if (max_tokens) {
    body.max_tokens = max_tokens;
  }

  // 仅在调用方明确要求时传入 response_format
  // 不是所有兼容服务商都支持，不支持的返回报错也不影响功能（提示词已要求 JSON）
  if (response_format) {
    body.response_format = response_format;
  }

  // 4. 发送请求
  const responseText = await chatCompletionsRequest(url, apiKey, body, timeoutMs);

  // 5. 解析响应
  let parsed;
  try {
    parsed = JSON.parse(responseText);
  } catch (_e) {
    throw Object.assign(
      new Error('模型返回了无法解析的响应格式'),
      { code: 'AI_INVALID_RESPONSE' },
    );
  }

  // 兼容多种响应格式
  const content =
    (parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content) ||
    (parsed.choices && parsed.choices[0] && parsed.choices[0].text) ||
    '';

  if (!content && content !== '') {
    throw Object.assign(
      new Error('模型未返回有效内容'),
      { code: 'AI_EMPTY_RESPONSE' },
    );
  }

  return content;
}

/* ============================== 配置读取辅助 ============================== */

/**
 * 从 user_ai_configs 集合读取当前用户的 AI 配置（不包含解密后的 Key）
 *
 * @param {object} db cloud.database() 实例
 * @param {string} userId 用户业务 ID（不是 openid）
 * @returns {Promise<{configured:boolean, baseUrl?:string, model?:string, maskedApiKey?:string}>}
 */
async function readAiConfig(db, userId) {
  const result = await db.collection('user_ai_configs').where({ userId }).limit(1).get();
  const row = result.data[0];

  if (!row) {
    return { configured: false };
  }

  return {
    configured: true,
    baseUrl: row.baseUrl,
    model: row.model,
    maskedApiKey: row.encryptedApiKey ? maskApiKey(
      decryptApiKey({
        encrypted: row.encryptedApiKey,
        nonce: row.keyNonce,
        authTag: row.keyAuthTag,
      }),
    ) : '****',
  };
}

/**
 * 从 user_ai_configs 读取并解密完整的 AI 配置（含明文 Key，仅服务端使用）
 *
 * @param {object} db cloud.database() 实例
 * @param {string} userId 用户业务 ID
 * @returns {Promise<object|null>} { baseUrl, model, encryptedApiKey, keyNonce, keyAuthTag } 或 null
 */
async function readFullAiConfig(db, userId) {
  const result = await db.collection('user_ai_configs').where({ userId }).limit(1).get();
  const row = result.data[0];

  if (!row) {
    return null;
  }

  return {
    _id: row._id,
    baseUrl: row.baseUrl,
    model: row.model,
    encryptedApiKey: row.encryptedApiKey,
    keyNonce: row.keyNonce,
    keyAuthTag: row.keyAuthTag,
    keyVersion: row.keyVersion,
  };
}

/* ============================== JSON 解析辅助 ============================== */

/**
 * 从模型返回的文本中提取 JSON。兼容三种情况：
 *   1. 纯 JSON 文本
 *   2. Markdown 代码围栏包裹的 JSON 块
 *   3. 文本中夹了一段的 JSON 对象
 *
 * @param {string} text 模型返回的原始文本
 * @returns {object|null} 解析成功返回对象，失败返回 null
 */
function extractJson(text) {
  if (!text || typeof text !== 'string') {
    return null;
  }

  // 尝试 1：去掉 Markdown 代码围栏后直接解析
  const cleaned = text
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?\s*```\s*$/, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (_e) {
    // 继续尝试
  }

  // 尝试 2：在文本中找第一个 { 到最后一个 }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch (_e) {
      // 继续尝试
    }
  }

  // 尝试 3：找 ```json 代码块
  const match = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/i);
  if (match) {
    try {
      return JSON.parse(match[1].trim());
    } catch (_e) {
      // 失败
    }
  }

  return null;
}

/**
 * 模板化 JSON 修复：在某些字段缺闭合括号时尝试补全。
 * 仅修复常见边角情况，不追求完整修复。
 */
function attemptJsonRepair(text) {
  if (!text || typeof text !== 'string') {
    return null;
  }

  const cleaned = text
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?\s*```\s*$/, '')
    .trim();

  // 尝试补全截断的 JSON：统计括号
  let braceDepth = 0;
  let bracketDepth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') braceDepth++;
    if (ch === '}') braceDepth--;
    if (ch === '[') bracketDepth++;
    if (ch === ']') bracketDepth--;
  }

  if (braceDepth > 0 || bracketDepth > 0) {
    const repaired = cleaned + ']'.repeat(Math.max(0, bracketDepth)) + '}'.repeat(Math.max(0, braceDepth));
    try {
      return JSON.parse(repaired);
    } catch (_e) {
      // 修复失败
    }
  }

  return null;
}

module.exports = {
  // 加密与脱敏（仅供 ai-config 云函数使用）
  encryptApiKey,
  maskApiKey,
  decryptApiKey,

  // URL 校验
  validateAndBuildUrl,

  // AI 调用
  chatCompletion,
  chatCompletionsRequest,

  // 配置读取
  readAiConfig,
  readFullAiConfig,

  // JSON 解析
  extractJson,
  attemptJsonRepair,

  // 超时常量
  AI_CALL_TIMEOUT_MS,
  AI_TEST_TIMEOUT_MS,

  // 环境变量名（供外部参考）
  ENV_ENCRYPTION_KEY,
};