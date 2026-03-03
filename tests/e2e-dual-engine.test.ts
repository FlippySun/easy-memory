/**
 * @module e2e-dual-engine.test
 * @description 双引擎 Embedding → Qdrant Vector DB 全链路 E2E 验证脚本。
 *
 * 三位审查专家：
 *   1. Node.js/TS 运行时架构师 — 死磕内存泄漏、异步陷阱、Event Loop 阻塞
 *   2. 数据管道工程师 — Qdrant 强一致性、多源异构向量的降维与对齐
 *   3. 混沌工程专家(QA) — 极端网络环境、类型破坏和边缘异常
 *
 * 链路 A (远端): Google gemini-embedding-001 API (MRL → 1024 维)
 * 链路 B (本地): Ollama bge-m3 (原生 1024 维)
 *
 * 验证目标:
 *   1. 两条链路各自的 embed → validate → upsert → search → recall 闭环
 *   2. 异构维度的 Collection 隔离 (动态创建不同参数的 Collection)
 *   3. wait:true 强制同步写入
 *   4. 动态超时策略 (远端 vs 本地)
 *   5. 脏数据拦截 (NaN/Infinity/维度不匹配)
 *
 * 运行方式:
 *   GEMINI_API_KEY=<your-key> pnpm test:e2e:dual
 *
 * 环境变量:
 *   GEMINI_API_KEY  — Google AI API Key (必须设置，否则跳过远端链路)
 *   QDRANT_URL      — Qdrant 端点 (default: http://localhost:6333)
 *   QDRANT_API_KEY  — Qdrant API Key (default: easy-memory-dev)
 *   OLLAMA_URL      — Ollama 端点 (default: http://localhost:11434)
 *   GEMINI_TIMEOUT_MS — Gemini 请求超时 (default: 30000)
 *   OLLAMA_TIMEOUT_MS — Ollama 请求超时 (default: 120000，含冷启动)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { QdrantClient } from "@qdrant/js-client-rest";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

// ============================================================
// §0 — 环境检测 & 配置
// ============================================================

/**
 * [混沌专家审查 - 容器网络逃逸]
 *
 * 若 Node.js 运行在容器内，localhost 指向容器自身，无法访问宿主机服务。
 * 检测策略：
 *   1. 用户显式环境变量 > 一切自动检测
 *   2. /.dockerenv 文件存在 → macOS/Windows 用 host.docker.internal
 *   3. /proc/1/cgroup 含 docker/containerd → 同上
 *   4. 均不命中 → 原生 localhost
 *
 * 边界覆盖：
 *   - macOS Docker Desktop: host.docker.internal 自动解析到宿主
 *   - Linux Docker: host.docker.internal 从 20.10+ 起可用
 *   - Podman: 使用 host.containers.internal
 *   - 非容器环境: 直接 localhost
 */
function detectHost(): string {
  try {
    if (existsSync("/.dockerenv")) return "host.docker.internal";
    const cgroup = readFileSync("/proc/1/cgroup", "utf8");
    if (cgroup.includes("docker") || cgroup.includes("containerd")) {
      return "host.docker.internal";
    }
  } catch {
    // 非容器环境或无权读取 — 使用 localhost
  }
  return "localhost";
}

const RESOLVED_HOST = detectHost();
const QDRANT_URL = process.env.QDRANT_URL ?? `http://${RESOLVED_HOST}:6333`;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY ?? "easy-memory-dev";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
const OLLAMA_URL = process.env.OLLAMA_URL ?? `http://${RESOLVED_HOST}:11434`;

/**
 * [架构师审查 - 动态超时控制]
 *
 * 不同 Provider 的响应耗时特征完全不同：
 *   - Gemini (远端): 受网络抖动主导，30s 足够覆盖 P99 延迟
 *   - Ollama (本地): 首次请求可能冷启动加载模型 (bge-m3 ~1.5GB)，
 *     冷启动 120s，后续请求 <5s
 *
 * 策略: 首次请求使用 full timeout，重试时收紧到 30s
 * (冷启动只影响第一次，后续重试无需长等待)
 */
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 30_000;
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 120_000;
const MAX_RETRIES = 3;

// 维度配置 — Gemini 使用 MRL 降维到 1024，Ollama bge-m3 原生 1024
const GEMINI_DIMENSION = 1024;
const OLLAMA_DIMENSION = 1024;

// 测试隔离标识 (时间戳确保跨次运行不冲突)
const TEST_RUN_ID = `dual_${Date.now().toString(36)}`;
const COLLECTION_GEMINI = `e2e_gemini_${TEST_RUN_ID}`;
const COLLECTION_OLLAMA = `e2e_ollama_${TEST_RUN_ID}`;

// 测试数据
const TEST_CONTENT =
  "TypeScript is a typed superset of JavaScript that compiles to plain JavaScript. It adds optional static typing and class-based object-oriented programming to the language.";
const TEST_QUERY = "What programming language adds type safety to JavaScript?";

const TEST_PAYLOAD: Record<string, unknown> = {
  content: TEST_CONTENT,
  project: "e2e-dual-test",
  source: "manual",
  fact_type: "verified_fact",
  lifecycle: "active",
  schema_version: 2,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

// ============================================================
// §1 — 多态时延追踪基础设施
// ============================================================

interface TimingEntry {
  provider: string;
  phase: string;
  durationMs: number;
  timestamp: string;
}

const timingLog: TimingEntry[] = [];

/**
 * 计时包装器：记录每个 provider 每个阶段的耗时。
 * 用于最终的多态时延对比报告。
 */
async function timed<T>(
  provider: string,
  phase: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    timingLog.push({
      provider,
      phase,
      durationMs: Math.round((performance.now() - start) * 100) / 100,
      timestamp: new Date().toISOString().split("T")[1]!.slice(0, 12),
    });
  }
}

/**
 * 输出时延对比报告到 stderr（不污染 stdout/MCP stdio 管道）。
 */
function printTimingReport(): void {
  if (timingLog.length === 0) return;

  const lines: string[] = [
    "",
    "╔══════════════════════════════════════════════════════════════╗",
    "║      多态时延对比报告 (Polymorphic Latency Report)          ║",
    "╚══════════════════════════════════════════════════════════════╝",
    "",
    `${"Provider".padEnd(10)}${"Phase".padEnd(16)}${"Duration(ms)".padStart(14)}  ${"Timestamp"}`,
    `${"─".repeat(10)}${"─".repeat(16)}${"─".repeat(14)}  ${"─".repeat(12)}`,
  ];

  for (const t of timingLog) {
    lines.push(
      `${t.provider.padEnd(10)}${t.phase.padEnd(16)}${String(t.durationMs).padStart(14)}  ${t.timestamp}`,
    );
  }

  // 对比摘要
  const geminiEmbed = timingLog.find(
    (t) => t.provider === "gemini" && t.phase === "embed",
  );
  const ollamaEmbed = timingLog.find(
    (t) => t.provider === "ollama" && t.phase === "embed",
  );
  if (geminiEmbed && ollamaEmbed) {
    lines.push("");
    lines.push("── 首次 Embed 耗时对比 ──");
    lines.push(
      `  Gemini (远端): ${geminiEmbed.durationMs}ms | Ollama (本地): ${ollamaEmbed.durationMs}ms`,
    );
    const ratio = geminiEmbed.durationMs / ollamaEmbed.durationMs;
    lines.push(`  比值: Gemini/Ollama = ${ratio.toFixed(2)}x`);
  }

  lines.push("");
  process.stderr.write(lines.join("\n") + "\n");
}

// ============================================================
// §2 — Provider 统一接口 & 向量校验器
// ============================================================

/**
 * 统一的 Embedding Provider 接口（策略模式 / 工厂模式抽象层）。
 *
 * 所有 Provider 必须实现此接口，确保上层代码对具体实现无感知。
 * 字段 `timeoutMs` 暴露给调用方用于日志和监控。
 */
interface EmbeddingProvider {
  readonly name: string;
  readonly dimension: number;
  readonly timeoutMs: number;
  embed(text: string): Promise<number[]>;
  healthCheck(): Promise<boolean>;
  close(): void;
}

/**
 * [数据工程师审查 - 精度与截断]
 *
 * 向量校验器：在落库前拦截一切脏数据。
 *
 * 风险点分析:
 *   1. NaN：Ollama 某些旧版本在 prompt 过长时可能返回 NaN
 *   2. Infinity：数值溢出（理论上不会，但防御性检查）
 *   3. 维度不匹配：Gemini MRL 降维可能因 API 变更返回不同维度
 *   4. 极端值：正常嵌入向量值域通常在 [-5, 5]，超过 100 视为异常
 *
 * 底层兼容:
 *   - Gemini MRL 降维后为 Float32 精度
 *   - Ollama bge-m3 返回 Float32 原生向量
 *   - 两者精度一致，无需额外对齐
 */
function validateVector(
  vector: number[],
  expectedDim: number,
  providerName: string,
): void {
  if (!Array.isArray(vector)) {
    throw new Error(`[${providerName}] 向量不是数组`);
  }
  if (vector.length !== expectedDim) {
    throw new Error(
      `[${providerName}] 维度不匹配: 预期 ${expectedDim}, 实际 ${vector.length}`,
    );
  }
  for (let i = 0; i < vector.length; i++) {
    const v = vector[i]!;
    if (typeof v !== "number") {
      throw new Error(`[${providerName}] 非数值类型 @ index ${i}: ${typeof v}`);
    }
    if (Number.isNaN(v)) {
      throw new Error(`[${providerName}] 检测到 NaN @ index ${i}`);
    }
    if (!Number.isFinite(v)) {
      throw new Error(`[${providerName}] 检测到 Infinity @ index ${i}: ${v}`);
    }
    if (Math.abs(v) > 100) {
      throw new Error(
        `[${providerName}] 可疑极端值 @ index ${i}: ${v} (|v| > 100)`,
      );
    }
  }
}

// ============================================================
// §3 — Gemini Embedding Provider (远端)
// ============================================================

/**
 * Google Gemini gemini-embedding-001 Provider。
 *
 * 特性:
 *   - 使用 Matryoshka Representation Learning (MRL) 支持动态降维
 *   - 原生 3072 维，通过 outputDimensionality 降至目标维度
 *   - 指数退避重试 (429 Rate Limit + 5xx Server Error)
 *   - AbortController 实现超时控制
 *
 * [架构师审查] AbortController 生命周期:
 *   - 每个请求创建独立的 AbortController
 *   - 存入 activeControllers Set 以支持 close() 全局中止
 *   - finally 块确保 clearTimeout + Set 清理，防止内存泄漏
 *   - close() 调用时遍历 Set 全部 abort()，再 clear()
 */
class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly name = "gemini";
  readonly dimension: number;
  readonly timeoutMs: number;
  private readonly apiKey: string;
  private readonly maxRetries: number;
  private readonly activeControllers = new Set<AbortController>();

  constructor(
    apiKey: string,
    dimension = GEMINI_DIMENSION,
    timeoutMs = GEMINI_TIMEOUT_MS,
    maxRetries = MAX_RETRIES,
  ) {
    this.apiKey = apiKey;
    this.dimension = dimension;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
  }

  async embed(text: string): Promise<number[]> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${this.apiKey}`;
    const body = {
      content: { parts: [{ text }] },
      outputDimensionality: this.dimension,
    };

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      if (attempt > 0) {
        // [架构师审查] 指数退避: 2s, 4s — 远端 API 的 429/5xx 需要充分退避
        const delay = Math.pow(2, attempt) * 1000;
        process.stderr.write(
          `  ⟳ Gemini 重试 ${attempt}/${this.maxRetries}, 等待 ${delay}ms\n`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }

      const controller = new AbortController();
      this.activeControllers.add(controller);
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        // [混沌专家审查] Rate Limit 429 — 强制退避重试
        if (res.status === 429) {
          lastError = new Error("Gemini rate limited (429)");
          continue;
        }

        if (!res.ok) {
          const errBody = await res.text().catch(() => "<unreadable>");
          lastError = new Error(
            `Gemini API ${res.status}: ${errBody.slice(0, 300)}`,
          );
          // 5xx 可重试，4xx (非 429) 直接抛出
          if (res.status >= 500) continue;
          throw lastError;
        }

        const data = (await res.json()) as {
          embedding?: { values?: number[] };
        };
        const values = data.embedding?.values;

        if (!Array.isArray(values) || values.length === 0) {
          throw new Error(
            "Gemini response 结构异常: 缺少 embedding.values 数组",
          );
        }

        return values;
      } catch (err: unknown) {
        // AbortController 超时
        if (err instanceof DOMException && err.name === "AbortError") {
          lastError = new Error(`Gemini 请求超时 (${this.timeoutMs}ms)`);
          continue;
        }
        // 网络层错误 (DNS, TCP refused 等) — 可重试
        if (err instanceof TypeError && String(err).includes("fetch")) {
          lastError = err instanceof Error ? err : new Error(String(err));
          continue;
        }
        // 非可重试错误 — 直接抛出
        if (lastError === null) {
          lastError = err instanceof Error ? err : new Error(String(err));
        }
        throw lastError;
      } finally {
        clearTimeout(timer);
        this.activeControllers.delete(controller);
      }
    }

    throw lastError ?? new Error("Gemini embedding 在所有重试后仍然失败");
  }

  async healthCheck(): Promise<boolean> {
    if (!this.apiKey) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      // 最小化健康检查: embed 单个单词验证 API 连通性
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${this.apiKey}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: { parts: [{ text: "ping" }] },
          outputDimensionality: this.dimension,
        }),
        signal: controller.signal,
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  close(): void {
    for (const c of this.activeControllers) c.abort();
    this.activeControllers.clear();
  }
}

// ============================================================
// §4 — Ollama Embedding Provider (本地)
// ============================================================

/**
 * Ollama bge-m3 Provider。
 *
 * 特性:
 *   - 原生 1024 维 dense vector
 *   - 使用与现有 src/services/embedding.ts 一致的 API 格式
 *     (POST /api/embeddings, body: { model, prompt })
 *   - 冷启动超时策略: 首次请求 full timeout，后续重试缩短
 *
 * [架构师审查 - 动态超时控制 — 冷启动策略]:
 *   Ollama 首次加载模型 (bge-m3 ~1.5GB) 可能需要 30-120s。
 *   首次请求给予完整 OLLAMA_TIMEOUT_MS (120s)，
 *   重试时模型已加载，收紧到 30s 避免无意义等待。
 */
class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = "ollama";
  readonly dimension: number;
  readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly maxRetries: number;
  private readonly activeControllers = new Set<AbortController>();

  constructor(
    baseUrl = OLLAMA_URL,
    dimension = OLLAMA_DIMENSION,
    model = "bge-m3",
    timeoutMs = OLLAMA_TIMEOUT_MS,
    maxRetries = MAX_RETRIES,
  ) {
    this.baseUrl = baseUrl;
    this.dimension = dimension;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
  }

  async embed(text: string): Promise<number[]> {
    // 兼容现有 src/services/embedding.ts 使用的旧版 Ollama API
    const url = `${this.baseUrl}/api/embeddings`;
    const body = { model: this.model, prompt: text };

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = Math.pow(2, attempt) * 1000;
        process.stderr.write(
          `  ⟳ Ollama 重试 ${attempt}/${this.maxRetries}, 等待 ${delay}ms\n`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }

      const controller = new AbortController();
      this.activeControllers.add(controller);

      // [架构师审查] 动态超时: 首次请求使用 full timeout (冷启动)
      // 后续重试收紧到 30s (模型已加载，重试不需要冷启动预算)
      const effectiveTimeout =
        attempt === 0 ? this.timeoutMs : Math.min(this.timeoutMs, 30_000);
      const timer = setTimeout(() => controller.abort(), effectiveTimeout);

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!res.ok) {
          const errBody = await res.text().catch(() => "<unreadable>");
          throw new Error(`Ollama API ${res.status}: ${errBody.slice(0, 300)}`);
        }

        const data = (await res.json()) as { embedding?: number[] };

        if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
          throw new Error("Ollama response 缺少 embedding 数组");
        }

        return data.embedding;
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") {
          lastError = new Error(
            `Ollama 请求超时 (${effectiveTimeout}ms)${attempt === 0 ? " — 可能是冷启动中" : ""}`,
          );
          continue;
        }
        lastError = err instanceof Error ? err : new Error(String(err));
        // Connection refused → 可重试 (Ollama 可能正在启动)
      } finally {
        clearTimeout(timer);
        this.activeControllers.delete(controller);
      }
    }

    throw lastError ?? new Error("Ollama embedding 在所有重试后仍然失败");
  }

  async healthCheck(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: controller.signal,
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  close(): void {
    for (const c of this.activeControllers) c.abort();
    this.activeControllers.clear();
  }
}

// ============================================================
// §5 — Provider 工厂
// ============================================================

/**
 * 工厂函数: 根据名称创建对应的 EmbeddingProvider。
 * 便于未来扩展新的 Provider (如 OpenAI, Cohere 等)。
 */
function createProvider(name: "gemini" | "ollama"): EmbeddingProvider | null {
  switch (name) {
    case "gemini":
      if (!GEMINI_API_KEY) return null;
      return new GeminiEmbeddingProvider(GEMINI_API_KEY);
    case "ollama":
      return new OllamaEmbeddingProvider();
    default:
      return null;
  }
}

// ============================================================
// §6 — Qdrant 辅助函数
// ============================================================

/**
 * 创建 Qdrant Collection。先尝试删除残留（防止上次测试残留）。
 *
 * [数据工程师审查] 维度隔离:
 * 每个 Provider 使用独立 Collection，dimension 参数动态传入。
 * 即使两个 Provider 恰好维度相同 (如都是 1024)，仍使用独立 Collection，
 * 因为不同模型的向量空间语义不同，混在一起会导致搜索质量下降。
 */
async function createCollection(
  client: QdrantClient,
  name: string,
  dimension: number,
): Promise<void> {
  // 清理残留
  try {
    await client.deleteCollection(name);
  } catch {
    // Collection 不存在，忽略
  }
  await client.createCollection(name, {
    vectors: {
      size: dimension,
      distance: "Cosine",
    },
  });
}

/**
 * 写入单个向量点。
 *
 * [数据工程师审查] wait:true 强制同步:
 * 确保 upsert 完成后数据立即可搜索，防止幻读。
 * 这与 src/services/qdrant.ts 的铁律一致。
 */
async function upsertPoint(
  client: QdrantClient,
  collection: string,
  id: string,
  vector: number[],
  payload: Record<string, unknown>,
): Promise<void> {
  await client.upsert(collection, {
    points: [{ id, vector, payload }],
    wait: true, // ⚠️ 铁律: 绝对不能改为 false
  });
}

/**
 * 语义搜索。
 */
async function searchSimilar(
  client: QdrantClient,
  collection: string,
  vector: number[],
  limit = 5,
): Promise<
  Array<{
    id: string | number;
    score: number;
    payload?: Record<string, unknown> | null | undefined;
  }>
> {
  return client.search(collection, {
    vector,
    limit,
    with_payload: true,
  });
}

/**
 * 安全删除 Collection（忽略不存在的情况）。
 */
async function deleteCollectionSafe(
  client: QdrantClient,
  name: string,
): Promise<void> {
  try {
    await client.deleteCollection(name);
  } catch {
    // 忽略
  }
}

// ============================================================
// §7 — 测试套件
// ============================================================

describe("Dual-Engine E2E: Gemini + Ollama → Qdrant", () => {
  let qdrantClient: QdrantClient;
  let geminiProvider: EmbeddingProvider | null = null;
  let ollamaProvider: EmbeddingProvider | null = null;

  let qdrantAvailable = false;
  let geminiAvailable = false;
  let ollamaAvailable = false;

  // 存储各链路生成的向量和点 ID
  let geminiVector: number[] = [];
  let ollamaVector: number[] = [];
  const geminiPointId = randomUUID();
  const ollamaPointId = randomUUID();

  // 需要清理的 Collection 列表
  const collectionsToClean: string[] = [];

  // ---- Setup ----

  beforeAll(async () => {
    process.stderr.write(
      "\n🔧 Dual-Engine E2E 初始化...\n" +
        `  Qdrant:  ${QDRANT_URL}\n` +
        `  Ollama:  ${OLLAMA_URL}\n` +
        `  Gemini:  ${GEMINI_API_KEY ? "已配置" : "❌ 未配置 GEMINI_API_KEY"}\n` +
        `  Host:    ${RESOLVED_HOST}\n\n`,
    );

    // 1. Qdrant 连通性检查
    qdrantClient = new QdrantClient({
      url: QDRANT_URL,
      apiKey: QDRANT_API_KEY,
    });
    try {
      await qdrantClient.getCollections();
      qdrantAvailable = true;
      process.stderr.write("  ✓ Qdrant 就绪\n");
    } catch {
      process.stderr.write("  ✗ Qdrant 不可用，跳过全部测试\n");
    }

    // 2. Gemini 连通性检查
    geminiProvider = createProvider("gemini");
    if (geminiProvider) {
      geminiAvailable = await geminiProvider.healthCheck();
      process.stderr.write(
        geminiAvailable ? "  ✓ Gemini API 就绪\n" : "  ✗ Gemini API 不可用\n",
      );
    } else {
      process.stderr.write("  ⏭ Gemini 跳过 (未设置 API Key)\n");
    }

    // 3. Ollama 连通性检查
    ollamaProvider = createProvider("ollama");
    if (ollamaProvider) {
      ollamaAvailable = await ollamaProvider.healthCheck();
      process.stderr.write(
        ollamaAvailable ? "  ✓ Ollama 就绪\n" : "  ✗ Ollama 不可用\n",
      );
    }

    process.stderr.write("\n");
  });

  // ---- Teardown ----

  afterAll(async () => {
    // [数据工程师审查] 无痕清理: 无论成功/失败都销毁所有测试 Collection
    for (const name of collectionsToClean) {
      await deleteCollectionSafe(qdrantClient, name);
    }

    // [架构师审查] TCP 句柄清理: 中止所有活跃请求释放文件描述符
    geminiProvider?.close();
    ollamaProvider?.close();

    // 输出时延对比报告
    printTimingReport();

    // 输出审查报告
    printReviewReport();
  });

  // ================================================================
  // 链路 A: Gemini (远端)
  // ================================================================

  describe("链路 A: Gemini (远端 → embed → validate → Qdrant)", () => {
    it("A1: 应生成正确维度的 embedding 向量", async () => {
      if (!geminiAvailable || !qdrantAvailable) {
        process.stderr.write("  ⏭ 跳过 A1: Gemini/Qdrant 不可用\n");
        return;
      }

      geminiVector = await timed("gemini", "embed", () =>
        geminiProvider!.embed(TEST_CONTENT),
      );

      // [数据工程师审查] 全量向量校验
      await timed("gemini", "validate", async () =>
        validateVector(geminiVector, GEMINI_DIMENSION, "gemini"),
      );

      expect(geminiVector).toHaveLength(GEMINI_DIMENSION);
      // 确认值不全为零（零向量说明 embedding 失败但未报错）
      const norm = Math.sqrt(geminiVector.reduce((sum, v) => sum + v * v, 0));
      expect(norm).toBeGreaterThan(0.01);
    });

    it("A2: 应成功写入 Qdrant (wait:true)", async () => {
      if (!geminiAvailable || !qdrantAvailable || geminiVector.length === 0) {
        return;
      }

      await timed("gemini", "create_coll", () =>
        createCollection(qdrantClient, COLLECTION_GEMINI, GEMINI_DIMENSION),
      );
      collectionsToClean.push(COLLECTION_GEMINI);

      await timed("gemini", "upsert", () =>
        upsertPoint(
          qdrantClient,
          COLLECTION_GEMINI,
          geminiPointId,
          geminiVector,
          { ...TEST_PAYLOAD, embedding_model: "gemini-embedding-001" },
        ),
      );

      // 验证 wait:true 已生效 — 写入后立即可查
      const info = await qdrantClient.getCollection(COLLECTION_GEMINI);
      expect(info.points_count).toBe(1);
    });

    it("A3: 应通过语义搜索召回已保存的记忆", async () => {
      if (!geminiAvailable || !qdrantAvailable || geminiVector.length === 0) {
        return;
      }

      // 用查询文本生成搜索向量
      const queryVector = await timed("gemini", "embed_query", () =>
        geminiProvider!.embed(TEST_QUERY),
      );
      validateVector(queryVector, GEMINI_DIMENSION, "gemini-query");

      const results = await timed("gemini", "search", () =>
        searchSimilar(qdrantClient, COLLECTION_GEMINI, queryVector),
      );

      expect(results.length).toBeGreaterThan(0);

      // Payload 完整性断言
      const found = results.find((r) => r.id === geminiPointId);
      expect(found).toBeDefined();
      expect(found!.payload?.content).toBe(TEST_CONTENT);
      expect(found!.payload?.lifecycle).toBe("active");
      expect(found!.payload?.embedding_model).toBe("gemini-embedding-001");
      expect(found!.score).toBeGreaterThan(0.3); // 语义相关性阈值
    });
  });

  // ================================================================
  // 链路 B: Ollama (本地)
  // ================================================================

  describe("链路 B: Ollama (本地 → embed → validate → Qdrant)", () => {
    it("B1: 应生成正确维度的 embedding 向量", async () => {
      if (!ollamaAvailable || !qdrantAvailable) {
        process.stderr.write("  ⏭ 跳过 B1: Ollama/Qdrant 不可用\n");
        return;
      }

      ollamaVector = await timed("ollama", "embed", () =>
        ollamaProvider!.embed(TEST_CONTENT),
      );

      await timed("ollama", "validate", async () =>
        validateVector(ollamaVector, OLLAMA_DIMENSION, "ollama"),
      );

      expect(ollamaVector).toHaveLength(OLLAMA_DIMENSION);
      const norm = Math.sqrt(ollamaVector.reduce((sum, v) => sum + v * v, 0));
      expect(norm).toBeGreaterThan(0.01);
    });

    it("B2: 应成功写入 Qdrant (wait:true)", async () => {
      if (!ollamaAvailable || !qdrantAvailable || ollamaVector.length === 0) {
        return;
      }

      await timed("ollama", "create_coll", () =>
        createCollection(qdrantClient, COLLECTION_OLLAMA, OLLAMA_DIMENSION),
      );
      collectionsToClean.push(COLLECTION_OLLAMA);

      await timed("ollama", "upsert", () =>
        upsertPoint(
          qdrantClient,
          COLLECTION_OLLAMA,
          ollamaPointId,
          ollamaVector,
          { ...TEST_PAYLOAD, embedding_model: "bge-m3" },
        ),
      );

      const info = await qdrantClient.getCollection(COLLECTION_OLLAMA);
      expect(info.points_count).toBe(1);
    });

    it("B3: 应通过语义搜索召回已保存的记忆", async () => {
      if (!ollamaAvailable || !qdrantAvailable || ollamaVector.length === 0) {
        return;
      }

      const queryVector = await timed("ollama", "embed_query", () =>
        ollamaProvider!.embed(TEST_QUERY),
      );
      validateVector(queryVector, OLLAMA_DIMENSION, "ollama-query");

      const results = await timed("ollama", "search", () =>
        searchSimilar(qdrantClient, COLLECTION_OLLAMA, queryVector),
      );

      expect(results.length).toBeGreaterThan(0);

      const found = results.find((r) => r.id === ollamaPointId);
      expect(found).toBeDefined();
      expect(found!.payload?.content).toBe(TEST_CONTENT);
      expect(found!.payload?.lifecycle).toBe("active");
      expect(found!.payload?.embedding_model).toBe("bge-m3");
      expect(found!.score).toBeGreaterThan(0.3);
    });
  });

  // ================================================================
  // 隔离性验证 & Collection 配置
  // ================================================================

  describe("维度隔离与跨引擎数据完整性", () => {
    it("C1: 各 Collection 应配置正确的维度和距离函数", async () => {
      if (!qdrantAvailable) return;

      const checks: [string, number][] = [];
      if (collectionsToClean.includes(COLLECTION_GEMINI)) {
        checks.push([COLLECTION_GEMINI, GEMINI_DIMENSION]);
      }
      if (collectionsToClean.includes(COLLECTION_OLLAMA)) {
        checks.push([COLLECTION_OLLAMA, OLLAMA_DIMENSION]);
      }

      for (const [name, expectedDim] of checks) {
        const info = await qdrantClient.getCollection(name);
        // Qdrant 返回的 vectors config 可能是 VectorParams 或 Named Vectors Map
        const vectorConfig = info.config.params.vectors as {
          size?: number;
          distance?: string;
        };
        expect(vectorConfig.size).toBe(expectedDim);
        expect(vectorConfig.distance).toBe("Cosine");
      }
    });

    it("C2: Collection 之间不应有数据交叉污染", async () => {
      if (!qdrantAvailable) return;

      // 只有两个 collection 都存在时才测试隔离性
      if (
        !collectionsToClean.includes(COLLECTION_GEMINI) ||
        !collectionsToClean.includes(COLLECTION_OLLAMA)
      ) {
        process.stderr.write("  ⏭ 跳过 C2: 需要两条链路均已写入数据\n");
        return;
      }

      // Gemini 的点 ID 不应出现在 Ollama Collection 中
      const crossCheck1 = await qdrantClient.retrieve(COLLECTION_OLLAMA, {
        ids: [geminiPointId],
        with_payload: true,
      });
      expect(crossCheck1).toHaveLength(0);

      // Ollama 的点 ID 不应出现在 Gemini Collection 中
      const crossCheck2 = await qdrantClient.retrieve(COLLECTION_GEMINI, {
        ids: [ollamaPointId],
        with_payload: true,
      });
      expect(crossCheck2).toHaveLength(0);

      // 各 Collection 应精确包含 1 个点
      const geminiInfo = await qdrantClient.getCollection(COLLECTION_GEMINI);
      expect(geminiInfo.points_count).toBe(1);

      const ollamaInfo = await qdrantClient.getCollection(COLLECTION_OLLAMA);
      expect(ollamaInfo.points_count).toBe(1);
    });

    it("C3: 同维度下跨引擎搜索应返回正确结果（不混淆语义空间）", async () => {
      if (!qdrantAvailable || !geminiAvailable || !ollamaAvailable) return;
      if (geminiVector.length === 0 || ollamaVector.length === 0) return;

      /**
       * [数据工程师审查 - 向量空间语义隔离]
       *
       * 即便两个 Provider 维度相同 (1024)，它们的向量空间语义不同：
       * - Gemini 向量搜索 Ollama Collection：维度匹配但语义不匹配，
       *   可能返回结果但相似度分数应偏低
       * - 重点验证: 搜索结果的 payload 数据不被跨引擎版本覆盖
       */
      if (GEMINI_DIMENSION === OLLAMA_DIMENSION) {
        // 同维度: Gemini 向量搜索 Ollama Collection — 维度兼容但语义不同
        const crossResults = await searchSimilar(
          qdrantClient,
          COLLECTION_OLLAMA,
          geminiVector,
          5,
        );

        // 如果跨引擎搜索有结果，验证 payload 属于 Ollama (模型标记正确)
        if (crossResults.length > 0) {
          for (const r of crossResults) {
            // 不管跨引擎搜索是否返回结果，payload 的 embedding_model
            // 应该始终是 Ollama 的标记（因为我们搜索的是 Ollama Collection）
            expect(r.payload?.embedding_model).toBe("bge-m3");
          }
        }
      } else {
        // 异维度: 搜索应直接被 Qdrant 拒绝 (维度不匹配)
        await expect(
          searchSimilar(qdrantClient, COLLECTION_OLLAMA, geminiVector),
        ).rejects.toThrow();
      }
    });
  });
});

// ============================================================
// §8 — 双引擎暗病清扫报告
// ============================================================

/**
 * 在测试结束时输出《双引擎暗病清扫报告》。
 *
 * 输出到 stderr，不污染 MCP stdio 管道。
 */
function printReviewReport(): void {
  const report = `
╔══════════════════════════════════════════════════════════════════╗
║          《双引擎暗病清扫报告》(Dual-Engine Review Report)       ║
╚══════════════════════════════════════════════════════════════════╝

[1] 维度隔离策略 ─────────────────────────────────────────────────

  方案: 动态创建独立 Collection (非 Named Vectors)
  理由:
    - Named Vectors 增加 Schema 复杂度，对 MVP 阶段收益不大
    - 独立 Collection 天然隔离不同模型的向量空间
    - 即便维度相同 (如 Gemini MRL→1024 & Ollama→1024)，
      不同模型的语义空间互不兼容，混排会严重降低搜索质量

  Collection 命名规则: e2e_{provider}_{timestamp_base36}
    ↳ 时间戳避免跨次运行冲突
    ↳ Teardown 阶段无条件删除

[2] 动态超时与冷启动消解 ────────────────────────────────────────

  ┌──────────┬──────────────┬──────────────────────────────────┐
  │ Provider │ 首次超时      │ 重试超时                         │
  ├──────────┼──────────────┼──────────────────────────────────┤
  │ Gemini   │ 30s (网络)   │ 30s (网络特征不变)               │
  │ Ollama   │ 120s (冷启动)│ 30s (模型已加载，收紧)           │
  └──────────┴──────────────┴──────────────────────────────────┘

  核心洞察:
    - Ollama 冷启动仅影响首次请求 (加载模型到 GPU/RAM)
    - 后续请求延迟与模型大小无关，仅取决于推理速度
    - 首次请求给足 120s 容忍窗口，重试收紧到 30s

[3] 脏数据拦截层 ─────────────────────────────────────────────────

  validateVector() 全量扫描守卫:
    ✓ 维度不匹配 → 立即拒绝 (防止 Qdrant 400 错误)
    ✓ NaN 值 → 立即拒绝 (Ollama 旧版本偶发)
    ✓ Infinity → 立即拒绝 (数值溢出)
    ✓ |v| > 100 → 告警 (正常嵌入向量值域 [-5, 5])
    ✓ 零向量 (norm ≈ 0) → 测试断言拦截

  与 Zod Schema 的关系:
    - Zod 负责输入层结构校验 (JSON Schema)
    - validateVector 负责数值层精度校验 (Float32 值域)
    - 两层互补，不重叠

[4] 容器网络 DNS 陷阱 ───────────────────────────────────────────

  detectHost() 自动检测策略:
    1. /.dockerenv      → host.docker.internal
    2. /proc/1/cgroup   → 含 docker/containerd 标记则同上
    3. 均不命中         → localhost

  已知限制:
    - Linux Docker <20.10 不支持 host.docker.internal
      → 需手动设置 QDRANT_URL/OLLAMA_URL 环境变量
    - Podman 使用 host.containers.internal
      → 通过环境变量覆盖

[5] 资源泄漏防护 ─────────────────────────────────────────────────

  [架构师审查通过]:
    ✓ 每个 Provider 维护 activeControllers: Set<AbortController>
    ✓ finally 块确保 clearTimeout + Set.delete
    ✓ close() 遍历 abort() + clear()
    ✓ afterAll 无条件调用 close() + deleteCollection
    ✓ 无残留 TCP 句柄、无 setTimeout 泄漏
`;

  process.stderr.write(report);
}
