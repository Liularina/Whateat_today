Component({
  properties: {
    item: { type: Object, value: {} },
    index: { type: Number, value: 0 },
    quantity: { type: Number, value: 0 },
    canEdit: { type: Boolean, value: true },
  },

  methods: {
    onIncrease() {
      if (!this.data.canEdit) {
        return;
      }
      this.triggerEvent('change', { index: this.data.index, quantity: this.data.quantity + 1 });
    },

    onDecrease() {
      if (!this.data.canEdit || this.data.quantity <= 0) {
        return;
      }
      this.triggerEvent('change', { index: this.data.index, quantity: this.data.quantity - 1 });
    },

    onRemarkInput(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
      this.triggerEvent('remark', { index: this.data.index, remark: e.detail.value });
    },
  },
});
