/**
 * 菜单服务（Phase 8）
 *
 * 封装 menu 云函数调用：保存菜单、查询、锁定、换菜、批量重推、确认。
 */
import type {
  Menu,
  LockItemResult,
  ReplaceItemResult,
  RegenerateResult,
  ConfirmResult,
  MenuHistoryParams,
  MenuHistoryResult,
  TodayMenuResult,
} from '../types/menu';
import type {
  SaveMenuInput,
  SavedMenuResult,
} from '../types/ai-config';
import { AI_REQUEST_TIMEOUT } from '../constants/config';
import { callFunction } from '../utils/cloud';

export const menuService = {
  /** Phase 8：将 AI 推荐结果保存为草稿菜单 */
  saveMenu(input: SaveMenuInput): Promise<SavedMenuResult> {
    return callFunction<SavedMenuResult, Record<string, unknown>>('menu', 'saveMenu', input as unknown as Record<string, unknown>);
  },

  /** 查询菜单详情 */
  getMenu(menuId: string, familyId?: string): Promise<Menu> {
    return callFunction<Menu, { menuId: string; familyId?: string }>('menu', 'getMenu', {
      menuId,
      familyId,
    });
  },

  /** 锁定 / 取消锁定 */
  setMenuItemLocked(menuId: string, recipeId: string, locked: boolean, familyId: string): Promise<LockItemResult> {
    return callFunction<LockItemResult>('menu', 'setMenuItemLocked', {
      menuId,
      recipeId,
      locked,
      familyId,
    });
  },

  /** 换一道菜 */
  replaceMenuItem(menuId: string, recipeId: string, familyId: string, preferences?: string): Promise<ReplaceItemResult> {
    return callFunction<ReplaceItemResult>('menu', 'replaceMenuItem', {
      menuId,
      recipeId,
      familyId,
      preferences,
    }, { timeout: AI_REQUEST_TIMEOUT });
  },

  /** 重新推荐所有未锁定菜品 */
  regenerateUnlockedItems(menuId: string, familyId: string, preferences?: string): Promise<RegenerateResult> {
    return callFunction<RegenerateResult>('menu', 'regenerateUnlockedItems', {
      menuId,
      familyId,
      preferences,
    }, { timeout: AI_REQUEST_TIMEOUT });
  },

  /** 确认菜单 */
  confirmMenu(menuId: string, familyId: string): Promise<ConfirmResult> {
    return callFunction<ConfirmResult>('menu', 'confirmMenu', { menuId, familyId });
  },

  /** 今日菜单（未确认时返回 null） */
  getTodayMenu(familyId: string): Promise<TodayMenuResult> {
    return callFunction<TodayMenuResult, { familyId: string }>('menu', 'getTodayMenu', { familyId });
  },

  /** 历史菜单列表（Phase 11，默认只返回已确认菜单） */
  getMenuHistory(params: MenuHistoryParams): Promise<MenuHistoryResult> {
    return callFunction<MenuHistoryResult, MenuHistoryParams & Record<string, unknown>>(
      'menu',
      'getMenuHistory',
      params as MenuHistoryParams & Record<string, unknown>,
    );
  },
};