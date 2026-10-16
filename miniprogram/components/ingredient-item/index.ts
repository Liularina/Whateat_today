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
      this.triggerEvent('consume', { index: this.data.index, item: this.data.item });
    },

    /** 「重新补货」：快速增加数量 */
    onRestock() {
      this.triggerEvent('restock', { index: this.data.index, item: this.data.item });
    },

    /** 「查看做法」：跳到包含该食材的菜谱 */
    onRecipes() {
      this.triggerEvent('recipes', { index: this.data.index, item: this.data.item });
    },

    /** 「删除」：直接从库存移除，页面侧必须二次确认 */
    onRemove() {
      this.triggerEvent('remove', { index: this.data.index, item: this.data.item });
    },
  },
});
