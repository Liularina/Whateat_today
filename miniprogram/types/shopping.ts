/**
 * 采购清单相关类型（Phase E1 / E3）
 *
 * 服务端由 shopping 云函数返回，这里的结构对应 cloudfunctions/shopping/index.js
 * 的 toListView 输出，前端不再自行拼装 items。
 */
import type { IngredientCategoryCode } from './ingredient';
import type { MealType } from './menu';

/** shopping_lists.items[]：一条采购项 */
export interface ShoppingItem {
  /** 稳定标识「名称|单位」，勾选状态按它持久化 */
  key: string;
  name: string;
  /** 归一化后的单位：kg 已换算为 g，其余保持原生单位 */
  unit: string;
  category: IngredientCategoryCode;
  categoryLabel: string;
  /** 按用餐人数换算后的总需要量 */
  needed: number;
  /** 现有库存量（同单位） */
  stock: number;
  /** 还需要采购的量；已备齐时为 0 */
  toBuy: number;
  /** 是否已备齐（库存 >= 需要量） */
  enough: boolean;
  /** 是否已勾选（家人共享） */
  checked: boolean;
  /** 需要该食材的菜品名 */
  dishes: string[];
}

/** 按食材分类分组后的采购项 */
export interface ShoppingGroup {
  category: IngredientCategoryCode;
  label: string;
  items: ShoppingItem[];
  /** 该分类下还需采购的条数 */
  toBuyCount: number;
}

/** 清单汇总统计 */
export interface ShoppingSummary {
  total: number;
  toBuyCount: number;
  inStockCount: number;
  checkedCount: number;
}

/** shopping_lists 集合的前端视图 */
export interface ShoppingList {
  listId: string;
  familyId: string;
  menuId: string;
  mealType: MealType;
  servings: number;
  /** 菜单日期 YYYY-MM-DD */
  dateLabel: string;
  items: ShoppingItem[];
  groups: ShoppingGroup[];
  summary: ShoppingSummary;
  createdAt: string;
  updatedAt: string;
}

/** getShoppingList 返回：没有清单是正常状态，此时 list 为 null */
export interface GetShoppingListResult {
  list: ShoppingList | null;
}

/** toggleShoppingItem 返回 */
export interface ToggleShoppingItemResult {
  listId: string;
  menuId: string;
  key: string;
  checked: boolean;
  summary: ShoppingSummary;
  updatedAt: string;
}
