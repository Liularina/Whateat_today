/**
 * 营养估算页（Phase 5）
 *
 * 数据来源：当前家庭的食材库存（standardName + quantity + unit）。
 * 页面**不做任何营养换算**，只把「食材 + 数量 + 单位 + 人数」交给 nutrition 云函数，
 * 服务端根据 nutrition_facts 重新计算 —— 这是规范的核心验收点：
 * AI 或页面算出多少都不算数，最终以程序重算结果为准。
 *
 * 四种状态都是「正常状态」：
 *   1. 未登录        → 引导登录
 *   2. 已登录无家庭  → 引导创建 / 加入家庭
 *   3. 有家庭无食材  → 提示先去添加食材
 *   4. 有食材        → 展示总量 / 人均 / 逐项明细
 *
 * 有食材缺营养数据或无法换算时，展示「部分营养数据缺失，仅供参考。」，
 * 绝不替系统补一个看似精确的数字。
 */
import {
  DEFAULT_PEOPLE_COUNT,
  NUTRITION_MAX_INGREDIENTS,
  NUTRITION_PARTIAL_MESSAGE,
  PEOPLE_COUNT_OPTIONS,
} from '../../constants/config';
import { UNITS, getUnitLabel } from '../../constants/units';
import { ingredientService } from '../../services/ingredient';
import { nutritionService } from '../../services/nutrition';
import type { FamilyDTO } from '../../types/family';
import type { Ingredient } from '../../types/ingredient';
import type { NutritionSummary } from '../../types/menu';
import type {
  NutritionIngredientInput,
  NutritionItemResult,
  NutritionItemStatus,
  NutritionResult,
} from '../../types/nutrition';
import { getErrorMessage } from '../../utils/cloud';
import { formatGram, formatKcal } from '../../utils/formatter';

/** 明细展示项：展示逻辑在 TS 里算好，WXML 不做判断 */
interface NutritionItemView {
  /** 列表 key：库存里可能有同名食材，需带上下标 */
  key: string;
  name: string;
  amountLabel: string;
  gramsLabel: string;
  kcalLabel: string;
  status: NutritionItemStatus;
  statusLabel: string;
}

const PEOPLE_LABELS: readonly string[] = PEOPLE_COUNT_OPTIONS.map((count) => `${count} 人`);
const UNIT_VALUES: readonly string[] = UNITS.map((item) => item.value);

/** 缺失 / 不可换算的说明文案 */
const STATUS_LABELS: Record<string, string> = {
  missing: '暂无营养数据',
  unconvertible: '缺少单个重量，无法换算',
};

/** 首次进入时按家庭偏好确定人数所在的索引 */
function resolveDefaultPeopleIndex(family: FamilyDTO | null): number {
  const preferred = family && family.preferences ? family.preferences.defaultPeopleCount : DEFAULT_PEOPLE_COUNT;
  const index = PEOPLE_COUNT_OPTIONS.indexOf(preferred);
  return index < 0 ? 0 : index;
}

/**
 * 库存 → 计算入参。
 * name 用 standardName（已归一），否则服务端查不到 nutrition_facts；
 * 只挑合法条目，非法数据直接跳过，不把脏数据发给服务端。
 */
function toInputs(list: Ingredient[]): NutritionIngredientInput[] {
  const inputs: NutritionIngredientInput[] = [];

  for (const item of list) {
    const quantity = Number(item.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      continue;
    }
    if (UNIT_VALUES.indexOf(item.unit) === -1) {
      continue;
    }

    const name = (item.standardName || item.name || '').trim();
    if (!name) {
      continue;
    }

    inputs.push({ name, amount: quantity, unit: item.unit });
    if (inputs.length >= NUTRITION_MAX_INGREDIENTS) {
      break;
    }
  }

  return inputs;
}

function toItemView(item: NutritionItemResult, index: number): NutritionItemView {
  const nutrition = item.status === 'ok' ? item.nutrition : null;

  return {
    key: `${index}-${item.name}`,
    name: item.name,
    amountLabel: `${item.amount} ${getUnitLabel(item.unit)}`,
    gramsLabel: item.grams === null ? '' : `可食 ${formatGram(item.grams)}`,
    kcalLabel: nutrition ? formatKcal(nutrition.calories) : '未计入',
    status: item.status,
    statusLabel: STATUS_LABELS[item.status] || '',
  };
}

Page({
  data: {
    /** 登录初始化是否结束 */
    authReady: false,
    isLoggedIn: false,
    /** 库存与营养是否已向服务端确认 */
    ready: false,
    loading: false,
    /** 仅切换人数时的轻量重算，不清空已有结果 */
    calculating: false,
    hasFamily: false,
    error: '',

    /* ---- 人数 ---- */
    peopleLabels: PEOPLE_LABELS,
    peopleIndex: 0,
    peopleCount: DEFAULT_PEOPLE_COUNT,
    /** 用户是否手动改过人数：改过就不再被家庭偏好覆盖 */
    peopleTouched: false,

    /* ---- 库存概览 ---- */
    hasIngredients: false,
    ingredientCount: 0,

    /* ---- 计算结果（全部来自服务端） ---- */
    result: null as NutritionResult | null,
    total: null as NutritionSummary | null,
    perPerson: null as NutritionSummary | null,
    items: [] as NutritionItemView[],
    partial: false,
    partialMessage: NUTRITION_PARTIAL_MESSAGE,
    missingText: '',
    unconvertibleText: '',
    computedCount: 0,

    /** 计算入参缓存：切换人数时复用，避免重复读库存 */
    inputs: [] as NutritionIngredientInput[],
  },

  onShow() {
    void this.load();
  },

  /** 读取库存并计算：一切以服务端返回为准 */
  async load() {
    const app = getApp<IAppOption>();
    const auth = app.getAuthState();

    if (!auth.ready) {
      this.setData({ authReady: false, isLoggedIn: auth.isLoggedIn });
      return;
    }

    if (!auth.isLoggedIn) {
      // 未登录不调用任何接口，只引导登录
      this.setData({
        authReady: true,
        isLoggedIn: false,
        ready: true,
        hasFamily: false,
        loading: false,
        error: '',
        inputs: [],
        hasIngredients: false,
        ingredientCount: 0,
        ...this.emptyResult(),
      });
      return;
    }

    let familyId = app.globalData.currentFamilyId;
    if (!familyId) {
      // 全局家庭态可能尚未就绪，主动确认一次，失败不抛
      await app.refreshFamily();
      familyId = app.globalData.currentFamilyId;
    }

    if (!familyId) {
      // 「没有家庭」是正常业务状态：食材按家庭共享
      this.setData({
        authReady: true,
        isLoggedIn: true,
        ready: true,
        hasFamily: false,
        loading: false,
        error: '',
        inputs: [],
        hasIngredients: false,
        ingredientCount: 0,
        ...this.emptyResult(),
      });
      return;
    }

    if (!this.data.peopleTouched) {
      const index = resolveDefaultPeopleIndex(app.globalData.family);
      this.setData({
        peopleIndex: index,
        peopleCount: PEOPLE_COUNT_OPTIONS[index] || DEFAULT_PEOPLE_COUNT,
      });
    }

    this.setData({
      authReady: true,
      isLoggedIn: true,
      hasFamily: true,
      loading: true,
      error: '',
    });

    try {
      const list = await ingredientService.list(familyId);
      const inputs = toInputs(list || []);

      if (inputs.length === 0) {
        this.setData({
          loading: false,
          ready: true,
          hasIngredients: false,
          ingredientCount: 0,
          inputs: [],
          error: '',
          ...this.emptyResult(),
        });
        return;
      }

      const result = await nutritionService.calculate(inputs, this.data.peopleCount, familyId);
      this.applyResult(inputs, result);
    } catch (error) {
      // 网络异常：保留已有结果，仅提示错误，不清空
      this.setData({
        loading: false,
        ready: true,
        hasFamily: true,
        error: getErrorMessage(error, '营养计算失败，请稍后重试'),
      });
    }
  },

  /** 把服务端结果写入展示状态 */
  applyResult(inputs: NutritionIngredientInput[], result: NutritionResult) {
    this.setData({
      loading: false,
      calculating: false,
      ready: true,
      hasIngredients: true,
      ingredientCount: inputs.length,
      inputs,
      result,
      total: {
        calories: result.calories,
        protein: result.protein,
        fat: result.fat,
        carbohydrate: result.carbohydrate,
      },
      perPerson: result.perPerson,
      items: (result.items || []).map((item, index) => toItemView(item, index)),
      partial: result.nutritionStatus === 'partial',
      missingText: (result.missing || []).join('、'),
      unconvertibleText: (result.unconvertible || []).join('、'),
      computedCount: result.computedCount,
      error: '',
    });
  },

  /** 清空计算结果时统一走这里，避免遗漏字段导致残留旧数据 */
  emptyResult() {
    return {
      result: null as NutritionResult | null,
      total: null as NutritionSummary | null,
      perPerson: null as NutritionSummary | null,
      items: [] as NutritionItemView[],
      partial: false,
      missingText: '',
      unconvertibleText: '',
      computedCount: 0,
    };
  },

  /** 切换人数：只重算，不重新读库存 */
  onPeopleChange(e: WechatMiniprogram.CustomEvent<{ value: string | number }>) {
    const index = Number(e.detail.value);
    if (!Number.isInteger(index) || index < 0 || index >= PEOPLE_COUNT_OPTIONS.length) {
      return;
    }

    this.setData({
      peopleIndex: index,
      peopleCount: PEOPLE_COUNT_OPTIONS[index],
      peopleTouched: true,
    });
    void this.recalculate();
  },

  async recalculate() {
    const inputs = this.data.inputs;
    if (!inputs || inputs.length === 0 || this.data.calculating) {
      return;
    }

    const familyId = getApp<IAppOption>().globalData.currentFamilyId || undefined;
    this.setData({ calculating: true, error: '' });

    try {
      const result = await nutritionService.calculate(inputs, this.data.peopleCount, familyId);
      this.applyResult(inputs, result);
    } catch (error) {
      this.setData({
        calculating: false,
        error: getErrorMessage(error, '营养计算失败，请稍后重试'),
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

  /** 回食材页补数据：食材页是 TabBar 页面，必须用 switchTab */
  onGoIngredients() {
    wx.switchTab({ url: '/pages/ingredients/index' });
  },
});
