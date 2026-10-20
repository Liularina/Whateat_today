/**
 * 云函数调用统一封装
 *
 * 约束（见开发规范第 89 条）：
 * 页面不得直接散落调用 wx.cloud.callFunction，必须经由 service 层 → 本文件。
 * 所有异常都会被转换为 AppError，保证页面能拿到可展示的中文提示，不会白屏。
 */
import {
  CLOUD_ENV_NOT_CONFIGURED_MESSAGE,
  CLOUD_ERROR_CODES,
  REQUEST_TIMEOUT,
  isCloudEnvConfigured,
} from '../constants/config';

/** 结构化错误体（Phase 2 起云函数同时返回 error 字段） */
export interface CloudErrorInfo {
  code: string;
  message: string;
}

/**
 * 云函数统一响应信封（与各云函数 index.js 中的 ok / fail 保持一致）。
 *
 * 兼容性说明：success / data / code / message 是 Phase 1 既有字段，保持不变；
 * error / requestId 是 Phase 2 追加的结构化字段，属于向后兼容的增量。
 */
export interface CloudEnvelope<T> {
  success: boolean;
  data: T | null;
  code?: string;
  message?: string;
  error?: CloudErrorInfo | null;
  requestId?: string;
}

/** 业务错误：code 用于程序判断，message 用于直接展示 */
export class AppError extends Error {
  readonly code: string;
  /** 云函数 requestId，用于把前端提示与服务端日志对应（不展示给用户） */
  readonly requestId: string;

  constructor(code: string, message: string, requestId = '') {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.requestId = requestId;
  }
}

export interface CallFunctionOptions {
  /** 是否展示全局 loading，默认关闭（页面应使用自有 loading 状态） */
  showLoading?: boolean;
  loadingTitle?: string;
  /** 超时时间（毫秒） */
  timeout?: number;
}

/**
 * 调用云函数。
 *
 * @param name 云函数名，例如 'recommend'
 * @param action 业务动作，例如 'generateRecommendations'
 * @param payload 业务参数（familyId 会由云函数结合当前登录态二次校验）
 */
export async function callFunction<TData, TPayload extends object = Record<string, unknown>>(
  name: string,
  action: string,
  payload?: TPayload,
  options: CallFunctionOptions = {},
): Promise<TData> {
  const {
    showLoading = false,
    loadingTitle = '加载中...',
    timeout = REQUEST_TIMEOUT,
  } = options;

  if (showLoading) {
    wx.showLoading({ title: loadingTitle, mask: true });
  }

  try {
    if (!wx.cloud) {
      throw new AppError('CLOUD_UNAVAILABLE', '当前基础库不支持云开发，请升级微信后重试');
    }

    // 云环境未配置时直接给出明确提示，避免开发者看到 undefined / cannot read property 之类的内部报错
    if (!isCloudEnvConfigured()) {
      throw new AppError(CLOUD_ERROR_CODES.CLOUD_NOT_READY, CLOUD_ENV_NOT_CONFIGURED_MESSAGE);
    }

    const res = await withTimeout(
      wx.cloud.callFunction({
        name,
        data: { action, ...(payload ?? {}) },
      }),
      timeout,
      name,
    );

    const envelope = (res as { result?: unknown }).result as CloudEnvelope<TData> | undefined;

    if (!envelope || typeof envelope !== 'object' || typeof envelope.success !== 'boolean') {
      throw new AppError('INVALID_RESPONSE', '服务返回数据异常，请稍后重试');
    }

    if (!envelope.success) {
      const info = envelope.error ?? null;
      throw new AppError(
        info?.code ?? envelope.code ?? 'UNKNOWN',
        info?.message ?? envelope.message ?? '操作失败，请稍后重试',
        envelope.requestId ?? '',
      );
    }

    return envelope.data as TData;
  } catch (error) {
    throw normalizeError(error, name);
  } finally {
    if (showLoading) {
      wx.hideLoading();
    }
  }
}

/** 把任意异常转换为 AppError，保证上层总能拿到 code + 中文提示 */
export function normalizeError(error: unknown, taskName = ''): AppError {
  if (error instanceof AppError) {
    return error;
  }

  // 兼容 WeChat 云函数返回的 {errCode, errMsg} 普通对象
  let rawMessage: string;
  if (error instanceof Error) {
    rawMessage = error.message;
  } else if (error && typeof error === 'object') {
    const wechatErr = error as { errCode?: number; errMsg?: string; message?: string };
    rawMessage = wechatErr.errMsg || wechatErr.message || String(error);
  } else {
    rawMessage = String(error ?? '');
  }

  if (/timeout|超时/i.test(rawMessage)) {
    return new AppError('TIMEOUT', '请求超时，请检查网络后重试');
  }

  // 函数不存在（未部署）：-501000
  if (/FunctionName parameter could not be found|-501000|FUNCTION_NOT_FOUND|FunctionName.*not found/i.test(rawMessage)) {
    return new AppError(
      'CLOUD_FUNCTION_UNAVAILABLE',
      `云函数${taskName ? ` ${taskName} ` : ''}不存在，请先在开发者工具中上传部署`,
    );
  }

  // 函数存在但执行失败（抛错/依赖缺失/超时）：-504002 / -504003
  // 注意：这类错误最容易被误判成「未部署」，实际应查看云函数日志
  if (/-504002|-504003|functions execute fail|function execution|function has no|FunctionName parameter error/i.test(rawMessage)) {
    return new AppError(
      'CLOUD_FUNCTION_ERROR',
      `云函数${taskName ? ` ${taskName} ` : ''}执行失败，请查看云函数日志`,
    );
  }

  if (/cloud\.?callFunction|cloud function/i.test(rawMessage)) {
    return new AppError(
      'CLOUD_FUNCTION_UNAVAILABLE',
      `云函数${taskName ? ` ${taskName} ` : ''}暂时不可用，请稍后重试`,
    );
  }

  return new AppError(CLOUD_ERROR_CODES.NETWORK_ERROR, '当前网络不可用，请检查网络后重试');
}

/** 取用于展示的错误文案 */
export function getErrorMessage(error: unknown, fallback = '操作失败，请稍后重试'): string {
  if (error instanceof AppError) {
    return error.message;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

/** 取错误码，用于程序分支判断 */
export function getErrorCode(error: unknown): string {
  if (error instanceof AppError) {
    return error.code;
  }
  return 'UNKNOWN';
}

function withTimeout<T>(promise: Promise<T>, ms: number, taskName: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      reject(new AppError('TIMEOUT', `请求超时（${taskName}），请稍后重试`));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (reason: unknown) => {
        clearTimeout(timer);
        reject(reason);
      },
    );
  });
}
