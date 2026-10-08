/**
 * 菜谱与做法相关类型
 */
import type { UnitCode } from './ingredient';

export type Difficulty = 'easy' | 'medium' | 'hard';

/** 菜谱/做法的食材用量 */
export interface RecipeIngredient {
  name: string;
  amount: number;
  unit: UnitCode;
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

export type RecipeSource = 'template' | 'ai' | 'manual';

/** recipes 集合文档：菜谱模板库 */
export interface Recipe {
  _id: string;
  name: string;
  description: string;
  tags: string[];
  difficulty: Difficulty;
  /** 预计烹饪时间（分钟） */
  cookTime: number;
  ingredients: RecipeIngredient[];
  steps: RecipeStep[];
  source: RecipeSource;
  createdAt: string;
  updatedAt: string;
}

export type RecipeDetailStatus = 'pending' | 'generated' | 'failed';

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
