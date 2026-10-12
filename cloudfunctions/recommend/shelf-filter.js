/**
 * 食材保质期过滤（Phase B）
 *
 * 纯函数，无云开发依赖，便于被 recommend 云函数复用与单独测试。
 */

/**
 * 北京时间的今天（YYYY-MM-DD）。
 * 云函数运行在 UTC，直接用 toISOString() 会在北京时间 08:00 前退回前一天，
 * 因此统一加 8 小时再取日期。
 */
function todayInBeijing(now) {
  const base = typeof now === 'number' ? now : Date.now();
  return new Date(base + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 到期日严格早于今天即视为已过期；未填到期日不算过期 */
function isExpiredIngredient(item, today) {
  const expireDate = (item && item.expireDate) || '';
  if (!expireDate) {
    return false;
  }
  return expireDate < today;
}

/**
 * 过滤掉已过期的食材。
 * 返回 { kept, skipped }，skipped 为被排除的条数，便于日志与测试。
 */
function filterExpired(ingredients, today) {
  const list = Array.isArray(ingredients) ? ingredients : [];
  const kept = list.filter((item) => !isExpiredIngredient(item, today));
  return { kept: kept, skipped: list.length - kept.length };
}

module.exports = {
  todayInBeijing,
  isExpiredIngredient,
  filterExpired,
};
