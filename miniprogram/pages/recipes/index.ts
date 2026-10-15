/**
 * 家常菜谱列表（Phase 6）
 *
 * 数据来自 recipe 云函数的 listRecipes —— 内置菜谱是公共只读数据，
 * 因此本页不要求登录、也不依赖家庭，未登录用户同样可以浏览。
 *
 * 四种状态都是正常状态，不白屏：
 *   1. 首次加载中   → loading-state
 *   2. 有数据       → 列表（上拉加载更多）
 *   3. 无数据       → 空状态（区分「筛选无结果」与「菜谱库为空」）
 *   4. 加载失败     → error-state + 重试
 */
import { DIFFICULTY_LABELS } from '../../constants/config';
import { RECIPE_CATEGORIES, RECIPE_CATEGORY_ALL, RECIPE_PAGE_SIZE } from '../../constants/recipe';
import { recipeService } from '../../services/recipe';
import type { RecipeListParams, RecipeSummary } from '../../types/recipe';
import { getErrorMessage } from '../../utils/cloud';

/** 列表展示项：难度文案、meta 文案在 TS 里算好，WXML 不做判断 */
interface RecipeView extends RecipeSummary {
  metaText: string;
  tagsText: string;
}

/** 筛选条：第一项固定为「全部」 */
const CATEGORY_OPTIONS: readonly string[] = [RECIPE_CATEGORY_ALL].concat(RECIPE_CATEGORIES);

/**
 * 页面参数解码。微信部分基础库不自动 decode query，食材页用 encodeURIComponent
 * 传入中文，这里做一次 decodeURIComponent 兑底；已是纯文本则原样返回。
 */
function decodeParam(value: string): string {
  if (!value) {
    return '';
  }
  try {
    return decodeURIComponent(value);
  } catch (_e) {
    return value;
  }
}

function toView(item: RecipeSummary): RecipeView {
  const parts: string[] = [];
  if (item.cookTime) {
    parts.push('约 ' + item.cookTime + ' 分钟');
  }
  const difficultyLabel = DIFFICULTY_LABELS[item.difficulty];
  if (difficultyLabel) {
    parts.push(difficultyLabel);
  }
  if (item.servings) {
    parts.push(item.servings + ' 人份');
  }

  return {
    _id: item._id,
    name: item.name,
    description: item.description,
    category: item.category,
    tags: item.tags || [],
    difficulty: item.difficulty,
    cookTime: item.cookTime,
    servings: item.servings,
    metaText: parts.join(' · '),
    tagsText: (item.tags || []).join(' · '),
  };
}

Page({
  data: {
    categories: CATEGORY_OPTIONS,
    categoryIndex: 0,
    /** 输入框里的关键词 */
    keyword: '',
    /** 已经提交给服务端的搜索词（与输入框内容区分开） */
    activeKeyword: '',
    /** 从食材页「做法」带入的食材筛选词，与关键词搜索独立 */
    ingredient: '',
    /** 当前是否处于筛选 / 搜索状态，用于空状态文案 */
    hasFilter: false,

    items: [] as RecipeView[],
    total: 0,
    page: 1,
    pageSize: RECIPE_PAGE_SIZE,
    hasMore: false,

    loading: false,
    loadingMore: false,
    /** 是否已完成过一次加载，用于区分「首次加载中」与「刷新中」 */
    inited: false,
    error: '',
  },

  /**
   * 支持从其他页面带 keyword 直接进入（如食材页的「查看做法」）。
   * 参数只作为初始筛选条件，用户仍可自由修改。
   */
  onLoad(query?: Record<string, string | undefined>) {
    const keyword = decodeParam(query && query.keyword ? String(query.keyword).trim() : '');
    const ingredient = decodeParam(query && query.ingredient ? String(query.ingredient).trim() : '');
    const patch: Record<string, unknown> = {};
    if (keyword) {
      patch.keyword = keyword;
      patch.activeKeyword = keyword;
      patch.hasFilter = true;
    }
    if (ingredient) {
      patch.ingredient = ingredient;
      patch.hasFilter = true;
    }
    if (Object.keys(patch).length > 0) {
      this.setData(patch);
    }
    void this.loadFirstPage();
  },

  onPullDownRefresh() {
    void this.loadFirstPage().then(() => {
      wx.stopPullDownRefresh();
    });
  },

  onReachBottom() {
    void this.loadMore();
  },

  /* ------------------------------ 筛选与搜索 ------------------------------ */

  onCategoryTap(e: WechatMiniprogram.TouchEvent) {
    const index = Number(e.currentTarget.dataset.index);
    if (!Number.isInteger(index) || index === this.data.categoryIndex) {
      return;
    }
    this.setData({ categoryIndex: index, hasFilter: index > 0 || !!this.data.activeKeyword || !!this.data.ingredient });
    void this.loadFirstPage();
  },

  onKeywordInput(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ keyword: e.detail.value });
  },

  /** 点击「搜索」或键盘回车才真正发起查询，避免每敲一个字都打一次云函数 */
  onKeywordConfirm() {
    const next = (this.data.keyword || '').trim();
    if (next === this.data.activeKeyword) {
      return;
    }
    this.setData({
      keyword: next,
      activeKeyword: next,
      hasFilter: this.data.categoryIndex > 0 || !!next || !!this.data.ingredient,
    });
    void this.loadFirstPage();
  },

  onClearKeyword() {
    this.setData({ keyword: '', activeKeyword: '', hasFilter: this.data.categoryIndex > 0 || !!this.data.ingredient });
    void this.loadFirstPage();
  },

  /** 清空全部筛选条件（空状态里的按钮） */
  onClearFilters() {
    this.setData({
      categoryIndex: 0,
      keyword: '',
      activeKeyword: '',
      ingredient: '',
      hasFilter: false,
    });
    void this.loadFirstPage();
  },

  /** 清除食材筛选（食材页「做法」带入的筛选词） */
  onClearIngredient() {
    this.setData({ ingredient: '', hasFilter: this.data.categoryIndex > 0 || !!this.data.activeKeyword });
    void this.loadFirstPage();
  },

  onRetry() {
    void this.loadFirstPage();
  },

  onOpenRecipe(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id || '');
    if (!id) {
      return;
    }
    wx.navigateTo({ url: '/pages/recipes/detail?id=' + id });
  },

  /* ------------------------------ 数据加载 ------------------------------ */

  buildParams(page: number): RecipeListParams {
    return {
      category: this.data.categories[this.data.categoryIndex] || RECIPE_CATEGORY_ALL,
      keyword: this.data.activeKeyword,
      ingredient: this.data.ingredient,
      page: page,
      pageSize: this.data.pageSize,
    };
  },

  async loadFirstPage(): Promise<void> {
    this.setData({ loading: true, error: '' });

    try {
      const result = await recipeService.listRecipes(this.buildParams(1));
      const items = (result.items || []).map(toView);
      const total = result.total || 0;

      this.setData({
        items: items,
        total: total,
        page: 1,
        hasMore: items.length < total,
        loading: false,
        inited: true,
      });
    } catch (error) {
      // 加载失败：保留已有列表，只提示错误，不清空
      this.setData({
        loading: false,
        inited: true,
        error: getErrorMessage(error, '菜谱加载失败，请稍后重试'),
      });
    }
  },

  async loadMore(): Promise<void> {
    if (!this.data.hasMore || this.data.loading || this.data.loadingMore) {
      return;
    }

    const nextPage = this.data.page + 1;
    this.setData({ loadingMore: true });

    try {
      const result = await recipeService.listRecipes(this.buildParams(nextPage));
      const more = (result.items || []).map(toView);
      const items = this.data.items.concat(more);
      const total = result.total || 0;

      this.setData({
        items: items,
        total: total,
        page: nextPage,
        hasMore: items.length < total,
        loadingMore: false,
      });
    } catch (error) {
      this.setData({
        loadingMore: false,
        error: getErrorMessage(error, '加载更多失败，请稍后重试'),
      });
    }
  },
});
