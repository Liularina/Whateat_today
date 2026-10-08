/**
 * 入参校验工具
 *
 * 前端校验只用于提升体验，最终校验以云函数服务端为准。
 */
import { isIngredientCategory } from '../constants/categories';
import { isUnitCode } from '../constants/units';
import type { IngredientInput } from '../types/ingredient';

export interface ValidationResult {
  valid: boolean;
  message: string;
}

const OK: ValidationResult = { valid: true, message: '' };

function fail(message: string): ValidationResult {
  return { valid: false, message };
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * YYYY-MM-DD。
 * 必须回环比对年月日：JS 的 Date 会把 2026-02-30 自动进位成 3 月 2 日，
 * 只判断 !isNaN 会把不存在的日期放行。
 */
export function isIsoDateString(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parts = value.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** 家庭邀请码：6 位大写字母或数字 */
export function normalizeInviteCode(value: string): string {
  return value.trim().toUpperCase();
}

export function isValidInviteCode(value: unknown): boolean {
  return typeof value === 'string' && /^[A-Z0-9]{6}$/.test(normalizeInviteCode(value));
}

export function validateFamilyName(name: unknown): ValidationResult {
  if (!isNonEmptyString(name)) {
    return fail('请输入家庭名称');
  }
  if (name.trim().length > 20) {
    return fail('家庭名称不要超过 20 个字');
  }
  return OK;
}

export function validatePeopleCount(count: unknown): ValidationResult {
  if (typeof count !== 'number' || !Number.isFinite(count)) {
    return fail('请选择用餐人数');
  }
  if (count < 1 || count > 5) {
    return fail('用餐人数需在 1 到 5 之间');
  }
  return OK;
}

export function validateCookTime(minutes: unknown): ValidationResult {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) {
    return fail('请选择最大烹饪时间');
  }
  if (minutes < 5 || minutes > 240) {
    return fail('最大烹饪时间需在 5 到 240 分钟之间');
  }
  return OK;
}

/** 食材入参校验，与 ingredients 集合字段一一对应 */
export function validateIngredientInput(input: Partial<IngredientInput>): ValidationResult {
  if (!isNonEmptyString(input.name)) {
    return fail('请输入食材名称');
  }
  if (input.name.trim().length > 20) {
    return fail('食材名称不要超过 20 个字');
  }
  if (typeof input.quantity !== 'number' || !Number.isFinite(input.quantity)) {
    return fail('请输入数量');
  }
  if (input.quantity <= 0) {
    return fail('数量需要大于 0');
  }
  if (!isUnitCode(input.unit)) {
    return fail('请选择单位');
  }
  if (!isIngredientCategory(input.category)) {
    return fail('请选择食材分类');
  }
  if (input.expireDate !== undefined && input.expireDate !== null && !isIsoDateString(input.expireDate)) {
    return fail('保质期格式不正确');
  }
  if (input.remark !== undefined && typeof input.remark !== 'string') {
    return fail('备注格式不正确');
  }
  if (typeof input.remark === 'string' && input.remark.length > 50) {
    return fail('备注不要超过 50 个字');
  }
  return OK;
}

/** 点菜份数校验 */
export function validateQuantity(quantity: unknown): ValidationResult {
  if (typeof quantity !== 'number' || !Number.isInteger(quantity)) {
    return fail('份数必须是整数');
  }
  if (quantity < 0 || quantity > 20) {
    return fail('份数需在 0 到 20 之间');
  }
  return OK;
}
