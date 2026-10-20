/**
 * 语音录入组件（阶段0-功能A）
 *
 * 使用 WechatSI 插件进行语音识别，把语音转为文本后通过事件传给父页面。
 * 本组件只负责录音与识别，不负责解析食材字段。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

let plugin: { getRecordRecognitionManager: () => any } | null = null;

try {
  plugin = requirePlugin('WechatSI') as typeof plugin;
} catch (_e) {
  plugin = null;
  console.warn('[voice-input] WechatSI 插件未就绪');
}

type ViStatus = 'idle' | 'recording' | 'done' | 'error';

Component({
  properties: {
    /** 按钮文案 */
    btnLabel: { type: String, value: '语音录入' },
  },

  data: {
    status: 'idle' as ViStatus,
    recognizedText: '',
    errorMsg: '',
  },

  lifetimes: {
    attached() {
      this.initManager();
    },
    detached() {
      this.stopAndClear();
    },
  },

  methods: {
    _manager: null as any,
    _timeoutId: null as any,

    initManager() {
      if (!plugin) return;

      try {
        this._manager = plugin.getRecordRecognitionManager();
      } catch (_e) {
        console.warn('[voice-input] 获取 RecordRecognitionManager 失败');
      }
    },

    /** 停止录音并清空管理器回调 */
    stopAndClear() {
      if (this._timeoutId) { clearTimeout(this._timeoutId); this._timeoutId = null; }
      if (this._manager) {
        try { this._manager.stop(); this._manager.onStop = undefined; this._manager.onError = undefined; } catch (_e) { /* 静默 */ }
      }
    },

    /** 开始录音 */
    onStartRecord() {
      if (!plugin || !this._manager) {
        this.setData({ status: 'error', errorMsg: '当前环境不支持语音识别' });
        return;
      }

      // 先确保上次已释放
      this.stopAndClear();
      if (!this._manager) return;

      this.setData({ status: 'recording', recognizedText: '', errorMsg: '' });

      // 最多录 15 秒
      this._timeoutId = setTimeout(() => {
        this.onStopRecord();
      }, 15000);

      // 监听事件
      this._manager.onStart = () => {
        /* recording already set */
      };

      this._manager.onRecognize = (_res: { result: string }) => {
        /* 实时中间结果，暂不做流式展示 */
      };

      this._manager.onStop = (res: { result: string; tempFilePath: string }) => {
        if (this._timeoutId) { clearTimeout(this._timeoutId); this._timeoutId = null; }
        const text = (res && res.result || '').trim();
        if (text) {
          this.setData({ status: 'done', recognizedText: text });
        } else {
          this.setData({ status: 'error', errorMsg: '未识别到语音，请靠近麦克风再说一次' });
        }
      };

      this._manager.onError = (res: { msg: string; retcode: number }) => {
        if (this._timeoutId) { clearTimeout(this._timeoutId); this._timeoutId = null; }
        this.setData({
          status: 'error',
          errorMsg: res.msg || '语音识别失败，请检查网络后重试',
        });
      };

      try {
        this._manager.start({
          duration: 15000,
          lang: 'zh_CN',
        });
      } catch (error: any) {
        if (this._timeoutId) { clearTimeout(this._timeoutId); this._timeoutId = null; }
        this.setData({
          status: 'error',
          errorMsg: (error && error.errMsg) ? error.errMsg : '录音启动失败，请检查麦克风权限',
        });
      }
    },

    /** 停止录音 */
    onStopRecord() {
      if (this._manager) {
        try { this._manager.stop(); } catch (_e) { /* 静默 */ }
      }
    },

    /** 点击填入表单：把识别文本传出去 */
    onFill() {
      if (!this.data.recognizedText) return;
      this.triggerEvent('recognized', { text: this.data.recognizedText });
    },

    /** 重置到空闲状态 */
    reset() {
      this.stopAndClear();
      this.setData({ status: 'idle', recognizedText: '', errorMsg: '' });
    },
  },
});