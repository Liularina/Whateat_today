/**
 * 采购清单（Phase E1 → E3：勾选持久化 / 一键复制）
 *
 * 入口：
 *   - 菜单详情 →「采购清单 ›」（携带 menuId，未生成时自动生成）
 *   - 无 menuId 打开时展示该家庭最近一份清单
 */
import { MEAL_TYPE_LABELS } from '../../constants/config';
import { shoppingService } from '../../services/shopping';
import { getErrorMessage } from '../../utils/cloud';
import type { IngredientCategoryCode } from '../../types/ingredient';
import type { ShoppingItem, ShoppingSummary } from '../../types/shopping';

/* --------------------- 展示层结构 --------------------- */

interface ShoppingItemView extends ShoppingItem {
  needText: string;
  stockText: string;
  toBuyText: string;
  dishesText: string;
}

interface ShoppingGroupView {
  category: IngredientCategoryCode;
  label: string;
  toBuyCount: number;
  items: ShoppingItemView[];
}

const EMPTY_SUMMARY: ShoppingSummary = {
  total: 0,
  toBuyCount: 0,
  inStockCount: 0,
  checkedCount: 0,
};

/** 数量展示：g 超过 1000 归一到 kg，其余保留原单位 */
function formatAmount(amount: number, unit: string): string {
  const value = Math.round(amount * 100) / 100;
  if (unit === 'g' && value >= 1000) {
    return Math.round((value / 1000) * 100) / 100 + ' kg';
  }
  return value + ' ' + unit;
}

function toItemView(item: ShoppingItem): ShoppingItemView {
  const dishesText = item.dishes && item.dishes.length > 0
    ? '用于：' + item.dishes.join('、')
    : '';
  return {
    ...item,
    needText: '共需 ' + formatAmount(item.needed, item.unit),
    stockText: item.stock > 0 ? '现有 ' + formatAmount(item.stock, item.unit) : '',
    toBuyText: item.enough ? '已备齐' : '需购 ' + formatAmount(item.toBuy, item.unit),
    dishesText: dishesText,
  };
}

function recount(groups: ShoppingGroupView[]): ShoppingSummary {
  const summary: ShoppingSummary = { total: 0, toBuyCount: 0, inStockCount: 0, checkedCount: 0 };
  groups.forEach((group) => {
    group.items.forEach((item) => {
      summary.total += 1;
      if (item.enough) summary.inStockCount += 1;
      else summary.toBuyCount += 1;
      if (item.checked) summary.checkedCount += 1;
    });
  });
  return summary;
}

Page({
  data: {
    menuId: '',
    loading: true,
    error: '',
    regenerating: false,

    hasList: false,
    mealTypeLabel: '',
    servings: 0,
    dateLabel: '',
    groups: [] as ShoppingGroupView[],
    summary: EMPTY_SUMMARY,
  },

  onLoad(query: Record<string, string | undefined>) {
    this.setData({ menuId: query.menuId || '' });
    void this.load();
  },

  onRetry() {
    void this.load();
  },

  async load() {
    const app = getApp<IAppOption>();
    const family = app.globalData.family;
    if (!family) {
      this.setData({ loading: false, error: '请先创建或加入家庭' });
      return;
    }

    this.setData({ loading: true, error: '' });
    try {
      let list = null;
      if (this.data.menuId) {
        const result = await shoppingService.get(family._id, this.data.menuId);
        list = result.list;
        if (!list) {
          // 菜单已确认但还没生成过 → 直接生成，省去用户多点一次
          list = await shoppingService.generate(family._id, this.data.menuId);
        }
      } else {
        const result = await shoppingService.get(family._id);
        list = result.list;
      }

      if (!list) {
        this.setData({
          loading: false,
          hasList: false,
          groups: [],
          summary: EMPTY_SUMMARY,
          mealTypeLabel: '',
          servings: 0,
          dateLabel: '',
        });
        return;
      }

      const groups: ShoppingGroupView[] = (list.groups || []).map((group) => ({
        category: group.category,
        label: group.label,
        toBuyCount: group.toBuyCount,
        items: group.items.map(toItemView),
      }));

      this.setData({
        menuId: list.menuId,
        loading: false,
        hasList: true,
        groups: groups,
        summary: list.summary || recount(groups),
        mealTypeLabel: MEAL_TYPE_LABELS[list.mealType] || list.mealType,
        servings: list.servings,
        dateLabel: list.dateLabel,
      });
    } catch (e) {
      this.setData({ loading: false, error: getErrorMessage(e, '采购清单加载失败') });
    }
  },

  /** 勾选 / 取消勾选：先乐观更新，失败回滚 */
  async onToggleItem(e: WechatMiniprogram.TouchEvent) {
    const groupIndex = Number(e.currentTarget.dataset.group);
    const itemIndex = Number(e.currentTarget.dataset.index);

    const groups = this.data.groups.slice();
    const group = groups[groupIndex];
    if (!group) return;
    const item = group.items[itemIndex];
    if (!item) return;

    const checked = !item.checked;
    const items = group.items.slice();
    items[itemIndex] = { ...item, checked: checked };
    groups[groupIndex] = { ...group, items: items };
    this.setData({ groups: groups, summary: recount(groups) });

    const app = getApp<IAppOption>();
    const family = app.globalData.family;
    if (!family || !this.data.menuId) return;

    try {
      await shoppingService.toggle(family._id, this.data.menuId, item.key, checked);
    } catch (err) {
      // 回滚到勾选前的状态
      const revert = this.data.groups.slice();
      const revertGroup = revert[groupIndex];
      if (revertGroup) {
        const revertItems = revertGroup.items.slice();
        revertItems[itemIndex] = { ...revertItems[itemIndex], checked: !checked };
        revert[groupIndex] = { ...revertGroup, items: revertItems };
        this.setData({ groups: revert, summary: recount(revert) });
      }
      wx.showToast({ title: getErrorMessage(err, '更新失败'), icon: 'none' });
    }
  },

  /** 重新生成：按最新菜单与库存刷新，保留已勾选项 */
  async onRegenerate() {
    const app = getApp<IAppOption>();
    const family = app.globalData.family;
    if (!family || !this.data.menuId) return;

    this.setData({ regenerating: true });
    try {
      await shoppingService.generate(family._id, this.data.menuId);
      await this.load();
      wx.showToast({ title: '已按最新库存更新', icon: 'none' });
    } catch (e) {
      wx.showToast({ title: getErrorMessage(e, '生成失败'), icon: 'none' });
    } finally {
      this.setData({ regenerating: false });
    }
  },

  /** 一键复制清单文本 */
  onCopy() {
    const lines: string[] = [];
    lines.push('采购清单' + (this.data.dateLabel ? ' · ' + this.data.dateLabel : ''));
    this.data.groups.forEach((group) => {
      lines.push('【' + group.label + '】');
      group.items.forEach((item) => {
        const tail = item.enough ? '（已备齐）' : ' 需购 ' + formatAmount(item.toBuy, item.unit);
        lines.push('- ' + item.name + tail + (item.checked ? ' ✓' : ''));
      });
    });

    wx.setClipboardData({
      data: lines.join('\n'),
      success: () => {
        wx.showToast({ title: '清单已复制', icon: 'none' });
      },
    });
  },

  onGoMenu() {
    if (this.data.menuId) {
      wx.navigateTo({ url: '/pages/menu-detail/index?menuId=' + this.data.menuId });
      return;
    }
    wx.switchTab({ url: '/pages/menu/index' });
  },
});
