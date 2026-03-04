/**
 * @module logger
 * @description 安全日志模块 — 所有日志输出到 stderr，绝不污染 stdout（MCP stdio 通道）。
 *
 * 铁律 [ADR: 补充十七]：全工程绝对禁止使用 console.log / console.info。
 * 如果 stderr.write 抛出异常（如 EPIPE），先尝试写入备用文件，最后静默吞咽。
 */

import { appendFileSync } from "node:fs";
import { DATA_PATHS } from "./paths.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: number;
  level: LogLevel;
  msg: string;
  data?: unknown;
}

/**
 * D2-4: 当 stderr 不可用时的备用日志文件路径。
 * 环境变量 LOG_FALLBACK_PATH 可覆盖默认值。
 */
const FALLBACK_LOG_PATH =
  process.env.LOG_FALLBACK_PATH ?? DATA_PATHS.fallbackLog;

/**
 * 向 stderr 写入 JSON 格式日志行。
 * - 如果 `process.stderr.write` 返回 `false`（背压）或抛出异常（EPIPE），
 *   尝试写入备用文件，再失败则静默吞咽。
 * - 不依赖任何全局可变状态。
 *
 * @param level - 日志级别
 * @param msg - 日志消息
 * @param data - 可选附加数据
 */
export function safeLog(level: LogLevel, msg: string, data?: unknown): void {
  const entry: LogEntry = {
    ts: Date.now(),
    level,
    msg,
    ...(data !== undefined ? { data } : {}),
  };
  const line = JSON.stringify(entry) + "\n";

  try {
    // stderr.write 返回 false 时只是背压信号，无需特殊处理（非关键路径）
    process.stderr.write(line);
  } catch {
    // D2-4: stderr 不可用时尝试写入备用文件
    try {
      appendFileSync(FALLBACK_LOG_PATH, line);
    } catch {
      // 彻底失败 — 静默吞咽，不向上抛出，不调用任何 console 方法
    }
  }
}

/** 便捷方法 */
export const log = {
  debug: (msg: string, data?: unknown) => safeLog("debug", msg, data),
  info: (msg: string, data?: unknown) => safeLog("info", msg, data),
  warn: (msg: string, data?: unknown) => safeLog("warn", msg, data),
  error: (msg: string, data?: unknown) => safeLog("error", msg, data),
} as const;
