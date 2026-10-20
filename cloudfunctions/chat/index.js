/**
 * chat 云函数 · AI 做饭机器人（阶段0-功能B）
 *
 * 职责：
 *   chat —— 与用户进行做饭与家庭饮食相关的文字对话
 *
 * 安全：
 *   1. 身份只来自 cloud.getWXContext().OPENID；
 *   2. 必须经 requireFamilyMember 复核家庭归属；
 *   3. 通过 ai-service 的统一入口 runAiCall 调用模型；
 *   4. 额度校验、限流与用量统计全部由 ai-service 负责；
 *   5. 不在前端暴露 API Key，不在日志记录凭据；
 *   6. 话题限制通过系统提示词 + 服务端轻量规则双重约束。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const aiService = require('./ai-service');
const { chatCompletion } = require('./openai-compatible-client');

/* ============================== 统一响应 ============================== */

function ok(data) {
  return { success: true, data: data, error: null };
}

function fail(code, message) {
  return {
    success: false,
    data: null,
    code: code,
    message: message,
    error: { code: code, message: message },
  };
}

/* ============================== 基础工具 ============================== */

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

/* ============================== 话题限制 ============================== */

/** 做饭机器人系统提示词 */
const COOKING_SYSTEM_PROMPT = `你是一个温暖可爱的 AI 做饭小助手，名字叫"饭团"。你的任务是帮助用户解决做饭和家庭饮食相关的问题。

你的职责范围：
- 菜谱做法、烹饪步骤、火候和调味指导
- 食材搭配建议、替代方案
- 家庭菜单规划和每日吃什么建议
- 根据现有食材推荐菜品
- 常见食材的储存方法、保质期
- 食品安全与基本烹饪安全（对紧急问题优先给出安全建议）
- 基础营养知识
- 当前小程序的功能使用说明

回答规则：
- 用温暖、亲切、自然的口吻回复，适当使用"呀"、"哦"、"呢"等语气词
- 优先给出可执行的步骤，而不是长篇背景解释
- 对不确定的食材用量和时间，明确说"可以根据实际情况调整"
- 涉及食品安全时优先给出谨慎、清晰的安全建议
- 不假装知道用户的库存（如果说"如果你家里有..."）
- 不输出危险或可能导致中毒的建议
- 回答简洁，不在一条消息里塞太多内容

话题限制：
- 如果用户问的是与做饭、饮食、食材完全无关的话题（如编程、汽车、金融），友好地引导回到做饭场景
- 引导语示例："我是做饭小助手哦～如果想知道今天吃什么、怎么做菜，都可以问我！"`;

/** 轻量级话题检查：识别明显无关的请求 */
function isUnrelatedTopic(message) {
  const text = (message || '').trim().toLowerCase();
  if (text.length > 2000) return true; // 超长文本

  // 明显的无关关键词（中英文混合）
  const unrelatedPatterns = [
    /写.*(文章|论文|代码|程序|小说|诗|作文)/,
    /(编程|代码|bug|api|restful|react|vue|python|java|docker|git)/,
    /(股票|基金|理财|投资|比特币|区块链|crypto)/,
    /(汽车|买房|租房|装修|保险|贷款)/,
    /(翻译|translate).*(?!食材|菜单|菜谱)/,
    /(考试|作业|答题|题目)/,
    /(政治|选举|投票|政党)/,
  ];

  for (const pat of unrelatedPatterns) {
    if (pat.test(text)) return true;
  }

  return false;
}

/** 无关话题的友好拒绝回复 */
function getRedirectReply() {
  const replies = [
    '我主要负责做饭和家庭饮食问题哦！如果你告诉我家里有什么食材，我可以帮你搭配一道好吃的菜～',
    '这个我不太擅长呢～不如问我今天吃什么好？或者有什么菜不会做？',
    '我是做饭小助手哦～如果想知道青椒肉丝怎么做、西红柿能和什么一起炒，都可以问我！',
  ];
  return replies[Math.floor(Math.random() * replies.length)];
}

/* ============================== 聊天 ============================== */

async function handleChat(event, wxContext) {
  const openid = wxContext.OPENID || '';
  const familyId = event.familyId || '';
  const message = (event.message || '').trim();

  if (!openid) return fail('AUTH_REQUIRED', '请先登录');
  if (!message) return fail('INVALID_PARAMS', '请输入你的问题');

  // 消息长度限制（防止滥用）
  if (message.length > 600) {
    return fail('MESSAGE_TOO_LONG', '问题太长了，请控制在 600 字以内');
  }

  // 身份校验
  const { user, member, error } = await requireFamilyMember(openid, familyId);
  if (error) return error;

  // 话题预检：明显无关的直接拒绝，不浪费额度
  if (isUnrelatedTopic(message)) {
    return ok({ reply: getRedirectReply(), topicFiltered: true });
  }

  try {
    // chatCompletion 返回模型正文文本；凭据、额度、日志由 runAiCall 统一处理
    const reply = await aiService.runAiCall(db, user._id, {
      action: 'chat',
      familyId: familyId,
      messageLength: message.length,
    }, async (aiConfig) => chatCompletion(
      aiConfig,
      [
        { role: 'system', content: COOKING_SYSTEM_PROMPT },
        { role: 'user', content: message },
      ],
      {
        temperature: 0.7,
        max_tokens: 800, // 限制回复长度
        timeoutMs: 20000,
      },
    ));

    const text = typeof reply === 'string' ? reply.trim() : '';
    if (!text) {
      return fail('AI_EMPTY_RESPONSE', 'AI 没有给出回复，请换个方式问问看');
    }

    return ok({ reply: text, topicFiltered: false });
  } catch (error) {
    // 根据错误码返回合适的提示
    const code = (error && error.code) || 'AI_CALL_FAILED';
    const msg = (error && error.message) || '';

    if (code === 'AI_QUOTA_EXCEEDED') {
      return fail(code, '今天的 AI 使用次数已用完，可以明天再来，或检查 AI 设置');
    }
    if (code === 'AI_CONFIG_REQUIRED') {
      return fail(code, '请在「模型 API 设置」中配置 AI 服务');
    }
    if (code === 'AI_BUILTIN_NOT_READY') {
      return fail(code, 'AI 服务暂时不可用，请稍后再试');
    }

    return fail(code, msg || 'AI 回复失败，请稍后重试');
  }
}

/* ============================== 入口 ============================== */

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const action = String(event.action || '');

  // 禁用写操作
  const WRITE_ACTIONS = [
    'create', 'update', 'delete', 'save', 'remove',
    'add', 'edit', 'set', 'modify', 'write', 'insert',
    'upsert', 'replace', 'patch', 'seed',
  ];
  if (WRITE_ACTIONS.includes(action)) {
    return fail('UNKNOWN_ACTION', '未知的 action：' + action);
  }

  switch (action) {
    case 'chat':
      return handleChat(event, wxContext);
    default:
      return fail('UNKNOWN_ACTION', '未知的 action：' + action);
  }
};