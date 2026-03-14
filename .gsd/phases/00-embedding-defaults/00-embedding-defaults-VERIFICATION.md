---
phase: 00-embedding-defaults
verified: 2026-03-14T04:18:22Z
status: human_needed
score: 5/5 must-haves verified
---

# Phase 00: Embedding Default Semantics Verification Report

**Phase Goal:** 将 easy-memory 的默认远端 embedding 语义调整为“官方 OpenAI 向量模型（经 OpenAI-compatible relay 接入）优先”，同时保留 Google Vertex AI 官方链路与本地 Ollama 兜底，并确保 1024 维/Qdrant/公开配置入口保持一致。
**Verified:** 2026-03-14T04:18:22Z
**Status:** human_needed

> 说明：仓库当前不存在正式的 `.gsd/ROADMAP.md`、`.gsd/REQUIREMENTS.md` 与 `.gsd/phases/*-PLAN.md` 体系，因此本报告基于本次用户需求与当前未提交改动集合做临时 phase 验证。

## Goal Achievement

### Observable Truths

| #   | Truth                                                                                                                                 | Status     | Evidence                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 当未显式设置 `EMBEDDING_PROVIDER` 且提供 relay API Key 时，系统会默认走官方 OpenAI 向量模型经 relay 接入，并使用 Ollama 作为 fallback | ✓ VERIFIED | `src/container.ts` 中 `resolveEmbeddingProviderMode()` 在检测到 `OPENAI_EMBEDDING_API_KEY` 时返回 `openai-auto`（lines 164, 172, 189）；`tests/container.test.ts` 新增推断用例并通过；完整测试 `931/931` 通过                                                                                                  |
| 2   | 当仅提供 Google 官方凭据时，系统仍能默认切换到 Vertex AI 官方链路                                                                     | ✓ VERIFIED | `src/container.ts` 中 `resolveEmbeddingProviderMode()` 在检测到 `GEMINI_API_KEY + GEMINI_PROJECT_ID` 时返回 `auto`（line 176）；`tests/container.test.ts` 的推断用例通过                                                                                                                                       |
| 3   | relay Provider 会始终请求 1024 维向量，并能把 host / `/v1` / `/v1/embeddings` 规范化到正确端点                                        | ✓ VERIFIED | `src/services/embedding-providers.ts` 在 OpenAI provider 请求体中固定 `dimensions: this.dimension`（lines 704, 713, 779, 789），`getEmbeddingsUrl()` 负责标准化 URL（lines 808-815）；`tests/services/embedding-providers.test.ts` 覆盖 host-only 与 full-endpoint 两类场景                                    |
| 4   | 向量写入与检索链路仍然保持 1024 维不变量，并默认避免跨模型语义空间污染                                                                | ✓ VERIFIED | `src/services/qdrant.ts` 维度默认值为 `1024`，创建 named vector `dense` 时使用 `this.embeddingDimension`（lines 61, 120-121）；`src/tools/save.ts` 持久化 `embedding_model`（line 321）；`src/tools/search.ts` 默认按 `normalizedQueryModel` 过滤并在 `cross_model=false` 时阻止混用（lines 138-151, 280-286） |
| 5   | 对外公开的配置出口已经把默认远端方案统一成“官方 OpenAI 模型经 relay 接入”                                                             | ✓ VERIFIED | `.env.example` 默认 `EMBEDDING_PROVIDER=openai-auto`（line 21）；`docker-compose*.yml` 默认透传 `openai-auto`（dev: line 28, prod: line 31）；`README.md` 明确默认远端方案与环境变量表（lines 92-107, 669-675）；`smithery-config-schema.json` 默认值已改为 `openai-auto`（line 26）                           |

**Score:** 5/5 truths verified

### Required Artifacts

| Artifact                                                                                   | Expected                                     | Status                         | Details                                                                                |
| ------------------------------------------------------------------------------------------ | -------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------- |
| `src/container.ts`                                                                         | Provider 默认推断 + 容器装配                 | ✓ EXISTS + SUBSTANTIVE + WIRED | 479 行；包含 `resolveEmbeddingProviderMode()`、OpenAI/Gemini/Ollama 三路装配，无占位符 |
| `src/services/embedding-providers.ts`                                                      | OpenAI-compatible relay Provider             | ✓ EXISTS + SUBSTANTIVE + WIRED | 817 行；Provider 使用 Bearer、`/v1/embeddings`、`dimensions: 1024`，并有 healthCheck   |
| `src/services/qdrant.ts`                                                                   | 1024 维 dense vector 不变量                  | ✓ EXISTS + SUBSTANTIVE + WIRED | 562 行；默认 1024d、创建 named vector `dense`、迁移检测与维度校验存在                  |
| `src/tools/save.ts`                                                                        | 真实模型名写入 payload                       | ✓ EXISTS + SUBSTANTIVE + WIRED | 392 行；`embedWithMeta()` 结果被标准化后写入 `embedding_model`                         |
| `src/tools/search.ts`                                                                      | same-model 默认过滤与跨模型警告              | ✓ EXISTS + SUBSTANTIVE + WIRED | 294 行；默认按 `embedding_model` 过滤，`cross_model=true` 才放开                       |
| `tests/container.test.ts`                                                                  | 默认值与模式推断测试                         | ✓ EXISTS + SUBSTANTIVE + WIRED | 296 行；覆盖 `openai-auto`、`auto`、显式 provider 与容器装配                           |
| `tests/services/embedding-providers.test.ts`                                               | relay Provider 请求/URL/429/healthCheck 测试 | ✓ EXISTS + SUBSTANTIVE + WIRED | 1234 行；覆盖 `/v1/embeddings` URL 规范化、`dimensions: 1024`、429 quota 处理          |
| `.env.example`                                                                             | 公开默认配置模板                             | ✓ EXISTS + SUBSTANTIVE + WIRED | 83 行；默认写成 `openai-auto` + relay base/model                                       |
| `docker-compose.yml` / `docker-compose.prod.yml`                                           | 部署默认值与 env 透传                        | ✓ EXISTS + SUBSTANTIVE + WIRED | 131/174 行；默认 provider 与 relay model 值已对齐                                      |
| `README.md` / `USER_GUIDE.md` / `smithery-config-schema.json` / `mcp-config-template.json` | 文档与机器可读配置一致                       | ✓ EXISTS + SUBSTANTIVE + WIRED | 文档、schema、模板均显式暴露官方 OpenAI via relay 方案，无占位说明残留                 |

**Artifacts:** 10/10 verified

### Key Link Verification

| From                                | To                        | Via                                         | Status  | Details                                                                                   |
| ----------------------------------- | ------------------------- | ------------------------------------------- | ------- | ----------------------------------------------------------------------------------------- |
| `.env.example` / Compose / schema   | `parseAppConfig()`        | `EMBEDDING_PROVIDER` + `OPENAI_EMBEDDING_*` | ✓ WIRED | 模板默认值与 `src/container.ts` 解析字段一致，Compose 和 schema 均透传相同 env 名         |
| `resolveEmbeddingProviderMode()`    | `createContainer()`       | `config.embeddingProvider`                  | ✓ WIRED | `src/container.ts` 先推断 provider，再在 `createContainer()` 中按模式实例化 provider 列表 |
| `OpenAICompatibleEmbeddingProvider` | relay embeddings endpoint | `getEmbeddingsUrl()` + Bearer POST          | ✓ WIRED | `src/services/embedding-providers.ts` 统一到 `/v1/embeddings` 并提交 `dimensions: 1024`   |
| `EmbeddingService.embedWithMeta()`  | `handleSave()`            | 返回 `model/provider` 元数据                | ✓ WIRED | `src/tools/save.ts` 把实际模型名标准化后写入 `payload.embedding_model`                    |
| `handleSearch()`                    | `Qdrant.hybridSearch()`   | `embedding_model` filter + cross_model gate | ✓ WIRED | `src/tools/search.ts` 默认过滤同模型，并对跨模型结果补充系统警告                          |

**Wiring:** 5/5 connections verified

## Requirements Coverage

未发现 `.gsd/REQUIREMENTS.md` 或正式 phase requirement 映射。当前验证改为覆盖用户明确提出的 4 个目标：

1. 默认仍以官网向量模型为语义基准
2. 内置远端接入走第三方 relay
3. 保留 Google 官方链路可选
4. 保持 1024 维与公开配置出口一致

上述目标均已由自动化检查与代码取证覆盖。

## Anti-Patterns Found

| File                                         | Line      | Pattern                                                                 | Severity   | Impact                                                               |
| -------------------------------------------- | --------- | ----------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------- |
| Targeted changed files                       | -         | 未发现 `TODO/FIXME/placeholder/coming soon/empty return` 等占位实现模式 | ℹ️ Info    | 目标文件的占位/桩代码扫描结果为 clean                                |
| `src/services/embedding.ts`                  | 142       | Cognitive Complexity 26（静态质量告警）                                 | ⚠️ Warning | 影响可维护性，不影响本次功能正确性；`pnpm typecheck/build/test` 全绿 |
| `src/services/embedding-providers.ts`        | 145       | Cognitive Complexity 19 与若干非阻塞类型风格告警                        | ⚠️ Warning | 影响代码整洁度，不阻断 provider 功能或测试结果                       |
| `tests/services/embedding-providers.test.ts` | 32 / 1194 | `Number.NaN` / 未使用变量风格告警                                       | ⚠️ Warning | 仅为测试代码风格问题，不影响测试通过                                 |

**Anti-patterns:** 4 found (0 blockers, 3 warnings, 1 info)

## Human Verification Required

### 1. 默认 relay 远端链路的真实账号验证

**Test:** 使用 `.env.example` 默认值填入真实 `OPENAI_EMBEDDING_API_KEY`，启动服务后执行一次真实 `save` 与 `search`。
**Expected:** 服务按 `openai-auto` 启动，save/search 成功，Qdrant 中写入 1024 维向量且 `embedding_model=text-embedding-3-small`。
**Why human:** 这是外部 relay 服务与真实账号凭据的集成验证，无法仅靠本地 mock 或静态检查完全替代。

### 2. Google Vertex AI 兼容链路的手动切换验证

**Test:** 将 `.env` 切换为 `EMBEDDING_PROVIDER=auto` 或 `gemini`，配置真实 `GEMINI_API_KEY` 与 `GEMINI_PROJECT_ID` 后启动并执行一次向量化。
**Expected:** 服务成功切到 Vertex AI 官方链路，仍返回 1024 维向量；若凭据缺失应在启动阶段 fast-fail。
**Why human:** 需要真实 Google Cloud 权限、配额与网络环境，无法从当前本地自动化完全证明。

## Gaps Summary

### Critical Gaps (Block Progress)

**无。**

自动化验证没有发现阻断本次功能目标的缺失、占位实现或接线断裂。

### Non-Critical Gaps (Can Defer)

1. **若干静态质量告警仍存在**
   - Issue: `embedding.ts` / `embedding-providers.ts` 存在复杂度与风格告警，测试文件也有少量风格告警。
   - Impact: 不影响运行与回归结果，但会增加后续维护噪音。
   - Recommendation: 后续可单独做一次无行为变更的质量清理。

2. **真实外部服务集成尚需人工验收**
   - Issue: 默认 relay 与 Gemini Vertex 两条远端链路都依赖真实凭据与外部网络。
   - Impact: 代码与 mock 测试已证明结构正确，但生产级账号路径仍需最后一跳确认。
   - Recommendation: 用真实 `.env` 做一次手动 save/search 烟测即可闭环。

## Verification Metadata

**Verification approach:** Goal-backward（基于用户本次“embedding 默认语义调整”需求推导 must-haves）
**Must-haves source:** 用户需求 + 当前未提交改动集合（仓库未提供正式 ROADMAP/PLAN/REQUIREMENTS）
**Automated checks:** `pnpm typecheck` ✅、`pnpm build` ✅、`pnpm test tests/container.test.ts` ✅、`pnpm test` ✅（38 files / 931 tests）、JSON 解析校验 ✅
**Human checks required:** 2
**Automated runtime observed in session:** 全量 `pnpm test` 28.81s；定向 `tests/container.test.ts` 334ms（不含文件审查时间）

---

_Verified: 2026-03-14T04:18:22Z_
_Verifier: Copilot (gsd-verifier, ad-hoc phase)_
