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
    embeddingDimension: 768,
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
          vectors: { size: 768, distance: "Cosine" },
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
  });

  describe("upsert", () => {
    it("should call client.upsert with wait:true (iron rule)", async () => {
      mockClient.upsert.mockResolvedValueOnce(undefined);

      const service = new QdrantService(config);
      const points = [
        {
          id: "uuid-1",
          vector: new Array(768).fill(0.1),
          payload: { content: "test" },
        },
      ];

      await service.upsert("my-project", points);

      expect(mockClient.upsert).toHaveBeenCalledWith("em_my-project", {
        points: [
          {
            id: "uuid-1",
            vector: expect.any(Array),
            payload: { content: "test" },
          },
        ],
        wait: true, // ⚠️ 必须为 true
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

  describe("search", () => {
    it("should search with default parameters", async () => {
      mockClient.search.mockResolvedValueOnce([
        { id: "uuid-1", score: 0.9, payload: { content: "found" } },
      ]);

      const service = new QdrantService(config);
      const results = await service.search(
        "my-project",
        new Array(768).fill(0),
      );

      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe("uuid-1");
      expect(results[0]!.score).toBe(0.9);
      expect(mockClient.search).toHaveBeenCalledWith(
        "em_my-project",
        expect.objectContaining({
          limit: 5,
          score_threshold: 0.65,
          with_payload: true,
        }),
      );
    });

    it("should apply custom limit and threshold", async () => {
      mockClient.search.mockResolvedValueOnce([]);

      const service = new QdrantService(config);
      await service.search("my-project", [], {
        limit: 10,
        scoreThreshold: 0.8,
      });

      expect(mockClient.search).toHaveBeenCalledWith(
        "em_my-project",
        expect.objectContaining({ limit: 10, score_threshold: 0.8 }),
      );
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
