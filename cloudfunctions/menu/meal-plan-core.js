/**
 * 餐次协作核心逻辑（Phase 1：角色协作 + 多方案点单闭环）
 *
 * 只放纯函数，便于在本地用 tools/mock-cloud.js 直接验证：
 *   - 北京时间自然日
 *   - 方案 / 菜品偏好的规范化和汇总
 *   - 掌勺人判定
 *   - 从推荐方案生成最终菜单快照
 *
 * 约定：
 *   - 偏好只以「有效成员 + 有效记录」计算，未参与成员不计入任何一方；
 *   - 掌勺人判定只认 plan.cookId，与家庭 owner 身份无关（管理员 ≠ 掌勺人）。
 */

const CN_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 菜品建议取值 */
const DISH_VOTES = ['want', 'avoid', 'none'];

const NOTE_MAX_LENGTH = 50;
const DISH_VOTES_MAX = 30;

/** 北京时间的自然日，格式 YYYY-MM-DD（与历史菜单、临期计算口径一致） */
function beijingDateString(input) {
  const base = input ? new Date(input) : new Date();
  const shifted = new Date(base.getTime() + CN_OFFSET_MS);
  return shifted.toISOString().slice(0, 10);
}

/** 菜单状态：只有 open 的方案可以被继续选择 / 确认 */
function isPlanOpen(plan) {
  return !!plan && plan.status === 'open';
}

/**
 * 是否为本餐次掌勺人。
 * owner 身份不参与判断：方案没有 cookId 时一律不授予确认权。
 */
function isMealCook(plan, userId) {
  return !!plan && !!userId && plan.cookId === userId;
}

/**
 * 规范化菜品偏好入参：[{recipeId, vote}]。
 * 同一 recipeId 只保留最后一条，避免前端重复提交刷数据。
 */
function normalizeDishVotes(list) {
  if (list === undefined || list === null) return { value: [] };
  if (!Array.isArray(list)) return { error: 'dishVotes 必须是数组' };
  if (list.length > DISH_VOTES_MAX) {
    return { error: '菜品偏好最多 ' + DISH_VOTES_MAX + ' 条' };
  }

  const map = {};
  for (const item of list) {
    if (!item || typeof item !== 'object') return { error: '菜品偏好格式不正确' };
    const recipeId = typeof item.recipeId === 'string' ? item.recipeId.trim() : '';
    const vote = typeof item.vote === 'string' ? item.vote : '';
    if (!recipeId) return { error: '菜品偏好缺少 recipeId' };
    if (DISH_VOTES.indexOf(vote) === -1) {
      return { error: '菜品偏好只能取 want / avoid / none' };
    }
    map[recipeId] = vote;
  }

  return {
    value: Object.keys(map).map((recipeId) => ({ recipeId: recipeId, vote: map[recipeId] })),
  };
}

/** 规范化留言：去首尾空白并限长；空串表示不留言 */
function normalizeNote(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, NOTE_MAX_LENGTH);
}

/**
 * 汇总家人对「掌勺人已保存的点单」的菜品建议。
 *
 * 只统计菜品层面的「想吃 / 不想吃」：最终菜单由掌勺人锁定，
 * 家人的意见只作为参考，所以这里不做任何方案级投票统计。
 *
 * @param {object} args
 *   menuItems   —— 草稿菜单的 items（[{recipeId, name}]）
 *   preferences —— meal_preferences 记录（同一成员同餐次只有一条）
 *   members     —— [{userId, nickname}]
 *   viewerId    —— 当前查看者 userId
 *   familyId    —— 家庭 ID
 * @returns {{dishes:Array, participantCount:number, memberCount:number,
 *            totalMembers:number, missingMembers:Array, my:object|null}}
 */
function summarizePreferences(args) {
  const menuItems = Array.isArray(args.menuItems) ? args.menuItems : [];
  const preferences = Array.isArray(args.preferences) ? args.preferences : [];
  const members = Array.isArray(args.members) ? args.members : [];

  const memberMap = {};
  for (const member of members) {
    memberMap[member.userId] = member.nickname || '家人';
  }

  // 只统计「仍属于当前家庭」的成员记录，退群成员的旧偏好不计入
  const familyPreferences = preferences.filter((item) => {
    return item && item.familyId === args.familyId && memberMap[item.userId];
  });

  // 同一成员理论上只有一条记录；并发写入可能留下重复，
  // 按 updatedAt 取最新一条，避免同一个人被算两次。
  const latestByUser = {};
  for (const pref of familyPreferences) {
    const prev = latestByUser[pref.userId];
    if (!prev || String(pref.updatedAt || '') >= String(prev.updatedAt || '')) {
      latestByUser[pref.userId] = pref;
    }
  }
  const validPreferences = Object.keys(latestByUser).map((key) => latestByUser[key]);

  // 建议只对「草稿菜单里真实存在的菜」有效：
  // 掌勺人换过菜之后，旧建议不能凭空出现在新菜单上。
  const dishStats = {};
  for (const item of menuItems) {
    const recipeId = item && (item.recipeId || item._id);
    if (!recipeId || dishStats[recipeId]) continue;
    dishStats[recipeId] = {
      recipeId: recipeId,
      name: item.name || '',
      wantCount: 0,
      avoidCount: 0,
      wantBy: [],
      avoidBy: [],
    };
  }

  let participantCount = 0;
  let my = null;
  const votedUserIds = {};

  for (const pref of validPreferences) {
    const nickname = memberMap[pref.userId];
    const hasDishVote = Array.isArray(pref.dishVotes) && pref.dishVotes.length > 0;
    if (hasDishVote) {
      participantCount += 1;
      votedUserIds[pref.userId] = true;
    }

    if (pref.userId === args.viewerId) {
      my = {
        dishVotes: Array.isArray(pref.dishVotes) ? pref.dishVotes.slice() : [],
        note: pref.note || '',
        updatedAt: pref.updatedAt || '',
      };
    }

    for (const vote of pref.dishVotes || []) {
      const dish = dishStats[vote.recipeId];
      if (!dish) continue;
      if (vote.vote === 'want') {
        dish.wantCount += 1;
        dish.wantBy.push(nickname);
      } else if (vote.vote === 'avoid') {
        dish.avoidCount += 1;
        dish.avoidBy.push(nickname);
      }
    }
  }

  const myVoteMap = {};
  if (my) {
    for (const vote of my.dishVotes) myVoteMap[vote.recipeId] = vote.vote;
  }

  const missingMembers = members
    .filter((member) => !votedUserIds[member.userId])
    .map((member) => member.nickname || '家人');

  return {
    dishes: menuItems
      .map((item) => (item && (item.recipeId || item._id)) || '')
      .filter((recipeId) => !!recipeId && dishStats[recipeId])
      .map((recipeId) => {
        const stat = dishStats[recipeId];
        return {
          recipeId: stat.recipeId,
          name: stat.name,
          wantCount: stat.wantCount,
          avoidCount: stat.avoidCount,
          wantBy: stat.wantBy,
          avoidBy: stat.avoidBy,
          myVote: myVoteMap[recipeId] || 'none',
        };
      }),
    participantCount: participantCount,
    memberCount: members.length,
    totalMembers: members.length,
    missingMembers: missingMembers,
    my: my,
  };
}

module.exports = {
  DISH_VOTES,
  NOTE_MAX_LENGTH,
  beijingDateString,
  isPlanOpen,
  isMealCook,
  normalizeDishVotes,
  normalizeNote,
  summarizePreferences,
};
