Page({
  data: {
    familyId: '',
  },

  onShow() {
    const app = getApp<IAppOption>();
    this.setData({ familyId: app.globalData.currentFamilyId });
  },

  onCreateOrder() {
    wx.showToast({ title: '发起点菜功能开发中', icon: 'none' });
  },
});
