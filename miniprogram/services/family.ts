/**
 * 家庭服务（Phase 3）
 *
 * 约定：
 *   - 页面不得直接调用 wx.cloud.callFunction，家庭相关调用统一经过本 service；
 *   - 涉及 familyId 的调用，服务端一定会用「当前登录身份」去 family_members 复核，
 *     前端传入的 familyId 只是「想操作哪个家庭」的意图，绝不作为权限依据；
 *   - 响应信封（success / error / requestId）由 utils/cloud.ts 统一解析，
 *     这里只负责调用与返回 data，页面不需要重复解析。
 */
import type {
  CreateFamilyInput,
  FamilyDTO,
  FamilyMemberDTO,
  MyFamilyResult,
  UpdateFamilyInput,
} from '../types/family';
import { callFunction } from '../utils/cloud';

export const familyService = {
  /** 创建家庭：创建者自动成为 owner。ownerId 由服务端按当前登录身份决定 */
  createFamily(input: CreateFamilyInput): Promise<FamilyDTO> {
    return callFunction<FamilyDTO, CreateFamilyInput>('family', 'createFamily', input);
  },

  /**
   * 查询当前用户的家庭与成员。
   * 刻意不让前端传 familyId：服务端从当前登录身份反查，避免伪造 familyId。
   * 没有家庭时正常返回 { family: null, members: [], currentMember: null }。
   */
  getMyFamily(): Promise<MyFamilyResult> {
    return callFunction<MyFamilyResult>('family', 'getMyFamily');
  },

  /** 用邀请码加入家庭。服务端会 trim + 转大写后校验，前端不提交任何身份字段 */
  joinFamily(inviteCode: string): Promise<FamilyDTO> {
    return callFunction<FamilyDTO, { inviteCode: string }>('family', 'joinFamily', { inviteCode });
  },

  /** 当前家庭成员列表：同样由服务端按当前登录身份解析家庭 */
  getMembers(): Promise<FamilyMemberDTO[]> {
    return callFunction<FamilyMemberDTO[]>('family', 'getMembers');
  },

  /** 修改家庭信息与偏好，仅 owner 可执行（服务端二次校验） */
  updateFamily(familyId: string, input: UpdateFamilyInput): Promise<FamilyDTO> {
    return callFunction<FamilyDTO, { familyId: string } & UpdateFamilyInput>(
      'family',
      'updateFamily',
      { familyId, ...input },
    );
  },

  /** 退出家庭：普通成员可用；owner 会被服务端以 OWNER_CANNOT_LEAVE 拒绝 */
  leaveFamily(familyId?: string): Promise<null> {
    return callFunction<null, { familyId?: string }>('family', 'leaveFamily', {
      ...(familyId ? { familyId } : {}),
    });
  },

  /** 移除成员：仅 owner 可执行，且不能移除自己 */
  removeMember(familyId: string, userId: string): Promise<null> {
    return callFunction<null, { familyId: string; userId: string }>('family', 'removeMember', {
      familyId,
      userId,
    });
  },

  /** 解散家庭：仅 owner 可执行。服务端将 status 置为 deleted 并清理成员关系 */
  dissolveFamily(familyId: string): Promise<null> {
    return callFunction<null, { familyId: string }>('family', 'dissolveFamily', { familyId });
  },
};
