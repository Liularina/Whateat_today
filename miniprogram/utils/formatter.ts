/**
 * 展示层格式化工具
 *
 * 约束（见开发规范第 31 / 95 条）：
 * 热量必须展示为「约 XXX kcal」；
 * 数据库保存标准时间，本地化展示由前端负责。
 */
import { KCAL_PREFIX, MEAL_TYPES } from '../constants/config';
import type { MealType } from '../types/menu';

/** 安全地把字符串 / 时间戳 / Date 转为 Date，失败返回 null */
export function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** YYYY-MM-DD */
export function formatDate(value: string | number | Date | null | undefined): string {
  const date = toDate(value);
  if (!date) {
    return '';
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** YYYY-MM-DD HH:mm */
export function formatDateTime(value: string | number | Date | null | undefined): string {
  const date = toDate(value);
  if (!date) {
    return '';
  }
  return `${formatDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** HH:mm */
export function formatTime(value: string | number | Date | null | undefined): string {
  const date = toDate(value);
  if (!date) {
    return '';
  }
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 点菜截止时间展示：今天 18:30 / 明天 18:30 / 10-06 18:30 */
export function formatDeadline(value: string | number | Date | null | undefined): string {
  const date = toDate(value);
  if (!date) {
    return '';
  }

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const targetStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((targetStart - todayStart) / 86400000);

  if (dayDiff === 0) {
    return `今天 ${formatTime(date)}`;
  }
  if (dayDiff === 1) {
    return `明天 ${formatTime(date)}`;
  }
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${formatTime(date)}`;
}

/** 根据当前时间推断默认餐次；仅作为默认值，用户可以手动修改 */
export function inferMealTypeByHour(date: Date = new Date()): MealType {
  const hour = date.getHours();
  if (hour >= 5 && hour < 10) {
    return 'breakfast';
  }
  if (hour >= 10 && hour < 15) {
    return 'lunch';
  }
  if (hour >= 15 && hour < 22) {
    return 'dinner';
  }
  return 'midnight_snack';
}

export function getMealTypeLabel(mealType: MealType): string {
  const found = MEAL_TYPES.find((item) => item.value === mealType);
  return found ? found.label : '本餐';
}

/** 热量统一展示为「约 XXX kcal」，禁止「精确 XXX kcal」表述 */
export function formatKcal(calories: number): string {
  if (!Number.isFinite(calories) || calories <= 0) {
    return '暂无数据';
  }
  return `${KCAL_PREFIX} ${Math.round(calories)} kcal`;
}

/** 营养克数展示 */
export function formatGram(grams: number): string {
  if (!Number.isFinite(grams) || grams <= 0) {
    return '0 g';
  }
  return `${roundTo(grams, 1)} g`;
}

export function roundTo(value: number, digits: number): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

/** 人数展示：5 表示「5 人及以上」 */
export function formatPeopleCount(count: number): string {
  if (!Number.isFinite(count) || count <= 0) {
    return '';
  }
  return count >= 5 ? '5 人及以上' : `${count} 人`;
}

/** 烹饪时间展示 */
export function formatCookTime(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return '';
  }
  return `约 ${Math.round(minutes)} 分钟`;
}
