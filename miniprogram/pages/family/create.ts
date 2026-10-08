/**
 * 创建家庭
 *
 * 表单包含：家庭名称、默认人数、默认口味、烹饪时间、忌口、过敏。
 * 前端只做体验层校验，服务端会独立再校验一次（人数 1~6、烹饪时间枚举、
 * 标签长度与数量、名称长度），不信任任何前端提交的值。
 */
import {
  ALLERGEN_OPTIONS,
  AVOID_INGREDIENT_OPTIONS,
  COOK_TIME_OPTIONS,
  DEFAULT_COOK_TIME,
  DEFAULT_PEOPLE_COUNT,
  DEFAULT_TASTE,
  FAMILY_NAME_MAX_LENGTH,
  FAMILY_TAG_MAX_LENGTH,
  PEOPLE_COUNT_OPTIONS,
  TASTE_OPTIONS,
} from '../../constants/config';
import { familyService } from '../../services/family';
import type { CreateFamilyInput } from '../../types/family';
import { getErrorMessage } from '../../utils/cloud';
import {
  buildNumberOptions,
  buildTagOptions,
  buildTasteOptions,
  collectActive,
  pickActiveValue,
  type TagOption,
} from '../../utils/family-form';

Page({
  data: {
    name: '',
    nameMaxLength: FAMILY_NAME_MAX_LENGTH,
    tagMaxLength: FAMILY_TAG_MAX_LENGTH,
    peopleOptions: buildNumberOptions(PEOPLE_COUNT_OPTIONS, DEFAULT_PEOPLE_COUNT, ' 人'),
    tasteOptions: buildTasteOptions(TASTE_OPTIONS, DEFAULT_TASTE),
    cookTimeOptions: buildNumberOptions(COOK_TIME_OPTIONS, DEFAULT_COOK_TIME, ' 分钟'),
    avoidOptions: buildTagOptions(AVOID_INGREDIENT_OPTIONS, []),
    allergenOptions: buildTagOptions(ALLERGEN_OPTIONS, []),
    customAvoid: '',
    customAllergen: '',
    /** 提交中：按钮禁用，避免快速重复提交产生多个家庭 */
    submitting: false,
    error: '',
  },

  onNameInput(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ name: e.detail.value });
  },

  onSelectPeople(e: WechatMiniprogram.TouchEvent) {
    const value = Number(e.currentTarget.dataset.value);
    this.setData({ peopleOptions: buildNumberOptions(PEOPLE_COUNT_OPTIONS, value, ' 人') });
  },

  onSelectCookTime(e: WechatMiniprogram.TouchEvent) {
    const value = Number(e.currentTarget.dataset.value);
    this.setData({ cookTimeOptions: buildNumberOptions(COOK_TIME_OPTIONS, value, ' 分钟') });
  },

  onToggleTaste(e: WechatMiniprogram.TouchEvent) {
    this.toggleOption('tasteOptions', Number(e.currentTarget.dataset.index));
  },

  onToggleAvoid(e: WechatMiniprogram.TouchEvent) {
    this.toggleOption('avoidOptions', Number(e.currentTarget.dataset.index));
  },

  onToggleAllergen(e: WechatMiniprogram.TouchEvent) {
    this.toggleOption('allergenOptions', Number(e.currentTarget.dataset.index));
  },

  /** 通用开关：切换选项组的第 index 项（按 key 分支，避免动态 setData 的键类型问题） */
  toggleOption(key: 'tasteOptions' | 'avoidOptions' | 'allergenOptions', index: number) {
    const target = this.data[key][index];
    if (!target) {
      return;
    }
    const active = !target.active;

    if (key === 'tasteOptions') {
      const list = this.data.tasteOptions.slice();
      list[index].active = active;
      this.setData({ tasteOptions: list });
      return;
    }

    if (key === 'avoidOptions') {
      const list = this.data.avoidOptions.slice();
      list[index].active = active;
      this.setData({ avoidOptions: list });
      return;
    }

    const list = this.data.allergenOptions.slice();
    list[index].active = active;
    this.setData({ allergenOptions: list });
  },

  onCustomAvoidInput(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ customAvoid: e.detail.value });
  },

  onCustomAllergenInput(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ customAllergen: e.detail.value });
  },

  onAddCustomAvoid() {
    this.addCustomTag('avoidOptions', 'customAvoid', '请输入忌口内容');
  },

  onAddCustomAllergen() {
    this.addCustomTag('allergenOptions', 'customAllergen', '请输入过敏原');
  },

  /** 新增自定义标签：已存在则直接选中，避免重复项 */
  addCustomTag(
    optionKey: 'avoidOptions' | 'allergenOptions',
    inputKey: 'customAvoid' | 'customAllergen',
    emptyTip: string,
  ) {
    const raw = String(this.data[inputKey] || '').trim();
    if (!raw) {
      wx.showToast({ title: emptyTip, icon: 'none' });
      return;
    }
    if (raw.length > FAMILY_TAG_MAX_LENGTH) {
      wx.showToast({ title: `单项不能超过 ${FAMILY_TAG_MAX_LENGTH} 个字`, icon: 'none' });
      return;
    }

    const list: TagOption[] = this.data[optionKey].map((item) => ({
      label: item.label,
      active: item.active,
    }));
    const existing = list.filter((item) => item.label === raw)[0];

    if (existing) {
      existing.active = true;
    } else {
      list.push({ label: raw, active: true });
    }

    if (optionKey === 'avoidOptions') {
      this.setData({ avoidOptions: list, customAvoid: '' });
      return;
    }

    this.setData({ allergenOptions: list, customAllergen: '' });
  },

  onCancel() {
    wx.navigateBack();
  },

  async onSubmit() {
    if (this.data.submitting) {
      return;
    }

    const name = String(this.data.name || '').trim();
    if (!name) {
      wx.showToast({ title: '请填写家庭名称', icon: 'none' });
      return;
    }
    if (name.length > FAMILY_NAME_MAX_LENGTH) {
      wx.showToast({ title: `家庭名称不能超过 ${FAMILY_NAME_MAX_LENGTH} 个字`, icon: 'none' });
      return;
    }

    const peopleCount = pickActiveValue(this.data.peopleOptions, DEFAULT_PEOPLE_COUNT);
    const cookTime = pickActiveValue(this.data.cookTimeOptions, DEFAULT_COOK_TIME);

    const input: CreateFamilyInput = {
      name,
      preferences: {
        defaultPeopleCount: peopleCount,
        taste: collectActive(this.data.tasteOptions),
        avoidIngredients: collectActive(this.data.avoidOptions),
        allergens: collectActive(this.data.allergenOptions),
        defaultCookTime: cookTime,
      },
    };

    this.setData({ submitting: true, error: '' });
    wx.showLoading({ title: '创建中...', mask: true });

    try {
      const family = await familyService.createFamily(input);

      wx.hideLoading();
      this.setData({ submitting: false });

      // 创建成功后立即写入全局状态与本地标识，保证返回首页时状态已正确
      getApp<IAppOption>().setFamily(family);

      wx.showToast({ title: '创建成功', icon: 'success' });
      setTimeout(() => {
        wx.reLaunch({ url: '/pages/home/index' });
      }, 800);
    } catch (error) {
      wx.hideLoading();
      const message = getErrorMessage(error, '创建失败，请稍后重试');
      this.setData({ submitting: false, error: message });
      wx.showToast({ title: message, icon: 'none' });
    }
  },
});
