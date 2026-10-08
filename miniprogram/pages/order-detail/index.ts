Page({
  data: {
    orderId: '',
  },

  onLoad(query: Record<string, string | undefined>) {
    // 分享链接只携带业务 ID，敏感数据一律由云函数按权限返回
    this.setData({ orderId: query.orderId ?? '' });
  },

  onRefresh() {
    wx.showToast({ title: '点菜详情功能开发中', icon: 'none' });
  },
});
