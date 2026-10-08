/**
 * 家庭主页
 *
 * 三种状态都是「正常状态」，不是错误：
 *   1. 未登录        → 引导登录，不调用 getMyFamily
 *   2. 已登录无家庭  → 创建 / 加入引导
 *   3. 已登录有家庭  → 家庭信息 + 邀请码 + 成员列表 + 默认设置
 *
 * 权限依据永远是服务端 family_members：
 * 页面只负责按服务端返回的 role 渲染，按钮隐藏只是体验，真正的拦截在云函数。
 */
import { DEFAULT_NICKNAME, FAMILY_OWNER_BADGE, FAMILY_ROLE_LABELS } from '../../constants/config';
import { familyService } from '../../services/family';
import type { FamilyMemberDTO } from '../../types/family';
import { getErrorMessage } from '../../utils/cloud';

/** 成员展示项：把角色文案、是否本人等展示逻辑在 TS 里算好，WXML 不做判断 */
interface MemberView {
  userId: string;
  nickname: string;
  avatarUrl: string;
  role: 'owner' | 'member';
  roleLabel: string;
  isOwnerRole: boolean;
  isSelf: boolean;
}

function toMemberViews(members: FamilyMemberDTO[], currentUserId: string): MemberView[] {
  return (members || []).map((item) => ({
    userId: item.userId,
    nickname: item.nickname || DEFAULT_NICKNAME,
    avatarUrl: item.avatarUrl || '',
    role: item.role,
    roleLabel: item.role === 'owner' ? FAMILY_OWNER_BADGE : FAMILY_ROLE_LABELS.member,
    isOwnerRole: item.role === 'owner',
    isSelf: item.userId === currentUserId,
  }));
}

Page({
  data: {
    /** 登录初始化是否结束 */
    authReady: false,
    isLoggedIn: false,
    authError: '',
    /** 家庭信息是否已向服务端确认 */
    ready: false,
    loading: false,
    isInFamily: false,
    isOwner: false,
    familyName: '',
    memberCount: 0,
    inviteCode: '',
    members: [] as MemberView[],
    peopleText: '',
    tasteText: '',
    cookTimeText: '',
    avoidText: '',
    allergenText: '',
    /** 可直接展示的错误文案（网络异常等） */
    error: '',
  },

  onShow() {
    void this.load();
  },

  /** 拉取家庭：以服务端返回为准，同时同步 App 全局家庭状态 */
  async load() {
    const app = getApp<IAppOption>();
    const auth = app.getAuthState();

    if (!auth.ready) {
      this.setData({ authReady: false, isLoggedIn: auth.isLoggedIn });
      return;
    }

    if (!auth.isLoggedIn) {
      // 未登录时不调用家庭接口，只引导登录
      this.setData({
        authReady: true,
        isLoggedIn: false,
        authError: auth.error,
        ready: true,
        isInFamily: false,
      });
      return;
    }

    this.setData({
      authReady: true,
      isLoggedIn: true,
      authError: auth.error,
      loading: true,
      error: '',
    });

    const currentUserId = app.globalData.user ? app.globalData.user._id : '';

    try {
      const result = await familyService.getMyFamily();

      if (!result || !result.family) {
        // 「没有家庭」是正常业务状态，清掉可能残留的本地 familyId
        app.clearFamily();
        this.setData({ loading: false, ready: true, isInFamily: false });
        return;
      }

      const family = result.family;
      const preferences = family.preferences;

      app.setFamily(family);

      this.setData({
        loading: false,
        ready: true,
        isInFamily: true,
        isOwner: family.ownerId === currentUserId,
        familyName: family.name,
        memberCount: family.memberCount,
        inviteCode: family.inviteCode,
        members: toMemberViews(result.members, currentUserId),
        peopleText: preferences.defaultPeopleCount + ' 人',
        tasteText: preferences.taste.length ? preferences.taste.join('、') : '不限',
        cookTimeText: preferences.defaultCookTime + ' 分钟',
        avoidText: preferences.avoidIngredients.length
          ? preferences.avoidIngredients.join('、')
          : '无',
        allergenText: preferences.allergens.length ? preferences.allergens.join('、') : '无',
      });
    } catch (error) {
      // 网络异常：保留已有家庭状态，仅提示错误，不清空
      const cached = app.globalData.family;
      this.setData({
        loading: false,
        ready: true,
        isInFamily: cached !== null,
        isOwner: cached ? cached.ownerId === currentUserId : false,
        familyName: cached ? cached.name : '',
        memberCount: cached ? cached.memberCount : 0,
        inviteCode: cached ? cached.inviteCode : '',
        members: [],
        error: getErrorMessage(error, '家庭信息加载失败，请稍后重试'),
      });
    }
  },

  onRetryLogin() {
    void getApp<IAppOption>().retryLogin();
  },

  onGoCreate() {
    wx.navigateTo({ url: '/pages/family/create' });
  },

  onGoJoin() {
    wx.navigateTo({ url: '/pages/family/join' });
  },

  onGoSettings() {
    wx.navigateTo({ url: '/pages/family/settings' });
  },

  /** 复制邀请码：本阶段只支持邀请码，不做二维码 */
  onCopyInviteCode() {
    const inviteCode = this.data.inviteCode;
    if (!inviteCode) {
      return;
    }

    wx.setClipboardData({
      data: inviteCode,
      success: () => {
        wx.showToast({ title: '已复制邀请码', icon: 'none' });
      },
      fail: () => {
        wx.showToast({ title: '复制失败，请长按选择', icon: 'none' });
      },
    });
  },

  /** 管理员移除成员：仅 owner 能看到按钮，服务端会再次校验 */
  onRemoveMember(e: WechatMiniprogram.TouchEvent) {
    const userId = String(e.currentTarget.dataset.userid || '');
    const name = String(e.currentTarget.dataset.name || '该成员');
    if (!userId) {
      return;
    }

    wx.showModal({
      title: '移除成员',
      content: '确定要移除「' + name + '」吗？',
      success: (res) => {
        if (res.confirm) {
          void this.removeMember(userId);
        }
      },
    });
  },

  async removeMember(userId: string) {
    const app = getApp<IAppOption>();
    const familyId = app.globalData.currentFamilyId;
    if (!familyId) {
      return;
    }

    wx.showLoading({ title: '处理中...', mask: true });
    try {
      await familyService.removeMember(familyId, userId);
      wx.hideLoading();
      wx.showToast({ title: '已移除成员', icon: 'none' });
      // 以服务端返回为准重新拉取，不手动猜成员列表
      await this.load();
    } catch (error) {
      wx.hideLoading();
      wx.showToast({ title: getErrorMessage(error, '移除失败，请稍后重试'), icon: 'none' });
    }
  },

  /** 普通成员退出家庭：owner 不允许退出，只能解散 */
  onLeaveFamily() {
    wx.showModal({
      title: '退出家庭',
      content: '退出后将无法继续查看该家庭的信息。确定要退出吗？',
      success: (res) => {
        if (res.confirm) {
          void this.leaveFamily();
        }
      },
    });
  },

  async leaveFamily() {
    const app = getApp<IAppOption>();

    wx.showLoading({ title: '正在退出...', mask: true });
    try {
      await familyService.leaveFamily(app.globalData.currentFamilyId || undefined);
      wx.hideLoading();
      // 只清家庭，不清登录态
      app.clearFamily();
      wx.showToast({ title: '已退出家庭', icon: 'none' });
      setTimeout(() => {
        wx.reLaunch({ url: '/pages/home/index' });
      }, 800);
    } catch (error) {
      wx.hideLoading();
      wx.showToast({ title: getErrorMessage(error, '退出失败，请稍后重试'), icon: 'none' });
    }
  },
});
