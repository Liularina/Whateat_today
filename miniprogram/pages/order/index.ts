import { orderService } from '../../services/order';
import { getErrorMessage } from '../../utils/cloud';
import type { OrderListItem, OrderListResult, OrderStatus } from '../../types/order';

type StatusFilter = 'all' | 'open' | 'closed';

Page({
  data: {
    hasFamily: false,
    familyId: '',
    orders: [] as OrderListItem[],
    loading: true,
    error: '',
    page: 1,
    hasMore: false,
    statusFilter: 'all' as StatusFilter,
  },

  onShow() {
    const app = getApp<IAppOption>();
    const family = app.globalData.family;
    if (!family || !family._id) {
      this.setData({ hasFamily: false, loading: false });
      return;
    }
    this.setData({ hasFamily: true, familyId: family._id, page: 1 });
    void this.loadOrders();
  },

  /* ============================== 筛选 ============================== */

  onSwitchFilter(e: WechatMiniprogram.TouchEvent) {
    const filter = e.currentTarget.dataset.filter as StatusFilter;
    if (filter === this.data.statusFilter) return;
    this.setData({ statusFilter: filter, page: 1 }, () => {
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

      this.setData({
        loading: false,
        page: 1,
        orders: result.items || [],
        hasMore: result.page * result.pageSize < result.total,
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
    wx.navigateTo({ url: '/pages/order-detail/index?orderId=' + id });
  },

  /** 分享 */
  onShareOrder(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id || '');
    return {
      title: '来点菜吧！',
      path: '/pages/order-detail/index?orderId=' + id,
    };
  },
});