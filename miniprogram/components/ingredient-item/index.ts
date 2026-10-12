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

    /** 「已用完」：与删除同义，页面侧走同一套移除流程 */
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
