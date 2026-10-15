Component({
  properties: {
    item: { type: Object, value: {} },
    index: { type: Number, value: 0 },
    categoryLabel: { type: String, value: '' },
  },

  methods: {
    onEdit() {
      this.triggerEvent('edit', { index: this.data.index, item: this.data.item });
    },

    /** 「消耗」：扣减数量，页面侧弹出输入框并计算剩余 */
    onConsume() {
      this.triggerEvent('delete', { index: this.data.index, item: this.data.item, reason: 'consume' });
    },

    /** 「重新补货」：快速增加数量 */
    onRestock() {
      this.triggerEvent('restock', { index: this.data.index, item: this.data.item });
    },

    /** 「查看做法」：跳到包含该食材的菜谱 */
    onRecipes() {
      this.triggerEvent('recipes', { index: this.data.index, item: this.data.item });
    },
  },
});
