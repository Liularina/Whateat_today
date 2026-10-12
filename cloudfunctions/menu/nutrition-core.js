/**
 * 营养计算核心（Phase 5）
 *
 * 纯函数模块，不依赖 wx-server-sdk，可被直接单测。
 * 规范要求：最终营养必须由程序根据 nutrition_facts 重新计算，
 * AI 或客户端传来的任何营养值都不得作为结果 —— 本模块只认「食材 + 数量 + 单位」。
 *
 * 计算口径（与规范第 5 章公式一致）：
 *   单位克数  = g → 数量 ; kg → 数量 × 1000 ; 个/袋/盒 → 数量 × averageWeight
 *   可食克数  = 单位克数 × edibleRate
 *   某项营养  = 可食克数 ÷ 100 × per100g.该项
 *   总营养    = 各食材求和
 *   人均      = 总营养 ÷ 人数
 *
 * 缺失处理：
 *   - 食材不在 nutrition_facts  → 计入 missing，不猜数值
 *   - 个/袋/盒 缺 averageWeight → 计入 unconvertible，不给精确换算
 *   只要出现上述任一情况，nutritionStatus 即为 partial。
 */

/** 第一阶段支持的单位，与 constants/units.ts 保持一致 */
const UNITS = ['g', 'kg', '个', '袋', '盒'];

/** 这些单位必须知道单个重量才能换算为克 */
const WEIGHT_BASED_UNITS = ['个', '袋', '盒'];

const MAX_INGREDIENTS = 100;
const MAX_AMOUNT = 99999;
const MAX_PEOPLE_COUNT = 20;

const NUTRITION_FIELDS = ['calories', 'protein', 'fat', 'carbohydrate'];

function round(value, digits) {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 数量 + 单位 → 克。
 * @returns {number|null} 无法换算时返回 null（不猜测）
 */
function toGram(amount, unit, averageWeight) {
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  if (unit === 'g') {
    return amount;
  }
  if (unit === 'kg') {
    return amount * 1000;
  }
  if (WEIGHT_BASED_UNITS.indexOf(unit) !== -1) {
    if (!Number.isFinite(averageWeight) || averageWeight <= 0) {
      return null;
    }
    return amount * averageWeight;
  }
  return null;
}

/** 校验单个食材项，只取白名单字段 */
function normalizeIngredient(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};

  const name = normalizeText(source.name);
  if (!name) {
    return { error: '食材名称不能为空' };
  }

  const amount = typeof source.amount === 'number' ? source.amount : Number(source.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { error: '食材「' + name + '」的数量必须大于 0' };
  }
  if (amount > MAX_AMOUNT) {
    return { error: '食材「' + name + '」的数量过大' };
  }

  const unit = normalizeText(source.unit);
  if (UNITS.indexOf(unit) === -1) {
    return { error: '食材「' + name + '」的单位不支持' };
  }

  // 只保留 name / amount / unit：
  // 客户端或 AI 一并传来的 calories / nutrition 等字段在这里被丢弃。
  return { value: { name: name, amount: amount, unit: unit } };
}

/**
 * 校验 calculateNutrition 入参。
 * @returns {{error:string}|{value:{ingredients:Array,peopleCount:number}}}
 */
function validateCalculateInput(input) {
  const source = input && typeof input === 'object' ? input : {};

  if (!Array.isArray(source.ingredients)) {
    return { error: 'ingredients 必须是数组' };
  }
  if (source.ingredients.length > MAX_INGREDIENTS) {
    return { error: '一次最多计算 ' + MAX_INGREDIENTS + ' 种食材' };
  }

  const ingredients = [];
  for (const raw of source.ingredients) {
    const parsed = normalizeIngredient(raw);
    if (parsed.error) {
      return { error: parsed.error };
    }
    ingredients.push(parsed.value);
  }

  const peopleCount = typeof source.peopleCount === 'number' ? source.peopleCount : Number(source.peopleCount);
  if (!Number.isInteger(peopleCount) || peopleCount < 1 || peopleCount > MAX_PEOPLE_COUNT) {
    return { error: '用餐人数需为 1 到 ' + MAX_PEOPLE_COUNT + ' 之间的整数' };
  }

  return { value: { ingredients: ingredients, peopleCount: peopleCount } };
}

function emptySummary() {
  return { calories: 0, protein: 0, fat: 0, carbohydrate: 0 };
}

/**
 * 执行营养计算。
 *
 * @param {{ingredients:Array,peopleCount:number}} input 已通过 validateCalculateInput 的入参
 * @param {Object} factMap standardName → nutrition_facts 文档
 */
function calculateNutrition(input, factMap) {
  const facts = factMap || {};
  const peopleCount = input.peopleCount;

  const items = [];
  const missing = [];
  const unconvertible = [];

  let totals = emptySummary();
  let computedCount = 0;

  for (const ingredient of input.ingredients) {
    const name = ingredient.name;
    const fact = facts[name] || null;

    if (!fact) {
      // 数据库没有该食材：绝不编数值
      if (missing.indexOf(name) === -1) {
        missing.push(name);
      }
      items.push({
        name: name,
        amount: ingredient.amount,
        unit: ingredient.unit,
        grams: null,
        nutrition: null,
        status: 'missing',
      });
      continue;
    }

    const rawGrams = toGram(ingredient.amount, ingredient.unit, fact.averageWeight);
    if (rawGrams === null) {
      // 例如「2 个」但不知道单个多重：不给精确换算
      if (unconvertible.indexOf(name) === -1) {
        unconvertible.push(name);
      }
      items.push({
        name: name,
        amount: ingredient.amount,
        unit: ingredient.unit,
        grams: null,
        nutrition: null,
        status: 'unconvertible',
      });
      continue;
    }

    const edibleRate = Number.isFinite(fact.edibleRate) && fact.edibleRate > 0 ? fact.edibleRate : 1;
    const edibleGrams = rawGrams * edibleRate;
    const per100g = fact.per100g || {};
    const factor = edibleGrams / 100;

    const nutrition = {
      calories: factor * (Number(per100g.calories) || 0),
      protein: factor * (Number(per100g.protein) || 0),
      fat: factor * (Number(per100g.fat) || 0),
      carbohydrate: factor * (Number(per100g.carbohydrate) || 0),
    };

    totals = {
      calories: totals.calories + nutrition.calories,
      protein: totals.protein + nutrition.protein,
      fat: totals.fat + nutrition.fat,
      carbohydrate: totals.carbohydrate + nutrition.carbohydrate,
    };
    computedCount += 1;

    items.push({
      name: name,
      amount: ingredient.amount,
      unit: ingredient.unit,
      grams: round(edibleGrams, 1),
      nutrition: {
        calories: round(nutrition.calories, 1),
        protein: round(nutrition.protein, 1),
        fat: round(nutrition.fat, 1),
        carbohydrate: round(nutrition.carbohydrate, 1),
      },
      status: 'ok',
    });
  }

  const perPerson = {};
  for (const field of NUTRITION_FIELDS) {
    perPerson[field] = field === 'calories'
      ? round(totals[field] / peopleCount, 0)
      : round(totals[field] / peopleCount, 1);
  }

  return {
    /* 整桌合计（规范要求的扁平字段） */
    calories: round(totals.calories, 0),
    protein: round(totals.protein, 1),
    fat: round(totals.fat, 1),
    carbohydrate: round(totals.carbohydrate, 1),
    perPerson: perPerson,
    peopleCount: peopleCount,
    /** complete：全部食材都算得出；partial：有食材缺数据或无法换算 */
    nutritionStatus: missing.length === 0 && unconvertible.length === 0 ? 'complete' : 'partial',
    /** 数据库里没有营养数据的食材名 */
    missing: missing,
    /** 有营养数据、但单位无法换算为克的食材名 */
    unconvertible: unconvertible,
    /** 参与计算的食材数（不含 missing / unconvertible） */
    computedCount: computedCount,
    items: items,
  };
}

module.exports = {
  UNITS,
  MAX_INGREDIENTS,
  MAX_PEOPLE_COUNT,
  NUTRITION_FIELDS,
  toGram,
  validateCalculateInput,
  calculateNutrition,
};
