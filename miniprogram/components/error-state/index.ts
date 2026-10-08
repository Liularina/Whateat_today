Component({
  properties: {
    title: { type: String, value: '出了点小问题' },
    description: { type: String, value: '' },
    retryText: { type: String, value: '重新加载' },
  },

  methods: {
    onRetry() {
      this.triggerEvent('retry');
    },
  },
});
