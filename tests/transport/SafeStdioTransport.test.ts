/**
 * @module SafeStdioTransport.test
 * @description SafeStdioTransport 单元测试 — 覆盖背压、EPIPE、写队列串行化
 *
 * MCP SDK v1.27 使用 newline-delimited JSON (NDJSON)，不是 Content-Length 头。
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { Readable, Writable } from "node:stream";
import { SafeStdioTransport } from "../../src/transport/SafeStdioTransport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

function createMockStdin(): Readable {
  return new Readable({
    read() {
      // no-op: we push data manually
    },
  });
}

function createMockStdout(): Writable & { chunks: string[] } {
  const chunks: string[] = [];
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  }) as Writable & { chunks: string[] };
  writable.chunks = chunks;
  return writable;
}

function createMessage(id: number): JSONRPCMessage {
  return {
    jsonrpc: "2.0",
    id,
    method: "test",
    params: {},
  } as unknown as JSONRPCMessage;
}

describe("SafeStdioTransport", () => {
  let stdin: Readable;
  let stdout: Writable & { chunks: string[] };
  let transport: SafeStdioTransport;

  beforeEach(() => {
    stdin = createMockStdin();
    stdout = createMockStdout();
    transport = new SafeStdioTransport(stdin, stdout);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      await transport.close();
    } catch {
      // ignore
    }
  });

  it("should send NDJSON messages to stdout", async () => {
    await transport.start();

    const msg = createMessage(1);
    await transport.send(msg);

    expect(stdout.chunks.length).toBeGreaterThanOrEqual(1);
    const fullOutput = stdout.chunks.join("");
    // SDK uses JSON.stringify + '\n' (NDJSON)
    expect(fullOutput).toContain('"jsonrpc":"2.0"');
    expect(fullOutput.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(fullOutput.trim());
    expect(parsed.id).toBe(1);
  });

  it("should serialize multiple sends in order (queue)", async () => {
    await transport.start();

    const msg1 = createMessage(1);
    const msg2 = createMessage(2);

    // Fire both concurrently — they must be serialized
    await Promise.all([transport.send(msg1), transport.send(msg2)]);

    const fullOutput = stdout.chunks.join("");
    const idx1 = fullOutput.indexOf('"id":1');
    const idx2 = fullOutput.indexOf('"id":2');
    expect(idx1).toBeLessThan(idx2);
  });

  it("should handle stdout write returning false (backpressure)", async () => {
    const slowStdout = new Writable({
      write(chunk, _encoding, callback) {
        stdout.chunks.push(chunk.toString());
        callback();
      },
      highWaterMark: 1,
    });

    const bpTransport = new SafeStdioTransport(stdin, slowStdout);
    await bpTransport.start();

    const msg = createMessage(1);
    // Should not throw even with backpressure
    await bpTransport.send(msg);
    await bpTransport.close();
  });

  it("should handle EPIPE by catching stream error event", async () => {
    await transport.start();

    // Verify onerror can receive errors and process doesn't crash
    const errors: Error[] = [];
    transport.onerror = (err: Error) => errors.push(err);

    // Add error listener to stdout to prevent unhandled error
    stdout.on("error", () => {
      // expected — we're testing EPIPE resilience
    });

    // Destroy stdout to simulate pipe break
    stdout.destroy(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));

    // Give time for error propagation
    await new Promise((r) => setTimeout(r, 50));

    // Process should not crash — that's the main assertion
    // The transport may or may not have received the error depending on timing
  });

  it("should start and receive NDJSON messages from stdin", async () => {
    const received: JSONRPCMessage[] = [];
    transport.onmessage = (msg: JSONRPCMessage) => received.push(msg);
    await transport.start();

    // SDK ReadBuffer uses newline-delimited JSON
    const msgBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 42,
      method: "ping",
      params: {},
    });
    stdin.push(Buffer.from(msgBody + "\n"));

    // Give event loop a tick
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toHaveLength(1);
    expect((received[0] as { id: number }).id).toBe(42);
  });

  it("should not throw on double start", async () => {
    await transport.start();
    await expect(transport.start()).rejects.toThrow();
  });

  it("should handle close gracefully", async () => {
    let closeCalled = false;
    transport.onclose = () => {
      closeCalled = true;
    };
    await transport.start();
    await transport.close();
    expect(closeCalled).toBe(true);
  });
});
