/**
 * 库外新菜的解析与校验
 *
 * AI 允许返回菜谱库里没有的菜（newDish），用来真正「跳出菜谱库」。
 * 但库外菜是模型自由生成的文本，必须当成不可信输入处理：
 *
 *   1. 字段白名单 + 长度上限，避免脏数据写进 recipes；
 *   2. 过敏原 / 忌口用与库内菜谱完全相同的 matchRecipe 硬校验，
 *      命中就整道丢弃 —— 安全规则不能因为「菜是 AI 新想的」就放松；
 *   3. 食材必须给得出用量，否则采购清单和营养估算都会失真。
 *
 * 纯函数，不依赖云开发，便于单测。
 */

/** 允许的菜品分类（与内置菜谱保持一致） */
const ALLOWED_CATEGORIES = ['家常菜', '蔬菜类', '汤类', '主食类', '儿童餐', '减肥餐'];

const MAX_NAME_LENGTH = 30;
const MAX_TAGS = 6;
const MAX_TAG_LENGTH = 12;
const MAX_INGREDIENTS = 20;
const MAX_INGREDIENT_NAME = 20;
const MAX_UNIT_LENGTH = 6;
const MAX_COOK_TIME = 240;
const MAX_SERVINGS = 20;

function toText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

/** 去掉「少许 / 适量 / 若干」这类无法用于采购的用量 */
function normalizeAmount(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  // 单位为「个 / 只」时允许小数没意义，统一保留两位
  return Math.round(num * 100) / 100;
}

/**
 * 规范化 AI 返回的库外菜。
 *
 * @returns {{ok:true, value:object} | {ok:false, reason:string}}
 */
function normalizeNewDish(raw) {
  const input = raw && typeof raw === 'object' ? raw : null;
  if (!input) return { ok: false, reason: 'newDish 不是对象' };

  const name = toText(input.name, MAX_NAME_LENGTH);
  if (name.length < 2) return { ok: false, reason: '菜名缺失或过短' };

  // 食材：必须至少一条，且每条都要有名字和可用用量
  const rawIngredients = Array.isArray(input.ingredients) ? input.ingredients : [];
  const ingredients = [];
  for (let i = 0; i < rawIngredients.length && ingredients.length < MAX_INGREDIENTS; i++) {
    const item = rawIngredients[i];
    if (!item || typeof item !== 'object') continue;
    const ingredientName = toText(item.name, MAX_INGREDIENT_NAME);
    if (!ingredientName) continue;
    const amount = normalizeAmount(item.amount);
    if (amount <= 0) {
      return {
        ok: false,
        reason: '食材「' + ingredientName + '」缺少可用用量（不能写适量）',
      };
    }
    ingredients.push({
      name: ingredientName,
      amount: amount,
      unit: toText(item.unit, MAX_UNIT_LENGTH) || 'g',
    });
  }
  if (ingredients.length === 0) return { ok: false, reason: '缺少有效食材' };

  const category = ALLOWED_CATEGORIES.indexOf(toText(input.category, 20)) !== -1
    ? toText(input.category, 20)
    : '家常菜';

  const rawTags = Array.isArray(input.tags) ? input.tags : [];
  const tags = [];
  for (let i = 0; i < rawTags.length && tags.length < MAX_TAGS; i++) {
    const tag = toText(rawTags[i], MAX_TAG_LENGTH);
    if (tag && tags.indexOf(tag) === -1) tags.push(tag);
  }

  const cookTime = Number(input.cookTime);
  const servings = Number(input.servings);

  return {
    ok: true,
    value: {
      name: name,
      category: category,
      tags: tags,
      difficulty: input.difficulty === 'easy' || input.difficulty === 'hard' ? input.difficulty : 'medium',
      cookTime: Number.isFinite(cookTime) && cookTime > 0
        ? Math.min(Math.round(cookTime), MAX_COOK_TIME)
        : 30,
      servings: Number.isFinite(servings) && servings > 0
        ? Math.min(Math.round(servings), MAX_SERVINGS)
        : 2,
      ingredients: ingredients,
      // 库外菜没有步骤，交给 recipe 云函数按需生成做法
      steps: [],
    },
  };
}

/**
 * 解析 AI 返回的 dishes 数组，支持两种写法：
 *   { recipeId: 'xxx' }   —— 从候选里选
 *   { newDish: {...} }    —— 库外新菜
 *
 * @param {Array} dishes
 * @returns {{recipeIds:string[], newDishes:object[], rejected:Array<{name:string, reason:string}>}}
 */
function parseDishSelections(dishes) {
  const recipeIds = [];
  const newDishes = [];
  const rejected = [];

  (Array.isArray(dishes) ? dishes : []).forEach((item) => {
    // 兼容旧格式：直接在数组里给字符串 id（必须在对象判断之前，
    // 否则 'r-2' 这类原始值会被当成「不是对象」直接丢掉）
    if (typeof item === 'string') {
      const id = item.trim();
      if (id && recipeIds.indexOf(id) === -1) recipeIds.push(id);
      return;
    }

    if (!item || typeof item !== 'object') return;

    if (typeof item.recipeId === 'string' && item.recipeId.trim()) {
      const id = item.recipeId.trim();
      if (recipeIds.indexOf(id) === -1) recipeIds.push(id);
      return;
    }

    if (item.newDish !== undefined) {
      const normalized = normalizeNewDish(item.newDish);
      if (normalized.ok) {
        newDishes.push(normalized.value);
      } else {
        rejected.push({
          name: (item.newDish && item.newDish.name) || '',
          reason: normalized.reason,
        });
      }
    }
  });

  return { recipeIds: recipeIds, newDishes: newDishes, rejected: rejected };
}

/**
 * 用家庭过敏原 / 忌口硬校验库外菜。
 *
 * 复用 diet-filter 的 matchRecipe，保证库内库外同一套判定标准。
 *
 * @param {object} dish 已规范化的库外菜
 * @param {object} diet buildDiet() 的结果
 * @param {Function} matchRecipe diet-filter 导出的匹配函数
 * @returns {{ok:boolean, matches:Array}}
 */
function checkNewDishDiet(dish, diet, matchRecipe) {
  const matches = typeof matchRecipe === 'function' ? matchRecipe(dish, diet) : [];
  return { ok: matches.length === 0, matches: matches };
}

/**
 * 判断库外菜是否与近期菜单重复。
 *
 * 库外菜同样适用「同名 / 同主料同做法」的硬去重规则，
 * 否则模型只要把菜名换个写法就能绕过近期菜单限制。
 */
function isNewDishRepeated(dish, recentDishes, findConflictFn) {
  if (typeof findConflictFn !== 'function') return null;
  return findConflictFn(dish, recentDishes);
}

module.exports = {
  ALLOWED_CATEGORIES,
  MAX_NAME_LENGTH,
  normalizeNewDish,
  parseDishSelections,
  checkNewDishDiet,
  isNewDishRepeated,
};
