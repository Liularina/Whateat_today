/**
 * 首次登录资料设置页（Phase G）
 *
 * 登录后若用户昵称为默认「微信用户」且无头像，则引导至此页。
 * 使用合规方式获取头像（open-type="chooseAvatar"）和昵称（type="nickname"）。
 *
 * avatarUrl 存储云存储 fileID（cloud://...），展示时通过 getTempFileURL 转换为可显示 URL。
 */
import { authService } from '../../services/auth';
import { getErrorMessage } from '../../utils/cloud';
import { storage } from '../../utils/storage';

/** 将 cloud:// 转成可显示的临时 HTTPS URL；非 cloud:// 原样返回 */
function toDisplayUrl(url: string): Promise<string> {
  if (!url || !url.startsWith('cloud://')) return Promise.resolve(url);
  return new Promise((resolve) => {
    wx.cloud.getTempFileURL({
      fileList: [url],
      success: (res) => {
        if (res.fileList && res.fileList.length > 0 && res.fileList[0].tempFileURL) {
          resolve(res.fileList[0].tempFileURL);
        } else {
          resolve('');
        }
      },
      fail: () => resolve(''),
    });
  });
}

Page({
  data: {
    /** 待保存的 fileID（cloud://...） */
    avatarUrl: '',
    /** 页面展示用的临时 HTTPS URL */
    avatarDisplayUrl: '',
    nickname: '',
    saving: false,
    error: '',
    avatarChosen: false,
  },

  onLoad() {
    const app = getApp<IAppOption>();
    const user = app.globalData.user;
    if (user) {
      const raw = user.avatarUrl || '';
      this.setData({
        avatarUrl: raw,
        nickname: user.nickname,
      });
      // 已有头像时转成可显示 URL
      void toDisplayUrl(raw).then((display) => {
        if (display) this.setData({ avatarDisplayUrl: display });
      });
    }
  },

  /** chooseAvatar 回调：拿到临时路径后上传云存储，存储 fileID + 展示临时 URL */
  onChooseAvatar(e: WechatMiniprogram.CustomEvent<{ avatarUrl: string }>) {
    const tempPath = e.detail.avatarUrl;
    if (!tempPath) return;

    wx.showLoading({ title: '上传中...', mask: true });
    const cloudPath = 'avatars/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.png';
    wx.cloud.uploadFile({
      cloudPath: cloudPath,
      filePath: tempPath,
      success: (res) => {
        const fileId = res.fileID;
        // 同时获取临时显示 URL
        wx.cloud.getTempFileURL({
          fileList: [fileId],
          success: (r) => {
            const displayUrl = (r.fileList && r.fileList[0] && r.fileList[0].tempFileURL) || '';
            this.setData({
              avatarUrl: fileId,
              avatarDisplayUrl: displayUrl || tempPath,
              avatarChosen: true,
            });
          },
          fail: () => {
            // getTempFileURL 失败时回退用临时路径展示
            this.setData({
              avatarUrl: fileId,
              avatarDisplayUrl: tempPath,
              avatarChosen: true,
            });
          },
          complete: () => wx.hideLoading(),
        });
      },
      fail: () => {
        wx.hideLoading();
        wx.showToast({ title: '头像上传失败，请重试', icon: 'none' });
      },
    });
  },

  onNicknameBlur(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const value = (e.detail.value || '').trim();
    if (value) this.setData({ nickname: value });
  },

  onNicknameInput(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    const value = (e.detail.value || '').trim();
    if (value) this.setData({ nickname: value });
  },

  async onSave() {
    const nickname = this.data.nickname.trim();
    const avatarUrl = this.data.avatarUrl.trim();

    if (!nickname || nickname === '微信用户') {
      this.setData({ error: '请输入你的昵称' });
      return;
    }

    this.setData({ saving: true, error: '' });
    try {
      const user = await authService.updateProfile({
        nickname: nickname || undefined,
        avatarUrl: avatarUrl || undefined,
      });

      const app = getApp<IAppOption>();
      app.globalData.user = user;
      app.globalData.profileSetupDone = true;
      storage.setCurrentUser(user);

      this.setData({ saving: false });
      wx.showToast({ title: '资料已保存', icon: 'success' });
      setTimeout(() => this.goBack(), 800);
    } catch (e) {
      this.setData({ saving: false, error: getErrorMessage(e, '保存失败') });
    }
  },

  onSkip() {
    getApp<IAppOption>().globalData.profileSetupDone = true;
    this.goBack();
  },

  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack({ delta: 1 });
      return;
    }
    wx.switchTab({ url: '/pages/mine/index' });
  },
});