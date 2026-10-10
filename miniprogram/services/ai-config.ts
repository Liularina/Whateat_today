/**
 * AI 配置服务（Phase 7）
 *
 * 封装 ai-config 云函数调用：配置查询、保存、删除、连接测试。
 * API Key 不在此层缓存或本地存储。
 */
import { AI_REQUEST_TIMEOUT } from '../constants/config';
import type {
  AiConfigInfo,
  AiConfigInput,
  AiConfigDeleteResult,
  AiConfigTestResult,
} from '../types/ai-config';
import { callFunction } from '../utils/cloud';

export const aiConfigService = {
  /** 获取当前用户的非敏感配置 */
  getConfig(): Promise<AiConfigInfo> {
    return callFunction<AiConfigInfo>('ai-config', 'getAiConfig');
  },

  /** 保存或更新配置 */
  saveConfig(input: AiConfigInput): Promise<{ baseUrl: string; model: string; maskedApiKey: string }> {
    return callFunction('ai-config', 'saveAiConfig', {
      baseUrl: input.baseUrl,
      model: input.model,
      apiKey: input.apiKey,
    });
  },

  /** 删除配置 */
  deleteConfig(): Promise<AiConfigDeleteResult> {
    return callFunction('ai-config', 'deleteAiConfig');
  },

  /** 测试连接：用临时配置测试（保存前） */
  testConnection(tempBaseUrl: string, tempModel: string, tempApiKey: string): Promise<AiConfigTestResult> {
    return callFunction<AiConfigTestResult>('ai-config', 'testAiConfig', {
      tempBaseUrl,
      tempModel,
      tempApiKey,
    }, { timeout: AI_REQUEST_TIMEOUT });
  },

  /** 测试已保存的配置 */
  testSavedConfig(): Promise<AiConfigTestResult> {
    return callFunction<AiConfigTestResult>('ai-config', 'testAiConfig', {}, { timeout: AI_REQUEST_TIMEOUT });
  },
};