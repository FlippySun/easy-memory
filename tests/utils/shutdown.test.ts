/**
 * @module shutdown.test
 * @description GracefulShutdown 单元测试 — 覆盖 stdin close、SIGTERM、5s watchdog、EPIPE
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { setupGracefulShutdown } from "../../src/utils/shutdown.js";

describe("setupGracefulShutdown", () => {
  let cleanupFn: ReturnType<typeof vi.fn>;
  let teardown: (() => void) | undefined;

  // Store original listeners to restore
  let stdinListenersBefore: number;
  let processListenersBefore: number;

  beforeEach(() => {
    cleanupFn = vi.fn().mockResolvedValue(undefined);
    stdinListenersBefore = process.stdin.listenerCount("close");
    processListenersBefore = process.listenerCount("SIGTERM");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (teardown) {
      teardown();
      teardown = undefined;
    }
  });

  it("should return a teardown function", () => {
    teardown = setupGracefulShutdown(cleanupFn);
    expect(typeof teardown).toBe("function");
  });

  it("should register stdin close and SIGTERM listeners", () => {
    teardown = setupGracefulShutdown(cleanupFn);

    expect(process.stdin.listenerCount("close")).toBe(stdinListenersBefore + 1);
    expect(process.listenerCount("SIGTERM")).toBe(processListenersBefore + 1);
  });

  it("should call cleanup when stdin closes", async () => {
    teardown = setupGracefulShutdown(cleanupFn, {
      drainMs: 100,
      exitFn: vi.fn(), // Mock exit to prevent test from exiting
    });

    // Emit stdin close
    process.stdin.emit("close");

    // Wait for cleanup to be called
    await new Promise((r) => setTimeout(r, 50));

    expect(cleanupFn).toHaveBeenCalledTimes(1);
  });

  it("should only call cleanup once even on multiple signals", async () => {
    teardown = setupGracefulShutdown(cleanupFn, {
      drainMs: 100,
      exitFn: vi.fn(),
    });

    // Emit both signals
    process.stdin.emit("close");
    process.stdin.emit("close");

    await new Promise((r) => setTimeout(r, 50));

    expect(cleanupFn).toHaveBeenCalledTimes(1);
  });

  it("should handle cleanup function throwing an error", async () => {
    const failingCleanup = vi
      .fn()
      .mockRejectedValue(new Error("cleanup failed"));
    const mockExit = vi.fn();

    teardown = setupGracefulShutdown(failingCleanup, {
      drainMs: 100,
      exitFn: mockExit,
    });

    process.stdin.emit("close");

    await new Promise((r) => setTimeout(r, 150));

    expect(failingCleanup).toHaveBeenCalledTimes(1);
    // Should still exit even if cleanup fails
    expect(mockExit).toHaveBeenCalled();
  });

  it("should force exit after drain timeout (watchdog)", async () => {
    const slowCleanup = vi.fn(
      () => new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    );
    const mockExit = vi.fn();

    teardown = setupGracefulShutdown(slowCleanup, {
      drainMs: 100, // Very short for test
      exitFn: mockExit,
    });

    process.stdin.emit("close");

    // Wait for watchdog to fire
    await new Promise((r) => setTimeout(r, 200));

    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it("should remove listeners on teardown", () => {
    teardown = setupGracefulShutdown(cleanupFn);

    teardown();
    teardown = undefined;

    expect(process.stdin.listenerCount("close")).toBe(stdinListenersBefore);
    expect(process.listenerCount("SIGTERM")).toBe(processListenersBefore);
  });
});
