/**
 * chat 云函数验证
 *
 * 用 stub 替换 wx-server-sdk 与 openai-compatible-client，直接跑 exports.main，
 * 覆盖：正常对话、话题过滤、参数校验、家庭成员校验、AI 错误映射、空回复。
 *
 * 重点回归：chat/index.js 曾经调用不存在的 aiService.chatCompletion，
 * 导致线上表现为「云函数 chat 暂时不可用」。
 */
'use strict';

const path = require('path');
const Module = require('module');

/* ============================== 断言 ============================== */

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error('✗ ' + name + (detail ? ' — ' + detail : ''));
  }
}

function checkEqual(name, actual, expected) {
  check(name, actual === expected, '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
}

/* ============================== stub 状态 ============================== */

const state = {
  openid: 'o1',
  isMember: true,
  aiCalls: [],
  aiBehavior: null, // null | 'throw_quota' | 'empty'
  usageAdds: 0,
};

const adds = [];

/* ============================== 云开发 SDK stub ============================== */

function queryData(name, filter) {
  if (name === 'users') {
    return state.openid ? [{ _id: 'u1', openid: state.openid }] : [];
  }
  if (name === 'family_members') {
    return state.isMember ? [{ _id: 'm1', familyId: filter.familyId, userId: 'u1' }] : [];
  }
  return [];
}

function makeCollection(name) {
  const col = {
    _filter: {},
    where(filter) { col._filter = filter || {}; return col; },
    limit() { return col; },
    skip() { return col; },
    orderBy() { return col; },
    field() { return col; },
    async get() { return { data: queryData(name, col._filter) }; },
    async add(payload) {
      adds.push({ name: name, data: payload && payload.data });
      if (name === 'ai_usage') state.usageAdds++;
      return { _id: 'gen_' + adds.length };
    },
    async update() { return { stats: { updated: 1 } }; },
    async count() { return { total: 0 }; },
    doc() {
      return {
        async get() { return { data: {} }; },
        async update() { return { stats: { updated: 1 } }; },
        async set() { return {}; },
      };
    },
  };
  return col;
}

const cloudStub = {
  DYNAMIC_CURRENT_ENV: 'stub-env',
  init() {},
  getWXContext() { return { OPENID: state.openid }; },
  database() {
    return {
      collection: makeCollection,
      command: { lt: (v) => ({ $lt: v }), inc: (v) => ({ $inc: v }) },
    };
  },
};

/* ============================== AI 客户端 stub ============================== */

const clientStub = {
  validateAndBuildUrl(url) {
    const u = new URL(url);
    if (u.protocol !== 'https:') throw new Error('仅支持 HTTPS');
    return u;
  },
  async readFullAiConfig() { return null; },
  async chatCompletion(aiConfig, messages, options) {
    state.aiCalls.push({ aiConfig: aiConfig, messages: messages, options: options });
    if (state.aiBehavior === 'throw_quota') {
      throw Object.assign(new Error('quota'), { code: 'AI_QUOTA_EXCEEDED' });
    }
    if (state.aiBehavior === 'empty') return '';
    return '先把鸡蛋炒散盛出，再炒西红柿，最后合炒就好啦～';
  },
};

const clientPath = path.resolve(__dirname, '../cloudfunctions/chat/openai-compatible-client.js');

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') return cloudStub;
  if (request === './openai-compatible-client' && parent && parent.filename &&
      parent.filename.indexOf(path.join('cloudfunctions', 'chat')) !== -1) {
    return clientStub;
  }
  if (parent && parent.filename && path.resolve(parent.filename) === clientPath) {
    return clientStub;
  }
  return originalLoad.apply(this, arguments);
};

/* ============================== 准备环境 ============================== */

process.env.AI_BUILTIN_ENABLED = 'true';
process.env.AI_BUILTIN_BASE_URL = 'https://api.example.com/v1';
process.env.AI_BUILTIN_MODEL = 'test-model';
process.env.AI_BUILTIN_API_KEY = 'test-key';
process.env.AI_BUILTIN_DAILY_QUOTA = '50';

const chatFn = require('../cloudfunctions/chat/index.js');

function reset() {
  state.isMember = true;
  state.aiCalls = [];
  state.aiBehavior = null;
  state.usageAdds = 0;
}

function chat(message, familyId) {
  return chatFn.main({ action: 'chat', message: message, familyId: familyId }, {});
}

/* ============================== 用例 ============================== */

(async function run() {
  /* 1. 正常对话：必须真正走到 chatCompletion，且签名正确 */
  reset();
  let res = await chat('西红柿炒蛋怎么做', 'f1');
  checkEqual('正常对话 success', res.success, true);
  checkEqual('正常对话返回模型正文', res.data && res.data.reply,
    '先把鸡蛋炒散盛出，再炒西红柿，最后合炒就好啦～');
  checkEqual('正常对话未触发话题过滤', res.data && res.data.topicFiltered, false);
  checkEqual('chatCompletion 只调用一次', state.aiCalls.length, 1);
  if (state.aiCalls.length === 1) {
    const call = state.aiCalls[0];
    check('chatCompletion 第 1 个参数是 aiConfig', !!call.aiConfig && call.aiConfig.model === 'test-model');
    check('chatCompletion 第 2 个参数是 messages 数组', Array.isArray(call.messages) && call.messages.length === 2);
    checkEqual('messages[0] 是系统提示词', call.messages[0].role, 'system');
    checkEqual('messages[1] 是用户问题', call.messages[1].content, '西红柿炒蛋怎么做');
    checkEqual('options 用 timeoutMs 而不是 timeout', call.options.timeoutMs, 20000);
    checkEqual('max_tokens 使用下划线写法', call.options.max_tokens, 800);
    checkEqual('不再传多余的 timeout 字段', call.options.timeout, undefined);
  }

  /* 2. 无关话题：不消耗额度 */
  reset();
  res = await chat('帮我写一段 Python 代码', 'f1');
  checkEqual('无关话题 success', res.success, true);
  checkEqual('无关话题被过滤', res.data && res.data.topicFiltered, true);
  checkEqual('无关话题不调用模型', state.aiCalls.length, 0);
  check('无关话题给出引导语', !!(res.data && res.data.reply && res.data.reply.length > 0));

  /* 3. 参数校验 */
  reset();
  res = await chat('', 'f1');
  checkEqual('空消息 success=false', res.success, false);
  checkEqual('空消息错误码', res.code, 'INVALID_PARAMS');

  reset();
  res = await chat(new Array(602).join('啊'), 'f1');
  checkEqual('超长消息错误码', res.code, 'MESSAGE_TOO_LONG');

  reset();
  res = await chat('今天吃什么', '');
  checkEqual('缺 familyId 错误码', res.code, 'INVALID_PARAMS');

  /* 4. 非家庭成员 */
  reset();
  state.isMember = false;
  res = await chat('今天吃什么', 'f1');
  checkEqual('非成员 success=false', res.success, false);
  checkEqual('非成员错误码', res.code, 'NOT_IN_FAMILY');
  checkEqual('非成员不调用模型', state.aiCalls.length, 0);

  /* 5. 未登录 */
  reset();
  state.openid = '';
  res = await chat('今天吃什么', 'f1');
  checkEqual('未登录错误码', res.code, 'AUTH_REQUIRED');
  state.openid = 'o1';

  /* 6. AI 额度耗尽：映射成中文提示，不泄漏内部信息 */
  reset();
  state.aiBehavior = 'throw_quota';
  res = await chat('今天吃什么', 'f1');
  checkEqual('额度耗尽 success=false', res.success, false);
  checkEqual('额度耗尽错误码', res.code, 'AI_QUOTA_EXCEEDED');
  checkEqual('额度耗尽文案', res.message, '今天的 AI 使用次数已用完，可以明天再来，或检查 AI 设置');

  /* 7. 空回复 */
  reset();
  state.aiBehavior = 'empty';
  res = await chat('今天吃什么', 'f1');
  checkEqual('空回复 success=false', res.success, false);
  checkEqual('空回复错误码', res.code, 'AI_EMPTY_RESPONSE');

  /* 8. 未知 action 与写操作拦截 */
  reset();
  res = await chatFn.main({ action: 'deleteAll', familyId: 'f1' }, {});
  checkEqual('写操作被拦截', res.code, 'UNKNOWN_ACTION');
  res = await chatFn.main({ action: 'nope', familyId: 'f1' }, {});
  checkEqual('未知 action', res.code, 'UNKNOWN_ACTION');

  /* 9. 静态回归：不得再引用 aiService 上不存在的导出 */
  const fs = require('fs');
  const src = fs.readFileSync(path.resolve(__dirname, '../cloudfunctions/chat/index.js'), 'utf8');
  check('不再调用 aiService.chatCompletion', src.indexOf('aiService.chatCompletion') === -1);
  check('不再调用 aiService.extractAssistantContent', src.indexOf('extractAssistantContent') === -1);
  check('从 openai-compatible-client 引入 chatCompletion',
    /require\(['"]\.\/openai-compatible-client['"]\)/.test(src));

  Module._load = originalLoad;

  console.log('\nchat 云函数验证：' + passed + ' 通过，' + failed + ' 失败');
  if (failed > 0) process.exit(1);
})().catch((e) => {
  console.error('验证脚本异常：', e);
  process.exit(1);
});
