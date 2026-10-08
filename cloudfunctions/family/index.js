/**
 * family 云函数 · 家庭创建 / 加入 / 成员 / 偏好 / 退出 / 移除 / 解散（Phase 3）
 *
 * 职责：
 *   createFamily / getMyFamily / joinFamily / getMembers
 *   updateFamily / leaveFamily / removeMember / dissolveFamily
 *
 * 安全约束：
 *   1. 身份只来自 cloud.getWXContext().OPENID，绝不读取、也绝不信任客户端传入的
 *      openid / ownerId / role / status 等身份与权限字段；
 *   2. 所有涉及 familyId 的操作都必须经 requireFamilyMember 复核，
 *      前端传入的 familyId 只作为「想操作哪个家庭」的意图，绝不作为权限依据；
 *   3. 只允许写白名单字段（name / preferences），其余字段一律忽略；
 *   4. 日志不记录完整邀请码，只记录 inviteCodeUsed 布尔值；
 *   5. LLM API Key 只存在于本云函数的环境变量中，绝不下发到小程序前端。
 *
 * 本阶段刻意不做的事：不调用任何 LLM、不实现食材 / 营养 / 推荐 / 点菜 / 菜单。
 */
const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const usersCol = db.collection('users');
const familiesCol = db.collection('families');
const membersCol = db.collection('family_members');

/** 云数据库「集合不存在」错误码 */
const ERR_COLLECTION_NOT_EXIST = -502005;

const DEFAULT_NICKNAME = '微信用户';

const DB_NOT_READY_MESSAGE =
  '数据库集合 families / family_members 不存在，请先在云开发控制台创建';

/* ------------------------------ 业务约束 ------------------------------ */
/* 与 miniprogram/constants/config.ts 保持一致，服务端必须独立校验，不能相信前端 */

/** 单个家庭成员人数上限（含 owner） */
const FAMILY_MAX_MEMBERS = 10;
const FAMILY_NAME_MAX_LENGTH = 20;
const FAMILY_TAG_MAX_LENGTH = 20;
const FAMILY_TAG_LIST_MAX_LENGTH = 20;

const INVITE_CODE_LENGTH = 6;
/** 剔除易混淆的 O / 0 / I / 1 */
const INVITE_CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const INVITE_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

const PEOPLE_COUNT_MIN = 1;
const PEOPLE_COUNT_MAX = 6;
const COOK_TIME_OPTIONS = [20, 30, 40, 60, 90];
const TASTE_OPTIONS = ['不限', '清淡', '家常', '偏辣', '重口', '酸甜'];

const DEFAULT_PEOPLE_COUNT = 2;
const DEFAULT_COOK_TIME = 40;
const DEFAULT_TASTE = ['家常'];

/** 邀请码唯一性重试次数 */
const INVITE_CODE_MAX_ATTEMPTS = 10;

/* ------------------------------ 统一响应 ------------------------------ */

function ok(data) {
  return { success: true, data: data === undefined ? null : data, error: null };
}

function fail(code, message, details) {
  return {
    success: false,
    data: null,
    code: code,
    message: message,
    error: { code: code, message: message },
    details: details || null,
  };
}

/* ------------------------------ 基础工具 ------------------------------ */

function isCollectionMissing(error) {
  if (!error) {
    return false;
  }
  if (error.errCode === ERR_COLLECTION_NOT_EXIST) {
    return true;
  }
  const text = String(error.errMsg || error.message || '');
  return /collection.+not exists|集合不存在/i.test(text);
}

function toIsoString(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    return value;
  }
  return '';
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function randomIndex(max) {
  if (typeof crypto.randomInt === 'function') {
    return crypto.randomInt(0, max);
  }
  return Math.floor(Math.random() * max);
}

function randomInviteCode() {
  let code = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) {
    code += INVITE_CODE_CHARSET.charAt(randomIndex(INVITE_CODE_CHARSET.length));
  }
  return code;
}

/* ------------------------------ 查询工具 ------------------------------ */

async function findUserByOpenid(openid) {
  const res = await usersCol.where({ openid: openid }).orderBy('createdAt', 'asc').limit(1).get();
  return (res.data && res.data[0]) || null;
}

/** 查询用户当前所属的成员关系（一个用户同时只允许属于一个家庭） */
async function findMembershipByUserId(userId) {
  const res = await membersCol
    .where({ userId: userId })
    .orderBy('createdAt', 'asc')
    .limit(1)
    .get();
  return (res.data && res.data[0]) || null;
}

async function findFamilyById(familyId) {
  if (!familyId) {
    return null;
  }
  try {
    const res = await familiesCol.doc(familyId).get();
    return res.data || null;
  } catch (error) {
    // 文档不存在时按「查不到」处理，不向调用方抛出
    return null;
  }
}

async function countMembers(familyId) {
  const res = await membersCol.where({ familyId: familyId }).count();
  return res.total || 0;
}

/**
 * 生成唯一邀请码：生成 → 查库 → 重复则重新生成。
 * 绝不使用固定邀请码。
 */
async function generateUniqueInviteCode() {
  for (let i = 0; i < INVITE_CODE_MAX_ATTEMPTS; i += 1) {
    const code = randomInviteCode();
    const res = await familiesCol.where({ inviteCode: code }).limit(1).get();
    if (!res.data || res.data.length === 0) {
      return code;
    }
  }
  return null;
}

/* ------------------------------ DTO 拼装 ------------------------------ */

function toFamilyDTO(family, memberCount) {
  return {
    _id: family._id,
    name: family.name,
    ownerId: family.ownerId,
    inviteCode: family.inviteCode,
    preferences: {
      defaultPeopleCount: family.preferences.defaultPeopleCount,
      taste: (family.preferences.taste || []).slice(),
      avoidIngredients: (family.preferences.avoidIngredients || []).slice(),
      allergens: (family.preferences.allergens || []).slice(),
      defaultCookTime: family.preferences.defaultCookTime,
    },
    status: family.status,
    memberCount: memberCount,
    createdAt: toIsoString(family.createdAt),
    updatedAt: toIsoString(family.updatedAt),
  };
}

/**
 * 成员列表：family_members → userId → 回查 users，拼装成 Member DTO。
 * 页面永远拿不到 userId 之外的原始成员记录，也不需要自己去查用户表；
 * nickname 为空时统一兜底为「微信用户」，绝不显示 openid。
 */
async function buildMemberDTOs(familyId) {
  const res = await membersCol
    .where({ familyId: familyId })
    .orderBy('joinedAt', 'asc')
    .limit(FAMILY_MAX_MEMBERS)
    .get();

  const memberships = res.data || [];
  if (memberships.length === 0) {
    return [];
  }

  const userIds = memberships.map((item) => item.userId);
  const usersRes = await usersCol.where({ _id: _.in(userIds) }).get();
  const userMap = {};
  for (const user of usersRes.data || []) {
    userMap[user._id] = user;
  }

  return memberships.map((item) => {
    const user = userMap[item.userId];
    return {
      userId: item.userId,
      nickname: (user && user.nickname) || DEFAULT_NICKNAME,
      avatarUrl: (user && user.avatarUrl) || '',
      role: item.role === 'owner' ? 'owner' : 'member',
      joinedAt: toIsoString(item.joinedAt),
    };
  });
}

/* ------------------------------ 权限工具 ------------------------------ */
/* Phase 4 起的食材 / 推荐 / 点菜 / 菜单都必须复用这两个函数 */

/**
 * 家庭身份校验：绝不直接信任前端传来的 familyId。
 *
 *   openid → users → family_members → families
 *
 * familyId 缺省时按当前用户所属家庭解析；
 * 传入 familyId 但与当前用户的成员关系不匹配时，返回 PERMISSION_DENIED，
 * 且不区分「家庭不存在」与「不是该家庭成员」，避免泄露其他家庭是否存在。
 *
 * logContext 会在校验过程中尽早写入已解析出的 userId / familyId：
 * 越权请求正是最需要审计的场景，失败路径也必须留下可追溯的日志。
 */
async function requireFamilyMember(openid, familyId, logContext) {
  if (!openid) {
    return { error: fail('AUTH_REQUIRED', '无法获取微信用户身份，请重新进入小程序') };
  }

  const user = await findUserByOpenid(openid);
  if (!user) {
    return { error: fail('UNAUTHORIZED', '用户不存在，请先登录') };
  }
  if (logContext) {
    logContext.userId = user._id;
  }

  const requestedFamilyId = normalizeText(familyId);

  if (!requestedFamilyId) {
    const membership = await findMembershipByUserId(user._id);
    if (!membership) {
      return { error: fail('NOT_IN_FAMILY', '你还没有加入家庭') };
    }
    if (logContext) {
      logContext.familyId = membership.familyId;
    }

    const family = await findFamilyById(membership.familyId);
    if (!family) {
      return { error: fail('FAMILY_NOT_FOUND', '家庭不存在') };
    }
    if (family.status !== 'active') {
      return { error: fail('FAMILY_NOT_ACTIVE', '该家庭已不可用') };
    }

    return { user: user, family: family, membership: membership };
  }

  // 先记录「想操作哪个家庭」，越权时日志里才有可追溯的目标
  if (logContext) {
    logContext.familyId = requestedFamilyId;
  }

  const res = await membersCol
    .where({ familyId: requestedFamilyId, userId: user._id })
    .limit(1)
    .get();
  const membership = (res.data && res.data[0]) || null;

  if (!membership) {
    return { error: fail('PERMISSION_DENIED', '你没有权限访问该家庭') };
  }

  const family = await findFamilyById(requestedFamilyId);
  if (!family) {
    return { error: fail('FAMILY_NOT_FOUND', '家庭不存在') };
  }
  if (family.status !== 'active') {
    return { error: fail('FAMILY_NOT_ACTIVE', '该家庭已不可用') };
  }

  return { user: user, family: family, membership: membership };
}

/** 仅家庭管理员可执行 */
function requireOwner(membership) {
  if (!membership || membership.role !== 'owner') {
    return fail('PERMISSION_DENIED', '只有家庭管理员可以执行该操作');
  }
  return null;
}

/* ------------------------------ 入参校验 ------------------------------ */

function validateFamilyName(raw) {
  const name = normalizeText(raw);
  if (!name) {
    return { error: fail('INVALID_PARAMS', '请填写家庭名称') };
  }
  if (name.length > FAMILY_NAME_MAX_LENGTH) {
    return { error: fail('INVALID_PARAMS', '家庭名称不能超过 ' + FAMILY_NAME_MAX_LENGTH + ' 个字') };
  }
  return { value: name };
}

function normalizePeopleCount(raw) {
  if (raw === undefined || raw === null) {
    return { value: undefined };
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < PEOPLE_COUNT_MIN || value > PEOPLE_COUNT_MAX) {
    return { error: fail('INVALID_PARAMS', '默认人数需要是 1~6 之间的整数') };
  }
  return { value: value };
}

function normalizeCookTime(raw) {
  if (raw === undefined || raw === null) {
    return { value: undefined };
  }
  const value = Number(raw);
  if (COOK_TIME_OPTIONS.indexOf(value) === -1) {
    return { error: fail('INVALID_PARAMS', '默认烹饪时间取值不合法') };
  }
  return { value: value };
}

function normalizeTasteList(raw) {
  if (raw === undefined || raw === null) {
    return { value: undefined };
  }
  if (!Array.isArray(raw)) {
    return { error: fail('INVALID_PARAMS', '口味格式不正确') };
  }
  const result = [];
  for (const item of raw) {
    const text = normalizeText(item);
    if (!text) {
      continue;
    }
    if (TASTE_OPTIONS.indexOf(text) === -1) {
      return { error: fail('INVALID_PARAMS', '口味取值不合法') };
    }
    if (result.indexOf(text) === -1) {
      result.push(text);
    }
  }
  return { value: result };
}

/** 忌口 / 过敏：允许自定义添加，但限制单项长度与数量，并去重 */
function normalizeTagList(raw, label) {
  if (raw === undefined || raw === null) {
    return { value: undefined };
  }
  if (!Array.isArray(raw)) {
    return { error: fail('INVALID_PARAMS', label + '格式不正确') };
  }
  if (raw.length > FAMILY_TAG_LIST_MAX_LENGTH) {
    return { error: fail('INVALID_PARAMS', label + '最多 ' + FAMILY_TAG_LIST_MAX_LENGTH + ' 项') };
  }

  const result = [];
  for (const item of raw) {
    const text = normalizeText(item);
    if (!text) {
      continue;
    }
    if (text.length > FAMILY_TAG_MAX_LENGTH) {
      return { error: fail('INVALID_PARAMS', label + '单项不能超过 ' + FAMILY_TAG_MAX_LENGTH + ' 个字') };
    }
    if (result.indexOf(text) === -1) {
      result.push(text);
    }
  }
  return { value: result };
}

function defaultPreferences() {
  return {
    defaultPeopleCount: DEFAULT_PEOPLE_COUNT,
    taste: DEFAULT_TASTE.slice(),
    avoidIngredients: [],
    allergens: [],
    defaultCookTime: DEFAULT_COOK_TIME,
  };
}

/**
 * 拼装并校验偏好。
 * base 为已有的合法偏好（更新场景），未提交的字段沿用 base；
 * 返回对象显式构造，客户端多传的字段一律不会落库。
 */
function buildPreferences(raw, base) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const fallback = base || defaultPreferences();

  const people = normalizePeopleCount(source.defaultPeopleCount);
  if (people.error) {
    return people;
  }
  const cookTime = normalizeCookTime(source.defaultCookTime);
  if (cookTime.error) {
    return cookTime;
  }
  const taste = normalizeTasteList(source.taste);
  if (taste.error) {
    return taste;
  }
  const avoid = normalizeTagList(source.avoidIngredients, '忌口');
  if (avoid.error) {
    return avoid;
  }
  const allergens = normalizeTagList(source.allergens, '过敏');
  if (allergens.error) {
    return allergens;
  }

  return {
    value: {
      defaultPeopleCount:
        people.value === undefined ? fallback.defaultPeopleCount : people.value,
      taste: taste.value === undefined ? fallback.taste.slice() : taste.value,
      avoidIngredients:
        avoid.value === undefined ? fallback.avoidIngredients.slice() : avoid.value,
      allergens: allergens.value === undefined ? fallback.allergens.slice() : allergens.value,
      defaultCookTime: cookTime.value === undefined ? fallback.defaultCookTime : cookTime.value,
    },
  };
}

/* ------------------------------ 业务实现 ------------------------------ */

/**
 * 创建家庭。
 * 创建者成为 owner；ownerId 由当前登录身份决定，客户端提交的 ownerId 一律忽略。
 * 一致性：families 与 family_members 分两步写入，
 * 第二步失败时补偿删除刚建的 family，避免出现「有家庭但没有 owner」。
 */
async function handleCreateFamily(event, wxContext, requestId, logContext) {
  const openid = wxContext.OPENID;
  if (!openid) {
    return fail('AUTH_REQUIRED', '无法获取微信用户身份，请重新进入小程序');
  }

  const user = await findUserByOpenid(openid);
  if (!user) {
    return fail('UNAUTHORIZED', '用户不存在，请先登录');
  }
  logContext.userId = user._id;

  // 一个用户同时只允许属于一个家庭
  const existing = await findMembershipByUserId(user._id);
  if (existing) {
    return fail('ALREADY_IN_FAMILY', '你已经加入一个家庭，请先退出当前家庭，再加入其他家庭。');
  }

  const nameResult = validateFamilyName(event.name);
  if (nameResult.error) {
    return nameResult.error;
  }

  const preferencesResult = buildPreferences(event.preferences, null);
  if (preferencesResult.error) {
    return preferencesResult.error;
  }

  const inviteCode = await generateUniqueInviteCode();
  if (!inviteCode) {
    return fail('INVITE_CODE_GENERATE_FAILED', '邀请码生成失败，请稍后重试');
  }

  const now = new Date();
  const familyDoc = {
    name: nameResult.value,
    ownerId: user._id,
    inviteCode: inviteCode,
    preferences: preferencesResult.value,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };

  let familyId;
  try {
    const added = await familiesCol.add({ data: familyDoc });
    familyId = added._id;
  } catch (error) {
    if (isCollectionMissing(error)) {
      return fail('DB_NOT_READY', DB_NOT_READY_MESSAGE);
    }
    console.error('[family] 创建家庭失败 requestId=' + requestId, error);
    return fail('CREATE_FAMILY_FAILED', '创建家庭失败，请稍后重试');
  }

  try {
    await membersCol.add({
      data: {
        familyId: familyId,
        userId: user._id,
        role: 'owner',
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
  } catch (error) {
    // 补偿删除：宁可没有家庭，也不要留下一个没有管理员的家庭
    try {
      await familiesCol.doc(familyId).remove();
    } catch (cleanupError) {
      console.error('[family] 补偿删除家庭失败 requestId=' + requestId, cleanupError);
    }
    if (isCollectionMissing(error)) {
      return fail('DB_NOT_READY', DB_NOT_READY_MESSAGE);
    }
    console.error('[family] 创建 owner 成员失败 requestId=' + requestId, error);
    return fail('CREATE_FAMILY_FAILED', '创建家庭失败，请稍后重试');
  }

  familyDoc._id = familyId;
  logContext.familyId = familyId;

  return ok(toFamilyDTO(familyDoc, 1));
}

/**
 * 查询当前用户的家庭与成员。
 * 刻意不接受前端传入的 familyId，从当前登录身份反查。
 * 「没有家庭」是正常业务状态，返回 family = null，不作为异常。
 */
async function handleGetMyFamily(event, wxContext, requestId, logContext) {
  const openid = wxContext.OPENID;
  if (!openid) {
    return fail('AUTH_REQUIRED', '无法获取微信用户身份，请重新进入小程序');
  }

  const user = await findUserByOpenid(openid);
  if (!user) {
    return fail('UNAUTHORIZED', '用户不存在，请先登录');
  }
  logContext.userId = user._id;

  const membership = await findMembershipByUserId(user._id);
  if (!membership) {
    return ok({ family: null, members: [], currentMember: null });
  }

  logContext.familyId = membership.familyId;

  const family = await findFamilyById(membership.familyId);
  // 成员关系残留但家庭已不存在 / 已解散：按「没有家庭」返回，不向用户抛错
  if (!family || family.status !== 'active') {
    return ok({ family: null, members: [], currentMember: null });
  }

  const members = await buildMemberDTOs(family._id);
  const currentMember =
    members.filter((item) => item.userId === user._id)[0] || null;

  return ok({
    family: toFamilyDTO(family, members.length),
    members: members,
    currentMember: currentMember,
  });
}

/**
 * 用邀请码加入家庭。
 * 邀请码先 trim + 转大写再校验；写入前完成全部检查，避免重复成员。
 */
async function handleJoinFamily(event, wxContext, requestId, logContext) {
  const openid = wxContext.OPENID;
  if (!openid) {
    return fail('AUTH_REQUIRED', '无法获取微信用户身份，请重新进入小程序');
  }

  const user = await findUserByOpenid(openid);
  if (!user) {
    return fail('UNAUTHORIZED', '用户不存在，请先登录');
  }
  logContext.userId = user._id;

  const rawCode = normalizeText(event.inviteCode).toUpperCase();
  if (!rawCode || !INVITE_CODE_PATTERN.test(rawCode)) {
    return fail('INVITE_CODE_INVALID', '邀请码格式不正确，请输入 6 位邀请码');
  }

  const familyRes = await familiesCol.where({ inviteCode: rawCode }).limit(1).get();
  const family = (familyRes.data && familyRes.data[0]) || null;
  if (!family) {
    return fail('INVITE_CODE_INVALID', '家庭邀请码不存在');
  }
  logContext.familyId = family._id;

  if (family.status !== 'active') {
    return fail('FAMILY_NOT_ACTIVE', '该家庭已不可用');
  }

  // 一个用户同时只允许属于一个家庭
  const existing = await findMembershipByUserId(user._id);
  if (existing) {
    if (existing.familyId === family._id) {
      return fail('ALREADY_MEMBER', '你已经是该家庭成员');
    }
    return fail('ALREADY_IN_FAMILY', '你已经加入一个家庭，请先退出当前家庭，再加入其他家庭。');
  }

  const memberCount = await countMembers(family._id);
  if (memberCount >= FAMILY_MAX_MEMBERS) {
    return fail('FAMILY_FULL', '该家庭成员人数已达到当前版本上限。');
  }

  const now = new Date();
  try {
    await membersCol.add({
      data: {
        familyId: family._id,
        userId: user._id,
        role: 'member',
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
  } catch (error) {
    if (isCollectionMissing(error)) {
      return fail('DB_NOT_READY', DB_NOT_READY_MESSAGE);
    }
    // 并发下可能已被另一次请求创建，回查一次，避免产生重复成员
    console.error('[family] 加入家庭失败 requestId=' + requestId, error);
    const retry = await findMembershipByUserId(user._id);
    if (retry && retry.familyId === family._id) {
      return fail('ALREADY_MEMBER', '你已经是该家庭成员');
    }
    return fail('JOIN_FAMILY_FAILED', '加入家庭失败，请稍后重试');
  }

  return ok(toFamilyDTO(family, memberCount + 1));
}

/** 当前家庭成员列表：同样由服务端按当前登录身份解析家庭 */
async function handleGetMembers(event, wxContext, requestId, logContext) {
  const context = await requireFamilyMember(wxContext.OPENID, event.familyId, logContext);
  if (context.error) {
    return context.error;
  }
  logContext.userId = context.user._id;
  logContext.familyId = context.family._id;

  return ok(await buildMemberDTOs(context.family._id));
}

/** 修改家庭信息与偏好，仅 owner */
async function handleUpdateFamily(event, wxContext, requestId, logContext) {
  const context = await requireFamilyMember(wxContext.OPENID, event.familyId, logContext);
  if (context.error) {
    return context.error;
  }
  logContext.userId = context.user._id;
  logContext.familyId = context.family._id;

  const ownerError = requireOwner(context.membership);
  if (ownerError) {
    return ownerError;
  }

  const update = {};

  if (event.name !== undefined) {
    const nameResult = validateFamilyName(event.name);
    if (nameResult.error) {
      return nameResult.error;
    }
    update.name = nameResult.value;
  }

  if (event.preferences !== undefined) {
    const preferencesResult = buildPreferences(event.preferences, context.family.preferences);
    if (preferencesResult.error) {
      return preferencesResult.error;
    }
    update.preferences = preferencesResult.value;
  }

  // 没有任何可更新字段时按「无变化」处理，仍返回最新家庭，不报错
  if (Object.keys(update).length === 0) {
    const memberCount = await countMembers(context.family._id);
    return ok(toFamilyDTO(context.family, memberCount));
  }

  update.updatedAt = new Date();

  try {
    await familiesCol.doc(context.family._id).update({ data: update });
  } catch (error) {
    if (isCollectionMissing(error)) {
      return fail('DB_NOT_READY', DB_NOT_READY_MESSAGE);
    }
    console.error('[family] 更新家庭失败 requestId=' + requestId, error);
    return fail('UPDATE_FAMILY_FAILED', '保存失败，请稍后重试');
  }

  const memberCount = await countMembers(context.family._id);
  const updated = Object.assign({}, context.family, update);

  return ok(toFamilyDTO(updated, memberCount));
}

/**
 * 退出家庭。
 * 普通成员可退出；owner 不允许直接退出（第一阶段不实现管理员转移），
 * 只能通过 dissolveFamily 解散家庭。
 */
async function handleLeaveFamily(event, wxContext, requestId, logContext) {
  const context = await requireFamilyMember(wxContext.OPENID, event.familyId, logContext);
  if (context.error) {
    return context.error;
  }
  logContext.userId = context.user._id;
  logContext.familyId = context.family._id;

  if (context.membership.role === 'owner') {
    return fail('OWNER_CANNOT_LEAVE', '你是家庭管理员，不能退出家庭。如需结束家庭，请在家庭设置中解散家庭。');
  }

  try {
    await membersCol.doc(context.membership._id).remove();
  } catch (error) {
    if (isCollectionMissing(error)) {
      return fail('DB_NOT_READY', DB_NOT_READY_MESSAGE);
    }
    console.error('[family] 退出家庭失败 requestId=' + requestId, error);
    return fail('INTERNAL_ERROR', '退出家庭失败，请稍后重试');
  }

  return ok(null);
}

/** 移除成员：仅 owner，且不能移除自己，目标必须在当前家庭内 */
async function handleRemoveMember(event, wxContext, requestId, logContext) {
  const context = await requireFamilyMember(wxContext.OPENID, event.familyId, logContext);
  if (context.error) {
    return context.error;
  }
  logContext.userId = context.user._id;
  logContext.familyId = context.family._id;

  const ownerError = requireOwner(context.membership);
  if (ownerError) {
    return ownerError;
  }

  const targetUserId = normalizeText(event.userId);
  if (!targetUserId) {
    return fail('INVALID_PARAMS', '缺少要移除的成员');
  }

  if (targetUserId === context.user._id) {
    return fail('CANNOT_REMOVE_SELF', '管理员不能移除自己。');
  }

  // 只在当前家庭范围内查找，天然杜绝跨家庭删除
  const res = await membersCol
    .where({ familyId: context.family._id, userId: targetUserId })
    .limit(1)
    .get();
  const target = (res.data && res.data[0]) || null;
  if (!target) {
    return fail('MEMBER_NOT_FOUND', '该成员不在当前家庭');
  }

  try {
    await membersCol.doc(target._id).remove();
  } catch (error) {
    if (isCollectionMissing(error)) {
      return fail('DB_NOT_READY', DB_NOT_READY_MESSAGE);
    }
    console.error('[family] 移除成员失败 requestId=' + requestId, error);
    return fail('REMOVE_MEMBER_FAILED', '移除成员失败，请稍后重试');
  }

  return ok(null);
}

/**
 * 解散家庭：仅 owner。
 * 第一阶段不做物理删除，采用 status = deleted；
 * 同时清理 family_members，保证已解散家庭不再可被读取 / 加入 / 更新。
 */
async function handleDissolveFamily(event, wxContext, requestId, logContext) {
  const context = await requireFamilyMember(wxContext.OPENID, event.familyId, logContext);
  if (context.error) {
    return context.error;
  }
  logContext.userId = context.user._id;
  logContext.familyId = context.family._id;

  const ownerError = requireOwner(context.membership);
  if (ownerError) {
    return ownerError;
  }

  // 先置为 deleted：即使后续清理成员失败，该家庭也已经不可用
  try {
    await familiesCol.doc(context.family._id).update({
      data: { status: 'deleted', updatedAt: new Date() },
    });
  } catch (error) {
    if (isCollectionMissing(error)) {
      return fail('DB_NOT_READY', DB_NOT_READY_MESSAGE);
    }
    console.error('[family] 解散家庭失败 requestId=' + requestId, error);
    return fail('DISSOLVE_FAMILY_FAILED', '解散家庭失败，请稍后重试');
  }

  try {
    await membersCol.where({ familyId: context.family._id }).remove();
  } catch (error) {
    // 家庭已标记 deleted，成员关系残留不会再被读取；记录日志便于后续清理
    console.error('[family] 清理家庭成员失败 requestId=' + requestId, error);
  }

  return ok(null);
}

/* ------------------------------ 业务路由 ------------------------------ */

const handlers = {
  /** 健康检查：部署后可用来验证云函数是否可用 */
  ping() {
    return ok({ function: 'family', status: 'ok', time: Date.now() });
  },

  createFamily: handleCreateFamily,
  getMyFamily: handleGetMyFamily,
  joinFamily: handleJoinFamily,
  getMembers: handleGetMembers,
  updateFamily: handleUpdateFamily,
  leaveFamily: handleLeaveFamily,
  removeMember: handleRemoveMember,
  dissolveFamily: handleDissolveFamily,
};

/* ------------------------------ 入口 ------------------------------ */

exports.main = async (event = {}) => {
  const startedAt = Date.now();
  const wxContext = cloud.getWXContext();
  const action = event.action || '';
  const requestId = event.requestId || Date.now() + '-' + Math.random().toString(36).slice(2, 8);

  // 日志上下文：由各 handler 在解析出身份后填充，日志只记 userId / familyId，不记邀请码
  const logContext = { userId: '', familyId: '' };

  let response;
  try {
    const handler = Object.prototype.hasOwnProperty.call(handlers, action)
      ? handlers[action]
      : null;
    if (!handler) {
      response = fail('UNKNOWN_ACTION', '未知操作：' + action);
    } else {
      response = await handler(event, wxContext, requestId, logContext);
    }
  } catch (error) {
    if (isCollectionMissing(error)) {
      console.error('[family] 数据库集合缺失', error);
      response = fail('DB_NOT_READY', DB_NOT_READY_MESSAGE);
    } else {
      console.error('[family] 未捕获异常', error);
      response = fail('INTERNAL_ERROR', '服务内部异常，请稍后重试');
    }
  }

  response.requestId = requestId;

  // 统一日志：functionName / requestId / action / userId / familyId / duration / status / error
  // 邀请码只以布尔值记录，绝不写入完整邀请码
  console.log(
    JSON.stringify({
      functionName: 'family',
      requestId: requestId,
      action: action,
      userId: logContext.userId,
      familyId: logContext.familyId || event.familyId || '',
      duration: Date.now() - startedAt,
      status: response.success ? 'success' : 'fail',
      code: response.code || '',
      error: response.success ? '' : response.message,
    }),
  );

  return response;
};
