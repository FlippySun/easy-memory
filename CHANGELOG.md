# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2025-07-03

### Fixed

- **[FIX H-5] Gemini healthCheck Vertex AI 兼容**: 修复 Vertex AI 不支持 GET model info 端点（返回 404）的问题。改用轻量 POST predict 调用（输入 `"ok"`，约 1 token），验证端到端连通性。

### Changed

- npm publish CI/CD 修复：移除 npm 2FA 限制以支持自动化发布。

## [0.2.0] - 2025-07-02

### ⚠ BREAKING CHANGES

- **Vertex AI Migration**: Gemini embedding provider 从 Google AI Studio 迁移至 **Google Cloud Vertex AI**。
  - 新增 **必需** 环境变量 `GEMINI_PROJECT_ID`（当 `EMBEDDING_PROVIDER` 为 `auto` 或 `gemini` 时）。
  - 新增可选环境变量 `GEMINI_REGION`（默认 `us-central1`）。
  - API endpoint 变更为 `{region}-aiplatform.googleapis.com/v1/projects/{project}/locations/{region}/publishers/google/models/{model}:predict`。
  - 认证方式: `x-goog-api-key` header（需要 GCP 项目级 API Key）。

### Added

- **[FIX H-1] NonRetryableError 分类**: 新增 `NonRetryableError` 类，HTTP 401/403/400/404 等永久性错误立即失败不重试。
- **[FIX H-2] 429 RESOURCE_EXHAUSTED 检测**: 区分临时限流（可重试）与配额耗尽（不可重试），配额耗尽时立即触发熔断器。
- **[FIX C-1] 熔断器 mid-retry 中止**: 重试循环中每次尝试前检查 `isCircuitOpen` 回调，防止并发雷暴期间浪费 API 调用。
- **[FIX F-2] Sleep 后二次熔断器检查**: 在指数退避 sleep 完成后再次检查熔断器状态，防止 sleep 间隙放过额外请求。
- **[FIX C-2] 跨模型向量过滤**: `memory_search` 新增 `cross_model` 参数（默认 `false`），仅返回与当前 embedding 模型匹配的向量，避免余弦距离无意义比较。向后兼容 `is_empty` 和 `"unknown"` 旧记录。
- **[FIX M-1] 重试 Jitter**: 指数退避延迟添加 ±20% 随机抖动，防止并发请求形成同步脉冲（Thundering Herd）。
- **[FIX M-3] HTTP/1.1 连接泄漏防护**: 错误响应体主动消费 (`response.text()`)，避免底层 socket 泄漏。
- **[FIX L-2] 模型名称归一化**: `save` 操作对 embedding model 名执行 `.toLowerCase()`，确保大小写不敏感匹配。
- **失败熔断器** (`rate-limiter.ts`): 新增 `recordGeminiFailure()` 计数器，连续 3 次失败触发 60 秒冷却期，自动恢复。
- **onFailure 回调** (`embedding.ts`): `EmbeddingService` 新增 `onFailure` 配置项，embed 失败时通知上层（用于触发失败熔断器）。
- **可取消 Sleep** (`embedding-providers.ts`): 重试 Sleep 注册到 `_pendingSleepRejects`，`close()` 调用时立即中断（不再等待 sleep 自然到期）。
- **Shutdown 前置守卫**: 重试循环和 `safeFetch` 均检查 `_closedByShutdown` 标志，防止 close 后泄漏请求。

### Fixed

- **[FIX F-1] GeminiProvider isCircuitOpen 转发**: 修复 `GeminiEmbeddingProvider` 构造函数未将 `isCircuitOpen` 回调转发到基类的严重 bug，该 bug 导致 Gemini（唯一需要熔断器的 Provider）的 mid-retry 熔断完全无效。
- **[FIX F-3] Ollama probe AbortController 注册**: 修复 healthCheck 中 dimension probe 的 `AbortController` 未加入 `_activeControllers`，可能导致 `close()` 后 probe 阻塞关闭最多 3 秒。
- **[FIX H-3] dailyReset 保护进行中的失败**: `resetDaily()` 在连续失败计数 > 0 时不重置失败熔断器，防止定时 reset 误清正在生效的熔断保护。
- **[FIX H-4] healthCheck 安全**: Gemini healthCheck 的 catch 块静默返回 `false`，防止 API Key/ProjectID 通过错误堆栈泄露到日志。

### Changed

- **Vertex AI 请求格式**: `{ instances: [{ content }], parameters: { outputDimensionality } }` → `{ predictions: [{ embeddings: { values } }] }`。
- **Gemini 默认超时**: 30s（远端网络），默认 3 次重试（对比 Ollama 120s/5 次）。
- **Docker Compose**: `docker-compose.yml` 和 `docker-compose.prod.yml` 新增 `GEMINI_PROJECT_ID` 和 `GEMINI_REGION` 环境变量透传。
- **`.env.example`**: 更新 Gemini 配置说明为 Vertex AI 格式。

### Tests

- 新增 447 条测试（原 444 + 3 新增审计修复测试），覆盖:
  - NonRetryableError 分类（401/403/400/404/408/5xx）
  - 429 RESOURCE_EXHAUSTED 检测
  - 熔断器 mid-retry 中止（Ollama + Gemini）
  - GeminiProvider isCircuitOpen 转发验证
  - Post-sleep 二次熔断器检查
  - 重试 Jitter ±20% 验证
  - `recordGeminiFailure` 连续失败与冷却恢复
  - `resetDaily` 保护进行中失败
  - 跨模型向量过滤
  - Save 模型名称归一化
  - onFailure 回调异常安全

## [0.1.0] - 2025-06-28

### Added

- 初始发布
- MCP 工具: `memory_save`, `memory_search`, `memory_forget`, `memory_status`
- 双引擎 embedding: Ollama (bge-m3) + Gemini (Google AI Studio) with auto-fallback
- Qdrant 向量数据库持久化存储
- HTTP API 模式 (Express)
- SafeStdioTransport (背压处理)
- 优雅关闭 (SIGTERM/stdin close + watchdog)
- 敏感信息脱敏 (AWS Key, JWT, PEM, DB URI)
- SHA-256 内容去重
- Docker Compose 部署 (Qdrant + Ollama)
- Nginx 反向代理配置
- 全面的单元测试覆盖
