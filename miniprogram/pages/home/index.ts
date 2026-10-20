import { DEFAULT_NICKNAME } from '../../constants/config';
import type { FamilyState } from '../../types/family';
import type { AuthState } from '../../types/user';
import type { Menu } from '../../types/menu';
import type { Ingredient } from '../../types/ingredient';
import { menuService } from '../../services/menu';
import { ingredientService } from '../../services/ingredient';
import { getShelfLifeStatus } from '../../utils/shelf-life';
import { getErrorMessage } from '../../utils/cloud';

/* ========================== 展示辅助类型 ========================== */

interface DishView {
  recipeId: string;
  name: string;
  kcal: number;
  kcalLabel: string;
  cookTime: number;
  cookTimeLabel: string;
}

interface IngredientAlert {
  name: string;
  daysLeft: number | null;
  label: string;
}

/* ========================== 冰箱提醒快照 ========================== */

interface FridgeSnapshot {
  total: number;
  expired: number;
  todayExpire: number;
  nearExpiry: number;
  warning: number;
  /** 优先展示的预警食材（最多3条） */
  alerts: IngredientAlert[];
}

type LoadState = 'idle' | 'loading' | 'loaded' | 'error';

/* ========================== 页面 ========================== */

Page({
  data: {
    /* 自定义导航栏：状态栏高度（px），由系统信息写入 */
    statusBarHeight: 20,

    /* 登录 */
    authReady: false,
    isLoggedIn: false,
    greeting: '',
    authError: '',

    /* 家庭 */
    familyReady: false,
    isInFamily: false,
    familyName: '',
    familyId: '',
    familyError: '',

    /* 今日菜单 */
    menuState: 'idle' as LoadState,
    todayMenu: null as Menu | null,
    dishes: [] as DishView[],
    menuMealLabel: '',
    menuStatusLabel: '',
    /** draft / confirmed / completed: 区分按钮 */
    menuStatusCode: 'draft' as 'draft' | 'confirmed' | 'completed',
    menuTotalKcal: 0,
    menuNutritionStatus: 'unknown' as 'complete' | 'partial' | 'unknown',
    menuServings: 0,

    /** 换菜进行中，防止重复点击 */
    swapping: false,

    /* 冰箱提醒 */
    fridge: null as FridgeSnapshot | null,
    fridgeLoading: false,
  },

  /* 缓存 */
  _cacheIngredients: null as Ingredient[] | null,

  _unsubscribeAuth: null as null | (() => void),
  _unsubscribeFamily: null as null | (() => void),

  /* ========================== 生命周期 ========================== */

  onLoad() {
    const app = getApp<IAppOption>();

    // 自定义导航栏：按机型状态栏高度留出安全区
    const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    this.setData({ statusBarHeight: (windowInfo && windowInfo.statusBarHeight) || 20 });

    const authListener = (s: AuthState) => this.applyAuth(s);
    this._unsubscribeAuth = () => app.offAuthStateChange(authListener);
    app.onAuthStateChange(authListener);

    const famListener = (s: FamilyState) => this.applyFamily(s);
    this._unsubscribeFamily = () => app.offFamilyStateChange(famListener);
    app.onFamilyStateChange(famListener);

    this.applyAuth(app.getAuthState());
    this.applyFamily(app.getFamilyState());
  },

  onShow() {
    const app = getApp<IAppOption>();
    this.applyAuth(app.getAuthState());
    this.applyFamily(app.getFamilyState());
    if (app.globalData.isLoggedIn) void app.refreshFamily();
    this.loadAll();
  },

  onUnload() {
    this._unsubscribeAuth?.(); this._unsubscribeAuth = null;
    this._unsubscribeFamily?.(); this._unsubscribeFamily = null;
  },

  /* ========================== 状态同步 ========================== */

  applyAuth(state: AuthState) {
    const nickname = state.user?.nickname || DEFAULT_NICKNAME;
    this.setData({
      authReady: state.ready,
      isLoggedIn: state.isLoggedIn,
      greeting: state.isLoggedIn ? `你好，${nickname}` : '',
      authError: state.error,
    });
    const isDefault =
      state.ready && state.isLoggedIn && state.user &&
      state.user.nickname === DEFAULT_NICKNAME && !state.user.avatarUrl;
    if (isDefault && !getApp<IAppOption>().globalData.profileSetupDone) {
      getApp<IAppOption>().globalData.profileSetupDone = true;
      wx.navigateTo({ url: '/pages/profile-setup/index' });
    }
  },

  applyFamily(state: FamilyState) {
    const familyId = state.family ? state.family._id : '';
    this.setData({
      familyReady: state.ready,
      isInFamily: state.isInFamily,
      familyName: state.family ? state.family.name : '',
      familyId,
      familyError: state.error,
    });
    if (state.ready && state.isInFamily) this.loadAll();
  },

  /* ========================== 数据加载 ========================== */

  loadAll() {
    const fid = this.data.familyId;
    if (!fid) return;
    void this.loadMenu(fid);
    void this.loadFridge(fid);
  },

  /* ---- 今日菜单 ---- */

  async loadMenu(familyId: string) {
    if (this.data.menuState === 'loading') return;
    this.setData({ menuState: 'loading' });
    try {
      const { menu } = await menuService.getTodayMenu(familyId);
      if (menu) {
        const mealLabels: Record<string, string> = {
          breakfast: '早餐', lunch: '午餐', dinner: '晚餐', midnight_snack: '夜宵',
        };
        const statusLabels: Record<string, string> = {
          draft: '待确认', confirmed: '已确认', completed: '已完成',
        };
        const items = menu.items || [];
        let totalKcal = 0;
        const dishes: DishView[] = [];
        for (const it of items) {
          const kcal = it.nutrition?.calories || 0;
          if (kcal > 0) totalKcal += kcal;
          dishes.push({
            recipeId: it.recipeId,
            name: it.name,
            kcal,
            kcalLabel: kcal > 0 ? `约 ${Math.round(kcal)} kcal` : '',
            cookTime: it.cookTime || 0,
            cookTimeLabel: it.cookTime ? `约 ${it.cookTime} 分钟` : '',
          });
        }
        this.setData({
          menuState: 'loaded',
          todayMenu: menu,
          dishes,
          menuMealLabel: mealLabels[menu.mealType] || '今日',
          menuStatusCode: menu.status as Menu['status'],
          menuStatusLabel: statusLabels[menu.status] || '',
          menuTotalKcal: Math.round(totalKcal),
          menuServings: menu.servings || 0,
          menuNutritionStatus: menu.nutritionStatus || 'unknown',
        });
      } else {
        this.setData({ menuState: 'loaded', todayMenu: null, dishes: [] });
      }
    } catch {
      this.setData({ menuState: 'error' });
    }
  },

  /* ---- 冰箱提醒 ---- */

  async loadFridge(familyId: string) {
    if (this.data.fridgeLoading) return;
    this.setData({ fridgeLoading: true });
    try {
      let list = this._cacheIngredients;
      if (!list) { list = await ingredientService.list(familyId); this._cacheIngredients = list; }

      const now = new Date();
      let expired = 0, todayExpire = 0, nearExpiry = 0;
      const alerts: IngredientAlert[] = [];

      for (const item of list) {
        const s = getShelfLifeStatus(item.expireDate, now);
        if (s.status === 'expired') {
          expired++;
          if (alerts.length < 3) alerts.push({ name: item.standardName || item.name, daysLeft: s.daysLeft, label: s.label });
        } else if (s.daysLeft === 0) {
          todayExpire++;
          if (alerts.length < 3) alerts.push({ name: item.standardName || item.name, daysLeft: 0, label: '今天到期' });
        } else if (s.status === 'warning') {
          nearExpiry++;
          if (alerts.length < 3) alerts.push({ name: item.standardName || item.name, daysLeft: s.daysLeft, label: s.label });
        }
      }

      // 补充其他临期食材到 alerts（最多3条）
      for (const item of list) {
        if (alerts.length >= 3) break;
        const s = getShelfLifeStatus(item.expireDate, now);
        if (s.status === 'warning' || s.status === 'expired' || s.daysLeft === 0) {
          if (!alerts.some(a => a.name === (item.standardName || item.name))) {
            alerts.push({ name: item.standardName || item.name, daysLeft: s.daysLeft, label: s.label });
          }
        }
      }

      this.setData({
        fridgeLoading: false,
        fridge: {
          total: list.length,
          expired, todayExpire, nearExpiry,
          warning: expired + todayExpire + nearExpiry,
          alerts: alerts.slice(0, 3),
        },
      });
    } catch {
      this.setData({ fridgeLoading: false });
    }
  },

  /* ========================== 刷新 ========================== */

  onReloadMenu() { void this.loadMenu(this.data.familyId); },
  onReloadFridge() { this._cacheIngredients = null; void this.loadFridge(this.data.familyId); },

  /* ========================== 菜单操作 ========================== */

  /** 点击菜品 → 菜谱详情 */
  onOpenDish(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id || '');
    if (!id) return;
    const name = String(e.currentTarget.dataset.name || '');
    wx.navigateTo({
      url: '/pages/recipes/detail?id=' + id +
        (name ? '&name=' + encodeURIComponent(name) : ''),
    });
  },

  /**
   * 换一道菜：仅未确认（draft）的菜单可用。
   * 直接替换第一道未锁定的菜，成功后重新加载，保证卡片内容同步更新。
   */
  async onSwapDish() {
    const menu = this.data.todayMenu;
    if (!menu || menu.status !== 'draft' || this.data.swapping) return;

    const items = menu.items || [];
    const target = items.find((it) => !it.locked) || items[0];
    if (!target) return;

    this.setData({ swapping: true });
    try {
      await menuService.replaceMenuItem(menu._id, target.recipeId, this.data.familyId);
      wx.showToast({ title: '已换一道菜', icon: 'none' });
      await this.loadMenu(this.data.familyId);
    } catch (e) {
      wx.showToast({ title: getErrorMessage(e, '换菜失败'), icon: 'none' });
    } finally {
      this.setData({ swapping: false });
    }
  },

  /**
   * 查看做法：进入菜单详情。
   * 沿用原有逻辑，仅按钮名称在草稿态显示为「锁定并查看做法」。
   */
  onViewRecipes() {
    const menu = this.data.todayMenu;
    if (menu) wx.navigateTo({ url: '/pages/menu-detail/index?menuId=' + menu._id });
  },

  /* ========================== 导航 ========================== */

  onRetryLogin() { void getApp<IAppOption>().retryLogin(); },
  onGoFamily() { wx.navigateTo({ url: '/pages/family/index' }); },
  onGoCreateFamily() { wx.navigateTo({ url: '/pages/family/create' }); },
  onGoJoinFamily() { wx.navigateTo({ url: '/pages/family/join' }); },
  onStartRecommend() { wx.navigateTo({ url: '/pages/recommend/index' }); },
  onGoShopping() { wx.navigateTo({ url: '/pages/shopping/index' }); },
  onGoHistory() {
    // 菜单是 tabBar 页面，navigateTo 不会生效；用全局标记让菜单页切到历史 tab
    getApp<IAppOption>().globalData.pendingMenuTab = 'history';
    wx.switchTab({ url: '/pages/menu/index' });
  },
  onGoIngredients() { wx.switchTab({ url: '/pages/ingredients/index' }); },
  onOpenChat() { wx.navigateTo({ url: '/pages/chat/index' }); },
});