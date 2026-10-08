/**
 * 做法服务
 *
 * 做法由 AI 在「菜单确认后」生成，服务端会校验：
 * 使用最终确认的食材与用量、不加入过敏原、不删除核心食材。
 */
import type { RecipeDetail } from '../types/recipe';
import { AI_REQUEST_TIMEOUT } from '../constants/config';
import { callFunction } from '../utils/cloud';

export interface RecipeKey {
  menuId: string;
  recipeId: string;
}

export const recipeService = {
  /** 生成整桌菜单的做法（幂等：已生成的会直接返回） */
  generate(menuId: string): Promise<RecipeDetail[]> {
    return callFunction<RecipeDetail[], { menuId: string }>(
      'recipe',
      'generateRecipe',
      { menuId },
      { timeout: AI_REQUEST_TIMEOUT },
    );
  },

  get(key: RecipeKey): Promise<RecipeDetail> {
    return callFunction<RecipeDetail, RecipeKey>('recipe', 'getRecipe', key);
  },

  /** 单道菜做法重新生成 */
  retry(key: RecipeKey): Promise<RecipeDetail> {
    return callFunction<RecipeDetail, RecipeKey>('recipe', 'retryRecipe', key, {
      timeout: AI_REQUEST_TIMEOUT,
    });
  },
};
