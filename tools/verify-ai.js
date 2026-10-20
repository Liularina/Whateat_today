/**
 * 统一 AI 服务 · 静态结构与行为验证（Phase C）
 *
 * 运行：npm run verify:ai          （完整输出）
 *       npm run verify:ai -- --quiet（只输出小节标题、失败项与总计）
 *
 * 覆盖三块：
 *   1. 静态结构 —— 4 份 client / ai-service 必须字节一致；三个 AI 云函数不得再各自
 *      直连 user_ai_configs，必须走 ai-service 的统一入口；
 *   2. 内置通道 —— 凭据只来自环境变量，未配置/配错必须 fail closed，
 *      对外状态绝不泄露 Key、Base URL、模型名；
 *   3. 额度与路由 —— 每日额度的原子性、超限、北京日切、模式路由与错误码，
 *      以及「客户端传什么都不可能自带凭据或绕过额度」。
 *
 * 用内存版 wx-server-sdk（tools/mock-cloud.js）当数据库，不依赖真实云环境。
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { createMockCloud } = require('./mock-cloud');

const mock = createMockCloud();
const store = mock.store;
const db = mock.mockCloud.database();

const ROOT = path.join(__dirname, '..');
const CF = path.join(ROOT, 'cloudfunctions');
const AI_DIRS = ['ai-config', 'chat', 'menu', 'recipe', 'recommend'];
/** 真正会调用模型的云函数（ai-config 只做配置与连通测试，不算业务调用方） */
const AI_CALLERS = ['chat', 'menu', 'recipe', 'recommend'];

const clientPath = (dir) => path.join(CF, dir, 'openai-compatible-client.js');
const servicePath = (dir) => path.join(CF, dir, 'ai-service.js');

const aiService = require(servicePath('ai-config'));
const client = require(clientPath('ai-config'));

/* ============================== 断言工具 ============================== */

let passed = 0;
const failures = [];
const QUIET = process.argv.indexOf('--quiet') !== -1;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    if (!QUIET) console.log('  [通过] ' + name);
    return;
  }
  failures.push(name + (detail ? ' -> ' + detail : ''));
  console.log('  [失败] ' + name + (detail ? ' -> ' + detail : ''));
}

function checkEqual(name, actual, expected) {
  check(
    name,
    actual === expected,
    'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected),
  );
}

function section(title) {
  console.log('\n=== ' + title + ' ===');
}

/* ============================== 环境变量工具 ============================== */

const BUILTIN_ENV_KEYS = [
  aiService.ENV_BUILTIN_ENABLED,
  aiService.ENV_BUILTIN_BASE_URL,
  aiService.ENV_BUILTIN_MODEL,
  aiService.ENV_BUILTIN_API_KEY,
  aiService.ENV_BUILTIN_DAILY_QUOTA,
];

/** 清空内置通道的全部环境变量 */
function clearBuiltinEnv() {
  BUILTIN_ENV_KEYS.forEach((key) => {
    delete process.env[key];
  });
}

/** 写入一套可用的内置通道配置 */
function setupBuiltinEnv(overrides) {
  clearBuiltinEnv();
  const env = Object.assign({
    AI_BUILTIN_ENABLED: 'true',
    AI_BUILTIN_BASE_URL: 'https://api.example-vendor.com/v1',
    AI_BUILTIN_MODEL: 'vendor-model-x',
    AI_BUILTIN_API_KEY: 'sk-test-builtin-key-0123456789',
  }, overrides || {});

  Object.keys(env).forEach((key) => {
    if (env[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = env[key];
    }
  });
}

/** 造一个用户自配 API 配置（Key 用密文格式占位，本套件不真解密） */
function seedCustomConfig(userId, secret) {
  const enc = client.encryptApiKeyWithSecret
    ? null
    : null;
  // 直接用 client 的加密函数需要环境变量密钥，这里退化为构造密文结构：
  // resolveAiCall 只判断「有没有配置」，不在这里解密，解密发生在 chatCompletion。
  store.user_ai_configs.push({
    _id: 'cfg_' + userId,
    userId: userId,
    baseUrl: 'https://user-vendor.example.com/v1',
    model: 'user-model',
    encryptedApiKey: 'deadbeef',
    keyNonce: 'aabbccddeeff001122334455',
    keyAuthTag: '00112233445566778899aabbccddeeff',
    keyVersion: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/** 造一个微信号用户 */
function seedUser(openid, id) {
  store.users.push({ _id: id, openid: openid, createdAt: new Date() });
  return id;
}

function resetAiStore() {
  mock.resetStore();
  mock.setMissingCollections([]);
}

/* ============================== A. 静态结构 ============================== */

function runStructureChecks() {
  section('A. 静态结构');

  ['openai-compatible-client.js', 'ai-service.js'].forEach((name) => {
    const hashes = AI_DIRS.map((dir) =>
      crypto.createHash('sha256').update(fs.readFileSync(path.join(CF, dir, name))).digest('hex'),
    );
    checkEqual(
      name + ' 在 ' + AI_DIRS.length + ' 个云函数目录中字节一致',
      new Set(hashes).size,
      1,
    );
  });

  // 三个业务云函数必须统一走 ai-service.runAiCall
  AI_CALLERS.forEach((dir) => {
    const source = fs.readFileSync(path.join(CF, dir, 'index.js'), 'utf8');
    check(dir + ' 引入 ai-service', source.indexOf("require('./ai-service')") !== -1);
    check(dir + ' 走统一入口 runAiCall', source.indexOf('aiService.runAiCall') !== -1);
    check(
      dir + ' 不再直连 user_ai_configs',
      source.indexOf('readFullAiConfig') === -1,
      '仍在使用 readFullAiConfig',
    );
  });

  // 三个云函数目录都必须有 ai-service.js（云函数之间不能共享文件）
  AI_CALLERS.forEach((dir) => {
    check(dir + '/ai-service.js 存在', fs.existsSync(servicePath(dir)));
  });

  const serviceSource = fs.readFileSync(servicePath('ai-config'), 'utf8');

  // 内置通道凭据只能从环境变量来，源码里不允许出现任何真实形态的密钥
  check(
    'ai-service 源码不含硬编码密钥',
    !/sk-[A-Za-z0-9_-]{12,}/.test(serviceSource),
  );
  check(
    'ai-service 通过 process.env 读取凭据',
    serviceSource.indexOf('process.env[ENV_BUILTIN_API_KEY]') !== -1,
  );
  check(
    '内置凭据读取集中在 getBuiltinConfig',
    serviceSource.indexOf('function getBuiltinConfig') !== -1,
  );

  // 明文 Key 只允许出现在 getBuiltinConfig 的返回与 resolveAiCall 的 aiConfig 构造里
  check(
    'ai-service 不把 Key 写进日志字段',
    serviceSource.indexOf('apiKey:') === -1 ||
      // 允许 aiConfig 构造与返回值，但不允许出现在 logAiCall/recordAiCall 的字段里
      serviceSource.indexOf('logAiCall(aiConfig') === -1,
  );

  const pageSource = fs.readFileSync(
    path.join(ROOT, 'miniprogram', 'pages', 'ai-settings', 'index.ts'),
    'utf8',
  );
  check(
    'AI 设置页不直接调用 wx.cloud.callFunction',
    pageSource.indexOf('wx.cloud.callFunction') === -1,
  );
}

/* ============================== B. 内置通道 fail closed ============================== */

function runBuiltinChecks() {
  section('B. 内置通道凭据与状态');

  clearBuiltinEnv();
  let status = aiService.getBuiltinStatus();
  checkEqual('未配置任何环境变量时默认启用（fail open，方便运维）', status.enabled, true);
  checkEqual('未配置任何环境变量时不可用（缺凭据）', status.ready, false);
  checkEqual('默认每日额度为 20', status.dailyQuota, aiService.DEFAULT_BUILTIN_DAILY_QUOTA);

  process.env.AI_BUILTIN_ENABLED = 'false';
  setupBuiltinEnv({ AI_BUILTIN_ENABLED: 'false' });
  checkEqual('AI_BUILTIN_ENABLED=false 时不启用', aiService.getBuiltinStatus().enabled, false);
  checkEqual('未启用时不可用', aiService.getBuiltinStatus().ready, false);

  // 凭据三件套缺一不可
  ['AI_BUILTIN_BASE_URL', 'AI_BUILTIN_MODEL', 'AI_BUILTIN_API_KEY'].forEach((missing) => {
    setupBuiltinEnv({ [missing]: '' });
    checkEqual('缺少 ' + missing + ' 时不可用', aiService.getBuiltinStatus().ready, false);
    checkEqual(
      '缺少 ' + missing + ' 的原因标记为 missing_credentials',
      aiService.getBuiltinConfig().reason,
      'missing_credentials',
    );
  });

  // 配错地址必须在调用前就被拦住
  setupBuiltinEnv({ AI_BUILTIN_BASE_URL: 'http://api.example-vendor.com/v1' });
  checkEqual('非 HTTPS 地址不可用', aiService.getBuiltinStatus().ready, false);
  checkEqual('非 HTTPS 地址原因为 invalid_base_url', aiService.getBuiltinConfig().reason, 'invalid_base_url');

  setupBuiltinEnv({ AI_BUILTIN_BASE_URL: 'https://127.0.0.1/v1' });
  checkEqual('回环地址不可用', aiService.getBuiltinStatus().ready, false);

  setupBuiltinEnv({ AI_BUILTIN_BASE_URL: 'https://192.168.1.10/v1' });
  checkEqual('内网地址不可用', aiService.getBuiltinStatus().ready, false);

  // 配齐后可用
  setupBuiltinEnv();
  status = aiService.getBuiltinStatus();
  checkEqual('配齐凭据后启用', status.enabled, true);
  checkEqual('配齐凭据后可用', status.ready, true);

  // 对外状态禁止泄露任何凭据或供应商细节
  const statusJson = JSON.stringify(status);
  check('对外状态不含 API Key', statusJson.indexOf('sk-test-builtin-key') === -1);
  check('对外状态不含 Base URL', statusJson.indexOf('api.example-vendor.com') === -1);
  check('对外状态不含模型名', statusJson.indexOf('vendor-model-x') === -1);
  check('对外状态字段只有 enabled/ready/dailyQuota', Object.keys(status).sort().join(',') === 'dailyQuota,enabled,ready');

  // 额度阈值健壮性
  setupBuiltinEnv({ AI_BUILTIN_DAILY_QUOTA: 'abc' });
  checkEqual('非法额度回退默认值', aiService.getBuiltinStatus().dailyQuota, 20);

  setupBuiltinEnv({ AI_BUILTIN_DAILY_QUOTA: '-5' });
  checkEqual('负数额度钳到下限', aiService.getBuiltinStatus().dailyQuota, aiService.MIN_BUILTIN_DAILY_QUOTA);

  setupBuiltinEnv({ AI_BUILTIN_DAILY_QUOTA: '99999' });
  checkEqual('超大额度钳到上限', aiService.getBuiltinStatus().dailyQuota, aiService.MAX_BUILTIN_DAILY_QUOTA);

  setupBuiltinEnv({ AI_BUILTIN_DAILY_QUOTA: '7' });
  checkEqual('合法额度原样生效', aiService.getBuiltinStatus().dailyQuota, 7);

  clearBuiltinEnv();
}

/* ============================== C. 模式路由 ============================== */

async function runRoutingChecks() {
  section('C. 模式路由与统一入口');

  checkEqual('默认模式为内置', aiService.DEFAULT_AI_MODE, 'builtin');
  checkEqual('合法模式只有两个', aiService.AI_MODES.length, 2);

  resetAiStore();
  const userId = seedUser('openid-a', 'user_a');

  // 用户偏好：无记录 → 默认
  checkEqual('无偏好记录时读默认模式', await aiService.readAiMode(db, userId), 'builtin');

  await aiService.saveAiMode(db, userId, 'custom');
  checkEqual('保存后读到自定义模式', await aiService.readAiMode(db, userId), 'custom');

  await aiService.saveAiMode(db, userId, 'builtin');
  checkEqual('再次切换后读到内置模式', await aiService.readAiMode(db, userId), 'builtin');
  checkEqual('偏好表只有一行（upsert，不是每次新增）', store.user_ai_prefs.length, 1);

  let invalidModeRejected = false;
  try {
    await aiService.saveAiMode(db, userId, 'whatever');
  } catch (e) {
    invalidModeRejected = e.code === 'AI_MODE_INVALID';
  }
  check('保存非法模式被拒绝', invalidModeRejected);

  // 集合不存在时读模式要能降级，不能让整个 AI 功能不可用
  mock.setMissingCollections(['user_ai_prefs']);
  let degraded = null;
  try {
    degraded = await aiService.readAiMode(db, userId);
  } catch (e) {
    degraded = 'threw:' + e.code;
  }
  checkEqual('偏好集合缺失时降级为默认模式', degraded, 'builtin');
  mock.setMissingCollections([]);

  // 内置未就绪：默认模式必须明确报错，不回退到用户自配
  resetAiStore();
  const uid2 = seedUser('openid-b', 'user_b');
  seedCustomConfig(uid2);
  await aiService.saveAiMode(db, uid2, 'builtin');
  clearBuiltinEnv();

  let notReady = null;
  try {
    await aiService.resolveAiCall(db, uid2);
  } catch (e) {
    notReady = e.code;
  }
  checkEqual('内置未就绪时报 AI_BUILTIN_NOT_READY', notReady, 'AI_BUILTIN_NOT_READY');
  check(
    '内置未就绪时不静默回退到用户自配',
    notReady !== 'AI_CONFIG_REQUIRED',
    '意外回退为 AI_CONFIG_REQUIRED',
  );

  // 显式切到 custom 才使用自配凭据
  setupBuiltinEnv();
  const customResolution = await aiService.resolveAiCall(db, uid2, { mode: 'custom' });
  checkEqual('显式 custom 使用用户自配配置', customResolution.mode, 'custom');
  checkEqual('custom 模式不附带内置额度', customResolution.quota, null);
  checkEqual('custom 配置带的是用户自己的模型', customResolution.aiConfig.model, 'user-model');

  // 内置模式：凭据来自环境变量
  const builtinResolution = await aiService.resolveAiCall(db, uid2, { mode: 'builtin' });
  checkEqual('内置模式标记正确', builtinResolution.mode, 'builtin');
  checkEqual('内置模式使用环境变量里的 Base URL', builtinResolution.aiConfig.baseUrl, 'https://api.example-vendor.com/v1');
  checkEqual('内置模式使用环境变量里的模型', builtinResolution.aiConfig.model, 'vendor-model-x');
  checkEqual(
    '内置明文 Key 正确传递给客户端',
    client.resolveApiKey(builtinResolution.aiConfig),
    'sk-test-builtin-key-0123456789',
  );

  // 客户端传什么都不可能自带凭据：选项里的凭据字段必须被忽略
  const spoofed = await aiService.resolveAiCall(db, uid2, {
    mode: 'builtin',
    apiKey: 'sk-attacker-supplied',
    baseUrl: 'https://attacker.example.com/v1',
    model: 'attacker-model',
    encryptedApiKey: 'x',
    keyNonce: 'y',
    keyAuthTag: 'z',
  });
  checkEqual('选项里的 apiKey 无法覆盖内置凭据', client.resolveApiKey(spoofed.aiConfig), 'sk-test-builtin-key-0123456789');
  checkEqual('选项里的 baseUrl 无法覆盖内置地址', spoofed.aiConfig.baseUrl, 'https://api.example-vendor.com/v1');

  // 非法模式
  let badMode = null;
  try {
    await aiService.resolveAiCall(db, uid2, { mode: 'free' });
  } catch (e) {
    badMode = e.code;
  }
  checkEqual('非法模式被拒绝', badMode, 'AI_MODE_INVALID');

  // custom 但未配置
  resetAiStore();
  const uid3 = seedUser('openid-c', 'user_c');
  let noConfig = null;
  try {
    await aiService.resolveAiCall(db, uid3, { mode: 'custom' });
  } catch (e) {
    noConfig = e.code;
  }
  checkEqual('custom 未配置时报 AI_CONFIG_REQUIRED', noConfig, 'AI_CONFIG_REQUIRED');

  clearBuiltinEnv();
}

/* ============================== D. 额度 ============================== */

async function runQuotaChecks() {
  section('D. 每日额度');

  resetAiStore();
  const userId = seedUser('openid-q', 'user_q');
  const now = new Date('2026-03-05T04:00:00Z'); // 北京时间 12:00

  const quota = 3;
  const results = [];
  for (let i = 0; i < quota + 1; i += 1) {
    results.push(await aiService.consumeBuiltinQuota(db, userId, quota, now));
  }

  checkEqual('前 N 次全部放行', results.slice(0, quota).every((r) => r.allowed), true);
  checkEqual('第 N 次后剩余为 0', results[quota - 1].remaining, 0);
  checkEqual('第 N+1 次被拒绝', results[quota].allowed, false);
  checkEqual('被拒绝时剩余为 0', results[quota].remaining, 0);

  checkEqual('同一天同用户只有一行计数器', store.ai_usage.filter((r) => r.userId === userId).length, 1);
  const row = store.ai_usage.filter((r) => r.userId === userId)[0];
  checkEqual('计数器主键为 userId_日期', row._id, userId + '_2026-03-05');
  checkEqual('计数器计数正确', row.count, quota);

  // 并发预约不能一起越过上限
  resetAiStore();
  const uid2 = seedUser('openid-q2', 'user_q2');
  const concurrent = await Promise.all(
    Array.from({ length: 6 }, () => aiService.consumeBuiltinQuota(db, uid2, 4, now)),
  );
  checkEqual('并发 6 次、额度 4 时恰好放行 4 次', concurrent.filter((r) => r.allowed).length, 4);
  checkEqual('并发后计数器不超过上限', store.ai_usage.filter((r) => r.userId === uid2)[0].count, 4);

  // 跨自然日重置（北京时间 00:00 为界）
  resetAiStore();
  const uid3 = seedUser('openid-q3', 'user_q3');
  const day1Late = new Date('2026-03-05T15:59:59Z'); // 北京 23:59:59
  const day2Early = new Date('2026-03-05T16:00:00Z'); // 北京 次日 00:00:00

  const d1 = await aiService.consumeBuiltinQuota(db, uid3, 1, day1Late);
  const d1Again = await aiService.consumeBuiltinQuota(db, uid3, 1, day1Late);
  const d2 = await aiService.consumeBuiltinQuota(db, uid3, 1, day2Early);

  checkEqual('北京时间当天首次放行', d1.allowed, true);
  checkEqual('北京时间当天用满后拒绝', d1Again.allowed, false);
  checkEqual('跨到北京时间次日额度重置', d2.allowed, true);
  checkEqual('跨日后计数器分成两行', store.ai_usage.filter((r) => r.userId === uid3).length, 2);

  // custom 模式不消耗内置额度
  resetAiStore();
  const uid4 = seedUser('openid-q4', 'user_q4');
  seedCustomConfig(uid4);
  await aiService.resolveAiCall(db, uid4, { mode: 'custom' });
  checkEqual('custom 模式不写额度计数器', store.ai_usage.length, 0);

  // 额度耗尽后 resolveAiCall 报统一错误码
  resetAiStore();
  const uid5 = seedUser('openid-q5', 'user_q5');
  setupBuiltinEnv({ AI_BUILTIN_DAILY_QUOTA: '1' });
  await aiService.resolveAiCall(db, uid5);
  let exceeded = null;
  try {
    await aiService.resolveAiCall(db, uid5);
  } catch (e) {
    exceeded = e.code;
  }
  checkEqual('额度用尽后报 AI_QUOTA_EXCEEDED', exceeded, 'AI_QUOTA_EXCEEDED');

  // 即使显式指定内置模式，额度照样生效（无法绕过）
  let bypassAttempt = null;
  try {
    await aiService.resolveAiCall(db, uid5, { mode: 'builtin' });
  } catch (e) {
    bypassAttempt = e.code;
  }
  checkEqual('显式指定内置模式也无法绕过额度', bypassAttempt, 'AI_QUOTA_EXCEEDED');

  clearBuiltinEnv();
}

/* ============================== E. 用量日志 ============================== */

async function runUsageLogChecks() {
  section('E. 用量日志与脱敏');

  resetAiStore();
  const userId = seedUser('openid-l', 'user_l');
  setupBuiltinEnv();

  const okResult = await aiService.runAiCall(
    db,
    userId,
    { action: 'recommendMenus', requestId: 'req-1' },
    async () => 'model-output',
  );
  checkEqual('runAiCall 透传回调返回值', okResult, 'model-output');
  checkEqual('成功调用写入一条 ai_logs', store.ai_logs.length, 1);

  let successLog = store.ai_logs[0];
  checkEqual('日志状态为 success', successLog.status, 'success');
  checkEqual('日志记录模式', successLog.mode, 'builtin');
  checkEqual('日志记录功能名', successLog.action, 'recommendMenus');
  checkEqual('日志记录 requestId', successLog.requestId, 'req-1');
  checkEqual('日志记录用户', successLog.userId, userId);
  check('日志记录耗时', typeof successLog.duration === 'number');
  check(
    '日志记录额度剩余',
    successLog.quotaRemaining === aiService.DEFAULT_BUILTIN_DAILY_QUOTA - 1,
    String(successLog.quotaRemaining),
  );

  // 失败调用也要留痕
  let thrown = null;
  try {
    await aiService.runAiCall(
      db,
      userId,
      { action: 'replaceMenuItem', requestId: 'req-2' },
      async () => {
        throw Object.assign(new Error('模型认证失败'), { code: 'AI_AUTH_FAILED' });
      },
    );
  } catch (e) {
    thrown = e;
  }
  checkEqual('runAiCall 向上抛出回调错误', thrown && thrown.code, 'AI_AUTH_FAILED');
  checkEqual('失败调用同样写入 ai_logs', store.ai_logs.length, 2);

  const failLog = store.ai_logs[1];
  checkEqual('失败日志状态为 fail', failLog.status, 'fail');
  checkEqual('失败日志记录错误码', failLog.code, 'AI_AUTH_FAILED');

  // 日志绝不能出现明文 Key
  const logsJson = JSON.stringify(store.ai_logs);
  check('ai_logs 不含明文 Key', logsJson.indexOf('sk-test-builtin-key') === -1);
  check('ai_logs 不含环境变量名', logsJson.indexOf('AI_BUILTIN_API_KEY') === -1);

  // redact 对敏感字段打码
  const redacted = aiService.redact({
    apiKey: 'sk-leak',
    Authorization: 'Bearer leak',
    mode: 'builtin',
  });
  checkEqual('apiKey 被打码', redacted.apiKey, '***');
  checkEqual('Authorization 被打码', redacted.Authorization, '***');
  checkEqual('非敏感字段保留', redacted.mode, 'builtin');

  // 日志集合缺失不影响 AI 调用本身
  resetAiStore();
  const uid2 = seedUser('openid-l2', 'user_l2');
  mock.setMissingCollections(['ai_logs']);
  let loggedAnyway = null;
  try {
    loggedAnyway = await aiService.runAiCall(db, uid2, { action: 'x' }, async () => 'ok');
  } catch (e) {
    loggedAnyway = 'threw:' + e.code;
  }
  checkEqual('ai_logs 缺失时调用仍成功', loggedAnyway, 'ok');
  mock.setMissingCollections([]);

  clearBuiltinEnv();
}

/* ============================== F. 错误码文案 ============================== */

function runErrorCodeChecks() {
  section('F. 错误码与前端文案');

  ['AI_BUILTIN_NOT_READY', 'AI_QUOTA_EXCEEDED', 'AI_CONFIG_REQUIRED', 'AI_MODE_INVALID'].forEach((code) => {
    const message = aiService.friendlyAiMessage(code);
    check(code + ' 有可操作的中文文案', typeof message === 'string' && message.length > 0);
  });

  check(
    '内置未就绪文案不引导用户自配 API',
    aiService.friendlyAiMessage('AI_BUILTIN_NOT_READY').indexOf('模型 API 设置') === -1,
  );
  check(
    '额度用尽文案说明可次日再试',
    aiService.friendlyAiMessage('AI_QUOTA_EXCEEDED').indexOf('明天') !== -1,
  );
  checkEqual('未知错误码不返回文案（避免误映射）', aiService.friendlyAiMessage('AI_AUTH_FAILED'), '');
  checkEqual('空错误码返回空串', aiService.friendlyAiMessage(undefined), '');
}

/* ============================== 入口 ============================== */

(async function main() {
  console.log('Phase C 统一 AI 服务 · 验证开始');

  runStructureChecks();
  runBuiltinChecks();
  await runRoutingChecks();
  await runQuotaChecks();
  await runUsageLogChecks();
  runErrorCodeChecks();

  console.log('\n========================================');
  console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项');
  if (failures.length === 0) {
    console.log('全部通过');
  } else {
    console.log('失败清单：');
    failures.forEach((item) => console.log('  - ' + item));
    process.exitCode = 1;
  }
})();
