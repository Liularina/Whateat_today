/**
 * 食材与营养相关类型
 */

/** 第一阶段仅支持的单位；kg 必须能换算为 g */
export type UnitCode = 'g' | 'kg' | '个' | '袋' | '盒';

export type IngredientCategoryCode =
  | 'vegetable'
  | 'meat_egg'
  | 'seafood'
  | 'staple'
  | 'soy_product'
  | 'seasoning'
  | 'dairy'
  | 'fruit'
  | 'other';

/** ingredients 集合文档 */
export interface Ingredient {
  _id: string;
  familyId: string;
  /** 用户原始输入，例如「西红柿」 */
  name: string;
  /** 标准化后的标准名称，例如「番茄」 */
  standardName: string;
  quantity: number;
  unit: UnitCode;
  category: IngredientCategoryCode;
  /** 可选保质期，格式 YYYY-MM-DD，未填写为 null */
  expireDate: string | null;
  /** Phase B：购买日期，格式 YYYY-MM-DD，未填写为 null */
  purchaseDate: string | null;
  /** Phase B：保质天数；与 purchaseDate 同时存在时可自动推导 expireDate */
  shelfLifeDays: number | null;
  remark: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** 新增/修改食材的入参 */
export interface IngredientInput {
  name: string;
  quantity: number;
  unit: UnitCode;
  category: IngredientCategoryCode;
  /** 显式到期日；留空时由 purchaseDate + shelfLifeDays 自动推导 */
  expireDate?: string | null;
  /** Phase B：购买日期 */
  purchaseDate?: string | null;
  /** Phase B：保质天数 */
  shelfLifeDays?: number | null;
  remark?: string;
}

/** ingredient_aliases 集合文档：别名 → 标准名称 */
export interface IngredientAlias {
  _id: string;
  alias: string;
  standardName: string;
}

/** 每 100g 营养值 */
export interface NutritionPer100g {
  /** 千卡 */
  calories: number;
  /** 克 */
  protein: number;
  /** 克 */
  fat: number;
  /** 克 */
  carbohydrate: number;
}

/** nutrition_facts 集合文档 */
export interface NutritionFact {
  _id: string;
  standardName: string;
  per100g: NutritionPer100g;
  /** 可食比例，0~1 */
  edibleRate: number;
  /** 单个/袋/盒的平均重量（g），用于把「个」换算为克；未知为 null */
  averageWeight: number | null;
  source: 'internal' | 'external';
}
