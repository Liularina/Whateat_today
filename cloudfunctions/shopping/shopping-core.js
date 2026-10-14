/**
 * 采购清单聚合核心（Phase E1）
 *
 * 纯函数，无云开发依赖，便于被 shopping 云函数调用与单独验证。
 *
 * 输入：一份已确认菜单（menus 文档） + 当前家庭食材库存（ingredients 文档数组）
 * 输出：按食材分类分组的采购项，每项含「需要量 / 已备量 / 待购量 / 是否已勾选」
 *
 * 口径说明：
 *   1. 菜品食材用量按「菜单人数 / 菜品人数」等比缩放，与 confirmMenu 的营养快照一致；
 *   2. kg 统一换算为 g 后再累加，其余单位（个/袋/盒/勺…）保持原生单位，不跨单位相加；
 *   3. 库存比对只按「标准名相同 + 单位相同」相减，不做别名映射（别名在写入库存时已标准化）；
 *   4. 待购量为负数时归零，并标记 enough=true，前端据此显示「已备齐」。
 */

/* ============================== 分类 ============================== */

/** 与 cloudfunctions/recipe 的分类无关，这里对齐 miniprogram/types/ingredient 的 IngredientCategoryCode */
const CATEGORY_ORDER = [
  'vegetable',
  'meat_egg',
  'seafood',
  'staple',
  'soy_product',
  'dairy',
  'fruit',
  'seasoning',
  'other',
];

const CATEGORY_LABELS = {
  vegetable: '蔬菜',
  meat_egg: '肉蛋',
  seafood: '水产',
  staple: '主食',
  soy_product: '豆制品',
  dairy: '乳制品',
  fruit: '水果',
  seasoning: '调味',
  other: '其他',
};

/**
 * 关键词 → 分类，按数组顺序匹配，先命中先返回。
 * 「干辣椒」必须排在「辣椒」之前，否则会被误判成蔬菜。
 */
const CATEGORY_KEYWORDS = [
  ['seasoning', ['食盐', '盐', '白砂糖', '砂糖', '冰糖', '糖', '酱油', '醋', '食用油', '香油', '料酒', '花椒', '干辣椒', '豆瓣酱', '味精', '蚝油']],
  ['seafood', ['鱼', '虾', '蟹', '贝', '蛤', '蚝', '鱿鱼', '海带', '紫菜', '扇贝', '龙虾', '墨鱼']],
  ['meat_egg', ['猪肉', '牛肉', '羊肉', '鸡肉', '鸭肉', '鹅肉', '猪蹄', '牛腩', '牛排', '牛尾', '鸡翅', '鸡腿', '鸡胸', '排骨', '火腿', '培根', '香肠', '肉丝', '肉末', '鸡蛋', '蛋液', '皮蛋', '咸蛋']],
  ['dairy', ['牛奶', '奶油', '奶酪', '黄油', '芝士', '酸奶', '炼乳']],
  ['soy_product', ['豆腐', '豆浆', '豆干', '豆皮', '腐竹', '豆豉', '黄豆', '大豆']],
  ['staple', ['大米', '米饭', '米', '面条', '面粉', '挂面', '馒头', '面包', '粉丝', '年糕', '燕麦']],
  ['fruit', ['苹果', '香蕉', '橙', '梨', '葡萄', '桃', '芒果', '西瓜', '草莓', '柠檬', '枣']],
  ['vegetable', ['菜', '葱', '蒜', '姜', '椒', '瓜', '萝卜', '番茄', '西红柿', '土豆', '香菇', '菇', '木耳', '菠菜', '芹', '茄', '豆角', '四季豆', '青豆', '洋葱', '西兰花', '玉米', '银耳', '莲藕', '笋']],
];

/* ============================== 基础工具 ============================== */

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

/** 按名称猜分类，未知归入 other */
function guessCategory(name) {
  const text = normalizeText(name);
  if (!text) return 'other';
  for (let i = 0; i < CATEGORY_KEYWORDS.length; i++) {
    const category = CATEGORY_KEYWORDS[i][0];
    const keywords = CATEGORY_KEYWORDS[i][1];
    for (let j = 0; j < keywords.length; j++) {
      if (text.indexOf(keywords[j]) !== -1) return category;
    }
  }
  return 'other';
}

function getCategoryLabel(code) {
  return CATEGORY_LABELS[code] || CATEGORY_LABELS.other;
}

/**
 * 归一化「数量 + 单位」：kg → g（数量乘 1000），其余单位原样保留。
 * 数量非法时按 0 处理，保证聚合结果不会出现 NaN。
 */
function normalizeAmountUnit(amount, unit) {
  const normalizedUnit = normalizeText(unit) || 'g';
  const value = Number(amount);
  if (!Number.isFinite(value) || value < 0) {
    return { amount: 0, unit: normalizedUnit };
  }
  if (normalizedUnit === 'kg') {
    return { amount: round2(value * 1000), unit: 'g' };
  }
  return { amount: round2(value), unit: normalizedUnit };
}

/* ============================== 聚合 ============================== */

/**
 * 汇总菜单所有菜品需要的食材。
 * 同一食材同一单位累加；单位不同（如「番茄 2 个」与「番茄 100 g」）分别成项。
 *
 * @returns 对象：key = 名称|单位 → { key, name, unit, amount, dishes }
 */
function collectNeeded(menu) {
  const menuServings = Number(menu && menu.servings) || 0;
  const items = menu && Array.isArray(menu.items) ? menu.items : [];
  const map = {};

  items.forEach((item) => {
    const itemServings = Number(item && item.servings) || 0;
    const scale = itemServings > 0 && menuServings > 0 ? menuServings / itemServings : 1;
    const ingredients = item && Array.isArray(item.ingredients) ? item.ingredients : [];
    const dishName = normalizeText(item && item.name);

    ingredients.forEach((ingredient) => {
      const name = normalizeText(ingredient && ingredient.name);
      if (!name) return;
      const normalized = normalizeAmountUnit(ingredient && ingredient.amount, ingredient && ingredient.unit);
      if (normalized.amount <= 0) return;

      const key = name + '|' + normalized.unit;
      if (!map[key]) {
        map[key] = { key: key, name: name, unit: normalized.unit, amount: 0, dishes: [] };
      }
      map[key].amount = round2(map[key].amount + normalized.amount * scale);
      if (dishName && map[key].dishes.indexOf(dishName) === -1) {
        map[key].dishes.push(dishName);
      }
    });
  });

  return map;
}

/** 汇总库存：key = 标准名|单位 → 数量 */
function collectStock(ingredients) {
  const list = Array.isArray(ingredients) ? ingredients : [];
  const map = {};
  list.forEach((item) => {
    const name = normalizeText(item && (item.standardName || item.name));
    if (!name) return;
    const normalized = normalizeAmountUnit(item && item.quantity, item && item.unit);
    if (normalized.amount <= 0) return;
    const key = name + '|' + normalized.unit;
    map[key] = round2((map[key] || 0) + normalized.amount);
  });
  return map;
}

/**
 * 生成采购项列表。
 *
 * @param menu       menus 文档
 * @param ingredients ingredients 文档数组（可空）
 * @returns items[]，按「分类顺序 → 待购优先 → 名称」排序
 */
function buildShoppingItems(menu, ingredients) {
  const needed = collectNeeded(menu);
  const stock = collectStock(ingredients);

  const items = Object.keys(needed).map((key) => {
    const need = needed[key];
    const stockAmount = stock[key] || 0;
    const diff = round2(need.amount - stockAmount);
    const toBuy = diff > 0 ? diff : 0;
    const category = guessCategory(need.name);
    return {
      key: need.key,
      name: need.name,
      unit: need.unit,
      category: category,
      categoryLabel: getCategoryLabel(category),
      needed: need.amount,
      stock: stockAmount,
      toBuy: toBuy,
      enough: toBuy <= 0,
      checked: false,
      dishes: need.dishes,
    };
  });

  return sortItems(items);
}

function categoryRank(code) {
  const index = CATEGORY_ORDER.indexOf(code);
  return index === -1 ? CATEGORY_ORDER.length : index;
}

function sortItems(items) {
  const list = Array.isArray(items) ? items.slice() : [];
  list.sort((a, b) => {
    const rankDiff = categoryRank(a.category) - categoryRank(b.category);
    if (rankDiff !== 0) return rankDiff;
    if (a.enough !== b.enough) return a.enough ? 1 : -1;
    if (a.toBuy !== b.toBuy) return b.toBuy - a.toBuy;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
  return list;
}

/** 按分类分组，保留 CATEGORY_ORDER 顺序 */
function groupItems(items) {
  const list = Array.isArray(items) ? items : [];
  const groups = [];
  const indexMap = {};
  CATEGORY_ORDER.forEach((code) => {
    indexMap[code] = -1;
  });
  list.forEach((item) => {
    const code = item.category || 'other';
    if (indexMap[code] === undefined || indexMap[code] === -1) {
      indexMap[code] = groups.length;
      groups.push({
        category: code,
        label: getCategoryLabel(code),
        items: [],
        toBuyCount: 0,
      });
    }
    const group = groups[indexMap[code]];
    group.items.push(item);
    if (item.enough !== true) group.toBuyCount += 1;
  });
  return groups;
}

/** 读取 items 的勾选状态为 map，便于刷新时迁移 */
function extractChecked(items) {
  const map = {};
  (Array.isArray(items) ? items : []).forEach((item) => {
    if (item && item.key && item.checked === true) map[item.key] = true;
  });
  return map;
}

/** 按已保存的勾选状态回填（刷新清单时保留用户勾选） */
function applyChecked(items, checkedMap) {
  const map = checkedMap || {};
  return (Array.isArray(items) ? items : []).map((item) =>
    Object.assign({}, item, { checked: map[item.key] === true }));
}

/** 汇总统计，供列表头展示 */
function summarizeItems(items) {
  const list = Array.isArray(items) ? items : [];
  let toBuyCount = 0;
  let inStockCount = 0;
  let checkedCount = 0;
  list.forEach((item) => {
    if (item.enough === true) {
      inStockCount += 1;
    } else {
      toBuyCount += 1;
    }
    if (item.checked === true) checkedCount += 1;
  });
  return {
    total: list.length,
    toBuyCount: toBuyCount,
    inStockCount: inStockCount,
    checkedCount: checkedCount,
  };
}

module.exports = {
  CATEGORY_ORDER,
  CATEGORY_LABELS,
  guessCategory,
  getCategoryLabel,
  normalizeAmountUnit,
  collectNeeded,
  collectStock,
  buildShoppingItems,
  sortItems,
  groupItems,
  extractChecked,
  applyChecked,
  summarizeItems,
};
