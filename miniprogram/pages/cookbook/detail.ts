/**
 * 我的菜谱 · 做法详情（Phase D）
 *
 * 展示家庭菜谱库中某道菜当前版本的详细做法（family_cookbook + cookbook_versions）。
 * 数据来源：recipe.getCookbook。
 */
import { DIFFICULTY_LABELS } from '../../constants/config';
import { recipeService } from '../../services/recipe';
import { getErrorCode, getErrorMessage } from '../../utils/cloud';
import type { GeneratedCookingData } from '../../types/recipe';

interface IngredientView {
  name: string;
  amountText: string;
}

interface StepView {
  step: number;
  description: string;
  timeText: string;
}

function toIngredientView(item: GeneratedCookingData['ingredients'][number]): IngredientView {
  const amountText = item.unit ? item.amount + ' ' + item.unit : String(item.amount);
  return { name: item.name, amountText };
}

function toStepView(item: GeneratedCookingData['steps'][number], index: number): StepView {
  return {
    step: item.step || index + 1,
    description: item.description,
    timeText: item.minutes ? '约 ' + item.minutes + ' 分钟' : '',
  };
}

Page({
  data: {
    cookbookId: '',
    loading: true,
    error: '',
    notFound: false,

    name: '',
    category: '',
    difficultyLabel: '',
    cookTime: 0,
    servings: 0,
    version: 1,
    sourceLabel: '',

    intro: '',
    ingredients: [] as IngredientView[],
    preparation: [] as string[],
    steps: [] as StepView[],
    tips: [] as string[],
    safety: [] as string[],
  },

  onLoad(query: Record<string, string | undefined>) {
    const cookbookId = query.cookbookId || '';
    this.setData({ cookbookId: cookbookId });
    if (!cookbookId) {
      this.setData({ loading: false, notFound: true });
      return;
    }
    void this.load();
  },

  onRetry() {
    void this.load();
  },

  onBack() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack({ delta: 1 });
      return;
    }
    wx.redirectTo({ url: '/pages/cookbook/index' });
  },

  async load() {
    this.setData({ loading: true, error: '', notFound: false });
    try {
      const app = getApp<IAppOption>();
      const familyId = app.globalData.currentFamilyId || '';
      const detail = await recipeService.getCookbook({ cookbookId: this.data.cookbookId, familyId });

      const current = detail.current;
      const data: GeneratedCookingData = (current && current.data) || {
        introduction: '',
        ingredients: [],
        preparation: [],
        steps: [],
        tips: [],
        safetyNotes: [],
      };
      const sourceLabel = current && current.source === 'edited' ? '已编辑' : 'AI 生成';

      this.setData({
        loading: false,
        name: detail.entry.name,
        category: detail.entry.category,
        difficultyLabel: DIFFICULTY_LABELS[detail.entry.difficulty] || '',
        cookTime: detail.entry.cookTime,
        servings: detail.entry.servings,
        version: detail.entry.latestVersion,
        sourceLabel: sourceLabel,
        intro: data.introduction || '',
        ingredients: (data.ingredients || []).map(toIngredientView),
        preparation: data.preparation || [],
        steps: (data.steps || []).map(toStepView),
        tips: data.tips || [],
        safety: data.safetyNotes || [],
      });
    } catch (e) {
      if (getErrorCode(e) === 'COOKBOOK_NOT_FOUND') {
        this.setData({ loading: false, notFound: true });
        return;
      }
      this.setData({ loading: false, error: getErrorMessage(e, '做法加载失败') });
    }
  },
});
