---
status: investigating
trigger: >-
  请对 easy-memory 当前远端 VPS relay 故障做只读根因复核，不要修改代码。任务：1) 检查仓库当前
  embedding provider 实现和配置解析，确认代码是否支持 openai/openai-auto + 1024 维 relay；2) 基于以下已知
  证据判断故障归因：本地使用同一 relay key 跑 HTTP E2E 97 passed / 0 failed；远端已升级为新镜像
  easy-memory:relay-20260314，/opt/easy-memory/.env 为 EMBEDDING_PROVIDER=openai-auto，
  OPENAI_EMBEDDING_BASE_URL=https://api.vectorengine.ai/v1，OPENAI_EMBEDDING_MODEL=text-embedding-3-small，
  Gemini key 已移除；远端容器日志报 OpenAI-compatible embedding failed: 401 Unauthorized；直接从 VPS
  主机调用 relay /v1/embeddings 返回 HTTP 429，正文为 invalid tokens multiple times, wait 120 seconds；本地 key 与远端
  .env / 容器 env 完全一致，长度均为 56；远端公网 E2E 大部分通过，但 /api/status embedding=reconnecting，首个 save
  响应 64s 超过 30s。3) 输出：A. 根因归属（代码/配置/密钥注入/供应商/IP/其他）按置信度排序；B. 是否建议把远端临时切到
  ollama 以恢复性能；C. 若不切，当前线上风险是什么；D. 最小后续验证步骤。请给出简洁但明确的结论。
created: 2026-03-14T14:21:30+08:00
updated: 2026-03-14T14:44:00+08:00
---

## Current Focus

hypothesis: 新 token 已在本地与 VPS 主机两侧通过供应商鉴权，因此当前问题既不是“token 天生无效”，也不是“VPS 出口 IP 被该 token 普遍封禁”；更可能是旧 token / 旧冷却窗口导致的历史故障。
test: 汇总本轮 local / VPS 对照结果，判断是否还需要容器内补测；若主机级别已双侧成功，则直接输出结论与最小下一步建议。
expecting: 本轮应得出“新 token 可用，VPS 主机不受限”的明确结论，冷却复测不应触发。
next_action: 形成最终诊断报告，并说明为何本轮无需额外修改配置或重启服务。

## Symptoms

expected: 远端 VPS 在 openai-auto relay 配置下应与本地一样稳定完成 embedding，请求时延应在健康阈值内，/api/status 的 embedding 不应长期为 reconnecting。
actual: 远端公网 E2E 大部分通过，但 /api/status 显示 embedding=reconnecting，首个 save 请求约 64 秒，超过 30 秒门限。
errors: 远端容器日志出现 OpenAI-compatible embedding failed: 401 Unauthorized；直接从 VPS 主机调用 relay /v1/embeddings 返回 HTTP 429，正文含 invalid tokens multiple times, wait 120 seconds。
reproduction: 在远端 VPS 上使用 easy-memory:relay-20260314 镜像，配置 EMBEDDING_PROVIDER=openai-auto、OPENAI_EMBEDDING_BASE_URL=https://api.vectorengine.ai/v1、OPENAI_EMBEDDING_MODEL=text-embedding-3-small，Gemini key 已移除后进行公网 E2E 与直接 relay 探测。
started: 已知发生于远端升级到 easy-memory:relay-20260314 并切换 openai-auto relay 配置后；本地同 key 同配置 E2E 97 passed / 0 failed。

## Eliminated

- hypothesis: 仓库当前代码不支持 `openai` / `openai-auto` 或不支持 1024 维 relay
  evidence: `src/container.ts` 定义并解析 `openai` / `openai-auto`，`createContainer()` 在 `openai-auto` 模式下装配 `[openai, ollama]`；`src/services/embedding-providers.ts` 的 `OpenAICompatibleEmbeddingProvider` 固定发送 `dimensions: 1024`，并规范化到 `/v1/embeddings`；对应测试 `tests/container.test.ts` 与 `tests/services/embedding-providers.test.ts` 覆盖该链路。
  timestamp: 2026-03-14T14:39:00+08:00

- hypothesis: 当前远端问题由 `.env` / 容器 env 注入错误、key 截断或配置未生效导致
  evidence: 远端运行时摘要显示镜像为 `easy-memory:relay-20260314`，容器启动日志打印 `embeddingProvider":"openai-auto"`、`openaiEmbeddingBaseUrl":"https://api.vectorengine.ai/v1"`、`openaiEmbeddingModel":"text-embedding-3-small"`；`/tmp/easy_memory_remote_key_lengths_simple.out` 与 `/tmp/easy_memory_remote_key_equality.out` 证明本地 key、远端 `.env`、容器 env 长度同为 56 且内容一致。
  timestamp: 2026-03-14T14:39:00+08:00

- hypothesis: 用户刚提供的新 token 本身不可用/无效
  evidence: 本轮只读对照测试中，本地对 `https://api.vectorengine.ai/v1/embeddings` 的首次 authenticated POST 返回 `HTTP 200`，耗时约 `1073.88ms`，并收到合法 embedding 响应体前缀。
  timestamp: 2026-03-14T15:16:00+08:00

- hypothesis: 用户刚提供的新 token 可用，但 VPS 主机出口 IP 被供应商限制
  evidence: 同一轮、同一 token、同一请求体在 VPS 主机侧首次 authenticated POST 同样返回 `HTTP 200`，耗时约 `490.29ms`，返回体前缀与本地一致，且未触发 `429 invalid token / wait 120 seconds` 冷却条件。
  timestamp: 2026-03-14T15:16:00+08:00

## Evidence

- timestamp: 2026-03-14T14:21:30+08:00
  checked: 用户提供的本地 HTTP E2E 结果
  found: 同一 relay key 在本地 HTTP E2E 中 97 passed / 0 failed。
  implication: key 本身至少在某些来源 IP/环境下可用，不能直接归因为仓库代码普遍不支持该 relay。

- timestamp: 2026-03-14T14:21:30+08:00
  checked: 用户提供的远端运行配置
  found: 远端镜像已升级到 easy-memory:relay-20260314，.env 设置为 EMBEDDING_PROVIDER=openai-auto、OPENAI_EMBEDDING_BASE_URL=https://api.vectorengine.ai/v1、OPENAI_EMBEDDING_MODEL=text-embedding-3-small，Gemini key 已移除。
  implication: 当前远端运行路径已指向 openai-compatible relay，而非 Gemini 回退路径。

- timestamp: 2026-03-14T14:21:30+08:00
  checked: 用户提供的远端错误特征
  found: 容器日志报 401 Unauthorized，但从 VPS 主机直接调用 relay 接口返回 429 invalid tokens multiple times, wait 120 seconds。
  implication: 供应商侧可能存在风控/限流或错误归一化行为，应用内 401 需结合代码的错误包装逻辑再判断。

- timestamp: 2026-03-14T14:21:30+08:00
  checked: 用户提供的密钥一致性结论
  found: 本地 key 与远端 .env / 容器 env 完全一致，长度均为 56。
  implication: 简单的密钥截断、注入丢失或容器未读取新 env 的概率下降。

- timestamp: 2026-03-14T14:21:30+08:00
  checked: 用户提供的远端症状
  found: 远端公网 E2E 大部分通过，但 embedding 状态为 reconnecting，首个 save 请求 64 秒超时阈值。
  implication: 当前故障更像 embedding provider 间歇性不可用/重试退避，而不是 API 全面不可用。

- timestamp: 2026-03-14T14:39:00+08:00
  checked: `src/container.ts`
  found: `EmbeddingProviderMode` 明确包含 `openai` 与 `openai-auto`；`parseAppConfig()` 在有 `OPENAI_EMBEDDING_API_KEY` 时默认推断为 `openai-auto`，默认 `OPENAI_EMBEDDING_BASE_URL=https://api.vectorengine.ai/v1`，默认 `OPENAI_EMBEDDING_MODEL=text-embedding-3-small`；`createContainer()` 在 `openai-auto` 模式下按顺序装配 `OpenAICompatibleEmbeddingProvider` 和 `OllamaEmbeddingProvider`。
  implication: 当前仓库代码路径原生支持远端 relay 作为主 provider，并在失败时自动回退到 Ollama。

- timestamp: 2026-03-14T14:39:00+08:00
  checked: `src/services/embedding-providers.ts`
  found: `OpenAICompatibleEmbeddingProvider` 固定 `dimension = 1024`，请求体恒为 `{ model, input, dimensions: 1024, encoding_format: "float" }`，并自动把 host/baseUrl 规范化为 `/v1/embeddings`；非 429 的 4xx 会被视为 `NonRetryableError` 直接终止当前 provider 重试。
  implication: relay 调用的协议、路径与 1024 维约束在代码层是明确且严格的；401 不会在 openai provider 内部消耗多次重试。

- timestamp: 2026-03-14T14:39:00+08:00
  checked: `tests/container.test.ts` 与 `tests/services/embedding-providers.test.ts`
  found: 测试覆盖了 `OPENAI_EMBEDDING_API_KEY -> openai-auto` 推断、`openai-auto` 容器装配、`OpenAICompatibleEmbeddingProvider` 对 `https://proxy.example.com -> /v1/embeddings` 的 URL 规范化，以及请求体包含 `dimensions: 1024`。
  implication: openai-compatible relay 支持不是“文档写了”，而是已有单元测试约束。

- timestamp: 2026-03-14T14:39:00+08:00
  checked: `src/tools/status.ts` 与 `src/services/embedding.ts`
  found: `/api/status` 中 `embedding=reconnecting` 的直接条件是 `EmbeddingService.healthCheck()` 返回 false；而 `EmbeddingService.healthCheck()` 只要任一可用 provider 健康就会返回 true。
  implication: 远端出现 `reconnecting` 说明当时不只是 OpenAI 主 provider 失败，连 fallback 路径也未通过健康检查。

- timestamp: 2026-03-14T14:39:00+08:00
  checked: `src/services/embedding-providers.ts` 的 `OllamaEmbeddingProvider.healthCheck()`
  found: Ollama 健康检查先访问 `/api/tags`，再用 3 秒 timeout 执行 `/api/embeddings` probe；而真实 embed 超时默认是 120 秒。
  implication: 若 Ollama 模型刚加载或首推理较慢，状态探针会先报 unavailable/reconnecting，但实际 save 仍可能在几十秒后通过 fallback 成功。

- timestamp: 2026-03-14T14:39:00+08:00
  checked: `/tmp/easy_memory_remote_container_logs_after_switch.out`
  found: 远端容器启动时明确记录 `embeddingProvider=openai-auto`；状态检查期间日志出现 `Ollama dimension probe failed, treating provider as unavailable`；首个 save 前后出现 `openai non-retryable error, aborting retry` 与 `Provider openai failed ... willFallback=true`。
  implication: 远端现场符合“OpenAI 主链路被快速拒绝 -> 自动回退 Ollama，但 Ollama 当时健康探针未通过”的行为模型。

- timestamp: 2026-03-14T14:39:00+08:00
  checked: `/tmp/easy_memory_remote_relay_probe.out` 与 `/tmp/easy_memory_remote_relay_probe_after_cooldown.out`
  found: 从 VPS 主机直接调用 relay `/v1/embeddings` 两次都返回 `HTTP=429`，正文为 `You have used invalid tokens multiple times, please wait: 120 seconds before trying again`。
  implication: 在脱离 easy-memory 应用代码、直接复现 OpenAI-compatible 请求体的情况下，VPS 来源仍被 relay 拒绝，主故障更像供应商/风控/IP 侧问题，而非应用业务逻辑。

- timestamp: 2026-03-14T14:39:00+08:00
  checked: `/tmp/easy_memory_remote_postswitch_e2e.out`
  found: 远端公网 E2E 最终 `95 passed / 2 failed`，失败项仅为 `Embedding = ready: got reconnecting` 与 `Save 响应时间 < 30s (64374ms)`；后续搜索、RRF、去重、软删除等链路全部通过。
  implication: 远端系统并未全面失效，问题高度集中在 embedding 主 provider 不稳定与 fallback 首次延迟，而不是整体代码回归。

- timestamp: 2026-03-14T14:39:00+08:00
  checked: `/tmp/easy_memory_remote_runtime_summary.out`、`/tmp/easy_memory_remote_postprepare_summary.out`、`/tmp/easy_memory_remote_key_lengths_simple.out`、`/tmp/easy_memory_remote_key_equality.out`
  found: 当前远端镜像与运行时 env 均为 `openai-auto + https://api.vectorengine.ai/v1 + text-embedding-3-small`，Gemini 凭据缺失符合预期；本地 key、远端 `.env`、容器 env 内容一致且长度均为 56。
  implication: 配置漂移、key 长度不一致、容器未加载新 env 的可能性已显著降低。

- timestamp: 2026-03-14T14:41:30+08:00
  checked: `/tmp/easy_memory_local_relay_e2e.out`
  found: 本地使用同一 relay key、同一 `openai-auto + https://api.vectorengine.ai/v1 + text-embedding-3-small` 链路跑完整 HTTP E2E，结果为 `97 passed / 0 failed`，其中 `/api/status` 为 `embedding=ready`，首个 `save` 仅 `947ms`。
  implication: 代码、请求体与 relay 协议在本地环境下可稳定工作，远端异常更像来源环境差异（IP/风控/网络）而非实现缺陷。

- timestamp: 2026-03-14T14:44:00+08:00
  checked: `src/tools/save.ts`
  found: `handleSave()` 调用 `deps.embedding.embedWithMeta()`；若所有 provider 均失败，则返回 `status: "pending_embedding"`，并明确 `Memory not saved`。
  implication: 当前线上风险不仅是“慢”，若 relay 持续被拒且 Ollama fallback 也不可用/超时，将直接出现写入失败而非后台补写。

- timestamp: 2026-03-14T15:16:00+08:00
  checked: `/tmp/easy_memory_compare_summary.txt`
  found: 使用用户刚提供的新 token 做 host 级同构 authenticated POST 时，本地 `HTTP 200 / 1073.88ms`，VPS 主机 `HTTP 200 / 490.29ms`，两侧都直接返回合法 embedding 数据前缀；未命中 `429 invalid token` 或 `wait 120 seconds`，因此冷却后二次复测未触发。
  implication: 对于“新 token + 当前 VPS 主机出口”这一组合，供应商侧鉴权与网络路径均正常；本轮证据不支持 token 无效或 VPS IP 被该 token 限制。

## Resolution

root_cause: 对“用户刚提供的新 token”而言，未复现 token 无效或 VPS 主机出口 IP 受限；当前只读对照结果显示它在本地与 VPS 主机均可直接通过第三方 relay 的 embeddings 鉴权。若此前线上仍有 relay 故障，更可能属于旧 token、旧冷却窗口，或容器/应用层使用的并非本轮测试 token。
fix:
verification: 使用固定 URL、固定模型/维度/编码格式、固定请求体，在本地与 VPS 主机分别完成一次同构 authenticated POST；两侧首次请求均返回 `HTTP 200`，且无冷却重试。
files_changed: []
