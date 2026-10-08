Page({
  data: {
    menuId: '',
  },

  onLoad(query: Record<string, string | undefined>) {
    this.setData({ menuId: query.menuId ?? '' });
  },
});
