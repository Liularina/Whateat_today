/**
 * 保质期 / 临期计算工具（Phase B）
 *
 * 全部按 UTC 天数序号计算，避免 new Date('YYYY-MM-DD') 在非零时区
 * 被解析成前一天的本地时间而导致「差一天」。
 */

/** 剩余天数小于等于该值即视为临期 */
export const SHELF_LIFE_WARNING_DAYS = 3;

export type ShelfLifeStatusCode = 'expired' | 'warning' | 'fresh' | 'unknown';

export interface ShelfLifeStatus {
  status: ShelfLifeStatusCode;
  /** 剩余天数；已过期时为负数。无到期日时为 null */
  daysLeft: number | null;
  /** 可直接展示的文案 */
  label: string;
}

function pad(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

/** 本地日期 → YYYY-MM-DD */
export function toDateString(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * YYYY-MM-DD → UTC 天数序号。
 * 非法日期（格式错 / 2026-02-30 这类不存在的日期）返回 null。
 */
export function toDayNumber(dateText: string): number | null {
  if (typeof dateText !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateText)) {
    return null;
  }
  const parts = dateText.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const ms = Date.UTC(year, month - 1, day);
  const date = new Date(ms);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return Math.floor(ms / 86400000);
}

/** 剩余天数：正数表示还有几天到期，0 表示今天到期，负数表示已过期 */
export function daysUntil(expireDate: string, today: Date = new Date()): number | null {
  const expireDay = toDayNumber(expireDate);
  if (expireDay === null) {
    return null;
  }
  const todayDay = toDayNumber(toDateString(today));
  if (todayDay === null) {
    return null;
  }
  return expireDay - todayDay;
}

/** 判定保质期状态；无到期日或日期非法时返回 unknown */
export function getShelfLifeStatus(expireDate: string | null | undefined, today: Date = new Date()): ShelfLifeStatus {
  const daysLeft = expireDate ? daysUntil(expireDate, today) : null;

  if (daysLeft === null) {
    return { status: 'unknown', daysLeft: null, label: '' };
  }
  if (daysLeft < 0) {
    return { status: 'expired', daysLeft: daysLeft, label: `已过期 ${-daysLeft} 天` };
  }
  if (daysLeft === 0) {
    return { status: 'warning', daysLeft: 0, label: '今天到期' };
  }
  if (daysLeft <= SHELF_LIFE_WARNING_DAYS) {
    return { status: 'warning', daysLeft: daysLeft, label: `${daysLeft} 天后到期` };
  }
  return { status: 'fresh', daysLeft: daysLeft, label: `${daysLeft} 天后到期` };
}

/** 已过期（严格小于今天） */
export function isExpired(expireDate: string | null | undefined, today: Date = new Date()): boolean {
  return getShelfLifeStatus(expireDate, today).status === 'expired';
}
