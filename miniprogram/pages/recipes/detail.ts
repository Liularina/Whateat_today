import { CLOUD_ERROR_CODES, DIFFICULTY_LABELS } from '../../constants/config';
import { recipeService } from '../../services/recipe';
import { aiConfigService } from '../../services/ai-config';
import type { Recipe, GeneratedCookingData } from '../../types/recipe';
import { getErrorCode, getErrorMessage } from '../../utils/cloud';

interface IngredientView {
  name: string;
  amountText: string;
}

interface StepView {
  step: number;
  description: string;
  timeText: string;
}

function toIngredientView(item: Recipe['ingredients'][number]): IngredientView {
  const amountText = item.unit ? item.amount + ' ' + item.unit : String(item.amount);
  return { name: item.name, amountText: amountText };
}

function toStepView(item: Recipe['steps'][number], index: number): StepView {
  return {
    step: item.step || index + 1,
    description: item.description,
    timeText: item.minutes ? '约 ' + item.minutes + ' 分钟' : '',
  };
}

Page({
  data: {
    recipeId: '',
    /** 历史菜单/点单带来的菜名快照：菜谱不可用时兜底展示 */
    fallbackName: '',
    loading: true,
    error: '',
    notFound: false,

    name: '',
    description: '',
    category: '',
    tags: [] as string[],
    difficultyLabel: '',
    cookTime: 0,
    servings: 0,
    ingredients: [] as IngredientView[],
    steps: [] as StepView[],

    /* Phase 10：AI 生成 */
    aiReady: false,
    generating: false,
    generatedData: null as GeneratedCookingData | null,
    generatedIntro: '',
    generatedIngredients: [] as IngredientView[],
    generatedSteps: [] as StepView[],
    generatedPrep: [] as string[],
    generatedTips: [] as string[],
    generatedSafety: [] as string[],
    generateError: '',

    /* Phase D：是否已保存到家庭菜谱库 */
    savedToCookbook: false,
    cookbookId: '',
  },

  onLoad(query: Record<string, string | undefined>) {
    const recipeId = query.id || '';
    const fallbackName = query.name || '';
    this.setData({ recipeId: recipeId, fallbackName: fallbackName });

    if (!recipeId) {
      this.setData({ loading: false, notFound: true });
      return;
    }

    void this.load();
    void this.checkAiConfig();
  },

  onRetry() {
    void this.load();
  },

  onBackToList() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack({ delta: 1 });
      return;
    }
    wx.redirectTo({ url: '/pages/recipes/index' });
  },

  async checkAiConfig() {
    try {
      const config = await aiConfigService.getConfig();
      const aiReady = (config.mode === 'builtin' && config.builtin.ready)
                    || (config.mode === 'custom' && config.configured);
      this.setData({ aiReady: aiReady });
    } catch (_e) {
      // 静默
    }
  },

  async load(): Promise<void> {
    this.setData({ loading: true, error: '', notFound: false });

    try {
      const recipe = await recipeService.getRecipe(this.data.recipeId);

      this.setData({
        loading: false,
        name: recipe.name,
        description: recipe.description,
        category: recipe.category,
        tags: recipe.tags || [],
        difficultyLabel: DIFFICULTY_LABELS[recipe.difficulty] || '',
        cookTime: recipe.cookTime,
        servings: recipe.servings,
        ingredients: (recipe.ingredients || []).map(toIngredientView),
        steps: (recipe.steps || []).map(toStepView),
      });
    } catch (error) {
      if (getErrorCode(error) === CLOUD_ERROR_CODES.RECIPE_NOT_FOUND) {
        this.setData({ loading: false, notFound: true });
        return;
      }

      this.setData({
        loading: false,
        error: getErrorMessage(error, '菜谱加载失败'),
      });
    }
  },

  /* ============================== Phase 10：AI 生成 ============================== */

  async onGenerateSteps() {
    if (!this.data.aiReady) {
      wx.showModal({
        title: 'AI 服务暂不可用',
        content: '请在「模型 API 设置」中检查 AI 服务状态',
        confirmText: '去设置',
        success: (res) => {
          if (res.confirm) wx.navigateTo({ url: '/pages/ai-settings/index' });
        },
      });
      return;
    }

    this.setData({ generating: true, generateError: '' });

    try {
      const app = getApp<IAppOption>();
      const familyId = app.globalData.currentFamilyId || '';
      const result = await recipeService.generateCookingSteps(
        this.data.recipeId,
        this.data.servings,
        undefined,
        familyId,
      );

      const gen = result.data;
      const saved = !!result.cookbookId;
      this.setData({
        generating: false,
        generatedData: gen,
        savedToCookbook: saved,
        cookbookId: result.cookbookId || '',
        generatedIntro: gen.introduction || '',
        generatedIngredients: (gen.ingredients || []).map(toIngredientView),
        generatedSteps: (gen.steps || []).map((s, i) => ({
          step: s.step || i + 1,
          description: s.description,
          timeText: s.minutes ? '约 ' + s.minutes + ' 分钟' : '',
        })),
        generatedPrep: gen.preparation || [],
        generatedTips: gen.tips || [],
        generatedSafety: gen.safetyNotes || [],
      });

      wx.showToast({ title: saved ? '已保存到我的菜谱' : '做法已生成', icon: 'success' });
    } catch (error) {
      this.setData({
        generating: false,
        generateError: getErrorMessage(error, '生成失败'),
      });
    }
  },

  onRegenerateSteps() {
    void this.onGenerateSteps();
  },

  onGoSettings() {
    wx.navigateTo({ url: '/pages/ai-settings/index' });
  },

  /** Phase D：查看家庭菜谱库 */
  onGoCookbook() {
    wx.navigateTo({ url: '/pages/cookbook/index' });
  },
});