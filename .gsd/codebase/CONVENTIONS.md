# Coding Conventions

**Analysis Date:** 2026-03-14

## TypeScript Style

**Strict mode:** Yes — `tsconfig.json` enables `strict: true` plus additional strictness flags:
- `noUnusedLocals: true`
- `noUnusedParameters: true`
- `noFallthroughCasesInSwitch: true`
- `exactOptionalPropertyTypes: true`
- `isolatedModules: true`

**Module style:** ESM (`"type": "module"` in `package.json`, `"module": "NodeNext"` in `tsconfig.json`)

**Target:** ES2022

**Export style:** Named exports (dominant). Barrel re-exports are rare; most modules export specific symbols.

## Naming Conventions

| Element | Convention | Example |
|---------|-----------|---------|
| Files | kebab-case | `memory-routes.ts`, `api-key-manager.ts`, `rate-limiter.ts` |
| Directories | kebab-case | `src/services/`, `src/utils/`, `src/api/` |
| Functions | camelCase | `createContainer()`, `handleSave()`, `basicSanitize()` |
| Classes | PascalCase | `QdrantService`, `EmbeddingService`, `BM25Encoder`, `RateLimiter` |
| Types/Interfaces | PascalCase | `AppConfig`, `MemoryMetadata`, `SaveHandlerDeps`, `EmbeddingResult` |
| Enums (const arrays) | UPPER_SNAKE_CASE | `SOURCE_ENUM`, `FACT_TYPE_ENUM`, `LIFECYCLE_ENUM` |
| Constants | UPPER_SNAKE_CASE | `MAX_CONTENT_LENGTH`, `CURRENT_SCHEMA_VERSION`, `ONE_MINUTE_MS` |
| Zod schemas | PascalCase + `Schema` suffix | `MemoryMetadataSchema`, `MemorySaveInputSchema`, `BrowseQuerySchema` |
| Type from Zod | PascalCase (inferred) | `type MemoryMetadata = z.infer<typeof MemoryMetadataSchema>` |
| Collection names | `em_` prefix + slugified project | `em_my-project` via `collectionName()` |

## Import Organization

Imports are grouped in this order (no enforced linter rule, but consistent across files):

1. **Node.js built-ins** — `import { createHash } from "node:crypto"` (always use `node:` prefix)
2. **External packages** — `import { QdrantClient } from "@qdrant/js-client-rest"`, `import { z } from "zod/v4"`
3. **Internal modules** — `import { log } from "../utils/logger.js"`, `import type { AppContainer } from "../container.js"`

Key patterns:
- **Always use `.js` extension** in import paths (ESM requirement with NodeNext resolution)
- **Use `import type`** for type-only imports: `import type { EmbeddingProvider } from "./embedding-providers.js"`
- **Re-export convenience**: `export type { EmbeddingProvider } from "./embedding-providers.js"` in facade modules like `src/services/embedding.ts`
- **Zod imported as namespace** in tool handlers: `import * as z from "zod/v4"` (for `z.prettifyError`)
- **Zod imported as named** in schema files: `import { z } from "zod/v4"`

## Error Handling

**Pattern 1: Constructor validation — throw on invalid config**

Used in services that require mandatory configuration. Fail-fast at startup.

```typescript
// src/services/qdrant.ts
constructor(config: QdrantServiceConfig) {
  if (!config.apiKey) {
    throw new Error("Qdrant API Key is required [CORE_SCHEMA §3.2]");
  }
  // ...
}
```

**Pattern 2: Zod safeParse — return error response, never throw**

All MCP tool handlers use `safeParse` to validate input and return structured error responses rather than throwing.

```typescript
// src/tools/search.ts
const parsed = MemorySearchInputSchema.safeParse(rawInput);
if (!parsed.success) {
  const issues = z.prettifyError(parsed.error);
  log.warn("Search input validation failed", { issues });
  return {
    memories: [],
    total_found: 0,
    system_note: `Invalid input: ${issues}`,
  };
}
```

**Pattern 3: try/catch with structured logging — never expose stack traces**

HTTP middleware catches exceptions and returns sanitized error responses. Stack traces go to `log.error`, never to the API response.

```typescript
// src/api/middlewares.ts — globalErrorHandler
// Core-layer errors: log full details, return sanitized message
log.error("Unhandled error in request", { error: err.message, stack: err.stack });
return c.json({ error: "Internal server error" }, 500);
```

**Pattern 4: Retry with exponential backoff**

Used for infrastructure connections (Qdrant).

```typescript
// src/services/qdrant.ts — ensureConnected()
for (let attempt = 0; attempt < maxAttempts; attempt++) {
  try {
    await this.client.getCollections();
    return;
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (attempt === maxAttempts - 1) throw error;
    const delay = Math.pow(2, attempt) * 1000;
    await new Promise((r) => setTimeout(r, delay));
  }
}
```

**Pattern 5: TOCTOU race handling — catch "already exists" gracefully**

```typescript
// src/services/qdrant.ts — ensureCollection()
// Concurrent requests may both detect exists=false, second createCollection
// throws "already exists" — treated as success, not error.
```

**Pattern 6: Silent swallowing for non-critical paths**

Audit log writes and fallback file writes use fire-and-forget async with silent catch.

```typescript
// src/tools/save.ts
appendFile(AUDIT_LOG_PATH, JSON.stringify(entry) + "\n").catch(() => {
  // JSONL write failure — stderr log already serves as fallback
});
```

**Pattern 7: Config parse — throw Error, never process.exit()**

`parseAppConfig()` throws on invalid config; the caller (`src/index.ts`) decides whether to exit.

## Logging

**Logger:** `src/utils/logger.ts`

**Hard rule:** **NEVER use `console.log` or `console.info`** — MCP stdio channel must stay clean. All logging goes to stderr.

**Implementation:** JSON-formatted log lines written to `process.stderr.write()`:
```typescript
export function safeLog(level: LogLevel, msg: string, data?: unknown): void {
  const entry: LogEntry = { ts: Date.now(), level, msg, ...(data !== undefined ? { data } : {}) };
  process.stderr.write(JSON.stringify(entry) + "\n");
}
```

**Convenience object:**
```typescript
export const log = {
  debug: (msg: string, data?: unknown) => safeLog("debug", msg, data),
  info:  (msg: string, data?: unknown) => safeLog("info", msg, data),
  warn:  (msg: string, data?: unknown) => safeLog("warn", msg, data),
  error: (msg: string, data?: unknown) => safeLog("error", msg, data),
} as const;
```

**Fallback:** If stderr EPIPE occurs, writes to a fallback log file (`DATA_PATHS.fallbackLog`). If that also fails, silently swallowed.

**Usage pattern:** Every module imports `log` from `../utils/logger.js`:
```typescript
import { log } from "../utils/logger.js";
log.info("Qdrant connection verified");
log.error("Fatal error", { error: err.message, stack: err.stack });
```

## Code Patterns

### Dependency Injection via Handler Deps Interface

Every tool handler accepts a `*HandlerDeps` interface instead of importing singletons directly. This enables clean unit testing with mock objects.

- **Where used:** `src/tools/save.ts`, `src/tools/search.ts`, `src/tools/forget.ts`, `src/tools/status.ts`
- **Example:**
```typescript
// src/tools/save.ts
export interface SaveHandlerDeps {
  qdrant: QdrantService;
  embedding: EmbeddingService;
  bm25?: BM25Encoder;
  defaultProject: string;
}

export async function handleSave(rawInput: unknown, deps: SaveHandlerDeps): Promise<MemorySaveOutput> { ... }
```

### DI Container — Single Source of Service Instances

All core services instantiated once in `createContainer()`. Shell adapters (MCP, HTTP) receive the container and extract what they need. No service instantiated outside the container.

- **Where used:** `src/container.ts`
- **Key types:** `AppConfig`, `AppContainer`
- **Rule:** Shell adapters (`src/mcp/*`, `src/api/*`) must be thin — no business logic, only protocol adaptation.

### Dual-Shell Architecture (MCP + HTTP)

The same core logic is exposed through two independent shells:
- **MCP shell:** `src/mcp/server.ts` — stdio transport for AI agent integration
- **HTTP shell:** `src/api/server.ts` — Hono-based REST API for VPS deployment

Both shells call the same tool handlers (`handleSave`, `handleSearch`, etc.).

### Zod as Single Source of Truth for Schemas

All data schemas defined once in `src/types/schema.ts` (and related schema files). Types are inferred from Zod: `type X = z.infer<typeof XSchema>`. No manual type duplication.

- **Where used:** `src/types/schema.ts`, `src/types/admin-schema.ts`, `src/types/auth-schema.ts`, `src/types/audit-schema.ts`
- **Forward compatibility:** Input schemas use `.passthrough()` to preserve unknown fields.

### Security by Default

- **Timing-safe comparison** for token validation: `timingSafeEqual()` in `src/api/middlewares.ts`
- **Content sanitization** before storage: `basicSanitize()` in `src/utils/sanitize.ts`
- **Prompt injection detection** before save: `INJECTION_PATTERNS` in `src/tools/save.ts`
- **Boundary markers** on search output: `[MEMORY_CONTENT_START]`/`[MEMORY_CONTENT_END]`
- **Hash-based key storage**: API keys stored as SHA-256 hash, only prefix exposed
- **Password hashing**: scrypt (N=16384, r=8, p=1) in `src/services/auth.ts`
- **JWT**: Zero-dependency HMAC-SHA256 implementation in `src/services/auth.ts`
- **Network default**: HTTP binds to `127.0.0.1`, not `0.0.0.0`

### Per-Project Write Serialization

Concurrent writes to the same project are serialized via a Promise-chain mutex pattern to prevent hash deduplication races.

- **Where used:** `src/tools/save.ts` — `withProjectLock()`

### Section Separators

Source files use comment-style section separators for visual organization:
```typescript
// =========================================================================
// Types
// =========================================================================
```

### Module-Level JSDoc Headers

Every source module starts with a JSDoc block containing `@module` and `@description`, followed by key invariants ("铁律"):

```typescript
/**
 * @module qdrant
 * @description Qdrant 向量数据库客户端封装。
 *
 * 铁律 [CORE_SCHEMA §3.1]: upsert 必须 wait:true
 * 铁律 [CORE_SCHEMA §3.2]: 初始化必须带 apiKey
 */
```

### Readonly and Const Pattern

- Service fields marked `private readonly`
- Constant config objects use `as const`: `export const log = { ... } as const`
- Pattern arrays use `ReadonlyArray`: `const SENSITIVE_PATTERNS: ReadonlyArray<{...}>`
- Enum-like arrays use `as const`: `export const SOURCE_ENUM = [...] as const`

---

*Convention analysis: 2026-03-14*
