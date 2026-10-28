/**
 * 饭后评价与掌勺人成长类型（阶段二）
 *
 * 对应 menu 云函数的 completeMeal / submitRatings / getMealReview / getChefGrowth。
 * 所有汇总与等级都由服务端计算，前端只负责展示。
 */

/** 单道菜的评分（1—5 星，comment 可选） */
export interface DishRating {
  recipeId: string;
  stars: number;
  comment: string;
}

/** 汇总里的一条菜品评价 */
export interface DishReviewComment {
  userId: string;
  nickname: string;
  stars: number;
  comment: string;
}

/** 汇总后的单道菜评价 */
export interface DishReviewView {
  recipeId: string;
  name: string;
  category: string;
  /** 有效评分人数 */
  ratedCount: number;
  /** 平均分（保留 1 位小数）；无人评分时为 null */
  average: number | null;
  /** 我的评分，0 表示未评分 */
  myStars: number;
  myComment: string;
  comments: DishReviewComment[];
}

/** 一餐的评价汇总 */
export interface ReviewSummary {
  dishes: DishReviewView[];
  totalDishCount: number;
  ratedDishCount: number;
  myRatedDishCount: number;
  /** 有效评分数（菜品 × 人数） */
  ratingCount: number;
  /** 整体平均分；没有任何有效评分时为 null */
  overallAverage: number | null;
  raterCount: number;
  memberCount: number;
  missingMembers: string[];
  iHaveRated: boolean;
}

/** 厨师等级静态配置 */
export interface ChefLevel {
  level: number;
  name: string;
  minPoints: number;
}

/** 掌勺人在某个家庭的成长数据 */
export interface ChefGrowth {
  familyId: string;
  userId: string;
  nickname: string;
  points: number;
  level: number;
  levelName: string;
  levelMinPoints: number;
  nextLevel: number;
  nextLevelName: string;
  nextMinPoints: number;
  pointsToNext: number;
  maxLevel: boolean;
  lastReason: string;
  lastPoints: number;
  lastAt: string;
  recordCount: number;
}

/** 用餐详情（完成状态 + 评价 + 成长） */
export interface MealReviewDetail {
  menuId: string;
  menuStatus: 'draft' | 'confirmed' | 'completed';
  menuVersion: number;
  completedAt: string;
  completedBy: string;
  cookId: string;
  cookName: string;
  isCook: boolean;
  canComplete: boolean;
  canRate: boolean;
  myRatings: DishRating[];
  summary: ReviewSummary;
  growth: ChefGrowth | null;
  rules: ChefRules;
}

export interface ChefRules {
  basePoints: number;
  pointsPerStar: number;
  maxRatingBonus: number;
  levels: ChefLevel[];
}

/** 标记本餐完成 */
export interface CompleteMealResult {
  menuId: string;
  status: string;
  alreadyCompleted: boolean;
  completedAt: string;
  completedBy: string;
  cookId: string;
  cookName: string;
  pointsAwarded: number;
  growth: ChefGrowth | null;
}

/** 提交评分 */
export interface SubmitRatingsResult {
  menuId: string;
  summary: ReviewSummary;
  myRatings: DishRating[];
  cookId: string;
  cookName: string;
  pointsAwarded: number;
  growth: ChefGrowth | null;
}

/** 查询掌勺人成长 */
export interface ChefGrowthResult {
  growth: ChefGrowth;
  levels: ChefLevel[];
  rules: ChefRules;
}