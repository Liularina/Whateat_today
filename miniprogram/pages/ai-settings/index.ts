import { aiConfigService } from '../../services/ai-config';
import { getErrorMessage } from '../../utils/cloud';

Page({
  data: {
    /** 保存到云端的配置（不含完整 Key） */
    configured: false,
    savedBaseUrl: '',
    savedModel: '',
    savedMaskedKey: '',

    /** 页面输入 */
    baseUrl: '',
    model: '',
    apiKey: '',

    /** 页面状态 */
    loading: false,
    /** 是否正在获取云端配置 */
    fetching: true,
    error: '',

    /** 测试结果 */
    testResult: '',
    testResultType: '' as '' | 'success' | 'error',
    testing: false,

    /** 删除确认弹窗 */
    showDeleteConfirm: false,
    deleting: false,

    /** 保存成功提示 */
    savedBanner: false,
  },

  onLoad() {
    void this.fetchConfig();
  },

  /* ============================== 数据加载 ============================== */

  async fetchConfig() {
    this.setData({ fetching: true, error: '' });

    try {
      const config = await aiConfigService.getConfig();
      this.setData({
        configured: config.configured,
        savedBaseUrl: config.baseUrl || '',
        savedModel: config.model || '',
        savedMaskedKey: config.maskedApiKey || '',
        baseUrl: config.baseUrl || '',
        model: config.model || '',
        apiKey: '',
        fetching: false,
      });
    } catch (error) {
      this.setData({
        fetching: false,
        error: getErrorMessage(error, '配置加载失败'),
      });
    }
  },

  /* ============================== 输入 ============================== */

  onBaseUrlInput(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ baseUrl: e.detail.value, savedBanner: false });
  },

  onModelInput(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ model: e.detail.value, savedBanner: false });
  },

  onApiKeyInput(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ apiKey: e.detail.value, savedBanner: false });
  },

  /* ============================== 操作 ============================== */

  async onSave() {
    const baseUrl = (this.data.baseUrl || '').trim();
    const model = (this.data.model || '').trim();
    const apiKey = (this.data.apiKey || '').trim();

    if (!baseUrl) {
      wx.showToast({ title: '请输入 API Base URL', icon: 'none' });
      return;
    }
    if (!baseUrl.startsWith('https://')) {
      wx.showToast({ title: 'Base URL 必须以 https:// 开头', icon: 'none' });
      return;
    }
    if (!model) {
      wx.showToast({ title: '请输入模型名称', icon: 'none' });
      return;
    }
    if (!this.data.configured && !apiKey) {
      wx.showToast({ title: '首次配置时必须填写 API Key', icon: 'none' });
      return;
    }

    this.setData({ loading: true, error: '', savedBanner: false });

    try {
      const result = await aiConfigService.saveConfig({ baseUrl, model, apiKey });

      this.setData({
        configured: true,
        savedBaseUrl: result.baseUrl,
        savedModel: result.model,
        savedMaskedKey: result.maskedApiKey,
        apiKey: '', // 清空输入
        loading: false,
        savedBanner: true,
      });

      wx.showToast({ title: '保存成功', icon: 'success' });
    } catch (error) {
      this.setData({
        loading: false,
        error: getErrorMessage(error, '保存失败'),
      });
    }
  },

  async onTestConnection() {
    const baseUrl = (this.data.baseUrl || '').trim();
    const model = (this.data.model || '').trim();
    const apiKey = (this.data.apiKey || '').trim();

    if (!baseUrl || !model) {
      wx.showToast({ title: '请先填写 Base URL 和模型名称', icon: 'none' });
      return;
    }

    // 用当前表单的临时 Key 测试；如果没填 Key 但有已保存配置，用已保存的测试
    if (!apiKey && !this.data.configured) {
      wx.showToast({ title: '请填写 API Key', icon: 'none' });
      return;
    }

    this.setData({ testing: true, testResult: '', testResultType: '' });

    try {
      let result;
      if (apiKey) {
        // 用临时输入测试
        result = await aiConfigService.testConnection(baseUrl, model, apiKey);
      } else {
        // 用已保存的测试
        result = await aiConfigService.testSavedConfig();
      }

      this.setData({
        testing: false,
        testResult: result.message,
        testResultType: result.connected ? 'success' : 'error',
      });
    } catch (error) {
      this.setData({
        testing: false,
        testResult: getErrorMessage(error, '测试失败'),
        testResultType: 'error',
      });
    }
  },

  onTapDelete() {
    if (!this.data.configured) {
      wx.showToast({ title: '没有可删除的配置', icon: 'none' });
      return;
    }
    this.setData({ showDeleteConfirm: true });
  },

  onCancelDelete() {
    this.setData({ showDeleteConfirm: false });
  },

  async onConfirmDelete() {
    this.setData({ showDeleteConfirm: false, deleting: true, error: '' });

    try {
      await aiConfigService.deleteConfig();

      this.setData({
        configured: false,
        savedBaseUrl: '',
        savedModel: '',
        savedMaskedKey: '',
        baseUrl: '',
        model: '',
        apiKey: '',
        deleting: false,
        testResult: '',
        testResultType: '',
      });

      wx.showToast({ title: '已删除配置', icon: 'success' });
    } catch (error) {
      this.setData({
        deleting: false,
        error: getErrorMessage(error, '删除失败'),
      });
    }
  },

  onRetry() {
    void this.fetchConfig();
  },
});