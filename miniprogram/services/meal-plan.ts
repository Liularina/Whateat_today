/**
 * 餐次协作服务（Phase 1）
 *
 * 全部走 menu 云函数，服务端负责家庭归属与掌勺人校验：
 *   - getMealBoard     掌勺人已保存的点单 + 家人建议汇总 + 当前掌勺人
 *   - submitPreference 只能写自己的菜品建议，不会改变最终菜单
 *   - setMealCook      只有当前掌勺人可以把这一餐交给别人
 *   - confirmMenu      只有当前掌勺人可以锁定最终菜单（不必等家人建议齐全）
 */
import type {
  MealBoard,
  SubmitPreferenceInput,
  SetMealCookInput,
} from '../types/meal-plan';
import type { MealType } from '../types/menu';
import { callFunction } from '../utils/cloud';

export const mealPlanService = {
  /** 本餐次看板；无方案时 plan 为 null，available 仍为 true */
  getBoard(familyId: string, mealType?: MealType, date?: string): Promise<MealBoard> {
    return callFunction<MealBoard, { familyId: string; mealType?: MealType; date?: string }>(
      'menu', 'getMealBoard', { familyId, mealType, date },
    );
  },

  /** 提交 / 修改自己的菜品建议 */
  submitPreference(input: SubmitPreferenceInput): Promise<{ preference: unknown }> {
    return callFunction('menu', 'submitPreference', input as unknown as Record<string, unknown>);
  },

  /** 交接本餐次掌勺人（仅当前掌勺人可操作） */
  setCook(input: SetMealCookInput): Promise<{ cookId: string; cookName: string }> {
    return callFunction('menu', 'setMealCook', input as unknown as Record<string, unknown>);
  },
};