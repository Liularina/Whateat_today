/**
 * 食材分类常量
 */
import type { IngredientCategoryCode } from '../types/ingredient';

export interface IngredientCategoryOption {
  value: IngredientCategoryCode;
  label: string;
  emoji: string;
}

export const INGREDIENT_CATEGORIES: readonly IngredientCategoryOption[] = [
  { value: 'vegetable', label: '蔬菜', emoji: '🥬' },
  { value: 'meat_egg', label: '肉蛋', emoji: '🥩' },
  { value: 'seafood', label: '水产', emoji: '🐟' },
  { value: 'staple', label: '主食', emoji: '🍚' },
  { value: 'soy_product', label: '豆制品', emoji: '🫘' },
  { value: 'seasoning', label: '调味', emoji: '🧂' },
  { value: 'dairy', label: '乳制品', emoji: '🥛' },
  { value: 'fruit', label: '水果', emoji: '🍎' },
  { value: 'other', label: '其他', emoji: '🧺' },
];

const CATEGORY_MAP: Record<string, IngredientCategoryOption> = INGREDIENT_CATEGORIES.reduce(
  (acc, item) => {
    acc[item.value] = item;
    return acc;
  },
  {} as Record<string, IngredientCategoryOption>,
);

export function getCategoryLabel(code: IngredientCategoryCode): string {
  return CATEGORY_MAP[code]?.label ?? '其他';
}

export function getCategoryEmoji(code: IngredientCategoryCode): string {
  return CATEGORY_MAP[code]?.emoji ?? '🧺';
}

export function isIngredientCategory(value: unknown): value is IngredientCategoryCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CATEGORY_MAP, value);
}
