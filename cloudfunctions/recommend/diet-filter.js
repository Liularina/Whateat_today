/**
 * 过敏原 / 忌口程序硬过滤（Phase E2）
 *
 * 纯函数，不依赖云开发：
 *   - recommend 云函数在生成候选菜谱前先做硬过滤，AI 结果再按白名单复核一次；
 *   - menu 云函数的换菜 / 批量重推同样在候选阶段过滤，避免换出过敏原菜品。
 *
 * 为什么必须放服务端：
 *   家庭偏好是服务端数据（families.preferences）。客户端传入的 preferences 只作为
 *   提示词文本，过敏原属于安全约束，必须由服务端按数据库里的偏好强制执行，
 *   不能信任客户端提交的内容。
 *
 * 本文件在 recommend / menu 两个云函数目录各存一份（云函数之间不能共享文件），
 * verify-diet.js 会校验两份字节一致。
 */

/* ============================== 关键词映射 ============================== */

/**
 * 常见过敏原 → 命中该过敏原的食材关键词。
 * 关键词与 cloudfunctions/recipe/recipe-data.js 里实际出现的食材命名对齐，
 * 例如「花生米」「豆腐」「酱油」「面条」「虾仁」都能被对应分组命中。
 */
const ALLERGEN_KEYWORDS = {
  '花生': ['花生', '花生米', '花生酱'],
  '鸡蛋': ['鸡蛋', '蛋'],
  '牛奶': ['牛奶', '奶油', '奶酪', '黄油', '芝士', '炼乳', '酸奶'],
  '大豆': ['大豆', '黄豆', '豆腐', '豆浆', '豆干', '豆皮', '豆豉', '腐竹', '酱油', '豆瓣酱'],
  '小麦': ['小麦', '面粉', '面条', '挂面', '馒头', '面包', '饺子皮', '馄饨皮'],
  '坚果': ['坚果', '核桃', '腰果', '杏仁', '开心果', '榛子', '松子', '瓜子', '芝麻', '香油'],
  '鱼类': ['鱼'],
  '甲壳类': ['虾', '蟹', '贝', '蛤', '蚝', '扇贝', '龙虾'],
};

/**
 * 忌口标签 → 关键词扩充表。
 * 忌口标签常写成「不吃猪肉」这类组合，去掉前缀后「猪肉」直接命中食材名；
 * 「海鲜」「肉」这类笼统说法需要展开成具体食材，故单独列出。
 */
const AVOID_EXPANSIONS = {
  '海鲜': ['虾', '蟹', '鱼', '贝', '蛤', '蚝', '鱿鱼', '海带', '紫菜', '海鲜'],
  '肉': ['猪肉', '牛肉', '鸡肉', '羊肉', '排骨', '火腿'],
  '猪肉': ['猪肉', '排骨', '火腿'],
  '鸡肉': ['鸡肉', '鸡翅', '鸡腿'],
  '辣': ['辣椒', '辣'],
};

/** 忌口标签常见前缀，按长到短匹配，避免「不吃」抢先匹配掉「不能吃」 */
const AVOID_PREFIXES = ['不能吃', '不要吃', '不喜欢吃', '不喜欢', '忌食', '不吃', '禁食', '忌', '禁'];

/* ============================== 基础工具 ============================== */

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 去重 + 去空白，保持原有顺序 */
function normalizeTagList(list) {
  if (!Array.isArray(list)) return [];
  const result = [];
  list.forEach((item) => {
    const tag = normalizeText(item);
    if (tag && result.indexOf(tag) === -1) result.push(tag);
  });
  return result;
}

function dedupe(list) {
  const result = [];
  list.forEach((item) => {
    if (item && result.indexOf(item) === -1) result.push(item);
  });
  return result;
}

/** 去掉「不吃 / 忌 / 禁」等前缀，得到用于匹配的关键词 */
function stripAvoidPrefix(tag) {
  let text = normalizeText(tag);
  for (let i = 0; i < AVOID_PREFIXES.length; i++) {
    const prefix = AVOID_PREFIXES[i];
    if (text.length > prefix.length && text.indexOf(prefix) === 0) {
      text = text.slice(prefix.length);
      break;
    }
  }
  return text;
}

/** 展开一个过敏原标签：已知分组用分组表，自定义标签（如「芒果」）用标签本身 */
function expandAllergen(tag) {
  const keywords = ALLERGEN_KEYWORDS[tag];
  return keywords ? keywords.slice() : [tag];
}

/** 展开一个忌口标签：先并入扩充表，再并入去前缀后的标签本身 */
function expandAvoid(tag) {
  const base = stripAvoidPrefix(tag);
  const keywords = [];
  const expanded = AVOID_EXPANSIONS[base];
  if (expanded) expanded.forEach((keyword) => keywords.push(keyword));
  if (base) keywords.push(base);
  return dedupe(keywords);
}

/* ============================== 偏好 → 规则 ============================== */

/**
 * 把家庭偏好编译为过滤规则。
 *
 * @param preferences families.preferences，可缺省
 * @returns { allergenTags, avoidTags, rules: [{ kind, tag, keyword }] }
 *          rules 为空表示无任何硬过滤约束，调用方可直接放行。
 */
function buildDiet(preferences) {
  const prefs = preferences || {};
  const allergenTags = normalizeTagList(prefs.allergens);
  const avoidTags = normalizeTagList(prefs.avoidIngredients);

  const rules = [];
  allergenTags.forEach((tag) => {
    expandAllergen(tag).forEach((keyword) => {
      rules.push({ kind: 'allergen', tag: tag, keyword: keyword });
    });
  });
  avoidTags.forEach((tag) => {
    expandAvoid(tag).forEach((keyword) => {
      rules.push({ kind: 'avoid', tag: tag, keyword: keyword });
    });
  });

  return { allergenTags: allergenTags, avoidTags: avoidTags, rules: rules };
}

/* ============================== 命中判断 ============================== */

/**
 * 判断菜谱是否命中过敏原 / 忌口。
 *
 * 检查范围：菜名 + 每个食材名（子串匹配）。
 * 菜名也要查，是因为 AI 生成或人工自建的菜谱可能出现「花生」只在菜名里、
 * 食材列表不全的情况，宁可多拦不可漏拦。
 */
function matchRecipe(recipe, diet) {
  const rules = (diet && diet.rules) || [];
  if (rules.length === 0) return [];

  const fields = [];
  const name = normalizeText(recipe && recipe.name);
  if (name) fields.push({ field: 'name', value: name });
  const ingredients = recipe && Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
  ingredients.forEach((item) => {
    const value = normalizeText(item && item.name);
    if (value) fields.push({ field: 'ingredient', value: value });
  });

  const matches = [];
  const seen = {};
  for (let i = 0; i < fields.length; i++) {
    const current = fields[i];
    for (let j = 0; j < rules.length; j++) {
      const rule = rules[j];
      if (!rule.keyword) continue;
      if (current.value.indexOf(rule.keyword) === -1) continue;
      const key = rule.kind + '|' + rule.tag + '|' + rule.keyword + '|' + current.value;
      if (seen[key]) continue;
      seen[key] = true;
      matches.push({
        kind: rule.kind,
        tag: rule.tag,
        keyword: rule.keyword,
        field: current.field,
        value: current.value,
      });
    }
  }
  return matches;
}

/** 是否被拦下 */
function isBlocked(recipe, diet) {
  return matchRecipe(recipe, diet).length > 0;
}

/**
 * 过滤菜谱列表。
 *
 * @returns { kept, blocked }，blocked 每项含 recipeId / name / matches，
 *          便于日志与响应体透明展示「为什么被过滤」。
 */
function filterRecipes(recipes, diet) {
  const list = Array.isArray(recipes) ? recipes : [];
  const kept = [];
  const blocked = [];
  list.forEach((recipe) => {
    const matches = matchRecipe(recipe, diet);
    if (matches.length === 0) {
      kept.push(recipe);
    } else {
      blocked.push({
        recipeId: (recipe && recipe._id) || '',
        name: normalizeText(recipe && recipe.name),
        matches: matches,
      });
    }
  });
  return { kept: kept, blocked: blocked };
}

/** 供响应体展示的过滤摘要（不含敏感信息） */
function summarizeDiet(diet, blocked) {
  const list = Array.isArray(blocked) ? blocked : [];
  return {
    allergenTags: (diet && diet.allergenTags) ? diet.allergenTags.slice() : [],
    avoidTags: (diet && diet.avoidTags) ? diet.avoidTags.slice() : [],
    blockedCount: list.length,
    blockedRecipeIds: list.map((item) => item.recipeId).filter(Boolean),
    blockedNames: list.map((item) => item.name).filter(Boolean),
  };
}

module.exports = {
  ALLERGEN_KEYWORDS,
  AVOID_EXPANSIONS,
  AVOID_PREFIXES,
  buildDiet,
  matchRecipe,
  isBlocked,
  filterRecipes,
  summarizeDiet,
  stripAvoidPrefix,
  expandAllergen,
  expandAvoid,
};
