Component({
  properties: {
    emoji: { type: String, value: '🍽️' },
    /**
     * 可选插画，替代 emoji：目前支持 plate（手绘餐盘）。
     * emoji 里的 📅 在部分机型会固定显示「17 / July」，与真实日期不符，需要插画时用它。
     */
    icon: { type: String, value: '' },
    title: { type: String, value: '这里还没有内容' },
    description: { type: String, value: '' },
    actionText: { type: String, value: '' },
  },

  methods: {
    onAction() {
      this.triggerEvent('action');
    },
  },
});
