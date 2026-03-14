# Technology Stack

**Analysis Date:** 2026-03-14

## Languages

**Primary:**

- TypeScript 5.9.x — All backend source (`src/**/*.ts`) and web frontend (`web/src/**/*.tsx`)

**Secondary:**

- SQL (inline DDL) — SQLite table definitions in `src/services/analytics.ts`, `src/services/api-key-manager.ts`, `src/services/ban-manager.ts`

## Runtime

**Environment:**

- Node.js ≥ 20 (enforced via `engines` in `package.json`; Docker uses `node:20-alpine`)

**Package Manager:**

- pnpm (corepack-enabled in Docker; `pnpm-lock.yaml` present)
- Lockfile: present (`pnpm-lock.yaml`)
- Workspace: monorepo via `pnpm-workspace.yaml` — packages: root + `web/`

**Module System:**

- ESM (`"type": "module"` in `package.json`)
- TypeScript: `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`, target `ES2022`

## Frameworks

**Core Backend:**

- Hono 4.12.x — HTTP REST API server (`src/api/server.ts`)
- `@hono/node-server` 1.19.x — Node.js HTTP adapter for Hono
- `@modelcontextprotocol/sdk` 1.27.x — MCP stdio/streamable-HTTP protocol (`src/mcp/server.ts`, `src/mcp/remote-server.ts`)

**Web Frontend:**

- React 19.1.x — Admin web UI (`web/src/`)
- React Router DOM 7.6.x — Client-side routing
- Recharts 3.7.x — Analytics charts
- i18next 25.x + react-i18next 16.x — Internationalization
- Lucide React 0.511.x — Icons
- Tailwind CSS 4.1.x — Utility-first styling (via `@tailwindcss/vite` plugin)
- Vite 6.3.x — Build tooling + Dev server

**Testing:**

- Vitest 4.0.x — Unit + E2E test runner
- Coverage: V8 provider

**Build/Dev:**

- TypeScript 5.9.x (`tsc`) — Backend compilation
- Vite 6.3.x — Frontend build (`web/vite.config.ts`)

## Dependencies (Production)

| Package                     | Version | Purpose                                           |
| --------------------------- | ------- | ------------------------------------------------- |
| `hono`                      | ^4.12.3 | HTTP framework (lightweight, Express-like)        |
| `@hono/node-server`         | ^1.19.9 | Node.js HTTP adapter for Hono                     |
| `@modelcontextprotocol/sdk` | ^1.27.1 | MCP protocol (stdio + streamable HTTP transport)  |
| `@qdrant/js-client-rest`    | ^1.17.0 | Qdrant vector database REST client                |
| `better-sqlite3`            | ^12.6.2 | SQLite3 driver (analytics, API keys, bans, users) |
| `zod`                       | ^4.3.6  | Schema validation (v4 with `/v4` import)          |

## Dependencies (Development)

| Package                 | Version | Purpose                             |
| ----------------------- | ------- | ----------------------------------- |
| `typescript`            | ^5.9.3  | TypeScript compiler                 |
| `vitest`                | ^4.0.18 | Test runner (unit + E2E)            |
| `@types/better-sqlite3` | ^7.6.13 | Type definitions for better-sqlite3 |
| `@types/node`           | ^25.3.3 | Node.js type definitions            |

## Web Frontend Dependencies

| Package                | Version  | Purpose                            |
| ---------------------- | -------- | ---------------------------------- |
| `react`                | ^19.1.0  | UI library                         |
| `react-dom`            | ^19.1.0  | React DOM renderer                 |
| `react-router-dom`     | ^7.6.2   | Client-side routing                |
| `recharts`             | ^3.7.0   | Charts and analytics visualization |
| `i18next`              | ^25.8.18 | Internationalization framework     |
| `react-i18next`        | ^16.5.8  | React bindings for i18next         |
| `lucide-react`         | ^0.511.0 | Icon library                       |
| `tailwindcss`          | ^4.1.8   | CSS framework                      |
| `@tailwindcss/vite`    | ^4.1.8   | Tailwind CSS Vite plugin           |
| `@vitejs/plugin-react` | ^4.6.0   | React Vite plugin                  |
| `vite`                 | ^6.3.5   | Frontend bundler                   |

## Build & Tooling

**Build:**

- Backend: `tsc` → `dist/` (declaration + sourcemaps enabled)
- Frontend: `vite build` → `dist/web/` (served as static files from backend)
- Combined: `pnpm build:all` runs both sequentially

**Test:**

- Unit: `vitest run` — `tests/**/*.test.ts` (excludes `tests/e2e/**`), 10s timeout
- E2E: `vitest run --config vitest.e2e.config.ts` — `tests/e2e.test.ts`, 60s timeout
- E2E Dual: `vitest run --config vitest.e2e-dual.config.ts` — dual-engine tests, 180s timeout
- Watch: `vitest` (default watch mode)
- Coverage: V8 provider, scope `src/**/*.ts`

**Linting:**

- TypeScript strict mode with: `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `exactOptionalPropertyTypes`, `isolatedModules`
- No ESLint/Prettier config detected (TypeScript strict compiler flags serve as primary quality gate)

**Package Manager:**

- pnpm (monorepo with `pnpm-workspace.yaml`)
- `pnpm.onlyBuiltDependencies`: `esbuild`, `better-sqlite3`

## Scripts

| Script          | Command                                         | Purpose                     |
| --------------- | ----------------------------------------------- | --------------------------- |
| `build`         | `tsc`                                           | Compile backend TypeScript  |
| `build:web`     | `cd web && pnpm install && pnpm build`          | Build web frontend          |
| `build:all`     | `pnpm build && pnpm build:web`                  | Full build                  |
| `dev`           | `tsc --watch`                                   | Backend watch mode          |
| `dev:web`       | `cd web && pnpm dev`                            | Frontend dev server         |
| `test`          | `vitest run`                                    | Run unit tests              |
| `test:watch`    | `vitest`                                        | Run tests in watch mode     |
| `test:e2e`      | `vitest run --config vitest.e2e.config.ts`      | Run E2E tests               |
| `test:e2e:dual` | `vitest run --config vitest.e2e-dual.config.ts` | Run dual-engine E2E         |
| `typecheck`     | `tsc --noEmit`                                  | Type-check without emitting |
| `verify:local`  | `pnpm typecheck && pnpm test`                   | Pre-commit validation       |
| `start`         | `node dist/index.js`                            | Start production server     |

## Infrastructure

**Containerization:**

- Multi-stage Dockerfile: `node:20-alpine` (builder + runtime)
- Non-root user `easymem` (UID 1001)
- Health check: `wget --spider http://127.0.0.1:3080/health`
- Published image: `thj8632/easy-memory:latest`

**Docker Compose (Development):**

- 3 services: `easy-memory` + `qdrant` + `ollama` (with `ollama-init` for model auto-pull)
- Qdrant: `qdrant/qdrant:latest` — ports 6333 (REST) + 6334 (gRPC)
- Ollama: `ollama/ollama:latest` — port 11434, auto-pulls `bge-m3` model
- Volumes: `qdrant_data`, `ollama_data`, `easy_memory_data`

**Docker Compose (Production):**

- Pre-built image (`thj8632/easy-memory:latest`)
- Qdrant/Ollama ports not exposed (internal network only)
- Bind to `127.0.0.1:3080` (reverse proxy required)
- Resource limits: 512MB RAM, 1.0 CPU
- Log limits: 10MB, 3 files
- `TRUST_PROXY=true`, `REQUIRE_TLS=true`

**Database:**

- Qdrant — Vector database (REST + gRPC), API key authentication
- SQLite (better-sqlite3) — Local persistence for analytics, API keys, bans, users, refresh tokens

**Persistent Data:**

- `DATA_DIR` env → Docker `/data` volume
- Files: `.easy-memory-admin.db`, `.easy-memory-analytics.db`, `.easy-memory-audit.jsonl`, `.easy-memory-runtime-config.json`

## Configuration Files

| File                        | Purpose                                     |
| --------------------------- | ------------------------------------------- |
| `package.json`              | Root package manifest (backend)             |
| `web/package.json`          | Web frontend package manifest               |
| `pnpm-workspace.yaml`       | Monorepo workspace declaration              |
| `tsconfig.json`             | TypeScript compiler options (backend)       |
| `vitest.config.ts`          | Unit test configuration                     |
| `vitest.e2e.config.ts`      | E2E test configuration                      |
| `vitest.e2e-dual.config.ts` | Dual-engine E2E test configuration          |
| `web/vite.config.ts`        | Vite config (React + Tailwind)              |
| `Dockerfile`                | Multi-stage container build                 |
| `docker-compose.yml`        | Development compose (app + Qdrant + Ollama) |
| `docker-compose.prod.yml`   | Production compose                          |
| `.env.example`              | Environment variable template               |

## Platform Requirements

**Development:**

- Node.js ≥ 20
- pnpm
- Qdrant instance (local Docker or remote)
- Ollama instance (local Docker or remote) — for local embedding
- Optional: Gemini API access for cloud embedding

**Production:**

- Docker + Docker Compose
- Reverse proxy (Caddy/Nginx) for TLS termination
- Qdrant + Ollama containers (or remote services)

---

_Stack analysis: 2026-03-14_
