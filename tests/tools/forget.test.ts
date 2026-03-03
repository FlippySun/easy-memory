/**
 * @module forget.test
 * @description handleForget 单元测试 — Mock Qdrant 验证软删除 + 审计日志
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleForget } from "../../src/tools/forget.js";
import type { ForgetHandlerDeps } from "../../src/tools/forget.js";

function createMockDeps(): ForgetHandlerDeps {
  return {
    qdrant: {
      setPayload: vi.fn().mockResolvedValue(undefined),
      ensureCollection: vi.fn().mockResolvedValue("em_test"),
      upsert: vi.fn(),
      search: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(true),
      getCollectionInfo: vi.fn().mockResolvedValue(null),
    } as unknown as ForgetHandlerDeps["qdrant"],
    defaultProject: "test-project",
  };
}

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

describe("handleForget", () => {
  let deps: ForgetHandlerDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it("should archive a memory successfully", async () => {
    const result = await handleForget(
      { id: VALID_UUID, action: "archive", reason: "outdated info" },
      deps,
    );

    expect(result.status).toBe("archived");
    expect(result.message).toContain("archived");
    expect(result.message).toContain("outdated info");
    expect(deps.qdrant.setPayload).toHaveBeenCalledWith(
      "test-project",
      VALID_UUID,
      expect.objectContaining({
        lifecycle: "archived",
        forget_reason: "outdated info",
        forget_action: "archive",
      }),
    );
  });

  it("should downgrade delete to archive in Phase 1", async () => {
    const result = await handleForget(
      { id: VALID_UUID, action: "delete", reason: "not needed" },
      deps,
    );

    expect(result.status).toBe("archived");
    const setPayloadCall = (deps.qdrant.setPayload as ReturnType<typeof vi.fn>)
      .mock.calls[0]!;
    expect(setPayloadCall[2].lifecycle).toBe("archived");
    expect(setPayloadCall[2].forget_action).toBe("archive");
  });

  it("should mark as outdated when action is outdated", async () => {
    const result = await handleForget(
      { id: VALID_UUID, action: "outdated", reason: "superseded" },
      deps,
    );

    expect(result.status).toBe("forgotten");
    const setPayloadCall = (deps.qdrant.setPayload as ReturnType<typeof vi.fn>)
      .mock.calls[0]!;
    expect(setPayloadCall[2].lifecycle).toBe("outdated");
  });

  it("should return not_found on Qdrant error", async () => {
    (deps.qdrant.setPayload as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("point not found"),
    );

    const result = await handleForget(
      { id: VALID_UUID, action: "archive", reason: "test" },
      deps,
    );

    expect(result.status).toBe("not_found");
    expect(result.message).toContain("Failed");
  });

  it("should return not_found on Qdrant 'Not Found' (uppercase) error", async () => {
    (deps.qdrant.setPayload as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Not Found"),
    );

    const result = await handleForget(
      { id: VALID_UUID, action: "archive", reason: "test" },
      deps,
    );

    expect(result.status).toBe("not_found");
    expect(result.message).toContain("Not Found");
  });

  it("should return error for invalid UUID", async () => {
    const result = await handleForget(
      { id: "not-a-uuid", action: "archive", reason: "test" },
      deps,
    );
    expect(result.status).toBe("error");
    expect(result.message).toContain("Invalid input");
  });

  it("should return error for empty reason", async () => {
    const result = await handleForget(
      { id: VALID_UUID, action: "archive", reason: "" },
      deps,
    );
    expect(result.status).toBe("error");
    expect(result.message).toContain("Invalid input");
  });

  it("should write audit log to stderr", async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await handleForget(
      { id: VALID_UUID, action: "archive", reason: "audit test" },
      deps,
    );

    const logOutput = stderrSpy.mock.calls
      .map((c) => c[0]?.toString())
      .join("");
    expect(logOutput).toContain("AUDIT:memory_forget");
    expect(logOutput).toContain(VALID_UUID);

    stderrSpy.mockRestore();
  });

  it("should use specified project instead of default", async () => {
    const result = await handleForget(
      {
        id: VALID_UUID,
        action: "archive",
        reason: "cleanup",
        project: "custom-project",
      },
      deps,
    );

    expect(result.status).toBe("archived");
    expect(deps.qdrant.setPayload).toHaveBeenCalledWith(
      "custom-project",
      VALID_UUID,
      expect.objectContaining({
        lifecycle: "archived",
      }),
    );
  });

  it("should fall back to defaultProject when project not specified", async () => {
    await handleForget(
      { id: VALID_UUID, action: "archive", reason: "cleanup" },
      deps,
    );

    expect(deps.qdrant.setPayload).toHaveBeenCalledWith(
      "test-project",
      VALID_UUID,
      expect.objectContaining({
        lifecycle: "archived",
      }),
    );
  });

  // D-AUDIT: 审计日志应为非阻塞异步写入
  it("should not block event loop during audit log write", async () => {
    // 验证 handler 在正常流程中不使用 appendFileSync
    // 通过确认 handler 快速返回且不同步阻塞来间接验证
    const startTime = Date.now();
    const result = await handleForget(
      { id: VALID_UUID, action: "archive", reason: "async audit test" },
      deps,
    );
    const elapsed = Date.now() - startTime;

    expect(result.status).toBe("archived");
    // 异步操作不应阻塞超过 50ms（正常应 < 5ms）
    expect(elapsed).toBeLessThan(50);
  });
});
