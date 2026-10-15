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

/* ============================== Phase D：家庭菜谱库 ============================== */

/** cookbook_versions.source 取值 */
export type CookbookVersionSource = 'generated' | 'edited';

/** family_cookbook.status 取值 */
export type CookbookStatus = 'active' | 'archived';

/**
 * family_cookbook 集合：家庭菜谱入口。
 *
 * 唯一键：(familyId, recipeId, servings)。
 * 一个家庭对同一道菜谱模版用同一人数时只存一份。
 */
export interface FamilyCookbookEntry {
  _id: string;
  familyId: string;
  /** 关联的 recipes 模版 _id */
  recipeId: string;
  /** 冗余字段：模版名称，方便列表展示不 join */
  name: string;
  /** 冗余字段：模版分类 */
  category: string;
  /** 冗余字段：难度 */
  difficulty: Difficulty;
  /** 冗余字段：烹饪时间 */
  cookTime: number;
  /** 人数（与 generateCookingSteps 入参同步） */
  servings: number;
  /** 当前最新版本号，从 1 起 */
  latestVersion: number;
  /** active | archived */
  status: CookbookStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * cookbook_versions 集合：做法版本链。
 *
 * 一条 family_cookbook 可有多行 cookbook_versions，按 version 升序。
 * source=generated 为 AI 生成的原始版本；source=edited 为人工编辑覆盖。
 * 编辑只更新当前版本的 data 与 source 字段，不新增行。
 * 重新生成会产生新行（version + 1）。
 */
export interface CookbookVersion {
  _id: string;
  cookbookId: string;
  familyId: string;
  version: number;
  source: CookbookVersionSource;
  data: GeneratedCookingData;
  createdAt: string;
  /** 谁做了这次操作（user._id） */
  createdBy: string;
}

/** 家庭菜谱列表查询参数 */
export interface CookbookListParams {
  familyId: string;
  category?: string;
  status?: CookbookStatus;
  page?: number;
  pageSize?: number;
}

/** 家庭菜谱列表项（摘要，不含做法数据） */
export interface CookbookSummary {
  _id: string;
  name: string;
  category: string;
  difficulty: Difficulty;
  cookTime: number;
  servings: number;
  latestVersion: number;
  status: CookbookStatus;
  createdAt: string;
}

/** 家庭菜谱列表返回 */
export interface CookbookListResult {
  items: CookbookSummary[];
  total: number;
  page: number;
  pageSize: number;
}

/** 家庭菜谱详情：入口 + 当前版本做法 + 所有版本号 */
export interface CookbookDetail {
  entry: FamilyCookbookEntry;
  current: CookbookVersion;
  versionList: { version: number; source: CookbookVersionSource; createdAt: string }[];
}

/* ============================== 菜谱模板库 ============================== */

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
  /** 按食材名搜索（命中菜谱 ingredients[].name），与 keyword 独立，可叠加 */
  ingredient?: string;
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
  /** 无 familyId 时回退写入旧表 generated_recipes 的 _id */
  generatedId?: string;
  /** 传 familyId 时写入家庭菜谱库的入口 _id（保存成功即有值） */
  cookbookId?: string;
  /** 保存成功的版本号 */
  version?: number;
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