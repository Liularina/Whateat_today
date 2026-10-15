/**
 * auth 云函数 · 登录与当前用户
 *
 * 职责（Phase 2）：
 *   login / getCurrentUser
 *
 * 安全约束：
 *   1. 身份只来自微信云开发调用上下文（cloud.getWXContext().OPENID），
 *      绝不读取、也绝不信任客户端传入的 openid 等身份字段；
 *   2. users 文档中的 openid 只存在于服务端，返回给前端的 DTO 不含 openid；
 *   3. 前端业务统一使用 users._id 作为用户业务 ID；
 *   4. ping 用于部署后自检。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const usersCol = db.collection('users');

/** 云数据库「集合不存在」错误码 */
const ERR_COLLECTION_NOT_EXIST = -502005;

const DEFAULT_NICKNAME = '微信用户';

const DB_NOT_READY_MESSAGE = '数据库集合 users 不存在，请先在云开发控制台创建';

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

/* ------------------------------ 工具 ------------------------------ */

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

/** 服务端用户文档 → 前端 DTO：刻意不包含 openid */
function toAuthUser(user) {
  return {
    _id: user._id,
    nickname: user.nickname || DEFAULT_NICKNAME,
    avatarUrl: user.avatarUrl || '',
    createdAt: toIsoString(user.createdAt),
    updatedAt: toIsoString(user.updatedAt),
  };
}

/**
 * 按 openid 查询用户。
 *
 * 固定按 createdAt 升序取第一条：即使历史数据里存在重复记录，
 * 业务上也始终只使用同一个用户，不会重复创建。
 * 建议在云开发控制台为 users.openid 建立唯一索引，从根上杜绝重复。
 */
async function findUserByOpenid(openid) {
  const res = await usersCol.where({ openid: openid }).orderBy('createdAt', 'asc').limit(1).get();
  return (res.data && res.data[0]) || null;
}

/* ------------------------------ 业务实现 ------------------------------ */

/**
 * 微信登录：按当前微信身份查询或创建 users 文档。
 * 幂等——同一微信用户连续登录始终返回同一个用户，不会重复创建。
 */
async function handleLogin(event, wxContext, requestId) {
  const openid = wxContext.OPENID;

  // 注意：这里刻意不读取 event.openid
  if (!openid) {
    return fail('AUTH_REQUIRED', '无法获取微信用户身份，请重新进入小程序');
  }

  const now = new Date();
  let user = await findUserByOpenid(openid);

  if (!user) {
    /* 首次登录：创建用户，昵称头像使用默认值（资料完善留到后续阶段） */
    try {
      const added = await usersCol.add({
        data: {
          openid: openid,
          nickname: DEFAULT_NICKNAME,
          avatarUrl: '',
          createdAt: now,
          updatedAt: now,
        },
      });
      const created = await usersCol.doc(added._id).get();
      user = created.data;
    } catch (error) {
      if (isCollectionMissing(error)) {
        return fail('DB_NOT_READY', DB_NOT_READY_MESSAGE);
      }
      // 极端并发下可能已被另一次请求创建，回查一次，避免产生重复用户
      console.error('[auth] 创建用户失败 requestId=' + requestId, error);
      user = await findUserByOpenid(openid);
      if (!user) {
        return fail('USER_CREATE_FAILED', '创建用户失败，请稍后重试');
      }
    }
  } else {
    /* 再次登录：只刷新 updatedAt，不覆盖已有昵称/头像 */
    try {
      await usersCol.doc(user._id).update({ data: { updatedAt: now } });
      user.updatedAt = now;
    } catch (error) {
      if (isCollectionMissing(error)) {
        return fail('DB_NOT_READY', DB_NOT_READY_MESSAGE);
      }
      console.error('[auth] 更新用户失败 requestId=' + requestId, error);
      return fail('USER_UPDATE_FAILED', '更新用户失败，请稍后重试');
    }
  }

  if (!user || !user._id) {
    return fail('USER_CREATE_FAILED', '创建用户失败，请稍后重试');
  }

  return ok({ user: toAuthUser(user) });
}

/**
 * 查询当前用户。
 * 与 login 职责区分：这里只查询，绝不自动创建。
 */
async function handleGetCurrentUser(event, wxContext) {
  const openid = wxContext.OPENID;

  if (!openid) {
    return fail('AUTH_REQUIRED', '无法获取微信用户身份，请重新进入小程序');
  }

  const user = await findUserByOpenid(openid);

  if (!user) {
    return fail('USER_NOT_FOUND', '用户不存在，请先登录');
  }

  return ok({ user: toAuthUser(user) });
}

/**
 * 更新当前用户资料（昵称 / 头像）。
 * 前端提交 nickname 和 avatarUrl，至少一项非空时才更新。
 * 头像使用微信 button open-type="chooseAvatar" 获取的临时路径上传到云存储。
 */
async function handleUpdateProfile(event, wxContext) {
  const openid = wxContext.OPENID;
  if (!openid) {
    return fail('AUTH_REQUIRED', '无法获取微信用户身份，请重新进入小程序');
  }

  const nickname = typeof event.nickname === 'string' ? event.nickname.trim() : '';
  const avatarUrl = typeof event.avatarUrl === 'string' ? event.avatarUrl.trim() : '';
  if (!nickname && !avatarUrl) {
    return fail('INVALID_PARAMS', '昵称和头像至少提供一个');
  }

  const user = await findUserByOpenid(openid);
  if (!user) {
    return fail('USER_NOT_FOUND', '用户不存在，请先登录');
  }

  const updateData = { updatedAt: new Date() };
  if (nickname) {
    if (nickname.length < 1 || nickname.length > 20) {
      return fail('INVALID_PARAMS', '昵称长度为 1-20 个字符');
    }
    updateData.nickname = nickname;
  }
  if (avatarUrl) {
    // 接受两种格式：https://（公网）和 cloud://（微信云存储文件 ID）
    if (!/^(https?|cloud):\/\//.test(avatarUrl)) {
      return fail('INVALID_PARAMS', '头像地址格式不正确');
    }
    updateData.avatarUrl = avatarUrl;
  }

  try {
    await usersCol.doc(user._id).update({ data: updateData });
  } catch (error) {
    if (isCollectionMissing(error)) {
      return fail('DB_NOT_READY', DB_NOT_READY_MESSAGE);
    }
    console.error('[auth] 更新用户资料失败', error);
    return fail('USER_UPDATE_FAILED', '更新用户资料失败，请稍后重试');
  }

  return ok({ user: toAuthUser({ ...user, ...updateData }) });
}

/* ------------------------------ 业务路由 ------------------------------ */

const handlers = {
  /** 健康检查：部署后可用来验证云函数是否可用 */
  ping() {
    return ok({ function: 'auth', status: 'ok', time: Date.now() });
  },

  login: handleLogin,

  getCurrentUser: handleGetCurrentUser,

  updateProfile: handleUpdateProfile,
};

/* ------------------------------ 入口 ------------------------------ */

exports.main = async (event = {}) => {
  const startedAt = Date.now();
  const wxContext = cloud.getWXContext();
  const action = event.action || '';
  const requestId = event.requestId || (Date.now() + '-' + Math.random().toString(36).slice(2, 8));

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
      console.error('[auth] 数据库集合缺失', error);
      response = fail('DB_NOT_READY', DB_NOT_READY_MESSAGE);
    } else {
      console.error('[auth] 未捕获异常', error);
      response = fail('INTERNAL_ERROR', '服务内部异常，请稍后重试');
    }
  }

  response.requestId = requestId;

  // 统一日志：functionName / requestId / openid / action / duration / status / error
  console.log(
    JSON.stringify({
      functionName: 'auth',
      requestId: requestId,
      openid: wxContext.OPENID || '',
      action: action,
      duration: Date.now() - startedAt,
      status: response.success ? 'success' : 'fail',
      code: response.code || '',
      error: response.success ? '' : response.message,
    }),
  );

  return response;
};
