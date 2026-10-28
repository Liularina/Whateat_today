/**
 * 饭后评价与掌勺人成长核心逻辑（阶段二）
 *
 * 只放纯函数，便于用 tools/mock-cloud.js 直接验证：
 *   - 菜品快照 / 评价对象固化
 *   - 1—5 星评分的规范化、合并与汇总
 *   - 掌勺人积分规则（基础分 + 评分奖励）
 *   - 厨师等级门槛计算
 *
 * 约定：
 *   - 未评分的菜不参与平均分，也不默认 0 分或 3 分；
 *   - 一道菜的评分以 recipeId 关联，名称只作为快照展示；
 *   - 只统计有效成员的有效 1—5 星评分。
 */

const RATING_MIN = 1;
const RATING_MAX = 5;
const COMMENT_MAX_LENGTH = 50;
const MAX_DISHES_PER_SUBMIT = 30;

/** 本餐首次完成的基础积分 */
const BASE_POINTS = 10;
/** 评分奖励：平均分 × 2，四舍五入，最高 10 分 */
const POINTS_PER_STAR = 2;
const RATING_BONUS_MAX = 10;

/** 厨师等级门槛（累计有效积分） */
const LEVELS = [
  { level: 1, name: '初级厨师', minPoints: 0 },
  { level: 2, name: '家常好手', minPoints: 50 },
  { level: 3, name: '家庭大厨', minPoints: 150 },
  { level: 4, name: '星级掌勺人', minPoints: 350 },
  { level: 5, name: '米其林主厨', minPoints: 700 },
];

/** 四舍五入到 1 位小数，避免浮点尾数 */
function round1(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

/**
 * 由累计积分计算等级。
 * 等级只由服务端计算，前端传入的等级一律忽略。
 */
function resolveLevel(points) {
  const total = Math.max(0, Math.floor(Number(points) || 0));
  let current = LEVELS[0];
  for (const item of LEVELS) {
    if (total >= item.minPoints) current = item;
  }
  const next = LEVELS.find((item) => item.minPoints > total) || null;

  return {
    points: total,
    level: current.level,
    levelName: current.name,
    levelMinPoints: current.minPoints,
    nextLevel: next ? next.level : 0,
    nextLevelName: next ? next.name : '',
    nextMinPoints: next ? next.minPoints : 0,
    pointsToNext: next ? next.minPoints - total : 0,
    maxLevel: !next,
  };
}

/** 评分的文字含义（仅用于展示提示，不参与计算） */
function ratingLabel(stars) {
  const map = {
    1: '不喜欢',
    2: '一般偏差',
    3: '还不错',
    4: '很好吃',
    5: '非常好吃',
  };
  return map[stars] || '';
}

/** 评语规范化：可选，去首尾空白，超长截断，非字符串视为空 */
function normalizeComment(value) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, COMMENT_MAX_LENGTH);
}

function normalizeStars(value) {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(num) || num < RATING_MIN || num > RATING_MAX) return 0;
  return num;
}

/**
 * 规范化评分入参：[{recipeId, stars, comment}]。
 *
 * - recipeId 必须属于本次用餐的菜品快照，避免给「没做的菜」打分；
 * - 同一 recipeId 只保留最后一条，前端重复提交不会写出多条；
 * - stars 必须是 1—5 的整数，缺省或越界直接报错，不做默认补分。
 *
 * @param {Array} input
 * @param {string[]} allowedRecipeIds 本次用餐快照里的菜品 ID
 * @returns {{value:Array}|{error:string}}
 */
function normalizeRatings(input, allowedRecipeIds) {
  if (!Array.isArray(input) || input.length === 0) {
    return { error: '请至少给一道菜评分' };
  }
  if (input.length > MAX_DISHES_PER_SUBMIT) {
    return { error: '一次最多评价 ' + MAX_DISHES_PER_SUBMIT + ' 道菜' };
  }

  const allowed = {};
  for (const id of allowedRecipeIds || []) {
    if (id) allowed[id] = true;
  }

  const merged = {};
  const order = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') {
      return { error: '评分数据格式不正确' };
    }
    const recipeId = typeof item.recipeId === 'string' ? item.recipeId.trim() : '';
    if (!recipeId) return { error: '缺少 recipeId' };
    if (!allowed[recipeId]) {
      return { error: '这道菜不属于本次用餐：' + recipeId };
    }
    const stars = normalizeStars(item.stars);
    if (!stars) {
      return { error: '评分只能是 1—5 星：' + recipeId };
    }
    if (!merged[recipeId]) order.push(recipeId);
    merged[recipeId] = {
      recipeId: recipeId,
      stars: stars,
      comment: normalizeComment(item.comment),
    };
  }

  return { value: order.map((id) => merged[id]) };
}

/**
 * 合并评分：同一道菜更新为最新评分，不在列表里的菜保持原样。
 * 用于「成员修改自己的评分」，避免重复创建有效记录。
 */
function mergeRatings(existing, incoming) {
  const merged = {};
  const order = [];

  for (const item of existing || []) {
    if (!item || !item.recipeId) continue;
    if (!merged[item.recipeId]) order.push(item.recipeId);
    merged[item.recipeId] = {
      recipeId: item.recipeId,
      stars: normalizeStars(item.stars) || item.stars,
      comment: normalizeComment(item.comment),
    };
  }

  for (const item of incoming || []) {
    if (!item || !item.recipeId) continue;
    if (!merged[item.recipeId]) order.push(item.recipeId);
    merged[item.recipeId] = {
      recipeId: item.recipeId,
      stars: normalizeStars(item.stars) || item.stars,
      comment: normalizeComment(item.comment),
    };
  }

  return order.map((id) => merged[id]);
}

/**
 * 用餐菜品快照：固定 recipeId 与当时的菜名。
 * 完成后写入 menus.snapshotItems，之后任何菜单改动都不会改变评价对象。
 */
function buildDishSnapshot(menu) {
  if (!menu || !Array.isArray(menu.items)) return [];
  const seen = {};
  const snapshot = [];
  for (let index = 0; index < menu.items.length; index += 1) {
    const item = menu.items[index];
    if (!item || !item.recipeId || seen[item.recipeId]) continue;
    seen[item.recipeId] = true;
    snapshot.push({
      recipeId: item.recipeId,
      name: item.name || '',
      category: item.category || '',
      position: typeof item.position === 'number' ? item.position : index,
    });
  }
  return snapshot;
}

/** 取本次用餐的菜品快照：优先用完成时固化的，缺失时按当前菜品重建（旧数据兼容） */
function resolveDishSnapshot(menu) {
  if (menu && Array.isArray(menu.snapshotItems) && menu.snapshotItems.length > 0) {
    return menu.snapshotItems
      .filter((item) => item && item.recipeId)
      .map((item, index) => ({
        recipeId: item.recipeId,
        name: item.name || '',
        category: item.category || '',
        position: typeof item.position === 'number' ? item.position : index,
      }));
  }
  return buildDishSnapshot(menu);
}

/**
 * 汇总某餐的评价。
 *
 * @param {object} args
 *   snapshot —— 菜品快照（resolveDishSnapshot 的结果）
 *   reviews  —— meal_reviews 记录（每位成员一条）
 *   members  —— [{userId, nickname}]
 *   viewerId —— 当前查看者 userId
 * @returns 每道菜的有效评分人数、平均分、我的评分、评语，以及整体平均分
 */
function summarizeReviews(args) {
  const snapshot = (args && args.snapshot) || [];
  const reviews = (args && args.reviews) || [];
  const members = (args && args.members) || [];
  const viewerId = (args && args.viewerId) || '';

  const nicknameMap = {};
  for (const member of members) {
    nicknameMap[member.userId] = member.nickname || '家人';
  }
  const memberIds = {};
  for (const member of members) memberIds[member.userId] = true;

  const dishMap = {};
  const dishes = [];
  for (const item of snapshot) {
    if (!item || !item.recipeId || dishMap[item.recipeId]) continue;
    const view = {
      recipeId: item.recipeId,
      name: item.name || '',
      category: item.category || '',
      ratedCount: 0,
      average: null,
      myStars: 0,
      myComment: '',
      comments: [],
    };
    dishMap[item.recipeId] = view;
    dishes.push(view);
  }

  let starTotal = 0;
  let ratingCount = 0;
  let raterCount = 0;
  const ratedMembers = {};

  for (const review of reviews) {
    if (!review || !review.userId) continue;
    // 退群成员的历史评分不再计入有效汇总（记录本身保留）
    if (Object.keys(memberIds).length > 0 && !memberIds[review.userId]) continue;

    const userId = review.userId;
    const nickname = nicknameMap[userId] || review.nickname || '家人';
    let hasValid = false;

    for (const rating of review.ratings || []) {
      if (!rating || !rating.recipeId) continue;
      const dish = dishMap[rating.recipeId];
      if (!dish) continue;
      const stars = normalizeStars(rating.stars);
      if (!stars) continue;

      hasValid = true;
      dish.ratedCount += 1;
      dish.comments.push({
        userId: userId,
        nickname: nickname,
        stars: stars,
        comment: normalizeComment(rating.comment),
      });
      starTotal += stars;
      ratingCount += 1;

      if (userId === viewerId) {
        dish.myStars = stars;
        dish.myComment = normalizeComment(rating.comment);
      }
    }

    if (hasValid) {
      raterCount += 1;
      ratedMembers[userId] = true;
    }
  }

  let ratedDishCount = 0;
  let myRatedDishCount = 0;
  for (const dish of dishes) {
    // 每道菜的平均分只用该菜的有效评分计算，保留 1 位小数
    if (dish.ratedCount > 0) {
      const total = dish.comments.reduce((sum, item) => sum + item.stars, 0);
      dish.average = round1(total / dish.ratedCount);
      ratedDishCount += 1;
    }
    if (dish.myStars > 0) myRatedDishCount += 1;
  }

  return {
    dishes: dishes,
    totalDishCount: dishes.length,
    ratedDishCount: ratedDishCount,
    myRatedDishCount: myRatedDishCount,
    ratingCount: ratingCount,
    // 没有任何有效评分时为 null，前端显示「暂无评分」，避免除零
    overallAverage: ratingCount > 0 ? round1(starTotal / ratingCount) : null,
    raterCount: raterCount,
    memberCount: members.length,
    missingMembers: members
      .filter((member) => member && member.userId && !ratedMembers[member.userId])
      .map((member) => member.nickname || '家人'),
    iHaveRated: myRatedDishCount > 0,
  };
}

/**
 * 评分奖励积分：按本餐所有有效菜品评分的整体平均分计算。
 * 平均分 1 → 2 分，5 → 10 分；没有评分时返回 0（只能拿基础分）。
 */
function computeRatingBonus(average) {
  if (average === null || average === undefined || !Number.isFinite(Number(average))) return 0;
  const value = Math.round(Number(average) * POINTS_PER_STAR);
  if (value < 0) return 0;
  return Math.min(value, RATING_BONUS_MAX);
}

/** 积分流水固定 ID：同一餐同一类型只可能有一条，天然防重复发放 */
function pointsDocId(menuId, type) {
  return 'pt_' + menuId + '_' + type;
}

/** 每位成员在一餐里的评价记录固定 ID：天然「一人一餐一条」 */
function reviewDocId(menuId, userId) {
  return 'rv_' + menuId + '_' + userId;
}

module.exports = {
  RATING_MIN,
  RATING_MAX,
  COMMENT_MAX_LENGTH,
  BASE_POINTS,
  POINTS_PER_STAR,
  RATING_BONUS_MAX,
  LEVELS,
  round1,
  resolveLevel,
  ratingLabel,
  normalizeComment,
  normalizeStars,
  normalizeRatings,
  mergeRatings,
  buildDishSnapshot,
  resolveDishSnapshot,
  summarizeReviews,
  computeRatingBonus,
  pointsDocId,
  reviewDocId,
};
