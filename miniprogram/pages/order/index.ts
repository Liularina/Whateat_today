import { orderService } from '../../services/order';
import { mealPlanService } from '../../services/meal-plan';
import { getErrorMessage } from '../../utils/cloud';
import { inferMealTypeByHour } from '../../utils/formatter';
import type { MealType } from '../../types/menu';
import type { MealBoard, DishSuggestionView, DishVote } from '../../types/meal-plan';
import { menuService } from '../../services/menu';
import type { OrderListItem, OrderListResult, OrderStatus } from '../../types/order';

type StatusFilter = 'all' | 'open' | 'closed';

/** 删除确认与按钮统一用橙色，与「破坏性操作」的视觉语言保持一致 */
const DELETE_COLOR = '#e8850c';

const MEAL_LABELS: Record<MealType, string> = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  midnight_snack: '夜宵',
};

const MEAL_TABS: { value: MealType; label: string }[] = [
  { value: 'breakfast', label: '早餐' },
  { value: 'lunch', label: '午餐' },
  { value: 'dinner', label: '晚餐' },
  { value: 'midnight_snack', label: '夜宵' },
];

/** 统计列表中「已关闭」的点单数 —— 只有这些可以被勾选删除 */
function countClosed(list: OrderListItem[]): number {
  let count = 0;
  for (const item of list) {
    if (item.status === 'closed') count += 1;
  }
  return count;
}


/** 本地兜底：服务端未返回 openTotal 时，按当前页估算进行中数量 */
function countOpen(list: OrderListItem[]): number {
  let count = 0;
  for (const item of list) {
    if (item.status !== 'closed') count += 1;
  }
  return count;
}

Page({
  data: {
    familyReady: false,
    hasFamily: false,
    familyId: '',
    orders: [] as OrderListItem[],
    loading: true,
    error: '',
    page: 1,
    hasMore: false,
    statusFilter: 'all' as StatusFilter,

    /* ---- 选择删除 ---- */
    /** 管理态：卡片点击变为勾选，底部切换为删除操作 */
    manageMode: false,
    /** orderId → 是否勾选 */
    selectedMap: {} as Record<string, boolean>,
    selectedCount: 0,
    /** 当前列表中可勾选（已关闭）的点单数 */
    selectableCount: 0,
    deleting: false,
    /** 列表中还有进行中的点单（管理员可一键收尾，之后才能删除） */
    openOrderCount: 0,
    cleaningOrders: false,

    /* ---- 今日方案（Phase 1：家庭共享方案 + 偏好） ---- */
    boardLoading: false,
    boardError: '',
    /** 本餐次是否有共享方案 */
    boardAvailable: false,
    boardMealType: 'dinner' as MealType,
    boardMealLabel: '晚餐',
    mealTabs: MEAL_TABS,
    boardDate: '',
    boardCookName: '',
    boardIsCook: false,
    boardIsOwner: false,
    boardMembers: [] as { userId: string; nickname: string; isCook: boolean }[],
    boardCanRegenerate: false,
    boardCanSetCook: false,
    boardCanTakeOver: false,
    boardCanConfirm: false,
    boardStatus: '' as '' | 'open' | 'confirmed',
    boardPlanId: '',
    /** 已锁定的最终菜单 */
    boardMenuId: '',
    /** 掌勺人已保存、还没锁定的点单 */
    boardDraftMenuId: '',
    boardHasDraft: false,
    /** 掌勺人保存的点单里的菜品 + 家人建议 */
    boardDishes: [] as DishSuggestionView[],
    boardParticipantCount: 0,
    boardMemberCount: 0,
    boardMissingText: '',
    /** 我正在提交建议 / 锁定菜单 */
    boardSaving: false,
    boardConfirming: false,
    /** 我的留言（可选） */
    boardNote: '',
  },

  _unsubscribeAuth: null as null | (() => void),
  _unsubscribeFamily: null as null | (() => void),

  onLoad() {
    const app = getApp<IAppOption>();
    this.setData({
      boardMealType: inferMealTypeByHour(),
      boardMealLabel: MEAL_LABELS[inferMealTypeByHour()] || '晚餐',
    });
    const authListener = () => { this.applyAuthState(app.getAuthState()); };
    this._unsubscribeAuth = () => app.offAuthStateChange(authListener);
    app.onAuthStateChange(authListener);

    const familyListener = () => { this.applyFamilyState(app.getFamilyState()); };
    this._unsubscribeFamily = () => app.offFamilyStateChange(familyListener);
    app.onFamilyStateChange(familyListener);

    this.applyAuthState(app.getAuthState());
    this.applyFamilyState(app.getFamilyState());
  },

  onUnload() {
    if (this._unsubscribeAuth) { this._unsubscribeAuth(); this._unsubscribeAuth = null; }
    if (this._unsubscribeFamily) { this._unsubscribeFamily(); this._unsubscribeFamily = null; }
  },

  onShow() {
    const app = getApp<IAppOption>();
    this.applyAuthState(app.getAuthState());
    this.applyFamilyState(app.getFamilyState());
  },

  applyAuthState(_state: unknown) {},

  applyFamilyState(state: import('../../types/family').FamilyState) {
    this.setData({ familyReady: state.ready });
    if (!state.ready) return;

    const hasFamily = state.isInFamily && !!state.family;
    const newId = state.family ? state.family._id : '';
    this.setData({ hasFamily: hasFamily, familyId: newId });

    if (!hasFamily) {
      this.setData({
        orders: [], loading: false,
        boardAvailable: false, boardDishes: [], boardHasDraft: false, boardCookName: '',
        boardIsCook: false, boardIsOwner: false, boardMembers: [], boardStatus: '',
        boardPlanId: '', boardMenuId: '', boardDraftMenuId: '', boardCanConfirm: false,
        boardCanSetCook: false, boardCanRegenerate: false,
      });
      return;
    }

    this.setData({ page: 1 });
    void this.loadOrders();
    void this.loadBoard();
  },

  /* 保留原 onShow 废弃，态管理已移入 subscription */

  /* ============================== 筛选 ============================== */

  onSwitchFilter(e: WechatMiniprogram.TouchEvent) {
    const filter = e.currentTarget.dataset.filter as StatusFilter;
    if (filter === this.data.statusFilter) return;
    // 切换筛选后勾选已失效（列表换了），一并退出管理态
    this.setData({
      statusFilter: filter,
      page: 1,
      manageMode: false,
      selectedMap: {},
      selectedCount: 0,
    }, () => {
      void this.loadOrders();
    });
  },

  /* ============================== 加载 ============================== */

  async loadOrders() {
    this.setData({ loading: true, error: '' });
    try {
      const params: { familyId: string; page: number; pageSize: number; status?: OrderStatus } = {
        familyId: this.data.familyId,
        page: 1,
        pageSize: 10,
      };
      if (this.data.statusFilter !== 'all') {
        params.status = this.data.statusFilter;
      }

      const result: OrderListResult = await orderService.listOrders(params);

      const orders = result.items || [];
      this.setData({
        loading: false,
        page: 1,
        orders: orders,
        hasMore: result.page * result.pageSize < result.total,
        selectableCount: countClosed(orders),
        // 首屏同样要计算：漏掉这里会让「收尾进行中」入口永远不出现
        openOrderCount: typeof result.openTotal === 'number'
          ? result.openTotal
          : countOpen(orders),
      });
    } catch (e) {
      this.setData({ loading: false, error: getErrorMessage(e, '加载失败') });
    }
  },

  /** 触底加载更多 */
  onReachBottom() {
    if (!this.data.hasMore || this.data.loading) return;
    void this.loadMore();
  },

  async loadMore() {
    this.setData({ loading: true });
    try {
      const params: { familyId: string; page: number; pageSize: number; status?: OrderStatus } = {
        familyId: this.data.familyId,
        page: this.data.page + 1,
        pageSize: 10,
      };
      if (this.data.statusFilter !== 'all') {
        params.status = this.data.statusFilter;
      }

      const result: OrderListResult = await orderService.listOrders(params);
      const orders = [...this.data.orders, ...(result.items || [])];

      this.setData({
        loading: false,
        page: result.page,
        orders: orders,
        hasMore: result.page * result.pageSize < result.total,
        selectableCount: countClosed(orders),
        // 进行中数量以服务端为准（本地只有当前页，算不全）。
        // 服务端未返回 openTotal 时（如云函数尚未更新），退回本地计数，
        // 宁可多显示一次入口，也不要让存量点单彻底没有收尾的路径。
        openOrderCount: typeof result.openTotal === 'number'
          ? result.openTotal
          : countOpen(orders),
      });
    } catch (_e) {
      this.setData({ loading: false });
    }
  },

  /* ============================== 今日方案（Phase 1） ============================== */

  /** 读取本餐次共享方案 + 偏好汇总 */
  async loadBoard() {
    if (!this.data.familyId) return;
    this.setData({ boardLoading: true, boardError: '' });
    try {
      const board: MealBoard = await mealPlanService.getBoard(
        this.data.familyId, this.data.boardMealType,
      );
      this.applyBoard(board);
    } catch (e) {
      this.setData({
        boardLoading: false,
        boardAvailable: false,
        boardError: getErrorMessage(e, '方案加载失败'),
      });
    }
  },

  applyBoard(board: MealBoard) {
    const plan = board.plan;
    if (!board.available) {
      // 集合尚未创建：不显示看板，避免误导
      this.setData({
        boardLoading: false,
        boardAvailable: false,
        boardDishes: [],
        boardHasDraft: false,
        boardCanConfirm: false,
        boardCanSetCook: false,
      });
      return;
    }
    if (!plan) {
      this.setData({
        boardLoading: false,
        boardAvailable: true,
        boardStatus: '',
        boardHasDraft: false,
        boardDishes: [],
        boardCookName: '',
        boardIsCook: false,
        boardIsOwner: !!board.isOwner,
        boardMembers: board.members || [],
        boardCanRegenerate: false,
        boardCanSetCook: false,
        boardCanConfirm: false,
        boardPlanId: '',
        boardMenuId: '',
        boardDraftMenuId: '',
        boardDate: board.date,
        boardParticipantCount: 0,
        boardMemberCount: board.members.length,
        boardMissingText: '',
        boardMealLabel: MEAL_LABELS[board.mealType] || '晚餐',
      });
      return;
    }

    const summary = board.summary;
    const my = summary && summary.my;

    // 建议文本：直接告诉掌勺人「谁想吃 / 谁不想吃」，
    // 比只给数字更容易做决定。
    const dishes: DishSuggestionView[] = (summary && summary.dishes ? summary.dishes : []).map((stat) => ({
      recipeId: stat.recipeId,
      name: stat.name,
      meta: '',
      wantCount: stat.wantCount,
      avoidCount: stat.avoidCount,
      myVote: stat.myVote,
      wantText: stat.wantBy.length > 0 ? stat.wantBy.join('、') + ' 想吃' : '',
      avoidText: stat.avoidBy.length > 0 ? stat.avoidBy.join('、') + ' 不想吃' : '',
    }));

    // 菜品标签放在菜单里（草稿菜单才有 cookTime 等信息）
    const metaMap: Record<string, string> = {};
    if (board.draft) {
      for (const item of board.draft.items) {
        if (item.cookTime) metaMap[item.recipeId] = '约 ' + item.cookTime + ' 分钟';
        else if (item.category) metaMap[item.recipeId] = item.category;
      }
    }
    for (const dish of dishes) {
      dish.meta = metaMap[dish.recipeId] || '';
    }

    this.setData({
      boardLoading: false,
      boardAvailable: true,
      boardStatus: plan.status,
      boardDate: plan.date,
      boardCookName: plan.cookName || '',
      boardIsCook: board.isCook,
      boardIsOwner: !!board.isOwner,
      boardMembers: board.members || [],
      boardCanRegenerate: board.canRegenerate,
      boardCanSetCook: board.canSetCook,
      boardCanTakeOver: board.canTakeOver,
      boardCanConfirm: board.canConfirm,
      boardPlanId: plan.planId,
      boardMenuId: plan.menuId || '',
      boardDraftMenuId: plan.draftMenuId || '',
      boardHasDraft: !!board.draft,
      boardDishes: dishes,
      boardParticipantCount: summary ? summary.participantCount : 0,
      boardMemberCount: summary ? summary.memberCount : 0,
      boardMissingText: summary
        ? (summary.missingMembers.length > 0
          ? summary.missingMembers.join('、') + ' 还没提建议'
          : '家人都已表态')
        : '',
      boardMealLabel: MEAL_LABELS[plan.mealType] || '晚餐',
      boardNote: my ? my.note : '',
    });
  },

  onSwitchMeal(e: WechatMiniprogram.TouchEvent) {
    const mealType = e.currentTarget.dataset.value as MealType;
    if (!mealType || mealType === this.data.boardMealType) return;
    this.setData({
      boardMealType: mealType,
      boardMealLabel: MEAL_LABELS[mealType] || '晚餐',
      boardDishes: [],
      boardStatus: '',
    }, () => { void this.loadBoard(); });
  },

  /** 提交我的菜品建议：同一成员同餐次复用一条记录 */
  async submitPreference(dishVotes: { recipeId: string; vote: DishVote }[]) {
    if (this.data.boardSaving || !this.data.boardPlanId) return;

    this.setData({ boardSaving: true });
    try {
      await mealPlanService.submitPreference({
        familyId: this.data.familyId,
        mealType: this.data.boardMealType,
        planId: this.data.boardPlanId,
        dishVotes: dishVotes,
        note: this.data.boardNote,
      });
      await this.loadBoard();
    } catch (e) {
      this.setData({ boardSaving: false });
      wx.showToast({ title: getErrorMessage(e, '提交失败'), icon: 'none' });
      return;
    }
    this.setData({ boardSaving: false });
  },

  /**
   * 想吃 / 不想吃某道菜。
   *
   * 这只是建议：菜单内容由掌勺人锁定，这里不会改变任何菜品。
   */
  onVoteDish(e: WechatMiniprogram.TouchEvent) {
    const recipeId = String(e.currentTarget.dataset.recipeId || '');
    const vote = e.currentTarget.dataset.vote as DishVote;
    if (!recipeId || !vote) return;
    if (this.data.boardStatus !== 'open') return;
    if (!this.data.boardHasDraft) {
      wx.showToast({ title: '掌勺人还没保存点单', icon: 'none' });
      return;
    }

    const current = this.data.boardDishes.find((dish) => dish.recipeId === recipeId);
    const nextVote: DishVote = current && current.myVote === vote ? 'none' : vote;

    const votes: { recipeId: string; vote: DishVote }[] = [];
    for (const dish of this.data.boardDishes) {
      const finalVote = dish.recipeId === recipeId ? nextVote : dish.myVote;
      if (finalVote !== 'none') votes.push({ recipeId: dish.recipeId, vote: finalVote });
    }
    void this.submitPreference(votes);
  },

  /** 保存留言 */
  async onSaveNote() {
    if (!this.data.boardPlanId) return;
    const votes = this.data.boardDishes
      .filter((dish) => dish.myVote !== 'none')
      .map((dish) => ({ recipeId: dish.recipeId, vote: dish.myVote }));
    await this.submitPreference(votes);
    wx.showToast({ title: '留言已保存', icon: 'none' });
  },

  /**
   * 掌勺人锁定菜单。
   *
   * 不要求家人全部提完建议：掌勺人随时可以拍板，
   * 少数还没表态的家人不影响这一餐开火。
   */
  onLockMenu() {
    if (this.data.boardConfirming || !this.data.boardDraftMenuId) return;

    const missing = (this.data.boardMissingText || '').replace(' 还没提建议', '');
    wx.showModal({
      title: '锁定菜单？',
      content: missing
        ? missing + ' 还没提建议，锁定后不能再改。也可以再等等。'
        : '锁定后菜单就定了，之后不能再调整。',
      confirmText: '锁定',
      success: (res) => {
        if (!res.confirm) return;
        void this.confirmDraftMenu();
      },
    });
  },

  async confirmDraftMenu() {
    this.setData({ boardConfirming: true });
    wx.showLoading({ title: '锁定中…', mask: true });
    try {
      await menuService.confirmMenu(this.data.boardDraftMenuId, this.data.familyId);
      wx.hideLoading();
      this.setData({ boardConfirming: false });
      wx.showToast({ title: '菜单已锁定', icon: 'success' });
      await this.loadBoard();
    } catch (err) {
      wx.hideLoading();
      this.setData({ boardConfirming: false });
      wx.showToast({ title: getErrorMessage(err, '锁定失败'), icon: 'none' });
    }
  },

  /** 掌勺人还没保存点单时：去推荐页挑菜 */
  onGoSaveOrder() {
    wx.navigateTo({
      url: '/pages/recommend/index?auto=1&mealType=' + this.data.boardMealType,
    });
  },

  /** 已锁定菜单要换：必须掌勺人二次确认，旧菜单保留为历史 */
  onReplaceConfirmed() {
    wx.showModal({
      title: '重新生成本餐次？',
      content: '当前已锁定的菜单会保留为历史；新方案需要你再次保存并锁定后才会生效。',
      confirmText: '重新生成',
      success: (res) => {
        if (!res.confirm) return;
        wx.navigateTo({
          url: '/pages/recommend/index?auto=1&force=1&replace=1&mealType=' + this.data.boardMealType,
        });
      },
    });
  },

  /** 交接掌勺人（只有当前掌勺人能看到这个入口） */
  onChangeCook() {
    const others = (this.data.boardMembers || []).filter((m) => !m.isCook);
    if (others.length === 0) {
      wx.showToast({ title: '没有其他家人可以交接', icon: 'none' });
      return;
    }
    wx.showActionSheet({
      itemList: others.map((m) => m.nickname),
      success: (res) => {
        const target = others[res.tapIndex];
        if (!target) return;
        void this.assignCook(target.userId, target.nickname);
      },
      fail: () => {},
    });
  },

  async assignCook(cookId: string, cookName: string) {
    this.setData({ boardSaving: true });
    try {
      await mealPlanService.setCook({
        familyId: this.data.familyId,
        mealType: this.data.boardMealType,
        cookId: cookId,
      });
      await this.loadBoard();
      wx.showToast({ title: '掌勺人已交给 ' + cookName, icon: 'none' });
    } catch (e) {
      wx.showToast({ title: getErrorMessage(e, '交接失败'), icon: 'none' });
    }
    this.setData({ boardSaving: false });
  },

  /** 掌勺人换一批方案：跳到推荐页自动重新生成 */
  onRegeneratePlans() {
    wx.navigateTo({
      url: '/pages/recommend/index?auto=1&force=1&mealType=' + this.data.boardMealType,
    });
  },

  onGoRecommend() {
    wx.navigateTo({
      url: '/pages/recommend/index?auto=1&mealType=' + this.data.boardMealType,
    });
  },

  onOpenBoardMenu() {
    if (!this.data.boardMenuId) return;
    wx.navigateTo({ url: '/pages/menu-detail/index?menuId=' + this.data.boardMenuId });
  },

  onOpenShopping() {
    if (!this.data.boardMenuId) return;
    wx.navigateTo({ url: '/pages/shopping/index?menuId=' + this.data.boardMenuId });
  },

  onNoteInput(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ boardNote: String(e.detail.value || '').slice(0, 50) });
  },

  /* ============================== 创建 ============================== */

  /**
   * 本餐次还没有最终菜单时：引导掌勺人先保存点单。
   *
   * 新流程不再创建「份数点单」：家人直接在点菜页对已保存的点单表态，
   * 掌勺人锁定菜单即可开火。
   */
  onCreateOrder() {
    if (this.data.boardHasDraft) {
      wx.showToast({ title: '菜单已保存，等家人提建议后锁定即可', icon: 'none' });
      return;
    }
    if (this.data.boardStatus === 'open' && !this.data.boardIsCook) {
      wx.showToast({ title: '等掌勺人保存点单', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/recommend/index' });
  },

  /* ============================== 导航 ============================== */

  onOpenOrder(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id || '');
    if (!id) return;
    // 管理态下卡片点击是勾选，不进详情
    if (this.data.manageMode) {
      this.toggleSelect(id);
      return;
    }
    wx.navigateTo({ url: '/pages/order-detail/index?orderId=' + id });
  },

  /* ============================== 选择删除 ============================== */

  /**
   * 一键收尾历史遗留的「进行中」点单（仅家庭管理员）。
   *
   * 这些点单来自已废弃的份数点单功能，永远等不到「全员提交」，
   * 不先关闭就永远不能删除。
   */
  onCleanupOpenOrders() {
    if (this.data.cleaningOrders) return;

    // 不在这里报具体条数：列表是分页加载的，本地数量可能少于实际，
    // 真正的数量由云函数返回，避免给出误导性的数字。
    wx.showModal({
      title: '收尾进行中的点单',
      content: '将把本家庭所有进行中的点单标记为已关闭，之后就可以勾选删除。'
        + '关闭不会删除任何数据。',
      confirmText: '全部关闭',
      success: (res) => {
        if (!res.confirm) return;
        void this.cleanupOpenOrders();
      },
    });
  },

  async cleanupOpenOrders() {
    this.setData({ cleaningOrders: true });
    wx.showLoading({ title: '正在收尾...', mask: true });
    try {
      const result = await orderService.cleanupOpenOrders(this.data.familyId);
      wx.hideLoading();
      this.setData({ cleaningOrders: false, page: 1 });
      wx.showToast({
        title: '已关闭 ' + (result.closedCount || 0) + ' 条',
        icon: 'none',
      });
      await this.loadOrders();
      if (result.hasMore) {
        wx.showToast({ title: '还有更多，可再点一次', icon: 'none' });
      }
    } catch (error) {
      wx.hideLoading();
      this.setData({ cleaningOrders: false });
      wx.showToast({ title: getErrorMessage(error, '收尾失败'), icon: 'none' });
    }
  },

  onToggleManage() {
    const next = !this.data.manageMode;
    this.setData({
      manageMode: next,
      selectedMap: {},
      selectedCount: 0,
    });
  },

  /** 勾选 / 取消勾选：只有已关闭的点单可勾选，未关闭的给明确提示 */
  toggleSelect(orderId: string) {
    const item = this.data.orders.filter((o) => o.orderId === orderId)[0];
    if (!item) return;

    if (item.status !== 'closed') {
      wx.showToast({ title: '进行中的点单需先关闭才能删除', icon: 'none' });
      return;
    }

    const selectedMap: Record<string, boolean> = Object.assign({}, this.data.selectedMap);
    if (selectedMap[orderId]) {
      delete selectedMap[orderId];
    } else {
      selectedMap[orderId] = true;
    }
    this.setData({ selectedMap: selectedMap, selectedCount: Object.keys(selectedMap).length });
  },

  /** 全选可勾选的点单；已全选时再点则取消全选 */
  onSelectAllClosed() {
    const closedIds = this.data.orders
      .filter((o) => o.status === 'closed')
      .map((o) => o.orderId);
    const allSelected =
      closedIds.length > 0 && closedIds.every((id) => this.data.selectedMap[id]);

    const selectedMap: Record<string, boolean> = {};
    if (!allSelected) {
      for (const id of closedIds) {
        selectedMap[id] = true;
      }
    }
    this.setData({ selectedMap: selectedMap, selectedCount: Object.keys(selectedMap).length });
  },

  onDeleteSelected() {
    const ids = Object.keys(this.data.selectedMap);
    if (ids.length === 0) {
      wx.showToast({ title: '请先勾选要删除的点单', icon: 'none' });
      return;
    }

    wx.showModal({
      title: '删除点单',
      content:
        '将删除选中的 ' + ids.length + ' 条已关闭点单。' +
        '删除后不保留历史记录，也无法恢复。',
      confirmText: '确认删除',
      confirmColor: DELETE_COLOR,
      success: (res) => {
        if (res.confirm) {
          void this.deleteSelected(ids);
        }
      },
    });
  },

  async deleteSelected(ids: string[]) {
    if (this.data.deleting) return;
    this.setData({ deleting: true });
    wx.showLoading({ title: '正在删除...', mask: true });

    try {
      const result = await orderService.deleteOrders(this.data.familyId, ids);
      wx.hideLoading();
      const count =
        result && typeof result.deletedCount === 'number' ? result.deletedCount : ids.length;
      this.setData({
        deleting: false,
        manageMode: false,
        selectedMap: {},
        selectedCount: 0,
        page: 1,
      });
      wx.showToast({ title: '已删除 ' + count + ' 条', icon: 'none' });
      await this.loadOrders();
    } catch (error) {
      wx.hideLoading();
      this.setData({ deleting: false });
      wx.showToast({ title: getErrorMessage(error, '删除失败，请稍后重试'), icon: 'none' });
    }
  },

  /** 分享 */
  onShareOrder(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id || '');
    // 管理态下不发分享
    if (this.data.manageMode) return;
    return {
      title: '来点菜吧！',
      path: '/pages/order-detail/index?orderId=' + id,
    };
  },
});