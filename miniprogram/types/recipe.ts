/**
 * 菜谱与做法相关类型
 */
export type Difficulty = 'easy' | 'medium' | 'hard';

/**
 * 菜谱/做法的食材用量。
 *
 * unit 是「烹饪单位」（g / 个 / 勺 / 根 / 瓣 / 片 / 适量 …），因此为自由字符串，
 * 与库存的 UnitCode（g / kg / 个 / 袋 / 盒）不是同一套约束：
 * 库存单位必须可换算为克，菜谱只需能照着做。
 * 营养计算使用 types/nutrition.ts 中自带的 UnitCode 类型，不受此处影响。
 */
export interface RecipeIngredient {
  name: string;
  amount: number;
  unit: string;
}

/** 做法步骤 */
export interface RecipeStep {
  step: number;
  description: string;
  minutes: number;
}

/** 替代方案 */
export interface RecipeSubstitution {
  original: string;
  replacement: string;
}

export type RecipeSource = 'template' | 'ai' | 'manual' | 'builtin';

/** recipes 集合文档：菜谱模板库 */
export interface Recipe {
  _id: string;
  name: string;
  description: string;
  /** 菜谱分类，取值见 constants/recipe.ts 的 RECIPE_CATEGORIES */
  category: string;
  tags: string[];
  difficulty: Difficulty;
  /** 预计烹饪时间（分钟） */
  cookTime: number;
  /** 默认适用人数 */
  servings: number;
  ingredients: RecipeIngredient[];
  steps: RecipeStep[];
  source: RecipeSource;
  /** 是否启用；已禁用的菜谱不返回给客户端 */
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 菜谱列表查询参数（Phase 6） */
export interface RecipeListParams {
  /** 分类；「全部」或留空表示不筛选 */
  category?: string;
  /** 按菜名搜索的关键词 */
  keyword?: string;
  page?: number;
  pageSize?: number;
}

/**
 * 列表页展示用的菜谱摘要。
 * 列表接口刻意不返回 ingredients / steps，避免一次传回大量列表用不到的数据；
 * 完整内容由 getRecipe 详情接口返回。
 */
export interface RecipeSummary {
  _id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  difficulty: Difficulty;
  cookTime: number;
  servings: number;
}

/** 菜谱列表查询结果（Phase 6） */
export interface RecipeListResult {
  items: RecipeSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export type RecipeDetailStatus = 'pending' | 'generated' | 'failed';

/** Phase 10：AI 生成的详细做法数据结构 */
export interface GeneratedCookingData {
  introduction: string;
  ingredients: RecipeIngredient[];
  preparation: string[];
  steps: RecipeStep[];
  tips: string[];
  safetyNotes: string[];
  servings?: number;
}

/** generateCookingSteps 返回 */
export interface GenerateCookingStepsResult {
  source: 'cached' | 'generated';
  recipeId: string;
  generatedId?: string;
  data: GeneratedCookingData;
  createdAt: string;
}

/** 菜单确认后由 AI 生成的最终做法 */
export interface RecipeDetail {
  _id: string;
  menuId: string;
  recipeId: string;
  name: string;
  /** 准备工作 */
  preparation: string[];
  ingredients: RecipeIngredient[];
  steps: RecipeStep[];
  tips: string[];
  substitutions: RecipeSubstitution[];
  /** 生成时采用的用餐人数 */
  peopleCount: number;
  difficulty: Difficulty;
  /** 预计时间（分钟） */
  cookTime: number;
  status: RecipeDetailStatus;
  createdAt: string;
  updatedAt: string;
}
