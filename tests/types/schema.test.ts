/**
 * @module schema.test
 * @description Zod Schema 单元测试 — 覆盖正常解析、默认值、异常校验、slugify
 */

import { describe, it, expect } from "vitest";
import {
  MemoryMetadataSchema,
  MemorySaveInputSchema,
  MemorySearchInputSchema,
  MemoryForgetInputSchema,
  MemoryStatusInputSchema,
  slugify,
  collectionName,
  THRESHOLDS,
  CURRENT_SCHEMA_VERSION,
} from "../../src/types/schema.js";

describe("MemoryMetadataSchema", () => {
  const validMetadata = {
    content: "test content",
    content_hash: "abc123",
    project: "my-project",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    last_accessed_at: "2026-01-01T00:00:00Z",
  };

  it("should parse valid metadata with defaults", () => {
    const result = MemoryMetadataSchema.parse(validMetadata);
    expect(result.content).toBe("test content");
    expect(result.source).toBe("conversation");
    expect(result.fact_type).toBe("observation");
    expect(result.tags).toEqual([]);
    expect(result.confidence).toBe(0.7);
    expect(result.lifecycle).toBe("active");
    expect(result.access_count).toBe(0);
    expect(result.schema_version).toBe(2);
    expect(result.embedding_model).toBe("unknown");
    expect(result.related_ids).toEqual([]);
  });

  it("should reject empty content", () => {
    expect(() =>
      MemoryMetadataSchema.parse({ ...validMetadata, content: "" }),
    ).toThrow();
  });

  it("should reject missing project", () => {
    const { project: _, ...noProject } = validMetadata;
    expect(() => MemoryMetadataSchema.parse(noProject)).toThrow();
  });

  it("should reject invalid lifecycle", () => {
    expect(() =>
      MemoryMetadataSchema.parse({ ...validMetadata, lifecycle: "draft" }),
    ).toThrow();
  });

  it("should reject confidence out of range", () => {
    expect(() =>
      MemoryMetadataSchema.parse({ ...validMetadata, confidence: 1.5 }),
    ).toThrow();
    expect(() =>
      MemoryMetadataSchema.parse({ ...validMetadata, confidence: -0.1 }),
    ).toThrow();
  });

  it("should reject invalid datetime format", () => {
    expect(() =>
      MemoryMetadataSchema.parse({
        ...validMetadata,
        created_at: "not-a-date",
      }),
    ).toThrow();
  });

  it("should accept all valid source types", () => {
    for (const source of ["conversation", "file_watch", "manual"]) {
      const result = MemoryMetadataSchema.parse({
        ...validMetadata,
        source,
      });
      expect(result.source).toBe(source);
    }
  });

  it("should accept all valid fact_type values", () => {
    for (const ft of [
      "verified_fact",
      "decision",
      "hypothesis",
      "discussion",
      "observation",
    ]) {
      const result = MemoryMetadataSchema.parse({
        ...validMetadata,
        fact_type: ft,
      });
      expect(result.fact_type).toBe(ft);
    }
  });

  it("should accept all valid lifecycle values", () => {
    for (const lc of ["active", "disputed", "outdated", "archived"]) {
      const result = MemoryMetadataSchema.parse({
        ...validMetadata,
        lifecycle: lc,
      });
      expect(result.lifecycle).toBe(lc);
    }
  });

  it("should accept optional fields", () => {
    const result = MemoryMetadataSchema.parse({
      ...validMetadata,
      source_file: "src/auth.ts",
      source_line: 42,
      conversation_id: "conv-123",
      quality_score: 0.85,
      chunk_index: 0,
      parent_id: "parent-uuid",
    });
    expect(result.source_file).toBe("src/auth.ts");
    expect(result.source_line).toBe(42);
    expect(result.conversation_id).toBe("conv-123");
    expect(result.quality_score).toBe(0.85);
  });
});

describe("MemorySaveInputSchema", () => {
  it("should parse valid save input", () => {
    const result = MemorySaveInputSchema.parse({ content: "remember this" });
    expect(result.content).toBe("remember this");
  });

  it("should reject empty content", () => {
    expect(() => MemorySaveInputSchema.parse({ content: "" })).toThrow();
  });

  it("should accept optional project", () => {
    const result = MemorySaveInputSchema.parse({
      content: "test",
      project: "my-proj",
    });
    expect(result.project).toBe("my-proj");
  });
});

describe("MemorySearchInputSchema", () => {
  it("should parse with defaults", () => {
    const result = MemorySearchInputSchema.parse({ query: "find this" });
    expect(result.limit).toBe(5);
    expect(result.threshold).toBe(0.55);
    expect(result.include_outdated).toBe(false);
  });

  it("should reject empty query", () => {
    expect(() => MemorySearchInputSchema.parse({ query: "" })).toThrow();
  });

  it("should reject limit > 20", () => {
    expect(() =>
      MemorySearchInputSchema.parse({ query: "test", limit: 21 }),
    ).toThrow();
  });
});

describe("MemoryForgetInputSchema", () => {
  it("should parse valid forget input", () => {
    const result = MemoryForgetInputSchema.parse({
      id: "550e8400-e29b-41d4-a716-446655440000",
      action: "archive",
      reason: "outdated information",
    });
    expect(result.action).toBe("archive");
  });

  it("should reject invalid UUID", () => {
    expect(() =>
      MemoryForgetInputSchema.parse({
        id: "not-a-uuid",
        action: "archive",
        reason: "test",
      }),
    ).toThrow();
  });

  it("should reject empty reason", () => {
    expect(() =>
      MemoryForgetInputSchema.parse({
        id: "550e8400-e29b-41d4-a716-446655440000",
        action: "archive",
        reason: "",
      }),
    ).toThrow();
  });
});

describe("MemoryStatusInputSchema", () => {
  it("should parse empty object", () => {
    const result = MemoryStatusInputSchema.parse({});
    expect(result.project).toBeUndefined();
  });
});

describe("slugify", () => {
  it("should convert to lowercase and replace special chars", () => {
    expect(slugify("My Project!")).toBe("my-project");
  });

  it("should handle CJK characters", () => {
    // D1-7: CJK 字符现在转为 hex 编码而非被剥离
    expect(slugify("我的项目")).toBe("u6211u7684u9879u76ee");
  });

  it("should trim leading/trailing hyphens", () => {
    expect(slugify("--test--")).toBe("test");
  });

  it("should truncate to 64 characters", () => {
    const long = "a".repeat(100);
    expect(slugify(long).length).toBeLessThanOrEqual(64);
  });

  it("should handle empty string", () => {
    expect(slugify("")).toBe("");
  });

  // D-AUDIT: 防止 slugify 碰撞导致跨项目数据污染
  it("should preserve underscores to prevent collision with hyphens", () => {
    // "my_project" 和 "my-project" 必须映射到不同的 slug
    const slugUnderscore = slugify("my_project");
    const slugHyphen = slugify("my-project");
    expect(slugUnderscore).not.toBe(slugHyphen);
  });

  it("should keep underscores intact in slug", () => {
    expect(slugify("my_project")).toBe("my_project");
    expect(slugify("a_b_c")).toBe("a_b_c");
  });

  it("should produce distinct collection names for similar projects", () => {
    // 多种潜在碰撞场景
    expect(collectionName("foo_bar")).not.toBe(collectionName("foo-bar"));
    expect(collectionName("my_app_v2")).not.toBe(collectionName("my-app-v2"));
  });
});

describe("collectionName", () => {
  it("should prefix with em_", () => {
    expect(collectionName("my-project")).toBe("em_my-project");
  });

  it("should slugify the project name", () => {
    expect(collectionName("My Project!")).toBe("em_my-project");
  });
});

describe("THRESHOLDS", () => {
  it("should have correct search defaults", () => {
    expect(THRESHOLDS.SEARCH_MIN_SCORE).toBe(0.55);
    expect(THRESHOLDS.SEARCH_DEFAULT_LIMIT).toBe(5);
    expect(THRESHOLDS.SEARCH_MAX_LIMIT).toBe(20);
  });

  it("should have correct quality thresholds", () => {
    expect(THRESHOLDS.QUALITY_ACCEPT).toBe(0.6);
    expect(THRESHOLDS.QUALITY_REJECT).toBe(0.4);
  });
});

describe("CURRENT_SCHEMA_VERSION", () => {
  it("should be 2", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(2);
  });
});
