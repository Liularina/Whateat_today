import { orderService } from '../../services/order';
import { getErrorMessage } from '../../utils/cloud';
import type { OrderListItem, OrderListResult, OrderStatus } from '../../types/order';

type StatusFilter = 'all' | 'open' | 'closed';

/** 删除确认与按钮统一用橙色，与「破坏性操作」的视觉语言保持一致 */
const DELETE_COLOR = '#e8850c';

/** 统计列表中「已关闭」的点单数 —— 只有这些可以被勾选删除 */
function countClosed(list: OrderListItem[]): number {
  let count = 0;
  for (const item of list) {
    if (item.status === 'closed') count += 1;
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
  },

  _unsubscribeAuth: null as null | (() => void),
  _unsubscribeFamily: null as null | (() => void),

  onLoad() {
    const app = getApp<IAppOption>();
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
      this.setData({ orders: [], loading: false });
      return;
    }

    this.setData({ page: 1 });
    void this.loadOrders();
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
      });
    } catch (_e) {
      this.setData({ loading: false });
    }
  },

  /* ============================== 创建 ============================== */

  onCreateOrder() {
    if (!this.data.familyId) {
      wx.showToast({ title: '请先创建或加入家庭', icon: 'none' });
      return;
    }
    // 跳转到推荐页确认菜单后再发起
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