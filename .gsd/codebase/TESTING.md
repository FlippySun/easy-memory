# Testing

**Analysis Date:** 2026-03-14

## Framework

- **Runner:** Vitest 4.x
- **Config (unit):** `vitest.config.ts`
- **Config (e2e):** `vitest.e2e.config.ts`
- **Config (e2e-dual):** `vitest.e2e-dual.config.ts`
- **Assertion Library:** Vitest built-in (`expect`)
- **Mocking:** Vitest built-in (`vi.fn()`, `vi.mock()`, `vi.spyOn()`)
- **Globals:** `globals: true` — `describe`, `it`, `expect`, `vi`, `beforeEach`, `afterEach` are globally available (but explicitly imported in every file)
- **Environment:** Node.js

## Test Structure

```
tests/
├── api/                          # HTTP shell adapter tests
│   ├── admin-auth.test.ts        # Admin authentication middleware
│   ├── auth-rbac-regression.test.ts  # RBAC regression suite
│   ├── memory-routes.test.ts     # Memory browser API routes
│   ├── middlewares.test.ts       # bearerAuth, errorHandler, TLS, etc.
│   └── server.test.ts           # Full HTTP server route integration
├── mcp/                          # MCP shell adapter tests
│   ├── remote-server.test.ts     # Remote proxy MCP server
│   └── server.test.ts           # MCP server tool registration
├── services/                     # Core service unit tests
│   ├── analytics.test.ts
│   ├── api-key-manager.test.ts
│   ├── audit.test.ts
│   ├── auth.test.ts
│   ├── ban-manager.test.ts
│   ├── bm25.test.ts
│   ├── embedding-providers.test.ts
│   ├── embedding.test.ts
│   ├── memory-ownership.test.ts
│   ├── qdrant.test.ts
│   └── runtime-config.test.ts
├── tools/                        # MCP tool handler unit tests
│   ├── forget.test.ts
│   ├── save.test.ts
│   ├── search.test.ts
│   └── status.test.ts
├── transport/                    # Transport layer tests
│   └── SafeStdioTransport.test.ts
├── types/                        # Schema validation tests
│   ├── admin-schema.test.ts
│   ├── audit-schema.test.ts
│   ├── auth-schema.test.ts
│   └── schema.test.ts
├── utils/                        # Utility unit tests
│   ├── hash.test.ts
│   ├── ip.test.ts
│   ├── logger.test.ts
│   ├── paths.test.ts
│   ├── rate-limiter.test.ts
│   ├── sanitize.test.ts
│   └── shutdown.test.ts
├── container.test.ts             # DI container + config parsing
├── e2e.test.ts                   # E2E: full CRUD lifecycle (Qdrant + Ollama)
├── e2e-comprehensive.test.ts     # E2E: comprehensive scenarios
├── e2e-dual-engine.test.ts       # E2E: dual embedding engine (Ollama + Gemini)
├── audit-comprehensive.test.ts   # Cross-cutting audit tests
├── audit-analytics-comprehensive.test.ts  # Audit + analytics integration
└── phase2-auth-audit.test.ts     # Auth + audit Phase 2 integration
```

**Total test code:** ~25,500 lines across 41 test files.

**Mirror structure:** Test files at `tests/{layer}/{module}.test.ts` mirror source at `src/{layer}/{module}.ts` 1:1.

## Test Types

| Type | Location | Run Command | Timeout |
|------|----------|-------------|---------|
| Unit | `tests/**/*.test.ts` (excluding e2e) | `pnpm test` | 10s |
| E2E (basic) | `tests/e2e.test.ts` | `pnpm test:e2e` | 60s |
| E2E (dual engine) | `tests/e2e-dual-engine.test.ts` | `pnpm test:e2e:dual` | 180s |
| Typecheck | All `src/**/*.ts` | `pnpm typecheck` | — |

### Unit Tests
- Isolated from external services (Qdrant, Ollama, Gemini)
- All external dependencies mocked via `vi.fn()` / `vi.mock()`
- Focus on behavior: input → output, error paths, edge cases

### E2E Tests
- Require live Qdrant (localhost:6333) and Ollama (localhost:11434) with `bge-m3` model
- Test full CRUD lifecycle: save → search → forget → search (verify recall fails)
- Include graceful dependency detection — skip (not fail) if services are unavailable:
```typescript
async function checkDependencies(): Promise<boolean> {
  const [qdrantOK, ollamaOK] = await Promise.all([
    fetch(`${QDRANT_URL}/healthz`).then((r) => r.ok).catch(() => false),
    fetch(`${OLLAMA_URL}/api/tags`).then((r) => r.ok).catch(() => false),
  ]);
  return qdrantOK && ollamaOK;
}
```

## Mocking Patterns

### Pattern 1: Mock Factory Functions (Dominant)

Most tests define a `createMockDeps()` or `createMock*()` factory that returns a typed mock object with all methods stubbed via `vi.fn()`. This is the primary mocking pattern.

```typescript
// tests/tools/save.test.ts
function createMockDeps(): SaveHandlerDeps {
  return {
    qdrant: {
      upsert: vi.fn().mockResolvedValue(undefined),
      ensureCollection: vi.fn().mockResolvedValue("em_test"),
      search: vi.fn().mockResolvedValue([]),
      hybridSearch: vi.fn().mockResolvedValue([]),
      setPayload: vi.fn().mockResolvedValue(undefined),
      healthCheck: vi.fn().mockResolvedValue(true),
      getCollectionInfo: vi.fn().mockResolvedValue(null),
    } as unknown as SaveHandlerDeps["qdrant"],
    embedding: {
      embed: vi.fn().mockResolvedValue(new Array(1024).fill(0.1)),
      embedWithMeta: vi.fn().mockResolvedValue({
        vector: new Array(1024).fill(0.1),
        model: "bge-m3",
        provider: "ollama",
      }),
      healthCheck: vi.fn().mockResolvedValue(true),
      close: vi.fn(),
    } as unknown as SaveHandlerDeps["embedding"],
    bm25: {
      encode: vi.fn().mockReturnValue({
        indices: [100, 200, 300],
        values: [1.5, 0.8, 0.3],
      }),
    } as unknown as SaveHandlerDeps["bm25"],
    defaultProject: "test-project",
  };
}
```

### Pattern 2: Module-Level `vi.mock()` (External SDKs)

Used when an entire external module must be replaced (e.g., Qdrant client SDK).

```typescript
// tests/services/qdrant.test.ts
const mockClient = {
  collectionExists: vi.fn(),
  createCollection: vi.fn(),
  upsert: vi.fn(),
  search: vi.fn(),
  query: vi.fn(),
  setPayload: vi.fn(),
  getCollection: vi.fn(),
  getCollections: vi.fn(),
};

vi.mock("@qdrant/js-client-rest", () => {
  return {
    QdrantClient: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
      Object.assign(this, mockClient);
    }),
  };
});
```

### Pattern 3: `vi.spyOn()` for Process/System Calls

Used to intercept `process.stderr.write`, `process.exit`, etc.

```typescript
// tests/utils/logger.test.ts
vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
  writtenChunks.push(chunk.toString());
  return true;
});
```

### Pattern 4: Hono Test Client (HTTP Route Tests)

HTTP middleware and API tests use Hono's built-in `app.request()` for in-memory HTTP testing — no actual server startup needed.

```typescript
// tests/api/middlewares.test.ts
const app = new Hono();
app.use("*", bearerAuth({ masterToken: "secret", ... }));
app.get("/test", (c) => c.json({ ok: true }));

const res = await app.request("/test");
expect(res.status).toBe(200);
```

### Pattern 5: Container Mock Factory (Integration-Style)

Full `AppContainer` mock factories used for server-level tests.

```typescript
// tests/api/server.test.ts
function createMockContainer(overrides: Partial<AppConfig> = {}): AppContainer {
  const config: AppConfig = { /* all defaults */ ...overrides };
  return {
    config,
    qdrant: { healthCheck: vi.fn().mockResolvedValue(true), ... } as any,
    embedding: { embed: vi.fn().mockResolvedValue(new Array(1024).fill(0)), ... } as any,
    rateLimiter: { checkRate: vi.fn(), ... } as any,
    bm25: { encode: vi.fn().mockReturnValue({ indices: [100], values: [1.0] }) } as any,
    audit: { record: vi.fn(), ... } as any,
    // ... all container services mocked
  };
}
```

### Type Casting Note

Mocks frequently use `as unknown as T` or `as any` cast to satisfy TypeScript when only a subset of interface methods are mocked:
```typescript
} as unknown as SaveHandlerDeps["qdrant"],
```

## Test Naming Convention

- **File names:** Mirror source module: `src/services/qdrant.ts` → `tests/services/qdrant.test.ts`
- **Top-level `describe`**: Class or function name: `describe("QdrantService", ...)`, `describe("handleSave", ...)`
- **Nested `describe`**: Method or scenario group: `describe("ensureCollection", ...)`
- **`it` blocks**: Start with `"should"` + behavior description:
  - `it("should save valid content successfully", ...)`
  - `it("should reject fully redacted content", ...)`
  - `it("should throw if apiKey is missing", ...)`
  - `it("should handle TOCTOU race: concurrent createCollection 'already exists'", ...)`

## Test File Structure

Every test file follows this pattern:
1. **Module-level JSDoc** — `@module` + `@description`
2. **Imports** — vitest globals + source module under test
3. **Mock setup** (if needed) — mock factories or `vi.mock()`
4. **`describe` block** — groups by unit under test
5. **`beforeEach`** — reset mocks/state (commonly `vi.clearAllMocks()` or factory recreation)
6. **`it` blocks** — individual test cases

```typescript
/**
 * @module sanitize.test
 * @description basicSanitize 单元测试 — 覆盖 AWS Key/JWT/PEM/DB 连接串脱敏
 */

import { describe, it, expect } from "vitest";
import { basicSanitize, isFullyRedacted } from "../../src/utils/sanitize.js";

describe("basicSanitize", () => {
  it("should not modify safe text", () => { ... });
  it("should redact AWS Access Key IDs", () => { ... });
  // ...
});
```

## Assertion Patterns

**Common matchers used across the codebase:**

```typescript
// Equality
expect(result.status).toBe("saved");
expect(result.tags).toEqual(["test"]);

// Truthiness
expect(result.system_note).toBeTruthy();
expect(service).toBeDefined();

// Regex matching
expect(result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);

// Contains
expect(result.message).toContain("saved");
expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");

// Mock call verification
expect(deps.qdrant.upsert).toHaveBeenCalledTimes(1);
expect(deps.qdrant.upsert).not.toHaveBeenCalled();
expect(deps.embedding.embedWithMeta).toHaveBeenCalledWith("test query");

// Error assertions
expect(() => new QdrantService({ ... })).toThrow("API Key is required");
await expect(service.ensureCollection("fail")).rejects.toThrow("connection refused");
expect(() => safeLog("info", "crash test")).not.toThrow();

// Object shape
expect(deps.qdrant.hybridSearch).toHaveBeenCalledWith(
  "test-project",
  expect.any(Array),
  expect.any(Object),
  expect.objectContaining({ limit: 10, scoreThreshold: 0.8 }),
);

// Property existence
expect(parsed).not.toHaveProperty("data");

// HTTP status code assertions (Hono tests)
expect(res.status).toBe(401);
const body = await res.json();
expect(body.error).toContain("Missing Authorization");
```

## Coverage

- **Tool:** v8 (built into Vitest)
- **Config:** `vitest.config.ts` → `coverage.provider: "v8"`, `coverage.include: ["src/**/*.ts"]`
- **Enforcement:** No minimum threshold enforced
- **Run:** `pnpm test -- --coverage`

## Running Tests

```bash
# Unit tests (excludes e2e)
pnpm test

# Unit tests in watch mode
pnpm test:watch

# E2E tests (requires local Qdrant + Ollama)
pnpm test:e2e

# E2E dual-engine tests (requires Qdrant + Ollama + Gemini)
pnpm test:e2e:dual

# Typecheck only (no test execution)
pnpm typecheck

# Quick local verification (typecheck + unit tests)
pnpm verify:local

# Run with coverage
pnpm test -- --coverage
```

## Test Configuration Details

### Unit test config (`vitest.config.ts`)
```typescript
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/e2e/**", "tests/e2e.test.ts", "tests/e2e-*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
    },
    testTimeout: 10_000,
  },
});
```

### E2E config (`vitest.e2e.config.ts`)
```typescript
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/e2e.test.ts"],
    testTimeout: 60_000,
  },
});
```

### E2E dual-engine config (`vitest.e2e-dual.config.ts`)
```typescript
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/e2e-dual-engine.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
```

## Key Testing Patterns

### State Cleanup Between Tests

Tool handlers with internal caches expose cleanup functions for tests:
```typescript
// src/tools/save.ts exports clearHashCache()
// tests/tools/save.test.ts
beforeEach(() => {
  deps = createMockDeps();
  clearHashCache();  // Reset in-memory dedup hash set
});
```

### Graceful E2E Skip

E2E tests detect whether external services are available and skip gracefully if not:
```typescript
it.skipIf(!servicesAvailable)("should save a memory", async () => { ... });
```

### No Test Fixtures Directory

There is no shared fixtures directory. Test data is defined inline within each test file or in mock factory functions.

---

*Testing analysis: 2026-03-14*
