/**
 * 营养计算相关类型（Phase 5）
 *
 * 字段与 nutrition 云函数 calculateNutrition 的返回结构一一对应。
 * 营养值一律由服务端根据 nutrition_facts 计算，前端不做任何营养换算，
 * 也不允许把本地的营养值回传给服务端。
 */
import type { UnitCode } from './ingredient';
import type { NutritionSummary } from './menu';

/** complete：全部食材都算得出；partial：有食材缺数据或无法换算 */
export type NutritionStatus = 'complete' | 'partial';

/**
 * 单个食材的计算状态。
 *   ok            正常参与计算
 *   missing       nutrition_facts 里没有该食材，不猜数值
 *   unconvertible 有营养数据，但「个 / 袋 / 盒」缺 averageWeight，不给精确换算
 */
export type NutritionItemStatus = 'ok' | 'missing' | 'unconvertible';

/** calculateNutrition 入参里的单个食材（只允许这三个字段） */
export interface NutritionIngredientInput {
  name: string;
  amount: number;
  unit: UnitCode;
}

/** 单个食材的计算结果 */
export interface NutritionItemResult {
  name: string;
  amount: number;
  unit: UnitCode;
  /** 可食克数；无法换算时为 null */
  grams: number | null;
  /** 该项营养；未参与计算时为 null */
  nutrition: NutritionSummary | null;
  status: NutritionItemStatus;
}

/** calculateNutrition 返回结构 */
export interface NutritionResult {
  /** 整桌合计 */
  calories: number;
  protein: number;
  fat: number;
  carbohydrate: number;
  /** 人均 */
  perPerson: NutritionSummary;
  peopleCount: number;
  nutritionStatus: NutritionStatus;
  /** 数据库里没有营养数据的食材名 */
  missing: string[];
  /** 单位无法换算为克的食材名 */
  unconvertible: string[];
  /** 实际参与计算的食材数 */
  computedCount: number;
  items: NutritionItemResult[];
}
