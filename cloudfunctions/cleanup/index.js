/**
 * cleanup 云函数 · 定时维护
 *
 * 每天凌晨 3:00（北京时间）执行，做两件事：
 *
 *   1. 关闭超时未推进的餐次（48 小时）：
 *      - `menu_plans.status = 'open'` 且 48 小时没更新 → `expired`
 *        （这餐没人管了，不再霸占「一顿餐只有一个发起人」的位置）
 *      - `menus.status = 'confirmed'` 且 48 小时没更新 → `completed`
 *        （已经开饭但没人点完成，自动收尾，家人才能评价）
 *
 *   2. 清理 6 个月以前已确认的菜单，释放数据库空间。
 *
 * 安全：
 *   1. 只动上面两种状态，`draft` / `completed` / `superseded` 一律不碰；
 *   2. 每次最多处理 500 条（单次执行限额），防止 OOM；
 *   3. 只按时间条件推进，不删除仍在用的数据；
 *   4. 记录处理数量到日志，便于审计。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const MAX_PER_RUN = 500;

/** 「进行中」的判定窗口：超过这个时长没有任何推进，就视为停滞 */
const OPEN_TIMEOUT_HOURS = 48;
const OPEN_TIMEOUT_MS = OPEN_TIMEOUT_HOURS * 60 * 60 * 1000;

/** 计算 N 个月前的 ISO 日期字符串 */
function monthsAgo(months) {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString();
}

/** N 小时前的 ISO 日期字符串 */
function hoursAgo(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

/**
 * 找出「超时未推进」的文档。
 *
 * 分两路查询，因为老数据不一定有 updatedAt：
 *   - 主路径：有 updatedAt 且已超时；
 *   - 兜底路径：从未被更新过的老文档（只有 createdAt），
 *     若只看 updatedAt 会把它们永久漏掉。
 *
 * 两路结果按 `_id` 去重后合并，最多返回 MAX_PER_RUN 条。
 */
async function findStale(collection, baseCondition, cutoff, label) {
  const seen = {};
  const docs = [];

  async function collect(condition) {
    const res = await db.collection(collection)
      .where(condition)
      .field({ _id: true, createdAt: true, updatedAt: true })
      .limit(MAX_PER_RUN)
      .get();
    for (const doc of res.data || []) {
      if (seen[doc._id]) continue;
      seen[doc._id] = true;
      docs.push(doc);
    }
  }

  try {
    // 主路径：更新过且已超时
    await collect(Object.assign({}, baseCondition, { updatedAt: _.lt(cutoff) }));
    // 兜底：从未更新过的老数据，按创建时间判断。
    // 必须显式要求 updatedAt 不存在，否则这条查询会重复带出主路径的数据，
    // 白白占用 limit 名额，真正的老数据反而取不到。
    await collect(Object.assign({}, baseCondition, {
      updatedAt: _.exists(false),
      createdAt: _.lt(cutoff),
    }));
  } catch (e) {
    if (e.errCode === -502005) {
      console.log('[cleanup] ' + collection + ' 集合不存在，跳过' + label);
      return [];
    }
    console.error('[cleanup] 查询' + label + '失败', e);
    return [];
  }

  // 兜底路径可能带出「有 updatedAt 但未超时」的文档，这里再过滤一次
  return docs.filter((doc) => {
    const active = doc.updatedAt || doc.createdAt || '';
    return active && active < cutoff;
  }).slice(0, MAX_PER_RUN);
}

/**
 * 按条件批量推进状态。
 *
 * 逐条 update 而不是 `where().update()`：云开发的批量更新无法使用
 * `field` 回填，也无法区分「本来就要过期」和「刚刚更新过」的并发情况，
 * 这里用 `_id` 单条更新，条件在读取时已确认。
 */
async function closeStale(collection, baseCondition, cutoff, nextStatus, extra, label) {
  const docs = await findStale(collection, baseCondition, cutoff, label);
  if (docs.length === 0) return 0;

  let count = 0;
  const now = new Date().toISOString();
  for (const doc of docs) {
    try {
      const data = Object.assign({ status: nextStatus, updatedAt: now }, extra || {});
      await db.collection(collection).doc(doc._id).update({ data: data });
      count++;
    } catch (e) {
      console.error('[cleanup] 关闭 ' + doc._id + ' 失败', e.message || e);
    }
  }
  return count;
}

exports.main = async (event, context) => {
  const cutoffTime = hoursAgo(OPEN_TIMEOUT_HOURS);
  console.log('[cleanup] 开始，超时阈值（' + OPEN_TIMEOUT_HOURS + ' 小时前）:', cutoffTime);

  /* ---------- 1. 未锁定的方案：48 小时没人管就作废 ---------- */
  // 只用作废，不删除：家人还能看到「这餐过期了」，但不能再对它提建议。
  const expiredPlans = await closeStale(
    'menu_plans',
    {
      status: 'open',
      type: _.neq('plan_lock'),
    },
    cutoffTime,
    'expired',
    { expiredAt: new Date().toISOString() },
    '过期方案',
  );

  /* ---------- 2. 已锁定但没标记完成的菜单：48 小时自动收尾 ---------- */
  // completed 只是状态推进，菜品快照与评价归属沿用现有字段，不另建集合。
  const autoCompleted = await closeStale(
    'menus',
    {
      status: 'confirmed',
    },
    cutoffTime,
    'completed',
    {
      completedAt: new Date().toISOString(),
      completedBy: 'system',
      completionReason: 'auto_timeout',
    },
    '超时菜单',
  );

  console.log('[cleanup] 自动关闭：过期方案 ' + expiredPlans + ' 条，超时菜单 ' + autoCompleted + ' 条');

  /* ---------- 3. 清理 6 个月以前的已确认菜单 ---------- */
  const cutoff = monthsAgo(6);

  let ids;
  try {
    const res = await db.collection('menus')
      .where({
        status: 'confirmed',
        createdAt: _.lt(cutoff),
      })
      .field({ _id: true })
      .limit(MAX_PER_RUN)
      .get();
    ids = (res.data || []).map((doc) => doc._id);
  } catch (e) {
    if (e.errCode === -502005) {
      console.log('[cleanup] menus 集合不存在，跳过清理');
      return { expiredPlans: expiredPlans, autoCompleted: autoCompleted, deleted: 0 };
    }
    console.error('[cleanup] 查询待清理菜单失败', e);
    return { expiredPlans: expiredPlans, autoCompleted: autoCompleted, deleted: 0, error: e.message };
  }

  let deleted = 0;
  for (const id of ids) {
    try {
      await db.collection('menus').doc(id).remove();
      deleted++;
    } catch (e) {
      console.error(`[cleanup] 删除 ${id} 失败`, e.message || e);
    }
  }

  console.log(`[cleanup] 清理完成：已删除 ${deleted} 个历史菜单`);
  return {
    expiredPlans: expiredPlans,
    autoCompleted: autoCompleted,
    deleted: deleted,
    total: ids.length,
  };
};
