import {
  APP_NAME,
  CLOUD_ENV_ID,
  CLOUD_ENV_NAME,
  CLOUD_ENV_NOT_CONFIGURED_MESSAGE,
  isCloudEnvConfigured,
} from './constants/config';
import { authService } from './services/auth';
import { familyService } from './services/family';
import type { FamilyDTO, FamilyState, FamilyStateListener } from './types/family';
import type { AuthState, AuthStateListener } from './types/user';
import { getErrorCode, getErrorMessage } from './utils/cloud';
import { storage } from './utils/storage';

/** 登录态订阅者：页面通过 onAuthStateChange 统一获取当前用户 */
const authListeners: AuthStateListener[] = [];

/** 云开发初始化失败原因（供页面展示，避免出现 undefined 之类的内部报错） */
let cloudInitError = '';

function notifyAuthListeners(state: AuthState): void {
  // 复制一份再遍历，避免回调中取消订阅导致遍历错位
  for (const listener of authListeners.slice()) {
    try {
      listener(state);
    } catch (error) {
      console.warn('[app] 登录态监听回调异常', error);
    }
  }
}

/** 统一写入全局登录状态并广播给订阅页面 */
function applyAuthState(app: IAppOption, state: AuthState): void {
  app.globalData.user = state.user;
  app.globalData.isLoggedIn = state.isLoggedIn;
  app.globalData.authReady = state.ready;
  app.globalData.authError = state.error;
  notifyAuthListeners(state);
}

/** 家庭状态订阅者：页面通过 onFamilyStateChange 统一获取当前家庭 */
const familyListeners: FamilyStateListener[] = [];

/** 家庭加载并发保护：多个页面同时 onShow 也只发一次请求 */
let loadFamilyPromise: Promise<void> | null = null;

function notifyFamilyListeners(state: FamilyState): void {
  for (const listener of familyListeners.slice()) {
    try {
      listener(state);
    } catch (error) {
      console.warn('[app] 家庭态监听回调异常', error);
    }
  }
}

/**
 * 写入全局家庭状态并广播。
 * 刻意不在这里读写本地缓存：缓存只在 setFamily / clearFamily 时更新，
 * 这样「网络异常」时不会误清掉本地已缓存的 currentFamilyId。
 */
function applyFamilyState(app: IAppOption, state: FamilyState): void {
  app.globalData.family = state.family;
  app.globalData.currentFamilyId = state.family ? state.family._id : '';
  app.globalData.familyReady = state.ready;
  app.globalData.familyError = state.error;
  notifyFamilyListeners(state);
}

/**
 * 向服务端拉取当前家庭并写入全局状态。
 *
 *   - 未登录 → 直接置为无家庭，不发请求（未登录不进家庭接口）；
 *   - 服务端返回 family = null → 正常无家庭状态，并清掉本地脏 currentFamilyId；
 *   - 网络异常 → 保留现有家庭状态与本地缓存，仅提示错误，不做清空。
 */
async function fetchFamily(app: IAppOption): Promise<void> {
  if (!app.globalData.isLoggedIn) {
    app.clearFamily();
    return;
  }

  if (!app.globalData.cloudReady) {
    applyFamilyState(app, {
      ready: true,
      family: app.globalData.family,
      isInFamily: app.globalData.family !== null,
      error: app.globalData.familyError || cloudInitError,
    });
    return;
  }

  try {
    const result = await familyService.getMyFamily();

    if (result && result.family) {
      app.setFamily(result.family);
      return;
    }

    // 数据库才是最终事实：本地缓存过 familyId 但服务端已无家庭 → 清掉脏缓存
    app.clearFamily();
  } catch (error) {
    console.warn('[app] 家庭信息加载失败', getErrorCode(error));
    applyFamilyState(app, {
      ready: true,
      family: app.globalData.family,
      isInFamily: app.globalData.family !== null,
      error: getErrorMessage(error, '家庭信息加载失败，请稍后重试'),
    });
  }
}

App<IAppOption>({
  globalData: {
    user: null,
    isLoggedIn: false,
    authReady: false,
    authError: '',
    family: null,
    currentFamilyId: '',
    familyReady: false,
    familyError: '',
    cloudReady: false,
    lastRecommendResult: null,
    currentMenuId: '',
    profileSetupDone: false,
    pendingMenuTab: '',
  },

  onLaunch() {
    this.initCloud();
    this.restoreLocalState();
    // 身份初始化是异步的：不阻塞启动，页面通过 getAuthState / onAuthStateChange 感知结果
    void this.initAuth();
  },

  /**
   * 初始化微信云开发。
   * 环境 ID 统一来自 constants/config.ts，禁止在各页面散落写死。
   */
  initCloud(): boolean {
    if (!wx.cloud) {
      cloudInitError = '当前基础库不支持云开发，请升级微信后重试';
      console.error('[app] ' + cloudInitError);
      this.globalData.cloudReady = false;
      return false;
    }

    if (!isCloudEnvConfigured()) {
      cloudInitError = CLOUD_ENV_NOT_CONFIGURED_MESSAGE;
      console.error('[app] ' + cloudInitError);
      this.globalData.cloudReady = false;
      return false;
    }

    try {
      wx.cloud.init({
        env: CLOUD_ENV_ID,
        traceUser: true,
      });
      cloudInitError = '';
      this.globalData.cloudReady = true;
      console.info(`[app] 云开发初始化完成 app=${APP_NAME} env=${CLOUD_ENV_NAME}`);
      return true;
    } catch (error) {
      // 云环境初始化失败不允许阻塞小程序启动，页面需自行展示错误态
      cloudInitError = '云开发初始化失败，请检查网络后重试';
      console.error('[app] 云开发初始化失败', error);
      this.globalData.cloudReady = false;
      return false;
    }
  },

  /**
   * 从本地缓存恢复登录用户与家庭标识。
   * 只缓存标识（当前用户 + currentFamilyId），不缓存业务数据。
   * 这里只是「先恢复 UI」，真实登录态由 initAuth 向服务端校验后才确认。
   */
  restoreLocalState(): void {
    const cachedUser = storage.getCurrentUser();
    if (cachedUser) {
      applyAuthState(this, { ready: false, isLoggedIn: true, user: cachedUser, error: '' });
    }

    const familyId = storage.getCurrentFamilyId();
    if (familyId) {
      this.globalData.currentFamilyId = familyId;
    }
  },

  /**
   * 启动时的身份初始化（不阻塞启动）。
   *
   * 云开发未就绪 → 直接给出明确错误，绝不进入无限 loading；
   * 有缓存 → 先恢复 UI，再向服务端校验（服务端已无该用户则重新登录）；
   * 云服务暂时异常 → 保留本地登录数据，仅提示网络问题，不清空登录态。
   */
  async initAuth(): Promise<void> {
    if (!this.globalData.cloudReady) {
      applyAuthState(this, {
        ready: true,
        isLoggedIn: this.globalData.user !== null,
        user: this.globalData.user,
        error: cloudInitError || CLOUD_ENV_NOT_CONFIGURED_MESSAGE,
      });
      return;
    }

    try {
      const user = await authService.restoreSession();

      if (user) {
        applyAuthState(this, { ready: true, isLoggedIn: true, user, error: '' });
        // 登录成功后立即恢复家庭，保证进入首页时家庭状态已经正确
        void this.loadFamily();
        return;
      }

      applyAuthState(this, {
        ready: true,
        isLoggedIn: false,
        user: null,
        error: '登录失败，请稍后重试',
      });
      this.clearFamily();
    } catch (error) {
      const cached = authService.getCachedUser();

      if (cached) {
        // 云服务/网络暂时异常：保留本地登录数据，仅提示网络问题
        console.warn('[app] 登录态校验失败，保留本地缓存', getErrorCode(error));
        applyAuthState(this, {
          ready: true,
          isLoggedIn: true,
          user: cached,
          error: getErrorMessage(error, '当前网络不可用，请检查网络后重试'),
        });
        return;
      }

      applyAuthState(this, {
        ready: true,
        isLoggedIn: false,
        user: null,
        error: getErrorMessage(error, '登录失败，请稍后重试'),
      });
      this.clearFamily();
    }
  },

  /** 页面读取登录态的统一入口 */
  getAuthState(): AuthState {
    return {
      ready: this.globalData.authReady,
      isLoggedIn: this.globalData.isLoggedIn,
      user: this.globalData.user,
      error: this.globalData.authError,
    };
  },

  onAuthStateChange(listener: AuthStateListener): void {
    if (authListeners.indexOf(listener) === -1) {
      authListeners.push(listener);
    }
  },

  offAuthStateChange(listener: AuthStateListener): void {
    const index = authListeners.indexOf(listener);
    if (index !== -1) {
      authListeners.splice(index, 1);
    }
  },

  /** 登录失败后由页面手动重试 */
  async retryLogin(): Promise<void> {
    applyAuthState(this, {
      ready: false,
      isLoggedIn: this.globalData.isLoggedIn,
      user: this.globalData.user,
      error: '',
    });
    await this.initAuth();
  },

  /* ------------------------------ 家庭（Phase 3） ------------------------------ */

  getFamilyState(): FamilyState {
    return {
      ready: this.globalData.familyReady,
      family: this.globalData.family,
      isInFamily: this.globalData.family !== null,
      error: this.globalData.familyError,
    };
  },

  onFamilyStateChange(listener: FamilyStateListener): void {
    if (familyListeners.indexOf(listener) === -1) {
      familyListeners.push(listener);
    }
  },

  offFamilyStateChange(listener: FamilyStateListener): void {
    const index = familyListeners.indexOf(listener);
    if (index !== -1) {
      familyListeners.splice(index, 1);
    }
  },

  /**
   * 从服务端加载当前家庭。并发调用复用同一个 Promise，
   * 避免多个页面同时 onShow 打出多次请求。
   */
  loadFamily(): Promise<void> {
    if (loadFamilyPromise) {
      return loadFamilyPromise;
    }

    const promise = fetchFamily(this)
      .catch(() => {
        // fetchFamily 内部已按错误码兜底；这里只保证「即发即忘」的调用
        //（如登录成功后 void this.loadFamily()）不会产生未处理的 rejection
      })
      .finally(() => {
        loadFamilyPromise = null;
      });
    loadFamilyPromise = promise;

    return promise;
  },

  /** 页面 onShow 主动刷新：家庭设置保存、成员变动后需要立即一致 */
  refreshFamily(): Promise<void> {
    return this.loadFamily();
  },

  /** 创建 / 加入家庭成功后调用：写入全局状态与本地标识 */
  setFamily(family: FamilyDTO): void {
    applyFamilyState(this, { ready: true, family, isInFamily: true, error: '' });
    storage.setCurrentFamilyId(family._id);
  },

  /** 退出 / 解散家庭后调用：清空全局状态与本地标识，但不影响登录态 */
  clearFamily(): void {
    applyFamilyState(this, { ready: true, family: null, isInFamily: false, error: '' });
    storage.clearCurrentFamilyId();
  },

  setCurrentFamilyId(familyId: string): void {
    this.globalData.currentFamilyId = familyId;
    storage.setCurrentFamilyId(familyId);
  },

  clearSession(): void {
    authService.clearSession();
    storage.clearAll();
    applyFamilyState(this, { ready: true, family: null, isInFamily: false, error: '' });
    applyAuthState(this, { ready: true, isLoggedIn: false, user: null, error: '' });
  },
});
