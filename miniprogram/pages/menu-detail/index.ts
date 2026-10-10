/**
 * 菜单详情（Phase 11）
 *
 * 从历史菜单列表带 menuId 进入，内容一律重新向云函数取。
 * 只读展示：菜品列表 + 每道菜链接到菜谱详情（可继续查看/生成做法）。
 */
import { DIFFICULTY_LABELS, MEAL_TYPE_LABELS } from '../../constants/config';
import { menuService } from '../../services/menu';
import { getErrorMessage } from '../../utils/cloud';
import type { Menu } from '../../types/menu';

interface DishView {
  recipeId: string;
  name: string;
  description: string;
  category: string;
  difficultyLabel: string;
  cookTime: string;
  ingredientsText: string;
  locked: boolean;
}

const STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  confirmed: '已确认',
  completed: '已完成',
};

function toDishView(item: Menu['items'][number]): DishView {
  return {
    recipeId: item.recipeId,
    name: item.name,
    description: item.description || '',
    category: item.category || '',
    difficultyLabel: DIFFICULTY_LABELS[item.difficulty] || '',
    cookTime: item.cookTime ? '约 ' + item.cookTime + ' 分钟' : '',
    ingredientsText: (item.ingredients || []).map((i) => i.name).join('、'),
    locked: !!item.locked,
  };
}

Page({
  data: {
    menuId: '',
    loading: true,
    error: '',

    mealTypeLabel: '',
    servings: 0,
    statusLabel: '',
    dateLabel: '',
    dishes: [] as DishView[],
  },

  onLoad(query: Record<string, string | undefined>) {
    const menuId = query.menuId || '';
    this.setData({ menuId: menuId });
    if (!menuId) {
      this.setData({ loading: false, error: '缺少菜单 ID' });
      return;
    }
    void this.load();
  },

  onRetry() {
    void this.load();
  },

  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const app = getApp<IAppOption>();
      const family = app.globalData.family;

      const menu = await menuService.getMenu(this.data.menuId, family ? family._id : undefined);

      this.setData({
        loading: false,
        mealTypeLabel: MEAL_TYPE_LABELS[menu.mealType] || menu.mealType,
        servings: menu.servings,
        statusLabel: STATUS_LABELS[menu.status] || menu.status,
        dateLabel: (menu.createdAt || '').slice(0, 10),
        dishes: (menu.items || []).map(toDishView),
      });
    } catch (e) {
      this.setData({ loading: false, error: getErrorMessage(e, '菜单加载失败') });
    }
  },

  /** 点击菜品 → 菜谱详情（Phase 6/10 的做法页） */
  onOpenRecipe(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id || '');
    if (!id) return;
    const name = String(e.currentTarget.dataset.name || '');
    const url = '/pages/recipes/detail?id=' + id + (name ? '&name=' + encodeURIComponent(name) : '');
    wx.navigateTo({ url: url });
  },
});