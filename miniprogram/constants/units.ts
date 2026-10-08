/**
 * 单位常量与换算
 *
 * 第一阶段只支持 g / kg / 个 / 袋 / 盒。
 * 其中 kg → g 必须能精确换算；
 * 个 / 袋 / 盒 依赖 nutrition_facts.averageWeight 才能换算为克。
 */
import type { UnitCode } from '../types/ingredient';

export interface UnitOption {
  value: UnitCode;
  label: string;
}

export const UNITS: readonly UnitOption[] = [
  { value: 'g', label: 'g' },
  { value: 'kg', label: 'kg' },
  { value: '个', label: '个' },
  { value: '袋', label: '袋' },
  { value: '盒', label: '盒' },
];

const UNIT_VALUES: readonly string[] = UNITS.map((item) => item.value);

export function isUnitCode(value: unknown): value is UnitCode {
  return typeof value === 'string' && UNIT_VALUES.indexOf(value) !== -1;
}

export function getUnitLabel(unit: UnitCode): string {
  return unit;
}

/**
 * 把「数量 + 单位」换算为克。
 *
 * @param amount 数量
 * @param unit 单位
 * @param averageWeight nutrition_facts.averageWeight，即单个/袋/盒的平均重量（g）
 * @returns 换算后的克数；无法换算时返回 null（例如缺少 averageWeight）
 */
export function convertToGram(
  amount: number,
  unit: UnitCode,
  averageWeight: number | null = null,
): number | null {
  if (!Number.isFinite(amount) || amount < 0) {
    return null;
  }

  switch (unit) {
    case 'g':
      return round(amount, 2);
    case 'kg':
      return round(amount * 1000, 2);
    case '个':
    case '袋':
    case '盒':
      if (averageWeight === null || !Number.isFinite(averageWeight) || averageWeight <= 0) {
        return null;
      }
      return round(amount * averageWeight, 2);
    default:
      return null;
  }
}

function round(value: number, digits: number): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

/**
 * 展示用格式化：把 kg 归一到 g 更符合中国家庭习惯（1000g 以上显示 kg）。
 */
export function formatQuantity(amount: number, unit: UnitCode): string {
  if (unit === 'g' && amount >= 1000) {
    return `${round(amount / 1000, 2)} kg`;
  }
  return `${amount} ${unit}`;
}
