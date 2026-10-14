/**
 * 采购清单服务（Phase E1 / E3）
 *
 * 封装 shopping 云函数：生成 / 读取 / 勾选采购项。
 */
import type {
  ShoppingList,
  GetShoppingListResult,
  ToggleShoppingItemResult,
} from '../types/shopping';
import { callFunction } from '../utils/cloud';

export const shoppingService = {
  /** 按已确认菜单 + 当前库存生成（或刷新）采购清单 */
  generate(familyId: string, menuId: string): Promise<ShoppingList> {
    return callFunction<ShoppingList, { familyId: string; menuId: string }>(
      'shopping',
      'generateShoppingList',
      { familyId, menuId },
    );
  },

  /** 读取采购清单；不传 menuId 时返回该家庭最近更新的一份 */
  get(familyId: string, menuId?: string): Promise<GetShoppingListResult> {
    return callFunction<GetShoppingListResult, { familyId: string; menuId?: string }>(
      'shopping',
      'getShoppingList',
      { familyId, menuId },
    );
  },

  /** 勾选 / 取消勾选某一项 */
  toggle(familyId: string, menuId: string, key: string, checked: boolean): Promise<ToggleShoppingItemResult> {
    return callFunction<
      ToggleShoppingItemResult,
      { familyId: string; menuId: string; key: string; checked: boolean }
    >('shopping', 'toggleShoppingItem', { familyId, menuId, key, checked });
  },
};
