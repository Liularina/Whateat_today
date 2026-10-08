Page({
  data: {
    loading: false,
    errorMessage: '',
  },

  onBackToConditions() {
    wx.navigateBack({
      fail: () => {
        wx.redirectTo({ url: '/pages/recommend/index' });
      },
    });
  },

  onRetry() {
    wx.showToast({ title: '推荐功能开发中', icon: 'none' });
  },
});
