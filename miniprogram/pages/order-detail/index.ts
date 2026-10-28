import { orderService } from '../../services/order';
import { getErrorMessage, getErrorCode } from '../../utils/cloud';
import type { OrderItemSelection, OrderSummary } from '../../types/order';

interface RecipeWithSelection {
  recipeId: string;
  name: string;
  description: string;
  category: string;
  cookTime: string;
  selected: boolean;
  quantity: number;
  note: string;
}

Page({
  data: {
    orderId: '',
    loading: true,
    error: '',

    /* 订单基本信息 */
    title: '',
    status: '',
    deadline: '',
    note: '',
    closedAt: '',
    editable: false,
    canManage: false,

    /* 菜品列表 */
    recipes: [] as RecipeWithSelection[],

    /* 汇总 */
    summary: null as OrderSummary | null,
    showSummary: false,

    /* 操作状态 */
    saving: false,
    closing: false,
    closed: false,
  },

  onLoad(query: Record<string, string | undefined>) {
    const orderId = query.orderId || '';
    if (!orderId) {
      this.setData({ loading: false, error: '缺少点单 ID' });
      return;
    }
    this.setData({ orderId: orderId });
    void this.loadDetail();
  },

  onShow() {
    if (this.data.orderId) {
      void this.loadDetail();
    }
  },

  /* ============================== 加载 ============================== */

  async loadDetail() {
    this.setData({ loading: true, error: '' });
    try {
      const detail = await orderService.getDetail(this.data.orderId);

      // 转换菜品 + 已有选择
      const myMap: Record<string, OrderItemSelection> = {};
      for (const sel of (detail.mySelections || [])) {
        myMap[sel.recipeId] = sel;
      }

      const recipes = (detail.recipes || []).map((r) => {
        const sel = myMap[r.recipeId];
        return {
          recipeId: r.recipeId,
          name: r.name,
          description: r.description,
          category: r.category,
          cookTime: r.cookTime ? '约 ' + r.cookTime + ' 分钟' : '',
          selected: !!sel,
          quantity: sel ? sel.quantity : 1,
          note: sel ? sel.note : '',
        };
      });

      this.setData({
        loading: false,
        title: detail.order.title,
        status: detail.order.status,
        deadline: detail.order.deadline || '',
        note: detail.order.note || '',
        closedAt: detail.order.closedAt || '',
        editable: detail.editable,
        canManage: detail.canManage,
        closed: detail.order.status === 'closed',
        recipes: recipes,
      });
    } catch (error) {
      this.setData({ loading: false, error: getErrorMessage(error, '加载失败') });
    }
  },

  /* ============================== 菜品选择 ============================== */

  onToggleSelect(e: WechatMiniprogram.TouchEvent) {
    if (!this.data.editable) return;
    const recipeId = String(e.currentTarget.dataset.recipeId || '');
    const recipes = this.data.recipes.map((r) =>
      r.recipeId === recipeId ? { ...r, selected: !r.selected, quantity: r.selected ? 0 : 1 } : r,
    );
    this.setData({ recipes: recipes });
  },

  onQuantityChange(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const recipeId = String(e.currentTarget.dataset.recipeId || '');
    let value = parseInt(e.detail.value, 10);
    if (isNaN(value) || value < 1) value = 1;
    if (value > 20) value = 20;

    const recipes = this.data.recipes.map((r) =>
      r.recipeId === recipeId ? { ...r, quantity: value } : r,
    );
    this.setData({ recipes: recipes });
  },

  onNoteInput(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const recipeId = String(e.currentTarget.dataset.recipeId || '');
    const value = (e.detail.value || '').slice(0, 100);
    const recipes = this.data.recipes.map((r) =>
      r.recipeId === recipeId ? { ...r, note: value } : r,
    );
    this.setData({ recipes: recipes });
  },

  /* ============================== 提交 ============================== */

  async onSubmit() {
    if (!this.data.editable) return;
    if (this.data.saving) return;

    const items = this.data.recipes
      .filter((r) => r.selected)
      .map((r) => ({
        recipeId: r.recipeId,
        quantity: r.quantity,
        note: r.note,
      }));

    this.setData({ saving: true });

    try {
      await orderService.submitItems({ orderId: this.data.orderId, items: items });
      this.setData({ saving: false });
      wx.showToast({ title: '已保存 ' + items.length + ' 道菜', icon: 'success' });
    } catch (error) {
      this.setData({ saving: false });
      wx.showToast({ title: getErrorMessage(error, '保存失败'), icon: 'none' });
    }
  },

  /* ============================== 管理员：查看汇总 ============================== */

  async onViewSummary() {
    this.setData({ loading: true });
    try {
      const summary = await orderService.getSummary(this.data.orderId);
      this.setData({ loading: false, summary: summary, showSummary: true });
    } catch (error) {
      this.setData({ loading: false });
      wx.showToast({ title: getErrorMessage(error), icon: 'none' });
    }
  },

  onCloseSummary() {
    this.setData({ showSummary: false });
  },

  /* ============================== 管理员：关闭点单 ============================== */

  async onCloseOrder() {
    if (this.data.closing) return;

    const result = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: '关闭点单',
        content: '关闭后家庭成员将不能再修改选择。需要所有家人都点完才能关闭，确定现在关闭？',
        success: (res) => resolve(res.confirm),
      });
    });

    if (!result) return;

    this.setData({ closing: true });

    try {
      const res = await orderService.close(this.data.orderId);

      this.setData({
        closing: false,
        closed: true,
        status: 'closed',
        editable: false,
        summary: {
          orderId: this.data.orderId,
          title: this.data.title,
          status: 'closed',
          deadline: this.data.deadline,
          totalParticipants: res.totalParticipants,
          totalDishes: res.dishSummary.length,
          dishSummary: res.dishSummary,
          memberSummary: [],
          unsubmittedCount: 0,
        },
        showSummary: true,
      });

      wx.showToast({ title: '点单已关闭', icon: 'success' });
    } catch (error) {
      this.setData({ closing: false });
      const message = getErrorMessage(error, '关闭失败');
      // 还有家人没点单：这条信息较长，用弹窗而不是 toast，避免被截断
      if (getErrorCode(error) === 'ORDER_NOT_ALL_COMPLETED') {
        wx.showModal({ title: '还不能关闭', content: message, showCancel: false });
      } else {
        wx.showToast({ title: message, icon: 'none' });
      }
    }
  },

  /* ============================== 导航 ============================== */

  /** Phase 11：从点单菜品进入菜谱详情（查看/生成做法） */
  onOpenRecipe(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.recipeId || '');
    if (!id) return;
    const name = String(e.currentTarget.dataset.name || '');
    const url = '/pages/recipes/detail?id=' + id + (name ? '&name=' + encodeURIComponent(name) : '');
    wx.navigateTo({ url: url });
  },

  /* ============================== 分享 ============================== */

  onShareAppMessage() {
    return {
      title: '「' + this.data.title + '」— 来点菜吧！',
      path: '/pages/order-detail/index?orderId=' + this.data.orderId,
    };
  },
});