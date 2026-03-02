/**
 * @module logger.test
 * @description safeLog 单元测试 — 覆盖正常流 + 异常流（EPIPE、stderr 不可写）
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { safeLog, log } from "../../src/utils/logger.js";
import type { LogEntry } from "../../src/utils/logger.js";

describe("safeLog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should write JSON log to stderr", () => {
    const writtenChunks: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        writtenChunks.push(chunk.toString());
        return true;
      },
    );

    safeLog("info", "test message");

    expect(writtenChunks).toHaveLength(1);
    const parsed: LogEntry = JSON.parse(writtenChunks[0]!.trim());
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("test message");
    expect(typeof parsed.ts).toBe("number");
    expect(parsed.data).toBeUndefined();
  });

  it("should include data field when provided", () => {
    const writtenChunks: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        writtenChunks.push(chunk.toString());
        return true;
      },
    );

    safeLog("warn", "with data", { key: "value" });

    const parsed: LogEntry = JSON.parse(writtenChunks[0]!.trim());
    expect(parsed.level).toBe("warn");
    expect(parsed.data).toEqual({ key: "value" });
  });

  it("should NOT include data field when data is undefined", () => {
    const writtenChunks: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        writtenChunks.push(chunk.toString());
        return true;
      },
    );

    safeLog("debug", "no data");

    const parsed = JSON.parse(writtenChunks[0]!.trim());
    expect(parsed).not.toHaveProperty("data");
  });

  it("should silently swallow EPIPE errors from stderr.write", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => {
      const err = new Error("write EPIPE") as NodeJS.ErrnoException;
      err.code = "EPIPE";
      throw err;
    });

    // Must not throw
    expect(() => safeLog("error", "epipe test")).not.toThrow();
  });

  it("should silently swallow any exception from stderr.write", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => {
      throw new Error("unexpected");
    });

    expect(() => safeLog("info", "crash test")).not.toThrow();
  });

  it("should handle stderr.write returning false (backpressure) without error", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => false);

    expect(() => safeLog("info", "backpressure")).not.toThrow();
  });

  it("should output valid newline-terminated JSON", () => {
    const writtenChunks: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        writtenChunks.push(chunk.toString());
        return true;
      },
    );

    safeLog("error", "newline check");

    expect(writtenChunks[0]!.endsWith("\n")).toBe(true);
    // Must be parseable
    expect(() => JSON.parse(writtenChunks[0]!)).not.toThrow();
  });
});

describe("log convenience methods", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("log.debug should write with level debug", () => {
    const writtenChunks: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        writtenChunks.push(chunk.toString());
        return true;
      },
    );

    log.debug("debug msg");

    const parsed: LogEntry = JSON.parse(writtenChunks[0]!.trim());
    expect(parsed.level).toBe("debug");
  });

  it("log.info should write with level info", () => {
    const writtenChunks: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        writtenChunks.push(chunk.toString());
        return true;
      },
    );

    log.info("info msg", 42);

    const parsed: LogEntry = JSON.parse(writtenChunks[0]!.trim());
    expect(parsed.level).toBe("info");
    expect(parsed.data).toBe(42);
  });

  it("log.warn should write with level warn", () => {
    const writtenChunks: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        writtenChunks.push(chunk.toString());
        return true;
      },
    );

    log.warn("warn msg");

    const parsed: LogEntry = JSON.parse(writtenChunks[0]!.trim());
    expect(parsed.level).toBe("warn");
  });

  it("log.error should write with level error", () => {
    const writtenChunks: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        writtenChunks.push(chunk.toString());
        return true;
      },
    );

    log.error("error msg");

    const parsed: LogEntry = JSON.parse(writtenChunks[0]!.trim());
    expect(parsed.level).toBe("error");
  });
});

describe("stdout isolation", () => {
  it("safeLog should NEVER write to stdout", () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    safeLog("info", "isolation test");
    log.debug("debug");
    log.info("info");
    log.warn("warn");
    log.error("error");

    expect(stdoutSpy).not.toHaveBeenCalled();
  });
});
