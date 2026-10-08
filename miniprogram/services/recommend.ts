/**
 * 推荐服务
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
import { AI_REQUEST_TIMEOUT } from '../constants/config';
import { callFunction } from '../utils/cloud';

export const recommendService = {
  /** 生成 3 套候选菜单 */
  generateRecommendations(conditions: RecommendConditions): Promise<Recommendation> {
    return callFunction<Recommendation, RecommendConditions>(
      'recommend',
      'generateRecommendations',
      conditions,
      { timeout: AI_REQUEST_TIMEOUT },
    );
  },

  /** 换一换：只替换目标菜品，锁定菜品不受影响 */
  replaceDish(input: ReplaceDishInput): Promise<ReplaceDishResult> {
    return callFunction<ReplaceDishResult, ReplaceDishInput>('recommend', 'replaceDish', input, {
      timeout: AI_REQUEST_TIMEOUT,
    });
  },
};
