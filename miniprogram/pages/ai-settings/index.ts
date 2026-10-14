import { aiConfigService } from '../../services/ai-config';
import type { AiMode } from '../../types/ai-config';
import { getErrorMessage } from '../../utils/cloud';

Page({
  data: {
    /** 当前生效的 AI 模式 */
    mode: 'builtin' as AiMode,
    /** 切换模式请求进行中 */
    switchingMode: false,

    /** 内置 AI 状态 */
    builtinEnabled: false,
    builtinReady: false,
    builtinDailyQuota: 0,
    /** 今日内置额度剩余次数 */
    quotaRemaining: 0,
    quotaUsed: 0,

    /** 自定义配置表单是否展开 */
    customFormOpen: false,

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
      const mode = config.mode || 'builtin';
      const builtin = config.builtin || { enabled: false, ready: false, dailyQuota: 0 };
      const quota = config.quota || { dailyQuota: 0, used: 0, remaining: 0 };

      this.setData({
        mode: mode,
        builtinEnabled: !!builtin.enabled,
        builtinReady: !!builtin.ready,
        builtinDailyQuota: builtin.dailyQuota || 0,
        quotaRemaining: quota.remaining || 0,
        quotaUsed: quota.used || 0,
        configured: config.configured,
        savedBaseUrl: config.baseUrl || '',
        savedModel: config.model || '',
        savedMaskedKey: config.maskedApiKey || '',
        baseUrl: config.baseUrl || '',
        model: config.model || '',
        apiKey: '',
        // 自定义模式，或内置不可用时，直接展开表单 —— 否则用户没有可走的路
        customFormOpen: mode === 'custom' || !builtin.ready,
        fetching: false,
      });
    } catch (error) {
      this.setData({
        fetching: false,
        error: getErrorMessage(error, '配置加载失败'),
      });
    }
  },

  /* ============================== 模式切换 ============================== */

  /**
   * 切换 AI 模式。
   *
   * 切到自定义模式前要求已有配置（服务端会再校验一次）：
   * 没配置就切过去，之后每次调用都失败，不如现在就提示。
   */
  async onSelectMode(e: WechatMiniprogram.CustomEvent<{ mode?: AiMode }>) {
    const mode = (e.currentTarget && (e.currentTarget.dataset as { mode?: AiMode }).mode) ||
      (e.detail && e.detail.mode);
    if (!mode || mode === this.data.mode || this.data.switchingMode) {
      return;
    }

    if (mode === 'custom' && !this.data.configured) {
      this.setData({ mode: 'custom', customFormOpen: true, savedBanner: false });
      wx.showToast({ title: '请先填写并保存 API 配置', icon: 'none' });
      return;
    }

    this.setData({ switchingMode: true, error: '', savedBanner: false });

    try {
      const result = await aiConfigService.setMode(mode);
      const nextMode = (result && result.mode) || mode;
      this.setData({
        mode: nextMode,
        customFormOpen: nextMode === 'custom',
        switchingMode: false,
      });
      wx.showToast({
        title: nextMode === 'builtin' ? '已切换到内置 AI' : '已切换到自定义 API',
        icon: 'none',
      });
      // 额度会随模式变化，重新拉一次状态
      await this.fetchConfig();
    } catch (error) {
      this.setData({
        switchingMode: false,
        error: getErrorMessage(error, '模式切换失败'),
      });
    }
  },

  onToggleCustomForm() {
    this.setData({ customFormOpen: !this.data.customFormOpen });
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
      // 首次配置后内置额度等状态不变，但模式可切，重新拉一次保持一致
      await this.fetchConfig();
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
      const result = await aiConfigService.deleteConfig();

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

      wx.showToast({
        title: result && result.modeReset ? '已删除，并切回内置 AI' : '已删除配置',
        icon: 'success',
      });
      // 模式可能已被服务端退回内置，以服务端状态为准
      await this.fetchConfig();
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