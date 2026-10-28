/**
 * 家庭点单相关类型（Phase 9）
 *
 * family_orders —— 每轮点单
 * family_order_items —— 每个成员在本轮的选择
 */
import type { RecipeIngredient } from './recipe';

/* ============================== 状态枚举 ============================== */

export type OrderStatus = 'open' | 'closed';

/* ============================== 数据集合 ============================== */

/** family_orders 文档 */
export interface FamilyOrder {
  _id: string;
  familyId: string;
  menuId: string;
  menuName: string;
  title: string;
  status: OrderStatus;
  deadline: string;
  note: string;
  initiatorUserId: string;
  recipeIds: string[];
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  finalSummary?: DishSummaryItem[];
  totalParticipants?: number;
}

/** family_order_items 文档（每个用户每个点单一条） */
export interface FamilyOrderItemDoc {
  _id: string;
  orderId: string;
  familyId: string;
  userId: string;
  items: OrderItemSelection[];
  createdAt: string;
  updatedAt: string;
}

/* ============================== 选择与汇总 ============================== */

/** 用户对一道菜的选择 */
export interface OrderItemSelection {
  recipeId: string;
  quantity: number;
  note: string;
}

/** 点单中的菜品展示 */
export interface OrderRecipe {
  recipeId: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  cookTime: number;
  ingredients: RecipeIngredient[];
}

/** getOrder 返回 */
export interface OrderDetail {
  order: FamilyOrder;
  recipes: OrderRecipe[];
  mySelections: OrderItemSelection[];
  canManage: boolean;
  editable: boolean;
}

/* ============================== 汇总 ============================== */

/** 按菜品汇总项 */
export interface DishSummaryItem {
  recipeId: string;
  name: string;
  category: string;
  peopleCount: number;
  totalQuantity: number;
}

/** 按成员汇总项 */
export interface MemberSummaryItem {
  userId: string;
  displayName: string;
  items: {
    recipeId: string;
    name: string;
    quantity: number;
    note: string;
  }[];
}

/** getOrderSummary 返回 */
export interface OrderSummary {
  orderId: string;
  title: string;
  status: OrderStatus;
  deadline: string;
  totalParticipants: number;
  totalDishes: number;
  dishSummary: DishSummaryItem[];
  memberSummary: MemberSummaryItem[];
  unsubmittedCount: number;
}

/* ============================== 入参 ============================== */

export interface CreateOrderInput {
  menuId: string;
  note?: string;
  deadline?: string;
}

export interface SubmitOrderItemsInput {
  orderId: string;
  items: OrderItemSelection[];
}

export interface CloseOrderResult {
  _id: string;
  status: string;
  closedAt: string;
  totalParticipants: number;
  dishSummary: DishSummaryItem[];
}

/* ============================== 列表 ============================== */

export interface OrderListParams {
  familyId: string;
  page?: number;
  pageSize?: number;
  status?: OrderStatus;
}

export interface OrderListItem {
  orderId: string;
  menuId: string;
  menuName: string;
  title: string;
  status: OrderStatus;
  initiatorUserId: string;
  initiatorName: string;
  createdAt: string;
  deadline: string;
  closedAt: string;
  memberCount: number;
}

export interface OrderListResult {
  /** 本家庭所有「进行中」点单数（不受筛选与分页影响） */
  openTotal?: number;
  items: OrderListItem[];
  total: number;
  page: number;
  pageSize: number;
}

/* ============================== 删除 ============================== */

/** deleteOrders 返回 */
/** 存量「进行中」点单批量收尾的结果 */
export interface CleanupOpenOrdersResult {
  closed: string[];
  closedCount: number;
  /** 还有更多待处理（单次最多 50 条） */
  hasMore: boolean;
}

export interface DeleteOrdersResult {
  deleted: string[];
  deletedCount: number;
}