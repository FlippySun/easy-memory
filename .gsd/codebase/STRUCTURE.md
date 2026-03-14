# Codebase Structure

**Analysis Date:** 2026-03-14

## Overview

```
src/
├── index.ts                     - Process entry: mode routing (remote proxy → MCP → HTTP)
├── container.ts                 - DI container factory: creates all service singletons
├── api/                         - HTTP shell adapter (Hono framework)
│   ├── server.ts                - App creation, route registration, middleware stack, startHttpShell()
│   ├── middlewares.ts           - bearerAuth, globalErrorHandler, requestLogger, TLS enforcement, JSON content-type check
│   ├── schemas.ts               - HTTP-specific strict Zod schemas (defense-in-depth over core schemas)
│   ├── admin-auth.ts            - Admin auth middleware (ADMIN_TOKEN + JWT admin dual-path)
│   ├── admin-routes.ts          - /api/admin/* routes: keys, bans, analytics, audit, config, actions
│   ├── auth-routes.ts           - /api/auth/* routes: login, logout, refresh, register, me, users CRUD
│   ├── memory-routes.ts         - /api/memories/* routes: memory browsing, stats, updates
│   └── user-key-routes.ts       - /api/user/keys routes: self-service API key management
├── mcp/                         - MCP shell adapter (stdio JSON-RPC)
│   ├── server.ts                - McpServer setup, tool registration, console hijacking, startMcpShell()
│   └── remote-server.ts         - Remote proxy mode: stdio MCP → HTTP forwarding
├── services/                    - Core infrastructure services (stateful singletons)
│   ├── qdrant.ts                - Qdrant vector DB client: CRUD, hybrid search, collection management
│   ├── embedding.ts             - Embedding facade: multi-provider routing + automatic fallback
│   ├── embedding-providers.ts   - Concrete providers: Ollama (local) + Gemini (Vertex AI)
│   ├── bm25.ts                  - BM25 sparse vector encoder (pure JS, FNV-1a hash)
│   ├── audit.ts                 - JSONL hot audit log writer (buffered async)
│   ├── analytics.ts             - SQLite analytics: event ingest, rollups, retention, queries
│   ├── api-key-manager.ts       - API Key CRUD + SHA-256 hash storage + in-memory cache
│   ├── auth.ts                  - User auth: scrypt passwords, HMAC-SHA256 JWT, RBAC
│   ├── ban-manager.ts           - IP/key ban enforcement: memory-hot + SQLite write-through
│   ├── runtime-config.ts        - Runtime-mutable configuration: JSON file + memory overlay
│   └── memory-ownership.ts      - Legacy ownership remediation + stable owner backfill
├── tools/                       - Core business logic handlers (pure functions)
│   ├── save.ts                  - memory_save: validation → sanitization → dedup → embed → upsert
│   ├── search.ts                - memory_search: embed query → hybrid search → boundary markers
│   ├── forget.ts                - memory_forget: ownership check → soft-delete (archive) → audit
│   └── status.ts                - memory_status: health probes + collection info + rate budget
├── transport/                   - MCP transport extensions
│   └── SafeStdioTransport.ts    - EPIPE-safe stdio with write queue serialization (60KB limit)
├── types/                       - Zod schemas and TypeScript type definitions
│   ├── schema.ts                - Core memory metadata v2: input/output schemas, enums, constants
│   ├── admin-schema.ts          - Admin API types: API keys, bans, config, admin actions
│   ├── audit-schema.ts          - Audit log entry schema (WHO/WHEN/WHAT/TARGET/OUTCOME)
│   └── auth-schema.ts           - Auth types: user roles, JWT payload, refresh tokens
└── utils/                       - Shared utility modules (stateless)
    ├── logger.ts                - stderr-only structured logger (MCP stdout protection)
    ├── sanitize.ts              - Sensitive data redaction (AWS keys, JWT, PEM, DB URIs)
    ├── hash.ts                  - SHA-256 content hashing with 8-step normalization
    ├── rate-limiter.ts          - Sliding window limiter + Gemini budget circuit breaker
    ├── paths.ts                 - Data directory path resolution (DATA_DIR → HOME → /tmp)
    ├── shutdown.ts              - Graceful shutdown: signal handlers + watchdog timer
    └── ip.ts                    - Client IP extraction (X-Forwarded-For aware)

tests/                           - Vitest test suites (mirrors src/ structure)
├── api/                         - HTTP shell tests
│   ├── admin-auth.test.ts
│   ├── auth-rbac-regression.test.ts
│   ├── memory-routes.test.ts
│   ├── middlewares.test.ts
│   └── server.test.ts
├── mcp/                         - MCP shell tests
│   ├── remote-server.test.ts
│   └── server.test.ts
├── services/                    - Service layer tests
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
├── tools/                       - Tool handler tests
│   ├── forget.test.ts
│   ├── save.test.ts
│   ├── search.test.ts
│   └── status.test.ts
├── transport/                   - Transport tests
│   └── SafeStdioTransport.test.ts
├── types/                       - Schema tests
│   ├── admin-schema.test.ts
│   ├── audit-schema.test.ts
│   ├── auth-schema.test.ts
│   └── schema.test.ts
├── utils/                       - Utility tests
│   ├── hash.test.ts
│   ├── ip.test.ts
│   ├── logger.test.ts
│   ├── paths.test.ts
│   ├── rate-limiter.test.ts
│   ├── sanitize.test.ts
│   └── shutdown.test.ts
├── container.test.ts            - DI container wiring test
├── e2e.test.ts                  - End-to-end integration test
├── e2e-comprehensive.test.ts    - Extended E2E coverage
├── e2e-dual-engine.test.ts      - Dual-engine (Gemini+Ollama) E2E
├── audit-analytics-comprehensive.test.ts
├── audit-comprehensive.test.ts
└── phase2-auth-audit.test.ts

web/                             - Admin dashboard SPA (React + Vite)
├── src/
│   ├── main.tsx                 - Vite entry point
│   ├── App.tsx                  - Router + layout
│   ├── api/
│   │   └── client.ts            - HTTP API client for admin/auth endpoints
│   ├── components/
│   │   ├── Layout.tsx           - App shell layout
│   │   ├── LanguageSwitcher.tsx - i18n language toggle
│   │   └── ui.tsx               - Shared UI primitives
│   ├── contexts/
│   │   ├── auth.tsx             - Auth context (JWT state management)
│   │   └── i18n.tsx             - Internationalization context
│   ├── i18n/
│   │   ├── index.ts             - i18n initialization
│   │   ├── resources.ts         - Translation resources
│   │   └── format.ts            - Date/number formatting
│   └── pages/
│       ├── Dashboard.tsx        - Overview dashboard
│       ├── Analytics.tsx        - Usage analytics charts
│       ├── ApiKeys.tsx          - API key management (admin)
│       ├── AuditLogs.tsx        - Audit log viewer
│       ├── Bans.tsx             - Ban management
│       ├── Login.tsx            - Login page
│       ├── Register.tsx         - Registration page
│       ├── MemoryBrowser.tsx    - Memory browsing and editing
│       ├── MyKeys.tsx           - User self-service keys
│       ├── Settings.tsx         - Runtime config settings
│       └── Users.tsx            - User management (admin)
└── public/                      - Static assets

deploy/                          - Deployment configurations (Docker, etc.)
```

## Key Locations

| What                    | Where                     | Notes                                                                                                                                                 |
| ----------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process entry point     | `src/index.ts`            | Mode routing: checks `EASY_MEMORY_TOKEN` → `EASY_MEMORY_MODE`                                                                                         |
| DI container factory    | `src/container.ts`        | Single `createContainer()` — all singletons wired here                                                                                                |
| Core business logic     | `src/tools/`              | 4 handlers: save, search, forget, status. Pure functions taking typed deps.                                                                           |
| Infrastructure services | `src/services/`           | 11 stateful services (Qdrant, Embedding, BM25, Audit, Analytics, ApiKeyManager, Auth, BanManager, RuntimeConfig, MemoryOwnership, EmbeddingProviders) |
| MCP shell adapter       | `src/mcp/server.ts`       | `registerTools()` (public, reused by HTTP MCP endpoint) + `startMcpShell()`                                                                           |
| HTTP shell adapter      | `src/api/server.ts`       | Hono app factory + `startHttpShell()`                                                                                                                 |
| HTTP middleware         | `src/api/middlewares.ts`  | bearerAuth, globalErrorHandler, requestLogger, TLS, content-type                                                                                      |
| Admin routes            | `src/api/admin-routes.ts` | Keys, bans, analytics, audit, config, actions — 1137 LOC                                                                                              |
| Auth routes             | `src/api/auth-routes.ts`  | Login, logout, refresh, register, user CRUD — 897 LOC                                                                                                 |
| Schema definitions      | `src/types/schema.ts`     | Core memory schemas (Single Source of Truth)                                                                                                          |
| HTTP-specific schemas   | `src/api/schemas.ts`      | `.strict()` versions for defense-in-depth                                                                                                             |
| Shared logger           | `src/utils/logger.ts`     | stderr-only — `log.info/warn/error/debug`                                                                                                             |
| Data path config        | `src/utils/paths.ts`      | `DATA_PATHS` object with all persistent file locations                                                                                                |
| Test suites             | `tests/`                  | Mirrors `src/` structure exactly                                                                                                                      |
| Admin web app           | `web/src/`                | React SPA with pages, components, contexts, i18n                                                                                                      |
| Deployment              | `deploy/`                 | Docker and related configs                                                                                                                            |

## Directory Purposes

**`src/api/`** — HTTP protocol adapter. Contains Hono route definitions, middleware, and HTTP-specific schema validation. 7 files, ~3500 LOC total. Largest files: `server.ts` (1105), `admin-routes.ts` (1137), `auth-routes.ts` (897).

**`src/mcp/`** — MCP stdio protocol adapter. 2 files: `server.ts` (local MCP) and `remote-server.ts` (proxy mode). Tool registration function `registerTools()` is exported for reuse by HTTP shell's `/mcp` endpoint.

**`src/services/`** — Stateful infrastructure services. Each wraps a specific concern (database, auth, embedding, etc.). Instantiated exactly once via `container.ts`. 11 files, ~6600 LOC total.

**`src/tools/`** — Core business logic. 4 files, one per memory operation. Receives dependencies as typed objects (not global state). These are the shared kernel that both shells invoke identically.

**`src/types/`** — Zod schemas and TypeScript type definitions. 4 files covering memory metadata, admin, audit, and auth contracts. Schemas used for both validation and type inference.

**`src/utils/`** — Stateless utility functions. Logger, sanitizer, hasher, rate limiter, path resolver, shutdown manager, IP extractor. 7 files, ~620 LOC total.

**`src/transport/`** — Custom MCP transport. 1 file: `SafeStdioTransport.ts` extends SDK's transport with write queue, EPIPE protection, and 60KB size limit.

**`tests/`** — Vitest test suites mirroring `src/` exactly. Every source module has a corresponding test file. Additional E2E tests at the root of `tests/`.

**`web/`** — Standalone React SPA (Vite) for admin dashboard. Separate `package.json` and `node_modules`. Pages for dashboard, analytics, API keys, audit logs, bans, memory browser, user management, settings.

## File Naming Conventions

- **Source files:** kebab-case `.ts` — `api-key-manager.ts`, `rate-limiter.ts`, `remote-server.ts`
- **Type files:** kebab-case with `-schema` suffix — `admin-schema.ts`, `audit-schema.ts`
- **Test files:** mirror source path + `.test.ts` suffix — `tests/services/qdrant.test.ts` for `src/services/qdrant.ts`
- **Transport:** PascalCase for class-centric module — `SafeStdioTransport.ts`
- **Web components:** PascalCase `.tsx` — `Dashboard.tsx`, `LanguageSwitcher.tsx`
- **Route modules:** kebab-case with `-routes` suffix — `admin-routes.ts`, `auth-routes.ts`

## Where to Add New Code

**New MCP tool:**

1. Create handler in `src/tools/{name}.ts` with typed `{Name}HandlerDeps` interface
2. Add input/output Zod schemas to `src/types/schema.ts`
3. Register in `src/mcp/server.ts` → `registerTools()` (both shells use this)
4. Add HTTP route in `src/api/server.ts`
5. Add HTTP schema in `src/api/schemas.ts`
6. Test: `tests/tools/{name}.test.ts`

**New service:**

1. Create service class in `src/services/{name}.ts`
2. Add to `AppContainer` interface in `src/container.ts`
3. Instantiate in `createContainer()` respecting dependency order
4. Test: `tests/services/{name}.test.ts`

**New API route group:**

1. Create route factory `create{Name}Routes()` in `src/api/{name}-routes.ts`
2. Mount in `src/api/server.ts` via `app.route("/api/{name}", routes)`
3. Add auth middleware as appropriate
4. Test: `tests/api/{name}.test.ts`

**New utility:**

1. Add to `src/utils/{name}.ts`
2. Import where needed (no container wiring required)
3. Test: `tests/utils/{name}.test.ts`

## Module Dependencies

```
index.ts
  ├── container.ts (createContainer + parseAppConfig)
  ├── mcp/server.ts (startMcpShell)
  ├── api/server.ts (startHttpShell)
  └── mcp/remote-server.ts (createRemoteMcpServer)

container.ts
  ├── services/qdrant.ts
  ├── services/embedding.ts + embedding-providers.ts
  ├── services/bm25.ts
  ├── services/audit.ts
  ├── services/analytics.ts
  ├── services/api-key-manager.ts
  ├── services/auth.ts
  ├── services/ban-manager.ts
  ├── services/runtime-config.ts
  ├── services/memory-ownership.ts
  └── utils/rate-limiter.ts

mcp/server.ts
  ├── tools/save.ts
  ├── tools/search.ts
  ├── tools/forget.ts
  ├── tools/status.ts
  ├── transport/SafeStdioTransport.ts
  └── utils/shutdown.ts

api/server.ts
  ├── tools/save.ts, search.ts, forget.ts, status.ts
  ├── api/middlewares.ts
  ├── api/schemas.ts
  ├── api/admin-routes.ts
  ├── api/auth-routes.ts
  ├── api/memory-routes.ts
  ├── api/user-key-routes.ts
  ├── api/admin-auth.ts
  └── mcp/server.ts (registerTools — reused for /mcp endpoint)

tools/*.ts
  ├── services/qdrant.ts (via deps)
  ├── services/embedding.ts (via deps)
  ├── services/bm25.ts (via deps)
  ├── types/schema.ts
  ├── utils/sanitize.ts
  ├── utils/hash.ts
  └── utils/logger.ts
```

**Key dependency rule:** Tools depend on services via injected deps (never import container). Services depend only on utils and types. Shells depend on tools and container. No circular dependencies.

## Special Directories

**`.gsd/`** — GSD workflow documents (planning, codebase analysis). Not committed. Generated.

**`.planning/`** — Project planning state (STATE.md, PROJECT.md, etc.). May or may not be committed.

**`deploy/`** — Deployment artifacts (Dockerfiles, compose files). Committed.

**`web/`** — Separate npm workspace. Has its own `package.json`, `node_modules/`, and Vite build config. Built independently with `pnpm build:web`.

**`dist/`** — TypeScript compilation output. Generated. Not committed.

---

_Structure analysis: 2026-03-14_
