/**
 * @module embedding.test
 * @description EmbeddingService (统一 Facade) 单元测试。
 *
 * 使用 Mock Provider 验证:
 * - embed() 向后兼容
 * - embedWithMeta() 返回元数据
 * - 自动降级 (Fallback)
 * - 降级禁用时直接抛出
 * - healthCheck 任一可用即 true
 * - close() 级联传播
 * - modelName / primaryProvider 属性
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EmbeddingService } from "../../src/services/embedding.js";
import type { EmbeddingProvider } from "../../src/services/embedding.js";

// =========================================================================
// Mock Provider Factory
// =========================================================================

function createMockProvider(
  overrides: Partial<EmbeddingProvider> & { name: string; modelName: string },
): EmbeddingProvider {
  return {
    dimension: 1024,
    embed: vi.fn().mockResolvedValue(new Array(1024).fill(0.1)),
    healthCheck: vi.fn().mockResolvedValue(true),
    close: vi.fn(),
    ...overrides,
  };
}

// =========================================================================
// Tests
// =========================================================================

describe("EmbeddingService (Unified Facade)", () => {
  let primaryProvider: EmbeddingProvider;
  let fallbackProvider: EmbeddingProvider;

  beforeEach(() => {
    primaryProvider = createMockProvider({
      name: "gemini",
      modelName: "gemini-embedding-001",
    });
    fallbackProvider = createMockProvider({
      name: "ollama",
      modelName: "bge-m3",
    });
  });

  // ----- Constructor -----

  describe("constructor", () => {
    it("should throw if no providers given", () => {
      expect(() => new EmbeddingService({ providers: [] })).toThrow(
        "At least one embedding provider is required",
      );
    });

    it("should accept single provider", () => {
      const service = new EmbeddingService({ providers: [primaryProvider] });
      expect(service.modelName).toBe("gemini-embedding-001");
      expect(service.primaryProvider).toBe("gemini");
    });

    it("should accept multiple providers", () => {
      const service = new EmbeddingService({
        providers: [primaryProvider, fallbackProvider],
      });
      expect(service.providerNames).toEqual(["gemini", "ollama"]);
    });
  });

  // ----- embed() -----

  describe("embed()", () => {
    it("should return vector from primary provider", async () => {
      const service = new EmbeddingService({ providers: [primaryProvider] });
      const vector = await service.embed("test");
      expect(vector).toHaveLength(1024);
      expect(primaryProvider.embed).toHaveBeenCalledWith("test");
    });

    it("should return number[] (backward compatible)", async () => {
      const service = new EmbeddingService({ providers: [primaryProvider] });
      const result = await service.embed("test");
      expect(Array.isArray(result)).toBe(true);
      expect(typeof result[0]).toBe("number");
    });
  });

  // ----- embedWithMeta() -----

  describe("embedWithMeta()", () => {
    it("should return vector + model + provider metadata", async () => {
      const service = new EmbeddingService({ providers: [primaryProvider] });
      const result = await service.embedWithMeta("test");
      expect(result).toEqual({
        vector: expect.any(Array),
        model: "gemini-embedding-001",
        provider: "gemini",
      });
      expect(result.vector).toHaveLength(1024);
    });

    it("should return fallback provider metadata on fallback", async () => {
      vi.mocked(primaryProvider.embed).mockRejectedValue(
        new Error("Gemini down"),
      );

      const service = new EmbeddingService({
        providers: [primaryProvider, fallbackProvider],
      });
      const result = await service.embedWithMeta("test");
      expect(result.model).toBe("bge-m3");
      expect(result.provider).toBe("ollama");
    });
  });

  // ----- Fallback (自动降级) -----

  describe("fallback", () => {
    it("should fall back to secondary when primary fails", async () => {
      vi.mocked(primaryProvider.embed).mockRejectedValue(
        new Error("primary failed"),
      );

      const service = new EmbeddingService({
        providers: [primaryProvider, fallbackProvider],
      });
      const vector = await service.embed("test");
      expect(vector).toHaveLength(1024);
      expect(primaryProvider.embed).toHaveBeenCalledTimes(1);
      expect(fallbackProvider.embed).toHaveBeenCalledTimes(1);
    });

    it("should throw if all providers fail", async () => {
      vi.mocked(primaryProvider.embed).mockRejectedValue(
        new Error("primary failed"),
      );
      vi.mocked(fallbackProvider.embed).mockRejectedValue(
        new Error("fallback also failed"),
      );

      const service = new EmbeddingService({
        providers: [primaryProvider, fallbackProvider],
      });
      await expect(service.embed("test")).rejects.toThrow(
        "fallback also failed",
      );
    });

    it("should NOT fall back when fallbackEnabled is false", async () => {
      vi.mocked(primaryProvider.embed).mockRejectedValue(
        new Error("primary failed"),
      );

      const service = new EmbeddingService({
        providers: [primaryProvider, fallbackProvider],
        fallbackEnabled: false,
      });
      await expect(service.embed("test")).rejects.toThrow("primary failed");
      expect(fallbackProvider.embed).not.toHaveBeenCalled();
    });

    it("should auto-enable fallback when multiple providers", async () => {
      vi.mocked(primaryProvider.embed).mockRejectedValue(
        new Error("primary failed"),
      );

      const service = new EmbeddingService({
        providers: [primaryProvider, fallbackProvider],
      });
      const vector = await service.embed("test");
      expect(vector).toHaveLength(1024);
    });

    it("should not try fallback with single provider", async () => {
      vi.mocked(primaryProvider.embed).mockRejectedValue(
        new Error("only provider failed"),
      );

      const service = new EmbeddingService({
        providers: [primaryProvider],
      });
      await expect(service.embed("test")).rejects.toThrow(
        "only provider failed",
      );
    });
  });

  // ----- healthCheck -----

  describe("healthCheck()", () => {
    it("should return true if any provider is healthy", async () => {
      vi.mocked(primaryProvider.healthCheck).mockResolvedValue(false);
      vi.mocked(fallbackProvider.healthCheck).mockResolvedValue(true);

      const service = new EmbeddingService({
        providers: [primaryProvider, fallbackProvider],
      });
      expect(await service.healthCheck()).toBe(true);
    });

    it("should return false if all providers are down", async () => {
      vi.mocked(primaryProvider.healthCheck).mockResolvedValue(false);
      vi.mocked(fallbackProvider.healthCheck).mockResolvedValue(false);

      const service = new EmbeddingService({
        providers: [primaryProvider, fallbackProvider],
      });
      expect(await service.healthCheck()).toBe(false);
    });

    it("should return true for single healthy provider", async () => {
      const service = new EmbeddingService({ providers: [primaryProvider] });
      expect(await service.healthCheck()).toBe(true);
    });

    it("should return true even if one provider healthCheck throws (defensive)", async () => {
      // 模拟违反契约的 Provider: healthCheck() 抛异常而非返回 false
      const throwingProvider = createMockProvider({
        name: "buggy",
        modelName: "buggy-model",
      });
      vi.mocked(throwingProvider.healthCheck).mockRejectedValue(
        new Error("unexpected crash"),
      );
      vi.mocked(fallbackProvider.healthCheck).mockResolvedValue(true);

      const service = new EmbeddingService({
        providers: [throwingProvider, fallbackProvider],
      });
      // Promise.all 不应 fast-fail, 其他健康的 Provider 应仍被检测
      expect(await service.healthCheck()).toBe(true);
    });

    it("should return false when all providers throw in healthCheck", async () => {
      const throwingProvider1 = createMockProvider({
        name: "buggy1",
        modelName: "m1",
      });
      const throwingProvider2 = createMockProvider({
        name: "buggy2",
        modelName: "m2",
      });
      vi.mocked(throwingProvider1.healthCheck).mockRejectedValue(
        new Error("crash1"),
      );
      vi.mocked(throwingProvider2.healthCheck).mockRejectedValue(
        new Error("crash2"),
      );

      const service = new EmbeddingService({
        providers: [throwingProvider1, throwingProvider2],
      });
      expect(await service.healthCheck()).toBe(false);
    });
  });

  // ----- close() -----

  describe("close()", () => {
    it("should propagate close to all providers", () => {
      const service = new EmbeddingService({
        providers: [primaryProvider, fallbackProvider],
      });
      service.close();
      expect(primaryProvider.close).toHaveBeenCalledTimes(1);
      expect(fallbackProvider.close).toHaveBeenCalledTimes(1);
    });

    it("should propagate close to single provider", () => {
      const service = new EmbeddingService({ providers: [primaryProvider] });
      service.close();
      expect(primaryProvider.close).toHaveBeenCalledTimes(1);
    });
  });

  // ----- Properties -----

  describe("properties", () => {
    it("modelName should return primary provider model", () => {
      const service = new EmbeddingService({
        providers: [primaryProvider, fallbackProvider],
      });
      expect(service.modelName).toBe("gemini-embedding-001");
    });

    it("primaryProvider should return primary provider name", () => {
      const service = new EmbeddingService({
        providers: [primaryProvider, fallbackProvider],
      });
      expect(service.primaryProvider).toBe("gemini");
    });

    it("providerNames should return all provider names", () => {
      const service = new EmbeddingService({
        providers: [primaryProvider, fallbackProvider],
      });
      expect(service.providerNames).toEqual(["gemini", "ollama"]);
    });
  });

  // ----- shouldUseProvider (Provider 过滤 / 熔断器) -----

  describe("shouldUseProvider (cost guard filter)", () => {
    it("should skip provider when filter returns false", async () => {
      const service = new EmbeddingService({
        providers: [primaryProvider, fallbackProvider],
        shouldUseProvider: (p) => p.name !== "gemini",
      });

      const result = await service.embedWithMeta("test");
      // 应跳过 gemini，直接用 ollama
      expect(primaryProvider.embed).not.toHaveBeenCalled();
      expect(fallbackProvider.embed).toHaveBeenCalledWith("test");
      expect(result.provider).toBe("ollama");
      expect(result.model).toBe("bge-m3");
    });

    it("should throw when all providers are filtered out", async () => {
      const service = new EmbeddingService({
        providers: [primaryProvider, fallbackProvider],
        shouldUseProvider: () => false,
      });

      await expect(service.embedWithMeta("test")).rejects.toThrow(
        "All embedding providers were skipped by cost guard filter",
      );
    });

    it("should use all providers when no filter is set", async () => {
      const service = new EmbeddingService({
        providers: [primaryProvider],
      });
      await service.embed("test");
      expect(primaryProvider.embed).toHaveBeenCalled();
    });

    it("should allow dynamic filter changes", async () => {
      let blockGemini = false;
      const service = new EmbeddingService({
        providers: [primaryProvider, fallbackProvider],
        shouldUseProvider: (p) => !(p.name === "gemini" && blockGemini),
      });

      // 第一次：gemini 可用
      await service.embedWithMeta("test1");
      expect(primaryProvider.embed).toHaveBeenCalledTimes(1);

      // 第二次：模拟熔断器打开
      blockGemini = true;
      const result2 = await service.embedWithMeta("test2");
      expect(result2.provider).toBe("ollama");
    });
  });

  // ----- onSuccess (成功回调 / 成本追踪) -----

  describe("onSuccess (cost tracking callback)", () => {
    it("should call onSuccess after successful embed", async () => {
      const onSuccess = vi.fn();
      const service = new EmbeddingService({
        providers: [primaryProvider],
        onSuccess,
      });

      await service.embedWithMeta("test");
      expect(onSuccess).toHaveBeenCalledTimes(1);
      expect(onSuccess).toHaveBeenCalledWith({
        vector: expect.any(Array),
        model: "gemini-embedding-001",
        provider: "gemini",
      });
    });

    it("should call onSuccess with fallback provider info", async () => {
      vi.mocked(primaryProvider.embed).mockRejectedValue(
        new Error("Gemini down"),
      );
      const onSuccess = vi.fn();
      const service = new EmbeddingService({
        providers: [primaryProvider, fallbackProvider],
        onSuccess,
      });

      await service.embedWithMeta("test");
      expect(onSuccess).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "ollama",
          model: "bge-m3",
        }),
      );
    });

    it("should NOT call onSuccess when all providers fail", async () => {
      vi.mocked(primaryProvider.embed).mockRejectedValue(new Error("fail"));
      const onSuccess = vi.fn();
      const service = new EmbeddingService({
        providers: [primaryProvider],
        onSuccess,
      });

      await expect(service.embedWithMeta("test")).rejects.toThrow();
      expect(onSuccess).not.toHaveBeenCalled();
    });

    it("should not break when onSuccess is not provided", async () => {
      const service = new EmbeddingService({
        providers: [primaryProvider],
      });
      // 不传 onSuccess — 应正常工作不报错
      const result = await service.embedWithMeta("test");
      expect(result.vector).toHaveLength(1024);
    });
  });
});
