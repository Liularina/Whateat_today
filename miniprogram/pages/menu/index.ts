type MenuTab = 'today' | 'history';

Page({
  data: {
    activeTab: 'today' as MenuTab,
  },

  onSwitchTab(e: WechatMiniprogram.TouchEvent) {
    const tab = e.currentTarget.dataset.tab as MenuTab;
    this.setData({ activeTab: tab });
  },

  onGoHome() {
    wx.switchTab({ url: '/pages/home/index' });
  },
});
