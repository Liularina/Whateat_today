import {
  COOK_TIME_OPTIONS,
  DEFAULT_COOK_TIME,
  DEFAULT_PEOPLE_COUNT,
  MEAL_TYPES,
  PEOPLE_COUNT_OPTIONS,
  TASTE_OPTIONS,
} from '../../constants/config';
import type { MealType } from '../../types/menu';
import { recommendService } from '../../services/recommend';
import { getErrorCode, getErrorMessage } from '../../utils/cloud';
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

    /** AI 可用状态：内置就绪 或 自定义已配置 */
    aiReady: true,
    aiConfigError: '',

    /** 推荐中 */
    recommending: false,
  },

  onLoad() {
    this.setData({ mealType: inferMealTypeByHour() });
  },

  onShow() {
    // 从设置页返回后刷新 AI 配置状态
    void this.checkAiConfig();
  },

  async checkAiConfig() {
    try {
      const { aiConfigService } = await require('../../services/ai-config');
      const config = await aiConfigService.getConfig();
      // 内置就绪 或 自定义已配置 都视为 AI 可用
      const aiReady = (config.mode === 'builtin' && config.builtin.ready)
                    || (config.mode === 'custom' && config.configured);
      this.setData({
        aiReady: aiReady,
        aiConfigError: '',
      });
    } catch (_e) {
      // 加载失败不阻塞，推荐时云函数会再次校验
    }
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

  onGoSettings() {
    wx.navigateTo({ url: '/pages/ai-settings/index' });
  },

  /** 开始推荐：收集条件 → 调云函数 → 跳转结果页 */
  async onStartRecommend() {
    if (!this.data.aiReady) {
      wx.showToast({ title: 'AI 服务暂不可用，请检查设置', icon: 'none' });
      return;
    }

    if (this.data.recommending) {
      return;
    }

    const app = getApp<IAppOption>();
    const family = app.globalData.family;

    if (!family || !family._id) {
      wx.showToast({ title: '请先创建或加入家庭', icon: 'none' });
      return;
    }

    // 收集偏好
    const activeTastes = this.data.tasteOptions
      .filter((t) => t.active)
      .map((t) => t.label);

    let preferences = '';
    if (activeTastes.length > 0 && activeTastes[0] !== '不限') {
      preferences = '口味偏好：' + activeTastes.join('、');
    }
    if (this.data.maxCookTime) {
      preferences += (preferences ? '；' : '') + '单道菜不超过 ' + this.data.maxCookTime + ' 分钟';
    }

    this.setData({ recommending: true });

    try {
      const result = await recommendService.recommendMenus({
        familyId: family._id,
        mealType: this.data.mealType,
        servings: this.data.peopleCount,
        preferences: preferences || undefined,
      });

      this.setData({ recommending: false });

      // 带上完整结果跳转结果页
      const app2 = getApp<IAppOption>();
      app2.globalData.lastRecommendResult = result;

      wx.navigateTo({ url: '/pages/recommend-result/index' });
    } catch (error) {
      this.setData({ recommending: false });

      const code = getErrorCode(error);
      const message = getErrorMessage(error, '推荐失败，请稍后重试');

      if (code === 'AI_CONFIG_REQUIRED') {
        // 配置缺失：引导去设置页
        wx.showModal({
          title: '未配置模型 API',
          content: message,
          confirmText: '去设置',
          success: (res) => {
            if (res.confirm) {
              wx.navigateTo({ url: '/pages/ai-settings/index' });
            }
          },
        });
        return;
      }

      if (code === 'NOT_IN_FAMILY') {
        wx.showToast({ title: '请先创建或加入家庭', icon: 'none' });
        return;
      }

      wx.showModal({
        title: '推荐失败',
        content: message,
        showCancel: false,
      });
    }
  },
});