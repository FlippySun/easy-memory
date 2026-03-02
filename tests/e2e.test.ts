/**
 * @module e2e.test
 * @description E2E 集成测试 — 真实连接 Qdrant + Ollama 完成完整 CRUD 闭环。
 *
 * 要求:
 * - Qdrant 运行在 localhost:6333 (API Key: easy-memory-dev)
 * - Ollama 运行在 localhost:11434 (已安装 nomic-embed-text)
 *
 * 调用链: save → search → forget → search (验证不可召回)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { QdrantService } from "../src/services/qdrant.js";
import {
  EmbeddingService,
  OllamaEmbeddingProvider,
} from "../src/services/embedding.js";
import { handleSave, clearHashCache } from "../src/tools/save.js";
import { handleSearch } from "../src/tools/search.js";
import { handleForget } from "../src/tools/forget.js";
import { handleStatus } from "../src/tools/status.js";
import { collectionName } from "../src/types/schema.js";

const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const QDRANT_API_KEY = process.env.QDRANT_API_KEY ?? "easy-memory-dev";
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const E2E_PROJECT = `e2e-test-${Date.now()}`;

let qdrant: QdrantService;
let embedding: EmbeddingService;
let deps: {
  qdrant: QdrantService;
  embedding: EmbeddingService;
  defaultProject: string;
};

/**
 * 检测外部依赖是否就绪，否则跳过全部测试。
 */
async function checkDependencies(): Promise<boolean> {
  try {
    const [qdrantOK, ollamaOK] = await Promise.all([
      fetch(`${QDRANT_URL}/healthz`)
        .then((r) => r.ok)
        .catch(() => false),
      fetch(`${OLLAMA_URL}/api/tags`)
        .then((r) => r.ok)
        .catch(() => false),
    ]);
    return qdrantOK && ollamaOK;
  } catch {
    return false;
  }
}

describe("E2E: Full Memory CRUD Lifecycle", () => {
  let servicesAvailable = false;
  let savedMemoryId = "";

  beforeAll(async () => {
    servicesAvailable = await checkDependencies();

    if (!servicesAvailable) {
      return; // 外部服务不可用时跳过而非崩溃
    }

    qdrant = new QdrantService({
      url: QDRANT_URL,
      apiKey: QDRANT_API_KEY,
    });

    embedding = new EmbeddingService({
      providers: [new OllamaEmbeddingProvider({ baseUrl: OLLAMA_URL })],
    });

    deps = {
      qdrant,
      embedding,
      defaultProject: E2E_PROJECT,
    };

    // 清理 hash 缓存确保干净状态
    clearHashCache();
  });

  afterAll(async () => {
    if (!servicesAvailable) return;

    // 清理测试 collection
    try {
      const name = collectionName(E2E_PROJECT);
      // 直接用 Qdrant REST API 删除 collection
      await fetch(`${QDRANT_URL}/collections/${name}`, {
        method: "DELETE",
        headers: {
          "api-key": QDRANT_API_KEY,
        },
      });
    } catch {
      // 清理失败不影响测试结果
    }

    clearHashCache();
  });

  it("should verify services are healthy via status tool", async () => {
    if (!servicesAvailable) {
      process.stderr.write("⏭️  Skipping E2E: Qdrant/Ollama not available\n");
      return;
    }

    const status = await handleStatus({}, deps);

    expect(status.qdrant).toBe("ready");
    expect(status.embedding).toBe("ready");
  });

  it("should save a memory and return a valid UUID", async () => {
    if (!servicesAvailable) return;

    const result = await handleSave(
      {
        content:
          "The Easy Memory MCP project uses nomic-embed-text for generating 768-dimensional vectors stored in Qdrant.",
        source: "manual",
        fact_type: "verified_fact",
        tags: ["architecture", "embedding"],
        confidence: 0.95,
      },
      deps,
    );

    expect(result.status).toBe("saved");
    expect(result.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    savedMemoryId = result.id;
  });

  it("should search and recall the saved memory", async () => {
    if (!servicesAvailable || !savedMemoryId) return;

    const result = await handleSearch(
      {
        query: "What embedding model does Easy Memory use?",
        limit: 5,
        threshold: 0.3, // 放宽阈值确保能召回
      },
      deps,
    );

    expect(result.total_found).toBeGreaterThan(0);
    expect(result.system_note).toBeTruthy();

    // 验证 boundary markers
    const found = result.memories.find((m) => m.id === savedMemoryId);
    expect(found).toBeDefined();
    expect(found!.content).toContain("[MEMORY_CONTENT_START]");
    expect(found!.content).toContain("[MEMORY_CONTENT_END]");
    expect(found!.content).toContain("nomic-embed-text");
  });

  it("should reject duplicate content via hash dedup", async () => {
    if (!servicesAvailable) return;

    const result = await handleSave(
      {
        content:
          "The Easy Memory MCP project uses nomic-embed-text for generating 768-dimensional vectors stored in Qdrant.",
        source: "manual",
      },
      deps,
    );

    expect(result.status).toBe("duplicate_merged");
    expect(result.id).toBe("");
  });

  it("should forget (archive) the memory", async () => {
    if (!servicesAvailable || !savedMemoryId) return;

    const result = await handleForget(
      {
        id: savedMemoryId,
        action: "archive",
        reason: "E2E test cleanup",
      },
      deps,
    );

    expect(result.status).toBe("archived");
    expect(result.message).toContain(savedMemoryId);
  });

  it("should NOT recall archived memory in normal search", async () => {
    if (!servicesAvailable || !savedMemoryId) return;

    const result = await handleSearch(
      {
        query: "What embedding model does Easy Memory use?",
        limit: 5,
        threshold: 0.3,
        include_outdated: false, // 默认行为，不包含 archived
      },
      deps,
    );

    // 已归档的记忆不应出现在结果中
    const found = result.memories.find((m) => m.id === savedMemoryId);
    expect(found).toBeUndefined();
  });

  it("should recall archived memory when include_outdated=true", async () => {
    if (!servicesAvailable || !savedMemoryId) return;

    const result = await handleSearch(
      {
        query: "What embedding model does Easy Memory use?",
        limit: 5,
        threshold: 0.3,
        include_outdated: true,
      },
      deps,
    );

    // 包含已过期时应能找到已归档记忆
    const found = result.memories.find((m) => m.id === savedMemoryId);
    expect(found).toBeDefined();
    expect(found!.content).toContain("nomic-embed-text");
  });

  it("should downgrade delete to archive in Phase 1", async () => {
    if (!servicesAvailable) return;

    // 先保存一条新记忆
    const saveResult = await handleSave(
      {
        content:
          "Phase 1 delete downgrade test — this memory will be soft-deleted",
        source: "manual",
        fact_type: "discussion",
      },
      deps,
    );
    expect(saveResult.status).toBe("saved");

    // 尝试 delete，应降级为 archive
    const forgetResult = await handleForget(
      {
        id: saveResult.id,
        action: "delete",
        reason: "Testing Phase 1 delete downgrade",
      },
      deps,
    );

    expect(forgetResult.status).toBe("archived"); // 降级为 archived
  });
});
