/**
 * 本地缓存封装
 *
 * 约束（见开发规范第 97 条）：
 * 本地只缓存「当前用户」与「当前家庭 ID」这类必要标识，
 * 绝不缓存 openid、完整 users 文档、家庭业务数据或 AI 数据；
 * 权威数据每次通过云函数查询获得。
 */
import type { AuthUser } from '../types/user';

/** 当前登录用户缓存 key */
const KEY_CURRENT_USER = 'wte:currentUser';
const KEY_CURRENT_FAMILY_ID = 'wte:currentFamilyId';

function readRaw<T>(key: string): T | null {
  try {
    const value = wx.getStorageSync(key);
    if (value === '' || value === null || value === undefined) {
      return null;
    }
    return value as T;
  } catch (error) {
    console.warn(`[storage] 读取 ${key} 失败`, error);
    return null;
  }
}

function writeRaw(key: string, value: unknown): void {
  try {
    wx.setStorageSync(key, value);
  } catch (error) {
    console.warn(`[storage] 写入 ${key} 失败`, error);
  }
}

function removeRaw(key: string): void {
  try {
    wx.removeStorageSync(key);
  } catch (error) {
    console.warn(`[storage] 删除 ${key} 失败`, error);
  }
}

export const storage = {
  /**
   * 读取本地缓存的当前用户。
   * 只作为「启动时先恢复 UI」的乐观数据，登录态最终以服务端校验结果为准。
   */
  getCurrentUser(): AuthUser | null {
    const user = readRaw<AuthUser>(KEY_CURRENT_USER);
    if (!user || typeof user._id !== 'string' || user._id === '') {
      return null;
    }
    return user;
  },

  setCurrentUser(user: AuthUser): void {
    writeRaw(KEY_CURRENT_USER, user);
  },

  clearCurrentUser(): void {
    removeRaw(KEY_CURRENT_USER);
  },

  getCurrentFamilyId(): string {
    const familyId = readRaw<string>(KEY_CURRENT_FAMILY_ID);
    return typeof familyId === 'string' ? familyId : '';
  },

  setCurrentFamilyId(familyId: string): void {
    if (!familyId) {
      removeRaw(KEY_CURRENT_FAMILY_ID);
      return;
    }
    writeRaw(KEY_CURRENT_FAMILY_ID, familyId);
  },

  clearCurrentFamilyId(): void {
    removeRaw(KEY_CURRENT_FAMILY_ID);
  },

  /** 退出登录 / 切换账号时调用 */
  clearAll(): void {
    removeRaw(KEY_CURRENT_USER);
    removeRaw(KEY_CURRENT_FAMILY_ID);
  },
};
