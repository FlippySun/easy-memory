/**
 * @module rate-limiter
 * @description API 预算护城河 — 滑动窗口限流 + Gemini 预算熔断器。
 *
 * 防御场景:
 * - 前端 Bug / AI 代理无限循环导致的批量调用风暴
 * - Gemini API 账单意外暴涨
 *
 * 策略:
 * - 全局滑动窗口: 每分钟最大调用数（所有 MCP tool 共享）
 * - Gemini 预算: 小时 + 每日上限，超出则熔断（自动降级到本地 Ollama）
 * - 小时窗口恢复: 滑动窗口自然过期后自动恢复
 * - 每日窗口恢复: 仅可通过 resetDaily() 手动重置
 *
 * 铁律: 绝对禁止 console.log (MCP stdio 依赖)
 */

import { log } from "./logger.js";

// =========================================================================
// Types
// =========================================================================

export interface RateLimiterConfig {
  /** 每分钟最大调用数 (default: 60) */
  maxCallsPerMinute?: number;
  /** Gemini 每小时最大调用数，超出触发熔断 (default: 200) */
  geminiMaxCallsPerHour?: number;
  /** Gemini 每日最大调用数，超出触发熔断 (default: 2000) */
  geminiMaxCallsPerDay?: number;
  /** Gemini 连续失败阈值，达到后立即打开熔断器 (default: 3) */
  geminiMaxConsecutiveFailures?: number;
  /** 失败熔断后的冷却期(ms)，冷却后自动放行探测 (default: 60_000) */
  geminiCircuitCooldownMs?: number;
}

export interface RateLimiterStats {
  calls_last_minute: number;
  gemini_calls_last_hour: number;
  gemini_calls_today: number;
  gemini_circuit_open: boolean;
  /** 当前 Gemini 连续失败次数 */
  gemini_consecutive_failures: number;
}

// =========================================================================
// 内部常量
// =========================================================================

const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 3_600_000;

// =========================================================================
// RateLimiter
// =========================================================================

/**
 * API 预算护城河。
 *
 * - checkRate(): 全局限流检查（抛异常 = 被限流）
 * - recordGeminiCall(): 记录 Gemini 调用，自动检查熔断
 * - isGeminiCircuitOpen: 检查 Gemini 是否已被熔断
 * - getStats(): 获取当前统计数据（供 memory_status 展示）
 */
export class RateLimiter {
  private readonly maxCallsPerMinute: number;
  private readonly geminiMaxCallsPerHour: number;
  private readonly geminiMaxCallsPerDay: number;
  private readonly geminiMaxConsecutiveFailures: number;
  private readonly geminiCircuitCooldownMs: number;

  /** 全局调用时间戳（滑动窗口 60s） */
  private callTimestamps: number[] = [];
  /** Gemini 调用时间戳（滑动窗口 1h） */
  private geminiCallTimestamps: number[] = [];
  /** Gemini 当日累计调用数 */
  private geminiDayCount = 0;
  /** 熔断器状态 */
  private _geminiCircuitOpen = false;
  /** Gemini 连续失败计数 — 用于失败驱动熔断 */
  private _consecutiveGeminiFailures = 0;
  /** 失败熔断触发时的时间戳 — 用于冷却期自动恢复 */
  private _failureCircuitOpenedAt = 0;

  constructor(config: RateLimiterConfig = {}) {
    this.maxCallsPerMinute = config.maxCallsPerMinute ?? 60;
    this.geminiMaxCallsPerHour = config.geminiMaxCallsPerHour ?? 200;
    this.geminiMaxCallsPerDay = config.geminiMaxCallsPerDay ?? 2000;
    this.geminiMaxConsecutiveFailures =
      config.geminiMaxConsecutiveFailures ?? 3;
    this.geminiCircuitCooldownMs = config.geminiCircuitCooldownMs ?? 60_000;
  }

  /**
   * 全局限流检查 — 滑动窗口 60 秒。
   * @throws {Error} 超出限制时抛出
   */
  checkRate(): void {
    const now = Date.now();
    this.callTimestamps = this.callTimestamps.filter(
      (t) => now - t < ONE_MINUTE_MS,
    );
    if (this.callTimestamps.length >= this.maxCallsPerMinute) {
      log.warn("Rate limit exceeded", {
        limit: this.maxCallsPerMinute,
        current: this.callTimestamps.length,
      });
      throw new Error(
        `Rate limit exceeded: max ${this.maxCallsPerMinute} calls/minute`,
      );
    }
    this.callTimestamps.push(now);
  }

  /**
   * 记录一次 Gemini API 成功调用。
   * 自动更新熔断器状态 + 重置连续失败计数。
   */
  recordGeminiCall(): void {
    const now = Date.now();
    this.geminiCallTimestamps.push(now);
    this.geminiDayCount++;

    // 成功调用 → 重置连续失败计数
    this._consecutiveGeminiFailures = 0;

    // 清理小时窗口
    this.geminiCallTimestamps = this.geminiCallTimestamps.filter(
      (t) => now - t < ONE_HOUR_MS,
    );

    // 检查小时预算
    if (this.geminiCallTimestamps.length >= this.geminiMaxCallsPerHour) {
      this._geminiCircuitOpen = true;
      log.warn("Gemini circuit breaker OPEN: hourly budget exhausted", {
        hourlyCount: this.geminiCallTimestamps.length,
        hourlyLimit: this.geminiMaxCallsPerHour,
      });
    }

    // 检查日预算
    if (this.geminiDayCount >= this.geminiMaxCallsPerDay) {
      this._geminiCircuitOpen = true;
      log.warn("Gemini circuit breaker OPEN: daily budget exhausted", {
        dailyCount: this.geminiDayCount,
        dailyLimit: this.geminiMaxCallsPerDay,
      });
    }
  }

  /**
   * 记录一次 Gemini API 失败。
   * 连续失败达到阈值时立即打开熔断器，冷却期后自动恢复。
   *
   * 这是解决 "Gemini 持续 429 时每个请求白白等待 ~10s 再 fallback" 问题的核心修复。
   */
  recordGeminiFailure(): void {
    this._consecutiveGeminiFailures++;

    if (
      this._consecutiveGeminiFailures >= this.geminiMaxConsecutiveFailures &&
      !this._geminiCircuitOpen
    ) {
      this._geminiCircuitOpen = true;
      this._failureCircuitOpenedAt = Date.now();
      log.warn(
        "Gemini circuit breaker OPEN: consecutive failures threshold reached",
        {
          consecutiveFailures: this._consecutiveGeminiFailures,
          threshold: this.geminiMaxConsecutiveFailures,
          cooldownMs: this.geminiCircuitCooldownMs,
        },
      );
    }
  }

  /**
   * Gemini 熔断器是否打开。
   *
   * ⚠️ 注意: 此 getter 具有副作用 — 会清理过期时间戳并可能翻转 _geminiCircuitOpen 标志。
   * 这是有意设计: 允许小时窗口自然恢复而无需外部定时器。
   *
   * 自动恢复逻辑:
   * - 小时窗口自然过期后，如果日预算未耗尽，自动关闭熔断器
   * - 日预算耗尽后，必须显式调用 resetDaily() 才能恢复
   */
  get isGeminiCircuitOpen(): boolean {
    if (!this._geminiCircuitOpen) return false;

    // 日预算硬限制 — 不自动恢复
    if (this.geminiDayCount >= this.geminiMaxCallsPerDay) {
      return true;
    }

    // 小时窗口: 清理过期时间戳后重新检查
    const now = Date.now();
    this.geminiCallTimestamps = this.geminiCallTimestamps.filter(
      (t) => now - t < ONE_HOUR_MS,
    );

    // 小时预算仍然超限 — 保持打开
    if (this.geminiCallTimestamps.length >= this.geminiMaxCallsPerHour) {
      return true;
    }

    // 失败熔断冷却检查: 冷却期未过则保持打开
    if (
      this._failureCircuitOpenedAt > 0 &&
      now - this._failureCircuitOpenedAt < this.geminiCircuitCooldownMs
    ) {
      return true;
    }

    // 所有条件均已恢复 — 关闭熔断器
    this._geminiCircuitOpen = false;
    this._consecutiveGeminiFailures = 0;
    this._failureCircuitOpenedAt = 0;
    log.info("Gemini circuit breaker CLOSED: recovered", {
      hourlyCount: this.geminiCallTimestamps.length,
      hourlyLimit: this.geminiMaxCallsPerHour,
    });
    return false;
  }

  /**
   * 重置每日计数器（手动调用或外部定时器触发）。
   *
   * [FIX H-3]: 如果 Gemini 正处于连续失败状态（达到失败阈值），
   * 仅重置日预算但保持熔断器打开，防止所有请求再次涌入故障的 Gemini。
   */
  resetDaily(): void {
    this.geminiDayCount = 0;
    // [FIX H-3]: 连续失败仍超阈值时保持熔断器打开
    // 同时刷新 _failureCircuitOpenedAt，确保 getter 的冷却期检查不会立即恢复
    if (this._consecutiveGeminiFailures >= this.geminiMaxConsecutiveFailures) {
      this._failureCircuitOpenedAt = Date.now();
      log.warn(
        "Gemini daily budget reset, circuit remains open due to ongoing failures",
        {
          consecutiveFailures: this._consecutiveGeminiFailures,
          threshold: this.geminiMaxConsecutiveFailures,
        },
      );
    } else {
      this._geminiCircuitOpen = false;
    }
    log.info("Gemini daily budget reset");
  }

  /**
   * 获取当前统计数据。
   */
  getStats(): RateLimiterStats {
    const now = Date.now();
    return {
      calls_last_minute: this.callTimestamps.filter(
        (t) => now - t < ONE_MINUTE_MS,
      ).length,
      gemini_calls_last_hour: this.geminiCallTimestamps.filter(
        (t) => now - t < ONE_HOUR_MS,
      ).length,
      gemini_calls_today: this.geminiDayCount,
      gemini_circuit_open: this._geminiCircuitOpen,
      gemini_consecutive_failures: this._consecutiveGeminiFailures,
    };
  }
}
