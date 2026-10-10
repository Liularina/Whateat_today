import { menuService } from '../../services/menu';
import { getErrorMessage } from '../../utils/cloud';
import { MEAL_TYPE_LABELS } from '../../constants/config';
import type { Menu, MenuListItem } from '../../types/menu';

interface TodayMenuView {
  _id: string;
  mealTypeLabel: string;
  servings: number;
  statusLabel: string;
  dateLabel: string;
  dishes: { recipeId: string; name: string; category: string; cookTime: string }[];
}

interface HistoryMenuView extends MenuListItem {
  mealTypeLabel: string;
  statusLabel: string;
  dishSummary: string;
}

type MenuTab = 'today' | 'history';

const STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  confirmed: '已确认',
  completed: '已完成',
};

function toTodayView(menu: Menu | null): TodayMenuView | null {
  if (!menu) return null;
  return {
    _id: menu._id,
    mealTypeLabel: MEAL_TYPE_LABELS[menu.mealType] || menu.mealType,
    servings: menu.servings,
    statusLabel: STATUS_LABELS[menu.status] || menu.status,
    dateLabel: (menu.createdAt || '').slice(0, 10),
    dishes: (menu.items || []).map((it) => ({
      recipeId: it.recipeId,
      name: it.name,
      category: it.category || '',
      cookTime: it.cookTime ? '约 ' + it.cookTime + ' 分钟' : '',
    })),
  };
}

function toHistoryView(item: MenuListItem): HistoryMenuView {
  return {
    ...item,
    mealTypeLabel: MEAL_TYPE_LABELS[item.mealType] || item.mealType,
    statusLabel: STATUS_LABELS[item.status] || item.status,
    dishSummary: (item.dishNames || []).slice(0, 4).join('、') +
      (item.dishNames && item.dishNames.length > 4 ? ' 等' : ''),
  };
}

Page({
  data: {
    activeTab: 'today' as MenuTab,

    /* 今日菜单 */
    todayLoading: false,
    todayMenu: null as TodayMenuView | null,
    todayError: '',

    /* 历史菜单 */
    historyLoading: false,
    historyMenus: [] as HistoryMenuView[],
    historyError: '',
    historyPage: 1,
    historyHasMore: false,

    hasFamily: false,
  },

  onShow() {
    const app = getApp<IAppOption>();
    const family = app.globalData.family;
    const hasFamily = !!(family && family._id);

    this.setData({ hasFamily: hasFamily });

    if (!hasFamily) {
      this.setData({ todayMenu: null, historyMenus: [], todayLoading: false, historyLoading: false });
      return;
    }

    if (this.data.activeTab === 'today') {
      void this.loadToday();
    } else {
      void this.loadHistory(true);
    }
  },

  onSwitchTab(e: WechatMiniprogram.TouchEvent) {
    const tab = e.currentTarget.dataset.tab as MenuTab;
    this.setData({ activeTab: tab });
    if (!this.data.hasFamily) return;

    if (tab === 'today') {
      void this.loadToday();
    } else {
      void this.loadHistory(true);
    }
  },

  /* ============================== 今日菜单 ============================== */

  async loadToday() {
    const app = getApp<IAppOption>();
    const family = app.globalData.family;
    if (!family) return;

    this.setData({ todayLoading: true, todayError: '' });
    try {
      const result = await menuService.getTodayMenu(family._id);
      this.setData({ todayLoading: false, todayMenu: toTodayView(result.menu) });
    } catch (e) {
      this.setData({ todayLoading: false, todayError: getErrorMessage(e, '加载失败') });
    }
  },

  /* ============================== 历史菜单 ============================== */

  async loadHistory(reset = false) {
    const app = getApp<IAppOption>();
    const family = app.globalData.family;
    if (!family) return;

    const page = reset ? 1 : this.data.historyPage;
    this.setData({ historyLoading: true, historyError: '' });

    try {
      const result = await menuService.getMenuHistory({
        familyId: family._id,
        page: page,
        pageSize: 20,
      });

      const views = (result.items || []).map(toHistoryView);
      const menus = reset ? views : [...this.data.historyMenus, ...views];

      this.setData({
        historyLoading: false,
        historyMenus: menus,
        historyPage: page,
        historyHasMore: menus.length < result.total,
      });
    } catch (e) {
      this.setData({ historyLoading: false, historyError: getErrorMessage(e, '加载失败') });
    }
  },

  onReachBottom() {
    if (this.data.activeTab !== 'history') return;
    if (!this.data.historyHasMore || this.data.historyLoading) return;
    this.setData({ historyPage: this.data.historyPage + 1 }, () => {
      void this.loadHistory(false);
    });
  },

  onRetryHistory() {
    void this.loadHistory(true);
  },

  /* ============================== 导航 ============================== */

  onOpenMenu(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id || '');
    if (!id) return;
    wx.navigateTo({ url: '/pages/menu-detail/index?menuId=' + id });
  },

  /** 从当前菜单点菜品 → 菜谱详情（Phase 11） */
  onOpenRecipe(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id || '');
    if (!id) return;
    const name = String(e.currentTarget.dataset.name || '');
    const url = '/pages/recipes/detail?id=' + id + (name ? '&name=' + encodeURIComponent(name) : '');
    wx.navigateTo({ url: url });
  },

  onGoHome() {
    wx.switchTab({ url: '/pages/home/index' });
  },
});