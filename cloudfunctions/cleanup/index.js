/**
 * cleanup 云函数 · 历史菜单自动清理（Phase A4）
 *
 * 职责：删除 6 个月以前已确认的菜单，释放数据库空间。
 *
 * 触发器：每天凌晨 3:00（北京时间）自动执行。
 *   config.json 中设置 triggers，可在云函数控制台手动调用触发测试。
 *
 * 安全：
 *   1. 只删除已确认（confirmed）状态的历史菜单；
 *   2. 保留 draft / completed 状态不受影响；
 *   3. 一次最多删除 500 条（单次执行限额），防止 OOM；
 *   4. 记录清理数量到日志，便于审计。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const MAX_DELETE_PER_RUN = 500;

/** 计算 N 个月前的 ISO 日期字符串 */
function monthsAgo(months) {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString();
}

exports.main = async (event, context) => {
  const cutoff = monthsAgo(6);
  console.log('[cleanup] 清理开始，截止时间（6 个月前）:', cutoff);

  // 查询待清理的 menu ID
  let ids;
  try {
    const res = await db.collection('menus')
      .where({
        status: 'confirmed',
        createdAt: _.lt(cutoff),
      })
      .field({ _id: true })
      .limit(MAX_DELETE_PER_RUN)
      .get();
    ids = (res.data || []).map((doc) => doc._id);
  } catch (e) {
    if (e.errCode === -502005) {
      // 集合不存在，无需清理
      console.log('[cleanup] menus 集合不存在，跳过');
      return { deleted: 0, reason: 'collection-not-found' };
    }
    console.error('[cleanup] 查询待清理菜单失败', e);
    return { deleted: 0, error: e.message };
  }

  if (ids.length === 0) {
    console.log('[cleanup] 没有需要清理的菜单');
    return { deleted: 0 };
  }

  console.log(`[cleanup] 待清理 ${ids.length} 个菜单`);

  // 批量删除
  let deleted = 0;
  for (const id of ids) {
    try {
      await db.collection('menus').doc(id).remove();
      deleted++;
    } catch (e) {
      console.error(`[cleanup] 删除 ${id} 失败`, e.message || e);
    }
  }

  console.log(`[cleanup] 清理完成：已删除 ${deleted} 个菜单`);
  return { deleted: deleted, total: ids.length };
};