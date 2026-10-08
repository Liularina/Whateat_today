/**
 * 家庭相关类型（Phase 3）
 *
 * 分为两组，切勿混用：
 *   - 服务端文档结构：Family / FamilyMember（云数据库里真实存在的字段）
 *   - 前端 DTO：FamilyDTO / FamilyMemberDTO（云函数已脱敏、已拼装好的结构）
 *
 * 前端只用 DTO，不关心 family_members 里只有 userId、也没有 openid。
 */

export type FamilyRole = 'owner' | 'member';

export type FamilyStatus = 'active' | 'deleted';

/** 家庭默认偏好，本阶段只负责存储 / 修改 / 读取，不参与 AI */
export interface FamilyPreferences {
  /** 默认人数，1~6 */
  defaultPeopleCount: number;
  /** 口味，例如 ['家常'] */
  taste: string[];
  /** 明确忌口食材，例如 ['不吃香菜'] */
  avoidIngredients: string[];
  /** 过敏原，必须程序硬过滤 */
  allergens: string[];
  /** 默认最大烹饪时间（分钟），取值 20/30/40/60/90 */
  defaultCookTime: number;
}

/* ------------------------------ 服务端文档结构 ------------------------------ */

/** families 集合文档 */
export interface Family {
  _id: string;
  name: string;
  ownerId: string;
  inviteCode: string;
  preferences: FamilyPreferences;
  status: FamilyStatus;
  createdAt: Date | string;
  updatedAt: Date | string;
}

/** family_members 集合文档 */
export interface FamilyMember {
  _id: string;
  familyId: string;
  userId: string;
  role: FamilyRole;
  joinedAt: Date | string;
  createdAt: Date | string;
  updatedAt?: Date | string;
}

/* ------------------------------ 前端 DTO ------------------------------ */

/** 家庭 DTO：云函数返回给前端的家庭结构（含成员数，前端不必自己数） */
export interface FamilyDTO {
  _id: string;
  name: string;
  ownerId: string;
  inviteCode: string;
  preferences: FamilyPreferences;
  status: FamilyStatus;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * 家庭成员 DTO。
 * 由云函数用 family_members.userId 回查 users 拼装，页面直接展示，
 * 不包含 openid，也不需要页面二次查询用户表。
 */
export interface FamilyMemberDTO {
  userId: string;
  nickname: string;
  avatarUrl: string;
  role: FamilyRole;
  joinedAt: string;
}

/**
 * getMyFamily 返回结构。
 * 没有家庭是正常业务状态（不是异常）：family = null、members = []、currentMember = null。
 */
export interface MyFamilyResult {
  family: FamilyDTO | null;
  members: FamilyMemberDTO[];
  currentMember: FamilyMemberDTO | null;
}

/* ------------------------------ 入参 ------------------------------ */

/** 创建家庭入参：只允许提交 name 与 preferences，其余字段由服务端决定 */
export interface CreateFamilyInput {
  name: string;
  preferences?: Partial<FamilyPreferences>;
}

/** 修改家庭入参：只允许提交 name 与 preferences */
export interface UpdateFamilyInput {
  name?: string;
  preferences?: Partial<FamilyPreferences>;
}

/**
 * 家庭状态快照：页面通过 App 的 getFamilyState() 统一读取。
 * 「无家庭」是正常业务状态，不是错误——此时 family 为 null 且 error 为空串。
 */
export interface FamilyState {
  /** 家庭信息是否已向服务端确认（未确认前不应展示「无家庭」引导，避免闪一下） */
  ready: boolean;
  family: FamilyDTO | null;
  isInFamily: boolean;
  /** 可直接展示给用户的中文错误文案，无错误时为空串 */
  error: string;
}

export type FamilyStateListener = (state: FamilyState) => void;
