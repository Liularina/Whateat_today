/**
 * 家庭点单服务（Phase 9）
 */
import type {
  FamilyOrder,
  OrderDetail,
  OrderSummary,
  CreateOrderInput,
  SubmitOrderItemsInput,
  CloseOrderResult,
  OrderListParams,
  OrderListResult,
  DeleteOrdersResult,
  CleanupOpenOrdersResult,
} from '../types/order';
import { callFunction } from '../utils/cloud';

export const orderService = {
  /** 从已确认菜单发起点单 */
  createOrder(familyId: string, input: CreateOrderInput): Promise<FamilyOrder> {
    return callFunction<FamilyOrder, { familyId: string } & CreateOrderInput>('order', 'createOrder', {
      familyId,
      ...input,
    });
  },

  /** 查询点单详情（含菜品 + 我的选择） */
  getDetail(orderId: string): Promise<OrderDetail> {
    return callFunction<OrderDetail, { orderId: string }>('order', 'getOrder', { orderId });
  },

  /** 家庭成员点单列表 */
  listOrders(params: OrderListParams): Promise<OrderListResult> {
    return callFunction<OrderListResult, OrderListParams>('order', 'listOrders', params);
  },

  /** 提交/修改自己的点单选择 */
  submitItems(input: SubmitOrderItemsInput): Promise<{ orderId: string; savedCount: number }> {
    return callFunction('order', 'submitOrderItems', input);
  },

  /** 管理员查看汇总 */
  getSummary(orderId: string): Promise<OrderSummary> {
    return callFunction<OrderSummary, { orderId: string }>('order', 'getOrderSummary', { orderId });
  },

  /** 关闭点单 */
  close(orderId: string): Promise<CloseOrderResult> {
    return callFunction<CloseOrderResult, { orderId: string }>('order', 'closeOrder', { orderId });
  },

  /**
   * 一次性关闭历史遗留的「进行中」点单（仅家庭管理员）。
   * 份数点单功能已移除，旧点单永远等不到全员提交，只能批量收尾后才能删除。
   */
  cleanupOpenOrders(familyId: string): Promise<CleanupOpenOrdersResult> {
    return callFunction<CleanupOpenOrdersResult, { familyId: string }>(
      'order',
      'cleanupOpenOrders',
      { familyId },
    );
  },

  /**
   * 批量删除已关闭的点单。
   * 服务端会拒绝未关闭的点单，并只允许管理员或发起人操作。
   */
  deleteOrders(familyId: string, orderIds: string[]): Promise<DeleteOrdersResult> {
    return callFunction<DeleteOrdersResult, { familyId: string; orderIds: string[] }>(
      'order',
      'deleteOrders',
      { familyId, orderIds },
    );
  },
};