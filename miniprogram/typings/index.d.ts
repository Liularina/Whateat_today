import type { FamilyDTO, FamilyState, FamilyStateListener } from '../types/family';
import type { AuthState, AuthStateListener, AuthUser } from '../types/user';

declare global {
  /** 小程序全局内存状态：只放必要标识，权威数据始终来自云数据库 */
  interface IGlobalData {
    /** 当前登录用户；刻意不包含 openid（业务统一使用 _id） */
    user: AuthUser | null;
    isLoggedIn: boolean;
    /** 启动登录流程是否已结束，未结束前页面应展示「正在登录…」而不是登录失败 */
    authReady: boolean;
    /** 可直接展示给用户的登录错误文案，无错误时为空串 */
    authError: string;
    /** 当前家庭；无家庭时为 null（正常状态，不是错误） */
    family: FamilyDTO | null;
    /** 当前家庭 ID；无家庭时为空串。仅作为 UI 恢复与导航辅助，绝不作为权限依据 */
    currentFamilyId: string;
    /** 家庭信息是否已向服务端确认 */
    familyReady: boolean;
    /** 家庭加载错误文案，无错误时为空串 */
    familyError: string;
    cloudReady: boolean;
    /** Phase 7：最后一次 AI 推荐结果（跨页面传递，不持久化） */
    lastRecommendResult: unknown;
    /** Phase 8：当前正在操作的菜单 ID */
    currentMenuId: string;
  }

  interface IAppOption {
    globalData: IGlobalData;
    initCloud(): boolean;
    /** 从本地缓存恢复登录用户与当前家庭标识 */
    restoreLocalState(): void;
    /** App 启动时的身份初始化：恢复缓存 → 校验/登录 → 写入全局状态 */
    initAuth(): Promise<void>;
    getAuthState(): AuthState;
    onAuthStateChange(listener: AuthStateListener): void;
    offAuthStateChange(listener: AuthStateListener): void;
    /** 登录失败后由页面手动重试 */
    retryLogin(): Promise<void>;
    setCurrentFamilyId(familyId: string): void;
    clearSession(): void;

    /* ---- 家庭（Phase 3） ---- */
    /** 读取家庭状态（页面统一入口） */
    getFamilyState(): FamilyState;
    onFamilyStateChange(listener: FamilyStateListener): void;
    offFamilyStateChange(listener: FamilyStateListener): void;
    /** 从服务端加载当前家庭；并发调用只发一次请求 */
    loadFamily(): Promise<void>;
    /** 页面 onShow 时刷新家庭（家庭页、首页、我的页保存后需要立即一致） */
    refreshFamily(): Promise<void>;
    /** 创建 / 加入家庭成功后写入全局状态与本地标识 */
    setFamily(family: FamilyDTO): void;
    /** 退出 / 解散家庭后清空全局状态与本地标识（不影响登录态） */
    clearFamily(): void;
  }
}

export {};
