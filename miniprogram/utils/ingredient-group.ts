/**
 * 食材列表视图模型：临期排序 + 分类分组（Phase B）
 *
 * 纯函数，不依赖 wx API，便于复用与测试。
 */
import { INGREDIENT_CATEGORIES, CATEGORY_DISPLAY_MAP, getCategoryEmoji, getCategoryLabel } from '../constants/categories';
import { KCAL_PREFIX } from '../constants/config';
import type { Ingredient, IngredientCategoryCode } from '../types/ingredient';
import { getShelfLifeStatus, type ShelfLifeStatusCode } from './shelf-life';

/** 列表展示项：展示文案在这里算好，WXML 不做判断 */
export interface IngredientView {
  _id: string;
  name: string;
  standardName: string;
  /** 原始名与标准名不同时展示的别名文案，如「（西红柿）」 */
  aliasText: string;
  quantity: number;
  unit: string;
  quantityText: string;
  category: IngredientCategoryCode;
  categoryLabel: string;
  expireDate: string;
  purchaseDate: string;
  shelfLifeDays: number | null;
  shelfLabel: string;
  shelfStatus: ShelfLifeStatusCode;
  /** 剩余天数，已过期时为负数；无到期日时为 null */
  daysLeft: number | null;
  /** 已过期（严格早于今天） */
  isExpired: boolean;
  /** 临期（剩余天数 ≤ 3，含今天到期） */
  isWarning: boolean;
  /** 估算卡路里展示文案，如「约 45 kcal」；无数据时为空字符串 */
  calorieText: string;
  remark: string;
}

/** 按分类聚合的折叠分组 */
export interface CategoryGroup {
  code: IngredientCategoryCode;
  label: string;
  emoji: string;
  items: IngredientView[];
  count: number;
  /** 过期 + 临期的条数 */
  warningCount: number;
  hasWarning: boolean;
  collapsed: boolean;
}

/** 排序权重：过期 → 临期 → 新鲜 → 无到期日 */
const STATUS_ORDER: Record<ShelfLifeStatusCode, number> = {
  expired: 0,
  warning: 1,
  fresh: 2,
  unknown: 3,
};

const VALID_CATEGORIES: Record<string, boolean> = INGREDIENT_CATEGORIES.reduce(
  (acc, item) => {
    acc[item.value] = true;
    return acc;
  },
  {} as Record<string, boolean>,
);

/** 将历史分类码映射为展示分组码；dairy → soy_product */
function mapToDisplayCategory(code: IngredientCategoryCode): string {
  const mapped = CATEGORY_DISPLAY_MAP[code];
  return mapped || code;
}

/**
 * 卡路里文案。
 *
 * 数值来源是 nutrition 云函数根据 nutrition_facts 算出的单项热量（kcal），
 * 前端只做展示，不自己做任何营养换算。
 * 键为食材 _id；缺失或非正数时返回空字符串（不展示也不猜）。
 */
function buildCalorieText(id: string, calorieMap: Record<string, number>): string {
  const calories = calorieMap[id];
  if (typeof calories !== 'number' || !Number.isFinite(calories) || calories <= 0) {
    return '';
  }
  return KCAL_PREFIX + ' ' + Math.round(calories) + ' kcal';
}

export function toIngredientView(
  item: Ingredient,
  today: Date = new Date(),
  calorieMap: Record<string, number> = {},
): IngredientView {
  const expireDate = item.expireDate || '';
  const shelf = getShelfLifeStatus(expireDate || null, today);
  const standardName = item.standardName || item.name;
  const quantity = typeof item.quantity === 'number' ? item.quantity : 0;
  const unit = item.unit || '';

  return {
    _id: item._id,
    name: item.name,
    standardName: standardName,
    aliasText: item.name && item.name !== standardName ? '（' + item.name + '）' : '',
    quantity: quantity,
    unit: unit,
    quantityText: quantity + ' ' + unit,
    category: item.category,
    categoryLabel: getCategoryLabel(item.category),
    expireDate: expireDate,
    purchaseDate: item.purchaseDate || '',
    shelfLifeDays: typeof item.shelfLifeDays === 'number' ? item.shelfLifeDays : null,
    shelfLabel: shelf.label,
    shelfStatus: shelf.status,
    daysLeft: shelf.daysLeft,
    isExpired: shelf.status === 'expired',
    isWarning: shelf.status === 'warning',
    calorieText: buildCalorieText(item._id, calorieMap),
    remark: item.remark || '',
  };
}

/**
 * 临期优先排序：已过期最前，其次临期，再按剩余天数升序。
 * 无到期日的排最后，同档内按标准名稳定排序。
 */
export function sortByShelfLife(views: IngredientView[]): IngredientView[] {
  return views.slice().sort((a, b) => {
    const orderDiff = STATUS_ORDER[a.shelfStatus] - STATUS_ORDER[b.shelfStatus];
    if (orderDiff !== 0) {
      return orderDiff;
    }
    if (a.daysLeft !== null && b.daysLeft !== null && a.daysLeft !== b.daysLeft) {
      return a.daysLeft - b.daysLeft;
    }
    return a.standardName.localeCompare(b.standardName, 'zh-Hans-CN');
  });
}

/**
 * 按分类聚合成折叠分组。
 * 分组顺序固定跟随 INGREDIENT_CATEGORIES；空分类不展示；
 * category 不在枚举内的历史数据一律归入「其他」。
 * dairy 在展示层归入 soy_product（蛋奶豆制品）。
 *
 * calorieMap 为可选的「食材 _id → 热量(kcal)」，由调用方从服务端结果构建。
 */
export function buildCategoryGroups(
  items: Ingredient[],
  collapsed: Record<string, boolean> = {},
  today: Date = new Date(),
  calorieMap: Record<string, number> = {},
): CategoryGroup[] {
  const byCategory: Record<string, IngredientView[]> = {};

  for (const item of items) {
    const view = toIngredientView(item, today, calorieMap);
    const displayKey = mapToDisplayCategory(view.category);
    const key = VALID_CATEGORIES[displayKey] ? displayKey : 'other';
    if (!byCategory[key]) {
      byCategory[key] = [];
    }
    byCategory[key].push(view);
  }

  const groups: CategoryGroup[] = [];
  for (const option of INGREDIENT_CATEGORIES) {
    const views = byCategory[option.value];
    if (!views || views.length === 0) {
      continue;
    }

    const sorted = sortByShelfLife(views);
    let warningCount = 0;
    for (const v of sorted) {
      if (v.isExpired || v.isWarning) {
        warningCount += 1;
      }
    }

    groups.push({
      code: option.value,
      label: option.label,
      emoji: option.emoji || getCategoryEmoji(option.value),
      items: sorted,
      count: sorted.length,
      warningCount: warningCount,
      hasWarning: warningCount > 0,
      collapsed: !!collapsed[option.value],
    });
  }

  return groups;
}
