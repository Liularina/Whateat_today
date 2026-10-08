/**
 * 营养展示卡片（Phase 5）
 *
 * 纯展示组件：只渲染服务端算好的营养值，不做任何换算或补全。
 * 热量统一展示为「约 XXX kcal」，并强制携带免责声明。
 */
import { NUTRITION_DISCLAIMER } from '../../constants/config';

Component({
  properties: {
    /** 整桌营养汇总（NutritionSummary） */
    total: { type: Object, value: null },
    /** 人均营养（NutritionSummary） */
    perPerson: { type: Object, value: null },
    title: { type: String, value: '营养估算' },
    /** 免责声明，默认取全局常量，保证全站文案一致 */
    disclaimer: {
      type: String,
      value: NUTRITION_DISCLAIMER,
    },
  },
});
