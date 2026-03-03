/**
 * @module bm25.test
 * @description BM25 稀疏向量编码器单元测试。
 *
 * 覆盖:
 * 1. 基本编码功能（英文/中文/混合）
 * 2. 确定性验证（同一输入 → 同一输出）
 * 3. Stop words 过滤
 * 4. 空输入 / 边界情况
 * 5. Hash 函数分布质量
 * 6. BM25 TF 分量计算正确性
 * 7. indices 排序保证
 */

import { describe, it, expect } from "vitest";
import { BM25Encoder, type SparseVector } from "../../src/services/bm25.js";

describe("BM25Encoder", () => {
  const encoder = new BM25Encoder();

  // ===== 基本功能 =====

  describe("encode() — 基本功能", () => {
    it("should encode English text into a sparse vector", () => {
      const result = encoder.encode(
        "TypeScript is a typed superset of JavaScript",
      );
      expect(result.indices.length).toBeGreaterThan(0);
      expect(result.values.length).toBe(result.indices.length);
      // 所有 values 应为正数
      for (const v of result.values) {
        expect(v).toBeGreaterThan(0);
      }
    });

    it("should encode Chinese text into sparse vector (single-char tokens)", () => {
      const result = encoder.encode("向量数据库是现代人工智能基础设施");
      expect(result.indices.length).toBeGreaterThan(0);
      expect(result.values.length).toBe(result.indices.length);
    });

    it("should encode mixed CJK + English text", () => {
      const result = encoder.encode("使用 TypeScript 开发 MCP 协议");
      expect(result.indices.length).toBeGreaterThan(0);
      // 应包含英文和中文 token
      const tokens = encoder.tokenize("使用 TypeScript 开发 MCP 协议");
      expect(tokens).toContain("typescript");
      expect(tokens).toContain("mcp");
      expect(tokens).toContain("使");
      expect(tokens).toContain("用");
    });

    it("should return empty sparse vector for empty text", () => {
      const result = encoder.encode("");
      expect(result.indices).toEqual([]);
      expect(result.values).toEqual([]);
    });

    it("should return empty sparse vector for whitespace-only text", () => {
      const result = encoder.encode("   \n\t  ");
      expect(result.indices).toEqual([]);
      expect(result.values).toEqual([]);
    });

    it("should return empty sparse vector for stop-words-only text", () => {
      const result = encoder.encode("the is are was were");
      expect(result.indices).toEqual([]);
      expect(result.values).toEqual([]);
    });
  });

  // ===== 确定性 =====

  describe("encode() — 确定性", () => {
    it("should produce identical output for identical input", () => {
      const text = "Memory search with BM25 sparse encoding";
      const result1 = encoder.encode(text);
      const result2 = encoder.encode(text);
      expect(result1).toEqual(result2);
    });

    it("should be case-insensitive", () => {
      const result1 = encoder.encode("TypeScript");
      const result2 = encoder.encode("typescript");
      expect(result1).toEqual(result2);
    });

    it("should produce different output for different input", () => {
      const result1 = encoder.encode("vector database");
      const result2 = encoder.encode("quantum computing");
      // 不同内容应有不同的 indices
      expect(result1.indices).not.toEqual(result2.indices);
    });
  });

  // ===== Stop Words =====

  describe("tokenize() — Stop words 过滤", () => {
    it("should filter English stop words", () => {
      const tokens = encoder.tokenize("this is a test of the system");
      expect(tokens).not.toContain("this");
      expect(tokens).not.toContain("is");
      expect(tokens).not.toContain("a");
      expect(tokens).not.toContain("of");
      expect(tokens).not.toContain("the");
      expect(tokens).toContain("test");
      expect(tokens).toContain("system");
    });

    it("should not filter CJK characters", () => {
      const tokens = encoder.tokenize("这是一个测试");
      // 中文单字全部保留
      expect(tokens).toContain("这");
      expect(tokens).toContain("是");
      expect(tokens).toContain("一");
      expect(tokens).toContain("个");
      expect(tokens).toContain("测");
      expect(tokens).toContain("试");
    });

    it("should not filter domain-specific terms", () => {
      const tokens = encoder.tokenize("bge-m3 embedding model qdrant vector");
      expect(tokens).toContain("bge");
      expect(tokens).toContain("m3");
      expect(tokens).toContain("embedding");
      expect(tokens).toContain("model");
      expect(tokens).toContain("qdrant");
      expect(tokens).toContain("vector");
    });
  });

  // ===== indices 排序 =====

  describe("encode() — indices 排序", () => {
    it("should produce sorted indices", () => {
      const result = encoder.encode(
        "TypeScript JavaScript Python Rust Go Java Kotlin Swift",
      );
      for (let i = 1; i < result.indices.length; i++) {
        expect(result.indices[i]).toBeGreaterThan(result.indices[i - 1]!);
      }
    });

    it("should produce unique indices", () => {
      const result = encoder.encode(
        "database vector sparse dense hybrid search query",
      );
      const uniqueIndices = new Set(result.indices);
      expect(uniqueIndices.size).toBe(result.indices.length);
    });
  });

  // ===== BM25 TF 分量 =====

  describe("encode() — BM25 TF 分量", () => {
    it("should give higher weight to more frequent terms", () => {
      // "typescript" 出现 3 次，"python" 出现 1 次
      const result = encoder.encode("typescript typescript typescript python");
      const tsIndex = encoder.hashTerm("typescript");
      const pyIndex = encoder.hashTerm("python");

      const tsIdx = result.indices.indexOf(tsIndex);
      const pyIdx = result.indices.indexOf(pyIndex);

      expect(tsIdx).not.toBe(-1);
      expect(pyIdx).not.toBe(-1);
      expect(result.values[tsIdx]).toBeGreaterThan(result.values[pyIdx]!);
    });

    it("should show TF saturation effect (BM25 k1 parameter)", () => {
      // BM25 TF 有上界，tf=100 不应比 tf=10 高太多
      const manyRepeats = "test ".repeat(100);
      const fewRepeats = "test ".repeat(10);

      const manyResult = encoder.encode(manyRepeats);
      const fewResult = encoder.encode(fewRepeats);

      const testIndex = encoder.hashTerm("test");
      const manyValue =
        manyResult.values[manyResult.indices.indexOf(testIndex)]!;
      const fewValue = fewResult.values[fewResult.indices.indexOf(testIndex)]!;

      // 10x 的词频增加不应导致 10x 的分数增加（BM25 饱和效应）
      expect(manyValue / fewValue).toBeLessThan(3);
      expect(manyValue).toBeGreaterThan(fewValue);
    });

    it("should normalize by document length (BM25 b parameter)", () => {
      const short = encoder.encode("typescript programming");
      const long = encoder.encode(
        "typescript programming " + "extra words ".repeat(50),
      );

      const tsIndex = encoder.hashTerm("typescript");
      const shortValue = short.values[short.indices.indexOf(tsIndex)]!;
      const longValue = long.values[long.indices.indexOf(tsIndex)]!;

      // 长文档中单个词的 TF 分数应低于短文档（长度归一化）
      expect(shortValue).toBeGreaterThan(longValue);
    });
  });

  // ===== Hash 函数质量 =====

  describe("hashTerm() — FNV-1a hash", () => {
    it("should map same term to same index", () => {
      expect(encoder.hashTerm("typescript")).toBe(
        encoder.hashTerm("typescript"),
      );
    });

    it("should produce different indices for different terms", () => {
      const indices = new Set([
        encoder.hashTerm("typescript"),
        encoder.hashTerm("javascript"),
        encoder.hashTerm("python"),
        encoder.hashTerm("rust"),
        encoder.hashTerm("golang"),
      ]);
      // 5 个不同词应映射到至少 4 个不同索引（碰撞概率极低）
      expect(indices.size).toBeGreaterThanOrEqual(4);
    });

    it("should return values within [0, vocabSize)", () => {
      const terms = [
        "hello",
        "world",
        "向量",
        "数据库",
        "embedding",
        "1234",
        "x".repeat(1000),
      ];
      for (const term of terms) {
        const index = encoder.hashTerm(term);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(encoder.vocabSize);
      }
    });
  });

  // ===== 配置参数 =====

  describe("constructor — 自定义配置", () => {
    it("should use custom vocabSize", () => {
      const small = new BM25Encoder({ vocabSize: 100 });
      const result = small.encode("test words");
      for (const idx of result.indices) {
        expect(idx).toBeLessThan(100);
      }
    });

    it("should use custom k1 and b parameters", () => {
      const highK1 = new BM25Encoder({ k1: 3.0 });
      const lowK1 = new BM25Encoder({ k1: 0.5 });

      const text = "test test test other";
      const highResult = highK1.encode(text);
      const lowResult = lowK1.encode(text);

      // 不同 k1 应产生不同的 values
      expect(highResult.values).not.toEqual(lowResult.values);
    });

    it("should use default values when config is empty", () => {
      const defaultEncoder = new BM25Encoder();
      expect(defaultEncoder.vocabSize).toBe(30000);
    });
  });

  // ===== 边界情况 =====

  describe("边界情况", () => {
    it("should handle very long text without error", () => {
      const longText = "word ".repeat(10000);
      const result = encoder.encode(longText);
      expect(result.indices.length).toBeGreaterThan(0);
    });

    it("should handle special characters gracefully", () => {
      const result = encoder.encode("!@#$%^&*()");
      // 纯特殊字符应产生空结果（无有效 token）
      expect(result.indices).toEqual([]);
      expect(result.values).toEqual([]);
    });

    it("should handle numeric text", () => {
      const result = encoder.encode("404 error 500 timeout 200 success");
      const tokens = encoder.tokenize("404 error 500 timeout 200 success");
      expect(tokens).toContain("404");
      expect(tokens).toContain("error");
      expect(tokens).toContain("500");
    });

    it("should handle single character", () => {
      const result = encoder.encode("x");
      expect(result.indices.length).toBe(1);
      expect(result.values.length).toBe(1);
    });
  });
});
