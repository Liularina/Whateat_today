Page({
  data: {
    menuId: '',
    recipeId: '',
  },

  onLoad(query: Record<string, string | undefined>) {
    this.setData({
      menuId: query.menuId ?? '',
      recipeId: query.recipeId ?? '',
    });
  },

  onRetry() {
    wx.showToast({ title: '做法生成功能开发中', icon: 'none' });
  },
});
