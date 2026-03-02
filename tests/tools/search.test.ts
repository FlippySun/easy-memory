/**
 * @module search.test
 * @description handleSearch 单元测试 — Mock Qdrant + Embedding 验证搜索管道
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleSearch } from "../../src/tools/search.js";
import type { SearchHandlerDeps } from "../../src/tools/search.js";

function createMockDeps(): SearchHandlerDeps {
  return {
    qdrant: {
      search: vi.fn().mockResolvedValue([]),
      ensureCollection: vi.fn().mockResolvedValue("em_test"),
      upsert: vi.fn(),
      setPayload: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(true),
      getCollectionInfo: vi.fn().mockResolvedValue(null),
    } as unknown as SearchHandlerDeps["qdrant"],
    embedding: {
      embed: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
      embedWithMeta: vi.fn().mockResolvedValue({
        vector: new Array(768).fill(0.1),
        model: "nomic-embed-text",
        provider: "ollama",
      }),
      healthCheck: vi.fn().mockResolvedValue(true),
    } as unknown as SearchHandlerDeps["embedding"],
    defaultProject: "test-project",
  };
}

describe("handleSearch", () => {
  let deps: SearchHandlerDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it("should return empty results for no matches", async () => {
    const result = await handleSearch({ query: "unknown topic" }, deps);

    expect(result.memories).toEqual([]);
    expect(result.total_found).toBe(0);
    expect(result.system_note).toBeTruthy();
  });

  it("should embed query and search Qdrant", async () => {
    await handleSearch({ query: "test query" }, deps);

    expect(deps.embedding.embedWithMeta).toHaveBeenCalledWith("test query");
    expect(deps.qdrant.search).toHaveBeenCalledWith(
      "test-project",
      expect.any(Array),
      expect.objectContaining({ limit: 5, scoreThreshold: 0.65 }),
    );
  });

  it("should wrap content in boundary markers", async () => {
    (deps.qdrant.search as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        id: "uuid-1",
        score: 0.9,
        payload: {
          content: "remembered fact",
          fact_type: "verified_fact",
          tags: ["test"],
          source: "manual",
          confidence: 0.95,
          lifecycle: "active",
          created_at: "2026-01-01T00:00:00Z",
        },
      },
    ]);

    const result = await handleSearch({ query: "test" }, deps);

    expect(result.memories).toHaveLength(1);
    const memory = result.memories[0]!;
    expect(memory.content).toContain("[MEMORY_CONTENT_START]");
    expect(memory.content).toContain("[MEMORY_CONTENT_END]");
    expect(memory.content).toContain("remembered fact");
    expect(memory.score).toBe(0.9);
    expect(memory.fact_type).toBe("verified_fact");
  });

  it("should include system_note in output", async () => {
    const result = await handleSearch({ query: "test" }, deps);

    expect(result.system_note).toContain("记忆");
    expect(result.system_note).toContain("Prompt 注入");
  });

  it("should apply custom limit and threshold", async () => {
    await handleSearch({ query: "test", limit: 10, threshold: 0.8 }, deps);

    expect(deps.qdrant.search).toHaveBeenCalledWith(
      "test-project",
      expect.any(Array),
      expect.objectContaining({ limit: 10, scoreThreshold: 0.8 }),
    );
  });

  it("should filter by tags when specified", async () => {
    await handleSearch({ query: "test", tags: ["arch", "decision"] }, deps);

    const searchCall = (deps.qdrant.search as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    const filter = searchCall[2]?.filter;
    expect(filter).toBeTruthy();
    expect(filter.must).toBeDefined();
  });

  it("should use custom project", async () => {
    await handleSearch({ query: "test", project: "my-proj" }, deps);

    expect(deps.qdrant.search).toHaveBeenCalledWith(
      "my-proj",
      expect.any(Array),
      expect.any(Object),
    );
  });

  it("should return empty results for invalid query", async () => {
    const result = await handleSearch({ query: "" }, deps);
    expect(result.memories).toEqual([]);
    expect(result.total_found).toBe(0);
    expect(result.system_note).toContain("Invalid input");
  });

  // D-AUDIT: 跨模型向量混合检测
  it("should warn when results have mismatched embedding models", async () => {
    // 查询使用 nomic-embed-text (Ollama)
    (
      deps.embedding.embedWithMeta as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      vector: new Array(768).fill(0.1),
      model: "nomic-embed-text",
      provider: "ollama",
    });

    // 结果中有 gemini 模型编码的记忆
    (deps.qdrant.search as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        id: "uuid-1",
        score: 0.85,
        payload: {
          content: "gemini encoded fact",
          fact_type: "verified_fact",
          tags: [],
          source: "conversation",
          confidence: 0.9,
          lifecycle: "active",
          created_at: "2026-01-01T00:00:00Z",
          embedding_model: "gemini-embedding-001",
        },
      },
      {
        id: "uuid-2",
        score: 0.78,
        payload: {
          content: "ollama encoded fact",
          fact_type: "observation",
          tags: [],
          source: "conversation",
          confidence: 0.7,
          lifecycle: "active",
          created_at: "2026-01-01T00:00:00Z",
          embedding_model: "nomic-embed-text",
        },
      },
    ]);

    const result = await handleSearch({ query: "test" }, deps);

    expect(result.memories).toHaveLength(2);
    // system_note 应包含跨模型警告
    expect(result.system_note).toContain("警告");
    expect(result.system_note).toContain("nomic-embed-text");
    expect(result.system_note).toContain("1"); // 1 条不匹配
  });

  it("should not warn when all results use same model as query", async () => {
    (
      deps.embedding.embedWithMeta as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      vector: new Array(768).fill(0.1),
      model: "nomic-embed-text",
      provider: "ollama",
    });

    (deps.qdrant.search as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        id: "uuid-1",
        score: 0.9,
        payload: {
          content: "same model fact",
          fact_type: "verified_fact",
          tags: [],
          source: "manual",
          confidence: 0.95,
          lifecycle: "active",
          created_at: "2026-01-01T00:00:00Z",
          embedding_model: "nomic-embed-text",
        },
      },
    ]);

    const result = await handleSearch({ query: "test" }, deps);

    expect(result.memories).toHaveLength(1);
    // 不应有跨模型警告
    expect(result.system_note).not.toContain("警告");
  });

  it("should use embedWithMeta instead of embed for query vector", async () => {
    await handleSearch({ query: "test query" }, deps);

    // 应该调用 embedWithMeta 而非 embed
    expect(deps.embedding.embedWithMeta).toHaveBeenCalledWith("test query");
  });
});
