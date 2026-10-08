/**
 * menu 云函数 · 菜单查询
 *
 * 职责（第一阶段）：
 *   getTodayMenu / getMenu / getMenuHistory
 *
 * 说明：
 *   1. 所有需要 familyId 的操作都必须经 requireFamilyMember 校验；
 *   2. LLM API Key 只存在于本云函数的环境变量中，绝不下发到小程序前端；
 *   3. AI 返回的营养值一律不作为最终值，必须由 nutrition 服务重算。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

/* ------------------------------ 统一响应 ------------------------------ */

function ok(data) {
  return { success: true, data: data === undefined ? null : data };
}

function fail(code, message, details) {
  return { success: false, data: null, code: code, message: message, details: details || null };
}

/**
 * 家庭身份校验：绝不直接信任前端传来的 familyId。
 * openid → users → family_members，确认用户确实属于该家庭后才允许继续。
 */
async function requireFamilyMember(openid, familyId) {
  if (!familyId) {
    return { error: fail('INVALID_PARAMS', '缺少 familyId') };
  }

  const userResult = await db.collection('users').where({ openid }).limit(1).get();
  const user = userResult.data[0];
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
    // 不泄露家庭是否存在
    return { error: fail('NOT_IN_FAMILY', '你不是该家庭的成员') };
  }

  return { user, member };
}

/** 仅家庭管理员可执行 */
function requireOwner(member) {
  if (!member || member.role !== 'owner') {
    return fail('FORBIDDEN', '只有家庭管理员可以执行该操作');
  }
  return null;
}

/* ------------------------------ 业务路由 ------------------------------ */

const handlers = {
  /** 健康检查：部署后可用来验证云函数是否可用 */
  ping() {
    return ok({ function: 'menu', status: 'ok', time: Date.now() });
  },

  /**
   * 今日菜单
   * TODO: 按开发阶段实现，服务端必须做权限校验与入参校验
   */
  getTodayMenu() {
    return fail('NOT_IMPLEMENTED', 'menu.getTodayMenu 尚未实现');
  },

  /**
   * 菜单详情
   * TODO: 按开发阶段实现，服务端必须做权限校验与入参校验
   */
  getMenu() {
    return fail('NOT_IMPLEMENTED', 'menu.getMenu 尚未实现');
  },

  /**
   * 历史菜单
   * TODO: 按开发阶段实现，服务端必须做权限校验与入参校验
   */
  getMenuHistory() {
    return fail('NOT_IMPLEMENTED', 'menu.getMenuHistory 尚未实现');
  },
};

/* ------------------------------ 入口 ------------------------------ */

exports.main = async (event = {}) => {
  const startedAt = Date.now();
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID || '';
  const action = event.action || '';
  const requestId = event.requestId || (Date.now() + '-' + Math.random().toString(36).slice(2, 8));

  let response;
  try {
    const handler = Object.prototype.hasOwnProperty.call(handlers, action) ? handlers[action] : null;
    if (!handler) {
      response = fail('UNKNOWN_ACTION', '未知操作：' + action);
    } else {
      response = await handler(event, wxContext);
    }
  } catch (error) {
    console.error('[' + 'menu' + '] 未捕获异常', error);
    response = fail('INTERNAL_ERROR', '服务内部异常，请稍后重试');
  }

  // 统一日志：functionName / requestId / userId / familyId / duration / status / error
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
      error: response.success ? '' : response.message,
    }),
  );

  return response;
};
