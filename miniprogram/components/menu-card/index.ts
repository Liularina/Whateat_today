Component({
  properties: {
    menu: { type: Object, value: {} },
    /** 餐次中文，例如「晚餐」 */
    mealLabel: { type: String, value: '' },
  },

  methods: {
    onOpen() {
      const menu = this.data.menu as { _id?: string };
      this.triggerEvent('open', { menuId: menu._id ?? '' });
    },
  },
});
