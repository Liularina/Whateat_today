/**
 * 营养计算服务
 *
 * 只负责把「食材 + 数量 + 单位 + 人数」交给 nutrition 云函数，
 * 营养结果一律以服务端根据 nutrition_facts 计算的为准。
 *
 * familyId 是可选参数：传了就由服务端复核成员身份（营养页读的是自家库存），
 * 不传时只要求已登录（单纯的计算请求不涉及任何家庭数据）。
 */
import type { NutritionIngredientInput, NutritionResult } from '../types/nutrition';
import { callFunction } from '../utils/cloud';

interface CalculatePayload {
  ingredients: NutritionIngredientInput[];
  peopleCount: number;
  familyId?: string;
}

export const nutritionService = {
  calculate(
    ingredients: NutritionIngredientInput[],
    peopleCount: number,
    familyId?: string,
  ): Promise<NutritionResult> {
    const payload: CalculatePayload = { ingredients, peopleCount };
    if (familyId) {
      payload.familyId = familyId;
    }

    return callFunction<NutritionResult, CalculatePayload>('nutrition', 'calculateNutrition', payload);
  },
};
