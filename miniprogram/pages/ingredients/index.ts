/**
 * 食材库存页（Phase 4）
 *
 * 数据归属：所有读写都带当前家庭 familyId，服务端会二次校验成员身份。
 * 页面只负责展示与收集输入，真正的权限与校验在 ingredient 云函数。
 *
 * 四种状态都是「正常状态」，不是错误：
 *   1. 未登录        → 引导登录
 *   2. 已登录无家庭  → 引导创建 / 加入家庭（食材属于家庭）
 *   3. 有家庭无食材  → 空状态 + 添加引导
 *   4. 有家庭有食材  → 列表 + 添加 / 编辑 / 删除
 */
import { INGREDIENT_CATEGORIES, getCategoryLabel } from '../../constants/categories';
import { UNITS, convertToGram } from '../../constants/units';
import { ingredientService } from '../../services/ingredient';
import type { Ingredient, IngredientCategoryCode, IngredientInput } from '../../types/ingredient';
import { getErrorMessage } from '../../utils/cloud';
import { validateIngredientInput } from '../../utils/validator';

/** 列表展示项：分类文案等展示逻辑在 TS 里算好，WXML 不做判断 */
interface IngredientView {
  _id: string;
  name: string;
  standardName: string;
  quantity: number;
  unit: string;
  category: IngredientCategoryCode;
  categoryLabel: string;
  expireDate: string;
  remark: string;
}

const UNIT_VALUES: readonly string[] = UNITS.map((item) => item.value);
const UNIT_LABELS: readonly string[] = UNITS.map((item) => item.label);
const CATEGORY_VALUES: readonly string[] = INGREDIENT_CATEGORIES.map((item) => item.value);
const CATEGORY_LABELS: readonly string[] = INGREDIENT_CATEGORIES.map((item) => item.label);

function toView(item: Ingredient): IngredientView {
  return {
    _id: item._id,
    name: item.name,
    standardName: item.standardName || item.name,
    quantity: item.quantity,
    unit: item.unit,
    category: item.category,
    categoryLabel: getCategoryLabel(item.category),
    expireDate: item.expireDate || '',
    remark: item.remark || '',
  };
}

/** 数量输入：允许小数（0.5 kg），非法输入返回 null */
function parseQuantity(raw: string): number | null {
  const text = (raw || '').trim();
  if (!text) {
    return null;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

Page({
  data: {
    /** 登录初始化是否结束 */
    authReady: false,
    isLoggedIn: false,
    /** 食材是否已向服务端确认 */
    ready: false,
    loading: false,
    /** 可直接展示的错误文案（网络异常等） */
    error: '',
    hasFamily: false,

    ingredients: [] as IngredientView[],
    unitLabels: UNIT_LABELS,
    categoryLabels: CATEGORY_LABELS,

    /* ---- 添加 / 编辑表单 ---- */
    formVisible: false,
    formMode: 'create' as 'create' | 'edit',
    formTitle: '添加食材',
    editingId: '',
    formName: '',
    formQuantity: '',
    formUnitIndex: 0,
    formCategoryIndex: 0,
    formExpireDate: '',
    formRemark: '',
    /** kg → g 换算提示，空字符串表示不展示 */
    quantityHint: '',
    formError: '',
    saving: false,
  },

  onShow() {
    void this.load();
  },

  /** 拉取食材列表：以服务端返回为准 */
  async load() {
    const app = getApp<IAppOption>();
    const auth = app.getAuthState();

    if (!auth.ready) {
      this.setData({ authReady: false, isLoggedIn: auth.isLoggedIn });
      return;
    }

    if (!auth.isLoggedIn) {
      // 未登录时不调用食材接口，只引导登录
      this.setData({
        authReady: true,
        isLoggedIn: false,
        ready: true,
        hasFamily: false,
        loading: false,
        ingredients: [],
        error: '',
      });
      return;
    }

    let familyId = app.globalData.currentFamilyId;
    if (!familyId) {
      // 可能是首次进入、全局家庭态尚未就绪；主动确认一次，失败不抛
      await app.refreshFamily();
      familyId = app.globalData.currentFamilyId;
    }

    if (!familyId) {
      // 「没有家庭」是正常业务状态：食材属于家庭，先引导建家
      this.setData({
        authReady: true,
        isLoggedIn: true,
        ready: true,
        hasFamily: false,
        loading: false,
        ingredients: [],
        error: '',
      });
      return;
    }

    this.setData({ authReady: true, isLoggedIn: true, loading: true, error: '' });

    try {
      const list = await ingredientService.list(familyId);
      this.setData({
        loading: false,
        ready: true,
        hasFamily: true,
        ingredients: (list || []).map(toView),
      });
    } catch (error) {
      // 网络异常：保留已有列表，仅提示错误，不清空
      this.setData({
        loading: false,
        ready: true,
        hasFamily: true,
        error: getErrorMessage(error, '食材加载失败，请稍后重试'),
      });
    }
  },

  onRetry() {
    void this.load();
  },

  onRetryLogin() {
    void getApp<IAppOption>().retryLogin();
  },

  onGoCreateFamily() {
    wx.navigateTo({ url: '/pages/family/create' });
  },

  onGoJoinFamily() {
    wx.navigateTo({ url: '/pages/family/join' });
  },

  /** Phase 5：带当前库存去营养估算页 */
  onOpenNutrition() {
    wx.navigateTo({ url: '/pages/nutrition/index' });
  },

  /* ------------------------------ 表单 ------------------------------ */

  onOpenCreate() {
    this.setData({
      formVisible: true,
      formMode: 'create',
      formTitle: '添加食材',
      editingId: '',
      formName: '',
      formQuantity: '',
      formUnitIndex: 0,
      formCategoryIndex: 0,
      formExpireDate: '',
      formRemark: '',
      quantityHint: '',
      formError: '',
    });
  },

  /** 点击食材 → 编辑 */
  onEditIngredient(e: WechatMiniprogram.CustomEvent) {
    const item = (e.detail && e.detail.item) as IngredientView | undefined;
    if (!item) {
      return;
    }

    const unitIndex = UNIT_VALUES.indexOf(item.unit);

    this.setData({
      formVisible: true,
      formMode: 'edit',
      formTitle: '编辑食材',
      editingId: item._id,
      formName: item.name,
      formQuantity: String(item.quantity),
      formUnitIndex: unitIndex < 0 ? 0 : unitIndex,
      formCategoryIndex: Math.max(0, CATEGORY_VALUES.indexOf(item.category)),
      formExpireDate: item.expireDate,
      formRemark: item.remark,
      formError: '',
    });
    this.updateQuantityHint();
  },

  onCloseForm() {
    if (this.data.saving) {
      return;
    }
    this.setData({ formVisible: false, formError: '' });
  },

  onNameInput(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ formName: e.detail.value });
  },

  onQuantityInput(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ formQuantity: e.detail.value });
    this.updateQuantityHint();
  },

  onRemarkInput(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ formRemark: e.detail.value });
  },

  onUnitChange(e: WechatMiniprogram.CustomEvent<{ value: string | number }>) {
    this.setData({ formUnitIndex: Number(e.detail.value) });
    this.updateQuantityHint();
  },

  onCategoryChange(e: WechatMiniprogram.CustomEvent<{ value: string | number }>) {
    this.setData({ formCategoryIndex: Number(e.detail.value) });
  },

  onExpireChange(e: WechatMiniprogram.CustomEvent<{ value: string | number }>) {
    this.setData({ formExpireDate: String(e.detail.value) });
  },

  onClearExpire() {
    this.setData({ formExpireDate: '' });
  },

  /**
   * kg → g 换算提示。
   * 个 / 袋 / 盒 需要 nutrition_facts.averageWeight 才能换算，
   * 第一阶段还没有该数据，因此不做任何猜测。
   */
  updateQuantityHint() {
    const quantity = parseQuantity(this.data.formQuantity);
    const unit = UNIT_VALUES[this.data.formUnitIndex];

    if (quantity === null || quantity <= 0 || unit !== 'kg') {
      this.setData({ quantityHint: '' });
      return;
    }

    const grams = convertToGram(quantity, 'kg');
    this.setData({ quantityHint: grams === null ? '' : `≈ ${grams} g` });
  },

  /* ------------------------------ 保存 / 删除 ------------------------------ */

  /** 把表单值组装成服务端入参（服务端仍会独立校验一次） */
  buildInput(): IngredientInput {
    return {
      name: (this.data.formName || '').trim(),
      quantity: parseQuantity(this.data.formQuantity) ?? 0,
      unit: UNIT_VALUES[this.data.formUnitIndex] as IngredientInput['unit'],
      category: CATEGORY_VALUES[this.data.formCategoryIndex] as IngredientCategoryCode,
      expireDate: this.data.formExpireDate || null,
      remark: (this.data.formRemark || '').trim(),
    };
  },

  async onSubmit() {
    if (this.data.saving) {
      return;
    }

    const input = this.buildInput();

    // 前端校验只用于提升体验，最终以云函数校验为准
    const result = validateIngredientInput(input);
    if (!result.valid) {
      this.setData({ formError: result.message });
      return;
    }

    const app = getApp<IAppOption>();
    const familyId = app.globalData.currentFamilyId;
    if (!familyId) {
      this.setData({ formError: '你还没有加入家庭，无法添加食材' });
      return;
    }

    const isEdit = this.data.formMode === 'edit';
    this.setData({ saving: true, formError: '' });

    try {
      if (isEdit) {
        await ingredientService.update(familyId, this.data.editingId, input);
      } else {
        await ingredientService.create(familyId, input);
      }

      this.setData({ saving: false, formVisible: false });
      wx.showToast({ title: isEdit ? '已保存' : '已添加', icon: 'none' });
      await this.load();
    } catch (error) {
      this.setData({
        saving: false,
        formError: getErrorMessage(error, isEdit ? '保存失败，请稍后重试' : '添加失败，请稍后重试'),
      });
    }
  },

  /** 删除必须二次确认 */
  onDeleteIngredient(e: WechatMiniprogram.CustomEvent) {
    const item = (e.detail && e.detail.item) as IngredientView | undefined;
    if (!item) {
      return;
    }

    wx.showModal({
      title: '删除食材',
      content: '确定要删除「' + item.standardName + '」吗？删除后无法恢复。',
      confirmText: '删除',
      confirmColor: '#e34d59',
      success: (res) => {
        if (res.confirm) {
          void this.deleteIngredient(item._id);
        }
      },
    });
  },

  /** 表单里的删除按钮（编辑态才有） */
  onDeleteEditing() {
    const id = this.data.editingId;
    if (!id) {
      return;
    }
    const name = (this.data.formName || '该食材').trim();
    wx.showModal({
      title: '删除食材',
      content: '确定要删除「' + name + '」吗？删除后无法恢复。',
      confirmText: '删除',
      confirmColor: '#e34d59',
      success: (res) => {
        if (res.confirm) {
          this.setData({ formVisible: false });
          void this.deleteIngredient(id);
        }
      },
    });
  },

  async deleteIngredient(id: string) {
    const app = getApp<IAppOption>();
    const familyId = app.globalData.currentFamilyId;
    if (!familyId) {
      return;
    }

    wx.showLoading({ title: '正在删除...', mask: true });
    try {
      await ingredientService.remove(familyId, id);
      wx.hideLoading();
      wx.showToast({ title: '已删除', icon: 'none' });
      await this.load();
    } catch (error) {
      wx.hideLoading();
      wx.showToast({ title: getErrorMessage(error, '删除失败，请稍后重试'), icon: 'none' });
    }
  },
});
