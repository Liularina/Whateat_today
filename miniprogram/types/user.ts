/**
 * 用户相关类型
 */

/** 微信授权得到的用户资料（仅昵称与头像，符合隐私最小化要求） */
export interface UserProfile {
  nickname: string;
  avatarUrl: string;
}

/**
 * users 集合文档（服务端结构）。
 *
 * openid 是服务端身份字段，只允许存在于云函数内部与云数据库，
 * 禁止下发给普通页面业务使用。
 */
export interface User {
  _id: string;
  openid?: string;
  nickname: string;
  avatarUrl: string;
  createdAt: Date | string;
  updatedAt: Date | string;
}

/**
 * auth 云函数返回给前端的认证用户 DTO。
 *
 * 刻意不包含 openid：
 *   - 业务层统一使用 _id（= users._id）作为用户业务 ID；
 *   - 后续家庭等业务关联一律使用该 _id，不得使用 openid。
 */
export interface AuthUser {
  _id: string;
  nickname: string;
  avatarUrl: string;
  createdAt: string;
  updatedAt: string;
}

/** 前端业务代码使用的当前用户类型（等价于 AuthUser，不暴露 openid） */
export type CurrentUser = AuthUser;

/** 登录态快照：页面通过 App 的 getAuthState() 统一读取 */
export interface AuthState {
  /** 启动登录流程是否已结束（结束后才应展示「登录失败」之类的终态） */
  ready: boolean;
  isLoggedIn: boolean;
  user: AuthUser | null;
  /** 可直接展示给用户的中文错误文案，无错误时为空串 */
  error: string;
}

export type AuthStateListener = (state: AuthState) => void;
