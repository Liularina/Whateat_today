/**
 * 菜单服务
 */
import type { Menu, MenuHistoryItem, TodayMenuResult } from '../types/menu';
import { callFunction } from '../utils/cloud';

export const menuService = {
  /** 今日菜单（未确认时返回 menu = null） */
  getTodayMenu(familyId: string): Promise<TodayMenuResult> {
    return callFunction<TodayMenuResult, { familyId: string }>('menu', 'getTodayMenu', {
      familyId,
    });
  },

  getMenu(menuId: string): Promise<Menu> {
    return callFunction<Menu, { menuId: string }>('menu', 'getMenu', { menuId });
  },

  /** 历史菜单列表（只包含最终确认过的菜单） */
  getMenuHistory(familyId: string, page = 1, pageSize = 20): Promise<MenuHistoryItem[]> {
    return callFunction<MenuHistoryItem[], { familyId: string; page: number; pageSize: number }>(
      'menu',
      'getMenuHistory',
      { familyId, page, pageSize },
    );
  },
};
