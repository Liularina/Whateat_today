import { DIFFICULTY_LABELS } from '../../constants/config';
import type { RecommendMenusResult, RecommendMenuView, RecommendRecipeView, SavedMenuItem } from '../../types/ai-config';
import { menuService } from '../../services/menu';
import { orderService } from '../../services/order';
import { getErrorCode, getErrorMessage } from '../../utils/cloud';

interface DishViewModel {
  recipeId: string;
  name: string;
  description: string;
  category: string;
  difficultyLabel: string;
  cookTime: string;
  ingredientsText: string;
  tagsText: string;
  locked: boolean;
}

interface MenuViewModel {
  title: string;
  reason: string;
  totalCookTime: string;
  dishes: DishViewModel[];
}

function toMenuView(menu: RecommendMenuView): MenuViewModel {
  return {
    title: menu.title,
    reason: menu.reason,
    totalCookTime: '约 ' + (menu.totalCookTime || 0) + ' 分钟',
    dishes: (menu.items || []).map((item: RecommendRecipeView) => ({
      recipeId: item._id,
      name: item.name,
      description: item.description,
      category: item.category,
      difficultyLabel: DIFFICULTY_LABELS[item.difficulty] || item.difficulty,
      cookTime: item.cookTime ? '约 ' + item.cookTime + ' 分钟' : '',
      ingredientsText: (item.ingredients || []).map((i) => i.name).join('、'),
      tagsText: (item.tags || []).join(' · '),
      locked: false,
    })),
  };
}

function toDishView(item: SavedMenuItem): DishViewModel {
  return {
    recipeId: item.recipeId,
    name: item.name,
    description: item.description,
    category: item.category,
    difficultyLabel: DIFFICULTY_LABELS[item.difficulty] || item.difficulty,
    cookTime: item.cookTime ? '约 ' + item.cookTime + ' 分钟' : '',
    ingredientsText: (item.ingredients || []).map((i) => i.name + ' ' + (i.amount || '') + (i.unit || '')).join('、'),
    tagsText: (item.tags || []).join(' · '),
    locked: item.locked,
  };
}

Page({
  data: {
    /** 页面模式 */
    mode: 'selection' as 'selection' | 'interactive' | 'confirmed',

    /* ---- 选择模式 ---- */
    mealTypeLabel: '',
    servings: 0,
    menuCount: 0,
    menus: [] as MenuViewModel[],

    /* ---- 交互模式 ---- */
    menuId: '',
    familyId: '',
    interactiveTitle: '',
    interactiveDishes: [] as DishViewModel[],
    totalCookTime: '',

    /* ---- 加载与错误 ---- */
    loading: false,
    errorMessage: '',
    savingMenu: false,

    /** 防止与确认态交互 */
    confirmed: false,
  },

  /* ============================== 生命周期 ============================== */

  onLoad() {
    const app = getApp<IAppOption>();
    const result = app.globalData.lastRecommendResult as RecommendMenusResult | undefined;

    if (!result || !result.menus || result.menus.length === 0) {
      this.setData({ errorMessage: '没有可展示的推荐结果，请返回重新推荐' });
      return;
    }

    const mealLabels: Record<string, string> = {
      breakfast: '早餐', lunch: '午餐', dinner: '晚餐', midnight_snack: '夜宵',
    };

    this.setData({
      mealTypeLabel: mealLabels[result.mealType] || result.mealType,
      servings: result.servings,
      menuCount: result.menus.length,
      menus: result.menus.map(toMenuView),
    });
  },

  /* ============================== 选择菜单 → 保存 → 进入交互 ============================== */

  async onSelectMenu(e: WechatMiniprogram.TouchEvent) {
    const index = Number(e.currentTarget.dataset.index);
    if (isNaN(index)) return;

    const app = getApp<IAppOption>();
    const result = app.globalData.lastRecommendResult as RecommendMenusResult | undefined;
    if (!result) return;

    const menu = result.menus[index];
    if (!menu || !menu.items || menu.items.length === 0) {
      wx.showToast({ title: '该菜单没有菜品', icon: 'none' });
      return;
    }

    const family = app.globalData.family;
    if (!family || !family._id) {
      wx.showToast({ title: '请先创建或加入家庭', icon: 'none' });
      return;
    }

    this.setData({ savingMenu: true });

    try {
      const saved = await menuService.saveMenu({
        familyId: family._id,
        mealType: result.mealType,
        servings: result.servings,
        items: menu.items,
      });

      this.setData({
        savingMenu: false,
        mode: 'interactive',
        menuId: saved.menuId || saved._id,
        familyId: family._id,
        interactiveTitle: menu.title,
        interactiveDishes: (saved.items || []).map(toDishView),
        totalCookTime: '约 ' + (menu.totalCookTime || 0) + ' 分钟',
        menus: [],
      });

      // 持久化 menuId 到全局
      app.globalData.currentMenuId = saved.menuId || saved._id;
    } catch (error) {
      this.setData({ savingMenu: false });
      wx.showModal({
        title: '保存失败',
        content: getErrorMessage(error, '菜单保存失败'),
        showCancel: false,
      });
    }
  },

  /* ============================== 锁定 / 取消锁定 ============================== */

  async onToggleLock(e: WechatMiniprogram.TouchEvent) {
    if (this.data.confirmed) return;

    const recipeId = String(e.currentTarget.dataset.recipeId || '');
    const currentLocked = Boolean(e.currentTarget.dataset.locked);
    if (!recipeId || !this.data.menuId) return;

    // 乐观更新 UI
    const dishes = this.data.interactiveDishes.map((d) =>
      d.recipeId === recipeId ? { ...d, locked: !currentLocked } : d,
    );
    this.setData({ interactiveDishes: dishes });

    try {
      await menuService.setMenuItemLocked(this.data.menuId, recipeId, !currentLocked, this.data.familyId);
    } catch (error) {
      // 回滚
      const rolled = this.data.interactiveDishes.map((d) =>
        d.recipeId === recipeId ? { ...d, locked: currentLocked } : d,
      );
      this.setData({ interactiveDishes: rolled });
      wx.showToast({ title: getErrorMessage(error, '操作失败'), icon: 'none' });
    }
  },

  /* ============================== 换一道 ============================== */

  async onReplaceDish(e: WechatMiniprogram.TouchEvent) {
    if (this.data.confirmed) return;

    const recipeId = String(e.currentTarget.dataset.recipeId || '');
    if (!recipeId || !this.data.menuId) return;

    const dish = this.data.interactiveDishes.find((d) => d.recipeId === recipeId);
    if (!dish) return;

    if (dish.locked) {
      wx.showToast({ title: '已锁定，请先取消锁定再替换', icon: 'none' });
      return;
    }

    this.setData({ loading: true });

    try {
      const result = await menuService.replaceMenuItem(
        this.data.menuId, recipeId, this.data.familyId,
      );

      // 替换 UI 中的对应菜品
      const dishes = this.data.interactiveDishes.map((d) =>
        d.recipeId === recipeId ? toDishView(result.newItem) : d,
      );
      this.setData({ loading: false, interactiveDishes: dishes });

      wx.showToast({ title: '已更换为「' + result.newItem.name + '」', icon: 'success' });
    } catch (error) {
      this.setData({ loading: false });
      const code = getErrorCode(error);

      if (code === 'AI_CONFIG_REQUIRED') {
        wx.showModal({
          title: '未配置模型 API',
          content: getErrorMessage(error),
          confirmText: '去设置',
          success: (res) => {
            if (res.confirm) wx.navigateTo({ url: '/pages/ai-settings/index' });
          },
        });
        return;
      }

      wx.showToast({ title: getErrorMessage(error, '换菜失败'), icon: 'none' });
    }
  },

  /* ============================== 重新推荐未锁定 ============================== */

  async onRegenerate() {
    if (this.data.confirmed) return;

    if (!this.data.menuId) return;

    const unlockedCount = this.data.interactiveDishes.filter((d) => !d.locked).length;
    if (unlockedCount === 0) {
      wx.showToast({ title: '所有菜品均已锁定，无需重新推荐', icon: 'none' });
      return;
    }

    this.setData({ loading: true });

    try {
      const result = await menuService.regenerateUnlockedItems(this.data.menuId, this.data.familyId);

      this.setData({
        loading: false,
        interactiveDishes: (result.items || []).map(toDishView),
      });

      wx.showToast({ title: '已更新 ' + result.replacedCount + ' 道菜', icon: 'success' });
    } catch (error) {
      this.setData({ loading: false });
      const code = getErrorCode(error);

      if (code === 'AI_CONFIG_REQUIRED') {
        wx.showModal({
          title: '未配置模型 API',
          content: getErrorMessage(error),
          confirmText: '去设置',
          success: (res) => {
            if (res.confirm) wx.navigateTo({ url: '/pages/ai-settings/index' });
          },
        });
        return;
      }

      wx.showToast({ title: getErrorMessage(error, '重新推荐失败'), icon: 'none' });
    }
  },

  /* ============================== 确认菜单 ============================== */

  async onConfirmMenu() {
    if (this.data.confirmed) return;

    if (!this.data.menuId) return;

    this.setData({ loading: true });

    try {
      await menuService.confirmMenu(this.data.menuId, this.data.familyId);

      this.setData({
        loading: false,
        mode: 'confirmed',
        confirmed: true,
      });

      wx.showToast({ title: '菜单已确认', icon: 'success' });
    } catch (error) {
      this.setData({ loading: false });
      wx.showToast({ title: getErrorMessage(error, '确认失败'), icon: 'none' });
    }
  },

  /* ============================== Phase 9：发起点单 ============================== */

  async onStartOrder() {
    if (!this.data.menuId || !this.data.familyId) {
      wx.showToast({ title: '缺少菜单或家庭信息', icon: 'none' });
      return;
    }

    this.setData({ loading: true });

    try {
      const result = await orderService.createOrder(this.data.familyId, {
        menuId: this.data.menuId,
      });

      this.setData({ loading: false });

      wx.showToast({ title: '点单已创建', icon: 'success' });
      wx.navigateTo({ url: '/pages/order-detail/index?orderId=' + result._id });
    } catch (error) {
      this.setData({ loading: false });
      wx.showToast({ title: getErrorMessage(error, '创建失败'), icon: 'none' });
    }
  },

  /* ============================== 导航 ============================== */

  onBackToRecommend() {
    wx.navigateBack({
      fail: () => wx.redirectTo({ url: '/pages/recommend/index' }),
    });
  },

  onOpenRecipe(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id || '');
    if (!id) return;
    wx.navigateTo({ url: '/pages/recipes/detail?id=' + id });
  },
});