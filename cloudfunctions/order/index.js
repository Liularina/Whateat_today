/**
 * order 云函数 · 家庭点单（Phase 9）
 *
 * 职责：
 *   createOrder      —— 从已确认菜单发起点单
 *   getOrder         —— 查询点单详情（含菜品列表、我的选择）
 *   submitOrderItems —— 成员提交/修改自己的点单
 *   getOrderSummary  —— 管理员查看汇总
 *   closeOrder       —— 管理员关闭点单
 *
 * 安全：
 *   1. 身份只来自 cloud.getWXContext().OPENID
 *   2. 所有操作必须经 requireFamilyMember 校验
 *   3. 点单只关联已确认的菜单
 *   4. 服务端独立校验 recipeId 归属
 *   5. 数量统计只从 DB 记录计算，不信任客户端
 *   6. Phase 9 不调用 AI
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

/* ============================== 统一响应 ============================== */

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

/* ============================== 基础工具 ============================== */

const ERR_COLLECTION_NOT_EXIST = -502005;
const ERR_DOC_NOT_EXIST = -502002;

function isCollectionMissing(err) {
  if (!err) return false;
  // 有 errCode 时以错误码为准：-502005 是集合不存在，-502002 是文档不存在。
  // 若退回字符串判断，会把「document not exists」误判成集合缺失。
  if (typeof err.errCode === 'number') {
    return err.errCode === ERR_COLLECTION_NOT_EXIST;
  }
  return typeof err.message === 'string' && err.message.indexOf('not exist') !== -1;
}

function generateId() {
  return Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

/* ============================== 用户与家庭校验 ============================== */

async function findUserByOpenid(openid) {
  const result = await db.collection('users').where({ openid }).limit(1).get();
  return result.data[0] || null;
}

async function requireFamilyMember(openid, familyId) {
  if (!familyId) {
    return { error: fail('INVALID_PARAMS', '缺少 familyId') };
  }
  const user = await findUserByOpenid(openid);
  if (!user) {
    return { error: fail('UNAUTHORIZED', '请先登录') };
  }
  const memberResult = await db
    .collection('family_members')
    .where({ familyId, userId: user._id })
    .limit(1)
    .get();
  const member = memberResult.data[0];
  if (!member) {
    return { error: fail('NOT_IN_FAMILY', '你不是该家庭的成员') };
  }
  return { user, member };
}

function requireOwner(member) {
  if (!member || member.role !== 'owner') {
    return fail('FORBIDDEN', '只有家庭管理员可以执行该操作');
  }
  return null;
}

/* ============================== 校验辅助 ============================== */

/** 文档不存在（-502002）。与集合缺失区分开，避免误报 DB_NOT_READY */
function isDocMissing(err) {
  if (!err) return false;
  if (typeof err.errCode === 'number') return err.errCode === ERR_DOC_NOT_EXIST;
  return typeof err.message === 'string' && err.message.indexOf('document not exists') !== -1;
}

function readOrder(orderId) {
  return db.collection('family_orders')
    .doc(orderId)
    .get()
    .then((result) => result.data || null)
    .catch((err) => {
      if (isDocMissing(err)) return null;
      throw err;
    });
}

function readMenu(menuId) {
  return db.collection('menus')
    .doc(menuId)
    .get()
    .then((result) => result.data || null)
    .catch((err) => {
      if (isDocMissing(err)) return null;
      throw err;
    });
}

/** 统一的截止时间校验 */
function checkDeadline(deadline) {
  if (!deadline) return null; // 无截止时间，允许
  const dl = new Date(deadline);
  if (isNaN(dl.getTime())) {
    return fail('INVALID_DEADLINE', '截止时间格式无效');
  }
  if (dl.getTime() <= Date.now()) {
    return fail('DEADLINE_PAST', '截止时间必须在当前时间之后');
  }
  return null;
}

/** 检查点单是否可编辑（open + 未截止） */
function isOrderEditable(order) {
  if (order.status !== 'open') {
    return fail('ORDER_CLOSED', '点单已关闭，不能提交');
  }
  if (order.deadline && new Date(order.deadline).getTime() <= Date.now()) {
    return fail('DEADLINE_PASSED', '点单已截止');
  }
  return null;
}

/** 批量查询用户姓名 */
async function batchLookupUsers(userIds) {
  const map = {};
  if (userIds.length === 0) return map;

  try {
    // wx-server-sdk 的 _id 批量查询最多 1000 条
    const uniqueIds = [...new Set(userIds)];
    for (let i = 0; i < uniqueIds.length; i += 100) {
      const batch = uniqueIds.slice(i, i + 100);
      const result = await db.collection('users')
        .where({ _id: _.in(batch) })
        .get();
      for (const u of (result.data || [])) {
        const displayName = u.nickName || u.name || '';
        if (displayName) map[u._id] = displayName;
      }
    }
  } catch (_e) {
    // users 集合缺失时返回空 map，不影响汇总
  }

  return map;
}

/* ============================== createOrder ============================== */

async function handleCreateOrder(event, wxContext) {
  const openid = wxContext.OPENID || '';
  const { menuId, familyId, note } = event;

  if (!menuId) return fail('INVALID_PARAMS', '缺少 menuId');

  const auth = await requireFamilyMember(openid, familyId);
  if (auth.error) return auth.error;

  // 读取菜单，验证状态
  const menu = await readMenu(menuId);
  if (!menu) {
    return fail('MENU_NOT_FOUND', '菜单不存在或已被删除');
  }
  if (menu.familyId !== familyId) {
    return fail('FORBIDDEN', '该菜单不属于你的家庭');
  }
  if (menu.status !== 'confirmed') {
    return fail('MENU_NOT_CONFIRMED', '只能对已确认的菜单发起点单');
  }

  const items = menu.items || [];
  if (items.length === 0) {
    return fail('EMPTY_MENU', '菜单没有菜品');
  }

  // 防止同一菜单重复创建进行中的点单
  const existing = await db.collection('family_orders')
    .where({ menuId: menuId, familyId: familyId, status: 'open' })
    .limit(1)
    .get();
  if (existing.data.length > 0) {
    return fail('DUPLICATE_ORDER', '该菜单已有进行中的点单，请先关闭后再新建');
  }

  // 截止时间校验
  if (event.deadline) {
    const dlCheck = checkDeadline(event.deadline);
    if (dlCheck) return dlCheck;
  }

  const now = new Date().toISOString();
  const title = note || (menu.mealType === 'dinner' ? '今晚吃什么' : '家庭点单');

  const doc = {
    familyId: familyId,
    menuId: menuId,
    menuName: (menu.mealType || '') + ' · ' + (menu.servings || 0) + '人份',
    title: title,
    status: 'open',
    deadline: event.deadline || '',
    note: (note || '').slice(0, 200),
    initiatorUserId: auth.user._id,
    recipeIds: items.map((it) => it.recipeId),
    createdAt: now,
    updatedAt: now,
  };

  const result = await db.collection('family_orders').add({ data: doc });

  return ok({
    _id: result._id,
    ...doc,
  });
}

/* ============================== getOrder ============================== */

async function handleGetOrder(event, wxContext) {
  const openid = wxContext.OPENID || '';
  const { orderId } = event;

  if (!orderId) return fail('INVALID_PARAMS', '缺少 orderId');

  const order = await readOrder(orderId);
  if (!order) {
    return fail('ORDER_NOT_FOUND', '点单不存在或已被删除');
  }

  const auth = await requireFamilyMember(openid, order.familyId);
  if (auth.error) return auth.error;

  const member = auth.member;

  // 读取关联菜单的菜品
  let recipes = [];
  if (order.menuId) {
    const menu = await readMenu(order.menuId);
    if (menu && menu.items) {
      recipes = menu.items.map((it) => ({
        recipeId: it.recipeId,
        name: it.name,
        description: it.description || '',
        category: it.category || '',
        tags: it.tags || [],
        cookTime: it.cookTime || 0,
        ingredients: it.ingredients || [],
      }));
    }
  }

  // 读取当前用户的选择
  let mySelections = [];
  try {
    const selResult = await db.collection('family_order_items')
      .where({ orderId: orderId, userId: auth.user._id })
      .limit(1)
      .get();
    if (selResult.data.length > 0) {
      mySelections = selResult.data[0].items || [];
    }
  } catch (e) {
    if (!isCollectionMissing(e)) throw e;
  }

  // 权限判断
  const canManage = member.role === 'owner' || order.initiatorUserId === auth.user._id;
  const editable = order.status === 'open' && (!order.deadline || new Date(order.deadline).getTime() > Date.now());

  return ok({
    order: {
      _id: order._id,
      familyId: order.familyId,
      menuId: order.menuId,
      title: order.title,
      status: order.status,
      deadline: order.deadline || '',
      note: order.note || '',
      initiatorUserId: order.initiatorUserId,
      recipeIds: order.recipeIds || [],
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      closedAt: order.closedAt || '',
    },
    recipes: recipes,
    mySelections: mySelections,
    canManage: canManage,
    editable: editable,
  });
}

/* ============================== submitOrderItems ============================== */

async function handleSubmitOrderItems(event, wxContext) {
  const openid = wxContext.OPENID || '';
  const { orderId, items } = event;

  if (!orderId) return fail('INVALID_PARAMS', '缺少 orderId');
  if (!Array.isArray(items)) return fail('INVALID_PARAMS', '缺少 items 数组');

  const order = await readOrder(orderId);
  if (!order) return fail('ORDER_NOT_FOUND', '点单不存在或已被删除');

  const auth = await requireFamilyMember(openid, order.familyId);
  if (auth.error) return auth.error;

  const editableCheck = isOrderEditable(order);
  if (editableCheck) return editableCheck;

  // 校验每条 item
  const validRecipeIds = new Set(order.recipeIds || []);
  const validItems = [];

  for (const item of items) {
    const recipeId = String(item.recipeId || '');
    if (!recipeId) continue;
    if (!validRecipeIds.has(recipeId)) {
      return fail('INVALID_RECIPE', '菜品「' + (item.recipeId || '') + '」不属于本轮点单');
    }

    const quantity = Number(item.quantity);
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 20) {
      return fail('INVALID_QUANTITY', '份数需在 0~20 之间');
    }

    const note = String(item.note || '').slice(0, 100);

    // 份数为 0 表示取消，不加入
    if (quantity > 0) {
      validItems.push({
        recipeId: recipeId,
        quantity: quantity,
        note: note,
      });
    }
  }

  const now = new Date().toISOString();

  // 使用 upsert：如果该用户已有记录则替换，否则新增
  try {
    const existing = await db.collection('family_order_items')
      .where({ orderId: orderId, userId: auth.user._id })
      .limit(1)
      .get();

    if (existing.data.length > 0) {
      await db.collection('family_order_items').doc(existing.data[0]._id).update({
        data: {
          items: validItems,
          updatedAt: now,
        },
      });
    } else {
      await db.collection('family_order_items').add({
        data: {
          orderId: orderId,
          familyId: order.familyId,
          userId: auth.user._id,
          items: validItems,
          createdAt: now,
          updatedAt: now,
        },
      });
    }
  } catch (e) {
    if (isCollectionMissing(e)) {
      return fail('DB_NOT_READY', '数据库集合 family_order_items 不存在');
    }
    throw e;
  }

  return ok({
    orderId: orderId,
    savedCount: validItems.length,
    updatedAt: now,
  });
}

/* ============================== getOrderSummary ============================== */

async function handleGetOrderSummary(event, wxContext) {
  const openid = wxContext.OPENID || '';
  const { orderId } = event;

  if (!orderId) return fail('INVALID_PARAMS', '缺少 orderId');

  const order = await readOrder(orderId);
  if (!order) return fail('ORDER_NOT_FOUND', '点单不存在或已被删除');

  const auth = await requireFamilyMember(openid, order.familyId);
  if (auth.error) return auth.error;

  // 读取所有成员的提交
  let allItems;
  try {
    const result = await db.collection('family_order_items')
      .where({ orderId: orderId })
      .get();
    allItems = result.data || [];
  } catch (e) {
    if (isCollectionMissing(e)) {
      allItems = [];
    } else {
      throw e;
    }
  }

  // 读取菜单获取菜品名称
  let recipeMap = {};
  if (order.menuId) {
    const menu = await readMenu(order.menuId);
    if (menu && menu.items) {
      for (const it of menu.items) {
        recipeMap[it.recipeId] = it.name;
      }
    }
  }

  // 按菜品汇总
  const dishSummary = {};
  for (const doc of allItems) {
    for (const item of (doc.items || [])) {
      const recipeId = item.recipeId;
      if (!dishSummary[recipeId]) {
        dishSummary[recipeId] = {
          recipeId: recipeId,
          name: recipeMap[recipeId] || recipeId,
          peopleCount: 0,
          totalQuantity: 0,
          memberDetails: [],
        };
      }
      dishSummary[recipeId].peopleCount += 1;
      dishSummary[recipeId].totalQuantity += item.quantity || 0;
      dishSummary[recipeId].memberDetails.push({
        userId: doc.userId,
        quantity: item.quantity || 0,
        note: item.note || '',
      });
    }
  }

  // 按成员汇总（含昵称）
  const userIds = [...new Set(allItems.map((d) => d.userId))];
  const userMap = await batchLookupUsers(userIds);

  const memberSummary = [];
  for (const doc of allItems) {
    const memberItems = (doc.items || []).map((item) => ({
      recipeId: item.recipeId,
      name: recipeMap[item.recipeId] || item.recipeId,
      quantity: item.quantity || 0,
      note: item.note || '',
    }));
    if (memberItems.length > 0) {
      memberSummary.push({
        userId: doc.userId,
        displayName: userMap[doc.userId] || '家庭成员',
        items: memberItems,
      });
    }
  }

  // 读取家庭成员列表，找出未提交的
  let unsubmittedUsers = [];
  try {
    const members = await db.collection('family_members')
      .where({ familyId: order.familyId })
      .get();
    const submittedUserIds = new Set(allItems.map((d) => d.userId));
    for (const m of (members.data || [])) {
      if (!submittedUserIds.has(m.userId)) {
        unsubmittedUsers.push(m.userId);
      }
    }
  } catch (_e) {
    // members collection might not exist in test
  }

  return ok({
    orderId: orderId,
    title: order.title,
    status: order.status,
    deadline: order.deadline || '',
    totalParticipants: allItems.length,
    totalDishes: Object.keys(dishSummary).length,
    dishSummary: Object.values(dishSummary),
    memberSummary: memberSummary,
    unsubmittedCount: unsubmittedUsers.length,
  });
}

/* ============================== listOrders ============================== */

async function handleListOrders(event, wxContext) {
  const openid = wxContext.OPENID || '';
  const { familyId } = event;

  const auth = await requireFamilyMember(openid, familyId);
  if (auth.error) return auth.error;

  const page = Number.isInteger(event.page) && event.page > 0 ? event.page : 1;
  const pageSize = Math.min(
    Number.isInteger(event.pageSize) && event.pageSize > 0 ? event.pageSize : 10,
    50,
  );

  const condition = { familyId: familyId };
  if (event.status && (event.status === 'open' || event.status === 'closed')) {
    condition.status = event.status;
  }

  let total, docs;
  try {
    const countResult = await db.collection('family_orders').where(condition).count();
    total = countResult.total || 0;
    docs = [];
    if (total > 0) {
      const res = await db.collection('family_orders')
        .where(condition)
        .orderBy('createdAt', 'desc')
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .get();
      docs = res.data || [];
    }
  } catch (e) {
    if (isCollectionMissing(e)) {
      return fail('DB_NOT_READY', '数据库集合 family_orders 不存在');
    }
    throw e;
  }

  // 批量查发起人姓名
  const initiatorIds = [...new Set(docs.map((d) => d.initiatorUserId).filter(Boolean))];
  const userMap = await batchLookupUsers(initiatorIds);

  const items = docs.map((doc) => ({
    orderId: doc._id,
    menuId: doc.menuId || '',
    menuName: doc.menuName || '',
    title: doc.title || '',
    status: doc.status || '',
    initiatorUserId: doc.initiatorUserId || '',
    initiatorName: userMap[doc.initiatorUserId] || '家庭成员',
    createdAt: doc.createdAt || '',
    deadline: doc.deadline || '',
    closedAt: doc.closedAt || '',
    memberCount: doc.totalParticipants || 0,
  }));

  return ok({ items: items, total: total, page: page, pageSize: pageSize });
}

/* ============================== closeOrder ============================== */

async function handleCloseOrder(event, wxContext) {
  const openid = wxContext.OPENID || '';
  const { orderId } = event;

  if (!orderId) return fail('INVALID_PARAMS', '缺少 orderId');

  const order = await readOrder(orderId);
  if (!order) return fail('ORDER_NOT_FOUND', '点单不存在或已被删除');

  const auth = await requireFamilyMember(openid, order.familyId);
  if (auth.error) return auth.error;

  // 只有管理员或发起人可以关闭
  const isOwner = auth.member.role === 'owner';
  const isInitiator = order.initiatorUserId === auth.user._id;
  if (!isOwner && !isInitiator) {
    return fail('FORBIDDEN', '只有家庭管理员或点单发起人可以关闭点单');
  }

  if (order.status === 'closed') {
    return ok({
      _id: order._id,
      status: 'closed',
      closedAt: order.closedAt || order.updatedAt,
      message: '点单已经关闭',
    });
  }

  if (order.status !== 'open') {
    return fail('INVALID_STATUS', '只能关闭进行中的点单');
  }

  // 生成最终汇总快照
  let items;
  try {
    const result = await db.collection('family_order_items')
      .where({ orderId: orderId })
      .get();
    items = result.data || [];
  } catch (e) {
    if (isCollectionMissing(e)) items = [];
    else throw e;
  }

  const recipeMap = {};
  if (order.menuId) {
    const menu = await readMenu(order.menuId);
    if (menu && menu.items) {
      for (const it of menu.items) {
        recipeMap[it.recipeId] = { name: it.name, category: it.category || '' };
      }
    }
  }

  const finalDishSummary = {};
  for (const doc of items) {
    for (const item of (doc.items || [])) {
      if (!finalDishSummary[item.recipeId]) {
        finalDishSummary[item.recipeId] = {
          recipeId: item.recipeId,
          name: (recipeMap[item.recipeId] || {}).name || item.recipeId,
          category: (recipeMap[item.recipeId] || {}).category || '',
          peopleCount: 0,
          totalQuantity: 0,
        };
      }
      finalDishSummary[item.recipeId].peopleCount += 1;
      finalDishSummary[item.recipeId].totalQuantity += item.quantity || 0;
    }
  }

  const now = new Date().toISOString();
  await db.collection('family_orders').doc(orderId).update({
    data: {
      status: 'closed',
      closedAt: now,
      finalSummary: Object.values(finalDishSummary),
      totalParticipants: items.length,
      updatedAt: now,
    },
  });

  return ok({
    _id: order._id,
    status: 'closed',
    closedAt: now,
    totalParticipants: items.length,
    dishSummary: Object.values(finalDishSummary),
  });
}

/* ============================== 业务路由 ============================== */

const handlers = {
  ping() {
    return ok({ function: 'order', status: 'ok', time: Date.now() });
  },

  createOrder: handleCreateOrder,
  getOrder: handleGetOrder,
  listOrders: handleListOrders,
  submitOrderItems: handleSubmitOrderItems,
  getOrderSummary: handleGetOrderSummary,
  closeOrder: handleCloseOrder,

  /** 旧版桩 */
  submitOrderItem() {
    return fail('NOT_IMPLEMENTED', '请使用 submitOrderItems');
  },
  updateOrderItem() {
    return fail('NOT_IMPLEMENTED', '请使用 submitOrderItems');
  },
  confirmOrder() {
    return fail('NOT_IMPLEMENTED', 'order.confirmOrder 尚未实现');
  },
  cancelOrder() {
    return fail('NOT_IMPLEMENTED', 'order.cancelOrder 尚未实现');
  },
};

/* ============================== 入口 ============================== */

exports.main = async (event = {}) => {
  const startedAt = Date.now();
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID || '';
  const action = event.action || '';
  const requestId = event.requestId || generateId();

  let response;
  try {
    const handler = Object.prototype.hasOwnProperty.call(handlers, action) ? handlers[action] : null;
    if (!handler) {
      response = fail('UNKNOWN_ACTION', '未知操作：' + action);
    } else {
      response = await handler(event, wxContext);
    }
  } catch (error) {
    if (isCollectionMissing(error)) {
      response = fail('DB_NOT_READY', '数据库集合不存在，请先在云开发控制台创建');
    } else {
      console.error('[order] 未捕获异常', error.code || '', error.message || '');
      response = fail('INTERNAL_ERROR', '服务内部异常，请稍后重试');
    }
  }

  console.log(
    JSON.stringify({
      functionName: 'order',
      requestId: requestId,
      userId: openid,
      familyId: event.familyId || '',
      orderId: event.orderId || '',
      action: action,
      duration: Date.now() - startedAt,
      status: response.success ? 'success' : 'fail',
      code: response.code || '',
      error: response.success ? '' : (response.message || ''),
    }),
  );

  return response;
};