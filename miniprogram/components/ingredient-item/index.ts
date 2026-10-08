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

    onDelete() {
      this.triggerEvent('delete', { index: this.data.index, item: this.data.item });
    },
  },
});
