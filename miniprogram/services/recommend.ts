/**
 * 推荐服务（Phase 7）
 *
 * AI 调用较慢，因此使用更长的超时时间；
 * 服务端会先做硬过滤（过敏 / 忌口）再调用 AI，并对 AI 输出做二次校验与营养重算。
 */
import type {
  RecommendConditions,
  Recommendation,
  ReplaceDishInput,
  ReplaceDishResult,
} from '../types/recommend';
import type { RecommendMenusInput, RecommendMenusResult } from '../types/ai-config';
import { AI_REQUEST_TIMEOUT } from '../constants/config';
import { callFunction } from '../utils/cloud';

export const recommendService = {
  /** Phase 7：基于家庭食材和菜谱库的 AI 推荐 */
  recommendMenus(input: RecommendMenusInput): Promise<RecommendMenusResult> {
    return callFunction<RecommendMenusResult, RecommendMenusInput>(
      'recommend',
      'recommendMenus',
      input,
      { timeout: AI_REQUEST_TIMEOUT },
    );
  },

  /** Phase 8 预留：生成 3 套候选菜单 */
  generateRecommendations(conditions: RecommendConditions): Promise<Recommendation> {
    return callFunction<Recommendation, RecommendConditions>(
      'recommend',
      'generateRecommendations',
      conditions,
      { timeout: AI_REQUEST_TIMEOUT },
    );
  },

  /** Phase 8 预留：换一换 */
  replaceDish(input: ReplaceDishInput): Promise<ReplaceDishResult> {
    return callFunction<ReplaceDishResult, ReplaceDishInput>('recommend', 'replaceDish', input, {
      timeout: AI_REQUEST_TIMEOUT,
    });
  },
};
