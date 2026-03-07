# easy-memory Copilot Instructions

## Scope

- Treat this repository as a dual-shell service: `src/mcp/*` and `src/api/*` are adapters over shared core logic in `src/services/*`, `src/tools/*`, and the DI container in `src/container.ts`.
- Keep shell adapters thin. Do not instantiate core services outside `createContainer()`.

## Memory backend priority

- Use easy-memory MCP tools as the default memory system for project conventions, user preferences, and durable decisions.
- Prefer the discoverable alias names `easy_memory_search`, `easy_memory_save`, `easy_memory_forget`, and `easy_memory_status` when they are available; keep `memory_search`, `memory_save`, `memory_forget`, and `memory_status` as compatibility names.
- Before recommending architecture, libraries, workflows, or generating substantial code, search easy-memory for prior decisions when relevant.
- When the user says to remember something, save it to easy-memory first.
- Use built-in `/memories` or other memory systems only when easy-memory is unavailable, errors, or the user explicitly asks for another backend.
- Do not silently dual-write to multiple memory backends. If fallback is necessary, state the reason in the reply.
- When correcting an outdated remembered fact, save the replacement first, then archive or forget the outdated entry.

## Runtime and security invariants

- Never use `console.log` or write logs to stdout; MCP stdio must stay clean. Use `src/utils/logger.ts` and `safeLog`.
- Read secrets only from the repository-root `secrets.json`. Never hardcode secrets or print secret values.
- Preserve the save pipeline order: sanitize → normalize/hash → dedupe → embed → upsert.
- Preserve the search output guards: retrieved memory content must remain wrapped in `[MEMORY_CONTENT_START]` / `[MEMORY_CONTENT_END]` and include `system_note`.
- Keep scope, owner, device, branch, and lifecycle filtering intact when changing save/search/forget behavior.
- Qdrant usage is not optional: initialize with API key, keep named vectors (`dense`, `bm25`), and preserve `wait: true` on upserts.

## Modes and persistence

- `src/index.ts` chooses between local shells and remote proxy mode; `EASY_MEMORY_TOKEN` plus `EASY_MEMORY_URL` enables the remote MCP proxy.
- Persistent local files live under `DATA_DIR` via `src/utils/paths.ts`.
- HTTP binds to `127.0.0.1` by default; keep proxy/TLS protections intact when editing server startup.

## Workflow

- Use `pnpm` commands: `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm test:e2e` for validation.
- E2E flows expect local Qdrant and Ollama/Docker services to be running.
- Prefer small targeted changes with Vitest coverage near touched code.
- When touching API or MCP handlers, verify both shells still expose the same core behavior.
- If instructions in prompts or older docs conflict with current code, prefer this file, `README.md`, `CORE_SCHEMA.md`, and the actual implementation.
