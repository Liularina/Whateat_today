/**
 * AI 推荐会话相关类型
 *
 * 推荐结果会以 recommendationId 为会话标识落库，
 * 「换一换 / 锁定 / 确认菜单」都基于同一个推荐会话完成。
 */
import type { MealType, NutritionSummary } from './menu';
import type { Difficulty, RecipeIngredient } from './recipe';

/** 推荐条件，对应 recommend 云函数入参 */
export interface RecommendConditions {
  familyId: string;
  peopleCount: number;
  mealType: MealType;
  taste: string[];
  avoidIngredients: string[];
  allergens: string[];
  maxCookTime: number;
  clearInventoryFirst: boolean;
}

/** 推荐结果中的一道菜 */
export interface RecommendItem {
  recipeId: string;
  name: string;
  description: string;
  ingredients: RecipeIngredient[];
  cookTime: number;
  difficulty: Difficulty;
  /** 服务端根据 nutrition_facts 重算的营养值，AI 输出不作为最终值 */
  nutrition: NutritionSummary;
  /** 库存匹配度 0~1 */
  matchScore: number;
  matchReasons: string[];
  /** 库存中缺少的食材 */
  missingIngredients: string[];
  locked: boolean;
}

/** 一套候选菜单方案 */
export interface RecommendMenu {
  id: string;
  name: string;
  description: string;
  items: RecommendItem[];
  /** 整桌预计烹饪时间（分钟） */
  totalCookTime: number;
  difficulty: Difficulty;
  totalNutrition: NutritionSummary;
  perPersonNutrition: NutritionSummary;
  matchReasons: string[];
}

/** recommend 云函数 generateRecommendations 返回 */
export interface Recommendation {
  recommendationId: string;
  familyId: string;
  conditions: RecommendConditions;
  menus: RecommendMenu[];
  /** 是否由模板菜谱降级生成 */
  fallback: boolean;
  createdAt: string;
}

/** 「换一换」入参 */
export interface ReplaceDishInput {
  familyId: string;
  recommendationId: string;
  /** 第几套方案，默认 0 */
  menuIndex?: number;
  /** 方案内要替换的菜品下标 */
  targetIndex: number;
  /** 已锁定菜品名称，禁止被替换 */
  lockedItems: string[];
}

/** 「换一换」返回：只替换目标菜品，其余锁定菜品保持不变 */
export interface ReplaceDishResult {
  menuIndex: number;
  targetIndex: number;
  item: RecommendItem;
}
