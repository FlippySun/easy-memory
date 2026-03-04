/**
 * @module tests/services/analytics.test
 * @description AnalyticsService 单元测试 (SQLite)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AnalyticsService } from "../../src/services/analytics.js";
import type { AuditLogEntry } from "../../src/types/audit-schema.js";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// =========================================================================
// Helpers
// =========================================================================

function getTempPath(ext: string): string {
  return join(tmpdir(), `analytics-test-${randomUUID()}${ext}`);
}

function createTestEntry(
  overrides: Partial<AuditLogEntry> = {},
): AuditLogEntry {
  return {
    event_id: randomUUID(),
    timestamp: new Date().toISOString(),
    key_prefix: "test1234",
    user_agent: "test-agent/1.0",
    client_ip: "127.0.0.1",
    operation: "memory_save",
    project: "test-project",
    outcome: "success",
    outcome_detail: "",
    elapsed_ms: 42,
    http_method: "POST",
    http_path: "/api/save",
    http_status: 200,
    ...overrides,
  };
}

async function cleanupFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // ignore
  }
  // Also cleanup WAL/SHM files
  try {
    await unlink(`${path}-wal`);
  } catch {
    // ignore
  }
  try {
    await unlink(`${path}-shm`);
  } catch {
    // ignore
  }
}

// =========================================================================
// Tests
// =========================================================================

describe("AnalyticsService", () => {
  let dbPath: string;
  let auditLogPath: string;
  let service: AnalyticsService;

  beforeEach(() => {
    dbPath = getTempPath(".db");
    auditLogPath = getTempPath(".jsonl");
    service = new AnalyticsService({
      dbPath,
      auditLogPath,
      autoAggregate: false, // Disable auto-aggregation for tests
      rawRetentionDays: 30,
      hourlyRetentionDays: 7,
      dailyRetentionDays: 90,
    });
    service.open();
  });

  afterEach(async () => {
    service.close();
    await cleanupFile(dbPath);
    await cleanupFile(auditLogPath);
  });

  // ===== Lifecycle =====

  describe("lifecycle", () => {
    it("should open and create tables", () => {
      expect(service.isReady).toBe(true);
    });

    it("should be idempotent on open", () => {
      service.open(); // Second call should be safe
      expect(service.isReady).toBe(true);
    });

    it("should close cleanly", () => {
      service.close();
      expect(service.isReady).toBe(false);
    });

    it("should handle close when not opened", () => {
      const fresh = new AnalyticsService({
        dbPath: getTempPath(".db"),
        autoAggregate: false,
      });
      expect(() => fresh.close()).not.toThrow();
    });
  });

  // ===== Event Ingestion =====

  describe("ingestEvent", () => {
    it("should insert a single event", () => {
      const entry = createTestEntry();
      const result = service.ingestEvent(entry);
      expect(result).toBe(true);

      // Verify via query
      const events = service.queryEvents({
        range: "24h",
        page: 1,
        page_size: 50,
      });
      expect(events.data).toHaveLength(1);
      expect(events.data[0]!.event_id).toBe(entry.event_id);
    });

    it("should handle duplicate event_id gracefully (INSERT OR IGNORE)", () => {
      const entry = createTestEntry();
      service.ingestEvent(entry);
      service.ingestEvent(entry); // Same event_id

      const events = service.queryEvents({
        range: "24h",
        page: 1,
        page_size: 50,
      });
      expect(events.data).toHaveLength(1);
    });

    it("should return false when db is not ready", () => {
      service.close();
      expect(service.ingestEvent(createTestEntry())).toBe(false);
    });

    it("should store all fields correctly", () => {
      const entry = createTestEntry({
        operation: "memory_search",
        query_preview: "test query",
        result_count: 5,
        top_score: 0.92,
        search_hit: true,
        embedding_ms: 15,
        qdrant_ms: 8,
      });
      service.ingestEvent(entry);

      const events = service.queryEvents({
        range: "24h",
        page: 1,
        page_size: 50,
      });
      const stored = events.data[0]!;
      expect(stored.operation).toBe("memory_search");
      expect(stored.query_preview).toBe("test query");
      expect(stored.result_count).toBe(5);
      expect(stored.top_score).toBe(0.92);
      expect(stored.search_hit).toBe(true);
      expect(stored.embedding_ms).toBe(15);
      expect(stored.qdrant_ms).toBe(8);
    });
  });

  describe("ingestBatch", () => {
    it("should insert multiple events atomically", () => {
      const entries = Array.from({ length: 5 }, () => createTestEntry());
      const count = service.ingestBatch(entries);
      expect(count).toBe(5);

      const events = service.queryEvents({
        range: "24h",
        page: 1,
        page_size: 50,
      });
      expect(events.data).toHaveLength(5);
    });

    it("should return 0 for empty batch", () => {
      expect(service.ingestBatch([])).toBe(0);
    });
  });

  // ===== JSONL Import =====

  describe("importFromJsonl", () => {
    it("should import entries from JSONL file", async () => {
      const entries = [
        createTestEntry({ project: "proj-a" }),
        createTestEntry({ project: "proj-b" }),
      ];
      const jsonl = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
      await writeFile(auditLogPath, jsonl);

      const result = await service.importFromJsonl();
      expect(result.imported).toBe(2);
      expect(result.errors).toBe(0);

      const events = service.queryEvents({
        range: "24h",
        page: 1,
        page_size: 50,
      });
      expect(events.data).toHaveLength(2);
    });

    it("should handle missing JSONL file gracefully", async () => {
      const result = await service.importFromJsonl();
      expect(result.imported).toBe(0);
      expect(result.errors).toBe(0);
    });

    it("should skip corrupted lines", async () => {
      const validEntry = createTestEntry();
      const jsonl = [
        JSON.stringify(validEntry),
        "this is not valid json",
        '{"truncated": ',
      ].join("\n");
      await writeFile(auditLogPath, jsonl);

      const result = await service.importFromJsonl();
      expect(result.imported).toBe(1);
      expect(result.errors).toBe(2);
    });

    it("should support incremental import (cursor)", async () => {
      // First import
      const entry1 = createTestEntry({ project: "batch1" });
      await writeFile(auditLogPath, JSON.stringify(entry1) + "\n");
      await service.importFromJsonl();

      // Append more data
      const entry2 = createTestEntry({ project: "batch2" });
      const { appendFile } = await import("node:fs/promises");
      await appendFile(auditLogPath, JSON.stringify(entry2) + "\n");

      // Second import should only get new entries
      const result = await service.importFromJsonl();
      expect(result.imported).toBe(1);

      // Total should be 2
      const events = service.queryEvents({
        range: "24h",
        page: 1,
        page_size: 50,
      });
      expect(events.data).toHaveLength(2);
    });

    it("should handle legacy audit format", async () => {
      const legacy = {
        type: "AUDIT:memory_save",
        id: "legacy-id-123",
        project: "old-project",
        contentHash: "abc123",
        timestamp: new Date().toISOString(),
      };
      await writeFile(auditLogPath, JSON.stringify(legacy) + "\n");

      const result = await service.importFromJsonl();
      expect(result.imported).toBe(1);

      const events = service.queryEvents({
        range: "24h",
        page: 1,
        page_size: 50,
      });
      expect(events.data[0]!.operation).toBe("memory_save");
      expect(events.data[0]!.project).toBe("old-project");
    });
  });

  // ===== Query Events =====

  describe("queryEvents", () => {
    beforeEach(() => {
      // Seed data
      const entries: AuditLogEntry[] = [
        createTestEntry({
          operation: "memory_save",
          project: "proj-a",
          outcome: "success",
          key_prefix: "user1___",
        }),
        createTestEntry({
          operation: "memory_search",
          project: "proj-a",
          outcome: "success",
          key_prefix: "user1___",
          search_hit: true,
          top_score: 0.9,
          result_count: 3,
        }),
        createTestEntry({
          operation: "memory_save",
          project: "proj-b",
          outcome: "error",
          key_prefix: "user2___",
        }),
        createTestEntry({
          operation: "memory_forget",
          project: "proj-a",
          outcome: "success",
          key_prefix: "user1___",
        }),
        createTestEntry({
          operation: "memory_search",
          project: "proj-b",
          outcome: "rate_limited",
          key_prefix: "user2___",
        }),
      ];
      service.ingestBatch(entries);
    });

    it("should return all events within range", () => {
      const result = service.queryEvents({
        range: "24h",
        page: 1,
        page_size: 50,
      });
      expect(result.data).toHaveLength(5);
      expect(result.pagination.total_count).toBe(5);
    });

    it("should filter by operation", () => {
      const result = service.queryEvents({
        operation: "memory_search",
        range: "24h",
        page: 1,
        page_size: 50,
      });
      expect(result.data).toHaveLength(2);
    });

    it("should filter by project", () => {
      const result = service.queryEvents({
        project: "proj-a",
        range: "24h",
        page: 1,
        page_size: 50,
      });
      expect(result.data).toHaveLength(3);
    });

    it("should filter by outcome", () => {
      const result = service.queryEvents({
        outcome: "error",
        range: "24h",
        page: 1,
        page_size: 50,
      });
      expect(result.data).toHaveLength(1);
    });

    it("should filter by key_prefix", () => {
      const result = service.queryEvents({
        key_prefix: "user1___",
        range: "24h",
        page: 1,
        page_size: 50,
      });
      expect(result.data).toHaveLength(3);
    });

    it("should support pagination", () => {
      const page1 = service.queryEvents({
        range: "24h",
        page: 1,
        page_size: 2,
      });
      expect(page1.data).toHaveLength(2);
      expect(page1.pagination.total_count).toBe(5);
      expect(page1.pagination.total_pages).toBe(3);

      const page2 = service.queryEvents({
        range: "24h",
        page: 2,
        page_size: 2,
      });
      expect(page2.data).toHaveLength(2);
    });

    it("should return empty for future time range", () => {
      const futureFrom = new Date(Date.now() + 86_400_000).toISOString();
      const futureTo = new Date(Date.now() + 172_800_000).toISOString();
      const result = service.queryEvents({
        from: futureFrom,
        to: futureTo,
        range: "24h",
        page: 1,
        page_size: 50,
      });
      expect(result.data).toHaveLength(0);
    });

    it("should return empty when db is closed", () => {
      service.close();
      const result = service.queryEvents({
        range: "24h",
        page: 1,
        page_size: 50,
      });
      expect(result.data).toHaveLength(0);
    });
  });

  // ===== Hit Rate =====

  describe("getHitRate", () => {
    it("should compute hit rate correctly", () => {
      // 3 searches: 2 hits, 1 miss
      service.ingestBatch([
        createTestEntry({
          operation: "memory_search",
          search_hit: true,
          top_score: 0.9,
          result_count: 3,
        }),
        createTestEntry({
          operation: "memory_search",
          search_hit: true,
          top_score: 0.85,
          result_count: 2,
        }),
        createTestEntry({
          operation: "memory_search",
          search_hit: false,
          top_score: 0.3,
          result_count: 0,
        }),
      ]);

      const metrics = service.getHitRate({ range: "24h" });
      expect(metrics.total_searches).toBe(3);
      expect(metrics.searches_with_hits).toBe(2);
      expect(metrics.hit_rate).toBeCloseTo(2 / 3, 4);
      expect(metrics.avg_top_score).toBeCloseTo((0.9 + 0.85 + 0.3) / 3, 4);
    });

    it("should return 0 hit_rate when no searches", () => {
      const metrics = service.getHitRate({ range: "24h" });
      expect(metrics.total_searches).toBe(0);
      expect(metrics.hit_rate).toBe(0);
    });

    it("should filter by project", () => {
      service.ingestBatch([
        createTestEntry({
          operation: "memory_search",
          project: "proj-a",
          search_hit: true,
        }),
        createTestEntry({
          operation: "memory_search",
          project: "proj-b",
          search_hit: false,
        }),
      ]);

      const metrics = service.getHitRate({
        range: "24h",
        project: "proj-a",
      });
      expect(metrics.total_searches).toBe(1);
      expect(metrics.hit_rate).toBe(1);
    });
  });

  // ===== User Usage =====

  describe("getUserUsage", () => {
    it("should aggregate by user", () => {
      service.ingestBatch([
        createTestEntry({ key_prefix: "user1___", operation: "memory_save" }),
        createTestEntry({ key_prefix: "user1___", operation: "memory_search" }),
        createTestEntry({ key_prefix: "user1___", operation: "memory_search" }),
        createTestEntry({
          key_prefix: "user2___",
          operation: "memory_save",
          outcome: "error",
        }),
      ]);

      const usage = service.getUserUsage({ range: "24h" });
      expect(usage).toHaveLength(2);

      const user1 = usage.find((u) => u.key_prefix === "user1___")!;
      expect(user1.total_operations).toBe(3);
      expect(user1.save_count).toBe(1);
      expect(user1.search_count).toBe(2);

      const user2 = usage.find((u) => u.key_prefix === "user2___")!;
      expect(user2.total_operations).toBe(1);
      expect(user2.error_count).toBe(1);
    });

    it("should return empty when no data", () => {
      const usage = service.getUserUsage({ range: "24h" });
      expect(usage).toHaveLength(0);
    });
  });

  // ===== Project Usage =====

  describe("getProjectUsage", () => {
    it("should aggregate by project", () => {
      service.ingestBatch([
        createTestEntry({
          project: "proj-a",
          key_prefix: "user1___",
          operation: "memory_save",
        }),
        createTestEntry({
          project: "proj-a",
          key_prefix: "user2___",
          operation: "memory_search",
          search_hit: true,
        }),
        createTestEntry({
          project: "proj-b",
          key_prefix: "user1___",
          operation: "memory_save",
        }),
      ]);

      const usage = service.getProjectUsage({ range: "24h" });
      expect(usage).toHaveLength(2);

      const projA = usage.find((p) => p.project === "proj-a")!;
      expect(projA.total_operations).toBe(2);
      expect(projA.active_users).toBe(2);
      expect(projA.search_hit_rate).toBe(1); // 1 search, 1 hit
    });
  });

  // ===== Error Rate =====

  describe("getErrorRate", () => {
    it("should compute error metrics", () => {
      service.ingestBatch([
        createTestEntry({ outcome: "success" }),
        createTestEntry({ outcome: "success" }),
        createTestEntry({ outcome: "error", operation: "memory_save" }),
        createTestEntry({
          outcome: "rate_limited",
          operation: "memory_search",
        }),
        createTestEntry({ outcome: "rejected", operation: "memory_save" }),
      ]);

      const metrics = service.getErrorRate({ range: "24h" });
      expect(metrics.total_requests).toBe(5);
      expect(metrics.error_count).toBe(1);
      expect(metrics.error_rate).toBeCloseTo(0.2, 4);
      expect(metrics.rate_limited_count).toBe(1);
      expect(metrics.rejected_count).toBe(1);

      // By operation
      expect(metrics.by_operation["memory_save"]).toBeDefined();
      expect(metrics.by_operation["memory_save"]!.errors).toBe(1);
    });

    it("should return 0 error_rate when no events", () => {
      const metrics = service.getErrorRate({ range: "24h" });
      expect(metrics.error_rate).toBe(0);
    });
  });

  // ===== Aggregation =====

  describe("aggregation", () => {
    it("should create hourly rollups", async () => {
      service.ingestBatch([
        createTestEntry({ operation: "memory_save", elapsed_ms: 100 }),
        createTestEntry({ operation: "memory_save", elapsed_ms: 200 }),
        createTestEntry({
          operation: "memory_search",
          elapsed_ms: 50,
          search_hit: true,
          top_score: 0.9,
          result_count: 3,
        }),
      ]);

      await service.runAggregation();

      const rollups = service.queryRollups({
        range: "24h",
        granularity: "hourly",
      });
      expect(rollups.length).toBeGreaterThan(0);

      const saveRollup = rollups.find((r) => r.operation === "memory_save");
      expect(saveRollup).toBeDefined();
      expect(saveRollup!.total_count).toBe(2);
      expect(saveRollup!.avg_elapsed_ms).toBeCloseTo(150, 0);
    });

    it("should handle aggregation when no data", async () => {
      await expect(service.runAggregation()).resolves.not.toThrow();
    });
  });

  // ===== Export =====

  describe("exportEvents", () => {
    it("should export events", () => {
      service.ingestBatch([
        createTestEntry({ project: "export-test" }),
        createTestEntry({ project: "export-test" }),
      ]);

      const exported = service.exportEvents({
        range: "24h",
        page: 1,
        page_size: 100,
      });
      expect(exported).toHaveLength(2);
    });

    it("should limit export size", () => {
      const entries = Array.from({ length: 20 }, () => createTestEntry());
      service.ingestBatch(entries);

      const exported = service.exportEvents({
        range: "24h",
        page: 1,
        page_size: 5,
      });
      expect(exported.length).toBeLessThanOrEqual(5);
    });
  });
});
