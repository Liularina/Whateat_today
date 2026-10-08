/**
 * 家庭设置
 *
 * 管理员可以修改家庭名称与默认偏好，也可以解散家庭；
 * 普通成员可以查看，但不能保存 —— 这里只是体验层隐藏按钮，
 * 服务端 updateFamily / dissolveFamily 都会再次校验 role === owner。
 *
 * 进入页面时读取服务端最新值；取消不提交任何修改。
 */
import {
  ALLERGEN_OPTIONS,
  AVOID_INGREDIENT_OPTIONS,
  COOK_TIME_OPTIONS,
  DEFAULT_COOK_TIME,
  DEFAULT_PEOPLE_COUNT,
  FAMILY_NAME_MAX_LENGTH,
  FAMILY_TAG_MAX_LENGTH,
  PEOPLE_COUNT_OPTIONS,
  TASTE_OPTIONS,
} from '../../constants/config';
import { familyService } from '../../services/family';
import type { UpdateFamilyInput } from '../../types/family';
import { getErrorMessage } from '../../utils/cloud';
import {
  buildNumberOptions,
  buildTagOptions,
  buildTasteOptions,
  collectActive,
  pickActiveValue,
  type ChoiceOption,
  type TagOption,
} from '../../utils/family-form';

Page({
  data: {
    ready: false,
    isLoggedIn: false,
    isInFamily: false,
    isOwner: false,
    familyId: '',
    name: '',
    nameMaxLength: FAMILY_NAME_MAX_LENGTH,
    tagMaxLength: FAMILY_TAG_MAX_LENGTH,
    peopleOptions: [] as ChoiceOption[],
    tasteOptions: [] as TagOption[],
    cookTimeOptions: [] as ChoiceOption[],
    avoidOptions: [] as TagOption[],
    allergenOptions: [] as TagOption[],
    customAvoid: '',
    customAllergen: '',
    saving: false,
    dissolving: false,
    error: '',
  },

  onShow() {
    void this.load();
  },

  async load() {
    const app = getApp<IAppOption>();
    const auth = app.getAuthState();

    if (!auth.ready || !auth.isLoggedIn) {
      this.setData({ ready: true, isLoggedIn: auth.isLoggedIn, isInFamily: false });
      return;
    }

    this.setData({ ready: false, isLoggedIn: true, error: '' });

    try {
      const result = await familyService.getMyFamily();

      if (!result || !result.family) {
        this.setData({ ready: true, isInFamily: false });
        return;
      }

      const family = result.family;
      const preferences = family.preferences;
      const currentUserId = app.globalData.user ? app.globalData.user._id : '';

      app.setFamily(family);

      this.setData({
        ready: true,
        isInFamily: true,
        isOwner: family.ownerId === currentUserId,
        familyId: family._id,
        name: family.name,
        peopleOptions: buildNumberOptions(
          PEOPLE_COUNT_OPTIONS,
          preferences.defaultPeopleCount,
          ' 人',
        ),
        tasteOptions: buildTasteOptions(TASTE_OPTIONS, preferences.taste),
        cookTimeOptions: buildNumberOptions(
          COOK_TIME_OPTIONS,
          preferences.defaultCookTime,
          ' 分钟',
        ),
        avoidOptions: buildTagOptions(AVOID_INGREDIENT_OPTIONS, preferences.avoidIngredients),
        allergenOptions: buildTagOptions(ALLERGEN_OPTIONS, preferences.allergens),
      });
    } catch (error) {
      this.setData({
        ready: true,
        error: getErrorMessage(error, '家庭信息加载失败，请稍后重试'),
      });
    }
  },

  onNameInput(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ name: e.detail.value });
  },

  onSelectPeople(e: WechatMiniprogram.TouchEvent) {
    if (!this.data.isOwner) {
      return;
    }
    const value = Number(e.currentTarget.dataset.value);
    this.setData({ peopleOptions: buildNumberOptions(PEOPLE_COUNT_OPTIONS, value, ' 人') });
  },

  onSelectCookTime(e: WechatMiniprogram.TouchEvent) {
    if (!this.data.isOwner) {
      return;
    }
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

  /** 切换选项（按 key 分支，避免动态 setData 的键类型问题）；非管理员直接忽略 */
  toggleOption(key: 'tasteOptions' | 'avoidOptions' | 'allergenOptions', index: number) {
    if (!this.data.isOwner) {
      return;
    }

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

  addCustomTag(
    optionKey: 'avoidOptions' | 'allergenOptions',
    inputKey: 'customAvoid' | 'customAllergen',
    emptyTip: string,
  ) {
    if (!this.data.isOwner) {
      return;
    }

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
    // 取消：不提交任何修改
    wx.navigateBack();
  },

  async onSave() {
    if (this.data.saving || !this.data.isOwner) {
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

    const input: UpdateFamilyInput = {
      name,
      preferences: {
        defaultPeopleCount: pickActiveValue(this.data.peopleOptions, DEFAULT_PEOPLE_COUNT),
        taste: collectActive(this.data.tasteOptions),
        avoidIngredients: collectActive(this.data.avoidOptions),
        allergens: collectActive(this.data.allergenOptions),
        defaultCookTime: pickActiveValue(this.data.cookTimeOptions, DEFAULT_COOK_TIME),
      },
    };

    this.setData({ saving: true, error: '' });
    wx.showLoading({ title: '保存中...', mask: true });

    try {
      const family = await familyService.updateFamily(this.data.familyId, input);

      wx.hideLoading();
      this.setData({ saving: false });

      // 家庭名称可能已变，立即更新全局状态，保证其它页面读到的是一致的
      getApp<IAppOption>().setFamily(family);

      wx.showToast({ title: '设置已保存', icon: 'success' });
      setTimeout(() => {
        wx.navigateBack();
      }, 800);
    } catch (error) {
      wx.hideLoading();
      const message = getErrorMessage(error, '保存失败，请稍后重试');
      this.setData({ saving: false, error: message });
      wx.showToast({ title: message, icon: 'none' });
    }
  },

  /** 解散家庭：仅管理员，二次确认后 status 置为 deleted 并清理成员关系 */
  onDissolveFamily() {
    if (this.data.dissolving || !this.data.isOwner) {
      return;
    }

    wx.showModal({
      title: '解散家庭',
      content: '解散家庭后，家庭成员将无法继续访问家庭。确定要解散吗？',
      confirmText: '确定解散',
      confirmColor: '#e34d59',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm) {
          void this.dissolveFamily();
        }
      },
    });
  },

  async dissolveFamily() {
    const app = getApp<IAppOption>();

    this.setData({ dissolving: true, error: '' });
    wx.showLoading({ title: '正在解散...', mask: true });

    try {
      await familyService.dissolveFamily(this.data.familyId);

      wx.hideLoading();
      this.setData({ dissolving: false });

      // 只清家庭，保持登录态
      app.clearFamily();

      wx.showToast({ title: '已解散家庭', icon: 'none' });
      setTimeout(() => {
        wx.reLaunch({ url: '/pages/home/index' });
      }, 800);
    } catch (error) {
      wx.hideLoading();
      const message = getErrorMessage(error, '解散失败，请稍后重试');
      this.setData({ dissolving: false, error: message });
      wx.showToast({ title: message, icon: 'none' });
    }
  },
});
