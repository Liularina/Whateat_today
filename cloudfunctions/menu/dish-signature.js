/**
 * 菜品相似度签名（程序化强去重）
 *
 * 纯函数，不依赖云开发：
 *   - recommend 云函数用它判断「这套菜单是不是又跟前几天重复了」；
 *   - menu 云函数用它给换菜 / 批量重推做同一套判定。
 *
 * 为什么必须放服务端：
 *   提示词里让模型「自己注意别重复」并不可靠 —— 模型经常无视这类叮嘱。
 *   把主料、烹饪方式、菜系风味抽成结构化签名后，可以用程序硬性拦截
 *   高度相似的组合，模型只负责在剩下的安全选项里挑。
 *
 * 本文件在 recommend / menu 两个云函数目录各存一份（云函数之间不能共享文件），
 * verify-recommend-chef.js 会校验两份字节一致。
 */

/* ============================== 词表 ============================== */

/**
 * 主蛋白关键词 → 归一后的蛋白类别。
 * 顺序有意义：先匹配更具体的（虾仁 → 虾），避免被泛词抢先吃掉。
 */
const PROTEIN_KEYWORDS = [
  { key: '虾', words: ['虾'] },
  { key: '蟹', words: ['蟹'] },
  { key: '鱼', words: ['鱼'] },
  { key: '贝', words: ['蛤', '贝', '蚝', '鱿鱼', '墨鱼'] },
  { key: '鸡蛋', words: ['鸡蛋', '蛋'] },
  { key: '鸭', words: ['鸭'] },
  { key: '鸡', words: ['鸡', '鸡翅', '鸡腿', '鸡胸'] },
  { key: '牛', words: ['牛'] },
  { key: '羊', words: ['羊'] },
  { key: '猪', words: ['猪', '五花', '排骨', '里脊', '肉末', '肉丝', '肉片', '火腿', '培根'] },
  { key: '豆腐', words: ['豆腐', '豆干', '豆皮', '腐竹'] },
];

/** 烹饪方式关键词 → 归一后的做法类别 */
const METHOD_KEYWORDS = [
  { key: '凉拌', words: ['凉拌', '拌', '沙拉'] },
  { key: '蒸', words: ['蒸'] },
  { key: '炖', words: ['炖', '焖', '煲'] },
  { key: '汤', words: ['汤', '羹'] },
  { key: '烤', words: ['烤'] },
  { key: '炸', words: ['炸', '酥'] },
  { key: '煎', words: ['煎'] },
  { key: '烧', words: ['红烧', '烧'] },
  { key: '炒', words: ['炒', '爆'] },
  { key: '煮', words: ['煮', '烩', '汆', '卤'] },
  // 只收明确的成品词：单个「饭」「面」会误命中「下饭」「面筋」这类标签
  { key: '主食', words: ['炒饭', '盖饭', '拌饭', '焖饭', '粥', '面条', '炒面', '汤面', '拌面', '饺子', '包子', '馒头', '饼'] },
];

/** 菜系 / 风味标签（来自 recipes.tags） */
const CUISINE_WORDS = [
  '川味', '川菜', '粤式', '粤菜', '湘菜', '东北菜', '台式', '西北', '西式',
  '家常', '清淡', '麻辣', '酸辣', '酸甜', '香辣', '咸鲜',
];

/**
 * 蔬菜主料关键词 → 归一类别。
 * 只用于判断「两道菜是不是同一个蔬菜打底」，不做完整食材解析。
 */
const VEGETABLE_KEYWORDS = [
  '番茄', '西红柿', '土豆', '青椒', '尖椒', '茄子', '黄瓜', '冬瓜', '南瓜',
  '白菜', '娃娃菜', '包菜', '生菜', '菠菜', '油菜', '青菜', '上海青', '芹菜',
  '西兰花', '菜花', '韭菜', '丝瓜', '莲藕', '山药', '白萝卜', '胡萝卜',
  '豆芽', '粉丝', '木耳', '香菇', '豆腐',
];

/** 视为「调味料 / 辅料」的食材，不参与主料判定 */
const SEASONING_WORDS = [
  '食盐', '食用油', '酱油', '生抽', '老抽', '醋', '白砂糖', '冰糖', '料酒',
  '淀粉', '香油', '蚝油', '豆瓣酱', '番茄酱', '咖喱', '孜然', '花椒',
  '干辣椒', '姜', '小葱', '大蒜', '葱', '蒜', '胡椒', '味精', '鸡精',
  '清水', '水', '蜂蜜', '芝麻',
];

/* ============================== 基础工具 ============================== */

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isSeasoning(name) {
  const text = normalizeText(name);
  if (!text) return true;
  for (let i = 0; i < SEASONING_WORDS.length; i++) {
    if (text.indexOf(SEASONING_WORDS[i]) !== -1) return true;
  }
  return false;
}

/** 从文本里按词表识别类别，命中即返回 */
function matchKeyword(text, table) {
  const source = normalizeText(text);
  if (!source) return '';
  for (let i = 0; i < table.length; i++) {
    const entry = table[i];
    for (let j = 0; j < entry.words.length; j++) {
      if (source.indexOf(entry.words[j]) !== -1) return entry.key;
    }
  }
  return '';
}

/**
 * 主料蛋白类别：以食材表为准，菜名只作兜底。
 *
 * 为什么不能优先看菜名：
 *   「鱼香肉丝」里没有鱼，「蚂蚁上树」里没有蚂蚁，「老婆饼」里没有老婆。
 *   大量菜名只是形容味道或来历，靠菜名猜主料会把鱼香肉丝判成鱼，
 *   进而让去重逻辑把它和清蒸鱼归成一类，或漏掉它其实是猪肉菜。
 *
 * 先扫食材里的蛋白类；食材里完全没有蛋白时（例如只有名字的库外菜），
 * 才退回菜名。
 */
function resolveProtein(name, ingredientNames) {
  for (let i = 0; i < ingredientNames.length; i++) {
    const hit = matchKeyword(ingredientNames[i], PROTEIN_KEYWORDS);
    if (hit) return hit;
  }
  return matchKeyword(name, PROTEIN_KEYWORDS);
}

/**
 * 做法类别的判定优先级。
 *
 * 步骤描述里常出现「焯水后凉拌」「先煎再烧」这类前置处理，
 * 朴素地取第一个命中词会把主做法判错，所以按「主制法制胜」排序：
 * 炒 / 烧 / 蒸 / 炖 / 汤 > 烤 / 炸 / 煎 / 煮 > 凉拌 > 主食。
 */
const METHOD_PRIORITY = ['炒', '烧', '蒸', '炖', '汤', '烤', '炸', '煎', '煮', '凉拌', '主食'];

/** 在文本里按优先级找做法，而不是按出现顺序 */
function matchMethodByPriority(text) {
  const source = normalizeText(text);
  if (!source) return '';
  for (let i = 0; i < METHOD_PRIORITY.length; i++) {
    const target = METHOD_PRIORITY[i];
    const entry = METHOD_KEYWORDS.find((item) => item.key === target);
    if (!entry) continue;
    for (let j = 0; j < entry.words.length; j++) {
      if (source.indexOf(entry.words[j]) !== -1) return target;
    }
  }
  return '';
}

/**
 * 做法类别：先看菜名，再看步骤文本（按主做法优先级）。
 *
 * 刻意不看 tags —— 「下饭」「清淡」这类标签描述的是感受，
 * 拿来做做法判定会把「宫保鸡丁」误判成主食。
 */
function resolveMethod(name, tags, steps) {
  const fromName = matchMethodByPriority(name);
  if (fromName) return fromName;

  const stepText = (steps || [])
    .map((step) => (step && step.description ? String(step.description) : ''))
    .join(' ');
  return matchMethodByPriority(stepText);
}

/** 菜系 / 风味：取标签里第一个命中的词，没有则为空 */
function resolveCuisine(tags) {
  const list = tags || [];
  for (let i = 0; i < list.length; i++) {
    const tag = normalizeText(list[i]);
    if (!tag) continue;
    if (CUISINE_WORDS.indexOf(tag) !== -1) return tag;
  }
  return '';
}

/** 在文本里找第一个命中的蔬菜词 */
function findVegetable(text) {
  const source = normalizeText(text);
  if (!source) return '';
  for (let i = 0; i < VEGETABLE_KEYWORDS.length; i++) {
    if (source.indexOf(VEGETABLE_KEYWORDS[i]) !== -1) return VEGETABLE_KEYWORDS[i];
  }
  return '';
}

/** 菜品的主蔬菜（用于识别「换汤不换药」）：菜名优先，其次看食材 */
function resolveVegetable(name, ingredientNames) {
  const fromName = findVegetable(name);
  if (fromName) return fromName;
  for (let i = 0; i < ingredientNames.length; i++) {
    const hit = findVegetable(ingredientNames[i]);
    if (hit) return hit;
  }
  return '';
}

/* ============================== 签名 ============================== */

/**
 * 计算菜品签名。
 *
 * @param {{name?:string, tags?:string[], ingredients?:{name:string}[], steps?:{description:string}[]}} recipe
 * @returns {{name:string, protein:string, method:string, cuisine:string, vegetable:string,
 *            mainIngredients:string[], key:string, probe:string}}
 *   key   —— 主料 + 做法，用于判定「同一套路」
 *   probe —— key + 菜系/蔬菜，用于判定「换汤不换药」
 */
function buildSignature(recipe) {
  const doc = recipe || {};
  const name = normalizeText(doc.name);
  const ingredientNames = (doc.ingredients || [])
    .map((item) => normalizeText(item && item.name))
    .filter(Boolean);

  const mainIngredients = ingredientNames.filter((n) => !isSeasoning(n)).slice(0, 4);

  const protein = resolveProtein(name, ingredientNames);
  const method = resolveMethod(name, doc.tags, doc.steps);
  const cuisine = resolveCuisine(doc.tags);
  const vegetable = resolveVegetable(name, ingredientNames);

  return {
    name: name,
    protein: protein,
    method: method,
    cuisine: cuisine,
    vegetable: vegetable,
    mainIngredients: mainIngredients,
    key: (protein || '?') + '|' + (method || '?'),
    probe: (protein || '?') + '|' + (method || '?') + '|' + (vegetable || cuisine || '-'),
  };
}

/* ============================== 相似度 ============================== */

/**
 * 两道菜的重复程度。
 *
 * @returns {{level:'identical'|'similar'|'flavor'|'none', reason:string}}
 *   identical —— 同名（忽略「西红柿/番茄」等异体写法）
 *   similar   —— 同主料 + 同做法：本质上就是同一道菜的变体
 *   flavor    —— 同主料 + 同蔬菜/菜系：换了做法但吃起来高度接近
 */
function compareSignature(a, b) {
  const left = a || {};
  const right = b || {};
  const leftName = normalizeText(left.name);
  const rightName = normalizeText(right.name);

  if (leftName && rightName && leftName === rightName) {
    return { level: 'identical', reason: '同名：' + leftName };
  }

  const leftKey = left.key || buildSignature(left).key;
  const rightKey = right.key || buildSignature(right).key;

  if (leftKey !== '?|?' && leftKey === rightKey) {
    return {
      level: 'similar',
      reason: '同主料同做法：' + leftKey.replace('|', ' / '),
    };
  }

  // 一道菜「没识别出做法」不等于「做法不同」：
  // 「清炒西兰花」能识别出炒，「蒜蓉西兰花」识别不出，但两道其实是同一盘菜。
  // 只要主料与蔬菜/风味都相同，就按「换汤不换药」处理。
  const leftProbe = left.probe || buildSignature(left).probe;
  const rightProbe = right.probe || buildSignature(right).probe;
  if (leftProbe !== '?|?|-' && leftProbe === rightProbe) {
    return {
      level: 'flavor',
      reason: '同主料同风味：' + leftProbe.replace(/\|/g, ' / '),
    };
  }

  // 主料 + 蔬菜都相同、且其中至少一方做法未知 → 视为同一道菜的变体
  const leftParts = leftProbe.split('|');
  const rightParts = rightProbe.split('|');
  const sameProtein = leftParts[0] === rightParts[0];
  const sameFlavor = leftParts[2] === rightParts[2] && leftParts[2] !== '-';
  const methodUnknown = leftParts[1] === '?' || rightParts[1] === '?';
  if (sameProtein && sameFlavor && methodUnknown) {
    return {
      level: 'flavor',
      reason: '同主料同蔬菜且做法未知：' + leftParts[0] + ' / ' + leftParts[2],
    };
  }

  return { level: 'none', reason: '' };
}

/**
 * 在「近期菜品」里找最相似的一条。
 *
 * @param {object} candidate 待判定菜品
 * @param {object[]} recentDishes 近期做过的菜（含 name / tags / ingredients）
 * @param {{allowFlavor?:boolean}} options allowFlavor=false 时只把 identical/similar 算冲突
 * @returns {{level:string, reason:string, matched:string}|null}
 */
function findConflict(candidate, recentDishes, options) {
  const allowFlavor = !!(options && options.allowFlavor);
  const list = Array.isArray(recentDishes) ? recentDishes : [];
  const target = candidate && candidate.key ? candidate : buildSignature(candidate);

  let flavorHit = null;
  for (let i = 0; i < list.length; i++) {
    const other = list[i];
    if (!other) continue;
    const otherSig = other.key ? other : buildSignature(other);
    const result = compareSignature(target, otherSig);

    if (result.level === 'identical' || result.level === 'similar') {
      return {
        level: result.level,
        reason: result.reason,
        matched: normalizeText(otherSig.name) || '',
      };
    }
    if (result.level === 'flavor' && !flavorHit) {
      flavorHit = {
        level: result.level,
        reason: result.reason,
        matched: normalizeText(otherSig.name) || '',
      };
    }
  }

  if (flavorHit && allowFlavor) return flavorHit;
  return null;
}

/**
 * 从菜单条目里抽出去重用的菜品列表。
 * 兼容历史菜单的 items 结构（含 name / tags / ingredients）。
 */
function dishesOf(menu) {
  const items = (menu && menu.items) || [];
  return items
    .filter((item) => item && (item.name || item.recipeId))
    .map((item) => ({
      name: normalizeText(item.name),
      tags: item.tags || [],
      ingredients: item.ingredients || [],
      recipeId: item.recipeId || item._id || '',
    }));
}

module.exports = {
  PROTEIN_KEYWORDS,
  METHOD_KEYWORDS,
  CUISINE_WORDS,
  VEGETABLE_KEYWORDS,
  SEASONING_WORDS,
  isSeasoning,
  buildSignature,
  compareSignature,
  findConflict,
  dishesOf,
};
