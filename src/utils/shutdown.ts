/**
 * @module shutdown
 * @description 优雅关闭管理器 — 解决 MCP 协议下的"僵尸进程"问题。
 *
 * 监听:
 * - `process.stdin.on('close')` — 客户端 (如 Claude Desktop) 关闭管道
 * - `process.stdin.on('end')` — stdin 流正常结束 [D2-3]
 * - `SIGTERM` — Docker/系统停止信号
 * - `SIGINT` — Ctrl+C 中断 [D2-3]
 *
 * 行为:
 * 1. 触发用户提供的清理回调（关闭 Qdrant 连接、清理定时器等）
 * 2. 关闭所有可关闭服务（Qdrant/Embedding 等） [D2-6]
 * 3. 启动 watchdog 定时器（默认 5s），到时强制退出
 * 4. 所有 EPIPE 错误静默处理
 * 5. uncaughtException 非 EPIPE 时触发关闭而非 re-throw [D2-5]
 *
 * 铁律 [CORE_SCHEMA §5]: SHUTDOWN_DRAIN_MS = 5000
 */

import { log } from "./logger.js";

/** D2-6: 可关闭的服务接口 */
export interface Closeable {
  close: () => void | Promise<void>;
}

export interface ShutdownOptions {
  /** drain 超时毫秒数，默认 5000 */
  drainMs?: number;
  /** 用于测试注入的 exit 函数 */
  exitFn?: (code: number) => void;
  /** D2-6: 需要在关闭时调用 close() 的外部服务 */
  closeables?: Closeable[];
  /**
   * 运行模式 — 影响 stdin 监听行为:
   * - "mcp" (默认): 监听 stdin close/end 事件 + process.stdin.resume()
   * - "http": 跳过 stdin 监听，仅依赖 SIGTERM/SIGINT
   */
  mode?: "mcp" | "http";
  /**
   * HTTP Server 实例 — HTTP 模式下用于优雅关闭 (server.close())。
   * 必须提供 close() 方法，该方法在停止新连接后回调。
   */
  httpServer?: { close: (cb: (err?: Error) => void) => void };
}

/**
 * 注册优雅关闭处理器。
 *
 * @param cleanup - 异步清理函数（关闭连接、清理定时器等）
 * @param options - 可选配置
 * @returns teardown 函数，调用后移除所有已注册的监听器
 */
export function setupGracefulShutdown(
  cleanup: () => Promise<void>,
  options: ShutdownOptions = {},
): () => void {
  const {
    drainMs = 5000,
    exitFn = (code: number) => process.exit(code),
    mode = "mcp",
  } = options;

  let shutdownInProgress = false;

  const initiateShutdown = async (source: string): Promise<void> => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;

    log.info(`Graceful shutdown initiated`, { source, mode });

    // Watchdog: 强制退出兜底
    const watchdog = setTimeout(() => {
      log.warn("Shutdown watchdog fired, forcing exit");
      exitFn(0);
    }, drainMs);

    // 不让 watchdog 阻止进程自然退出
    if (watchdog.unref) {
      watchdog.unref();
    }

    try {
      // HTTP 模式: 先停止接受新连接
      if (mode === "http" && options.httpServer) {
        await new Promise<void>((resolve, reject) => {
          options.httpServer!.close((err) => {
            if (err) {
              log.warn("HTTP server close error", {
                error: err.message,
              });
              reject(err);
            } else {
              log.info("HTTP server stopped accepting new connections");
              resolve();
            }
          });
        }).catch(() => {
          // httpServer.close 失败不阻塞后续清理
        });
      }

      // D2-6: 关闭外部服务
      if (options.closeables && options.closeables.length > 0) {
        await Promise.allSettled(
          options.closeables.map((s) => Promise.resolve(s.close())),
        );
        log.info("External services closed");
      }
      await cleanup();
      log.info("Cleanup completed successfully");
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error("Cleanup error during shutdown", { error: error.message });
    } finally {
      clearTimeout(watchdog);
      exitFn(0);
    }
  };

  // --- 事件监听器 ---

  const onStdinClose = (): void => {
    void initiateShutdown("stdin:close");
  };

  // D2-3: 监听 stdin "end" 事件
  const onStdinEnd = (): void => {
    void initiateShutdown("stdin:end");
  };

  const onSigterm = (): void => {
    void initiateShutdown("SIGTERM");
  };

  // D2-3: 监听 SIGINT
  const onSigint = (): void => {
    void initiateShutdown("SIGINT");
  };

  // MCP 模式: stdin 监听 + resume（防止进程因 stdin 关闭而提前退出）
  // HTTP 模式: 跳过 stdin 监听（HTTP 不依赖 stdin，resume 会阻止进程自然退出）
  if (mode === "mcp") {
    // D2-3: 保持 stdin 流打开
    process.stdin.resume();
    process.stdin.on("close", onStdinClose);
    process.stdin.on("end", onStdinEnd);
  }

  // SIGTERM/SIGINT 在两种模式下都需要
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);

  // D2-5: uncaughtException 处理 — EPIPE 静默，非 EPIPE 触发关闭而非 re-throw
  const onUncaughtException = (err: Error): void => {
    const errno = err as NodeJS.ErrnoException;
    if (errno.code === "EPIPE") {
      log.warn("EPIPE caught in uncaughtException handler, suppressed");
      return;
    }
    // D2-5: 非 EPIPE 错误：记录日志并触发关闭流程，不再 re-throw
    log.error("Uncaught exception, initiating shutdown", {
      error: err.message,
      stack: err.stack,
    });
    void initiateShutdown("uncaughtException");
  };

  process.on("uncaughtException", onUncaughtException);

  // --- Teardown ---
  return () => {
    if (mode === "mcp") {
      process.stdin.off("close", onStdinClose);
      process.stdin.off("end", onStdinEnd);
    }
    process.off("SIGTERM", onSigterm);
    process.off("SIGINT", onSigint);
    process.off("uncaughtException", onUncaughtException);
    shutdownInProgress = false;
  };
}
