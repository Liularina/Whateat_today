/**
 * 菜单详情（Phase 11 → Phase A3：增加营养展示）
 */
import { DIFFICULTY_LABELS, MEAL_TYPE_LABELS } from '../../constants/config';
import { menuService } from '../../services/menu';
import { getErrorMessage } from '../../utils/cloud';
import { formatKcal } from '../../utils/formatter';
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
  kcalLabel: string;
  nutritionRow: string;  // e.g. "320 kcal | 12g 蛋白 | 8g 脂肪 | 30g 碳水"
  hasNutrition: boolean;
  isPartial: boolean;
}

interface NutritionSummary {
  totalKcal: number;
  kcalLabel: string;
  totalProtein: number;
  totalFat: number;
  totalCarbs: number;
  macroRow: string;
  perPersonKcal: number;
  perPersonLabel: string;
  nutritionStatus: string;
  showWarning: boolean;
  dishCount: number;
  computedCount: number;
}

const STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  confirmed: '已确认',
  completed: '已完成',
};

function formatG(value: number): string {
  const n = Math.round(value);
  return n > 0 ? n + 'g' : '0g';
}

function buildNutritionRow(nutrition: { calories: number; protein: number; fat: number; carbohydrate: number }): string {
  return [
    formatKcal(nutrition.calories),
    formatG(nutrition.protein) + ' 蛋白',
    formatG(nutrition.fat) + ' 脂肪',
    formatG(nutrition.carbohydrate) + ' 碳水',
  ].join(' | ');
}

function toDishView(item: Menu['items'][number]): DishView {
  const hasN = !!(item.nutrition && item.nutrition.calories > 0);
  return {
    recipeId: item.recipeId,
    name: item.name,
    description: item.description || '',
    category: item.category || '',
    difficultyLabel: DIFFICULTY_LABELS[item.difficulty] || '',
    cookTime: item.cookTime ? '约 ' + item.cookTime + ' 分钟' : '',
    ingredientsText: (item.ingredients || []).map((i) => i.name).join('、'),
    locked: !!item.locked,
    hasNutrition: hasN,
    isPartial: item.nutritionStatus === 'partial',
    kcalLabel: hasN ? formatKcal(item.nutrition!.calories) : '',
    nutritionRow: hasN ? buildNutritionRow(item.nutrition!) : '',
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
    nutrition: {
      totalKcal: 0,
      kcalLabel: '',
      totalProtein: 0,
      totalFat: 0,
      totalCarbs: 0,
      macroRow: '',
      perPersonKcal: 0,
      perPersonLabel: '',
      nutritionStatus: 'unknown' as string,
      showWarning: false,
      dishCount: 0,
      computedCount: 0,
    } as NutritionSummary,
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

      // 营养汇总
      let totalKcal = 0;
      let totalProtein = 0;
      let totalFat = 0;
      let totalCarbs = 0;
      let computedCount = 0;
      let hasPartial = false;
      const items = menu.items || [];

      for (const it of items) {
        if (it.nutrition && typeof it.nutrition.calories === 'number') {
          totalKcal += it.nutrition.calories;
          totalProtein += it.nutrition.protein || 0;
          totalFat += it.nutrition.fat || 0;
          totalCarbs += it.nutrition.carbohydrate || 0;
          computedCount++;
        }
        if (it.nutritionStatus === 'partial') hasPartial = true;
      }

      const ns = hasPartial ? 'partial'
        : (computedCount === items.length && items.length > 0 ? 'complete' : 'unknown');

      const nutrition: NutritionSummary = {
        totalKcal: totalKcal,
        kcalLabel: formatKcal(totalKcal),
        totalProtein: totalProtein,
        totalFat: totalFat,
        totalCarbs: totalCarbs,
        macroRow: [
          formatG(totalProtein) + ' 蛋白质',
          formatG(totalFat) + ' 脂肪',
          formatG(totalCarbs) + ' 碳水',
        ].join(' | '),
        perPersonKcal: menu.servings > 0 ? Math.round(totalKcal / menu.servings) : 0,
        perPersonLabel: menu.servings > 0
          ? '人均 ' + formatKcal(Math.round(totalKcal / menu.servings))
          : '',
        nutritionStatus: ns,
        showWarning: hasPartial && items.length > 0,
        dishCount: items.length,
        computedCount: computedCount,
      };

      this.setData({
        loading: false,
        mealTypeLabel: MEAL_TYPE_LABELS[menu.mealType] || menu.mealType,
        servings: menu.servings,
        statusLabel: STATUS_LABELS[menu.status] || menu.status,
        dateLabel: (menu.createdAt || '').slice(0, 10),
        dishes: items.map(toDishView),
        nutrition: nutrition,
      });
    } catch (e) {
      this.setData({ loading: false, error: getErrorMessage(e, '菜单加载失败') });
    }
  },

  /** 点击菜品 → 菜谱详情 */
  onOpenRecipe(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id || '');
    if (!id) return;
    const name = String(e.currentTarget.dataset.name || '');
    const url = '/pages/recipes/detail?id=' + id + (name ? '&name=' + encodeURIComponent(name) : '');
    wx.navigateTo({ url: url });
  },

  /** Phase E1：已确认菜单 → 采购清单 */
  onOpenShopping() {
    const menuId = this.data.menuId;
    if (!menuId) return;
    wx.navigateTo({ url: '/pages/shopping/index?menuId=' + menuId });
  },
});