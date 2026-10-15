import { DEFAULT_NICKNAME } from '../../constants/config';
import type { FamilyState } from '../../types/family';
import type { AuthState } from '../../types/user';

Page({
  data: {
    /** 登录初始化是否结束 */
    authReady: false,
    isLoggedIn: false,
    /** 已登录时的问候语，例如「你好，微信用户」 */
    greeting: '',
    /** 可直接展示的错误文案（登录失败 / 网络异常） */
    authError: '',

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

    // 从家庭页返回时刷新：成员增减、家庭改名后需要立即一致
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
    const nickname = state.user?.nickname || DEFAULT_NICKNAME;

    this.setData({
      authReady: state.ready,
      isLoggedIn: state.isLoggedIn,
      greeting: state.isLoggedIn ? `你好，${nickname}` : '',
      authError: state.error,
    });

    // 首次登录且为默认资料 → 自动引导设置
    const isDefaultProfile =
      state.ready && state.isLoggedIn &&
      state.user &&
      state.user.nickname === DEFAULT_NICKNAME &&
      !state.user.avatarUrl;
    if (isDefaultProfile && !getApp<IAppOption>().globalData.profileSetupDone) {
      getApp<IAppOption>().globalData.profileSetupDone = true;
      wx.navigateTo({ url: '/pages/profile-setup/index' });
    }
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

  /** 登录失败后手动重试 */
  onRetryLogin() {
    void getApp<IAppOption>().retryLogin();
  },

  // 核心 CTA：根据冰箱食材推荐
  onStartRecommend() {
    wx.navigateTo({ url: '/pages/recommend/index' });
  },

  onGoIngredients() {
    wx.switchTab({ url: '/pages/ingredients/index' });
  },

  onGoOrder() {
    wx.switchTab({ url: '/pages/order/index' });
  },

  /** Phase 6：家常菜谱库（公共只读，未登录也能看） */
  onGoRecipes() {
    wx.navigateTo({ url: '/pages/recipes/index' });
  },

  /** 点击当前家庭卡片 → 家庭页 */
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
