import { APP_NAME, APP_VERSION, CURRENT_ENV, DEFAULT_NICKNAME } from '../../constants/config';
import type { FamilyState } from '../../types/family';
import type { AuthState } from '../../types/user';

Page({
  data: {
    nickname: DEFAULT_NICKNAME,
    avatarUrl: '',
    /** 登录状态文案：正在登录… / 已登录 / 未登录 */
    authStatus: '正在登录…',
    authError: '',
    appName: APP_NAME,
    version: APP_VERSION,
    envName: CURRENT_ENV,

    /** 家庭信息是否已向服务端确认 */
    familyReady: false,
    isInFamily: false,
    familyName: '',
    memberCount: 0,
    familyError: '',
  },

  /** 取消登录态订阅的闭包，页面卸载时释放 */
  _unsubscribeAuth: null as null | (() => void),
  /** 取消家庭态订阅的闭包，页面卸载时释放 */
  _unsubscribeFamily: null as null | (() => void),

  onLoad() {
    const app = getApp<IAppOption>();

    // 页面不各自触发 login，只订阅 App 层统一的登录态
    const authListener = (state: AuthState) => this.applyAuthState(state);
    this._unsubscribeAuth = () => app.offAuthStateChange(authListener);
    app.onAuthStateChange(authListener);

    const familyListener = (state: FamilyState) => this.applyFamilyState(state);
    this._unsubscribeFamily = () => app.offFamilyStateChange(familyListener);
    app.onFamilyStateChange(familyListener);

    this.applyAuthState(app.getAuthState());
    this.applyFamilyState(app.getFamilyState());
  },

  onShow() {
    const app = getApp<IAppOption>();
    this.applyAuthState(app.getAuthState());
    this.applyFamilyState(app.getFamilyState());

    // 家庭页返回后刷新，保证成员数与名称是最新的
    if (app.globalData.isLoggedIn) {
      void app.refreshFamily();
    }
  },

  onUnload() {
    if (this._unsubscribeAuth) {
      this._unsubscribeAuth();
      this._unsubscribeAuth = null;
    }
    if (this._unsubscribeFamily) {
      this._unsubscribeFamily();
      this._unsubscribeFamily = null;
    }
  },

  applyAuthState(state: AuthState) {
    let authStatus = '正在登录…';
    if (state.ready) {
      authStatus = state.isLoggedIn ? '已登录' : '未登录';
    }

    this.setData({
      nickname: state.user?.nickname || DEFAULT_NICKNAME,
      avatarUrl: state.user?.avatarUrl || '',
      authStatus,
      authError: state.error,
    });
  },

  applyFamilyState(state: FamilyState) {
    this.setData({
      familyReady: state.ready,
      isInFamily: state.isInFamily,
      familyName: state.family ? state.family.name : '',
      memberCount: state.family ? state.family.memberCount : 0,
      familyError: state.error,
    });
  },

  /** 当前家庭 → 家庭管理 */
  onGoFamily() {
    wx.navigateTo({ url: '/pages/family/index' });
  },

  onGoCreateFamily() {
    wx.navigateTo({ url: '/pages/family/create' });
  },

  onGoJoinFamily() {
    wx.navigateTo({ url: '/pages/family/join' });
  },
});
