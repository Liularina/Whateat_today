Component({
  properties: {
    item: { type: Object, value: {} },
    index: { type: Number, value: 0 },
    locked: { type: Boolean, value: false },
  },

  methods: {
    onOpen() {
      this.triggerEvent('open', { index: this.data.index });
    },

    onReplace() {
      this.triggerEvent('replace', { index: this.data.index });
    },

    onToggleLock() {
      this.triggerEvent('lock', { index: this.data.index, locked: !this.data.locked });
    },
  },
});
