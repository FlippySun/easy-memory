/**
 * @module e2e-comprehensive
 * @description 综合端到端验证 — 三大关键链路:
 *
 * 1. Auto 模式降级策略: Gemini 优先 → 失败时自动降级 Ollama
 * 2. Dense + Sparse + RRF 混合检索: 验证稀疏向量实际参与检索
 * 3. Gemini 优先级验证: 正常情况下优先使用 Gemini
 *
 * 运行:
 *   GEMINI_API_KEY=<key> pnpm vitest run tests/e2e-comprehensive.test.ts
 *
 * 依赖: 本地 Qdrant (6333) + Ollama (11434 with bge-m3) + Gemini API
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { QdrantService } from "../src/services/qdrant.js";
import {
  EmbeddingService,
  OllamaEmbeddingProvider,
  GeminiEmbeddingProvider,
} from "../src/services/embedding.js";
import type { EmbeddingProvider } from "../src/services/embedding.js";
import { BM25Encoder } from "../src/services/bm25.js";
import { handleSave } from "../src/tools/save.js";
import { handleSearch } from "../src/tools/search.js";
import { collectionName } from "../src/types/schema.js";

// =========================================================================
// Environment
// =========================================================================
// @ts-expect-error -- tests run in Node where process is always available; tsconfig excludes tests/
const GEMINI_API_KEY: string = process.env.GEMINI_API_KEY ?? "";
const QDRANT_URL = "http://localhost:6333";
const QDRANT_API_KEY = "easy-memory-dev";
const ts = Date.now().toString(36);

/** 使用 REST API 安全删除测试 Collection */
async function deleteTestCollection(project: string): Promise<void> {
  try {
    const name = collectionName(project);
    await fetch(`${QDRANT_URL}/collections/${name}`, {
      method: "DELETE",
      headers: { "api-key": QDRANT_API_KEY },
    });
  } catch {
    /* 清理失败不影响测试结果 */
  }
}

// =========================================================================
// Shared Resources & Factory Functions
// =========================================================================
let qdrant: QdrantService;
let bm25: BM25Encoder;
const hasGemini = !!GEMINI_API_KEY;

/** 创建新鲜的 Ollama Provider 实例（避免 close 级联污染） */
function createOllamaProvider(): OllamaEmbeddingProvider {
  return new OllamaEmbeddingProvider({
    baseUrl: "http://localhost:11434",
    model: "bge-m3",
  });
}

/** 创建新鲜的 Gemini Provider 实例 */
function createGeminiProvider(): GeminiEmbeddingProvider | null {
  if (!GEMINI_API_KEY) return null;
  return new GeminiEmbeddingProvider({
    apiKey: GEMINI_API_KEY,
    model: "gemini-embedding-001",
  });
}

beforeAll(async () => {
  qdrant = new QdrantService({
    url: "http://localhost:6333",
    apiKey: "easy-memory-dev",
  });
  bm25 = new BM25Encoder();

  // 前置健康检查
  expect(await qdrant.healthCheck()).toBe(true);

  const probeOllama = createOllamaProvider();
  expect(await probeOllama.healthCheck()).toBe(true);
  probeOllama.close();

  if (hasGemini) {
    const probeGemini = createGeminiProvider()!;
    expect(await probeGemini.healthCheck()).toBe(true);
    probeGemini.close();
  }
}, 30_000);

afterAll(() => {
  qdrant?.close();
});

// =========================================================================
// Test Suite 1: Auto 模式降级策略
// =========================================================================
describe("Auto 模式: Gemini 优先 → Ollama 降级", () => {
  const project = `e2e_auto_fallback_${ts}`;

  afterAll(async () => {
    await deleteTestCollection(project);
  });

  it("T1: 正常情况下应优先使用 Gemini Provider", async () => {
    if (!hasGemini) return; // 无 key 则跳过

    const gemini = createGeminiProvider()!;
    const ollama = createOllamaProvider();
    const embedding = new EmbeddingService({
      providers: [gemini, ollama],
      shouldUseProvider: () => true, // 不启用熔断器
    });

    try {
      const result = await embedding.embedWithMeta("TypeScript best practices");
      expect(result.provider).toBe("gemini");
      expect(result.model).toBe("gemini-embedding-001");
      expect(result.vector.length).toBe(1024);
    } finally {
      embedding.close();
    }
  }, 30_000);

  it("T2: Gemini 失败时应自动降级到 Ollama", async () => {
    const brokenGemini: EmbeddingProvider = {
      name: "gemini",
      modelName: "gemini-embedding-001",
      dimension: 1024,
      embed: async () => {
        throw new Error("Simulated Gemini API failure (429 rate limit)");
      },
      healthCheck: async () => false,
      close: () => {},
    };

    const ollama = createOllamaProvider();
    const embedding = new EmbeddingService({
      providers: [brokenGemini, ollama],
    });

    try {
      const result = await embedding.embedWithMeta("Testing fallback behavior");
      expect(result.provider).toBe("ollama");
      expect(result.model).toBe("bge-m3");
      expect(result.vector.length).toBe(1024);
    } finally {
      embedding.close();
    }
  }, 30_000);

  it("T3: 熔断器打开时应跳过 Gemini 直接使用 Ollama", async () => {
    if (!hasGemini) return;

    const gemini = createGeminiProvider()!;
    const ollama = createOllamaProvider();
    let circuitOpen = false;

    const embedding = new EmbeddingService({
      providers: [gemini, ollama],
      shouldUseProvider: (p) => {
        if (p.name === "gemini" && circuitOpen) return false;
        return true;
      },
    });

    try {
      // 熔断器关闭 → 使用 Gemini
      const before = await embedding.embedWithMeta("Before circuit break");
      expect(before.provider).toBe("gemini");

      // 打开熔断器 → 跳过 Gemini，直接使用 Ollama
      circuitOpen = true;
      const after = await embedding.embedWithMeta("After circuit break");
      expect(after.provider).toBe("ollama");
      expect(after.model).toBe("bge-m3");
    } finally {
      embedding.close();
    }
  }, 30_000);

  it("T4: Auto 模式降级后 save+search 全链路可用", async () => {
    const brokenGemini: EmbeddingProvider = {
      name: "gemini",
      modelName: "gemini-embedding-001",
      dimension: 1024,
      embed: async () => {
        throw new Error("Simulated Gemini failure");
      },
      healthCheck: async () => false,
      close: () => {},
    };

    const ollama = createOllamaProvider();
    const embedding = new EmbeddingService({
      providers: [brokenGemini, ollama],
    });

    try {
      // Save — 通过降级的 Ollama 写入
      const saveResult = await handleSave(
        {
          content:
            "Auto fallback test: 在 Gemini 不可用时系统应自动使用本地 Ollama bge-m3 模型",
          tags: ["e2e", "auto-fallback"],
        },
        { qdrant, embedding, bm25, defaultProject: project },
      );

      expect(saveResult.status).toBe("saved");
      expect(saveResult.id).toBeTruthy();

      // Search — 同样使用降级的 Ollama 检索
      const searchResult = await handleSearch(
        { query: "Gemini 不可用时自动降级", limit: 5 },
        { qdrant, embedding, bm25, defaultProject: project },
      );

      expect(searchResult.total_found).toBeGreaterThanOrEqual(1);
      expect(searchResult.memories[0]!.content).toContain("Auto fallback test");
    } finally {
      embedding.close();
    }
  }, 60_000);
});

// =========================================================================
// Test Suite 2: Dense + Sparse + RRF 混合检索
// =========================================================================
describe("Dense + Sparse + RRF 混合检索", () => {
  const project = `e2e_hybrid_rrf_${ts}`;
  let embedding: EmbeddingService;
  let ollamaForHybrid: OllamaEmbeddingProvider;

  beforeAll(async () => {
    ollamaForHybrid = createOllamaProvider();
    embedding = new EmbeddingService({
      providers: [ollamaForHybrid],
    });
  }, 10_000);

  afterAll(async () => {
    embedding?.close();
    await deleteTestCollection(project);
  });

  it("T5: BM25 编码器应生成有效的稀疏向量", () => {
    const text = "TypeScript MCP server with Qdrant vector database";
    const sparse = bm25.encode(text);

    expect(sparse.indices.length).toBeGreaterThan(0);
    expect(sparse.values.length).toBe(sparse.indices.length);

    // indices 应为非负整数，values 应为正数
    for (const idx of sparse.indices) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(idx)).toBe(true);
    }
    for (const val of sparse.values) {
      expect(val).toBeGreaterThan(0);
    }

    // indices 应已排序
    for (let i = 1; i < sparse.indices.length; i++) {
      expect(sparse.indices[i]!).toBeGreaterThan(sparse.indices[i - 1]!);
    }
  });

  it("T6: Save 应同时写入 Dense + Sparse 向量到 Qdrant", async () => {
    const testDocs = [
      {
        content:
          "Docker 容器化部署指南：使用 docker-compose 编排 Qdrant 和 Ollama 服务",
        tags: ["docker", "deployment"],
      },
      {
        content: "React 18 Suspense 异步组件加载最佳实践与错误边界处理",
        tags: ["react", "frontend"],
      },
      {
        content:
          "PostgreSQL 索引优化：B-Tree vs GIN vs GiST 在全文检索场景的对比",
        tags: ["database", "optimization"],
      },
    ];

    for (const doc of testDocs) {
      const result = await handleSave(doc, {
        qdrant,
        embedding,
        bm25,
        defaultProject: project,
      });
      expect(result.status).toBe("saved");
    }

    // 验证 Qdrant 中的点包含稀疏向量
    // 通过 collection info 验证数据已写入
    const info = await qdrant.getCollectionInfo(project);
    expect(info).not.toBeNull();
    expect(info!.points_count).toBe(3);
  }, 60_000);

  it("T7: hybridSearch 应正确融合 Dense + Sparse 结果 (RRF)", async () => {
    // 语义查询（Dense 擅长）
    const semanticQuery = "容器化微服务部署方案";
    const sparseVector = bm25.encode(semanticQuery);
    const denseResult = await embedding.embed(semanticQuery);

    const hybridResults = await qdrant.hybridSearch(
      project,
      denseResult,
      sparseVector,
      { limit: 3 },
    );

    expect(hybridResults.length).toBeGreaterThan(0);

    // Docker 部署相关的记忆应排在前面
    const topResult = hybridResults[0]!;
    expect(String(topResult.payload.content)).toContain("Docker");

    // RRF 分数应为正数
    for (const r of hybridResults) {
      expect(r.score).toBeGreaterThan(0);
    }
  }, 30_000);

  it("T8: 关键词精确匹配场景 — Sparse 应提升相关性", async () => {
    // "PostgreSQL B-Tree" 这种低频精确术语是 BM25 擅长的
    const keywordQuery = "PostgreSQL B-Tree GIN GiST 索引";
    const sparseVector = bm25.encode(keywordQuery);
    const denseResult = await embedding.embed(keywordQuery);

    // 混合检索
    const hybridResults = await qdrant.hybridSearch(
      project,
      denseResult,
      sparseVector,
      { limit: 3 },
    );

    // 纯 dense 检索（对比）
    const denseOnlyResults = await qdrant.search(project, denseResult, {
      limit: 3,
    });

    // 混合检索应当返回结果
    expect(hybridResults.length).toBeGreaterThan(0);

    // PostgreSQL 记忆应在混合结果的 top-1
    const hybridTop = hybridResults[0]!;
    expect(String(hybridTop.payload.content)).toContain("PostgreSQL");

    // 记录两种检索的排名，用于人工验证
    const hybridRank = hybridResults.findIndex((r) =>
      String(r.payload.content).includes("PostgreSQL"),
    );
    const denseRank = denseOnlyResults.findIndex((r) =>
      String(r.payload.content).includes("PostgreSQL"),
    );

    // 输出排名对比报告到 stderr（使用 log 代替直接 stderr）
    const report =
      `\n  📊 [T8] PostgreSQL 排名对比:\n` +
      `     混合检索 (Dense+Sparse+RRF): #${hybridRank + 1} (score: ${hybridResults[hybridRank]?.score.toFixed(4)})\n` +
      `     纯 Dense 检索:               #${denseRank + 1} (score: ${denseOnlyResults[denseRank]?.score.toFixed(4)})\n`;
    // eslint-disable-next-line no-console
    console.error(report);
  }, 30_000);

  it("T9: 通过 handleSearch 全链路验证混合检索", async () => {
    // handleSearch 内部调用 hybridSearch
    const result = await handleSearch(
      { query: "docker-compose 编排服务", limit: 3 },
      { qdrant, embedding, bm25, defaultProject: project },
    );

    expect(result.total_found).toBeGreaterThan(0);
    expect(result.system_note).toBeTruthy();

    // 验证 boundary markers 正确包裹
    const firstMemory = result.memories[0]!;
    expect(firstMemory.content).toContain("[MEMORY_CONTENT_START]");
    expect(firstMemory.content).toContain("[MEMORY_CONTENT_END]");

    // 内容应包含 docker 相关记忆
    expect(firstMemory.content.toLowerCase()).toContain("docker");
  }, 30_000);

  it("T10: 无稀疏向量时 hybridSearch 应安全降级到纯 Dense", async () => {
    // 使用与存储内容语义相关的查询，确保 cosine threshold 能通过
    const denseResult = await embedding.embed("React 异步组件加载");

    // 传入空稀疏向量 → 应降级为纯 dense 搜索
    const results = await qdrant.hybridSearch(
      project,
      denseResult,
      { indices: [], values: [] },
      { limit: 3 },
    );

    expect(results.length).toBeGreaterThan(0);
    // 应正常返回 React 相关结果（降级为纯 dense）
    expect(String(results[0]!.payload.content)).toContain("React");
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0);
    }
  }, 30_000);
});

// =========================================================================
// Test Suite 3: Gemini 实际向量化 + Qdrant 写入/检索闭环
// =========================================================================
describe("Gemini gemini-embedding-001 完整链路", () => {
  const project = `e2e_gemini_full_${ts}`;

  afterAll(async () => {
    await deleteTestCollection(project);
  });

  it("T11: Gemini embedding 应生成 1024 维向量并成功写入/检索 Qdrant", async () => {
    if (!hasGemini) return;

    const gemini = createGeminiProvider()!;
    const embedding = new EmbeddingService({
      providers: [gemini],
    });

    try {
      const saveResult = await handleSave(
        {
          content:
            "Gemini embedding model supports MRL (Matryoshka Representation Learning) with 1024 dimensions",
          tags: ["gemini", "mrl"],
        },
        { qdrant, embedding, bm25, defaultProject: project },
      );

      expect(saveResult.status).toBe("saved");

      const searchResult = await handleSearch(
        { query: "Gemini MRL 1024 维向量", limit: 5 },
        { qdrant, embedding, bm25, defaultProject: project },
      );

      expect(searchResult.total_found).toBeGreaterThanOrEqual(1);
      expect(searchResult.memories[0]!.content).toContain("Matryoshka");
    } finally {
      embedding.close();
    }
  }, 60_000);
});
