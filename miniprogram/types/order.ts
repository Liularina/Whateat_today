/**
 * 家庭点菜相关类型
 *
 * 注意：FamilyOrder 表示「家庭成员选择今晚吃什么」的过程，
 * 与 Menu（最终确认菜单）是两个不同的数据实体，禁止合并。
 */
import type { NutritionSummary } from './menu';

/** 点菜状态机，只允许按顺序流转 */
export type OrderStatus =
  | 'draft'
  | 'open'
  | 'closed'
  | 'confirmed'
  | 'recipe_generated'
  | 'completed'
  | 'cancelled';

/** family_orders 集合文档 */
export interface FamilyOrder {
  _id: string;
  familyId: string;
  /** 确认后关联的菜单 ID，确认前为 null */
  menuId: string | null;
  title: string;
  status: OrderStatus;
  /** 截止时间，ISO 字符串；判断以服务端为准 */
  deadline: string;
  /** 候选菜品对应的菜谱 ID */
  recipeIds: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** family_order_items 集合文档：某个成员对某道菜的选择 */
export interface FamilyOrderItem {
  _id: string;
  orderId: string;
  userId: string;
  recipeId: string;
  quantity: number;
  remark: string;
  createdAt: string;
  updatedAt: string;
}

/** 候选菜品展示信息 */
export interface OrderRecipeOption {
  recipeId: string;
  name: string;
  description: string;
}

/** 创建点菜入参 */
export interface CreateOrderInput {
  title: string;
  /** 截止时间，ISO 字符串 */
  deadline: string;
  recipeIds: string[];
  remark?: string;
}

/** 成员提交单道菜的选择 */
export interface SubmitOrderItemInput {
  orderId: string;
  recipeId: string;
  quantity: number;
  remark?: string;
}

/** 成员当前选择的汇总视图 */
export interface OrderMySelection {
  recipeId: string;
  quantity: number;
  remark: string;
}

/** 点菜详情：订单 + 候选菜 + 我的选择 */
export interface OrderDetail {
  order: FamilyOrder;
  recipes: OrderRecipeOption[];
  mySelections: OrderMySelection[];
  /** 当前用户是否为管理员 */
  canManage: boolean;
  /** 服务端判定的当前是否可提交 */
  editable: boolean;
}

/** 管理员汇总中的单道菜统计 */
export interface OrderSummaryItem {
  recipeId: string;
  name: string;
  /** 选择该菜的人数 */
  peopleCount: number;
  /** 份数合计 */
  totalQuantity: number;
  /** 选择该菜的成员昵称，仅管理员可见 */
  memberNames: string[];
}

/** 管理员汇总结果 */
export interface OrderSummary {
  orderId: string;
  title: string;
  status: OrderStatus;
  totalParticipants: number;
  totalDishes: number;
  totalNutrition: NutritionSummary;
  perPersonNutrition: NutritionSummary;
  items: OrderSummaryItem[];
}
