/**
 * 食材库存页（Phase 4 → Phase B）
 *
 * 数据归属：所有读写都带当前家庭 familyId，服务端会二次校验成员身份。
 * 页面只负责展示与收集输入，真正的权限与校验在 ingredient 云函数。
 *
 * 四种状态都是「正常状态」，不是错误：
 *   1. 未登录        → 引导登录
 *   2. 已登录无家庭  → 引导创建 / 加入家庭（食材属于家庭）
 *   3. 有家庭无食材  → 空状态 + 添加引导
 *   4. 有家庭有食材  → 按分类折叠的列表 + 添加 / 编辑 / 快捷操作
 *
 * Phase B 增量：
 *   - 新增购买日期 purchaseDate 与保质天数 shelfLifeDays；
 *   - 列表按分类分组折叠，组内临期优先排序；
 *   - 临期（≤3 天）/ 过期 标识；
 *   - 快捷操作：已用完 / 补货 / 查看做法。
 */
import { INGREDIENT_CATEGORIES } from '../../constants/categories';
import { UNITS, convertToGram } from '../../constants/units';
import { ingredientService } from '../../services/ingredient';
import { nutritionService } from '../../services/nutrition';
import type { Ingredient, IngredientCategoryCode, IngredientInput } from '../../types/ingredient';
import { getErrorMessage } from '../../utils/cloud';
import { buildCategoryGroups, type CategoryGroup } from '../../utils/ingredient-group';
import { SHELF_LIFE_WARNING_DAYS, toDateString } from '../../utils/shelf-life';
import { validateIngredientInput } from '../../utils/validator';

const UNIT_VALUES: readonly string[] = UNITS.map((item) => item.value);
const UNIT_LABELS: readonly string[] = UNITS.map((item) => item.label);
const CATEGORY_VALUES: readonly IngredientCategoryCode[] = INGREDIENT_CATEGORIES.map(
  (item) => item.value,
);
const CATEGORY_LABELS: readonly string[] = INGREDIENT_CATEGORIES.map((item) => item.label);

/** nutrition 云函数一次最多接受 100 种食材，超出就分批请求 */
const CALORIE_BATCH_SIZE = 100;

/** 数量输入：允许小数（0.5 kg），非法输入返回 null */
function parseQuantity(raw: string): number | null {
  const text = (raw || '').trim();
  if (!text) {
    return null;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** 保质天数输入：只接受非负整数 */
function parseShelfLifeDays(raw: string): number | null {
  const text = (raw || '').trim();
  if (!text) {
    return null;
  }
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0 || value > 3650) {
    return null;
  }
  return value;
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

    /** 服务端返回的原始列表（分组重建的事实来源） */
    ingredients: [] as Ingredient[],
    /** 按分类折叠的分组视图 */
    groups: [] as CategoryGroup[],
    /** 每种食材数量（页头文案用） */
    ingredientCount: 0,
    /** 过期 + 临期条数 */
    warningCount: 0,
    /** 分类折叠状态：code → 是否折叠 */
    collapsedMap: {} as Record<string, boolean>,
    /** 「食材 _id → 热量(kcal)」，来自 nutrition 云函数；只用于展示 */
    calorieMap: {} as Record<string, number>,
    /** 加载序号：只有最新一次加载的结果才允许写回，防止过期响应覆盖新数据 */
    loadSeq: 0,

    unitLabels: UNIT_LABELS,
    categoryLabels: CATEGORY_LABELS,
    warningDays: SHELF_LIFE_WARNING_DAYS,

    /* ---- 添加 / 编辑表单 ---- */
    formVisible: false,
    formMode: 'create' as 'create' | 'edit',
    formTitle: '添加食材',
    editingId: '',
    formName: '',
    formQuantity: '',
    formUnitIndex: 0,
    formCategoryIndex: 0,
    formPurchaseDate: '',
    formShelfLifeDays: '',
    formExpireDate: '',
    formRemark: '',
    /** kg → g 换算提示，空字符串表示不展示 */
    quantityHint: '',
    /** 自动推导出的到期日提示 */
    expireHint: '',
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
        groups: [],
        calorieMap: {},
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
        groups: [],
        calorieMap: {},
        error: '',
      });
      return;
    }

    this.setData({ authReady: true, isLoggedIn: true, loading: true, error: '' });

    const seq = this.data.loadSeq + 1;
    this.setData({ loadSeq: seq });

    try {
      const list = (await ingredientService.list(familyId)) || [];
      if (seq !== this.data.loadSeq) {
        return;
      }

      // 先渲染库存，热量随后补上：多等一次云函数不应该拖慢列表
      this.applyList(list, true);

      if (list.length > 0) {
        const calorieMap = await this.fetchCalorieMap(list, familyId);
        if (seq !== this.data.loadSeq) {
          return;
        }
        if (Object.keys(calorieMap).length > 0) {
          this.applyList(list, false, calorieMap);
        }
      }
    } catch (error) {
      if (seq !== this.data.loadSeq) {
        return;
      }
      // 网络异常：保留已有列表，仅提示错误，不清空
      this.setData({
        loading: false,
        ready: true,
        hasFamily: true,
        error: getErrorMessage(error, '食材加载失败，请稍后重试'),
      });
    }
  },

  /**
   * 用 nutrition 云函数算出的单项热量。
   *
   * 营养值必须由服务端根据 nutrition_facts 计算（见规范第 5 章），
   * 前端不做任何营养换算，只把结果挂到对应食材上。
   * 拿不到就返回空映射 —— 热量只是锦上添花，不能影响库存列表本身。
   */
  async fetchCalorieMap(list: Ingredient[], familyId: string): Promise<Record<string, number>> {
    const map: Record<string, number> = {};
    // 服务端只认 name/amount/unit，且 amount 必须 > 0
    const usable = list.filter(
      (item) => (item.standardName || item.name) && item.quantity > 0 && !!item.unit,
    );
    if (usable.length === 0) {
      return map;
    }

    for (let start = 0; start < usable.length; start += CALORIE_BATCH_SIZE) {
      const chunk = usable.slice(start, start + CALORIE_BATCH_SIZE);
      try {
        const result = await nutritionService.calculate(
          chunk.map((item) => ({
            name: item.standardName || item.name,
            amount: item.quantity,
            unit: item.unit,
          })),
          1,
          familyId,
        );
        // items 与入参顺序一一对应
        const items = (result && result.items) || [];
        for (let i = 0; i < chunk.length && i < items.length; i += 1) {
          const nutrition = items[i].nutrition;
          if (nutrition && nutrition.calories > 0) {
            map[chunk[i]._id] = nutrition.calories;
          }
        }
      } catch (error) {
        // 某一批失败就不再继续请求，直接使用已拿到的部分
        break;
      }
    }

    return map;
  },

  /**
   * 用最新列表重建分组视图。
   *
   * calorieMap 省略时沿用已有映射（例如仅切换折叠状态），
   * 避免上一次拿到的热量在局部刷新时被清掉。
   */
  applyList(
    list: Ingredient[],
    markReady: boolean,
    calorieMap?: Record<string, number>,
  ) {
    const effectiveCalories = calorieMap === undefined ? this.data.calorieMap : calorieMap;
    const groups = buildCategoryGroups(
      list,
      this.data.collapsedMap,
      new Date(),
      effectiveCalories,
    );

    let warningCount = 0;
    for (const group of groups) {
      warningCount += group.warningCount;
    }

    const patch: Record<string, unknown> = {
      loading: false,
      hasFamily: true,
      ingredients: list,
      groups: groups,
      ingredientCount: list.length,
      warningCount: warningCount,
      calorieMap: effectiveCalories,
      error: '',
    };
    if (markReady) {
      patch.ready = true;
    }
    this.setData(patch);
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

  /* ------------------------------ 分类折叠 ------------------------------ */

  onToggleCategory(e: WechatMiniprogram.TouchEvent) {
    const code = String(e.currentTarget.dataset.code || '');
    if (!code) {
      return;
    }
    const collapsedMap = Object.assign({}, this.data.collapsedMap);
    collapsedMap[code] = !collapsedMap[code];
    this.setData({ collapsedMap: collapsedMap });
    this.applyList(this.data.ingredients, false, this.data.calorieMap);
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
      formPurchaseDate: toDateString(new Date()),
      formShelfLifeDays: '',
      formExpireDate: '',
      formRemark: '',
      quantityHint: '',
      expireHint: '',
      formError: '',
    });
    this.updateQuantityHint();
  },

  /** 点击食材 → 编辑 */
  onEditIngredient(e: WechatMiniprogram.CustomEvent) {
    const item = (e.detail && e.detail.item) as Ingredient | undefined;
    if (!item) {
      return;
    }

    const unitIndex = UNIT_VALUES.indexOf(item.unit as string);
    const categoryIndex = Math.max(0, CATEGORY_VALUES.indexOf(item.category));

    this.setData({
      formVisible: true,
      formMode: 'edit',
      formTitle: '编辑食材',
      editingId: item._id,
      formName: item.name,
      formQuantity: String(item.quantity),
      formUnitIndex: unitIndex < 0 ? 0 : unitIndex,
      formCategoryIndex: categoryIndex,
      formPurchaseDate: item.purchaseDate || '',
      formShelfLifeDays: typeof item.shelfLifeDays === 'number' ? String(item.shelfLifeDays) : '',
      formExpireDate: item.expireDate || '',
      formRemark: item.remark || '',
      formError: '',
      expireHint: '',
    });
    this.updateQuantityHint();
    this.updateExpireHint();
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

  onPurchaseDateChange(e: WechatMiniprogram.CustomEvent<{ value: string | number }>) {
    this.setData({ formPurchaseDate: String(e.detail.value) });
    this.updateExpireHint();
  },

  onClearPurchaseDate() {
    this.setData({ formPurchaseDate: '' });
    this.updateExpireHint();
  },

  onShelfLifeInput(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ formShelfLifeDays: e.detail.value });
    this.updateExpireHint();
  },

  onExpireChange(e: WechatMiniprogram.CustomEvent<{ value: string | number }>) {
    this.setData({ formExpireDate: String(e.detail.value) });
    this.updateExpireHint();
  },

  onClearExpire() {
    this.setData({ formExpireDate: '' });
    this.updateExpireHint();
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

  /**
   * 到期日提示：显式填了 expireDate 就以它为准（服务端优先级相同）；
   * 否则在填了购买日期 + 保质天数时提示会自动推导出的日期。
   */
  updateExpireHint() {
    if (this.data.formExpireDate) {
      this.setData({ expireHint: '' });
      return;
    }

    const purchaseDate = this.data.formPurchaseDate;
    const days = parseShelfLifeDays(this.data.formShelfLifeDays);

    if (!purchaseDate || days === null) {
      this.setData({ expireHint: '' });
      return;
    }

    const base = new Date(purchaseDate + 'T00:00:00Z');
    if (Number.isNaN(base.getTime())) {
      this.setData({ expireHint: '' });
      return;
    }
    base.setUTCDate(base.getUTCDate() + days);
    const text = base.toISOString().slice(0, 10);
    this.setData({ expireHint: '将自动记为 ' + text + ' 到期' });
  },

  /* ------------------------------ 保存 / 删除 ------------------------------ */

  /** 把表单值组装成服务端入参（服务端仍会独立校验一次） */
  buildInput(): IngredientInput {
    return {
      name: (this.data.formName || '').trim(),
      quantity: parseQuantity(this.data.formQuantity) ?? 0,
      unit: UNIT_VALUES[this.data.formUnitIndex] as IngredientInput['unit'],
      category: CATEGORY_VALUES[this.data.formCategoryIndex] || 'other',
      purchaseDate: this.data.formPurchaseDate || null,
      shelfLifeDays: parseShelfLifeDays(this.data.formShelfLifeDays),
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

  /* ------------------------------ 快捷操作 ------------------------------ */

  /** 「已用完」：从库存移除（与删除同一套流程，只是语义不同） */
  onConsumeIngredient(e: WechatMiniprogram.CustomEvent) {
    const item = (e.detail && e.detail.item) as Ingredient | undefined;
    if (!item) {
      return;
    }

    wx.showModal({
      title: '已用完',
      content: '把「' + (item.standardName || item.name) + '」从库存移除？',
      confirmText: '移除',
      success: (res) => {
        if (res.confirm) {
          void this.deleteIngredient(item._id, '已用完，已移除');
        }
      },
    });
  },

  /** 「重新补货」：输入补货后的总数量 */
  onRestockIngredient(e: WechatMiniprogram.CustomEvent) {
    const item = (e.detail && e.detail.item) as Ingredient | undefined;
    if (!item) {
      return;
    }

    const label = (item.standardName || item.name) + '（' + item.quantity + ' ' + item.unit + '）';

    wx.showModal({
      title: '补货：' + label,
      editable: true,
      placeholderText: '补货后的总数量',
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        const quantity = parseQuantity(res.content || '');
        if (quantity === null || quantity <= 0) {
          wx.showToast({ title: '请输入大于 0 的数量', icon: 'none' });
          return;
        }
        void this.restockIngredient(item, quantity);
      },
    });
  },

  async restockIngredient(item: Ingredient, quantity: number) {
    const app = getApp<IAppOption>();
    const familyId = app.globalData.currentFamilyId;
    if (!familyId) {
      return;
    }

    const input: IngredientInput = {
      name: item.name,
      quantity: quantity,
      unit: item.unit,
      category: item.category,
      purchaseDate: toDateString(new Date()),
      shelfLifeDays: typeof item.shelfLifeDays === 'number' ? item.shelfLifeDays : null,
      expireDate: typeof item.shelfLifeDays === 'number' ? null : (item.expireDate || null),
      remark: item.remark || '',
    };

    wx.showLoading({ title: '正在补货...', mask: true });
    try {
      await ingredientService.update(familyId, item._id, input);
      wx.hideLoading();
      wx.showToast({ title: '已补货', icon: 'none' });
      await this.load();
    } catch (error) {
      wx.hideLoading();
      wx.showToast({ title: getErrorMessage(error, '补货失败，请稍后重试'), icon: 'none' });
    }
  },

  /** 「查看做法」：跳到包含该食材的菜谱 */
  onViewRecipes(e: WechatMiniprogram.CustomEvent) {
    const item = (e.detail && e.detail.item) as Ingredient | undefined;
    if (!item) {
      return;
    }
    const keyword = item.standardName || item.name || '';
    if (!keyword) {
      return;
    }
    wx.navigateTo({ url: '/pages/recipes/index?keyword=' + encodeURIComponent(keyword) });
  },

  /** 删除必须二次确认（编辑表单里的删除入口） */
  onDeleteIngredient(e: WechatMiniprogram.CustomEvent) {
    const item = (e.detail && e.detail.item) as Ingredient | undefined;
    if (!item) {
      return;
    }

    wx.showModal({
      title: '删除食材',
      content: '确定要删除「' + (item.standardName || item.name) + '」吗？删除后无法恢复。',
      confirmText: '删除',
      confirmColor: '#e34d59',
      success: (res) => {
        if (res.confirm) {
          void this.deleteIngredient(item._id, '已删除');
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
          void this.deleteIngredient(id, '已删除');
        }
      },
    });
  },

  async deleteIngredient(id: string, successText: string) {
    const app = getApp<IAppOption>();
    const familyId = app.globalData.currentFamilyId;
    if (!familyId) {
      return;
    }

    wx.showLoading({ title: '正在处理...', mask: true });
    try {
      await ingredientService.remove(familyId, id);
      wx.hideLoading();
      wx.showToast({ title: successText, icon: 'none' });
      await this.load();
    } catch (error) {
      wx.hideLoading();
      wx.showToast({ title: getErrorMessage(error, '操作失败，请稍后重试'), icon: 'none' });
    }
  },
});
