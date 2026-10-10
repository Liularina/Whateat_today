/**
 * 全局配置与环境区分
 *
 * 环境 ID 只在此处维护，禁止在页面或云函数里散落写死。
 * 部署前请把下面的占位符替换为真实的云开发环境 ID。
 */
import type { MealType } from '../types/menu';

export type EnvName = 'dev' | 'prod';

export interface EnvConfig {
  name: EnvName;
  /** 微信云开发环境 ID */
  cloudEnvId: string;
}

const ENV_CONFIG: Record<EnvName, EnvConfig> = {
  dev: {
    name: 'dev',
    cloudEnvId: 'cloud1-d1glvky15d3e30ba8',
  },
  prod: {
    // TODO(发布前替换)：正式环境 ID，未发布前保持占位
    name: 'prod',
    cloudEnvId: 'prod-cloud-env-id',
  },
};

/**
 * 当前生效环境。
 * 开发阶段固定为 dev；正式发布前改为 'prod'。
 * 不要在多处判断环境，统一读取这里。
 */
export const CURRENT_ENV: EnvName = 'dev';

export const CONFIG: EnvConfig = ENV_CONFIG[CURRENT_ENV];

export const CLOUD_ENV_ID: string = CONFIG.cloudEnvId;

export const CLOUD_ENV_NAME: EnvName = CONFIG.name;

export const APP_NAME = '今天吃什么';

export const APP_VERSION = '1.0.0';

/** 普通云函数调用超时时间（毫秒） */
export const REQUEST_TIMEOUT = 20000;

/** AI 相关云函数调用超时时间（毫秒），AI 生成较慢 */
export const AI_REQUEST_TIMEOUT = 90000;

/** 家庭偏好默认值 */
export const DEFAULT_PEOPLE_COUNT = 2;
export const DEFAULT_COOK_TIME = 40;

/** 人数可选项（Phase 3 起支持 1~6 人） */
export const PEOPLE_COUNT_OPTIONS: readonly number[] = [1, 2, 3, 4, 5, 6];

/** 餐次 */
export interface MealTypeOption {
  value: MealType;
  label: string;
}

export const MEAL_TYPES: readonly MealTypeOption[] = [
  { value: 'breakfast', label: '早餐' },
  { value: 'lunch', label: '午餐' },
  { value: 'dinner', label: '晚餐' },
  { value: 'midnight_snack', label: '夜宵' },
];

/** 口味，第一阶段为家庭级设置 */
export const TASTE_OPTIONS: readonly string[] = ['不限', '清淡', '家常', '偏辣', '重口', '酸甜'];

/** 餐次 → 展示文案（Phase 11 起多处复用） */
export const MEAL_TYPE_LABELS: Record<string, string> = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  midnight_snack: '夜宵',
};

/** 难度展示文案 */
export const DIFFICULTY_LABELS: Record<string, string> = {
  easy: '简单',
  medium: '中等',
  hard: '有点挑战',
};

/** 最大烹饪时间选项（分钟） */
export const COOK_TIME_OPTIONS: readonly number[] = [20, 30, 40, 60, 90];

/** 热量展示前缀，禁止使用「精确」表述 */
export const KCAL_PREFIX = '约';

/**
 * 营养数据免责声明。
 * 文案与规范第 5 章要求一致，不要改成「精确」或去掉「估算」字眼。
 */
export const NUTRITION_DISCLAIMER = '营养数据为估算值，仅供饮食参考。';

/** 默认昵称：第一阶段微信登录不强制获取昵称头像，资料完善留到后续阶段 */
export const DEFAULT_NICKNAME = '微信用户';

/* ------------------------------ 家庭（Phase 3） ------------------------------ */

/** 当前版本单个家庭的成员人数上限（含 owner）。只在此处维护，禁止散落写死 */
export const FAMILY_MAX_MEMBERS = 10;

/** 家庭名称字数上限 */
export const FAMILY_NAME_MAX_LENGTH = 20;

/** 自定义忌口 / 过敏单项字数上限 */
export const FAMILY_TAG_MAX_LENGTH = 20;

/** 忌口 / 过敏标签数量上限 */
export const FAMILY_TAG_LIST_MAX_LENGTH = 20;

/** 邀请码长度 */
export const INVITE_CODE_LENGTH = 6;

/**
 * 邀请码字符集：大写字母 + 数字，剔除易混淆的 O / 0 / I / 1。
 * 云函数生成邀请码与前后端校验共用同一套规则。
 */
export const INVITE_CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 邀请码格式校验：输入需先 trim + 转大写 */
export const INVITE_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

/** 创建家庭时的默认口味 */
export const DEFAULT_TASTE: readonly string[] = ['家常'];

/** 忌口常用标签（允许自定义添加） */
export const AVOID_INGREDIENT_OPTIONS: readonly string[] = [
  '不吃辣',
  '不吃香菜',
  '不吃葱',
  '不吃蒜',
  '不吃海鲜',
  '不吃牛肉',
  '不吃羊肉',
  '不吃猪肉',
  '不吃鸡肉',
];

/** 过敏原常用标签（允许自定义添加） */
export const ALLERGEN_OPTIONS: readonly string[] = [
  '花生',
  '鸡蛋',
  '牛奶',
  '大豆',
  '小麦',
  '坚果',
  '鱼类',
  '甲壳类',
];

/** 家庭角色文案 */
export const FAMILY_ROLE_LABELS: Record<string, string> = {
  owner: '管理员',
  member: '成员',
};

/** 管理员标识：规范要求必须有明显标识，不能只显示 owner */
export const FAMILY_OWNER_BADGE = '👑 管理员';

/* ------------------------------ 食材库存（Phase 4） ------------------------------ */

/**
 * 一次最多返回的食材条数，第一阶段不做分页。
 * 与云函数中的同名常量保持一致，只在此处维护前端侧的值。
 */
export const INGREDIENT_LIST_LIMIT = 200;

/* ------------------------------ 营养计算（Phase 5） ------------------------------ */

/** 一次可计算的食材条数上限，与云函数 nutrition-core.js 保持一致 */
export const NUTRITION_MAX_INGREDIENTS = 100;

/** 用餐人数上限，与云函数 nutrition-core.js 保持一致 */
export const NUTRITION_MAX_PEOPLE_COUNT = 20;

/** 有食材缺营养数据 / 无法换算时的提示文案（规范要求固定文案） */
export const NUTRITION_PARTIAL_MESSAGE = '部分营养数据缺失，仅供参考。';

/**
 * 脚手架占位环境 ID。
 * 只要 cloudEnvId 仍是这些值，就说明开发者尚未配置真实云环境。
 */
const PLACEHOLDER_CLOUD_ENV_IDS: readonly string[] = ['dev-cloud-env-id', 'prod-cloud-env-id'];

/**
 * 云开发环境是否已配置。
 * 未配置时不允许发起云函数调用，直接给出明确提示，避免报 undefined / cannot read property。
 */
export function isCloudEnvConfigured(): boolean {
  return typeof CLOUD_ENV_ID === 'string' && CLOUD_ENV_ID !== '' && PLACEHOLDER_CLOUD_ENV_IDS.indexOf(CLOUD_ENV_ID) === -1;
}

export const CLOUD_ENV_NOT_CONFIGURED_MESSAGE = '云开发环境尚未配置，请检查 constants/config.ts 中的环境 ID';

/** 云函数统一响应码 */
export const CLOUD_ERROR_CODES = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_IN_FAMILY: 'NOT_IN_FAMILY',
  INVALID_PARAMS: 'INVALID_PARAMS',
  NOT_FOUND: 'NOT_FOUND',
  INVALID_STATUS: 'INVALID_STATUS',
  AI_FAILED: 'AI_FAILED',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',

  /* 认证相关（Phase 2） */
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  LOGIN_FAILED: 'LOGIN_FAILED',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  USER_CREATE_FAILED: 'USER_CREATE_FAILED',
  USER_UPDATE_FAILED: 'USER_UPDATE_FAILED',

  /* 客户端/环境相关 */
  CLOUD_NOT_READY: 'CLOUD_NOT_READY',
  NETWORK_ERROR: 'NETWORK_ERROR',
  /** 云数据库中缺少必需的集合（通常是尚未在控制台创建） */
  DB_NOT_READY: 'DB_NOT_READY',

  /* 家庭相关（Phase 3） */
  FAMILY_NOT_FOUND: 'FAMILY_NOT_FOUND',
  FAMILY_NOT_ACTIVE: 'FAMILY_NOT_ACTIVE',
  ALREADY_IN_FAMILY: 'ALREADY_IN_FAMILY',
  ALREADY_MEMBER: 'ALREADY_MEMBER',
  INVITE_CODE_INVALID: 'INVITE_CODE_INVALID',
  INVITE_CODE_GENERATE_FAILED: 'INVITE_CODE_GENERATE_FAILED',
  FAMILY_FULL: 'FAMILY_FULL',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  OWNER_CANNOT_LEAVE: 'OWNER_CANNOT_LEAVE',
  MEMBER_NOT_FOUND: 'MEMBER_NOT_FOUND',
  CANNOT_REMOVE_SELF: 'CANNOT_REMOVE_SELF',
  CREATE_FAMILY_FAILED: 'CREATE_FAMILY_FAILED',
  JOIN_FAMILY_FAILED: 'JOIN_FAMILY_FAILED',
  UPDATE_FAMILY_FAILED: 'UPDATE_FAMILY_FAILED',
  REMOVE_MEMBER_FAILED: 'REMOVE_MEMBER_FAILED',
  DISSOLVE_FAMILY_FAILED: 'DISSOLVE_FAMILY_FAILED',

  /* 食材库存相关（Phase 4） */
  INGREDIENT_NOT_FOUND: 'INGREDIENT_NOT_FOUND',
  CREATE_INGREDIENT_FAILED: 'CREATE_INGREDIENT_FAILED',
  UPDATE_INGREDIENT_FAILED: 'UPDATE_INGREDIENT_FAILED',
  DELETE_INGREDIENT_FAILED: 'DELETE_INGREDIENT_FAILED',

  /* 营养计算相关（Phase 5） */
  CALCULATE_NUTRITION_FAILED: 'CALCULATE_NUTRITION_FAILED',
  SEED_NUTRITION_FAILED: 'SEED_NUTRITION_FAILED',

  /* 菜谱相关（Phase 6） */
  RECIPE_NOT_FOUND: 'RECIPE_NOT_FOUND',
  SEED_RECIPES_FAILED: 'SEED_RECIPES_FAILED',

  /* AI 推荐相关（Phase 7） */
  AI_CONFIG_REQUIRED: 'AI_CONFIG_REQUIRED',
  AI_CALL_FAILED: 'AI_CALL_FAILED',
} as const;
