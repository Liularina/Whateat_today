/**
 * 食材分类常量
 *
 * 阶段一调整为 8 类：蔬菜 / 水果 / 肉类 / 水产 /
 * 蛋奶豆制品 / 粮食主食 / 调料与油 / 其他。
 *
 * 为了兼容历史数据，dairy 不会被删除，而是映射到 soy_product
 * 分组下统一展示为「蛋奶豆制品」。
 */
import type { IngredientCategoryCode } from '../types/ingredient';

export interface IngredientCategoryOption {
  value: IngredientCategoryCode;
  label: string;
  emoji: string;
}

export const INGREDIENT_CATEGORIES: readonly IngredientCategoryOption[] = [
  { value: 'vegetable', label: '蔬菜', emoji: '🥬' },
  { value: 'fruit', label: '水果', emoji: '🍎' },
  { value: 'meat_egg', label: '肉类', emoji: '🥩' },
  { value: 'seafood', label: '水产', emoji: '🐟' },
  { value: 'soy_product', label: '蛋奶豆制品', emoji: '🥚' },
  { value: 'staple', label: '粮食主食', emoji: '🍚' },
  { value: 'seasoning', label: '调料与油', emoji: '🧂' },
  { value: 'other', label: '其他', emoji: '🧺' },
];

/** dairy 在展示层映射为 soy_product，统一归入「蛋奶豆制品」 */
export const CATEGORY_DISPLAY_MAP: Partial<Record<IngredientCategoryCode, IngredientCategoryCode>> = {
  dairy: 'soy_product',
};

const CATEGORY_MAP: Record<string, IngredientCategoryOption> = INGREDIENT_CATEGORIES.reduce(
  (acc, item) => {
    acc[item.value] = item;
    return acc;
  },
  {} as Record<string, IngredientCategoryOption>,
);

export function getCategoryLabel(code: IngredientCategoryCode): string {
  const displayCode = CATEGORY_DISPLAY_MAP[code] || code;
  return CATEGORY_MAP[displayCode]?.label ?? '其他';
}

export function getCategoryEmoji(code: IngredientCategoryCode): string {
  const displayCode = CATEGORY_DISPLAY_MAP[code] || code;
  return CATEGORY_MAP[displayCode]?.emoji ?? '🧺';
}

export function isIngredientCategory(value: unknown): value is IngredientCategoryCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CATEGORY_MAP, value);
}
