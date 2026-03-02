/**
 * @module embedding
 * @description 统一 Embedding 服务门面 (Facade) — 策略路由 + 自动降级。
 *
 * 对上层 (save.ts, search.ts, status.ts) 屏蔽底层 Provider 差异:
 * - embed(text)        → 返回 number[] (向后兼容)
 * - embedWithMeta(text) → 返回 { vector, model, provider } (精确元数据)
 *
 * 降级策略:
 * - 当 providers 有多个且 fallbackEnabled=true 时，
 *   主 Provider 失败后自动尝试下一个，直到成功或全部耗尽。
 *
 * 铁律: 绝对禁止 console.log (MCP stdio 依赖)
 */

import { log } from "../utils/logger.js";
import type { EmbeddingProvider } from "./embedding-providers.js";

// Re-export provider types for convenience
export type { EmbeddingProvider } from "./embedding-providers.js";
export {
  OllamaEmbeddingProvider,
  GeminiEmbeddingProvider,
  validateVector,
  type OllamaProviderConfig,
  type GeminiProviderConfig,
} from "./embedding-providers.js";

// =========================================================================
// Types
// =========================================================================

/**
 * 带元数据的 Embedding 结果。
 * 用于 save.ts 记录实际使用的模型和 Provider。
 */
export interface EmbeddingResult {
  /** 768 维浮点向量 */
  vector: number[];
  /** 实际使用的模型名 (e.g. "nomic-embed-text") */
  model: string;
  /** 实际使用的 Provider (e.g. "ollama", "gemini") */
  provider: string;
}

/**
 * EmbeddingService 配置。
 */
export interface EmbeddingServiceConfig {
  /** Provider 列表，按优先级排序 (index 0 为主 Provider) */
  providers: EmbeddingProvider[];
  /** 是否启用降级 (默认: providers > 1 时自动启用) */
  fallbackEnabled?: boolean;
  /**
   * Provider 过滤器 — 在每次 embed 时调用，返回 false 跳过该 Provider。
   * 用于熔断器场景：Gemini 预算耗尽时动态跳过 Gemini。
   */
  shouldUseProvider?: (provider: EmbeddingProvider) => boolean;
  /**
   * embed 成功回调 — 在向量化成功后调用，用于成本追踪。
   * 通过 result.provider 判断实际使用的 Provider 并记录计费。
   */
  onSuccess?: (result: EmbeddingResult) => void;
}

// =========================================================================
// EmbeddingService (Unified Facade)
// =========================================================================

/**
 * 统一 Embedding 服务 — 策略路由 + 自动降级。
 *
 * 对 save/search/status 工具暴露统一接口:
 * - embed(): 返回 number[]，向后兼容
 * - embedWithMeta(): 返回 EmbeddingResult，含实际 model/provider
 * - healthCheck(): 任一 Provider 可用即返回 true
 * - close(): 级联关闭所有 Provider
 */
export class EmbeddingService {
  private readonly providers: EmbeddingProvider[];
  private readonly fallbackEnabled: boolean;
  private readonly shouldUseProvider:
    | ((provider: EmbeddingProvider) => boolean)
    | undefined;
  private readonly onSuccess: ((result: EmbeddingResult) => void) | undefined;

  constructor(config: EmbeddingServiceConfig) {
    if (!config.providers || config.providers.length === 0) {
      throw new Error("At least one embedding provider is required");
    }
    this.providers = config.providers;
    this.fallbackEnabled =
      config.fallbackEnabled ?? config.providers.length > 1;
    this.shouldUseProvider = config.shouldUseProvider;
    this.onSuccess = config.onSuccess;
  }

  /**
   * 生成 embedding 向量 (向后兼容)。
   *
   * @param text - 输入文本
   * @returns 浮点向量
   * @throws 所有 Provider 均失败后抛出最后一个错误
   */
  async embed(text: string): Promise<number[]> {
    const result = await this.embedWithMeta(text);
    return result.vector;
  }

  /**
   * 生成 embedding 向量，附带实际使用的 Provider 和模型元数据。
   *
   * 降级流程:
   * 1. 尝试 providers[0] (主 Provider)
   * 2. 若失败且 fallbackEnabled，尝试 providers[1]
   * 3. 依次类推，直到成功或全部耗尽
   *
   * @param text - 输入文本
   * @returns EmbeddingResult { vector, model, provider }
   * @throws 所有 Provider 均失败后抛出最后一个错误
   */
  async embedWithMeta(text: string): Promise<EmbeddingResult> {
    let lastError: Error | null = null;

    // 应用 Provider 过滤器（熔断器可在此处跳过 Gemini）
    const usableProviders = this.shouldUseProvider
      ? this.providers.filter((p) => this.shouldUseProvider!(p))
      : this.providers;

    if (usableProviders.length === 0) {
      throw new Error(
        "All embedding providers were skipped by cost guard filter",
      );
    }

    for (let i = 0; i < usableProviders.length; i++) {
      const provider = usableProviders[i]!;
      const isLastProvider = i === usableProviders.length - 1;

      try {
        const vector = await provider.embed(text);

        // 降级成功时输出警告
        if (i > 0) {
          log.warn(`Fallback to ${provider.name} succeeded`, {
            originalProvider: usableProviders[0]!.name,
            fallbackProvider: provider.name,
          });
        }

        const result: EmbeddingResult = {
          vector,
          model: provider.modelName,
          provider: provider.name,
        };

        // 通知成功回调（成本追踪）— 回调异常不应丢失已生成的向量
        try {
          this.onSuccess?.(result);
        } catch (cbErr: unknown) {
          log.warn("onSuccess callback failed (vector preserved)", {
            error: cbErr instanceof Error ? cbErr.message : String(cbErr),
          });
        }

        return result;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        log.warn(`Provider ${provider.name} failed`, {
          error: lastError.message,
          willFallback: this.fallbackEnabled && !isLastProvider,
        });

        // 不降级或已是最后一个 → 直接抛出
        if (!this.fallbackEnabled || isLastProvider) {
          throw lastError;
        }
        // 继续尝试下一个 Provider (fallback)
      }
    }

    // 不可达 (循环内最后一个 provider 失败时已 throw)
    // TypeScript 安全网
    throw lastError ?? new Error("All embedding providers failed");
  }

  /**
   * 健康检查 — 任一 Provider 可用即返回 true。
   */
  async healthCheck(): Promise<boolean> {
    // 防御性: 即使某个 Provider 的 healthCheck() 违反契约抛异常,
    // 也不会导致 Promise.all fast-fail 拖垮其他健康的 Provider
    const results = await Promise.all(
      this.providers.map((p) => p.healthCheck().catch(() => false)),
    );
    return results.some(Boolean);
  }

  /**
   * 级联关闭所有 Provider，释放资源。
   */
  close(): void {
    for (const provider of this.providers) {
      provider.close();
    }
  }

  /**
   * 主 Provider 的模型名称。
   */
  get modelName(): string {
    return this.providers[0]!.modelName;
  }

  /**
   * 主 Provider 的标识符。
   */
  get primaryProvider(): string {
    return this.providers[0]!.name;
  }

  /**
   * 所有已注册的 Provider 名称列表。
   */
  get providerNames(): string[] {
    return this.providers.map((p) => p.name);
  }
}
