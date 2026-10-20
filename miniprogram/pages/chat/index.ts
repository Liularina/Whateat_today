/**
 * AI 做饭机器人对话页（阶段0-功能B）
 *
 * 通过 chat 云函数与 AI 对话，复用现有 AI 服务与额度管理。
 */
import { chatService, type ChatResult } from '../../services/chat';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

Page({
  data: {
    messages: [] as ChatMessage[],
    inputText: '',
    loading: false,
    error: '',
    scrollTop: 0,
  },

  _lastMessageId: 0,

  onInput(e: WechatMiniprogram.CustomEvent<{ value: string }>) {
    this.setData({ inputText: e.detail.value, error: '' });
  },

  /** 点击快捷提问 */
  onTapQuick(e: WechatMiniprogram.TouchEvent) {
    const text = String(e.currentTarget.dataset.text || '');
    if (text) {
      this.setData({ inputText: text });
      this.doSend(text);
    }
  },

  /** 发送消息 */
  onSend() {
    const text = this.data.inputText.trim();
    if (!text || this.data.loading) return;
    this.doSend(text);
  },

  async doSend(text: string) {
    const app = getApp<IAppOption>();
    const familyId = app.globalData.currentFamilyId || '';

    // 添加用户消息
    const userMsg: ChatMessage = {
      id: 'u' + (++this._lastMessageId),
      role: 'user',
      content: text,
    };
    const messages = [...this.data.messages, userMsg];

    this.setData({
      messages: messages,
      inputText: '',
      loading: true,
      error: '',
    });
    this.scrollToBottom();

    try {
      const result: ChatResult = await chatService.sendMessage(text, familyId);
      const botMsg: ChatMessage = {
        id: 'b' + (++this._lastMessageId),
        role: 'assistant',
        content: result.reply,
      };
      this.setData({
        messages: [...this.data.messages, botMsg],
        loading: false,
      });
    } catch (error) {
      const err = error as { code?: string; message?: string };
      this.setData({
        loading: false,
        error: err.message || 'AI 回复失败，请稍后重试',
      });
    }
    this.scrollToBottom();
  },

  /** 重试最后一条消息 */
  onRetry() {
    // 找到最后一条用户消息
    const userMsgs = this.data.messages.filter((m) => m.role === 'user');
    if (userMsgs.length === 0) return;
    const lastUser = userMsgs[userMsgs.length - 1];

    // 移除最后一条 bot 消息和错误
    const msgs = this.data.messages.slice();
    while (msgs.length > 0 && msgs[msgs.length - 1].role !== 'user') {
      msgs.pop();
    }
    this.setData({ messages: msgs, error: '' });
    this.doSend(lastUser.content);
  },

  /** 滚动到底部 */
  scrollToBottom() {
    setTimeout(() => {
      this.setData({ scrollTop: 999999 });
    }, 100);
  },
});