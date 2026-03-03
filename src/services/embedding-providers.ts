/**
 * @module embedding-providers
 * @description Embedding Provider 策略模式实现。
 *
 * 提供两种 Provider:
 * - OllamaEmbeddingProvider: 本地 Ollama (bge-m3, 1024 维)
 * - GeminiEmbeddingProvider: 远端 Gemini (gemini-embedding-001, MRL 1024 维)
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

  /** 跟踪所有进行中的请求，以便 close() 全部中止 */
  protected readonly _activeControllers: Set<AbortController> = new Set();
  /** 标记 close() 是否已被调用，区分 abort 来源 */
  protected _closedByShutdown = false;

  constructor(config: BaseProviderConfig = {}) {
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.maxRetries = config.maxRetries ?? 5;
  }

  /**
   * 生成 embedding 向量 — 含重试 + 向量验证。
   */
  async embed(text: string): Promise<number[]> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const delay = this.getRetryDelay(attempt);
          log.info(
            `${this.name} retry ${attempt}/${this.maxRetries}, waiting ${delay}ms`,
          );
          await this.sleep(delay);
        }

        const vector = await this.safeFetch(text);
        validateVector(vector, this.dimension);
        return vector;
      } catch (err: unknown) {
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
   * 关闭 Provider，中止所有进行中的请求。
   */
  close(): void {
    this._closedByShutdown = true;
    for (const controller of this._activeControllers) {
      controller.abort();
    }
    this._activeControllers.clear();
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
   * 默认: 指数退避 (1s, 2s, 4s, 8s...)
   */
  protected getRetryDelay(attempt: number): number {
    return Math.pow(2, attempt - 1) * 1000;
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
    return new Promise((resolve) => setTimeout(resolve, ms));
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
  model?: string;
  outputDimensionality?: number;
}

interface GeminiEmbeddingResponse {
  embedding: { values: number[] };
}

/**
 * Gemini Embedding Provider — 远端 Google AI。
 *
 * - Endpoint: POST /v1beta/models/{model}:embedContent
 * - Model: gemini-embedding-001 (MRL → 1024 维)
 * - 默认超时: 30s (远端网络), 3 次重试
 * - 特殊处理: 429 (Rate Limit) 用更长退避
 */
export class GeminiEmbeddingProvider extends BaseEmbeddingProvider {
  readonly name = "gemini";
  readonly modelName: string;
  readonly dimension: number;
  private readonly apiKey: string;
  private readonly outputDimensionality: number;

  constructor(config: GeminiProviderConfig) {
    super({
      timeoutMs: config.timeoutMs ?? 30_000,
      maxRetries: config.maxRetries ?? 3,
    });
    if (!config.apiKey) {
      throw new Error("Gemini API key is required");
    }
    this.apiKey = config.apiKey;
    this.modelName = config.model ?? "gemini-embedding-001";
    this.outputDimensionality = config.outputDimensionality ?? 1024;
    this.dimension = this.outputDimensionality;
  }

  /**
   * Gemini 429 场景下使用更长的退避间隔 (2s, 4s, 8s...)。
   */
  protected getRetryDelay(attempt: number): number {
    return Math.pow(2, attempt - 1) * 2000;
  }

  protected async doFetch(
    text: string,
    signal: AbortSignal,
  ): Promise<number[]> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.modelName}:embedContent`;
    const body = JSON.stringify({
      content: { parts: [{ text }] },
      outputDimensionality: this.outputDimensionality,
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

    if (response.status === 429) {
      throw new Error("Gemini rate limited (429)");
    }

    if (!response.ok) {
      throw new Error(
        `Gemini embedding failed: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as GeminiEmbeddingResponse;
    if (
      !data.embedding?.values ||
      !Array.isArray(data.embedding.values) ||
      data.embedding.values.length === 0
    ) {
      throw new Error("Gemini returned empty embedding");
    }
    return data.embedding.values;
  }

  async healthCheck(): Promise<boolean> {
    const controller = new AbortController();
    this._activeControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.modelName}`,
        {
          signal: controller.signal,
          headers: { "x-goog-api-key": this.apiKey },
        },
      );
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
      this._activeControllers.delete(controller);
    }
  }
}
