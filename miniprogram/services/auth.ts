/**
 * 登录与用户服务
 *
 * 约束：
 *   - 页面不得直接调用 wx.cloud.callFunction，云函数调用统一经过本 service；
 *   - 前端不保存、不传播 openid，业务统一使用 user._id（= users._id）；
 *   - login 必须幂等，且并发调用只发一次请求；
 *   - 身份由云函数侧根据微信调用上下文确认，前端不提交任何身份字段。
 */
import { CLOUD_ERROR_CODES, CURRENT_ENV, DEFAULT_NICKNAME } from '../constants/config';
import type { AuthUser } from '../types/user';
import { AppError, callFunction, getErrorCode } from '../utils/cloud';
import { storage } from '../utils/storage';

interface AuthUserPayload {
  user: AuthUser;
}

/**
 * 并发登录保护。
 * App 启动与页面 onShow 若同时触发 login，复用同一个 Promise，
 * 避免产生多个登录请求进而创建重复用户。
 */
let loginPromise: Promise<AuthUser> | null = null;

/** 校验并归一化服务端返回的用户，缺字段时给出可展示的错误而不是白屏 */
function normalizeUser(payload: AuthUserPayload | null | undefined): AuthUser {
  const user = payload?.user;
  if (!user || typeof user._id !== 'string' || user._id === '') {
    throw new AppError('INVALID_RESPONSE', '登录返回数据异常，请稍后重试');
  }

  return {
    _id: user._id,
    nickname: user.nickname || DEFAULT_NICKNAME,
    avatarUrl: user.avatarUrl || '',
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

async function requestLogin(): Promise<AuthUser> {
  const payload = await callFunction<AuthUserPayload>('auth', 'login');
  const user = normalizeUser(payload);
  storage.setCurrentUser(user);

  if (CURRENT_ENV === 'dev') {
    // 开发期用于对照云函数日志；生产环境不输出
    console.info('[auth] login success', { userId: user._id });
  }

  return user;
}

export const authService = {
  /**
   * 微信登录：云函数依据微信调用上下文识别身份，并确保 users 记录存在。
   * 幂等——重复调用始终对应同一个用户。
   */
  login(): Promise<AuthUser> {
    if (loginPromise) {
      return loginPromise;
    }

    loginPromise = requestLogin().finally(() => {
      loginPromise = null;
    });

    return loginPromise;
  },

  /**
   * 查询服务端当前用户。
   * 服务端返回 USER_NOT_FOUND 时归一化为 null（不自动创建用户）。
   */
  async getCurrentUser(): Promise<AuthUser | null> {
    try {
      const payload = await callFunction<AuthUserPayload>('auth', 'getCurrentUser');
      const user = normalizeUser(payload);
      storage.setCurrentUser(user);
      return user;
    } catch (error) {
      if (getErrorCode(error) === CLOUD_ERROR_CODES.USER_NOT_FOUND) {
        return null;
      }
      throw error;
    }
  },

  /**
   * 更新当前用户资料（昵称 / 头像）。
   * 至少要提供 nickname 或 avatarUrl 之一。成功后同步到本地缓存。
   */
  async updateProfile(input: { nickname?: string; avatarUrl?: string }): Promise<AuthUser> {
    const payload = await callFunction<AuthUserPayload>('auth', 'updateProfile', {
      nickname: input.nickname || '',
      avatarUrl: input.avatarUrl || '',
    });
    const user = normalizeUser(payload);
    storage.setCurrentUser(user);
    return user;
  },

  /**
   * 启动时的会话恢复。
   *   - 无本地缓存 → 直接 login（首次登录，服务端会创建用户）；
   *   - 有本地缓存 → 先由调用方用缓存恢复 UI，再向服务端校验；
   *   - 服务端已无该用户 → 清理本地缓存并重新 login；
   *   - 云服务/网络异常 → 抛出，由调用方保留本地缓存并展示网络异常，不清空登录数据。
   */
  async restoreSession(): Promise<AuthUser | null> {
    const cached = storage.getCurrentUser();

    if (cached) {
      const fresh = await authService.getCurrentUser();
      if (fresh) {
        return fresh;
      }
      // 服务端已不存在该用户，清掉缓存后按首次登录处理
      storage.clearCurrentUser();
    }

    return authService.login();
  },

  /** 同步读取本地缓存的当前用户（仅用于启动时先恢复 UI） */
  getCachedUser(): AuthUser | null {
    return storage.getCurrentUser();
  },

  clearSession(): void {
    storage.clearCurrentUser();
  },

  isLoggedIn(): boolean {
    try {
      const app = getApp<IAppOption>();
      if (app && app.globalData) {
        return app.globalData.isLoggedIn;
      }
    } catch {
      // App 尚未初始化完成，退回本地缓存判断
    }
    return storage.getCurrentUser() !== null;
  },
};
