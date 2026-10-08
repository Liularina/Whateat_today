/**
 * 菜单相关类型
 */
import type { Difficulty, RecipeIngredient } from './recipe';

export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'midnight_snack';

export type MenuStatus = 'draft' | 'confirmed' | 'completed';

/** 四类营养汇总（热量 kcal，其余为 g） */
export interface NutritionSummary {
  calories: number;
  protein: number;
  fat: number;
  carbohydrate: number;
}

/** 菜单中的一道菜 */
export interface MenuItem {
  recipeId: string;
  name: string;
  description: string;
  ingredients: RecipeIngredient[];
  cookTime: number;
  difficulty: Difficulty;
  /** 该菜由服务端重新计算的营养值 */
  nutrition: NutritionSummary;
}

/** menus 集合文档：最终确认菜单 */
export interface Menu {
  _id: string;
  familyId: string;
  mealType: MealType;
  peopleCount: number;
  items: MenuItem[];
  totalNutrition: NutritionSummary;
  perPersonNutrition: NutritionSummary;
  status: MenuStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** 历史菜单列表项 */
export interface MenuHistoryItem {
  _id: string;
  familyId: string;
  mealType: MealType;
  /** 展示用日期，格式 YYYY-MM-DD */
  dateLabel: string;
  dishNames: string[];
  perPersonCalories: number;
  createdAt: string;
}

/** 今日菜单查询结果 */
export interface TodayMenuResult {
  menu: Menu | null;
  /** 该菜单对应的做法是否已生成完毕 */
  recipeGenerated: boolean;
}
