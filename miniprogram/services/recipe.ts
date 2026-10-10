/**
 * 菜谱服务
 *
 * 这里有两件容易混淆、但属于不同阶段的事，方法名刻意区分开：
 *
 *   1. 菜谱模板库（recipes 集合，Phase 6）
 *      listRecipes / getRecipe —— 按 recipeId 查内置菜谱本身；
 *   2. 菜单做法（由 AI 在菜单确认后生成，后续阶段）
 *      generate / getRecipeDetail / retry —— 按 menuId + recipeId 查「这一桌怎么做」。
 *
 * 两者不能互相替代：模板是公共只读数据，做法是家庭私有的 AI 产物。
 */
import type { Recipe, RecipeDetail, RecipeListParams, RecipeListResult, GenerateCookingStepsResult } from '../types/recipe';
import { AI_REQUEST_TIMEOUT } from '../constants/config';
import { AppError, callFunction } from '../utils/cloud';

/** 菜单做法的定位键（后续阶段使用） */
export interface RecipeKey {
  menuId: string;
  recipeId: string;
}

export const recipeService = {
  /* ------------------------- 菜谱模板库（Phase 6） ------------------------- */

  /** 菜谱列表：分类筛选 / 关键词搜索 / 分页，只返回启用的内置菜谱 */
  listRecipes(params: RecipeListParams = {}): Promise<RecipeListResult> {
    return callFunction<RecipeListResult, RecipeListParams>('recipe', 'listRecipes', params);
  },

  /** 菜谱详情；云函数返回 { recipe }，这里解包成 Recipe 供页面直接使用 */
  async getRecipe(recipeId: string): Promise<Recipe> {
    const data = await callFunction<{ recipe: Recipe } | null, { recipeId: string }>(
      'recipe',
      'getRecipe',
      { recipeId },
    );

    if (!data || !data.recipe) {
      throw new AppError('RECIPE_NOT_FOUND', '菜谱不存在或已下架');
    }

    return data.recipe;
  },

  /* ------------------------- 菜单做法（后续阶段） ------------------------- */

  /** 生成整桌菜单的做法（幂等：已生成的会直接返回） */
  generate(menuId: string): Promise<RecipeDetail[]> {
    return callFunction<RecipeDetail[], { menuId: string }>(
      'recipe',
      'generateRecipe',
      { menuId },
      { timeout: AI_REQUEST_TIMEOUT },
    );
  },

  /**
   * 查询某道菜在当前菜单下的做法。
   * 动作名用 getRecipeDetail，避免与 Phase 6 的菜谱模板详情 getRecipe 撞车。
   */
  getRecipeDetail(key: RecipeKey): Promise<RecipeDetail> {
    return callFunction<RecipeDetail, RecipeKey>('recipe', 'getRecipeDetail', key);
  },

  /** 单道菜做法重新生成 */
  retry(key: RecipeKey): Promise<RecipeDetail> {
    return callFunction<RecipeDetail, RecipeKey>('recipe', 'retryRecipe', key, {
      timeout: AI_REQUEST_TIMEOUT,
    });
  },

  /* ------------------------- Phase 10：AI 生成做法 ------------------------- */

  generateCookingSteps(recipeId: string, servings?: number, preferences?: string): Promise<GenerateCookingStepsResult> {
    return callFunction<GenerateCookingStepsResult>('recipe', 'generateCookingSteps', {
      recipeId,
      servings,
      preferences,
    }, { timeout: AI_REQUEST_TIMEOUT });
  },
};
