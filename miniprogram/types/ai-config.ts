/**
 * AI 配置相关类型（Phase 7 / Phase C）
 *
 * 两种模式（Phase C 新增）：
 *   builtin —— 平台内置 AI，开箱即用，无需用户配置；
 *   custom  —— 用户自配 OpenAI 兼容 API，Key 以 AES-256-GCM 密文存 user_ai_configs。
 *
 * API Key 仅以密文存储，前端不感知；内置通道凭据只存在于云函数环境变量。
 */
import type { MealType } from './menu';
import type { RecipeIngredient } from './recipe';

/** AI 服务模式 */
export type AiMode = 'builtin' | 'custom';

/** 内置 AI 通道对外状态（服务端不会返回 Base URL / 模型名 / 凭据） */
export interface AiBuiltinStatus {
  /** 是否开启（服务端环境变量控制） */
  enabled: boolean;
  /** 是否已配齐凭据，可实际调用 */
  ready: boolean;
  /** 每用户每日调用上限 */
  dailyQuota: number;
}

/** 内置 AI 今日额度（按北京时间自然日） */
export interface AiQuotaInfo {
  dailyQuota: number;
  used: number;
  remaining: number;
}

/** ai-config 云函数 getAiConfig 返回 */
export interface AiConfigInfo {
  configured: boolean;
  baseUrl: string;
  model: string;
  maskedApiKey: string;
  /** 当前生效的 AI 模式 */
  mode: AiMode;
  /** 内置通道状态 */
  builtin: AiBuiltinStatus;
  /** 今日内置额度 */
  quota: AiQuotaInfo;
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
  /** 若因删除配置而把模式退回内置，这里是退回后的模式；否则为 null */
  mode?: AiMode | null;
  /** 是否发生了模式回退 */
  modeReset?: boolean;
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
  /** true = 家人明确要求换一批；服务端会校验只有掌勺人可以重新生成 */
  force?: boolean;
  /** 已确认菜单被替换时，掌勺人二次确认标记 */
  confirmReplace?: boolean;
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
  /** 方案在本次餐次中的稳定 ID（如 plan-1），用于偏好记录 */
  planId?: string;
  title: string;
  reason: string;
  recipeIds: string[];
  items: RecommendRecipeView[];
  totalCookTime: number;
  /** 现有食材覆盖的食材种类数（服务端计算） */
  inventoryMatchedCount: number;
  /** 还需额外采购的食材种类数 */
  missingCount: number;
  /** 还需额外采购的食材名（服务端根据真实菜谱数据计算，不采信 AI） */
  missingIngredients: string[];
  /** 现有库存是否已完全覆盖该菜单 */
  fullyCovered: boolean;
}

/** recommend 云函数 recommendMenus 返回 */
export interface RecommendMenusResult {
  recommendationId: string;
  /** 落库后的方案文档 ID；集合缺失时为空串（不阻断推荐） */
  planId?: string;
  planStatus?: 'open' | 'confirmed';
  planVersion?: number;
  shared?: boolean;
  /** 本次是否直接复用了本餐次已有方案 */
  reused?: boolean;
  cookId?: string;
  cookName?: string;
  /** 方案确认后关联的最终菜单 */
  menuId?: string;
  date?: string;
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
  /** Phase 1：来源方案标题（便于历史菜单展示） */
  planTitle?: string;
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