/**
 * @module container
 * @description 应用依赖注入容器 — 六边形架构核心层的单例工厂。
 *
 * 职责:
 * - 解析环境配置为强类型 AppConfig
 * - 按依赖顺序构造核心服务单例: RateLimiter → Providers → EmbeddingService → QdrantService
 * - 绝对禁止包含任何外壳层组件（SafeStdioTransport、McpServer、Hono App 等）
 *
 * 铁律 [shell-interfaces-constraints.md §2]:
 *   绝对禁止多次实例化，所有外壳层必须通过本容器获取核心服务。
 *
 * 铁律: 本模块不调用 process.exit()，配置错误以异常形式抛出，由调用方决定退出策略。
 */

import { QdrantService } from "./services/qdrant.js";
import {
  EmbeddingService,
  OllamaEmbeddingProvider,
  GeminiEmbeddingProvider,
} from "./services/embedding.js";
import type { EmbeddingProvider } from "./services/embedding.js";
import { RateLimiter } from "./utils/rate-limiter.js";
import { log } from "./utils/logger.js";

// =========================================================================
// Types
// =========================================================================

export type EmbeddingProviderMode = "ollama" | "gemini" | "auto";

/**
 * 应用配置 — 从环境变量解析，强类型化。
 */
export interface AppConfig {
  // Qdrant
  qdrantUrl: string;
  qdrantApiKey: string;

  // Embedding
  embeddingProvider: EmbeddingProviderMode;
  ollamaBaseUrl: string;
  ollamaModel: string;
  geminiApiKey: string;
  geminiModel: string;

  // Application
  defaultProject: string;

  // Rate Limiting
  rateLimitPerMinute: number;
  geminiMaxPerHour: number;
  geminiMaxPerDay: number;

  // Server mode
  mode: "mcp" | "http";
  httpPort: number;
  httpAuthToken: string;

  // Network Security (defense-in-depth)
  /** 监听地址 — 安全默认 127.0.0.1（物理隔绝公网直连）[ADR-SHELL-09] */
  httpHost: string;
  /** 是否信任反向代理 X-Forwarded-* 头 [ADR-SHELL-09] */
  trustProxy: boolean;
  /** 拒绝非 HTTPS 请求（需同时启用 trustProxy）[ADR-SHELL-09] */
  requireTls: boolean;
}

/**
 * 应用依赖容器 — 核心层所有单例服务。
 */
export interface AppContainer {
  readonly config: AppConfig;
  readonly qdrant: QdrantService;
  readonly embedding: EmbeddingService;
  readonly rateLimiter: RateLimiter;
}

// =========================================================================
// Config Parsing
// =========================================================================

/**
 * 防御性 parseInt — NaN/负数降级为 fallback。
 */
function safeParseInt(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value ?? String(fallback), 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

/**
 * 从环境变量解析应用配置。
 * 不调用 process.exit()，配置异常以 Error 形式抛出。
 */
export function parseAppConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  const embeddingProvider = (env.EMBEDDING_PROVIDER ?? "ollama") as string;

  // 验证 embeddingProvider 值合法
  if (!["ollama", "gemini", "auto"].includes(embeddingProvider)) {
    throw new Error(
      `Invalid EMBEDDING_PROVIDER="${embeddingProvider}". Must be one of: ollama, gemini, auto`,
    );
  }

  const geminiApiKey = env.GEMINI_API_KEY ?? "";

  // Gemini/Auto 模式必须提供 API Key
  if (
    (embeddingProvider === "gemini" || embeddingProvider === "auto") &&
    !geminiApiKey
  ) {
    throw new Error(
      `EMBEDDING_PROVIDER="${embeddingProvider}" requires GEMINI_API_KEY env var`,
    );
  }

  const mode = (env.EASY_MEMORY_MODE ?? "mcp") as string;
  if (mode !== "mcp" && mode !== "http") {
    throw new Error(
      `Invalid EASY_MEMORY_MODE="${mode}". Must be one of: mcp, http`,
    );
  }

  const result: AppConfig = {
    qdrantUrl: env.QDRANT_URL ?? "http://localhost:6333",
    qdrantApiKey: env.QDRANT_API_KEY ?? "easy-memory-dev",

    embeddingProvider: embeddingProvider as EmbeddingProviderMode,
    ollamaBaseUrl: env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    ollamaModel: env.OLLAMA_MODEL ?? "nomic-embed-text",
    geminiApiKey,
    geminiModel: env.GEMINI_MODEL ?? "gemini-embedding-001",

    defaultProject: env.DEFAULT_PROJECT ?? "default",

    rateLimitPerMinute: safeParseInt(env.RATE_LIMIT_PER_MINUTE, 60),
    geminiMaxPerHour: safeParseInt(env.GEMINI_MAX_PER_HOUR, 200),
    geminiMaxPerDay: safeParseInt(env.GEMINI_MAX_PER_DAY, 2000),

    mode: mode as "mcp" | "http",
    httpPort: safeParseInt(env.HTTP_PORT, 3080),
    httpAuthToken: env.HTTP_AUTH_TOKEN ?? "",

    // Network Security — 安全默认 [ADR-SHELL-09]
    httpHost: env.HTTP_HOST ?? "127.0.0.1",
    trustProxy: env.TRUST_PROXY === "true",
    requireTls: env.REQUIRE_TLS === "true",
  };

  // ⚠️ 矛盾配置检测: REQUIRE_TLS 需要 TRUST_PROXY 才有意义（fast-fail）
  if (result.requireTls && !result.trustProxy) {
    throw new Error(
      "REQUIRE_TLS=true requires TRUST_PROXY=true — " +
        "Node.js cannot see the original protocol without proxy headers. " +
        "Either enable TRUST_PROXY or disable REQUIRE_TLS.",
    );
  }

  return result;
}

// =========================================================================
// Container Factory
// =========================================================================

/**
 * 创建应用依赖容器。
 *
 * 实例化顺序（严格按依赖图）:
 * 1. RateLimiter — 无外部依赖，纯内存
 * 2. OllamaProvider / GeminiProvider — 仅构造，不连接
 * 3. EmbeddingService — 依赖 providers + rateLimiter 闭包
 * 4. QdrantService — 依赖 url + apiKey，独立于 embedding
 *
 * @param config 应用配置
 * @returns 完整的依赖容器
 */
export function createContainer(config: AppConfig): AppContainer {
  // ① RateLimiter (无外部 IO)
  const rateLimiter = new RateLimiter({
    maxCallsPerMinute: config.rateLimitPerMinute,
    geminiMaxCallsPerHour: config.geminiMaxPerHour,
    geminiMaxCallsPerDay: config.geminiMaxPerDay,
  });

  // ② Embedding Providers
  const providers: EmbeddingProvider[] = [];

  const ollamaProvider = new OllamaEmbeddingProvider({
    baseUrl: config.ollamaBaseUrl,
    model: config.ollamaModel,
  });

  if (
    config.embeddingProvider === "gemini" ||
    config.embeddingProvider === "auto"
  ) {
    const geminiProvider = new GeminiEmbeddingProvider({
      apiKey: config.geminiApiKey,
      model: config.geminiModel,
    });

    if (config.embeddingProvider === "auto") {
      providers.push(geminiProvider, ollamaProvider);
      log.info("Dual-engine mode: Gemini primary, Ollama fallback");
    } else {
      providers.push(geminiProvider);
      log.info("Single-engine mode: Gemini only");
    }
  } else {
    providers.push(ollamaProvider);
    log.info("Single-engine mode: Ollama only");
  }

  // ③ EmbeddingService — shouldUseProvider 闭包引用 rateLimiter
  const embedding = new EmbeddingService({
    providers,
    shouldUseProvider: (p) => {
      if (p.name === "gemini" && rateLimiter.isGeminiCircuitOpen) {
        log.warn(
          "Gemini circuit breaker open — skipping, will fallback to local",
        );
        return false;
      }
      return true;
    },
    onSuccess: (result) => {
      if (result.provider === "gemini") {
        rateLimiter.recordGeminiCall();
      }
    },
  });

  // ④ QdrantService — 独立于 embedding
  const qdrant = new QdrantService({
    url: config.qdrantUrl,
    apiKey: config.qdrantApiKey,
  });

  return {
    config,
    qdrant,
    embedding,
    rateLimiter,
  };
}
