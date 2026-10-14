/**
 * shopping 云函数 · 采购清单（Phase E1 / E3）
 *
 * 职责：
 *   generateShoppingList —— 按已确认菜单 + 当前食材库存生成 / 刷新采购清单并落库
 *   getShoppingList      —— 读取已保存的采购清单（含勾选状态）
 *   toggleShoppingItem   —— 勾选 / 取消勾选某一项并落库
 *
 * 数据流：menus(已确认) + ingredients(库存) → shopping_lists(每菜单一份)
 *
 * 安全：
 *   1. 身份只来自 cloud.getWXContext().OPENID；
 *   2. 必须经 requireFamilyMember 复核家庭归属，菜单也必须属于该家庭；
 *   3. 清单内容全部由服务端根据菜单与库存推导，不信任客户端提交的采购项；
 *   4. 客户端只能改「某 key 是否勾选」，不能改名称 / 数量 / 分类。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const {
  buildShoppingItems,
  groupItems,
  summarizeItems,
  extractChecked,
  applyChecked,
} = require('./shopping-core');

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
  if (!memberResult.data[0]) {
    return { error: fail('NOT_IN_FAMILY', '你不是该家庭的成员') };
  }
  return { user, member: memberResult.data[0] };
}

/* ============================== 菜单读取 ============================== */

async function readMenu(menuId) {
  try {
    const result = await db.collection('menus').doc(menuId).get();
    return result.data || null;
  } catch (err) {
    if (err && err.errCode === ERR_DOC_NOT_EXIST) return null;
    if (err && typeof err.errCode !== 'number' &&
      typeof err.message === 'string' && err.message.indexOf('document not exists') !== -1) {
      return null;
    }
    throw err;
  }
}

/** 校验菜单归属：存在 + 家庭成员 + 家庭匹配 */
async function requireMenuOwnership(openid, menuId, familyId) {
  const auth = await requireFamilyMember(openid, familyId);
  if (auth.error) return auth;

  const menu = await readMenu(menuId);
  if (!menu) {
    return { error: fail('MENU_NOT_FOUND', '菜单不存在或已被删除') };
  }
  if (menu.familyId !== familyId) {
    return { error: fail('FORBIDDEN', '无权操作该菜单的采购清单') };
  }
  return { ...auth, menu };
}

/* ============================== 库存读取 ============================== */

/**
 * 读取家庭食材库存。
 * 集合缺失或读取失败时按「没有库存」处理（全部计为待购），不阻塞清单生成。
 */
async function loadIngredients(familyId) {
  try {
    const result = await db.collection('ingredients')
      .where({ familyId })
      .limit(200)
      .get();
    return result.data || [];
  } catch (e) {
    if (!isCollectionMissing(e)) {
      console.error('[shopping] 读取 ingredients 失败，按无库存处理', e && e.message);
    }
    return [];
  }
}

/* ============================== 清单读写 ============================== */

function toListView(doc) {
  const items = Array.isArray(doc.items) ? doc.items : [];
  return {
    listId: doc._id,
    familyId: doc.familyId,
    menuId: doc.menuId,
    mealType: doc.mealType || 'dinner',
    servings: doc.servings || 0,
    dateLabel: doc.dateLabel || '',
    items: items,
    groups: groupItems(items),
    summary: summarizeItems(items),
    createdAt: doc.createdAt || '',
    updatedAt: doc.updatedAt || '',
  };
}

async function findList(familyId, menuId) {
  const res = await db.collection('shopping_lists')
    .where({ familyId, menuId })
    .limit(1)
    .get();
  return res.data[0] || null;
}

/* ============================== generateShoppingList ============================== */

async function handleGenerateShoppingList(event, wxContext) {
  const openid = wxContext.OPENID || '';
  const menuId = event.menuId || '';
  const familyId = event.familyId || '';

  if (!menuId) return fail('INVALID_PARAMS', '缺少 menuId');

  const auth = await requireMenuOwnership(openid, menuId, familyId);
  if (auth.error) return auth.error;

  const menu = auth.menu;
  if (menu.status !== 'confirmed' && menu.status !== 'completed') {
    return fail('MENU_NOT_CONFIRMED', '菜单确认后才能生成采购清单');
  }

  const ingredients = await loadIngredients(familyId);
  const items = buildShoppingItems(menu, ingredients);

  // 刷新时保留已有勾选（按 key 匹配），避免家人重新生成后勾选被清空
  const existing = await findList(familyId, menuId);
  const checked = existing ? extractChecked(existing.items) : {};
  const mergedItems = applyChecked(items, checked);

  const now = new Date().toISOString();
  const payload = {
    familyId: familyId,
    menuId: menuId,
    mealType: menu.mealType || 'dinner',
    servings: menu.servings || 0,
    dateLabel: (menu.createdAt || now).slice(0, 10),
    items: mergedItems,
    updatedAt: now,
  };

  let listId;
  let createdAt;
  if (existing) {
    listId = existing._id;
    createdAt = existing.createdAt || now;
    await db.collection('shopping_lists').doc(listId).update({ data: payload });
  } else {
    createdAt = now;
    const added = await db.collection('shopping_lists').add({
      data: Object.assign({}, payload, { createdAt: createdAt, createdBy: auth.user._id }),
    });
    listId = added._id;
  }

  const doc = Object.assign({ _id: listId, createdAt: createdAt }, payload);
  return ok(toListView(doc));
}

/* ============================== getShoppingList ============================== */

async function handleGetShoppingList(event, wxContext) {
  const openid = wxContext.OPENID || '';
  const familyId = event.familyId || '';
  const menuId = event.menuId || '';

  const auth = await requireFamilyMember(openid, familyId);
  if (auth.error) return auth.error;

  // 若指定了 menuId，必须校验菜单属于该家庭（防跨家庭数据泄露）；
  // 但菜单不存在时不应报错（可能菜单已删除，清单还留着）
  if (menuId) {
    const menu = await readMenu(menuId);
    if (menu && menu.familyId !== familyId) {
      return fail('FORBIDDEN', '无权查看该菜单的采购清单');
    }
  }

  let doc = null;
  try {
    if (menuId) {
      doc = await findList(familyId, menuId);
    } else {
      const res = await db.collection('shopping_lists')
        .where({ familyId })
        .orderBy('updatedAt', 'desc')
        .limit(1)
        .get();
      doc = res.data[0] || null;
    }
  } catch (e) {
    if (isCollectionMissing(e)) {
      return fail('DB_NOT_READY', '数据库集合 shopping_lists 不存在');
    }
    throw e;
  }

  return ok({ list: doc ? toListView(doc) : null });
}

/* ============================== toggleShoppingItem ============================== */

async function handleToggleShoppingItem(event, wxContext) {
  const openid = wxContext.OPENID || '';
  const familyId = event.familyId || '';
  const menuId = event.menuId || '';
  const key = typeof event.key === 'string' ? event.key.trim() : '';
  const checked = event.checked;

  if (!menuId) return fail('INVALID_PARAMS', '缺少 menuId');
  if (!key) return fail('INVALID_PARAMS', '缺少采购项 key');
  if (typeof checked !== 'boolean') return fail('INVALID_PARAMS', 'checked 必须是 true/false');

  const auth = await requireFamilyMember(openid, familyId);
  if (auth.error) return auth.error;

  const doc = await findList(familyId, menuId);
  if (!doc) {
    return fail('LIST_NOT_FOUND', '采购清单不存在，请先生成');
  }

  const items = Array.isArray(doc.items) ? doc.items : [];
  let found = false;
  const nextItems = items.map((item) => {
    if (!item || item.key !== key) return item;
    found = true;
    return Object.assign({}, item, { checked: checked });
  });

  if (!found) {
    return fail('ITEM_NOT_FOUND', '采购清单中没有该食材');
  }

  const now = new Date().toISOString();
  await db.collection('shopping_lists').doc(doc._id).update({
    data: { items: nextItems, updatedAt: now },
  });

  return ok({
    listId: doc._id,
    menuId: menuId,
    key: key,
    checked: checked,
    summary: summarizeItems(nextItems),
    updatedAt: now,
  });
}

/* ============================== 业务路由 ============================== */

const handlers = {
  ping() {
    return ok({ function: 'shopping', status: 'ok', time: Date.now() });
  },

  generateShoppingList: handleGenerateShoppingList,
  getShoppingList: handleGetShoppingList,
  toggleShoppingItem: handleToggleShoppingItem,
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
      console.error('[shopping] 未捕获异常', error.code || '', error.message || '');
      response = fail('INTERNAL_ERROR', '服务内部异常，请稍后重试');
    }
  }

  console.log(
    JSON.stringify({
      functionName: 'shopping',
      requestId: requestId,
      userId: openid,
      familyId: event.familyId || '',
      action: action,
      duration: Date.now() - startedAt,
      status: response.success ? 'success' : 'fail',
      code: response.code || '',
      error: response.success ? '' : (response.message || ''),
    }),
  );

  return response;
};
