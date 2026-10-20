/**
 * AI 做饭机器人聊天服务（阶段0-功能B）
 */
import { callFunction } from '../utils/cloud';

export interface ChatResult {
  reply: string;
  topicFiltered: boolean;
}

export const chatService = {
  /** 发送聊天消息 */
  sendMessage(message: string, familyId: string): Promise<ChatResult> {
    return callFunction<ChatResult>('chat', 'chat', { message, familyId }, { timeout: 25000 });
  },
};