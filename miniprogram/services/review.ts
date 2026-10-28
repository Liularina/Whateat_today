/**
 * 饭后评价与掌勺人成长服务（阶段二）
 *
 * 所有权限、幂等与积分结算都在 menu 云函数内完成；
 * 前端只传家庭 ID、菜单 ID 和评分内容，不传用户 ID 或等级。
 */
import type {
  CompleteMealResult,
  SubmitRatingsResult,
  MealReviewDetail,
  ChefGrowthResult,
  DishRating,
} from '../types/review';
import { callFunction } from '../utils/cloud';

export const reviewService = {
  /** 标记本餐已完成（幂等，重复调用不会重复发积分） */
  completeMeal(familyId: string, menuId: string): Promise<CompleteMealResult> {
    return callFunction<CompleteMealResult, { familyId: string; menuId: string }>(
      'menu',
      'completeMeal',
      { familyId, menuId },
    );
  },

  /** 提交 / 修改自己的菜品评分 */
  submitRatings(familyId: string, menuId: string, ratings: DishRating[]): Promise<SubmitRatingsResult> {
    return callFunction<SubmitRatingsResult, {
      familyId: string;
      menuId: string;
      ratings: Array<{ recipeId: string; stars: number; comment: string }>;
    }>('menu', 'submitRatings', { familyId, menuId, ratings });
  },

  /** 用餐详情：完成状态、评价汇总、掌勺人成长 */
  getMealReview(familyId: string, menuId: string): Promise<MealReviewDetail> {
    return callFunction<MealReviewDetail, { familyId: string; menuId: string }>(
      'menu',
      'getMealReview',
      { familyId, menuId },
    );
  },

  /** 掌勺人成长；不传 userId 时查询自己 */
  getChefGrowth(familyId: string, userId?: string): Promise<ChefGrowthResult> {
    return callFunction<ChefGrowthResult, { familyId: string; userId?: string }>(
      'menu',
      'getChefGrowth',
      { familyId, userId },
    );
  },
};