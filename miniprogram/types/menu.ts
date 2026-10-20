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
  category: string;
  tags: string[];
  ingredients: RecipeIngredient[];
  cookTime: number;
  difficulty: Difficulty;
  servings: number;
  /** 该菜由服务端重新计算的营养值 */
  nutrition?: NutritionSummary;
  /** 该菜的营养计算状态：complete（全有数据）或 partial（有食材缺数据/无法换算） */
  nutritionStatus?: 'complete' | 'partial';
  /** Phase 8：锁定状态 */
  locked: boolean;
  /** Phase 8：显示顺序（0-based） */
  position: number;
  /** Phase 8：菜品来源 */
  source: 'ai_recommendation' | 'manual_replacement';
}

/** menus 集合文档 */
export interface Menu {
  _id: string;
  familyId: string;
  userId: string;
  mealType: MealType;
  servings: number;
  items: MenuItem[];
  status: MenuStatus;
  /** 整体营养计算状态（确认时写入） */
  nutritionStatus?: 'complete' | 'partial';
  createdAt: string;
  updatedAt: string;
}

/** 菜单列表项（Phase 11 历史菜单） */
export interface MenuListItem {
  _id: string;
  menuId: string;
  mealType: MealType;
  servings: number;
  status: MenuStatus;
  dateLabel: string;
  dishCount: number;
  dishNames: string[];
  /** Phase A：该菜单的合计热量（kcal），来自确认时的营养快照；无数据时为 0 */
  totalCalories: number;
  /** Phase 1：该菜单的合计蛋白质（g），无数据时为 0 */
  totalProtein: number;
  /** Phase 1：该菜单的合计脂肪（g），无数据时为 0 */
  totalFat: number;
  /** Phase 1：该菜单的合计碳水（g），无数据时为 0 */
  totalCarbs: number;
  /** Phase A：该菜单的营养计算状态 */
  nutritionStatus: 'complete' | 'partial' | 'unknown';
  createdAt: string;
  updatedAt: string;
}

/** getMenuHistory 入参 */
export interface MenuHistoryParams {
  familyId: string;
  page?: number;
  pageSize?: number;
  status?: MenuStatus;
  startDate?: string;
  endDate?: string;
}

/** getMenuHistory 返回 */
export interface MenuHistoryResult {
  items: MenuListItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** getTodayMenu 返回 */
export interface TodayMenuResult {
  menu: Menu | null;
  recipeGenerated: boolean;
}

/** 锁定/取消锁定返回 */
export interface LockItemResult {
  menuId: string;
  recipeId: string;
  locked: boolean;
  updatedAt: string;
}

/** 换菜返回 */
export interface ReplaceItemResult {
  menuId: string;
  replaced: { recipeId: string; name: string };
  newItem: MenuItem;
  updatedAt: string;
}

/** 批量重推返回 */
export interface RegenerateResult {
  menuId: string;
  items: MenuItem[];
  lockedCount: number;
  replacedCount: number;
  updatedAt: string;
}

/** 确认菜单返回 */
export interface ConfirmResult {
  menuId: string;
  status: string;
  updatedAt: string;
}
