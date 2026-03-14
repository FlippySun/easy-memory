# Architecture

**Analysis Date:** 2026-03-14

## Pattern

- **Style:** Hexagonal (Ports & Adapters) / Dual-Shell over Shared Core
- **Key principle:** Two independent shell adapters (MCP stdio + HTTP REST) sit over identical core logic. All business logic lives in `src/tools/` and `src/services/`; shells are pure protocol adapters with zero domain knowledge.

## System Overview

easy-memory is a persistent semantic memory service for AI agents. It stores, searches, and manages "memories" (text snippets with metadata) backed by Qdrant vector database with hybrid retrieval (dense embeddings + BM25 sparse vectors fused via RRF).

The system operates in three modes:
1. **MCP stdio** (default): Local process communicating with AI clients (Claude, Cursor) via MCP JSON-RPC over stdin/stdout.
2. **HTTP REST**: Hono-based HTTP server for VPS deployment, supporting Bearer token auth, managed API keys, JWT user auth, and an admin dashboard.
3. **Remote proxy**: Lightweight local stdio MCP server that forwards all calls to a remote HTTP easy-memory instance.

## Layers

### Shell Layer — Protocol Adapters

Thin adapters that translate protocol-specific requests into core tool handler calls. **No business logic allowed.**

- **MCP Shell:** `src/mcp/server.ts`
  - Instantiates `McpServer` from `@modelcontextprotocol/sdk`
  - Registers 8 tool handlers (memory_save/search/forget/status × 2 aliases each)
  - Uses `SafeStdioTransport` for EPIPE-safe stdout communication
  - Hijacks `console.*` to redirect all output to stderr (protect stdio purity)
  - Shell-level rate limiting returns structured MCP error responses
  - Audit recording via `recordAudit()` helper

- **HTTP Shell:** `src/api/server.ts`
  - Hono web framework with layered middleware stack
  - Route groups: `/api/save|search|forget|status`, `/api/admin/*`, `/api/auth/*`, `/api/user/keys`, `/api/memories/*`, `/mcp` (Streamable HTTP MCP)
  - Middleware chain: error handler → request logger → TLS enforcement → IP ban check → auth routes → MCP endpoint → admin routes → memory routes → bearer auth → content-type validation → rate limiting → audit recording
  - Creates per-request stateless MCP server for `/mcp` Streamable HTTP endpoint

- **Remote Proxy Shell:** `src/mcp/remote-server.ts`
  - Stdio MCP server that HTTP-forwards save/search/forget/status to remote API
  - Activated when `EASY_MEMORY_TOKEN` env var is set
  - 30s request timeout with AbortController

### Core Tool Layer — Business Logic Orchestrators

Pure functions receiving typed dependencies. Each tool handler implements a complete request pipeline.

- **Location:** `src/tools/`
- **Key files:**
  - `src/tools/save.ts` — **Save pipeline**: safeParse → injection detection (NFKC-normalized + zero-width stripped) → length check → basicSanitize → boundary marker strip → hash dedup (per-project in-memory Set) → embed → BM25 sparse encode → Qdrant upsert. Per-project write serialization via Promise-chain mutex.
  - `src/tools/search.ts` — **Search pipeline**: safeParse → embed query → BM25 encode → Qdrant hybrid search (prefetch dense+sparse, RRF fusion) → owner scope filtering → wrap results in `[MEMORY_CONTENT_START/END]` boundary markers + system_note.
  - `src/tools/forget.ts` — **Forget pipeline**: safeParse → ownership check → Qdrant setPayload (soft-delete to `lifecycle: "archived"`) → JSONL audit log.
  - `src/tools/status.ts` — Health check: parallel Qdrant + Embedding health probes, collection info, rate limiter budget stats.

### Service Layer — Infrastructure Abstractions

Stateful services constructed once in the DI container. Each wraps a specific infrastructure concern.

- **Location:** `src/services/`
- **Key files:**
  - `src/services/qdrant.ts` (562 LOC) — Qdrant client wrapper. Auto-creates collections with named vectors (`dense` 1024d Cosine + `bm25` sparse). Enforces `wait: true` on upserts. Hybrid search via prefetch + RRF fusion. Collection naming: `em_${slugify(project)}`.
  - `src/services/embedding.ts` (255 LOC) — Facade over multiple embedding providers with automatic fallback. Strategy pattern: providers ordered by priority; `shouldUseProvider` callback enables circuit breaker bypass; `onSuccess`/`onFailure` callbacks for cost tracking and breaker logic.
  - `src/services/embedding-providers.ts` (625 LOC) — Two concrete providers: `OllamaEmbeddingProvider` (local bge-m3, 1024d) and `GeminiEmbeddingProvider` (Vertex AI gemini-embedding-001, MRL 1024d). Both implement exponential backoff retry, AbortController timeout, vector validation.
  - `src/services/bm25.ts` (263 LOC) — Pure-JS BM25 sparse vector encoder. FNV-1a hash for term→index mapping. CJK single-char tokenization + English word-level tokenization. No IDF (compensated by RRF fusion).
  - `src/services/audit.ts` (346 LOC) — JSONL hot write layer. Async buffered writes, fire-and-forget. PIPE_BUF atomic guarantee. Auto-rotation on size threshold.
  - `src/services/analytics.ts` (1379 LOC) — SQLite cold analysis layer. WAL mode. 3 tables: `audit_events`, `hourly_rollups`, `daily_rollups`. Periodic JSONL import + aggregation. Configurable retention (raw 30d, hourly 7d, daily 90d).
  - `src/services/api-key-manager.ts` (1119 LOC) — API Key CRUD + SQLite persistence. SHA-256 hash storage (plaintext returned once on create/rotate). In-memory cache for hot-path validation. Per-key usage statistics.
  - `src/services/auth.ts` (828 LOC) — User CRUD, scrypt password hashing, HMAC-SHA256 JWT (derived from ADMIN_TOKEN via HKDF). Zero external auth dependencies.
  - `src/services/ban-manager.ts` (429 LOC) — IP/CIDR and API key bans. Memory-hot + SQLite write-through. Temporary (TTL) and permanent bans. Lazy expiration on check.
  - `src/services/runtime-config.ts` (248 LOC) — Runtime-mutable config (rate limits, retention, etc.). JSON file persistence. Env var defaults → runtime overrides merge.
  - `src/services/memory-ownership.ts` (454 LOC) — Legacy memory ownership remediation. Backfills `owner_user_id`/`owner_key_prefix` onto Qdrant points that lack stable attribution.

### Type Layer — Data Contracts

Zod schemas as the single source of truth for all I/O validation.

- **Location:** `src/types/`
- **Key files:**
  - `src/types/schema.ts` — Core memory metadata schema v2. All MCP tool input/output types. Enums for `source`, `fact_type`, `lifecycle`, `memory_scope`, `memory_type`.
  - `src/types/admin-schema.ts` — API Key, Ban, Runtime Config, Admin Action types and Zod schemas.
  - `src/types/audit-schema.ts` — Audit log entry schema. WHO/WHEN/WHAT/TARGET/OUTCOME structure.
  - `src/types/auth-schema.ts` — User roles (admin/user), JWT payload, refresh token types.

### Utility Layer

- **Location:** `src/utils/`
- **Key files:**
  - `src/utils/logger.ts` — stderr-only logger (protects MCP stdout purity). Fallback to file if stderr EPIPE.
  - `src/utils/sanitize.ts` — Regex-based sensitive data redaction (AWS keys, JWT, PEM, DB connection strings).
  - `src/utils/hash.ts` — SHA-256 content hashing with 8-step normalization (BOM removal, NFKC, trim, whitespace collapse, etc.).
  - `src/utils/rate-limiter.ts` — Sliding window rate limiter + Gemini budget circuit breaker (hourly + daily caps).
  - `src/utils/paths.ts` — Centralized data directory resolution (`DATA_DIR` env → `HOME` → `/tmp`).
  - `src/utils/shutdown.ts` — Graceful shutdown: stdin close/end, SIGTERM, SIGINT listeners. Watchdog timer.
  - `src/utils/ip.ts` — Client IP extraction with X-Forwarded-For proxy support.

### Transport Layer

- **Location:** `src/transport/`
- **Key file:**
  - `src/transport/SafeStdioTransport.ts` — Extends MCP SDK's `StdioServerTransport`. Memory write queue for serialization. EPIPE-safe stdout writes. 60KB message size limit.

## Entry Points

| Entry Point | File | Purpose |
|-------------|------|---------|
| Main process | `src/index.ts` | Mode router: remote proxy → MCP stdio → HTTP. Parses env, creates container, starts shell. |
| MCP Shell | `src/mcp/server.ts` → `startMcpShell()` | Registers tools on McpServer, connects SafeStdioTransport. |
| HTTP Shell | `src/api/server.ts` → `startHttpShell()` | Creates Hono app, registers routes/middleware, starts `@hono/node-server`. |
| Remote Proxy | `src/mcp/remote-server.ts` → `createRemoteMcpServer()` | Stdio MCP server forwarding to remote HTTP API. |
| MCP over HTTP | `src/api/server.ts` → `app.all("/mcp")` | Stateless per-request MCP server via `WebStandardStreamableHTTPServerTransport`. |

## Data Flow

### Memory Save (MCP path)

```
1. Client sends JSON-RPC call → stdin
2. SafeStdioTransport deserializes → McpServer dispatches to "memory_save" handler
3. Shell: rateLimiter.checkRate() → rate_limited response on failure
4. Tool: handleSave(args, deps)
   a. Zod safeParse (validation)
   b. NFKC normalization + zero-width stripping + prompt injection detection
   c. Content length check (50KB max)
   d. basicSanitize() — redact sensitive patterns
   e. stripBoundaryMarkers() — remove [MEMORY_CONTENT_START/END]
   f. isFullyRedacted() check — reject if content is entirely sensitive
   g. computeHash(cleanedContent) — SHA-256 dedup
   h. Per-project lock acquire (Promise-chain mutex)
   i. In-memory hashSet dedup check
   j. embedding.embedWithMeta(content) → 1024d dense vector
   k. bm25.encode(content) → sparse vector
   l. qdrant.upsert(point) with wait:true
   m. Lock release
5. Shell: recordAudit() → AuditService (JSONL) + AnalyticsService (SQLite)
6. MCP response → stdout
```

### Memory Search (HTTP path)

```
1. HTTP POST /api/search with Bearer token
2. Middleware chain: error handler → logger → TLS → ban check → bearerAuth → content-type → rate limit → audit
3. bearerAuth: validate masterToken (timing-safe) or manage API key (hash lookup + ban + per-key rate limit)
4. HttpSearchInputSchema.strict() validation
5. Tool: handleSearch(args, deps)
   a. Zod safeParse
   b. embedding.embedWithMeta(query) → 1024d dense vector
   c. bm25.encode(query) → sparse vector
   d. qdrant.hybridSearch() → prefetch dense + sparse, RRF fusion
   e. Owner scope filtering (callerUserId + callerOwnedKeyPrefixes)
   f. Wrap results in boundary markers + system_note
6. Audit middleware: AuditService + AnalyticsService dual-write
7. JSON response
```

### Memory Save (Remote Proxy path)

```
1. Client sends JSON-RPC call → stdin (local)
2. SafeStdioTransport → McpServer → "memory_save" handler
3. remoteCall(baseUrl, token, "POST", "/api/save", body)
4. HTTP fetch with Bearer EASY_MEMORY_TOKEN to remote server
5. Remote server processes via HTTP path (above)
6. Response forwarded back → stdout
```

## Dependency Injection

- **Container:** `src/container.ts`
- **Pattern:** Factory function `createContainer(config)` returning a frozen `AppContainer` interface. No DI framework — manual wiring with strict instantiation order.
- **Instantiation order (by dependency graph):**
  1. `RateLimiter` — pure memory, no IO
  2. `OllamaEmbeddingProvider` / `GeminiEmbeddingProvider` — construct only, no connection
  3. `EmbeddingService` — wraps providers + rateLimiter callbacks
  4. `QdrantService` — independent of embedding
  5. `BM25Encoder` — pure memory computation
  6. `AuditService` — JSONL writer, starts async flush loop
  7. `AnalyticsService` — opens SQLite (WAL mode)
  8. `ApiKeyManager` — opens SQLite, shares DB handle downstream
  9. `BanManager` — shares ApiKeyManager's SQLite DB (or opens own)
  10. `RuntimeConfigManager` — JSON file persistence
  11. `AuthService` — shares admin DB, seeds admin user
  12. `MemoryOwnershipService` — depends on QdrantService + ApiKeyManager

- **Key bindings:**

| Service | Interface | Purpose |
|---------|-----------|---------|
| `container.qdrant` | `QdrantService` | Vector DB operations |
| `container.embedding` | `EmbeddingService` | Text → vector conversion |
| `container.bm25` | `BM25Encoder` | Sparse vector encoding |
| `container.rateLimiter` | `RateLimiter` | Global + Gemini budget limits |
| `container.audit` | `AuditService` | JSONL hot audit writes |
| `container.analytics` | `AnalyticsService` | SQLite aggregation + queries |
| `container.apiKeyManager` | `ApiKeyManager` | API key CRUD + validation |
| `container.banManager` | `BanManager` | IP/key ban enforcement |
| `container.runtimeConfig` | `RuntimeConfigManager` | Mutable runtime settings |
| `container.auth` | `AuthService` | User auth + JWT + RBAC |
| `container.memoryOwnership` | `MemoryOwnershipService` | Ownership backfill |

## Authentication Architecture

The system implements a layered auth model:

1. **MCP stdio** — inherently trusted (local process IPC), tagged as `keyPrefix: "stdio"`.
2. **HTTP Master Token** — `HTTP_AUTH_TOKEN` env var, timing-safe comparison, full access.
3. **Managed API Keys** — created via admin API, SHA-256 hashed, per-key rate limits and ban. Scoped permissions (`memory:save`, `memory:search`, etc.).
4. **JWT User Auth** — scrypt passwords, HMAC-SHA256 JWT (2h expiry), httpOnly cookie delivery, refresh token rotation. Roles: `admin` (full), `user` (scoped by permissions).
5. **Admin Token** — `ADMIN_TOKEN` env var, separate from HTTP_AUTH_TOKEN, gates admin API + seeds initial admin user.

## Error Handling

- **Tool layer:** `safeParse` returns structured error responses (never throws for validation failures). Embedding failures return `pending_embedding` status. All errors are JSON-serializable.
- **Shell layer — MCP:** Errors caught per-tool, returned as `isError: true` MCP responses. Unhandled rejections logged to stderr.
- **Shell layer — HTTP:** `globalErrorHandler` catches all exceptions, returns generic 500 (no stack traces). Path-specific error codes for auth/ban/rate-limit.
- **Audit:** Fire-and-forget writes. JSONL failures silent (stderr fallback). Never blocks request pipeline.

## Security Architecture

- **Input sanitization pipeline:** NFKC normalization → zero-width character stripping → prompt injection regex detection → sensitive data redaction → boundary marker removal.
- **Stdout purity:** `console.*` hijacked to stderr. `SafeStdioTransport` handles EPIPE. Logger exclusively writes to stderr.
- **Network security defaults:** HTTP binds `127.0.0.1`. Optional `TRUST_PROXY` + `REQUIRE_TLS` for reverse proxy deployments. IP ban enforcement at middleware layer.
- **Secrets:** Read from env vars only. SHA-256 hashed storage for API keys. scrypt for passwords. Timing-safe comparisons throughout.

## Design Decisions

- **Dual-shell architecture:** MCP stdio for local AI agent integration; HTTP for remote/server deployment. Both call identical tool handlers — ensures behavioral parity.
- **No DI framework:** Manual factory function keeps dependency graph explicit and fast. Container is created once per process lifetime.
- **Soft delete (archive):** `memory_forget` sets `lifecycle: "archived"` via Qdrant payload update rather than physical deletion. Preserves audit trail.
- **Hybrid retrieval (dense + BM25):** Dense vectors capture semantic similarity; BM25 sparse vectors capture exact keyword matches. RRF fusion combines both. BM25 is pure-JS with zero ML inference overhead.
- **Dual audit storage:** JSONL for hot real-time writes (never blocks), SQLite for cold analytical queries (WAL mode for concurrent reads).
- **Per-project write serialization:** Promise-chain mutex prevents concurrent dedup race conditions within the same project.
- **Content hash dedup:** In-memory per-project hash sets with 10K cap and 20% LRU eviction.
- **Embedding provider fallback:** `auto` mode: Gemini primary → Ollama local fallback. Circuit breaker on Gemini failures (hour/day budget caps).
- **MCP Streamable HTTP:** `/mcp` endpoint creates stateless per-request MCP server, enabling remote MCP clients to connect via API key auth.

---

*Architecture analysis: 2026-03-14*
