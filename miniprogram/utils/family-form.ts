/**
 * 家庭表单选项工具（创建页 / 家庭设置页共用）
 *
 * 只负责「预置选项 + 已选值 → 可渲染的选项列表」这类纯计算，
 * 不涉及任何请求与页面状态，避免两个页面的表单逻辑各写一份、逐渐漂移。
 */

export interface TagOption {
  label: string;
  active: boolean;
}

export interface ChoiceOption {
  value: number;
  label: string;
  active: boolean;
}

/**
 * 构造标签选项。
 * 预置标签按是否被选中标记 active；不在预置列表里的已选项（自定义标签）
 * 追加到末尾并保持选中，保证用户之前填过的自定义内容不会丢失。
 */
export function buildTagOptions(
  presets: readonly string[],
  selected: readonly string[],
): TagOption[] {
  const options: TagOption[] = presets.map((label) => ({
    label,
    active: selected.indexOf(label) !== -1,
  }));

  for (const item of selected) {
    if (presets.indexOf(item) === -1) {
      options.push({ label: item, active: true });
    }
  }

  return options;
}

export function buildTasteOptions(
  presets: readonly string[],
  selected: readonly string[],
): TagOption[] {
  return presets.map((label) => ({ label, active: selected.indexOf(label) !== -1 }));
}

/** 单选数值选项，例如人数、烹饪时间 */
export function buildNumberOptions(
  values: readonly number[],
  selected: number,
  suffix: string,
): ChoiceOption[] {
  return values.map((value) => ({ value, label: value + suffix, active: value === selected }));
}

export function collectActive(options: TagOption[]): string[] {
  return options.filter((item) => item.active).map((item) => item.label);
}

/** 取选中项数值，没有选中项时回退默认值 */
export function pickActiveValue(options: ChoiceOption[], fallback: number): number {
  const active = options.filter((item) => item.active)[0];
  return active ? active.value : fallback;
}
