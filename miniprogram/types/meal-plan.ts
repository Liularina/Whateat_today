/**
 * 餐次协作类型（Phase 1）
 *
 * 对应云函数 menu 的 getMealBoard / submitPreference / setMealCook / confirmMenu。
 *
 * 角色不是身份枚举：掌勺人由 menu_plans.cookId 决定，
 * 一顿餐只有一个发起人，发起人即掌勺人，家庭管理员不会自动获得该权限。
 */
import type { MealType, MenuItem } from './menu';

/** 方案状态：open 可继续选；confirmed 掌勺人已锁定最终菜单 */
export type PlanStatus = 'open' | 'confirmed';

/** 菜品建议：想吃 / 不想吃 / 未表态 */
export type DishVote = 'want' | 'avoid' | 'none';

/** 掌勺人已保存的点单里的菜品 */
export interface DraftDishView {
  recipeId: string;
  name: string;
  category: string;
  cookTime: number;
  difficulty: string;
}

/** 掌勺人已保存的点单 */
export interface DraftMenuView {
  menuId: string;
  title: string;
  status: string;
  items: DraftDishView[];
}

/** 方案文档视图 */
export interface MealPlanDoc {
  planId: string;
  familyId: string;
  date: string;
  mealType: MealType;
  servings: number;
  status: PlanStatus;
  cookId: string;
  cookName: string;
  /** 已锁定的最终菜单 */
  menuId: string;
  /** 掌勺人已保存、但还没锁定的点单 */
  draftMenuId: string;
  planTitle: string;
  generatedBy: string;
  createdAt: string;
  updatedAt: string;
}

/** 单道菜的建议汇总 */
export interface DishSuggestionStat {
  recipeId: string;
  name: string;
  wantCount: number;
  avoidCount: number;
  wantBy: string[];
  avoidBy: string[];
  /** 我的表态 */
  myVote: DishVote;
}

/** 我的建议 */
export interface MyPreference {
  dishVotes: { recipeId: string; vote: DishVote }[];
  note: string;
  updatedAt: string;
}

/** 建议汇总 */
export interface PreferenceSummary {
  dishes: DishSuggestionStat[];
  participantCount: number;
  memberCount: number;
  totalMembers: number;
  missingMembers: string[];
  my: MyPreference | null;
}

/** 本菜单的点单进度（历史份数点单，用餐详情展示用） */
export interface MealOrderProgress {
  orderId: string;
  status: '' | 'open' | 'closed';
  orderedCount: number;
  memberCount: number;
  missingMembers: string[];
  allDone: boolean;
}

/** 餐次看板 */
export interface MealBoard {
  available: boolean;
  date: string;
  mealType: MealType;
  plan: MealPlanDoc | null;
  members: { userId: string; nickname: string; isCook: boolean }[];
  /** 掌勺人已保存的点单；未保存时为 null */
  draft: DraftMenuView | null;
  summary: PreferenceSummary | null;
  isCook: boolean;
  /** 查看者是否家庭管理员（仅用于展示，不能指定掌勺人） */
  isOwner: boolean;
  /** 掌勺人可锁定菜单（已有草稿、未锁定） */
  canConfirm: boolean;
  /** 掌勺人可换一批推荐 */
  canRegenerate: boolean;
  /** 可交接掌勺人（掌勺人本人，或掌勺人已离群时的管理员兜底） */
  canSetCook: boolean;
  /** 管理员在掌勺人已不在家庭里时的兜底接管 */
  canTakeOver: boolean;
}

/** 提交菜品建议入参 */
export interface SubmitPreferenceInput {
  familyId: string;
  mealType: MealType;
  planId: string;
  dishVotes: { recipeId: string; vote: DishVote }[];
  note?: string;
}

/** 指定掌勺人入参 */
export interface SetMealCookInput {
  familyId: string;
  mealType: MealType;
  cookId: string;
  date?: string;
}

/** 前端组合后的建议视图（便于 WXML 直接渲染） */
export interface DishSuggestionView {
  recipeId: string;
  name: string;
  meta: string;
  wantCount: number;
  avoidCount: number;
  myVote: DishVote;
  /** 「张三、李四想吃」这类可读文本 */
  wantText: string;
  avoidText: string;
}

/** 已确认菜单的摘要（点菜页顶部展示） */
export interface ConfirmedMenuView {
  menuId: string;
  itemCount: number;
  items: MenuItem[];
}