/**
 * AI 配置相关类型（Phase 7）
 *
 * 用户自定义模型 API 配置：
 *   - 数据存入 user_ai_configs 集合
 *   - API Key 仅以 AES-256-GCM 密文存储，前端不感知
 */
import type { MealType } from './menu';
import type { RecipeIngredient } from './recipe';

/** ai-config 云函数 getAiConfig 返回 */
export interface AiConfigInfo {
  configured: boolean;
  baseUrl: string;
  model: string;
  maskedApiKey: string;
}

/** ai-config 云函数 saveAiConfig 入参 */
export interface AiConfigInput {
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** ai-config 云函数 deleteAiConfig 返回 */
export interface AiConfigDeleteResult {
  deleted: boolean;
}

/** ai-config 云函数 testAiConfig 返回 */
export interface AiConfigTestResult {
  connected: boolean;
  message: string;
  errorCode?: string;
}

/* ============================== 推荐相关（Phase 7） ============================== */

/** recommend 云函数 recommendMenus 入参 */
export interface RecommendMenusInput {
  familyId: string;
  mealType: MealType;
  servings: number;
  preferences?: string;
  excludeRecipeIds?: string[];
}

/** 推荐菜谱视图（前端展示用） */
export interface RecommendRecipeView {
  _id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  difficulty: string;
  cookTime: number;
  servings: number;
  ingredients: RecipeIngredient[];
}

/** 一套推荐菜单 */
export interface RecommendMenuView {
  title: string;
  reason: string;
  recipeIds: string[];
  items: RecommendRecipeView[];
  totalCookTime: number;
}

/** recommend 云函数 recommendMenus 返回 */
export interface RecommendMenusResult {
  recommendationId: string;
  mealType: MealType;
  servings: number;
  familyId?: string;
  inventoryCount: number;
  candidateCount: number;
  menus: RecommendMenuView[];
  createdAt: string;
}

/** saveMenu 云函数入参 */
export interface SaveMenuInput {
  familyId: string;
  mealType: MealType;
  servings: number;
  items: RecommendRecipeView[];
}

/** saveMenu 云函数返回（等同于 Menu） */
export interface SavedMenuResult {
  menuId: string;
  _id: string;
  familyId: string;
  userId: string;
  mealType: MealType;
  servings: number;
  items: SavedMenuItem[];
  status: string;
  createdAt: string;
  updatedAt: string;
}

/** 已保存菜单中的菜品（含 locked/position/source） */
export interface SavedMenuItem {
  recipeId: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  difficulty: string;
  cookTime: number;
  servings: number;
  ingredients: RecipeIngredient[];
  locked: boolean;
  position: number;
  source: string;
}