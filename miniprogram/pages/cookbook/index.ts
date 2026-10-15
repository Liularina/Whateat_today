/**
 * 我的菜谱（家庭菜谱库列表，Phase D）
 *
 * 展示全家已保存 / 生成的详细做法（family_cookbook 入口），
 * 点击进入做法详情。数据来源：recipe.listCookbook。
 */
import { DIFFICULTY_LABELS } from '../../constants/config';
import { recipeService } from '../../services/recipe';
import { getErrorMessage } from '../../utils/cloud';
import type { CookbookSummary } from '../../types/recipe';

interface CookbookView {
  _id: string;
  name: string;
  category: string;
  difficultyLabel: string;
  cookTime: string;
  servings: string;
  versionLabel: string;
  createdAt: string;
}

function toView(item: CookbookSummary): CookbookView {
  return {
    _id: item._id,
    name: item.name,
    category: item.category,
    difficultyLabel: DIFFICULTY_LABELS[item.difficulty] || '',
    cookTime: item.cookTime ? '约 ' + item.cookTime + ' 分钟' : '',
    servings: item.servings ? item.servings + ' 人份' : '',
    versionLabel: '第 ' + (item.latestVersion || 1) + ' 版',
    createdAt: (item.createdAt || '').slice(0, 10),
  };
}

Page({
  data: {
    loading: true,
    error: '',
    inited: false,
    items: [] as CookbookView[],
    total: 0,
  },

  onLoad() {
    void this.loadList();
  },

  onShow() {
    // 从详情页返回后刷新（可能重新生成 / 编辑过）
    if (this.data.inited) {
      void this.loadList();
    }
  },

  onRetry() {
    void this.loadList();
  },

  async loadList() {
    this.setData({ loading: true, error: '' });
    try {
      const app = getApp<IAppOption>();
      const familyId = app.globalData.currentFamilyId || '';
      if (!familyId) {
        this.setData({ loading: false, inited: true, items: [], total: 0 });
        return;
      }

      const result = await recipeService.listCookbook({ familyId });
      this.setData({
        loading: false,
        inited: true,
        items: (result.items || []).map(toView),
        total: result.total || 0,
      });
    } catch (e) {
      this.setData({
        loading: false,
        inited: true,
        error: getErrorMessage(e, '我的菜谱加载失败'),
      });
    }
  },

  onOpenRecipe(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id || '');
    if (!id) return;
    wx.navigateTo({ url: '/pages/cookbook/detail?cookbookId=' + id });
  },
});
