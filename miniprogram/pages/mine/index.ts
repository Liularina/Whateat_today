import { APP_NAME, APP_VERSION, CURRENT_ENV, DEFAULT_NICKNAME } from '../../constants/config';
import { reviewService } from '../../services/review';
import type { FamilyState } from '../../types/family';
import type { AuthState } from '../../types/user';
import type { ChefGrowth } from '../../types/review';

/** cloud:// 转成可显示 HTTPS URL */
function toDisplayUrl(url: string): Promise<string> {
  if (!url || !url.startsWith('cloud://')) return Promise.resolve(url);
  return new Promise((resolve) => {
    wx.cloud.getTempFileURL({
      fileList: [url],
      success: (res) => {
        const tmp = res.fileList && res.fileList[0] && res.fileList[0].tempFileURL;
        resolve(tmp || '');
      },
      fail: () => resolve(''),
    });
  });
}

Page({
  data: {
    nickname: DEFAULT_NICKNAME,
    avatarUrl: '',
    /** cloud:// 转成的可显示 HTTPS URL */
    avatarDisplayUrl: '',
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

    /** 阶段二：厨师等级与成长（掌勺人积分） */
    growth: null as ChefGrowth | null,
    growthProgress: 0,
    growthNextLabel: '',
    growthLastLabel: '',
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
    void this.loadGrowth();
  },

  /** 阶段二：读取当前家庭下的厨师等级与累计积分 */
  async loadGrowth() {
    const app = getApp<IAppOption>();
    const family = app.globalData.family;
    if (!family) {
      this.setData({ growth: null, growthProgress: 0, growthNextLabel: '', growthLastLabel: '' });
      return;
    }

    try {
      const result = await reviewService.getChefGrowth(family._id);
      const growth = result.growth;
      const span = growth.maxLevel ? 0 : growth.nextMinPoints - growth.levelMinPoints;
      const ratio = growth.maxLevel || span <= 0
        ? 1
        : (growth.points - growth.levelMinPoints) / span;

      this.setData({
        growth: growth,
        growthProgress: Math.max(0, Math.min(100, Math.round(ratio * 100))),
        growthNextLabel: growth.maxLevel
          ? '已达到最高等级'
          : '距 ' + growth.nextLevelName + ' 还差 ' + growth.pointsToNext + ' 分',
        growthLastLabel: growth.lastReason
          ? growth.lastReason + ' +' + growth.lastPoints
          : '',
      });
    } catch (_e) {
      // 成长数据只做展示，未创建集合或未担任过掌勺人时静默降级
      this.setData({ growth: null, growthProgress: 0, growthNextLabel: '', growthLastLabel: '' });
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

    const rawAvatar = state.user?.avatarUrl || '';
    this.setData({
      nickname: state.user?.nickname || DEFAULT_NICKNAME,
      avatarUrl: rawAvatar,
      authStatus,
      authError: state.error,
    });

    // cloud:// 头像转可显示 URL
    void toDisplayUrl(rawAvatar).then((display) => {
      this.setData({ avatarDisplayUrl: display || '' });
    });

    const isDefaultProfile =
      state.ready && state.isLoggedIn &&
      state.user &&
      state.user.nickname === DEFAULT_NICKNAME &&
      !state.user.avatarUrl;

    // 首次登录且为默认资料 → 自动引导设置
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

  /** Phase 7：模型 API 设置入口 */
  onGoAiSettings() {
    wx.navigateTo({ url: '/pages/ai-settings/index' });
  },

  /** Phase 11：历史菜单（菜单 Tab） */
  onGoHistoryMenu() {
    wx.switchTab({ url: '/pages/menu/index' });
  },

  /** Phase 11：历史点单（点菜 Tab） */
  onGoHistoryOrder() {
    wx.switchTab({ url: '/pages/order/index' });
  },

  /** Phase D：我的菜谱（家庭菜谱库） */
  onGoCookbook() {
    wx.navigateTo({ url: '/pages/cookbook/index' });
  },

  /** 修改资料：跳转到资料设置页 */
  onGoProfileSetup() {
    wx.navigateTo({ url: '/pages/profile-setup/index' });
  },
});
