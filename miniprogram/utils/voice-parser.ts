/**
 * 语音录入食材解析器（阶段0-功能A）
 *
 * 把语音识别文本转化为结构化的食材列表。
 * 优先使用轻量规则，避免每次录入都调用 LLM。
 *
 * 输入示例：
 *   "两个西红柿"          → [{ name: "西红柿", quantity: 2, unit: "个" }]
 *   "一斤青菜"            → [{ name: "青菜", quantity: 1, unit: "斤" }]
 *   "三盒牛奶"            → [{ name: "牛奶", quantity: 3, unit: "盒" }]
 *   "五百克鸡胸肉"        → [{ name: "鸡胸肉", quantity: 500, unit: "克" }]
 *   "鸡蛋六个"            → [{ name: "鸡蛋", quantity: 6, unit: "个" }]
 *   "半斤牛肉"            → [{ name: "牛肉", quantity: 0.5, unit: "斤" }]
 *   "一斤半排骨"          → [{ name: "排骨", quantity: 1.5, unit: "斤" }]
 *   "两斤土豆"            → [{ name: "土豆", quantity: 2, unit: "斤" }]
 *   "两个西红柿、三根黄瓜、一斤青菜" → 三条
 */

export interface VoiceParseItem {
  /** 食材名称（可能含修饰词，用户需二次确认） */
  name: string;
  /** 识别到的数量，未识别时为 null */
  quantity: number | null;
  /** 识别到的单位，未识别时为 null */
  unit: string | null;
  /** 在原文中的起始位置 */
  start: number;
  /** 在原文中的结束位置（不含） */
  end: number;
}

/** 中文数字映射 */
const CN_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  百: 100, 千: 1000, 万: 10000,
};

/** 中文数字 → 阿拉伯数字（"五百二十" → 520） */
function parseChineseNumber(text: string): number | null {
  if (!text) return null;

  // 半 → 0.5
  if (text === '半') return 0.5;

  let result = 0;
  let section = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const val = CN_DIGITS[ch];
    if (val === undefined) return null; // 非法字符

    if (val >= 10) {
      if (section === 0) section = 1;
      if (val === 10000) {
        result += section * 10000;
        section = 0;
      } else {
        section *= val;
      }
    } else {
      section += val;
    }
  }
  result += section;
  return result > 0 ? result : null;
}

/** 阿拉伯数字字符串 → number */
function parseArabicNumber(text: string): number | null {
  if (!text) return null;
  const val = Number(text);
  return Number.isFinite(val) && val > 0 ? val : null;
}

/** 特殊复合数量："半斤" → 0.5斤；"一斤半" → 1.5斤 */
const HALF_KILO_RE = /^(半)(斤)$/;
const ONE_HALF_RE = /^(一(?:斤)半)$/;
const ONE_HALF_PREFIX_RE = /^(一)(斤半)(\S*)$/;

function parseSpecialQuantity(text: string): { quantity: number; unit: string; suffix: string } | null {
  // 先检查「一斤半+食材」格式
  {
    const m = text.match(ONE_HALF_PREFIX_RE);
    if (m) return { quantity: 1.5, unit: '斤', suffix: m[3] };
  }
  {
    const m = text.match(HALF_KILO_RE);
    if (m) return { quantity: 0.5, unit: m[2], suffix: '' };
  }
  {
    const m = text.match(ONE_HALF_RE);
    if (m) return { quantity: 1.5, unit: '斤', suffix: '' };
  }
  return null;
}

/** 匹配：中文数字+单位+余下食材名 */
const CN_QTY_RE = /^([零一二两三四五六七八九十百千万半]+)(斤半?|克|千克|公斤|两|个|只|根|颗|把|袋|盒|瓶|包|份|条|块|片|碗|盘|串|升|毫升)(\S*)$/;

function parseChineseQuantity(text: string): { quantity: number; unit: string; suffix: string } | null {
  const m = text.match(CN_QTY_RE);
  if (!m) return null;

  const qty = parseChineseNumber(m[1]);
  if (qty === null) return null;

  return { quantity: qty, unit: m[2], suffix: m[3] || '' };
}

/** 匹配：纯数字+单位+余下食材名 */
const ARABIC_QTY_RE = /^(\d+(?:\.\d+)?)\s*(克|千克|公斤|kg|斤|两|个|只|根|颗|把|袋|盒|瓶|包|份|条|块|片|碗|盘|串|升|毫升|ml|L)(\S*)$/i;

function parseArabicQuantity(text: string): { quantity: number; unit: string; suffix: string } | null {
  const m = text.match(ARABIC_QTY_RE);
  if (!m) return null;

  const qty = parseArabicNumber(m[1]);
  if (qty === null) return null;

  return { quantity: qty, unit: m[2], suffix: m[3] || '' };
}

/**
 * 从文本中尝试提取 数量 + 单位。
 * 返回数量、单位和剩余未匹配的文本。
 */
function extractQuantity(text: string): {
  quantity: number | null;
  unit: string | null;
  remaining: string;
} {
  if (!text) return { quantity: null, unit: null, remaining: '' };

  // 1. 特殊复合：半斤、一斤半
  {
    const r = parseSpecialQuantity(text);
    if (r) return { quantity: r.quantity, unit: r.unit, remaining: r.suffix };
  }

  // 2. 中文数字 + 单位
  {
    const r = parseChineseQuantity(text);
    if (r) return { quantity: r.quantity, unit: r.unit, remaining: r.suffix };
  }

  // 3. 阿拉伯数字 + 单位
  {
    const r = parseArabicQuantity(text);
    if (r) return { quantity: r.quantity, unit: r.unit, remaining: r.suffix };
  }

  // 4. 「食材名+数量+单位」在尾（"鸡蛋六个"、"土豆3个"、"白菜五百克"）
  {
    const suffixMatch = text.match(/(.+?)([零一二两三四五六七八九十百千万半]+)(个|只|根|颗|把|袋|盒|瓶|包|份|条|块|片|碗|盘|串|斤|两|克|千克)$/);
    if (suffixMatch) {
      const qty = parseChineseNumber(suffixMatch[2]);
      if (qty !== null) {
        return { quantity: qty, unit: suffixMatch[3], remaining: suffixMatch[1].trim() };
      }
    }
  }
  {
    const suffixMatch = text.match(/(.+?)(\d+(?:\.\d+)?)\s*(个|只|根|颗|把|袋|盒|瓶|包|份|条|块|片|碗|盘|串|斤|两|克|千克)$/);
    if (suffixMatch) {
      const qty = parseArabicNumber(suffixMatch[2]);
      if (qty !== null) {
        return { quantity: qty, unit: suffixMatch[3], remaining: suffixMatch[1].trim() };
      }
    }
  }

  return { quantity: null, unit: null, remaining: text };
}

/** 分隔符：顿号、逗号、空格、"和"、"还有"、"以及"、"再"、"然后"、"接着"、"一个"的位置 */
const SPLIT_RE = /[、,，\s]+|和|还有|以及|再买?|然后|接着|再加上?/g;

/** 前缀清理：去掉"我买了"、"家里有"等口语前缀 */
const PREFIX_CLEAN_RE = /^(我(?:买了?|有|想买)|今天(?:买了?)?|已经?|买了?|家里有|买点)\s*/;

/**
 * 从语音识别文本中提取食材列表。
 *
 * 策略：
 *   1. 清理口语前缀
 *   2. 按分隔符拆分为多个片段
 *   3. 每个片段尝试提取数量+单位+名称
 *   4. 无法拆分的整体处理
 */
export function parseVoiceText(raw: string): VoiceParseItem[] {
  // 清理
  let text = raw
    .replace(PREFIX_CLEAN_RE, '')
    .replace(/。/g, '、')  // 句号也当作分隔
    .replace(/！/g, '')
    .replace(/？/g, '')
    .trim();

  if (!text) return [];

  // 按分隔符拆分
  const parts = text.split(SPLIT_RE).map((s) => s.trim()).filter(Boolean);

  // 单条：直接解析
  if (parts.length <= 1) {
    const item = parseSingleItem(text, 0, text.length);
    return item ? [item] : [];
  }

  // 多条：逐条解析
  let pos = 0;
  const results: VoiceParseItem[] = [];
  for (const part of parts) {
    const idx = text.indexOf(part, pos);
    const start = idx >= 0 ? idx : pos;
    const end = start + part.length;
    pos = end;

    const item = parseSingleItem(part, start, end);
    if (item) results.push(item);
  }

  return results;
}

function parseSingleItem(text: string, start: number, end: number): VoiceParseItem | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const { quantity, unit, remaining } = extractQuantity(trimmed);

  // remaining 是去掉数量+单位后的部分 → 食材名
  let name = remaining.trim() || trimmed.trim();

  // 纯数字不是食材名
  if (/^\d+(\.\d+)?$/.test(name)) return null;
  // 纯中文数字也不是食材名
  if (/^[零一二两三四五六七八九十百千万半]+$/.test(name)) return null;

  // 完全没有识别到有效信息
  if (quantity === null && unit === null && !name) return null;

  return { name, quantity, unit, start, end };
}

/**
 * 找出与 parsed item 最匹配的单位选项。
 * @param parsedUnit 识别出的单位
 * @param availableUnits 表单可用的单位列表
 * @returns 匹配到的单位索引，未匹配时返回 0
 */
export function matchUnit(parsedUnit: string | null, availableUnits: readonly string[]): number {
  if (!parsedUnit) return 0;

  const normalized = parsedUnit.toLowerCase();
  const directIdx = availableUnits.findIndex(
    (u) => u.toLowerCase() === normalized,
  );
  if (directIdx >= 0) return directIdx;

  // 别名映射
  const ALIASES: Record<string, string> = {
    '公斤': 'kg',
    '千克': 'kg',
    '两': 'g',
    '升': 'L',
    '毫升': 'ml',
    'ml': 'ml',
    'l': 'L',
    '只': '个',
    '根': '个',
    '颗': '个',
    '条': '个',
    '块': '个',
    '片': '个',
    '碗': '份',
    '盘': '份',
    '串': '份',
  };
  const mapped = ALIASES[parsedUnit] || ALIASES[normalized];
  if (mapped) {
    const aliasIdx = availableUnits.findIndex(
      (u) => u.toLowerCase() === mapped.toLowerCase(),
    );
    if (aliasIdx >= 0) return aliasIdx;
  }

  return 0;
}