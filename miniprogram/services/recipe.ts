/**
 * 菜谱服务
 *
 * 这里有两件容易混淆、但属于不同阶段的事，方法名刻意区分开：
 *
 *   1. 菜谱模板库（recipes 集合，Phase 6）
 *      listRecipes / getRecipe —— 按 recipeId 查内置菜谱本身；
 *   2. 菜单做法（Phase 7/8）→ 家庭菜谱库（Phase D）
 *      generate / getRecipeDetail / retry —— 按 familyId + cookbookId 查「这家人怎么做」。
 *
 * 两者不能互相替代：模板是公共只读数据，做法是家庭私有的 AI 产物。
 */
import type { Recipe, RecipeListParams, RecipeListResult, GenerateCookingStepsResult, CookbookDetail, CookbookListResult, GeneratedCookingData } from '../types/recipe';

/** 批量生成结果中单道菜的状态 */
interface MenuRecipeResult {
  recipeId: string;
  name: string;
  status: 'cached' | 'generated' | 'skipped' | 'failed';
  cookbookId?: string;
  version?: number;
  reason?: string;
}

/** 批量生成返回 */
interface GenerateRecipeResult {
  menuId: string;
  items: MenuRecipeResult[];
  totalCount: number;
  generatedCount: number;
  cachedCount: number;
}

/** 单道查询返回 */
interface RecipeDetailResult {
  cookbookId: string;
  name: string;
  category: string;
  difficulty: string;
  cookTime: number;
  servings: number;
  version: number;
  source: string;
  data: GeneratedCookingData;
  createdAt: string;
}

/** 重新生成返回 */
interface RetryRecipeResult {
  cookbookId: string;
  version: number;
  data: GeneratedCookingData;
  createdAt: string;
}

/** 编辑返回 */
interface EditCookbookRecipeResult {
  cookbookId: string;
  version: number;
  source: string;
  updatedAt: string;
}
import { AI_REQUEST_TIMEOUT } from '../constants/config';
import { AppError, callFunction } from '../utils/cloud';

/** 家庭菜谱定位键 */
export interface CookbookKey {
  cookbookId: string;
  familyId: string;
}

/** 批量菜单生成入参 */
export interface MenuGenerateParams {
  menuId: string;
  familyId: string;
  preferences?: string;
}

export const recipeService = {
  /* ------------------------- 菜谱模板库（Phase 6） ------------------------- */

  listRecipes(params: RecipeListParams = {}): Promise<RecipeListResult> {
    return callFunction<RecipeListResult, RecipeListParams>('recipe', 'listRecipes', params);
  },

  async getRecipe(recipeId: string): Promise<Recipe> {
    const data = await callFunction<{ recipe: Recipe } | null, { recipeId: string }>(
      'recipe', 'getRecipe', { recipeId },
    );
    if (!data || !data.recipe) {
      throw new AppError('RECIPE_NOT_FOUND', '菜谱不存在或已下架');
    }
    return data.recipe;
  },

  /* ------------------------- Phase D：家庭菜谱库 ------------------------- */

  /** 生成整桌菜单的做法（幂等：已有做法则直接返回缓存） */
  generateRecipe(params: MenuGenerateParams): Promise<GenerateRecipeResult> {
    return callFunction<GenerateRecipeResult, MenuGenerateParams>(
      'recipe', 'generateRecipe', params, { timeout: AI_REQUEST_TIMEOUT },
    );
  },

  /** 重新生成单道菜做法（旧版保留） */
  retryRecipe(key: CookbookKey): Promise<RetryRecipeResult> {
    return callFunction<RetryRecipeResult, CookbookKey>('recipe', 'retryRecipe', key, { timeout: AI_REQUEST_TIMEOUT });
  },

  /** 查询家庭菜谱中某道菜的做法 */
  getRecipeDetail(key: CookbookKey): Promise<RecipeDetailResult> {
    return callFunction<RecipeDetailResult, CookbookKey>('recipe', 'getRecipeDetail', key);
  },

  /** 编辑做法（覆盖当前版本，不新增版本行） */
  editCookbookRecipe(cookbookId: string, familyId: string, data: GeneratedCookingData): Promise<EditCookbookRecipeResult> {
    return callFunction<EditCookbookRecipeResult, { cookbookId: string; familyId: string; data: GeneratedCookingData }>('recipe', 'editCookbookRecipe', { cookbookId, familyId, data });
  },

  /** 家庭菜谱列表 */
  listCookbook(params: { familyId: string; category?: string; status?: string; page?: number; pageSize?: number }): Promise<CookbookListResult> {
    return callFunction<CookbookListResult, typeof params>('recipe', 'listCookbook', params);
  },

  /** 家庭菜谱详情（入口 + 当前做法 + 版本列表） */
  getCookbook(key: CookbookKey): Promise<CookbookDetail> {
    return callFunction<CookbookDetail, CookbookKey>('recipe', 'getCookbook', key);
  },

  /* ------------------------- Phase 10：AI 生成做法（重写走家庭菜谱库） ------------------------- */

  generateCookingSteps(recipeId: string, servings?: number, preferences?: string, familyId?: string): Promise<GenerateCookingStepsResult> {
    return callFunction<GenerateCookingStepsResult>('recipe', 'generateCookingSteps', {
      recipeId, servings, preferences, familyId,
    }, { timeout: AI_REQUEST_TIMEOUT });
  },
};
