/**
 * 加入家庭
 *
 * 本阶段只支持邀请码加入（不做二维码）。
 * 邀请码在输入时即做清洗：去除非字母数字字符并转大写，
 * 提交前再校验 6 位格式，服务端会独立再校验一次。
 */
import { INVITE_CODE_LENGTH, INVITE_CODE_PATTERN } from '../../constants/config';
import { familyService } from '../../services/family';
import { getErrorMessage } from '../../utils/cloud';

Page({
  data: {
    inviteCode: '',
    codeLength: INVITE_CODE_LENGTH,
    /** 提交中：按钮禁用，避免快速重复提交产生并发加入 */
    submitting: false,
    error: '',
  },

  onCodeInput(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    // 粘贴时可能带入空格或小写，这里统一清洗，避免无意义的格式错误
    const value = String(e.detail.value || '')
      .replace(/[^A-Za-z0-9]/g, '')
      .toUpperCase();
    this.setData({ inviteCode: value });
  },

  async onSubmit() {
    if (this.data.submitting) {
      return;
    }

    const inviteCode = String(this.data.inviteCode || '').trim().toUpperCase();
    if (!INVITE_CODE_PATTERN.test(inviteCode)) {
      wx.showToast({ title: '请输入 6 位邀请码', icon: 'none' });
      return;
    }

    this.setData({ submitting: true, error: '' });
    wx.showLoading({ title: '加入中...', mask: true });

    try {
      const family = await familyService.joinFamily(inviteCode);

      wx.hideLoading();
      this.setData({ submitting: false });

      // 加入成功后立即写入全局状态与本地标识
      getApp<IAppOption>().setFamily(family);

      wx.showToast({ title: '已加入家庭', icon: 'success' });
      setTimeout(() => {
        wx.reLaunch({ url: '/pages/home/index' });
      }, 800);
    } catch (error) {
      wx.hideLoading();
      const message = getErrorMessage(error, '加入失败，请稍后重试');
      this.setData({ submitting: false, error: message });
      wx.showToast({ title: message, icon: 'none' });
    }
  },
});
