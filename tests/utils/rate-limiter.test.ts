/**
 * @module rate-limiter.test
 * @description RateLimiter 单元测试 — 滑动窗口限流 + Gemini 预算熔断器
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RateLimiter } from "../../src/utils/rate-limiter.js";

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // Constructor & Defaults
  // =========================================================================

  it("should create with default config", () => {
    const limiter = new RateLimiter();
    const stats = limiter.getStats();
    expect(stats.calls_last_minute).toBe(0);
    expect(stats.gemini_calls_last_hour).toBe(0);
    expect(stats.gemini_calls_today).toBe(0);
    expect(stats.gemini_circuit_open).toBe(false);
  });

  it("should accept custom config", () => {
    const limiter = new RateLimiter({
      maxCallsPerMinute: 10,
      geminiMaxCallsPerHour: 50,
      geminiMaxCallsPerDay: 100,
    });
    // Should not throw on first call
    limiter.checkRate();
    expect(limiter.getStats().calls_last_minute).toBe(1);
  });

  // =========================================================================
  // Global Rate Limit (滑动窗口)
  // =========================================================================

  describe("checkRate (global sliding window)", () => {
    it("should allow calls within limit", () => {
      const limiter = new RateLimiter({ maxCallsPerMinute: 5 });
      for (let i = 0; i < 5; i++) {
        limiter.checkRate();
      }
      expect(limiter.getStats().calls_last_minute).toBe(5);
    });

    it("should throw when limit exceeded", () => {
      const limiter = new RateLimiter({ maxCallsPerMinute: 3 });
      limiter.checkRate();
      limiter.checkRate();
      limiter.checkRate();
      expect(() => limiter.checkRate()).toThrow("Rate limit exceeded");
    });

    it("should recover after sliding window clears", () => {
      const limiter = new RateLimiter({ maxCallsPerMinute: 2 });
      limiter.checkRate();
      limiter.checkRate();
      expect(() => limiter.checkRate()).toThrow("Rate limit exceeded");

      // 前进 61 秒，窗口清空
      vi.advanceTimersByTime(61_000);
      // 应该能再次调用
      limiter.checkRate();
      expect(limiter.getStats().calls_last_minute).toBe(1);
    });

    it("should only count calls within 60s window", () => {
      const limiter = new RateLimiter({ maxCallsPerMinute: 3 });
      limiter.checkRate(); // t=0
      vi.advanceTimersByTime(30_000);
      limiter.checkRate(); // t=30s
      vi.advanceTimersByTime(31_000);
      // t=61s — 第一个调用已过期
      limiter.checkRate(); // 窗口内只有 t=30s 和 t=61s
      expect(limiter.getStats().calls_last_minute).toBe(2);
    });
  });

  // =========================================================================
  // Gemini Budget & Circuit Breaker
  // =========================================================================

  describe("Gemini budget tracking", () => {
    it("should track Gemini calls", () => {
      const limiter = new RateLimiter();
      limiter.recordGeminiCall();
      limiter.recordGeminiCall();
      const stats = limiter.getStats();
      expect(stats.gemini_calls_last_hour).toBe(2);
      expect(stats.gemini_calls_today).toBe(2);
    });

    it("should trip circuit breaker when hourly limit reached", () => {
      const limiter = new RateLimiter({ geminiMaxCallsPerHour: 3 });
      expect(limiter.isGeminiCircuitOpen).toBe(false);

      limiter.recordGeminiCall();
      limiter.recordGeminiCall();
      expect(limiter.isGeminiCircuitOpen).toBe(false);

      limiter.recordGeminiCall(); // 达到限制
      expect(limiter.isGeminiCircuitOpen).toBe(true);
    });

    it("should trip circuit breaker when daily limit reached", () => {
      const limiter = new RateLimiter({ geminiMaxCallsPerDay: 5 });

      for (let i = 0; i < 5; i++) {
        limiter.recordGeminiCall();
      }
      expect(limiter.isGeminiCircuitOpen).toBe(true);
    });

    it("should auto-recover from hourly limit after window clears", () => {
      const limiter = new RateLimiter({
        geminiMaxCallsPerHour: 2,
        geminiMaxCallsPerDay: 100,
      });

      limiter.recordGeminiCall();
      limiter.recordGeminiCall();
      expect(limiter.isGeminiCircuitOpen).toBe(true);

      // 前进 61 分钟，小时窗口清空
      vi.advanceTimersByTime(61 * 60 * 1000);
      expect(limiter.isGeminiCircuitOpen).toBe(false);
    });

    it("should NOT auto-recover from daily limit", () => {
      const limiter = new RateLimiter({
        geminiMaxCallsPerHour: 100,
        geminiMaxCallsPerDay: 3,
      });

      for (let i = 0; i < 3; i++) {
        limiter.recordGeminiCall();
      }
      expect(limiter.isGeminiCircuitOpen).toBe(true);

      // 即使过了 2 小时，日限制仍然生效
      vi.advanceTimersByTime(2 * 60 * 60 * 1000);
      expect(limiter.isGeminiCircuitOpen).toBe(true);
    });

    it("should recover from daily limit after resetDaily()", () => {
      const limiter = new RateLimiter({ geminiMaxCallsPerDay: 2 });

      limiter.recordGeminiCall();
      limiter.recordGeminiCall();
      expect(limiter.isGeminiCircuitOpen).toBe(true);

      limiter.resetDaily();
      expect(limiter.isGeminiCircuitOpen).toBe(false);
      expect(limiter.getStats().gemini_calls_today).toBe(0);
    });
  });

  // =========================================================================
  // getStats
  // =========================================================================

  describe("getStats", () => {
    it("should return accurate stats", () => {
      const limiter = new RateLimiter({ maxCallsPerMinute: 100 });
      limiter.checkRate();
      limiter.checkRate();
      limiter.recordGeminiCall();

      const stats = limiter.getStats();
      expect(stats.calls_last_minute).toBe(2);
      expect(stats.gemini_calls_last_hour).toBe(1);
      expect(stats.gemini_calls_today).toBe(1);
      expect(stats.gemini_circuit_open).toBe(false);
    });

    it("should prune expired entries in stats", () => {
      const limiter = new RateLimiter({ maxCallsPerMinute: 100 });
      limiter.checkRate();
      limiter.recordGeminiCall();

      vi.advanceTimersByTime(61_000); // 过期分钟窗口
      const stats = limiter.getStats();
      expect(stats.calls_last_minute).toBe(0);
      // Gemini 小时窗口仍在
      expect(stats.gemini_calls_last_hour).toBe(1);
    });
  });

  // =========================================================================
  // Failure-Driven Circuit Breaker
  // =========================================================================

  describe("recordGeminiFailure (failure-driven circuit breaker)", () => {
    it("should not open circuit on single failure", () => {
      const limiter = new RateLimiter();
      limiter.recordGeminiFailure();
      expect(limiter.isGeminiCircuitOpen).toBe(false);
    });

    it("should open circuit after consecutive failures reach threshold (default 3)", () => {
      const limiter = new RateLimiter();
      limiter.recordGeminiFailure();
      limiter.recordGeminiFailure();
      expect(limiter.isGeminiCircuitOpen).toBe(false);
      limiter.recordGeminiFailure(); // 3rd consecutive failure
      expect(limiter.isGeminiCircuitOpen).toBe(true);
    });

    it("should accept custom failure threshold", () => {
      const limiter = new RateLimiter({ geminiMaxConsecutiveFailures: 5 });
      for (let i = 0; i < 4; i++) {
        limiter.recordGeminiFailure();
      }
      expect(limiter.isGeminiCircuitOpen).toBe(false);
      limiter.recordGeminiFailure(); // 5th
      expect(limiter.isGeminiCircuitOpen).toBe(true);
    });

    it("should reset consecutive failure count on recordGeminiCall (success)", () => {
      const limiter = new RateLimiter();
      limiter.recordGeminiFailure();
      limiter.recordGeminiFailure();
      // 2 consecutive failures, now a success resets
      limiter.recordGeminiCall();
      limiter.recordGeminiFailure();
      limiter.recordGeminiFailure();
      // Only 2 consecutive again — should NOT open
      expect(limiter.isGeminiCircuitOpen).toBe(false);
    });

    it("should auto-recover from failure circuit after cooldown period", () => {
      const limiter = new RateLimiter({ geminiCircuitCooldownMs: 30_000 });
      limiter.recordGeminiFailure();
      limiter.recordGeminiFailure();
      limiter.recordGeminiFailure();
      expect(limiter.isGeminiCircuitOpen).toBe(true);

      // Advance 29s — still open
      vi.advanceTimersByTime(29_000);
      expect(limiter.isGeminiCircuitOpen).toBe(true);

      // Advance 2 more — cooldown elapsed (total 31s > 30s)
      vi.advanceTimersByTime(2_000);
      expect(limiter.isGeminiCircuitOpen).toBe(false);
    });

    it("should include failure stats in getStats()", () => {
      const limiter = new RateLimiter();
      limiter.recordGeminiFailure();
      limiter.recordGeminiFailure();
      const stats = limiter.getStats();
      expect(stats.gemini_consecutive_failures).toBe(2);
    });

    it("should re-open circuit if failures resume after cooldown recovery", () => {
      const limiter = new RateLimiter({
        geminiCircuitCooldownMs: 10_000,
      });
      // Open circuit
      limiter.recordGeminiFailure();
      limiter.recordGeminiFailure();
      limiter.recordGeminiFailure();
      expect(limiter.isGeminiCircuitOpen).toBe(true);

      // Cooldown recovers
      vi.advanceTimersByTime(11_000);
      expect(limiter.isGeminiCircuitOpen).toBe(false);

      // Failures resume — consecutive count was reset by cooldown recovery
      limiter.recordGeminiFailure();
      limiter.recordGeminiFailure();
      limiter.recordGeminiFailure();
      expect(limiter.isGeminiCircuitOpen).toBe(true);
    });

    it("should keep circuit open if both budget AND failure trigger fire", () => {
      const limiter = new RateLimiter({
        geminiMaxCallsPerHour: 3,
        geminiCircuitCooldownMs: 10_000,
      });
      // Budget-driven open
      limiter.recordGeminiCall();
      limiter.recordGeminiCall();
      limiter.recordGeminiCall();
      expect(limiter.isGeminiCircuitOpen).toBe(true);

      // Failure cooldown elapsed, but budget still exhausted
      vi.advanceTimersByTime(11_000);
      // Budget check should still keep it open (hourly not expired)
      expect(limiter.isGeminiCircuitOpen).toBe(true);
    });
  });

  // =========================================================================
  // Edge Cases
  // =========================================================================

  describe("edge cases", () => {
    it("should handle zero-config gracefully (use defaults)", () => {
      const limiter = new RateLimiter();
      // Default 60 calls/min — should not throw on first call
      limiter.checkRate();
      expect(limiter.getStats().calls_last_minute).toBe(1);
    });

    it("should handle rapid successive calls", () => {
      const limiter = new RateLimiter({ maxCallsPerMinute: 1000 });
      for (let i = 0; i < 100; i++) {
        limiter.checkRate();
      }
      expect(limiter.getStats().calls_last_minute).toBe(100);
    });

    it("should not trip circuit breaker when hourly calls are under limit", () => {
      const limiter = new RateLimiter({ geminiMaxCallsPerHour: 10 });
      for (let i = 0; i < 9; i++) {
        limiter.recordGeminiCall();
      }
      expect(limiter.isGeminiCircuitOpen).toBe(false);
    });
  });

  // =========================================================================
  // [FIX H-3] resetDaily with ongoing failures
  // =========================================================================

  describe("resetDaily with ongoing failures (FIX H-3)", () => {
    it("should keep circuit open if consecutive failures >= threshold after resetDaily", () => {
      const limiter = new RateLimiter({
        geminiMaxConsecutiveFailures: 3,
        geminiMaxCallsPerDay: 10,
      });

      // 触发日预算耗尽
      for (let i = 0; i < 10; i++) {
        limiter.recordGeminiCall();
      }
      expect(limiter.isGeminiCircuitOpen).toBe(true);

      // 同时触发连续失败
      limiter.recordGeminiFailure();
      limiter.recordGeminiFailure();
      limiter.recordGeminiFailure();

      // resetDaily 重置日计数，但连续失败仍达阈值 → 熔断器保持打开
      limiter.resetDaily();
      expect(limiter.getStats().gemini_calls_today).toBe(0);
      expect(limiter.isGeminiCircuitOpen).toBe(true);
    });

    it("should close circuit on resetDaily when no ongoing failures", () => {
      const limiter = new RateLimiter({
        geminiMaxConsecutiveFailures: 3,
        geminiMaxCallsPerDay: 5,
      });

      // 因日预算打开熔断器
      for (let i = 0; i < 5; i++) {
        limiter.recordGeminiCall();
      }
      expect(limiter.isGeminiCircuitOpen).toBe(true);

      // 成功调用重置了失败计数（recordGeminiCall 内含 _consecutiveGeminiFailures = 0）
      // resetDaily 时无连续失败 → 关闭熔断器
      limiter.resetDaily();
      expect(limiter.isGeminiCircuitOpen).toBe(false);
    });

    it("should keep circuit open if failures < threshold but still actively failing", () => {
      const limiter = new RateLimiter({
        geminiMaxConsecutiveFailures: 5,
        geminiMaxCallsPerDay: 3,
      });

      // 日预算耗尽
      for (let i = 0; i < 3; i++) {
        limiter.recordGeminiCall();
      }
      expect(limiter.isGeminiCircuitOpen).toBe(true);

      // 2 次连续失败（< 阈值 5）
      limiter.recordGeminiFailure();
      limiter.recordGeminiFailure();

      // resetDaily → 连续失败 2 < 阈值 5 → 应该关闭熔断器
      limiter.resetDaily();
      expect(limiter.isGeminiCircuitOpen).toBe(false);
    });
  });

  // =========================================================================
  // Per-Key Rate Limit
  // =========================================================================

  describe("checkPerKeyRate", () => {
    it("should allow calls within per-key limit", () => {
      const limiter = new RateLimiter();
      // 5 次调用在每分钟 10 限制内
      for (let i = 0; i < 5; i++) {
        limiter.checkPerKeyRate("key-hash-abc", 10);
      }
      expect(limiter.getStats().per_key_limiter_count).toBe(1);
    });

    it("should throw when per-key limit exceeded", () => {
      const limiter = new RateLimiter();
      const limit = 3;
      for (let i = 0; i < limit; i++) {
        limiter.checkPerKeyRate("key-hash-abc", limit);
      }
      expect(() => limiter.checkPerKeyRate("key-hash-abc", limit)).toThrow(
        /Rate limit exceeded/,
      );
    });

    it("should use global default when perKeyLimit is null", () => {
      const limiter = new RateLimiter({ maxCallsPerMinute: 2 });
      limiter.checkPerKeyRate("key-hash-abc", null);
      limiter.checkPerKeyRate("key-hash-abc", null);
      expect(() => limiter.checkPerKeyRate("key-hash-abc", null)).toThrow(
        /Rate limit exceeded/,
      );
    });

    it("should track separate keys independently", () => {
      const limiter = new RateLimiter();
      const limit = 2;
      // Key A exhausts its limit
      limiter.checkPerKeyRate("key-A", limit);
      limiter.checkPerKeyRate("key-A", limit);
      expect(() => limiter.checkPerKeyRate("key-A", limit)).toThrow();

      // Key B should still work
      limiter.checkPerKeyRate("key-B", limit);
      expect(limiter.getStats().per_key_limiter_count).toBe(2);
    });

    it("should expire old timestamps after 1 minute", () => {
      const limiter = new RateLimiter();
      const limit = 2;
      limiter.checkPerKeyRate("key-hash", limit);
      limiter.checkPerKeyRate("key-hash", limit);
      expect(() => limiter.checkPerKeyRate("key-hash", limit)).toThrow();

      // Advance past 1 minute
      vi.advanceTimersByTime(61_000);

      // Should work again
      limiter.checkPerKeyRate("key-hash", limit);
    });

    it("should report per_key_limiter_count in stats", () => {
      const limiter = new RateLimiter();
      expect(limiter.getStats().per_key_limiter_count).toBe(0);
      limiter.checkPerKeyRate("key-1", 10);
      limiter.checkPerKeyRate("key-2", 10);
      limiter.checkPerKeyRate("key-3", 10);
      expect(limiter.getStats().per_key_limiter_count).toBe(3);
    });
  });
});
