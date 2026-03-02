/**
 * @module save.test
 * @description handleSave 单元测试 — Mock Qdrant + Embedding 验证管道
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleSave, clearHashCache } from "../../src/tools/save.js";
import type { SaveHandlerDeps } from "../../src/tools/save.js";

function createMockDeps(): SaveHandlerDeps {
  return {
    qdrant: {
      upsert: vi.fn().mockResolvedValue(undefined),
      ensureCollection: vi.fn().mockResolvedValue("em_test"),
      search: vi.fn().mockResolvedValue([]),
      setPayload: vi.fn().mockResolvedValue(undefined),
      healthCheck: vi.fn().mockResolvedValue(true),
      getCollectionInfo: vi.fn().mockResolvedValue(null),
    } as unknown as SaveHandlerDeps["qdrant"],
    embedding: {
      embed: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
      embedWithMeta: vi.fn().mockResolvedValue({
        vector: new Array(768).fill(0.1),
        model: "nomic-embed-text",
        provider: "ollama",
      }),
      healthCheck: vi.fn().mockResolvedValue(true),
      close: vi.fn(),
    } as unknown as SaveHandlerDeps["embedding"],
    defaultProject: "test-project",
  };
}

describe("handleSave", () => {
  let deps: SaveHandlerDeps;

  beforeEach(() => {
    deps = createMockDeps();
    clearHashCache();
  });

  it("should save valid content successfully", async () => {
    const result = await handleSave({ content: "Remember this fact" }, deps);

    expect(result.status).toBe("saved");
    expect(result.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result.message).toContain("saved");
    expect(deps.qdrant.upsert).toHaveBeenCalledTimes(1);
    expect(deps.embedding.embedWithMeta).toHaveBeenCalledTimes(1);
  });

  it("should use defaultProject when project not specified", async () => {
    await handleSave({ content: "test" }, deps);

    const upsertCall = (deps.qdrant.upsert as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(upsertCall[0]).toBe("test-project");
  });

  it("should use specified project", async () => {
    await handleSave({ content: "test", project: "my-proj" }, deps);

    const upsertCall = (deps.qdrant.upsert as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(upsertCall[0]).toBe("my-proj");
  });

  it("should reject fully redacted content", async () => {
    const result = await handleSave(
      { content: "postgres://user:pass@host:5432/db" },
      deps,
    );

    expect(result.status).toBe("rejected_sensitive");
    expect(deps.qdrant.upsert).not.toHaveBeenCalled();
    expect(deps.embedding.embedWithMeta).not.toHaveBeenCalled();
  });

  it("should detect duplicate content via hash", async () => {
    await handleSave({ content: "unique fact" }, deps);
    const result = await handleSave({ content: "unique fact" }, deps);

    expect(result.status).toBe("duplicate_merged");
    expect(deps.qdrant.upsert).toHaveBeenCalledTimes(1); // Only first save
  });

  it("should sanitize content before saving", async () => {
    await handleSave(
      { content: "Key is AKIAIOSFODNN7EXAMPLE and some text here" },
      deps,
    );

    const upsertCall = (deps.qdrant.upsert as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    const payload = upsertCall[1][0].payload;
    expect(payload.content).toContain("[REDACTED]");
    expect(payload.content).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("should include all metadata in payload", async () => {
    await handleSave(
      {
        content: "test content",
        source: "manual",
        fact_type: "decision",
        tags: ["tech", "arch"],
        confidence: 0.9,
        source_file: "src/index.ts",
        source_line: 42,
        related_ids: ["id-1"],
      },
      deps,
    );

    const upsertCall = (deps.qdrant.upsert as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    const payload = upsertCall[1][0].payload;
    expect(payload.source).toBe("manual");
    expect(payload.fact_type).toBe("decision");
    expect(payload.tags).toEqual(["tech", "arch"]);
    expect(payload.confidence).toBe(0.9);
    expect(payload.source_file).toBe("src/index.ts");
    expect(payload.source_line).toBe(42);
    expect(payload.related_ids).toEqual(["id-1"]);
    expect(payload.lifecycle).toBe("active");
    expect(payload.schema_version).toBe(2);
    expect(payload.embedding_model).toBe("nomic-embed-text");
  });

  it("should reject invalid input (empty content) with structured response", async () => {
    const result = await handleSave({ content: "" }, deps);
    expect(result.status).toBe("rejected_low_quality");
    expect(result.message).toContain("Invalid input");
    expect(result.id).toBe("");
  });

  it("should return pending_embedding on embedding failure", async () => {
    (
      deps.embedding.embedWithMeta as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("Ollama down"));

    const result = await handleSave({ content: "test" }, deps);
    expect(result.status).toBe("pending_embedding");
    expect(result.message).toContain("Ollama down");
  });

  it("should use actual provider model in payload when fallback occurs", async () => {
    // 模拟降级场景: Gemini 成功 → embedding_model 应为 gemini 的模型名
    (
      deps.embedding.embedWithMeta as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      vector: new Array(768).fill(0.2),
      model: "gemini-embedding-001",
      provider: "gemini",
    });

    await handleSave({ content: "fallback test content" }, deps);

    const upsertCall = (deps.qdrant.upsert as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    const payload = upsertCall[1][0].payload;
    expect(payload.embedding_model).toBe("gemini-embedding-001");
  });
});
