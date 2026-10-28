/**
 * 菜谱相关常量（Phase 6）
 *
 * 云函数无法 require TypeScript，因此 categories 与分页上限在
 * cloudfunctions/recipe/recipe-data.js 中保留了同名副本，
 * 修改时必须两边同步（与 Phase 4 的 INGREDIENT_LIST_LIMIT 处理方式一致）。
 */

/** 列表页「全部」筛选项 */
export const RECIPE_CATEGORY_ALL = '全部';

/** 菜谱分类；数组顺序即筛选条顺序 */
export const RECIPE_CATEGORIES: readonly string[] = [
  '家常菜',
  '蔬菜类',
  '汤类',
  '主食类',
  '儿童餐',
  '减肥餐',
];

/** 列表页默认每页条数 */
export const RECIPE_PAGE_SIZE = 20;

/** 每页条数上限，与云函数保持一致 */
export const RECIPE_PAGE_SIZE_MAX = 50;

/** 搜索关键词最大长度 */
export const RECIPE_KEYWORD_MAX_LENGTH = 20;
