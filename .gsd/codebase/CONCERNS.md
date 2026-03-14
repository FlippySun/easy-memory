# Codebase Concerns

**Analysis Date:** 2026-03-14

## Technical Debt

### Duplicated `writeAuditLog` / `AUDIT_LOG_PATH` in Tool Handlers
- **Location:** `src/tools/save.ts` (L35-46), `src/tools/forget.ts` (L24-36)
- **Severity:** Medium
- **Description:** Both `save.ts` and `forget.ts` define identical `AUDIT_LOG_PATH` constants and `writeAuditLog()` helpers using direct `appendFile`. This is legacy code from before the centralised `AuditService` (`src/services/audit.ts`) was introduced. The `AuditService` provides buffered, batched, rotation-aware JSONL writing — the tool-level functions do not.
- **Impact:** Double-write path (tool handler + MCP/HTTP shell audit), maintenance burden, inconsistent audit behaviour between shells.
- **Suggested fix:** Remove the per-tool `writeAuditLog` / `AUDIT_LOG_PATH` in `save.ts` and `forget.ts`; rely solely on the shell-level `AuditService.record()` call that already exists in `src/mcp/server.ts` and `src/api/server.ts`.

### Deprecated `bearerAuthSimple` Still Exported
- **Location:** `src/api/middlewares.ts` (L144-180)
- **Severity:** Low
- **Description:** `bearerAuthSimple` is marked `@deprecated` in favour of the full `bearerAuth(BearerAuthConfig)` variant but remains exported. No current caller uses it in production code, but it appears in test files and could confuse contributors.
- **Impact:** Dead code; potential misuse by future consumers.
- **Suggested fix:** Remove the export (or move to a `_compat` internal module) once all tests migrate to the `bearerAuth` overload.

### Deprecated `getClientIp` Re-export in `admin-auth.ts`
- **Location:** `src/api/admin-auth.ts` (L164-167)
- **Severity:** Low
- **Description:** `getClientIp` is deprecated in favour of the shared `../utils/ip.js` version, but `src/api/admin-routes.ts` still imports the deprecated re-export (10 call sites).
- **Impact:** Misleading import paths, no functional risk (it delegates to the shared version).
- **Suggested fix:** Update `admin-routes.ts` imports to `../utils/ip.js` and remove the deprecated wrapper.

### In-Memory Hash Dedup Without Qdrant Cross-Check
- **Location:** `src/tools/save.ts` (L118-145)
- **Severity:** Medium
- **Description:** Duplicate detection relies on a per-process `Set<string>`. On restart, the set is empty, so the same content can be saved again until Qdrant returns a duplicate score. In multi-instance deployments or after restart, duplicate memories may accumulate.
- **Impact:** Duplicate vectors in Qdrant, wasted embedding calls.
- **Suggested fix:** After the in-memory check, optionally scroll Qdrant for `content_hash` match (single-field filter, no vector needed) as a server-side dedup layer.

### `listAllCollections` N+1 Query
- **Location:** `src/services/qdrant.ts` (L459-495)
- **Severity:** Low
- **Description:** `listAllCollections()` calls `getCollections()` then loops with `getCollection(name)` for each `em_*` collection — one HTTP round-trip per collection. With many projects the latency adds up.
- **Impact:** Slow Memory Browser project listing for large deployments.
- **Suggested fix:** Batch the info calls or cache collection metadata on upsert.

### Synchronous File I/O in RuntimeConfigManager
- **Location:** `src/services/runtime-config.ts` (L213, L236)
- **Severity:** Low
- **Description:** `readFileSync` / `writeFileSync` are used for config persistence. In MCP mode this blocks the event loop; in HTTP mode it blocks request handling.
- **Impact:** Brief event-loop stall (~ms) during config reads/writes — acceptable at startup, problematic if admin toggles config during traffic.
- **Suggested fix:** Migrate to async `readFile` / `writeFile` for the update path (startup read can stay sync).

## Security Considerations

### Dev-Mode Auth Bypass When `HTTP_AUTH_TOKEN` Is Empty
- **Area:** Authentication
- **Current state:** Both `bearerAuth` (L70-72 in `middlewares.ts`) and `adminAuth` accept empty token = skip auth entirely. This is intentional for local dev but dangerous if deployed without configuring the env var.
- **Risk level:** High (deployment misconfiguration)
- **Notes:** The `httpHost` default is `127.0.0.1` (binds localhost only), which mitigates remote exploitation. However, Docker `--net=host` or cloud NAT misconfig could expose it. Consider requiring an explicit `EASY_MEMORY_DEV_MODE=true` flag rather than inferring from an empty token.

### Prompt Injection Detection Is Pattern-Based
- **Area:** Input validation
- **Current state:** `src/tools/save.ts` (L81-93) uses 10 static regexes to detect prompt injection. NFKC normalisation and zero-width character stripping are applied first — solid baseline.
- **Risk level:** Medium
- **Notes:** Pattern-based detection is bypassable by rephrasing or encoding tricks not yet covered. The boundary-marker stripping (`stripBoundaryMarkers`) is a good defence-in-depth, but should be monitored for new evasion patterns.

### Sanitisation Coverage Is Limited to Known Patterns
- **Area:** Input validation
- **Current state:** `src/utils/sanitize.ts` covers AWS keys, JWTs, PEM blocks, DB URIs, and generic `api_key=…` patterns. It does not cover GitHub PATs (`ghp_`), Slack tokens (`xoxb-`), Stripe keys (`sk_live_`), or Google API keys.
- **Risk level:** Medium
- **Notes:** False negative → sensitive data stored in Qdrant in cleartext. Expanding `SENSITIVE_PATTERNS` is low-effort, high-value.

### JWT Secret Derived from `ADMIN_TOKEN`
- **Area:** Authentication (JWT)
- **Current state:** `src/services/auth.ts` derives the JWT HMAC secret from `ADMIN_TOKEN` via HKDF. If `ADMIN_TOKEN` is weak (e.g., short or common), so is the JWT signing key.
- **Risk level:** Medium
- **Notes:** Document a minimum strength requirement for `ADMIN_TOKEN` (e.g., ≥ 32 random bytes). Consider generating a separate random `JWT_SECRET` at first startup and persisting it.

### CORS Wildcard on `/mcp` Endpoint
- **Area:** Network security
- **Current state:** `src/api/server.ts` (L210-222) sets `origin: "*"` for the `/mcp` Streamable HTTP endpoint.
- **Risk level:** Low-Medium
- **Notes:** The endpoint requires a Bearer API key, so CORS `origin: *` alone is not exploitable for data exfiltration. However, it weakens defence-in-depth by allowing any origin to make credentialed requests if a key leaks. Consider restricting to known admin panel origins.

## Performance

### Embedding Calls Are the Hot Path Bottleneck
- **Location:** `src/services/embedding-providers.ts` (Ollama: 120s timeout, 5 retries; Gemini: 30s, 3 retries)
- **Issue:** Every `memory_save` and `memory_search` triggers a synchronous embedding call. No request batching — each call embeds a single text.
- **Impact:** Under Ollama (local), latency is 200-600ms per embed. Under burst traffic, concurrent embed calls can saturate GPU/RAM. Queueing or micro-batching would amortise overhead.

### BM25 Encoding Is CPU-Bound in Hot Path
- **Location:** `src/services/bm25.ts` (L154-191)
- **Issue:** The BM25 encoder tokenises every save/search input with regex matching + FNV-1a hashing. For long documents (up to 50k chars), this is a measurable CPU task on the event loop.
- **Impact:** Blocks the Node.js event loop for a few ms per call — acceptable for moderate throughput, but becomes a concern at high concurrency.

### Analytics `importFromJsonl` Reads Entire File Into Memory
- **Location:** `src/services/analytics.ts` (L467-475)
- **Issue:** `readFile(auditLogPath, 'utf-8')` loads the full JSONL file (up to 50MB before rotation) into a single string. Although it uses `setImmediate` batching for parsing, the initial `readFile` allocates ~50MB of heap at once.
- **Impact:** Temporary memory spike during hourly aggregation. V8 GC pressure could cause latency spikes in HTTP handlers.

### Per-Key Rate Limiter Map Grows Unbounded
- **Location:** `src/utils/rate-limiter.ts` `perKeyTimestamps: Map<string, number[]>`
- **Issue:** Cleaned every 100 calls (`perKeyCleanupCounter`), but if many unique keys are issued, the Map can hold thousands of entries between cleanups.
- **Impact:** Memory growth proportional to distinct API key count × window size. Not critical for current scale, but should be bounded (e.g., LRU eviction).

## Code Smells

### Large Files Exceeding 800 LOC
- **Location:**
  - `src/services/analytics.ts` — 1,379 lines
  - `src/api/admin-routes.ts` — 1,137 lines
  - `src/services/api-key-manager.ts` — 1,119 lines
  - `src/api/server.ts` — 1,105 lines
  - `src/api/auth-routes.ts` — 897 lines
  - `src/mcp/server.ts` — 859 lines
  - `src/services/auth.ts` — 828 lines
- **Type:** Complexity / God file
- **Description:** Several service files exceed recommended 500-line thresholds. `analytics.ts` alone handles DB init, event ingestion, JSONL import, aggregation, rollup queries, hit-rate metrics, user/project summaries, error-rate metrics, and retention cleanup — at least 4 distinct responsibilities. `admin-routes.ts` registers 20+ route handlers inline.

### `as unknown as` Type Assertions
- **Location:** `src/services/analytics.ts` (L508), `src/api/server.ts` (L98)
- **Type:** Type safety bypass
- **Description:** Two uses of `as unknown as` to cast raw query results. These bypass TypeScript's type checking and could mask runtime errors if schemas change.

### Hono Context `c.set(...as never)` Pattern
- **Location:** `src/api/admin-auth.ts`, `src/api/middlewares.ts` (multiple call sites)
- **Type:** Type safety bypass
- **Description:** Uses `c.set("authUserId" as never, value as never)` to work around Hono's strict Env typing. This suppresses all type checking for these context variables.

### Duplicated Owner-Scope Filter Logic
- **Location:** `src/tools/search.ts` `buildOwnerScopeFilter()`, `src/tools/forget.ts` `getScopedPrefixes()` + `isOwnedByCaller()`, `src/api/memory-routes.ts` `buildOwnerFilter()`
- **Type:** Duplication
- **Description:** Owner-based data isolation filter construction is reimplemented in 3 places with slightly different signatures and logic. This is fragile — a change in ownership semantics must be applied in all 3 locations.
- **Suggested fix:** Extract a shared `buildOwnerFilter(userId, keyPrefixes)` utility into `src/utils/` or `src/services/`.

## Missing Coverage

| Area | Current State | Priority |
|------|--------------|----------|
| `src/api/user-key-routes.ts` (188 LOC) | **No dedicated test file** — zero direct coverage | High |
| `src/api/auth-routes.ts` (897 LOC) | Only covered indirectly via `auth-rbac-regression.test.ts` (29 lines setup) | High |
| `src/api/admin-routes.ts` (1137 LOC) | No dedicated test file — partially exercised by E2E tests | Medium |
| `src/services/memory-ownership.ts` remediation logic | Covered by `tests/services/memory-ownership.test.ts` (316 LOC) but audit-log parsing branch is mocked | Medium |
| `src/api/schemas.ts` (HTTP-specific Zod schemas) | No dedicated validation tests | Medium |
| `src/utils/ip.ts` edge cases: IPv6, X-Forwarded-For spoofing | `tests/utils/ip.test.ts` exists but may not stress-test chain parsing edge cases | Low |
| Web app (`web/src/`) | No test infrastructure detected | Low (separate app) |
| Integration: MCP ↔ HTTP shell parity | `tests/e2e-dual-engine.test.ts` covers dual engine but not HTTP REST ↔ MCP output equivalence | Medium |

## TODO/FIXME Items

| File | Line | Comment | Priority |
|------|------|---------|----------|
| — | — | No `TODO` / `FIXME` / `HACK` / `XXX` comments found in `src/` | — |

> The codebase is notably clean of TODO markers — all known issues have been addressed inline with `[FIX ...]` tags and resolved.

## Fragile Areas

### Save Pipeline Ordering
- **Files:** `src/tools/save.ts` (L160-370)
- **Why fragile:** The save pipeline has a strict ordering dependency: `normalize → injection check → sanitize → stripBoundaryMarkers → isFullyRedacted → hash → dedup → embed → upsert`. Reordering any step (e.g., hashing before sanitize) would break dedup or allow unsanitised data to be stored. The ordering is enforced only by sequential code flow — no pipeline abstraction.
- **Risk:** Maintenance changes to the pipeline may inadvertently reorder steps.

### Refresh Token Rotation State Machine
- **Files:** `src/services/auth.ts` (L580-700)
- **Why fragile:** The `rotateRefreshToken()` method implements a 4-case state machine (valid → rotate, revoked-within-grace → reissue, revoked-past-grace → revoke family, expired → cleanup). Cases 2 and 3 share subtle timing logic around `REFRESH_TOKEN_REUSE_GRACE_SECONDS`. A logic error here could either lock all users out (false positive family revocation) or allow token replay attacks (false negative).
- **Risk:** Regressions in auth refresh flow.

### Console Hijacking in MCP Mode
- **Files:** `src/mcp/server.ts` (L117-140)
- **Why fragile:** `hijackConsole()` globally replaces `console.log/info/warn/error` with stderr redirects. If any dependency writes to stdout before hijacking (or after teardown), MCP's JSON-RPC channel breaks. The hijack happens in `startMcpShell` — any code that runs before it (including `createContainer` logging) must already use `log.*` from `utils/logger.ts`.
- **Risk:** Accidental stdout pollution from new dependencies or misconfigured logging.

### Shared SQLite Database Between Services
- **Files:** `src/container.ts` (L302-315), `src/services/api-key-manager.ts`, `src/services/ban-manager.ts`, `src/services/auth.ts`
- **Why fragile:** `ApiKeyManager`, `BanManager`, and `AuthService` shares the same `better-sqlite3` Database instance (`adminDb`). SQLite serialises all writes — a long-running admin query (e.g., listing all keys with pagination) can block auth lookups. Also, schema migrations in one service can break prepared statements in another if the migration adds/renames columns.
- **Risk:** Write contention at scale; cross-service migration breakage.

## Dependency Concerns

| Package | Issue | Risk |
|---------|-------|------|
| `better-sqlite3` ^12.6.2 | Native addon — requires C++ toolchain for install; may break on Node.js major upgrades; no async I/O (blocks event loop on write) | Medium |
| `@modelcontextprotocol/sdk` ^1.27.1 | Rapidly evolving protocol — breaking changes between minor versions possible. Ties the project to MCP SDK release cadence | Medium |
| `zod` ^4.3.6 | Zod v4 is a major rewrite from v3 (import path change to `zod/v4`). Community middleware/plugins may not yet support v4 | Low |
| `@qdrant/js-client-rest` ^1.17.0 | Qdrant API evolves frequently; named vectors and sparse vectors are relatively new features. SDK updates may change query API signatures | Low |
| No `npm audit` / Dependabot config | No automated vulnerability scanning detected in repo configuration | Medium |

---

*Concerns audit: 2026-03-14*
