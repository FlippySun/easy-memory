/**
 * @module SafeStdioTransport
 * @description 继承 MCP SDK 的 StdioServerTransport，增加：
 * 1. 内存写入队列串行化，防止并发 send 导致消息交错
 * 2. 直接写入 stdout（不经过 super.send()），正确处理背压/drain
 * 3. EPIPE 静默处理，防止 stdout 管道断裂时进程崩溃
 * 4. stdout 错误监听，捕获管道级错误
 *
 * 铁律 [ADR: 补充十七]：不使用 console.log/console.info
 * 铁律 [CORE_SCHEMA §5]: STDIO_MAX_BYTES = 61440 (60KB)
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Readable, Writable } from "node:stream";
import { log } from "../utils/logger.js";

/**
 * 安全的 stdio 传输层。
 * - 使用写队列保证消息顺序
 * - 直接写入 stdout 并处理背压（drain）
 * - EPIPE 错误不崩溃
 * - stdout 错误事件监听
 */
export class SafeStdioTransport extends StdioServerTransport {
  private _writeQueue: Array<{
    message: JSONRPCMessage;
    options?: TransportSendOptions;
    resolve: () => void;
    reject: (err: Error) => void;
  }> = [];
  private _flushing = false;
  // D2-1: 保存 stdout 引用用于直接写入，绕过 super.send()
  private readonly _outStream: Writable;

  constructor(stdin?: Readable, stdout?: Writable) {
    const out = stdout ?? process.stdout;
    super(stdin, out);
    this._outStream = out;

    // D2-2: 监听 stdout 错误事件（EPIPE 等管道级错误）
    this._outStream.on("error", (err: Error) => {
      const errno = err as NodeJS.ErrnoException;
      if (errno.code === "EPIPE") {
        log.warn("SafeStdioTransport: stdout EPIPE detected via error event");
        return;
      }
      log.error("SafeStdioTransport: stdout error", {
        error: err.message,
      });
      this.onerror?.(err);
    });
  }

  /**
   * 覆盖 send 方法：将消息加入写队列，确保串行写入。
   */
  override async send(
    message: JSONRPCMessage,
    options?: TransportSendOptions,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const item: {
        message: JSONRPCMessage;
        options?: TransportSendOptions;
        resolve: () => void;
        reject: (err: Error) => void;
      } = { message, resolve, reject };
      if (options !== undefined) {
        item.options = options;
      }
      this._writeQueue.push(item);
      void this._flushQueue();
    });
  }

  /**
   * 从队列中逐条写出消息。
   * D2-1: 直接写 stdout（NDJSON 格式），不再调用 super.send()。
   * 正确处理 stdout.write() 返回 false 时的 drain 事件（背压）。
   * EPIPE 静默处理，其他错误通过 onerror 回调报告。
   */
  private async _flushQueue(): Promise<void> {
    if (this._flushing) return;
    this._flushing = true;

    try {
      while (this._writeQueue.length > 0) {
        const item = this._writeQueue.shift()!;
        try {
          // D2-1: 直接序列化并写入 stdout，不经过 super.send()
          const line = JSON.stringify(item.message) + "\n";
          const canWrite = this._outStream.write(line);
          if (!canWrite) {
            // 背压：等待 drain 事件再继续
            // S5: 同时监听 error 事件，防止 stdout 销毁后 drain 永不触发导致挂起
            await new Promise<void>((resolve) => {
              const onDrain = (): void => {
                this._outStream.removeListener("error", onError);
                resolve();
              };
              const onError = (): void => {
                this._outStream.removeListener("drain", onDrain);
                resolve(); // resolve 而非 reject，与现有容错模式一致
              };
              this._outStream.once("drain", onDrain);
              this._outStream.once("error", onError);
            });
          }
          item.resolve();
        } catch (err: unknown) {
          const error = err instanceof Error ? err : new Error(String(err));
          const errno = error as NodeJS.ErrnoException;

          if (errno.code === "EPIPE" || error.message.includes("EPIPE")) {
            // EPIPE: 管道已断，静默处理
            log.warn("SafeStdioTransport: EPIPE on send, silently dropped", {
              msgId: (item.message as { id?: unknown }).id,
            });
            item.resolve();
          } else {
            // 非 EPIPE 错误：报告但不崩溃
            log.error("SafeStdioTransport: send error", {
              error: error.message,
              msgId: (item.message as { id?: unknown }).id,
            });
            this.onerror?.(error);
            item.resolve(); // 仍然 resolve，避免调用方永远卡住
          }
        }
      }
    } finally {
      this._flushing = false;
    }
  }
}
