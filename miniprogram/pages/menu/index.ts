import { menuService } from '../../services/menu';
import { getErrorMessage } from '../../utils/cloud';
import { MEAL_TYPE_LABELS } from '../../constants/config';
import { formatKcal } from '../../utils/formatter';
import type { Menu, MenuListItem } from '../../types/menu';

/* --------------------- 展示辅助接口 --------------------- */

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
  kcalLabel: string;
}

/** 日历月视图：每天一个格子 */
interface CalendarDayCell {
  day: number;            // 日期（1-31）
  date: string;           // YYYY-MM-DD
  isToday: boolean;
  isCurrentMonth: boolean;
  menus: {
    _id: string;
    mealType: string;
    mealTypeLabel: string;
    dishCount: number;
    totalCalories: number;
    kcalLabel: string;
    nutritionStatus: string;
  }[];
  menuCount: number;
  hasMenu: boolean;
  hasMissingNutrition: boolean;
}

/** 周日历条 */
interface WeekDayBar {
  date: string;
  dayLabel: string;       // 周一、周二…
  dayNum: number;
  isToday: boolean;
  totalCalories: number;
  kcalLabel: string;
  menuCount: number;
  nutritionStatus: string;
}

/* --------------------- 常量 --------------------- */

type MenuTab = 'today' | 'history' | 'calendar';
type CalendarMode = 'month' | 'week' | 'day';

const STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  confirmed: '已确认',
  completed: '已完成',
};

const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];

function pad(n: number): string { return n < 10 ? '0' + n : String(n); }

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
    kcalLabel: item.totalCalories > 0 ? formatKcal(item.totalCalories) : '',
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

    /* 日历 */
    calendarMode: 'month' as CalendarMode,
    calendarYear: 2026,
    calendarMonth: 10,
    calendarWeekStart: '',  // ISO date string for week start (Monday)
    calendarLoading: false,
    calendarDays: [] as CalendarDayCell[],
    weekBars: [] as WeekDayBar[],
    /** 日视图：选中日的菜单 */
    selectedDate: '',
    selectedDateLabel: '',
    selectedDayMenus: [] as HistoryMenuView[],

    hasFamily: false,
  },

  onShow() {
    const app = getApp<IAppOption>();
    const family = app.globalData.family;
    const hasFamily = !!(family && family._id);

    this.setData({ hasFamily: hasFamily });

    if (!hasFamily) {
      this.setData({
        todayMenu: null, historyMenus: [],
        todayLoading: false, historyLoading: false,
        calendarDays: [], weekBars: [],
      });
      return;
    }

    if (this.data.activeTab === 'today') {
      void this.loadToday();
    } else if (this.data.activeTab === 'history') {
      void this.loadHistory(true);
    } else {
      void this.loadCalendarMonth();
    }
  },

  onSwitchTab(e: WechatMiniprogram.TouchEvent) {
    const tab = e.currentTarget.dataset.tab as MenuTab;
    this.setData({ activeTab: tab });
    if (!this.data.hasFamily) return;

    if (tab === 'today') {
      void this.loadToday();
    } else if (tab === 'history') {
      void this.loadHistory(true);
    } else {
      void this.loadCalendarMonth();
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

  /* ================================================================ */
  /*                           日  历                                  */
  /* ================================================================ */

  /** 月初 → 末日的日期字符串 */
  getMonthRange(year: number, month: number) {
    const start = `${year}-${pad(month)}-01`;
    const lastDay = new Date(year, month, 0).getDate(); // month=12 → 下年1月0日 = 12月最后一天
    const end = `${year}-${pad(month)}-${pad(lastDay)}T23:59:59.999Z`;
    return { start, end };
  },

  async loadCalendarMonth() {
    const app = getApp<IAppOption>();
    const family = app.globalData.family;
    if (!family) return;

    const { year, month } = { year: this.data.calendarYear, month: this.data.calendarMonth };
    const { start, end } = this.getMonthRange(year, month);

    this.setData({ calendarLoading: true });
    try {
      const result = await menuService.getMenuHistory({
        familyId: family._id,
        startDate: start,
        endDate: end,
        page: 1,
        pageSize: 50,
      });

      const menus = result.items || [];
      const days = this.buildMonthGrid(year, month, menus);
      const weekBars = this.buildWeekBars(menus);

      this.setData({
        calendarLoading: false,
        calendarDays: days,
        weekBars: weekBars,
        selectedDayMenus: [],
        selectedDate: '',
      });
    } catch (e) {
      this.setData({ calendarLoading: false });
      wx.showToast({ title: getErrorMessage(e, '加载日历失败'), icon: 'none' });
    }
  },

  /** 按 dateLabel 对菜单分组 */
  groupByDate(menus: MenuListItem[]): Record<string, typeof menus> {
    const groups: Record<string, typeof menus> = {};
    for (const m of menus) {
      const d = m.dateLabel || (m.createdAt || '').slice(0, 10);
      if (!d) continue;
      if (!groups[d]) groups[d] = [];
      groups[d].push(m);
    }
    return groups;
  },

  /** 构建月历网格 */
  buildMonthGrid(year: number, month: number, menus: MenuListItem[]): CalendarDayCell[] {
    const dayGroups = this.groupByDate(menus);
    const days: CalendarDayCell[] = [];
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

    // 当月第一天是星期几（0=周日）
    const firstDay = new Date(year, month - 1, 1).getDay();
    // 上个月填位
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    const prevLastDay = new Date(year, month - 1, 0).getDate();

    for (let i = firstDay - 1; i >= 0; i--) {
      const d = prevLastDay - i;
      const date = `${prevYear}-${pad(prevMonth)}-${pad(d)}`;
      days.push(this.makeDayCell(d, date, todayStr, false, dayGroups));
    }

    // 当月
    const lastDay = new Date(year, month, 0).getDate();
    for (let d = 1; d <= lastDay; d++) {
      const date = `${year}-${pad(month)}-${pad(d)}`;
      days.push(this.makeDayCell(d, date, todayStr, true, dayGroups));
    }

    // 下个月填位（凑满整行）
    const remaining = (7 - (days.length % 7)) % 7;
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    for (let d = 1; d <= remaining; d++) {
      const date = `${nextYear}-${pad(nextMonth)}-${pad(d)}`;
      days.push(this.makeDayCell(d, date, todayStr, false, dayGroups));
    }

    return days;
  },

  makeDayCell(day: number, date: string, today: string, isCurrentMonth: boolean,
    dayGroups: Record<string, MenuListItem[]>): CalendarDayCell {
    const ms = dayGroups[date] || [];
    let totalCal = 0;
    let hasMissing = false;
    for (const m of ms) {
      if (m.totalCalories) totalCal += m.totalCalories;
      if (m.nutritionStatus === 'partial') hasMissing = true;
    }
    return {
      day: day,
      date: date,
      isToday: date === today,
      isCurrentMonth: isCurrentMonth,
      menus: ms.map((m) => ({
        _id: m.menuId,
        mealType: m.mealType,
        mealTypeLabel: MEAL_TYPE_LABELS[m.mealType] || m.mealType,
        dishCount: m.dishCount,
        totalCalories: m.totalCalories || 0,
        kcalLabel: m.totalCalories > 0 ? formatKcal(m.totalCalories) : '',
        nutritionStatus: m.nutritionStatus || 'unknown',
      })),
      menuCount: ms.length,
      hasMenu: ms.length > 0,
      hasMissingNutrition: hasMissing,
    };
  },

  /** 构建周视图 */
  buildWeekBars(menus: MenuListItem[]): WeekDayBar[] {
    const dayGroups = this.groupByDate(menus);
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

    // 本周一
    const todayDayOfWeek = today.getDay(); // 0=Sun
    const mondayOffset = todayDayOfWeek === 0 ? -6 : 1 - todayDayOfWeek;
    const monday = new Date(today);
    monday.setDate(today.getDate() + mondayOffset);

    const bars: WeekDayBar[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const ms = dayGroups[date] || [];
      let totalCal = 0;
      let ns: string = 'unknown';
      for (const m of ms) {
        if (m.totalCalories) totalCal += m.totalCalories;
        if (m.nutritionStatus === 'partial') ns = 'partial';
        else if (m.nutritionStatus === 'complete' && ns !== 'partial') ns = 'complete';
      }
      bars.push({
        date: date,
        dayLabel: WEEKDAY_NAMES[d.getDay()],
        dayNum: d.getDate(),
        isToday: date === todayStr,
        totalCalories: totalCal,
        kcalLabel: totalCal > 0 ? formatKcal(totalCal) : '',
        menuCount: ms.length,
        nutritionStatus: ns,
      });
    }
    return bars;
  },

  /* ============================== 月历导航 ============================== */

  onPrevMonth() {
    let { calendarYear, calendarMonth } = this.data;
    if (calendarMonth === 1) {
      calendarMonth = 12;
      calendarYear--;
    } else {
      calendarMonth--;
    }
    this.setData({ calendarYear, calendarMonth }, () => { void this.loadCalendarMonth(); });
  },

  onNextMonth() {
    let { calendarYear, calendarMonth } = this.data;
    if (calendarMonth === 12) {
      calendarMonth = 1;
      calendarYear++;
    } else {
      calendarMonth++;
    }
    this.setData({ calendarYear, calendarMonth }, () => { void this.loadCalendarMonth(); });
  },

  /* ============================== 日历模式切换 ============================== */

  onCalendarMode(e: WechatMiniprogram.TouchEvent) {
    const mode = e.currentTarget.dataset.mode as CalendarMode;
    this.setData({ calendarMode: mode });
  },

  /* ============================== 日视图 ============================== */

  onDayTap(e: WechatMiniprogram.TouchEvent) {
    const date = String(e.currentTarget.dataset.date || '');
    if (!date) return;

    // 查找当日菜单
    const menus = this.data.calendarDays
      .filter((d) => d.date === date)
      .flatMap((d) => d.menus.map((m) => ({
        _id: m._id,
        menuId: m._id,
        mealType: m.mealType,
        mealTypeLabel: m.mealTypeLabel,
        dishCount: m.dishCount,
        totalCalories: m.totalCalories,
        nutritionStatus: m.nutritionStatus,
      } as HistoryMenuView)));

    this.setData({
      selectedDate: date,
      selectedDateLabel: date,
      selectedDayMenus: menus.map((m) => ({
        ...m,
        dishSummary: '',
        statusLabel: STATUS_LABELS['confirmed'] || '已确认',
        kcalLabel: m.totalCalories > 0 ? formatKcal(m.totalCalories) : '',
      })),
    });
  },

  onCloseDay() {
    this.setData({ selectedDate: '', selectedDayMenus: [] });
  },

  /* ============================== 导航 ============================== */

  onOpenMenu(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id || '');
    if (!id) return;
    wx.navigateTo({ url: '/pages/menu-detail/index?menuId=' + id });
  },

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