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
  OpenAICompatibleEmbeddingProvider,
} from "./services/embedding.js";
import type { EmbeddingProvider } from "./services/embedding.js";
import { BM25Encoder } from "./services/bm25.js";
import { RateLimiter } from "./utils/rate-limiter.js";
import { AuditService } from "./services/audit.js";
import { AnalyticsService } from "./services/analytics.js";
import { ApiKeyManager } from "./services/api-key-manager.js";
import { BanManager } from "./services/ban-manager.js";
import { RuntimeConfigManager } from "./services/runtime-config.js";
import { AuthService } from "./services/auth.js";
import { MemoryOwnershipService } from "./services/memory-ownership.js";
import { log } from "./utils/logger.js";

// =========================================================================
// Types
// =========================================================================

export type EmbeddingProviderMode =
  | "ollama"
  | "gemini"
  | "openai"
  | "auto"
  | "openai-auto";

const EMBEDDING_PROVIDER_MODES = [
  "ollama",
  "gemini",
  "openai",
  "auto",
  "openai-auto",
] as const;

function isEmbeddingProviderMode(
  value: string,
): value is EmbeddingProviderMode {
  return (EMBEDDING_PROVIDER_MODES as readonly string[]).includes(value);
}

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
  geminiProjectId: string;
  geminiRegion: string;
  geminiModel: string;
  openaiEmbeddingApiKey: string;
  openaiEmbeddingBaseUrl: string;
  openaiEmbeddingModel: string;

  // Application
  defaultProject: string;

  // Timeouts
  ollamaTimeoutMs: number;

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

  // Admin Management
  /** Admin API Token — 独立于 httpAuthToken，空串 = admin 功能禁用 */
  adminToken: string;

  // Auth / User Management
  /** Admin 用户名 — 首次启动时种子 admin 用户 */
  adminUsername: string;
  /** Admin 密码 — 首次启动时种子 admin 用户 */
  adminPassword: string;
}

/**
 * 应用依赖容器 — 核心层所有单例服务。
 */
export interface AppContainer {
  readonly config: AppConfig;
  readonly qdrant: QdrantService;
  readonly embedding: EmbeddingService;
  readonly rateLimiter: RateLimiter;
  /** [ADR 补充二十] BM25 稀疏向量编码器，用于混合检索 */
  readonly bm25: BM25Encoder;
  /** 审计日志服务 — JSONL 热写入层 */
  readonly audit: AuditService;
  /** 分析服务 — SQLite 冷分析层 */
  readonly analytics: AnalyticsService;
  /** API Key 管理服务 */
  readonly apiKeyManager: ApiKeyManager;
  /** Ban 管理服务 */
  readonly banManager: BanManager;
  /** 运行时配置管理 */
  readonly runtimeConfig: RuntimeConfigManager;
  /** 用户认证服务 */
  readonly auth: AuthService;
  /** 历史 owner 修复与归属回填服务 */
  readonly memoryOwnership: MemoryOwnershipService;
}

// =========================================================================
// Config Parsing
// =========================================================================

/**
 * 防御性 parseInt — NaN/负数降级为 fallback。
 */
function safeParseInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

/**
 * ========================== 变更记录 ==========================
 * [日期]     2026-03-14
 * [类型]     配置变更
 * [描述]     调整 embedding 默认推断策略：显式配置优先，其次优先选择已配置官方远端模型（OpenAI-compatible relay → Gemini Vertex AI），最后才回退到本地 Ollama。
 * [思路]     通过“凭据即意图”的推断规则，让项目在提供远端 API Key 时自动采用远端官方模型语义；若完全未配置远端凭据，则保留 Ollama 作为零配置兜底，避免启动即失败。
 * [参数与返回值] 参数 env: 环境变量键值对；返回值 string: 解析出的 embedding provider mode，后续会由 parseAppConfig 做合法性校验。
 * [影响范围] parseAppConfig() 默认行为、Docker/.env 模板预期、HTTP/MCP 双壳共享容器默认 provider 选择。
 * [潜在风险] 当同时配置 OpenAI-compatible 与 Gemini 凭据且未显式指定 EMBEDDING_PROVIDER 时，将优先选择 OpenAI-compatible relay；如需 Gemini 优先，必须显式设置 provider。
 * ==============================================================
 */
function resolveEmbeddingProviderMode(
  env: Record<string, string | undefined>,
): string {
  if (env.EMBEDDING_PROVIDER) {
    return env.EMBEDDING_PROVIDER;
  }

  if (env.OPENAI_EMBEDDING_API_KEY) {
    return "openai-auto";
  }

  if (env.GEMINI_API_KEY && env.GEMINI_PROJECT_ID) {
    return "auto";
  }

  return "ollama";
}

/**
 * 从环境变量解析应用配置。
 * 不调用 process.exit()，配置异常以 Error 形式抛出。
 */
export function parseAppConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  const embeddingProvider = resolveEmbeddingProviderMode(env);

  // 验证 embeddingProvider 值合法
  if (!isEmbeddingProviderMode(embeddingProvider)) {
    throw new Error(
      `Invalid EMBEDDING_PROVIDER="${embeddingProvider}". Must be one of: ollama, gemini, openai, auto, openai-auto`,
    );
  }

  const geminiApiKey = env.GEMINI_API_KEY ?? "";
  const geminiProjectId = env.GEMINI_PROJECT_ID ?? "";
  const openaiEmbeddingApiKey = env.OPENAI_EMBEDDING_API_KEY ?? "";

  // Gemini/Auto 模式必须提供 API Key 和 Project ID
  if (
    (embeddingProvider === "gemini" || embeddingProvider === "auto") &&
    !geminiApiKey
  ) {
    throw new Error(
      `EMBEDDING_PROVIDER="${embeddingProvider}" requires GEMINI_API_KEY env var`,
    );
  }
  if (
    (embeddingProvider === "gemini" || embeddingProvider === "auto") &&
    !geminiProjectId
  ) {
    throw new Error(
      `EMBEDDING_PROVIDER="${embeddingProvider}" requires GEMINI_PROJECT_ID env var`,
    );
  }

  if (
    (embeddingProvider === "openai" || embeddingProvider === "openai-auto") &&
    !openaiEmbeddingApiKey
  ) {
    throw new Error(
      `EMBEDDING_PROVIDER="${embeddingProvider}" requires OPENAI_EMBEDDING_API_KEY env var`,
    );
  }

  const mode = env.EASY_MEMORY_MODE ?? "mcp";
  if (mode !== "mcp" && mode !== "http") {
    throw new Error(
      `Invalid EASY_MEMORY_MODE="${mode}". Must be one of: mcp, http`,
    );
  }

  const result: AppConfig = {
    qdrantUrl: env.QDRANT_URL ?? "http://localhost:6333",
    qdrantApiKey: env.QDRANT_API_KEY ?? "easy-memory-dev",

    embeddingProvider,
    ollamaBaseUrl: env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    ollamaModel: env.OLLAMA_MODEL ?? "bge-m3",
    geminiApiKey,
    geminiProjectId,
    geminiRegion: env.GEMINI_REGION ?? "us-central1",
    geminiModel: env.GEMINI_MODEL ?? "gemini-embedding-001",
    openaiEmbeddingApiKey,
    openaiEmbeddingBaseUrl:
      env.OPENAI_EMBEDDING_BASE_URL ?? "https://api.vectorengine.ai/v1",
    openaiEmbeddingModel:
      env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small",

    defaultProject: env.DEFAULT_PROJECT ?? "default",

    ollamaTimeoutMs: safeParseInt(env.OLLAMA_TIMEOUT_MS, 120_000),

    rateLimitPerMinute: safeParseInt(env.RATE_LIMIT_PER_MINUTE, 60),
    geminiMaxPerHour: safeParseInt(env.GEMINI_MAX_PER_HOUR, 200),
    geminiMaxPerDay: safeParseInt(env.GEMINI_MAX_PER_DAY, 2000),

    mode,
    httpPort: safeParseInt(env.HTTP_PORT, 3080),
    httpAuthToken: env.HTTP_AUTH_TOKEN ?? "",

    // Network Security — 安全默认 [ADR-SHELL-09]
    httpHost: env.HTTP_HOST ?? "127.0.0.1",
    trustProxy: env.TRUST_PROXY === "true",
    requireTls: env.REQUIRE_TLS === "true",

    // Admin Management
    adminToken: env.ADMIN_TOKEN ?? "",

    // Auth / User Management
    adminUsername: env.ADMIN_USERNAME ?? "",
    adminPassword: env.ADMIN_PASSWORD ?? "",
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
    timeoutMs: config.ollamaTimeoutMs,
  });

  // ========================== 变更记录 ==========================
  // [日期]     2026-03-14
  // [类型]     新增功能
  // [描述]     扩展 EmbeddingProvider 选择器，新增 OpenAI-compatible / 第三方中转 Provider，同时保留官方 Gemini Vertex AI 链路与原有 auto 行为。
  // [思路]     采用显式 provider mode（openai / openai-auto）避免破坏旧有 gemini / auto 语义；第三方中转默认走兼容协议 `/v1/embeddings`。
  // [影响范围] createContainer() Provider 装配顺序、日志输出、远端 embedding 路由行为。
  // [潜在风险] 若用户在 openai/openai-auto 模式下填入非兼容网关地址，将在 Provider healthCheck/embed 阶段暴露为配置错误。
  // ==============================================================
  if (config.embeddingProvider === "gemini") {
    providers.push(
      new GeminiEmbeddingProvider({
        apiKey: config.geminiApiKey,
        projectId: config.geminiProjectId,
        region: config.geminiRegion,
        model: config.geminiModel,
        // [FIX C-1]: 传递熔断器检查回调，Provider 内部重试时可检查熔断状态。
        // 防止 100 个并发请求穿透熔断器窗口期，每个白白浪费 ~8.5s 重试。
        isCircuitOpen: () => rateLimiter.isGeminiCircuitOpen,
      }),
    );
    log.info("Single-engine mode: Gemini only");
  } else if (config.embeddingProvider === "auto") {
    providers.push(
      new GeminiEmbeddingProvider({
        apiKey: config.geminiApiKey,
        projectId: config.geminiProjectId,
        region: config.geminiRegion,
        model: config.geminiModel,
        isCircuitOpen: () => rateLimiter.isGeminiCircuitOpen,
      }),
      ollamaProvider,
    );
    log.info("Dual-engine mode: Gemini primary, Ollama fallback");
  } else if (config.embeddingProvider === "openai") {
    providers.push(
      new OpenAICompatibleEmbeddingProvider({
        apiKey: config.openaiEmbeddingApiKey,
        baseUrl: config.openaiEmbeddingBaseUrl,
        model: config.openaiEmbeddingModel,
      }),
    );
    log.info("Single-engine mode: OpenAI-compatible only");
  } else if (config.embeddingProvider === "openai-auto") {
    providers.push(
      new OpenAICompatibleEmbeddingProvider({
        apiKey: config.openaiEmbeddingApiKey,
        baseUrl: config.openaiEmbeddingBaseUrl,
        model: config.openaiEmbeddingModel,
      }),
      ollamaProvider,
    );
    log.info("Dual-engine mode: OpenAI-compatible primary, Ollama fallback");
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
    onFailure: (failure) => {
      if (failure.provider === "gemini") {
        rateLimiter.recordGeminiFailure();
      }
    },
  });

  // ④ QdrantService — 独立于 embedding
  const qdrant = new QdrantService({
    url: config.qdrantUrl,
    apiKey: config.qdrantApiKey,
  });

  // ⑥ BM25Encoder [ADR 补充二十] — 纯内存计算，无外部 IO
  const bm25 = new BM25Encoder();

  // ⑦ AuditService — JSONL 审计日志热写入
  const audit = new AuditService();
  audit.start();

  // ⑧ AnalyticsService — SQLite 分析存储
  const analytics = new AnalyticsService();
  analytics.open();

  // ⑨ ApiKeyManager — API Key CRUD + SQLite 持久化
  const apiKeyManager = new ApiKeyManager();
  apiKeyManager.open();

  // ⑩ BanManager — Ban 管理 (与 ApiKeyManager 共享 admin DB 连接)
  const banManager = new BanManager();
  const adminDb = apiKeyManager.getDatabase();
  if (adminDb) {
    banManager.open(adminDb);
  } else {
    // 降级: ApiKeyManager DB 不可用时独立打开
    banManager.open();
  }

  // ⑪ RuntimeConfigManager — 运行时可变配置
  const runtimeConfig = new RuntimeConfigManager({
    defaults: {
      rate_limit_per_minute: config.rateLimitPerMinute,
      gemini_max_per_hour: config.geminiMaxPerHour,
      gemini_max_per_day: config.geminiMaxPerDay,
      default_project: config.defaultProject,
      require_tls: config.requireTls,
      audit_enabled: true,
      raw_retention_days: 30,
      hourly_retention_days: 7,
      daily_retention_days: 90,
    },
  });

  // ⑫ AuthService — 用户认证 + RBAC (共享 admin DB)
  const auth = new AuthService({
    adminToken: config.adminToken,
    adminUsername: config.adminUsername,
    adminPassword: config.adminPassword,
  });
  if (adminDb) {
    auth.open(adminDb);
  }

  const memoryOwnership = new MemoryOwnershipService({
    qdrant,
    apiKeyManager,
  });

  return {
    config,
    qdrant,
    embedding,
    rateLimiter,
    bm25,
    audit,
    analytics,
    apiKeyManager,
    banManager,
    runtimeConfig,
    auth,
    memoryOwnership,
  };
}
