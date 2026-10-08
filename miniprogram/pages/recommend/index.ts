import {
  COOK_TIME_OPTIONS,
  DEFAULT_COOK_TIME,
  DEFAULT_PEOPLE_COUNT,
  MEAL_TYPES,
  PEOPLE_COUNT_OPTIONS,
  TASTE_OPTIONS,
} from '../../constants/config';
import type { MealType } from '../../types/menu';
import { inferMealTypeByHour } from '../../utils/formatter';

interface TasteOption {
  label: string;
  active: boolean;
}

Page({
  data: {
    peopleCount: DEFAULT_PEOPLE_COUNT,
    mealType: 'dinner' as MealType,
    maxCookTime: DEFAULT_COOK_TIME,
    clearInventoryFirst: true,
    peopleOptions: PEOPLE_COUNT_OPTIONS,
    mealTypeOptions: MEAL_TYPES,
    cookTimeOptions: COOK_TIME_OPTIONS,
    tasteOptions: TASTE_OPTIONS.map((label) => ({ label, active: false })) as TasteOption[],
  },

  onLoad() {
    // 餐次默认值按当前时间推断，仅作默认，用户可随时修改
    this.setData({ mealType: inferMealTypeByHour() });
  },

  onSelectPeople(e: WechatMiniprogram.TouchEvent) {
    this.setData({ peopleCount: e.currentTarget.dataset.value });
  },

  onSelectMealType(e: WechatMiniprogram.TouchEvent) {
    this.setData({ mealType: e.currentTarget.dataset.value });
  },

  onSelectCookTime(e: WechatMiniprogram.TouchEvent) {
    this.setData({ maxCookTime: e.currentTarget.dataset.value });
  },

  onToggleTaste(e: WechatMiniprogram.TouchEvent) {
    const index = e.currentTarget.dataset.index as number;
    const tasteOptions = this.data.tasteOptions.map((item, i) =>
      i === index ? { label: item.label, active: !item.active } : item,
    );
    this.setData({ tasteOptions });
  },

  onToggleClearInventory(e: WechatMiniprogram.CustomEvent<{ value: boolean }>) {
    this.setData({ clearInventoryFirst: e.detail.value });
  },

  onStartRecommend() {
    wx.navigateTo({ url: '/pages/recommend-result/index' });
  },
});
