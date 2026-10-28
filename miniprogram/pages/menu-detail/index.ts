/**
 * 菜单详情（Phase 11 → Phase A3：增加营养展示）
 */
import { DIFFICULTY_LABELS, MEAL_TYPE_LABELS } from '../../constants/config';
import { menuService } from '../../services/menu';
import { reviewService } from '../../services/review';
import { getErrorMessage, getErrorCode } from '../../utils/cloud';
import { formatKcal } from '../../utils/formatter';
import type { Menu, MenuStatus } from '../../types/menu';
import type {
  ChefGrowth,
  DishRating,
  DishReviewView,
  MealReviewDetail,
  ReviewSummary,
} from '../../types/review';

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

/** 评价区的一道菜：把服务端汇总转成可直接渲染的视图 */
interface ReviewDishView {
  recipeId: string;
  name: string;
  stars: number;
  comment: string;
  averageLabel: string;
  ratedCountLabel: string;
  commentsText: string;
}

function toReviewDishView(dish: DishReviewView): ReviewDishView {
  const comments = (dish.comments || []).filter((item) => item.comment);
  return {
    recipeId: dish.recipeId,
    name: dish.name,
    stars: dish.myStars || 0,
    comment: dish.myComment || '',
    averageLabel: dish.average === null ? '暂无评分' : dish.average.toFixed(1) + ' 星',
    ratedCountLabel: dish.ratedCount > 0 ? dish.ratedCount + ' 人评分' : '暂无评分',
    commentsText: comments
      .slice(0, 3)
      .map((item) => item.nickname + '：' + item.comment)
      .join('　'),
  };
}

/** ISO → YYYY-MM-DD HH:mm（本地时间，仅用于展示） */
function formatDateTime(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (isNaN(date.getTime())) return iso.slice(0, 16).replace('T', ' ');
  const pad = (n: number) => (n < 10 ? '0' + n : String(n));
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

/** 等级进度：当前等级到下一等级之间的百分比 */
function growthProgress(growth: ChefGrowth | null): number {
  if (!growth) return 0;
  if (growth.maxLevel) return 100;
  const span = growth.nextMinPoints - growth.levelMinPoints;
  if (span <= 0) return 100;
  const ratio = (growth.points - growth.levelMinPoints) / span;
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}

function growthNextLabel(growth: ChefGrowth | null): string {
  if (!growth) return '';
  if (growth.maxLevel) return '已达到最高等级';
  return '距 ' + growth.nextLevelName + ' 还差 ' + growth.pointsToNext + ' 分';
}

function growthLastLabel(growth: ChefGrowth | null): string {
  if (!growth || !growth.lastReason) return '';
  return growth.lastReason + ' +' + growth.lastPoints;
}

Page({
  data: {
    menuId: '',
    loading: true,
    error: '',

    mealTypeLabel: '',
    servings: 0,
    statusLabel: '',
    menuStatusCode: 'draft' as MenuStatus,
    /** Phase 1：确认本菜单的掌勺人 */
    cookName: '',
    dateLabel: '',
    /** 阶段二：完成状态与评价 */
    completedAtLabel: '',
    canComplete: false,
    canRate: false,
    /** 我是不是本餐掌勺人（决定看到「完成制作」还是「饭后评价」） */
    isCook: false,
    completing: false,
    reviewLoading: false,
    reviewError: '',
    reviewExpanded: false,
    reviewSummary: null as ReviewSummary | null,
    reviewDishes: [] as ReviewDishView[],
    starOptions: [1, 2, 3, 4, 5],
    ratingSubmitting: false,
    growth: null as ChefGrowth | null,
    growthProgress: 0,
    growthNextLabel: '',
    growthLastLabel: '',
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
        menuStatusCode: menu.status,
        cookName: menu.cookName || '',
        dateLabel: (menu.createdAt || '').slice(0, 10),
        completedAtLabel: formatDateTime(menu.completedAt || ''),
        canComplete: menu.status === 'confirmed',
        canRate: menu.status === 'completed',
        // 已完成的用餐默认展开评价区，成员进来就能直接打分
        reviewExpanded: menu.status === 'completed',
        dishes: items.map(toDishView),
        nutrition: nutrition,
      });

      // 已完成或已确认的菜单才需要评价区/成长数据
      if (menu.status === 'completed' || menu.status === 'confirmed') {
        void this.loadReview();
      }
    } catch (e) {
      this.setData({ loading: false, error: getErrorMessage(e, '菜单加载失败') });
    }
  },

  /** 读取用餐评价与掌勺人成长（失败不影响菜单本身展示） */
  async loadReview() {
    const app = getApp<IAppOption>();
    const family = app.globalData.family;
    if (!family || !this.data.menuId) return;

    this.setData({ reviewLoading: true, reviewError: '' });
    try {
      const detail = await reviewService.getMealReview(family._id, this.data.menuId);
      this.applyReview(detail);
    } catch (e) {
      this.setData({ reviewLoading: false, reviewError: getErrorMessage(e, '评价加载失败') });
    }
  },

  applyReview(detail: MealReviewDetail) {
    const growth = detail.growth || null;
    this.setData({
      reviewLoading: false,
      reviewError: '',
      reviewSummary: detail.summary,
      reviewDishes: (detail.summary.dishes || []).map(toReviewDishView),
      canComplete: detail.canComplete,
      canRate: detail.canRate,
      isCook: !!detail.isCook,
      completedAtLabel: formatDateTime(detail.completedAt),
      growth: growth,
      growthProgress: growthProgress(growth),
      growthNextLabel: growthNextLabel(growth),
      growthLastLabel: growthLastLabel(growth),
    });
  },

  /** 展开 / 收起评价区 */
  onToggleReview() {
    this.setData({ reviewExpanded: !this.data.reviewExpanded });
    if (this.data.reviewExpanded && !this.data.reviewSummary) {
      void this.loadReview();
    }
  },

  /** 标记本餐已完成（服务端幂等，重复点击不会重复加积分） */
  async onCompleteMeal() {
    if (this.data.completing || !this.data.canComplete) return;

    const app = getApp<IAppOption>();
    const family = app.globalData.family;
    if (!family) {
      wx.showToast({ title: '请先加入家庭', icon: 'none' });
      return;
    }

    const confirm = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: '标记本餐已完成',
        content: '完成家庭成员就可以给每道菜打分了，同一餐只能完成一次。',
        confirmText: '已完成',
        success: (res) => resolve(!!res.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirm) return;

    this.setData({ completing: true });
    try {
      const result = await reviewService.completeMeal(family._id, this.data.menuId);
      this.setData({
        completing: false,
        statusLabel: STATUS_LABELS.completed,
        menuStatusCode: 'completed',
        canComplete: false,
        // 掌勺人不评价自己的菜，别在这里给出评价入口
        canRate: !this.data.isCook,
        completedAtLabel: formatDateTime(result.completedAt),
      });

      const tips = result.alreadyCompleted
        ? '本餐之前已完成'
        : (result.pointsAwarded > 0
          ? '已完成，掌勺人 +' + result.pointsAwarded + ' 分'
          : '已完成');
      wx.showToast({ title: tips, icon: 'none' });
      void this.loadReview();
    } catch (e) {
      this.setData({ completing: false });
      const code = getErrorCode(e);
      if (code === 'COOK_REQUIRED') {
        wx.showToast({ title: '请先在点菜页指定掌勺人', icon: 'none' });
        return;
      }
      if (code === 'ONLY_COOK_CAN_COMPLETE') {
        wx.showToast({ title: '只有掌勺人可以标记完成制作', icon: 'none' });
        void this.load();
        return;
      }
      if (code === 'ORDER_STILL_OPEN') {
        wx.showToast({ title: '点单还没关闭，先关闭点单', icon: 'none' });
        void this.load();
        return;
      }
      wx.showToast({ title: getErrorMessage(e, '标记失败，请重试'), icon: 'none' });
      // 状态可能已被他人改变，刷新到最新真值
      void this.load();
    }
  },

  /** 点星：只改本地草稿，提交时才写服务端 */
  onSelectStars(e: WechatMiniprogram.TouchEvent) {
    const recipeId = String(e.currentTarget.dataset.id || '');
    const stars = Number(e.currentTarget.dataset.stars);
    if (!recipeId || !stars) return;

    const reviewDishes = this.data.reviewDishes.map((dish) => (
      dish.recipeId === recipeId ? { ...dish, stars: stars } : dish
    ));
    this.setData({ reviewDishes: reviewDishes });
  },

  /** 评语输入 */
  onCommentInput(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const recipeId = String(e.currentTarget.dataset.id || '');
    if (!recipeId) return;
    const value = String((e.detail && e.detail.value) || '').slice(0, 50);
    const reviewDishes = this.data.reviewDishes.map((dish) => (
      dish.recipeId === recipeId ? { ...dish, comment: value } : dish
    ));
    this.setData({ reviewDishes: reviewDishes });
  },

  /** 提交自己的评分：只提交已打星的菜 */
  async onSubmitRatings() {
    if (this.data.ratingSubmitting) return;

    const app = getApp<IAppOption>();
    const family = app.globalData.family;
    if (!family) {
      wx.showToast({ title: '请先加入家庭', icon: 'none' });
      return;
    }

    const ratings: DishRating[] = this.data.reviewDishes
      .filter((dish) => dish.stars >= 1 && dish.stars <= 5)
      .map((dish) => ({ recipeId: dish.recipeId, stars: dish.stars, comment: dish.comment || '' }));

    if (ratings.length === 0) {
      wx.showToast({ title: '请先给至少一道菜打星', icon: 'none' });
      return;
    }

    this.setData({ ratingSubmitting: true });
    try {
      const result = await reviewService.submitRatings(family._id, this.data.menuId, ratings);
      this.setData({
        ratingSubmitting: false,
        reviewSummary: result.summary,
        reviewDishes: (result.summary.dishes || []).map(toReviewDishView),
      });

      if (result.growth) {
        this.setData({
          growth: result.growth,
          growthProgress: growthProgress(result.growth),
          growthNextLabel: growthNextLabel(result.growth),
          growthLastLabel: growthLastLabel(result.growth),
        });
      }

      const tips = result.pointsAwarded > 0
        ? '评分已提交，掌勺人 +' + result.pointsAwarded + ' 分'
        : '评分已提交';
      wx.showToast({ title: tips, icon: 'none' });
    } catch (e) {
      this.setData({ ratingSubmitting: false });
      wx.showToast({ title: getErrorMessage(e, '提交失败，请重试'), icon: 'none' });
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