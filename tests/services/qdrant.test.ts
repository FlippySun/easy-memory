/**
 * @module qdrant.test
 * @description QdrantService 单元测试 — Mock QdrantClient 验证参数组装
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @qdrant/js-client-rest before import
const mockClient = {
  collectionExists: vi.fn(),
  createCollection: vi.fn(),
  upsert: vi.fn(),
  search: vi.fn(),
  query: vi.fn(),
  setPayload: vi.fn(),
  getCollection: vi.fn(),
  getCollections: vi.fn(),
};

vi.mock("@qdrant/js-client-rest", () => {
  return {
    QdrantClient: vi.fn().mockImplementation(function (
      this: Record<string, unknown>,
    ) {
      Object.assign(this, mockClient);
    }),
  };
});

import { QdrantService } from "../../src/services/qdrant.js";

describe("QdrantService", () => {
  const config = {
    url: "http://localhost:6333",
    apiKey: "test-key",
    embeddingDimension: 1024,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.collectionExists.mockResolvedValue({ exists: true });
  });

  it("should throw if apiKey is missing", () => {
    expect(
      () => new QdrantService({ url: "http://localhost:6333", apiKey: "" }),
    ).toThrow("API Key is required");
  });

  it("should create instance with valid config", () => {
    const service = new QdrantService(config);
    expect(service).toBeDefined();
  });

  describe("ensureCollection", () => {
    it("should create collection if it does not exist", async () => {
      mockClient.collectionExists.mockResolvedValueOnce({ exists: false });
      mockClient.createCollection.mockResolvedValueOnce(undefined);

      const service = new QdrantService(config);
      const name = await service.ensureCollection("my-project");

      expect(name).toBe("em_my-project");
      expect(mockClient.createCollection).toHaveBeenCalledWith(
        "em_my-project",
        {
          vectors: {
            dense: { size: 1024, distance: "Cosine" },
          },
          sparse_vectors: {
            bm25: {},
          },
        },
      );
    });

    it("should not create collection if it already exists", async () => {
      const service = new QdrantService(config);
      await service.ensureCollection("my-project");

      expect(mockClient.createCollection).not.toHaveBeenCalled();
    });

    it("should cache initialized collections", async () => {
      const service = new QdrantService(config);
      await service.ensureCollection("my-project");
      await service.ensureCollection("my-project");

      // collectionExists should only be called once
      expect(mockClient.collectionExists).toHaveBeenCalledTimes(1);
    });

    it("should propagate errors from Qdrant", async () => {
      mockClient.collectionExists.mockRejectedValueOnce(
        new Error("connection refused"),
      );

      const service = new QdrantService(config);
      await expect(service.ensureCollection("fail")).rejects.toThrow(
        "connection refused",
      );
    });

    it("should handle TOCTOU race: concurrent createCollection 'already exists'", async () => {
      // Simulate: collectionExists returns false, but createCollection
      // throws "already exists" (concurrent request created it first)
      mockClient.collectionExists.mockResolvedValueOnce({ exists: false });
      mockClient.createCollection.mockRejectedValueOnce(
        new Error("Collection em_race-test already exists"),
      );

      const service = new QdrantService(config);
      // Should NOT throw — "already exists" is handled gracefully
      const name = await service.ensureCollection("race-test");
      expect(name).toBe("em_race-test");
    });

    it("should still propagate non-'already exists' createCollection errors", async () => {
      mockClient.collectionExists.mockResolvedValueOnce({ exists: false });
      mockClient.createCollection.mockRejectedValueOnce(
        new Error("insufficient storage"),
      );

      const service = new QdrantService(config);
      await expect(service.ensureCollection("fail")).rejects.toThrow(
        "insufficient storage",
      );
    });

    // [FIX C-2] 旧 Collection 迁移检测
    it("should reject collection with legacy unnamed vectors", async () => {
      mockClient.collectionExists.mockResolvedValueOnce({ exists: true });
      mockClient.getCollection.mockResolvedValueOnce({
        config: {
          params: {
            vectors: { size: 768, distance: "Cosine" },
          },
        },
      });

      const service = new QdrantService(config);
      await expect(service.ensureCollection("legacy")).rejects.toThrow(
        /legacy unnamed vectors.*768d.*Migration required/,
      );
    });

    it("should reject collection with dimension mismatch on named 'dense' vector", async () => {
      mockClient.collectionExists.mockResolvedValueOnce({ exists: true });
      mockClient.getCollection.mockResolvedValueOnce({
        config: {
          params: {
            vectors: { dense: { size: 768, distance: "Cosine" } },
          },
        },
      });

      const service = new QdrantService(config);
      await expect(service.ensureCollection("old-model")).rejects.toThrow(
        /dimension mismatch.*existing=768.*expected=1024/,
      );
    });

    it("should accept collection with matching named 'dense' vector config", async () => {
      mockClient.collectionExists.mockResolvedValueOnce({ exists: true });
      mockClient.getCollection.mockResolvedValueOnce({
        config: {
          params: {
            vectors: { dense: { size: 1024, distance: "Cosine" } },
          },
        },
      });

      const service = new QdrantService(config);
      const name = await service.ensureCollection("compatible");
      expect(name).toBe("em_compatible");
    });

    it("should proceed cautiously when getCollection fails during validation", async () => {
      mockClient.collectionExists.mockResolvedValueOnce({ exists: true });
      mockClient.getCollection.mockRejectedValueOnce(new Error("timeout"));

      const service = new QdrantService(config);
      // Should NOT throw — network issues during validation are non-fatal
      const name = await service.ensureCollection("flaky");
      expect(name).toBe("em_flaky");
    });
  });

  describe("upsert", () => {
    it("should call client.upsert with named vectors and wait:true (iron rule)", async () => {
      mockClient.upsert.mockResolvedValueOnce(undefined);

      const service = new QdrantService(config);
      const points = [
        {
          id: "uuid-1",
          vector: new Array(1024).fill(0.1),
          payload: { content: "test" },
        },
      ];

      await service.upsert("my-project", points);

      expect(mockClient.upsert).toHaveBeenCalledWith("em_my-project", {
        points: [
          {
            id: "uuid-1",
            vector: { dense: expect.any(Array) },
            payload: { content: "test" },
          },
        ],
        wait: true, // ⚠️ 必须为 true
      });
    });

    it("should include bm25 sparse vector when provided", async () => {
      mockClient.upsert.mockResolvedValueOnce(undefined);

      const service = new QdrantService(config);
      const points = [
        {
          id: "uuid-2",
          vector: new Array(1024).fill(0.2),
          sparseVector: { indices: [1, 5, 10], values: [0.8, 0.6, 0.4] },
          payload: { content: "sparse test" },
        },
      ];

      await service.upsert("my-project", points);

      const upsertCall = mockClient.upsert.mock.calls[0];
      const point = upsertCall[1].points[0];
      expect(point.vector).toEqual({
        dense: expect.any(Array),
        bm25: { indices: [1, 5, 10], values: [0.8, 0.6, 0.4] },
      });
    });

    it("should ensure collection before upsert", async () => {
      mockClient.upsert.mockResolvedValueOnce(undefined);

      const service = new QdrantService(config);
      await service.upsert("new-project", [
        { id: "1", vector: [0.1], payload: {} },
      ]);

      expect(mockClient.collectionExists).toHaveBeenCalledWith(
        "em_new-project",
      );
    });
  });

  describe("search (pure dense via query API)", () => {
    it("should search with default parameters using query API", async () => {
      mockClient.query.mockResolvedValueOnce({
        points: [{ id: "uuid-1", score: 0.9, payload: { content: "found" } }],
      });

      const service = new QdrantService(config);
      const results = await service.search(
        "my-project",
        new Array(1024).fill(0),
      );

      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe("uuid-1");
      expect(results[0]!.score).toBe(0.9);
      expect(mockClient.query).toHaveBeenCalledWith(
        "em_my-project",
        expect.objectContaining({
          query: expect.any(Array),
          using: "dense",
          limit: 5,
          score_threshold: 0.55,
          with_payload: true,
        }),
      );
    });

    it("should apply custom limit and threshold", async () => {
      mockClient.query.mockResolvedValueOnce({ points: [] });

      const service = new QdrantService(config);
      await service.search("my-project", [], {
        limit: 10,
        scoreThreshold: 0.8,
      });

      expect(mockClient.query).toHaveBeenCalledWith(
        "em_my-project",
        expect.objectContaining({
          limit: 10,
          score_threshold: 0.8,
          using: "dense",
        }),
      );
    });

    it("should handle empty points array gracefully", async () => {
      mockClient.query.mockResolvedValueOnce({ points: [] });

      const service = new QdrantService(config);
      const results = await service.search("my-project", []);

      expect(results).toEqual([]);
    });
  });

  describe("hybridSearch (Dense + Sparse + RRF)", () => {
    it("should use prefetch + RRF fusion with both vectors", async () => {
      mockClient.query.mockResolvedValueOnce({
        points: [
          { id: "uuid-1", score: 0.85, payload: { content: "hybrid result" } },
        ],
      });

      const service = new QdrantService(config);
      const denseVec = new Array(1024).fill(0.1);
      const sparseVec = { indices: [100, 200, 300], values: [1.5, 0.8, 0.3] };

      const results = await service.hybridSearch(
        "my-project",
        denseVec,
        sparseVec,
        { limit: 5 },
      );

      expect(results).toHaveLength(1);
      expect(results[0]!.score).toBe(0.85);

      const queryCall = mockClient.query.mock.calls[0];
      const params = queryCall[1];
      expect(params.query).toEqual({ fusion: "rrf" });
      expect(params.prefetch).toHaveLength(2);
      expect(params.prefetch[0].using).toBe("dense");
      expect(params.prefetch[1].using).toBe("bm25");
      expect(params.prefetch[1].query).toEqual({
        indices: [100, 200, 300],
        values: [1.5, 0.8, 0.3],
      });
      expect(params.limit).toBe(5);
      expect(params.with_payload).toBe(true);
    });

    it("should fallback to pure dense when sparseVector is undefined", async () => {
      mockClient.query.mockResolvedValueOnce({
        points: [
          { id: "uuid-2", score: 0.7, payload: { content: "dense only" } },
        ],
      });

      const service = new QdrantService(config);
      const results = await service.hybridSearch(
        "my-project",
        new Array(1024).fill(0),
        undefined,
        { limit: 3 },
      );

      expect(results).toHaveLength(1);
      // Should have called query with using: "dense" (pure dense fallback)
      const params = mockClient.query.mock.calls[0][1];
      expect(params.using).toBe("dense");
      expect(params.prefetch).toBeUndefined();
    });

    it("should fallback to pure dense when sparseVector has empty indices", async () => {
      mockClient.query.mockResolvedValueOnce({ points: [] });

      const service = new QdrantService(config);
      await service.hybridSearch("my-project", [0.1], {
        indices: [],
        values: [],
      });

      const params = mockClient.query.mock.calls[0][1];
      expect(params.using).toBe("dense");
    });

    it("should use prefetchLimit = max(limit * 3, 20)", async () => {
      mockClient.query.mockResolvedValueOnce({ points: [] });

      const service = new QdrantService(config);
      await service.hybridSearch(
        "my-project",
        [0.1],
        { indices: [1], values: [1.0] },
        { limit: 3 },
      );

      const params = mockClient.query.mock.calls[0][1];
      // max(3 * 3, 20) = 20
      expect(params.prefetch[0].limit).toBe(20);
      expect(params.prefetch[1].limit).toBe(20);
    });

    it("should pass filter to hybrid query (both prefetch and top-level)", async () => {
      mockClient.query.mockResolvedValueOnce({ points: [] });

      const service = new QdrantService(config);
      const myFilter = {
        must: [{ key: "lifecycle", match: { value: "active" } }],
      };
      await service.hybridSearch(
        "my-project",
        [0.1],
        { indices: [1], values: [1.0] },
        { limit: 5, filter: myFilter },
      );

      const params = mockClient.query.mock.calls[0][1];
      // [FIX H-6] filter 应注入到每个 prefetch 子查询
      expect(params.prefetch[0].filter).toEqual(myFilter);
      expect(params.prefetch[1].filter).toEqual(myFilter);
      // 顶层 filter 也保留
      expect(params.filter).toEqual(myFilter);
    });

    it("should pass scoreThreshold to dense prefetch only (not sparse)", async () => {
      mockClient.query.mockResolvedValueOnce({ points: [] });

      const service = new QdrantService(config);
      await service.hybridSearch(
        "my-project",
        [0.1],
        { indices: [1], values: [1.0] },
        { limit: 5, scoreThreshold: 0.55 },
      );

      const params = mockClient.query.mock.calls[0][1];
      // [FIX C-1] scoreThreshold 应加在 dense prefetch 上
      expect(params.prefetch[0].score_threshold).toBe(0.55);
      // BM25 sparse 不应有 score_threshold（分数语义不同）
      expect(params.prefetch[1].score_threshold).toBeUndefined();
    });

    it("should not add score_threshold to dense prefetch when scoreThreshold is undefined", async () => {
      mockClient.query.mockResolvedValueOnce({ points: [] });

      const service = new QdrantService(config);
      await service.hybridSearch(
        "my-project",
        [0.1],
        { indices: [1], values: [1.0] },
        { limit: 5 },
      );

      const params = mockClient.query.mock.calls[0][1];
      expect(params.prefetch[0].score_threshold).toBeUndefined();
    });
  });

  describe("setPayload", () => {
    it("should call setPayload with wait:true", async () => {
      mockClient.setPayload.mockResolvedValueOnce(undefined);

      const service = new QdrantService(config);
      await service.setPayload("my-project", "uuid-1", {
        lifecycle: "archived",
      });

      expect(mockClient.setPayload).toHaveBeenCalledWith("em_my-project", {
        points: ["uuid-1"],
        payload: { lifecycle: "archived" },
        wait: true,
      });
    });
  });

  describe("healthCheck", () => {
    it("should return true when Qdrant is reachable", async () => {
      mockClient.getCollections.mockResolvedValueOnce({ collections: [] });

      const service = new QdrantService(config);
      expect(await service.healthCheck()).toBe(true);
    });

    it("should return false when Qdrant is unreachable", async () => {
      mockClient.getCollections.mockRejectedValueOnce(
        new Error("ECONNREFUSED"),
      );

      const service = new QdrantService(config);
      expect(await service.healthCheck()).toBe(false);
    });
  });

  describe("getCollectionInfo", () => {
    it("should return collection info", async () => {
      mockClient.getCollection.mockResolvedValueOnce({ points_count: 42 });

      const service = new QdrantService(config);
      const info = await service.getCollectionInfo("my-project");

      expect(info).toEqual({ name: "em_my-project", points_count: 42 });
    });

    it("should return null if collection does not exist", async () => {
      mockClient.getCollection.mockRejectedValueOnce(new Error("not found"));

      const service = new QdrantService(config);
      const info = await service.getCollectionInfo("nonexistent");

      expect(info).toBeNull();
    });
  });
});
