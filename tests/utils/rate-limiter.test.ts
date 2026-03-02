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
});
