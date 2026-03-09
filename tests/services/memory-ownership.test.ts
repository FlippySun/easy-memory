import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApiKeyManager } from "../../src/services/api-key-manager.js";
import { MemoryOwnershipService } from "../../src/services/memory-ownership.js";

describe("MemoryOwnershipService", () => {
  let tmpDir: string;
  let apiKeyManager: ApiKeyManager;
  let qdrant: {
    listAllCollections: ReturnType<typeof vi.fn>;
    scrollPoints: ReturnType<typeof vi.fn>;
    getPointPayload: ReturnType<typeof vi.fn>;
    setPayload: ReturnType<typeof vi.fn>;
  };
  let auditLogPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "em-memory-ownership-test-"));
    apiKeyManager = new ApiKeyManager({
      dbPath: join(tmpDir, "admin.db"),
      keyPrefix: "em_",
    });
    apiKeyManager.open();

    qdrant = {
      listAllCollections: vi
        .fn()
        .mockResolvedValue([
          { name: "em_proj-a", project: "proj-a", points_count: 1 },
        ]),
      scrollPoints: vi.fn(),
      getPointPayload: vi.fn(),
      setPayload: vi.fn().mockResolvedValue(undefined),
    };

    auditLogPath = join(tmpDir, "audit.jsonl");
  });

  afterEach(() => {
    apiKeyManager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("dry_run backfills owner_user_id from existing owner_key_prefix history", async () => {
    const key = apiKeyManager.createKeyForUser(
      { name: "owned-key" },
      101,
      "u1",
    );
    qdrant.scrollPoints.mockResolvedValueOnce({
      points: [
        {
          id: "mem-1",
          payload: {
            owner_key_prefix: key.prefix,
          },
        },
      ],
      next_offset: null,
    });

    const service = new MemoryOwnershipService({
      qdrant: qdrant as never,
      apiKeyManager,
      auditLogPath,
    });

    const result = await service.remediateOwnership({ mode: "dry_run" });

    expect(result.planned_updates).toBe(1);
    expect(result.applied_updates).toBe(0);
    expect(result.prefix_history_matches).toBe(1);
    expect(result.applied_samples[0]?.updates).toEqual({
      owner_user_id: 101,
    });
  });

  it("apply backfills owner_key_prefix and owner_user_id from deterministic MCP audit memory_id evidence", async () => {
    const key = apiKeyManager.createKeyForUser(
      { name: "audit-key" },
      202,
      "u2",
    );
    writeFileSync(
      auditLogPath,
      `${JSON.stringify({
        operation: "memory_save",
        outcome: "success",
        memory_id: "mem-2",
        key_prefix: key.prefix,
      })}\n`,
      "utf-8",
    );

    qdrant.scrollPoints.mockResolvedValueOnce({
      points: [
        {
          id: "mem-2",
          payload: {
            owner_key_prefix: "",
          },
        },
      ],
      next_offset: null,
    });
    qdrant.getPointPayload.mockResolvedValueOnce({ owner_key_prefix: "" });

    const service = new MemoryOwnershipService({
      qdrant: qdrant as never,
      apiKeyManager,
      auditLogPath,
    });

    const result = await service.remediateOwnership({ mode: "apply" });

    expect(result.planned_updates).toBe(1);
    expect(result.applied_updates).toBe(1);
    expect(result.mcp_audit_matches).toBe(1);
    expect(qdrant.setPayload).toHaveBeenCalledWith("proj-a", "mem-2", {
      owner_key_prefix: key.prefix,
      owner_user_id: 202,
    });
  });

  it("keeps ownerless HTTP-era memories unresolved without deterministic evidence", async () => {
    qdrant.scrollPoints.mockResolvedValueOnce({
      points: [
        {
          id: "mem-http-legacy",
          payload: {
            owner_key_prefix: "",
          },
        },
      ],
      next_offset: null,
    });

    const service = new MemoryOwnershipService({
      qdrant: qdrant as never,
      apiKeyManager,
      auditLogPath,
    });

    const result = await service.remediateOwnership({ mode: "dry_run" });

    expect(result.planned_updates).toBe(0);
    expect(result.unresolved).toBe(1);
    expect(result.unresolved_samples[0]?.reason).toBe(
      "no_deterministic_evidence",
    );
  });

  it("ignores audit evidence whose prefix cannot be verified in local history", async () => {
    writeFileSync(
      auditLogPath,
      `${JSON.stringify({
        operation: "memory_save",
        outcome: "success",
        memory_id: "mem-legacy-audit",
        key_prefix: "legacy_hash_prefix",
      })}\n`,
      "utf-8",
    );

    qdrant.scrollPoints.mockResolvedValueOnce({
      points: [
        {
          id: "mem-legacy-audit",
          payload: {
            owner_key_prefix: "",
          },
        },
      ],
      next_offset: null,
    });

    const service = new MemoryOwnershipService({
      qdrant: qdrant as never,
      apiKeyManager,
      auditLogPath,
    });

    const result = await service.remediateOwnership({ mode: "dry_run" });

    expect(result.planned_updates).toBe(0);
    expect(result.unresolved).toBe(1);
    expect(result.unresolved_samples[0]?.reason).toBe(
      "no_deterministic_evidence",
    );
  });

  it("keeps short legacy audit prefixes unresolved even when they share a recorded prefix root", async () => {
    const key = apiKeyManager.createKeyForUser(
      { name: "canonical-key" },
      303,
      "u3",
    );
    const shortPrefix = key.prefix.slice(0, 8);

    writeFileSync(
      auditLogPath,
      `${JSON.stringify({
        operation: "memory_save",
        outcome: "success",
        memory_id: "mem-short-prefix",
        key_prefix: shortPrefix,
      })}\n`,
      "utf-8",
    );

    qdrant.scrollPoints.mockResolvedValueOnce({
      points: [
        {
          id: "mem-short-prefix",
          payload: {
            owner_key_prefix: "",
          },
        },
      ],
      next_offset: null,
    });

    const service = new MemoryOwnershipService({
      qdrant: qdrant as never,
      apiKeyManager,
      auditLogPath,
    });

    const result = await service.remediateOwnership({ mode: "dry_run" });

    expect(result.planned_updates).toBe(0);
    expect(result.unresolved).toBe(1);
    expect(result.unresolved_samples[0]?.reason).toBe(
      "no_deterministic_evidence",
    );
    expect(qdrant.setPayload).not.toHaveBeenCalled();
  });

  it("keeps conflicting audit evidence fail-closed when it disagrees with an existing owner prefix", async () => {
    const keyA = apiKeyManager.createKeyForUser(
      { name: "owner-key-a" },
      401,
      "u4",
    );
    const keyB = apiKeyManager.createKeyForUser(
      { name: "owner-key-b" },
      402,
      "u5",
    );

    writeFileSync(
      auditLogPath,
      `${JSON.stringify({
        operation: "memory_save",
        outcome: "success",
        memory_id: "mem-conflict-prefix",
        key_prefix: keyB.prefix,
      })}\n`,
      "utf-8",
    );

    qdrant.scrollPoints.mockResolvedValueOnce({
      points: [
        {
          id: "mem-conflict-prefix",
          payload: {
            owner_key_prefix: keyA.prefix,
          },
        },
      ],
      next_offset: null,
    });

    const service = new MemoryOwnershipService({
      qdrant: qdrant as never,
      apiKeyManager,
      auditLogPath,
    });

    const result = await service.remediateOwnership({ mode: "dry_run" });

    expect(result.planned_updates).toBe(0);
    expect(result.unresolved).toBe(1);
    expect(result.unresolved_samples[0]?.reason).toBe("conflicting_evidence");
    expect(qdrant.setPayload).not.toHaveBeenCalled();
  });

  it("treats owner_user_id-only records as already resolved when no provenance evidence exists", async () => {
    qdrant.scrollPoints.mockResolvedValueOnce({
      points: [
        {
          id: "mem-user-owned",
          payload: {
            owner_user_id: 202,
            owner_key_prefix: "",
          },
        },
      ],
      next_offset: null,
    });

    const service = new MemoryOwnershipService({
      qdrant: qdrant as never,
      apiKeyManager,
      auditLogPath,
    });

    const result = await service.remediateOwnership({ mode: "dry_run" });

    expect(result.already_resolved).toBe(1);
    expect(result.unresolved).toBe(0);
    expect(result.planned_updates).toBe(0);
  });
});
