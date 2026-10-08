/**
 * 家庭点菜服务
 *
 * 注意：这里的「点菜 / 订单」指家庭成员选择今晚吃什么，不涉及任何支付。
 * 状态流转与管理员权限全部由服务端状态机与 family_members 校验保证。
 */
import type {
  CreateOrderInput,
  FamilyOrder,
  OrderDetail,
  OrderSummary,
  SubmitOrderItemInput,
} from '../types/order';
import type { Menu } from '../types/menu';
import { AI_REQUEST_TIMEOUT } from '../constants/config';
import { callFunction } from '../utils/cloud';

export const orderService = {
  /** 管理员发起家庭点菜 */
  create(familyId: string, input: CreateOrderInput): Promise<FamilyOrder> {
    return callFunction<FamilyOrder, { familyId: string } & CreateOrderInput>('order', 'createOrder', {
      familyId,
      ...input,
    });
  },

  getDetail(orderId: string): Promise<OrderDetail> {
    return callFunction<OrderDetail, { orderId: string }>('order', 'getOrder', { orderId });
  },

  /** 成员提交/修改自己某道菜的选择 */
  submitItem(input: SubmitOrderItemInput): Promise<null> {
    return callFunction<null, SubmitOrderItemInput>('order', 'submitOrderItem', input);
  },

  updateItem(input: SubmitOrderItemInput): Promise<null> {
    return callFunction<null, SubmitOrderItemInput>('order', 'updateOrderItem', input);
  },

  /** 管理员截止点菜（open → closed） */
  close(orderId: string): Promise<FamilyOrder> {
    return callFunction<FamilyOrder, { orderId: string }>('order', 'closeOrder', { orderId });
  },

  /** 管理员确认最终菜单（closed → confirmed，并生成 Menu） */
  confirm(orderId: string, peopleCount: number): Promise<Menu> {
    return callFunction<Menu, { orderId: string; peopleCount: number }>(
      'order',
      'confirmOrder',
      { orderId, peopleCount },
      { timeout: AI_REQUEST_TIMEOUT },
    );
  },

  cancel(orderId: string): Promise<FamilyOrder> {
    return callFunction<FamilyOrder, { orderId: string }>('order', 'cancelOrder', { orderId });
  },

  /** 管理员查看汇总（仅 open / closed 状态可看） */
  getSummary(orderId: string): Promise<OrderSummary> {
    return callFunction<OrderSummary, { orderId: string }>('order', 'getOrderSummary', {
      orderId,
    });
  },
};
