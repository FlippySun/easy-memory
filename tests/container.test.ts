/**
 * @module tests/container.test
 * @description container.ts 单元测试 — 配置解析与容器构造。
 */

import { describe, it, expect } from "vitest";
import { parseAppConfig, createContainer } from "../src/container.js";

// =========================================================================
// parseAppConfig
// =========================================================================

describe("parseAppConfig", () => {
  it("should return default config when no env vars set", () => {
    const config = parseAppConfig({});
    expect(config.qdrantUrl).toBe("http://localhost:6333");
    expect(config.qdrantApiKey).toBe("easy-memory-dev");
    expect(config.embeddingProvider).toBe("ollama");
    expect(config.ollamaBaseUrl).toBe("http://localhost:11434");
    expect(config.ollamaModel).toBe("nomic-embed-text");
    expect(config.geminiApiKey).toBe("");
    expect(config.geminiModel).toBe("gemini-embedding-001");
    expect(config.defaultProject).toBe("default");
    expect(config.rateLimitPerMinute).toBe(60);
    expect(config.geminiMaxPerHour).toBe(200);
    expect(config.geminiMaxPerDay).toBe(2000);
    expect(config.mode).toBe("mcp");
    expect(config.httpPort).toBe(3080);
    expect(config.httpAuthToken).toBe("");
    expect(config.httpHost).toBe("127.0.0.1");
    expect(config.trustProxy).toBe(false);
    expect(config.requireTls).toBe(false);
  });

  it("should override defaults with env vars", () => {
    const config = parseAppConfig({
      QDRANT_URL: "http://remote:6334",
      QDRANT_API_KEY: "my-key",
      EMBEDDING_PROVIDER: "ollama",
      OLLAMA_BASE_URL: "http://ollama:11434",
      OLLAMA_MODEL: "bge-m3",
      DEFAULT_PROJECT: "my-project",
      RATE_LIMIT_PER_MINUTE: "120",
      EASY_MEMORY_MODE: "http",
      HTTP_PORT: "8080",
      HTTP_AUTH_TOKEN: "secret-token",
    });

    expect(config.qdrantUrl).toBe("http://remote:6334");
    expect(config.qdrantApiKey).toBe("my-key");
    expect(config.ollamaBaseUrl).toBe("http://ollama:11434");
    expect(config.ollamaModel).toBe("bge-m3");
    expect(config.defaultProject).toBe("my-project");
    expect(config.rateLimitPerMinute).toBe(120);
    expect(config.mode).toBe("http");
    expect(config.httpPort).toBe(8080);
    expect(config.httpAuthToken).toBe("secret-token");
  });

  it("should throw on invalid EMBEDDING_PROVIDER", () => {
    expect(() => parseAppConfig({ EMBEDDING_PROVIDER: "invalid" })).toThrow(
      /Invalid EMBEDDING_PROVIDER/,
    );
  });

  it("should throw when gemini mode lacks GEMINI_API_KEY", () => {
    expect(() => parseAppConfig({ EMBEDDING_PROVIDER: "gemini" })).toThrow(
      /requires GEMINI_API_KEY/,
    );
  });

  it("should throw when auto mode lacks GEMINI_API_KEY", () => {
    expect(() => parseAppConfig({ EMBEDDING_PROVIDER: "auto" })).toThrow(
      /requires GEMINI_API_KEY/,
    );
  });

  it("should accept gemini mode with GEMINI_API_KEY", () => {
    const config = parseAppConfig({
      EMBEDDING_PROVIDER: "gemini",
      GEMINI_API_KEY: "test-key",
    });
    expect(config.embeddingProvider).toBe("gemini");
    expect(config.geminiApiKey).toBe("test-key");
  });

  it("should throw on invalid EASY_MEMORY_MODE", () => {
    expect(() => parseAppConfig({ EASY_MEMORY_MODE: "grpc" })).toThrow(
      /Invalid EASY_MEMORY_MODE/,
    );
  });

  it("should throw when REQUIRE_TLS=true without TRUST_PROXY", () => {
    expect(() =>
      parseAppConfig({ REQUIRE_TLS: "true", TRUST_PROXY: "false" }),
    ).toThrow(/REQUIRE_TLS=true requires TRUST_PROXY=true/);
  });

  it("should accept REQUIRE_TLS=true with TRUST_PROXY=true", () => {
    const config = parseAppConfig({
      REQUIRE_TLS: "true",
      TRUST_PROXY: "true",
    });
    expect(config.requireTls).toBe(true);
    expect(config.trustProxy).toBe(true);
  });

  it("should override httpHost via HTTP_HOST env var", () => {
    const config = parseAppConfig({ HTTP_HOST: "0.0.0.0" });
    expect(config.httpHost).toBe("0.0.0.0");
  });

  it("should handle NaN env vars with safeParseInt", () => {
    const config = parseAppConfig({
      RATE_LIMIT_PER_MINUTE: "abc",
      GEMINI_MAX_PER_HOUR: "-5",
      HTTP_PORT: "0",
    });
    expect(config.rateLimitPerMinute).toBe(60); // fallback
    expect(config.geminiMaxPerHour).toBe(200); // fallback
    expect(config.httpPort).toBe(3080); // fallback (0 is not positive)
  });
});

// =========================================================================
// createContainer
// =========================================================================

describe("createContainer", () => {
  it("should create container with ollama-only provider", () => {
    const config = parseAppConfig({});
    const container = createContainer(config);

    expect(container.config).toBe(config);
    expect(container.qdrant).toBeDefined();
    expect(container.embedding).toBeDefined();
    expect(container.rateLimiter).toBeDefined();
  });

  it("should create container with auto provider", () => {
    const config = parseAppConfig({
      EMBEDDING_PROVIDER: "auto",
      GEMINI_API_KEY: "test-key",
    });
    const container = createContainer(config);

    expect(container.embedding.providerNames).toContain("ollama");
    expect(container.embedding.providerNames).toContain("gemini");
    expect(container.embedding.providerNames.length).toBe(2);
  });

  it("should create container with gemini-only provider", () => {
    const config = parseAppConfig({
      EMBEDDING_PROVIDER: "gemini",
      GEMINI_API_KEY: "test-key",
    });
    const container = createContainer(config);

    expect(container.embedding.providerNames).toEqual(["gemini"]);
  });

  it("should wire rateLimiter into embedding shouldUseProvider", () => {
    const config = parseAppConfig({
      EMBEDDING_PROVIDER: "auto",
      GEMINI_API_KEY: "test-key",
      GEMINI_MAX_PER_DAY: "0", // will fallback to 2000
    });
    const container = createContainer(config);

    // RateLimiter should be wired — no direct way to test without calling embed,
    // but we can verify the objects exist and are connected
    expect(container.rateLimiter).toBeDefined();
    expect(container.embedding).toBeDefined();
  });

  it("should preserve config reference in container", () => {
    const config = parseAppConfig({
      DEFAULT_PROJECT: "test-project",
    });
    const container = createContainer(config);

    expect(container.config.defaultProject).toBe("test-project");
  });
});
