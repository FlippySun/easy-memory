/**
 * @module embedding-providers
 * @description Embedding Provider 策略模式实现。
 *
 * 提供两种 Provider:
 * - OllamaEmbeddingProvider: 本地 Ollama (bge-m3, 1024 维)
 * - GeminiEmbeddingProvider: 远端 Google Cloud Vertex AI (gemini-embedding-001, MRL 1024 维)
 *
 * 共同职责:
 * - 超时控制 (AbortController)
 * - 指数退避重试
 * - 向量合法性验证 (NaN, Infinity, 维度)
 * - close() 中止所有进行中的请求
 *
 * 铁律: 绝对禁止 console.log (MCP stdio 依赖)
 */

import { log } from "../utils/logger.js";

// =========================================================================
// 向量验证
// =========================================================================

/**
 * 验证 embedding 向量的合法性。
 * 防御 NaN, Infinity, 维度不匹配等脏数据。
 *
 * @param vector  - 待验证的 embedding 向量
 * @param expectedDim - 期望的向量维度
 * @throws 维度不匹配、NaN、Infinity 时抛出 Error
 */
export function validateVector(vector: number[], expectedDim: number): void {
  if (vector.length !== expectedDim) {
    throw new Error(
      `Vector dimension mismatch: got ${vector.length}, expected ${expectedDim}`,
    );
  }
  for (let i = 0; i < vector.length; i++) {
    const v = vector[i]!;
    if (Number.isNaN(v)) {
      throw new Error(`Vector contains NaN at index ${i}`);
    }
    if (!Number.isFinite(v)) {
      throw new Error(`Vector contains Infinity at index ${i}`);
    }
  }
}

// =========================================================================
// Error Classification [FIX H-1]
// =========================================================================

/**
 * 不可重试错误 — 认证失败、请求格式错误等永久性异常。
 * BaseEmbeddingProvider.embed() 捕获此类错误后直接上抛，不进入重试循环。
 *
 * 覆盖场景: HTTP 400 (Bad Request), 401 (Unauthorized), 403 (Forbidden), 404 (Not Found)
 */
export class NonRetryableError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "NonRetryableError";
  }
}

// =========================================================================
// Provider 接口
// =========================================================================

/**
 * Embedding Provider 接口 — 策略模式的核心契约。
 *
 * 所有 Provider 必须实现此接口，以便 EmbeddingService
 * 能够统一路由和降级。
 */
export interface EmbeddingProvider {
  /** Provider 标识符 (e.g. "ollama", "gemini") */
  readonly name: string;
  /** 使用的模型名称 (e.g. "bge-m3") */
  readonly modelName: string;
  /** 输出向量维度 */
  readonly dimension: number;

  /** 生成文本的 embedding 向量 */
  embed(text: string): Promise<number[]>;
  /** 健康检查 */
  healthCheck(): Promise<boolean>;
  /** 释放资源，中止进行中的请求 */
  close(): void;
}

// =========================================================================
// Base Provider (Template Method — 共享重试 / 超时 / AbortController 逻辑)
// =========================================================================

export interface BaseProviderConfig {
  timeoutMs?: number;
  maxRetries?: number;
  /**
   * [FIX C-1] 熔断器状态检查回调。
   * 每次重试前调用，返回 true 表示熔断器已打开，应立即中止重试循环。
   * 防止并发雷暴期间已进入 Provider 重试的请求继续浪费 API 调用。
   */
  isCircuitOpen?: () => boolean;
}

/**
 * Provider 基类 — 封装重试、超时、AbortController 管理。
 *
 * 子类只需实现:
 * - doFetch(text, signal): 执行 HTTP 调用并返回 number[]
 * - healthCheck(): 检查服务可用性
 */
export abstract class BaseEmbeddingProvider implements EmbeddingProvider {
  abstract readonly name: string;
  abstract readonly modelName: string;
  abstract readonly dimension: number;

  protected readonly timeoutMs: number;
  protected readonly maxRetries: number;
  /** [FIX C-1] 外部熔断器状态检查回调 */
  protected readonly isCircuitOpen: (() => boolean) | undefined;

  /** 跟踪所有进行中的请求，以便 close() 全部中止 */
  protected readonly _activeControllers: Set<AbortController> = new Set();
  /** 跟踪 pending retry sleep 的 reject 函数，以便 close() 立即中断 */
  protected readonly _pendingSleepRejects: Set<(reason: Error) => void> =
    new Set();
  /** 标记 close() 是否已被调用，区分 abort 来源 */
  protected _closedByShutdown = false;

  constructor(config: BaseProviderConfig = {}) {
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.maxRetries = config.maxRetries ?? 5;
    this.isCircuitOpen = config.isCircuitOpen;
  }

  /**
   * 生成 embedding 向量 — 含重试 + 向量验证。
   */
  async embed(text: string): Promise<number[]> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      // 前置守卫: close() 后立即中止循环 (不创建新的 sleep/fetch promise)
      if (this._closedByShutdown) {
        throw new Error(
          `${this.name} request aborted: service is shutting down`,
        );
      }

      // [FIX C-1]: 熔断器检查 — 防止并发雷暴期间已进入重试的请求继续浪费 API 调用
      // 仅在 attempt > 0 时检查（首次尝试已在 EmbeddingService 层过滤）
      if (attempt > 0 && this.isCircuitOpen?.()) {
        throw new Error(
          `${this.name} retry aborted: circuit breaker opened during retry`,
        );
      }

      try {
        if (attempt > 0) {
          const delay = this.getRetryDelay(attempt);
          log.info(
            `${this.name} retry ${attempt}/${this.maxRetries}, waiting ${delay}ms`,
          );
          await this.sleep(delay);

          // [FIX F-2]: sleep 后二次检查熔断器 — sleep 期间熔断器可能已打开
          if (this.isCircuitOpen?.()) {
            throw new Error(
              `${this.name} retry aborted: circuit breaker opened during sleep`,
            );
          }
        }

        const vector = await this.safeFetch(text);
        validateVector(vector, this.dimension);
        return vector;
      } catch (err: unknown) {
        // [FIX H-1]: 不可重试错误直接上抛，不进入重试循环
        if (err instanceof NonRetryableError) {
          log.warn(`${this.name} non-retryable error, aborting retry`, {
            error: err.message,
            statusCode: err.statusCode,
          });
          throw err;
        }

        lastError = err instanceof Error ? err : new Error(String(err));
        log.warn(
          `${this.name} attempt ${attempt + 1}/${this.maxRetries} failed`,
          { error: lastError.message },
        );
      }
    }

    throw (
      lastError ?? new Error(`${this.name} embedding failed: unknown error`)
    );
  }

  abstract healthCheck(): Promise<boolean>;

  /**
   * 关闭 Provider，中止所有进行中的请求和 pending sleep。
   */
  close(): void {
    this._closedByShutdown = true;
    for (const controller of this._activeControllers) {
      controller.abort();
    }
    this._activeControllers.clear();

    // 立即中断所有 pending retry sleep (FIX-2: 不再等待 sleep 自然到期)
    const shutdownError = new Error(
      `${this.name} request aborted: service is shutting down`,
    );
    for (const reject of this._pendingSleepRejects) {
      reject(shutdownError);
    }
    this._pendingSleepRejects.clear();
  }

  // ----- Template Method: 子类实现 -----

  /**
   * 执行 HTTP 请求获取 embedding 向量。
   * 子类只需关注 HTTP 调用逻辑，超时/abort 由基类管理。
   */
  protected abstract doFetch(
    text: string,
    signal: AbortSignal,
  ): Promise<number[]>;

  // ----- 可覆盖的策略 -----

  /**
   * 计算第 attempt 次重试的等待时间 (ms)。
   * 默认: 指数退避 (1s, 2s, 4s, 8s...) + ±20% jitter
   *
   * [FIX M-1]: 添加 jitter 防止并发请求重试形成同步脉冲 (Thundering Herd)
   */
  protected getRetryDelay(attempt: number): number {
    const baseDelay = Math.pow(2, attempt - 1) * 1000;
    return Math.round(baseDelay * (0.8 + Math.random() * 0.4));
  }

  // ----- 内部工具 -----

  /**
   * 在 AbortController + timeout 保护下执行 doFetch。
   */
  private async safeFetch(text: string): Promise<number[]> {
    // 前置守卫: close() 后禁止发起新请求 (防止 sleep 期间 close 后重试泄漏)
    if (this._closedByShutdown) {
      throw new Error(`${this.name} request aborted: service is shutting down`);
    }
    const controller = new AbortController();
    this._activeControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      return await this.doFetch(text, controller.signal);
    } catch (err: unknown) {
      // 区分超时中止 vs 主动关闭中止
      if (err instanceof DOMException && err.name === "AbortError") {
        if (this._closedByShutdown) {
          throw new Error(
            `${this.name} request aborted: service is shutting down`,
          );
        }
        throw new Error(
          `${this.name} request timed out after ${this.timeoutMs}ms`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timeout);
      this._activeControllers.delete(controller);
    }
  }

  protected sleep(ms: number): Promise<void> {
    // 前置守卫: 已关闭则立即返回 rejected promise (不进入 constructor)
    if (this._closedByShutdown) {
      return Promise.reject(
        new Error(`${this.name} request aborted: service is shutting down`),
      );
    }
    return new Promise<void>((resolve, reject) => {
      const doReject = (reason: Error): void => {
        clearTimeout(timer);
        this._pendingSleepRejects.delete(doReject);
        reject(reason);
      };
      const timer = setTimeout(() => {
        this._pendingSleepRejects.delete(doReject);
        resolve();
      }, ms);
      this._pendingSleepRejects.add(doReject);
    });
  }
}

// =========================================================================
// Ollama Provider
// =========================================================================

export interface OllamaProviderConfig extends BaseProviderConfig {
  baseUrl?: string;
  model?: string;
  dimension?: number;
}

interface OllamaEmbeddingResponse {
  embedding: number[];
}

/**
 * Ollama Embedding Provider — 本地推理。
 *
 * - Endpoint: POST /api/embeddings
 * - Model: bge-m3 (1024 维)
 * - 默认超时: 120s (首次模型加载需要时间), 5 次重试
 */
export class OllamaEmbeddingProvider extends BaseEmbeddingProvider {
  readonly name = "ollama";
  readonly modelName: string;
  readonly dimension: number;
  private readonly baseUrl: string;

  constructor(config: OllamaProviderConfig = {}) {
    super({
      timeoutMs: config.timeoutMs ?? 120_000,
      maxRetries: config.maxRetries ?? 5,
      ...(config.isCircuitOpen ? { isCircuitOpen: config.isCircuitOpen } : {}),
    });
    this.baseUrl = config.baseUrl ?? "http://localhost:11434";
    this.modelName = config.model ?? "bge-m3";
    this.dimension = config.dimension ?? 1024;
  }

  protected async doFetch(
    text: string,
    signal: AbortSignal,
  ): Promise<number[]> {
    const url = `${this.baseUrl}/api/embeddings`;
    const body = JSON.stringify({ model: this.modelName, prompt: text });

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal,
    });

    if (!response.ok) {
      // [FIX M-3]: 消费 response body 防止 HTTP/1.1 连接泄漏
      try {
        await response.text();
      } catch {
        /* body 读取失败不影响主流程 */
      }
      throw new Error(
        `Ollama embedding failed: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as OllamaEmbeddingResponse;
    if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
      throw new Error("Ollama returned empty embedding");
    }
    return data.embedding;
  }

  async healthCheck(): Promise<boolean> {
    const controller = new AbortController();
    this._activeControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: controller.signal,
      });
      if (!response.ok) return false;

      // [FIX C-3]: 维度探测 — 发送一个短文本获取实际维度
      // 避免运行时 embed 5 次重试后才发现维度不匹配
      // 使用独立的 AbortController + 3s timeout，防止 /api/tags 耗尽共享超时
      try {
        const probeController = new AbortController();
        this._activeControllers.add(probeController);
        const probeTimeout = setTimeout(() => probeController.abort(), 3000);
        try {
          const probeResponse = await fetch(`${this.baseUrl}/api/embeddings`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: this.modelName,
              prompt: "dimension probe",
            }),
            signal: probeController.signal,
          });
          if (probeResponse.ok) {
            const data = (await probeResponse.json()) as {
              embedding?: number[];
            };
            if (Array.isArray(data.embedding) && data.embedding.length > 0) {
              if (data.embedding.length !== this.dimension) {
                log.error(
                  `Ollama ${this.modelName} dimension mismatch: actual=${data.embedding.length}, expected=${this.dimension}. ` +
                    `Check Ollama model version or set OLLAMA_DIMENSION env var.`,
                );
                return false;
              }
              log.info(
                `Ollama ${this.modelName} dimension verified: ${data.embedding.length}d`,
              );
            }
          }
        } finally {
          clearTimeout(probeTimeout);
          this._activeControllers.delete(probeController);
        }
      } catch {
        // 探测失败不阻断 healthCheck — 将在首次 embed 时由 validateVector 捕获
        log.warn("Ollama dimension probe failed, will validate on first embed");
      }

      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
      this._activeControllers.delete(controller);
    }
  }
}

// =========================================================================
// Gemini Provider
// =========================================================================

export interface GeminiProviderConfig extends BaseProviderConfig {
  apiKey: string;
  projectId: string;
  region?: string;
  model?: string;
  outputDimensionality?: number;
}

/**
 * Vertex AI Text Embeddings API 响应格式。
 * @see https://docs.cloud.google.com/vertex-ai/generative-ai/docs/model-reference/text-embeddings-api
 */
interface VertexAIEmbeddingResponse {
  predictions: Array<{
    embeddings: {
      values: number[];
      statistics?: {
        truncated: boolean;
        token_count: number;
      };
    };
  }>;
}

/**
 * Gemini Embedding Provider — 远端 Google Cloud Vertex AI。
 *
 * - Endpoint: POST /v1/projects/{PROJECT}/locations/{REGION}/publishers/google/models/{MODEL}:predict
 * - Model: gemini-embedding-001 (MRL → 1024 维)
 * - Auth: x-goog-api-key header
 * - 默认超时: 30s (远端网络), 3 次重试
 * - 特殊处理: 429 (Rate Limit) 用更长退避
 */
export class GeminiEmbeddingProvider extends BaseEmbeddingProvider {
  readonly name = "gemini";
  readonly modelName: string;
  readonly dimension: number;
  private readonly apiKey: string;
  private readonly projectId: string;
  private readonly region: string;
  private readonly outputDimensionality: number;

  constructor(config: GeminiProviderConfig) {
    super({
      timeoutMs: config.timeoutMs ?? 30_000,
      maxRetries: config.maxRetries ?? 3,
      ...(config.isCircuitOpen ? { isCircuitOpen: config.isCircuitOpen } : {}),
    });
    if (!config.apiKey) {
      throw new Error("Gemini API key is required");
    }
    if (!config.projectId) {
      throw new Error("Gemini Project ID is required");
    }
    this.apiKey = config.apiKey;
    this.projectId = config.projectId;
    this.region = config.region ?? "us-central1";
    this.modelName = config.model ?? "gemini-embedding-001";
    this.outputDimensionality = config.outputDimensionality ?? 1024;
    this.dimension = this.outputDimensionality;
  }

  /**
   * Gemini 429 场景下使用更长的退避间隔 (2s, 4s, 8s...) + ±20% jitter。
   *
   * [FIX M-1]: 添加 jitter 防止并发请求重试形成同步脉冲
   */
  protected getRetryDelay(attempt: number): number {
    const baseDelay = Math.pow(2, attempt - 1) * 2000;
    return Math.round(baseDelay * (0.8 + Math.random() * 0.4));
  }

  protected async doFetch(
    text: string,
    signal: AbortSignal,
  ): Promise<number[]> {
    const url = `https://${this.region}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${this.region}/publishers/google/models/${this.modelName}:predict`;
    const body = JSON.stringify({
      instances: [{ content: text }],
      parameters: { outputDimensionality: this.outputDimensionality },
    });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.apiKey,
      },
      body,
      signal,
    });

    // [FIX H-2]: 解析 429 详情，区分临时限流 vs 配额耗尽 (RESOURCE_EXHAUSTED)
    if (response.status === 429) {
      let isQuotaExhausted = false;
      try {
        const errorBody = await response.text();
        isQuotaExhausted = /RESOURCE_EXHAUSTED|quota|daily.?limit/i.test(
          errorBody,
        );
      } catch {
        /* body 读取失败不影响主流程 */
      }

      if (isQuotaExhausted) {
        // 配额耗尽是不可重试的 — 立即失败，让熔断器快速打开
        throw new NonRetryableError(
          "Gemini quota exhausted (429 RESOURCE_EXHAUSTED)",
          429,
        );
      }
      // 临时限流 — 可重试（由 base class 指数退避处理）
      throw new Error("Gemini rate limited (429)");
    }

    if (!response.ok) {
      // [FIX M-3]: 消费 response body 防止 HTTP/1.1 连接泄漏
      try {
        await response.text();
      } catch {
        /* body 读取失败不影响主流程 */
      }

      // [FIX H-1]: 4xx (非 429/408) 为不可重试错误 — 认证失败、权限不足等
      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 408
      ) {
        throw new NonRetryableError(
          `Gemini embedding failed: ${response.status} ${response.statusText}`,
          response.status,
        );
      }

      // 5xx 服务端错误 — 可重试
      throw new Error(
        `Gemini embedding failed: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as VertexAIEmbeddingResponse;
    const values = data.predictions?.[0]?.embeddings?.values;
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error("Gemini returned empty embedding");
    }
    return values;
  }

  async healthCheck(): Promise<boolean> {
    const controller = new AbortController();
    this._activeControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      // [FIX H-4]: URL 和 headers 包含 projectId 和 API Key。
      // catch 块必须静默返回 false，绝对禁止记录 URL/headers 到日志。
      const url = `https://${this.region}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${this.region}/publishers/google/models/${this.modelName}`;
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { "x-goog-api-key": this.apiKey },
      });
      return response.ok;
    } catch {
      // [FIX H-4]: 静默处理 — 不记录错误详情，防止 API Key/projectId 泄露到堆栈
      return false;
    } finally {
      clearTimeout(timeout);
      this._activeControllers.delete(controller);
    }
  }
}
