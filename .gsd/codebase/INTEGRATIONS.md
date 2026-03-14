# External Integrations

**Analysis Date:** 2026-03-14

## Databases

### Qdrant (Vector Database)

- **Type:** Vector database with named vectors (dense + sparse)
- **Client:** `@qdrant/js-client-rest` ^1.17.0
- **Connection:** REST API via `QDRANT_URL` env var (default: `http://localhost:6333`)
- **Authentication:** API key via `QDRANT_API_KEY` env var (mandatory — initialization fails without it)
- **Implementation:** `src/services/qdrant.ts` — `QdrantService` class
- **Key operations:**
  - Collection management: auto-create per project (`em_{slugified_project}`), named vectors `dense` (1024d Cosine) + `bm25` (sparse)
  - Upsert: `wait: true` enforced (strong consistency)
  - Hybrid search: Dense vector + BM25 sparse vector with RRF (Reciprocal Rank Fusion) prefetch
  - Point CRUD: scroll, get, delete by ID/filter
  - Connection verification: 3-attempt exponential backoff on startup
- **Docker:** `qdrant/qdrant:latest` — ports 6333 (REST) + 6334 (gRPC)

### SQLite (Local Persistence)

- **Type:** Embedded relational database
- **Client:** `better-sqlite3` ^12.6.2 (native addon, synchronous API)
- **Connection:** File-based, paths managed by `src/utils/paths.ts` under `DATA_DIR`
- **Databases:**
  - `~/.easy-memory-admin.db` — API keys, bans, users, refresh tokens, admin actions
  - `~/.easy-memory-analytics.db` — Audit event aggregation (hourly/daily rollups), WAL mode
- **Implementation:**
  - `src/services/api-key-manager.ts` — API key CRUD + SHA-256 hash storage + memory cache
  - `src/services/ban-manager.ts` — Ban management (API key + IP/CIDR), memory hot cache + write-through
  - `src/services/analytics.ts` — Audit log aggregation, data retention (raw 30d, hourly 7d, daily 90d)
  - `src/services/auth.ts` — User table, refresh tokens
- **Key operations:** WAL mode for concurrent reads/writes, automatic schema migration via inline DDL

## AI/ML Services

### Ollama (Local Embedding — Primary Provider)

- **Purpose:** Text embedding generation (semantic vector search)
- **Model:** `bge-m3` (default, 1024-dimensional vectors)
- **Client:** Native `fetch()` HTTP calls (no SDK)
- **Connection:** `OLLAMA_BASE_URL` env var (default: `http://localhost:11434`)
- **Timeout:** Configurable via `OLLAMA_TIMEOUT_MS` (default: 120,000ms)
- **Implementation:** `src/services/embedding-providers.ts` — `OllamaEmbeddingProvider` class
- **Features:**
  - Exponential backoff retry (up to 5 attempts)
  - AbortController timeout management
  - Vector validation (NaN, Infinity, dimension check)
  - Circuit breaker integration
- **Docker:** `ollama/ollama:latest` — port 11434, auto-pull model via `ollama-init` init container

### Google Cloud Vertex AI (Cloud Embedding — Fallback Provider)

- **Purpose:** Cloud-based text embedding (fallback when Ollama unavailable)
- **Model:** `gemini-embedding-001` (MRL → 1024 dimensions)
- **Client:** Native `fetch()` to Vertex AI REST API (no SDK)
- **Endpoint:** `https://{REGION}-aiplatform.googleapis.com/v1/projects/{PROJECT_ID}/locations/{REGION}/publishers/google/models/{MODEL}:predict`
- **Authentication:** `GEMINI_API_KEY` used as Bearer token
- **Configuration:**
  - `GEMINI_API_KEY` — API key (required for Gemini provider)
  - `GEMINI_PROJECT_ID` — Google Cloud project ID
  - `GEMINI_REGION` — Region (default: `us-central1`)
  - `GEMINI_MODEL` — Model name (default: `gemini-embedding-001`)
- **Rate Limiting:**
  - `GEMINI_MAX_PER_HOUR` (default: 200)
  - `GEMINI_MAX_PER_DAY` (default: 2000)
- **Implementation:** `src/services/embedding-providers.ts` — `GeminiEmbeddingProvider` class
- **Features:** Longer backoff for 429 (RESOURCE_EXHAUSTED), non-retryable error classification (400/401/403/404)

### Embedding Service (Unified Facade)

- **Implementation:** `src/services/embedding.ts` — `EmbeddingService` class
- **Strategy:** Provider priority list (Ollama first, Gemini fallback)
- **Configuration:** `EMBEDDING_PROVIDER` env var: `"ollama"` | `"gemini"` | `"auto"` (auto = both with fallback)
- **Features:**
  - Automatic fallback on primary provider failure
  - Circuit breaker pattern (per-provider, failure-driven)
  - Cost tracking callbacks (`onSuccess`, `onFailure`)
  - Provider filtering via `shouldUseProvider` callback

## Authentication & Identity

### Master Token Authentication

- **Method:** Bearer token over HTTP
- **Implementation:** `src/api/middlewares.ts` — `bearerAuth()` middleware
- **Configuration:** `HTTP_AUTH_TOKEN` env var (empty = dev mode, no auth)
- **Properties:** Timing-safe comparison to prevent timing attacks

### Managed API Keys

- **Method:** Bearer token (SHA-256 hashed keys)
- **Implementation:** `src/services/api-key-manager.ts` — `ApiKeyManager` class
- **Storage:** SQLite `api_keys` table (hash + prefix stored, never plaintext)
- **Features:**
  - Key creation with `em_` prefix + random bytes
  - Per-key rate limiting, scopes, expiry
  - Key rotation (revoke old, issue new)
  - Memory cache for hot-path lookup (hash → record)
  - Usage tracking (total requests, last used)

### User Authentication (Admin Web UI)

- **Method:** JWT (HMAC-SHA256) — Access Token (15min) + Refresh Token
- **Implementation:** `src/services/auth.ts` — `AuthService` class
- **Password:** `crypto.scryptSync` (N=16384, r=8, p=1) + random salt, timing-safe verify
- **JWT:** Zero-dependency implementation using Node.js `crypto` module
- **JWT Secret:** Derived from `ADMIN_TOKEN` via HKDF
- **Refresh Tokens:** Stored in SQLite with reuse grace period
- **Roles:** Permission-based (`ROLE_PERMISSIONS` from `src/types/auth-schema.ts`)

### Admin Authentication

- **Implementation:** `src/api/admin-auth.ts` — `adminAuth()` middleware
- **Configuration:** `ADMIN_TOKEN` env var (separate from `HTTP_AUTH_TOKEN`)

### Ban Management

- **Implementation:** `src/services/ban-manager.ts` — `BanManager` class
- **Types:** API key bans + IP/CIDR bans (temporary with TTL or permanent)
- **Check:** O(1) memory-based, lazy expiry cleanup

## External APIs

### Remote Easy Memory Proxy

- **Purpose:** MCP proxy mode — local stdio MCP server forwards calls to remote HTTP server
- **Trigger:** `EASY_MEMORY_TOKEN` env var set
- **Target:** `EASY_MEMORY_URL` env var (e.g., `https://memory.zhiz.chat`)
- **Authentication:** Bearer token (`EASY_MEMORY_TOKEN`)
- **Implementation:** `src/mcp/remote-server.ts` — `createRemoteMcpServer()`
- **Key endpoints proxied:** `/api/save`, `/api/search`, `/api/forget`, `/api/status`
- **Timeout:** 30s per request

## Message Transport

### MCP (Model Context Protocol) — stdio

- **Protocol:** JSON-RPC over stdin/stdout IPC
- **Transport:** `src/transport/SafeStdioTransport.ts` — extends SDK `StdioServerTransport`
- **Features:**
  - Write queue serialization (prevents message interleaving)
  - Direct stdout write with backpressure handling
  - EPIPE silent handling (no crash on pipe break)
  - Max message size: 60KB (`STDIO_MAX_BYTES = 61440`)
- **Usage:** Default mode (`EASY_MEMORY_MODE=mcp`), local-only

### MCP (Model Context Protocol) — Streamable HTTP

- **Protocol:** MCP over HTTP (WebStandard Streamable HTTP transport)
- **Transport:** `WebStandardStreamableHTTPServerTransport` from MCP SDK
- **Implementation:** Mounted within the Hono HTTP server (`src/api/server.ts`)
- **Usage:** HTTP mode alongside REST API, enables remote MCP clients

### HTTP REST API

- **Framework:** Hono 4.12.x with `@hono/node-server`
- **Implementation:** `src/api/server.ts` — `startHttpShell()`
- **Endpoints:**
  - `POST /api/save` — Save memory
  - `POST /api/search` — Search memories
  - `POST /api/forget` — Forget/archive memory
  - `GET /api/status` — Service status
  - `/api/admin/*` — Admin management routes
  - `/api/auth/*` — User authentication routes
  - `/api/keys/*` — User API key management
  - `/api/memories/*` — Memory CRUD routes
  - `GET /health` — Health check
- **Middleware:** CORS, bearer auth, TLS enforcement, request logging, JSON content-type validation, error boundary
- **Network Security:**
  - `HTTP_HOST` — Default `127.0.0.1` (localhost only)
  - `TRUST_PROXY` — X-Forwarded-\* header trust
  - `REQUIRE_TLS` — Reject non-HTTPS (requires `TRUST_PROXY`)

## Audit & Observability

### Audit Logging

- **Implementation:** `src/services/audit.ts` — `AuditService` class
- **Format:** JSONL (hot write layer) → `~/.easy-memory-audit.jsonl`
- **Features:**
  - Non-blocking memory buffer → async batch flush (1s interval)
  - < 0.1ms enqueue latency
  - File rotation (50MB max, 5 rotated files)
  - Graceful degradation to stderr on disk failure

### Analytics

- **Implementation:** `src/services/analytics.ts` — `AnalyticsService` class
- **Storage:** SQLite WAL mode (`~/.easy-memory-analytics.db`)
- **Features:**
  - Periodic JSONL → SQLite aggregation (hourly)
  - Hourly + daily rollups
  - Data retention: raw 30d, hourly 7d, daily 90d
  - User/project usage summaries, hit rate metrics, error rate metrics

### Application Logging

- **Implementation:** `src/utils/logger.ts` — `safeLog()` function
- **Output:** stderr only (JSON format) — stdout reserved for MCP stdio
- **Fallback:** `~/.easy-memory-fallback.log` when stderr unavailable (EPIPE)

## Security Services

### Content Sanitization

- **Implementation:** `src/utils/sanitize.ts`
- **Patterns detected:** AWS keys, JWT tokens, PEM keys, database connection strings
- **Action:** Replace with `[REDACTED]`

### Content Hashing

- **Implementation:** `src/utils/hash.ts` — `normalizeForHash()` + SHA-256
- **Normalization:** 8-step pipeline (BOM removal, NFKC, trim, line endings, invisible chars, trailing spaces, blank lines, inline spaces)
- **Purpose:** Deduplication before memory upsert

### Rate Limiting

- **Implementation:** `src/utils/rate-limiter.ts` — `RateLimiter` class
- **Scope:** Global per-minute + per-provider (Gemini hourly/daily quotas)
- **Per-key:** Optional per-API-key rate limits

### Runtime Configuration

- **Implementation:** `src/services/runtime-config.ts` — `RuntimeConfigManager` class
- **Storage:** JSON file (`~/.easy-memory-runtime-config.json`)
- **Features:** Hot-reload without restart, change listeners for downstream services

---

_Integration audit: 2026-03-14_
