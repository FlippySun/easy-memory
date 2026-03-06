#!/usr/bin/env node
/**
 * Seed comprehensive test data for local integration testing.
 * Run with: node seed-test-data.mjs
 */

const BASE = "http://localhost:3080";
const AUTH_TOKEN = "test-token-12345";
const ADMIN_TOKEN = "admin-token-12345";

// =========================================================================
// Helpers
// =========================================================================

async function api(method, path, body = null, token = AUTH_TOKEN) {
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
    },
  };
  if (body) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, opts);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) {
    console.error(`❌ ${method} ${path} -> ${res.status}`, data);
  }
  return { status: res.status, data };
}

async function adminApi(method, path, body = null) {
  return api(method, path, body, ADMIN_TOKEN);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// =========================================================================
// 1. Create API Keys for test users
// =========================================================================

async function createApiKeys() {
  console.log("\n📌 Creating API Keys...");

  const keys = [
    { name: "Alice-Frontend", scopes: ["save", "search", "status"] },
    { name: "Bob-Backend", scopes: ["save", "search", "forget", "status"] },
    { name: "Charlie-DevOps" },
    { name: "Diana-DataScience", rate_limit_per_minute: 100 },
    { name: "Eve-Testing", metadata: { team: "QA", env: "staging" } },
  ];

  const results = [];
  for (const key of keys) {
    const { status, data } = await adminApi("POST", "/api/admin/keys", key);
    if (status === 201) {
      console.log(`  ✅ Created key: ${data.name} (prefix: ${data.prefix})`);
      results.push({ name: key.name, fullKey: data.key, prefix: data.prefix });
    } else {
      console.log(`  ⚠️ Key creation returned ${status}:`, data);
    }
  }
  return results;
}

// =========================================================================
// 2. Create test users (via auth register)
// =========================================================================

async function createTestUsers() {
  console.log("\n📌 Creating test users...");

  // Login as admin first to get JWT cookie
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" }),
  });
  const cookies = loginRes.headers.getSetCookie();
  const accessCookie = cookies.find((c) => c.startsWith("em_access="));
  const jwt = accessCookie?.split("=")[1]?.split(";")[0];

  if (!jwt) {
    console.error("  ❌ Failed to get admin JWT");
    return;
  }

  const users = [
    { username: "alice", password: "alice12345", role: "user" },
    { username: "bob", password: "bob12345", role: "user" },
    { username: "charlie", password: "charlie12345", role: "admin" },
  ];

  for (const user of users) {
    const res = await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `em_access=${jwt}`,
      },
      body: JSON.stringify(user),
    });
    const data = await res.json();
    if (res.ok) {
      console.log(`  ✅ Created user: ${user.username} (role: ${user.role})`);
    } else {
      console.log(
        `  ⚠️ User ${user.username}: ${res.status}`,
        data.error || data,
      );
    }
  }
}

// =========================================================================
// 3. Seed Memories with various profiles
// =========================================================================

const PROJECTS = [
  "easy-memory",
  "frontend-app",
  "data-pipeline",
  "mobile-ios",
  "infra-k8s",
];
const SCOPES = ["global", "project", "branch"];
const TYPES = ["long_term", "short_term"];
const SOURCES = ["conversation", "file_watch", "manual"];
const FACT_TYPES = [
  "verified_fact",
  "decision",
  "hypothesis",
  "discussion",
  "observation",
];
const BRANCHES = [
  "main",
  "develop",
  "feature/auth",
  "feature/analytics",
  "fix/memory-leak",
  "release/v2.0",
];
const DEVICES = [
  "macbook-m4",
  "desktop-linux",
  "ci-runner-1",
  "ipad-pro",
  "vps-prod",
];

const MEMORY_CONTENTS = [
  // Architecture decisions
  "项目采用 Hono 作为 HTTP 框架，替代 Express，因为 Hono 更轻量且支持 Edge Runtime。决策时间：2025年Q4。",
  "数据库选择 Qdrant 向量数据库配合 SQLite 做元数据存储。Qdrant 负责向量检索，SQLite 负责审计和 API Key 管理。",
  "Embedding 采用双引擎策略：本地 Ollama (bge-m3) + 远端 Gemini 兜底。auto 模式下 Gemini 失败自动回退到 Ollama。",
  "前端技术栈：React 19 + TypeScript + Tailwind CSS + Recharts。使用 Vite 作为构建工具。",
  "认证系统采用 JWT + httpOnly Cookie 方案，Access Token 15分钟过期，Refresh Token 7天轮转。",

  // Coding patterns
  "在 TypeScript 中使用 Zod v4 进行 schema 验证。注意 import 路径是 'zod/v4' 而非 'zod'。",
  "所有 API 响应必须使用 JSON 格式，错误响应统一为 { error: string, details?: unknown } 结构。",
  "MCP stdio 通信中绝对禁止 console.log，必须使用 safeLog 输出到 stderr。",
  "防御性编程：所有 Qdrant upsert 必须强制 wait: true，防止幻读。",
  "退避重试策略：Ollama embedding 请求失败时，执行 3 次指数退避重试（1s, 2s, 4s）。",

  // Preferences
  "Git commit message 遵循 Conventional Commits 规范：feat/fix/chore/docs/refactor/perf/test + scope。",
  "TypeScript 严格模式开启：strictNullChecks, exactOptionalPropertyTypes, noUncheckedIndexedAccess。",
  "测试框架使用 Vitest，测试文件放在 tests/ 目录，与 src/ 同构映射。",
  "Docker Compose 开发环境：Qdrant (6333) + Ollama (11434) + App (3080)。",
  "环境变量通过 .env 文件配置，生产环境使用 Docker secrets 或 K8s ConfigMap。",

  // Snippets
  "Qdrant 集合创建代码：await client.createCollection({ collection_name, vectors: { size: 1024, distance: 'Cosine' } })。bge-m3 输出 1024 维向量。",
  "Hono 路由注册模式：const app = new Hono(); app.route('/api/admin', createAdminRoutes(deps));",
  "JWT payload 结构：{ sub: number, role: UserRole, username: string, iat: number, exp: number }。",
  "SafeStdioTransport 实现了背压控制：当 stdout.write 返回 false 时，等待 drain 事件再继续写入。",
  "BM25 全文检索实现：使用 TF-IDF 算法，支持中文分词（基于 Unicode 范围判断）。",

  // Debugging tips
  "Qdrant API Key 认证错误 403：检查 QDRANT_API_KEY 环境变量是否与 Docker 中 QDRANT__SERVICE__API_KEY 一致。",
  "Ollama 模型加载超时：首次请求 bge-m3 需要加载模型到内存，建议 timeout 设为 30s。",
  "EPIPE 错误处理：MCP 客户端断开连接后 stdout.write 会抛 EPIPE，需要在 shutdown 模块中捕获并静默。",
  "记忆搜索结果为空：检查 Qdrant 集合中是否有数据、embedding 维度是否匹配（bge-m3 = 1024）。",
  "Web UI 热更新失败：检查 Vite 代理配置是否指向正确的后端端口 3080。",

  // Feature documentation
  "审计日志系统：每个 API 操作自动记录 operation/outcome/ip/user 到 SQLite audit_events 表。支持 CSV 导出。",
  "API Key 管理：支持创建、吊销、限流（per-key rate limit）。Key 前缀格式：em_xxxx，用于审计追溯。",
  "Memory Browser：支持按 project/scope/type/lifecycle 过滤，支持就地编辑 tags/weight/memory_type。",
  "Analytics 仪表盘：展示记忆增长趋势、搜索质量指标、性能拆解（P95/Max/Avg）。",
  "用户权限隔离：非 admin 用户只能看到自己 API Key 关联的记忆数据，admin 可看全部。",

  // Performance insights
  "Embedding 延迟：Ollama bge-m3 本地推理约 50-200ms/query，Gemini API 约 100-500ms/query。",
  "Qdrant 检索延迟：10K 条记忆时搜索时间约 5-20ms，100K 条时约 20-50ms（取决于 HNSW 参数）。",
  "SQLite 批量写入：审计日志使用 WAL 模式，批量 INSERT 吞吐约 10K ops/s。",
  "前端首屏加载：Vite 生产构建后 JS bundle 约 200KB gzip，首屏 LCP < 1s。",
  "WebSocket 连接池：MCP streamable HTTP transport 支持多路复用，减少连接开销。",

  // Security notes
  "敏感信息脱敏：memory_save 管道中 basicSanitize 自动将 AWS Key、JWT、PEM 替换为 [REDACTED]。",
  "CSV 导出防注入：所有以 =, +, -, @ 开头的字段自动添加单引号前缀和 Tab 字符。",
  "IP 限流：登录接口 10次/分钟/IP，API 默认 60次/分钟/Key（可自定义）。",
  "CORS 配置：开发环境允许 localhost:5173，生产环境需要配置 ALLOWED_ORIGINS。",
  "Admin Token timing-safe 比较：使用 crypto.timingSafeEqual 防止时序攻击。",

  // Project-specific
  "easy-memory v0.5.3 发布要点：重构 Docker Compose 配置，修复 Qdrant 健康检查，支持 ARM64。",
  "前端路由结构：/ (Dashboard) / /analytics / /audit / /memories / /settings / /login。",
  "API 前缀规范：/api/save, /api/search, /api/forget, /api/status (核心); /api/admin/* (管理); /api/auth/* (认证)。",
  "数据目录结构：$DATA_DIR/easy-memory.db (SQLite), $DATA_DIR/audit.db (审计), $DATA_DIR/runtime-config.json。",
  "测试覆盖：870 个单元测试，覆盖核心层/API层/前端组件，使用 Vitest + Testing Library。",

  // Misc knowledge
  "Node.js 20+ 是最低运行时要求，因为使用了 fetch API、crypto.subtle、structuredClone 等原生功能。",
  "pnpm workspace 结构：根包 easy-memory + 子包 easy-memory-web (web/)。共享 tsconfig。",
  "Qdrant 数据持久化：Docker volume qdrant_data 挂载到 /qdrant/storage，重启不丢数据。",
  "Ollama 模型缓存：Docker volume ollama_data 挂载到 /root/.ollama，避免重复下载模型。",
  "部署架构：反向代理 (Caddy/Nginx) -> Easy Memory (3080) -> Qdrant (6333) + Ollama (11434)。",

  // Long content entries
  "完整的 API Key 创建流程：1) Admin 登录获取 JWT Cookie 2) POST /api/admin/keys { name, scopes, rate_limit_per_minute } 3) 返回包含完整 key 的响应（仅此一次可见） 4) 客户端使用 Authorization: Bearer <key> 进行后续请求 5) 每次请求自动记录审计日志和调用计数。",
  "Memory 保存管道（5步）：Step 1: Input Validation (Zod schema) -> Step 2: Sanitize (basicSanitize 脱敏) -> Step 3: Hash (SHA-256 去重检查) -> Step 4: Embed (Ollama/Gemini 向量化) -> Step 5: Upsert (Qdrant upsert wait:true)。每一步都有独立的错误处理和超时控制。",
  "搜索结果格式：{ results: [{ id, content, score, metadata: { project, source, fact_type, tags, ... }, system_note }], total_found }。content 字段用 [MEMORY_CONTENT_START]/[MEMORY_CONTENT_END] 标记包裹，防御 Prompt Injection。",
];

const TAGS_POOL = [
  "architecture",
  "performance",
  "security",
  "api",
  "frontend",
  "backend",
  "database",
  "devops",
  "testing",
  "documentation",
  "bugfix",
  "feature",
  "refactor",
  "migration",
  "config",
  "auth",
  "cache",
  "logging",
  "monitoring",
  "deployment",
  "docker",
  "kubernetes",
  "ci-cd",
  "typescript",
  "react",
  "node",
  "qdrant",
  "ollama",
  "embedding",
  "vector-search",
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function pickN(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

async function seedMemories(apiKeys) {
  console.log("\n📌 Seeding memories...");

  let saved = 0;
  let failed = 0;

  // Save memories using different API keys (for user data isolation testing)
  const allTokens = [
    { token: AUTH_TOKEN, label: "master" },
    ...apiKeys.map((k) => ({ token: k.fullKey, label: k.name })),
  ];

  for (let i = 0; i < MEMORY_CONTENTS.length; i++) {
    const content = MEMORY_CONTENTS[i];
    const tokenInfo = allTokens[i % allTokens.length];
    const project = pick(PROJECTS);
    const scope = pick(SCOPES);
    const type = pick(TYPES);
    const source = pick(SOURCES);
    const factType = pick(FACT_TYPES);
    const tags = pickN(TAGS_POOL, 2 + Math.floor(Math.random() * 4));
    const weight = Math.round((1 + Math.random() * 9) * 2) / 2; // 0.5 step
    const branch = scope === "branch" ? pick(BRANCHES) : undefined;
    const device = Math.random() > 0.5 ? pick(DEVICES) : undefined;

    const body = {
      content,
      project,
      source,
      fact_type: factType,
      tags,
      confidence: Math.round(Math.random() * 100) / 100,
      memory_scope: scope,
      memory_type: type,
      weight,
      ...(branch && { git_branch: branch }),
      ...(device && { device_id: device }),
    };

    const { status } = await api("POST", "/api/save", body, tokenInfo.token);
    if (status === 200 || status === 201) {
      saved++;
      if (saved % 10 === 0) console.log(`  📝 Saved ${saved} memories...`);
    } else {
      failed++;
    }

    // Small delay to avoid overwhelming
    await sleep(200);
  }

  console.log(`  ✅ Saved: ${saved}, ❌ Failed: ${failed}`);
}

// =========================================================================
// 4. Generate search queries to populate search quality data
// =========================================================================

const SEARCH_QUERIES = [
  "Hono HTTP 框架选择原因",
  "JWT Cookie 认证方案",
  "Qdrant 向量数据库配置",
  "Ollama embedding 超时处理",
  "TypeScript 严格模式配置",
  "API Key 管理流程",
  "审计日志系统设计",
  "前端技术栈选择",
  "Docker Compose 开发环境",
  "EPIPE 错误处理方法",
  "BM25 全文检索实现",
  "CSV 导出安全防注入",
  "性能优化策略",
  "部署架构设计",
  "敏感信息脱敏规则",
  "记忆搜索为空排查",
  "MCP stdio 通信限制",
  "用户权限隔离方案",
  "Embedding 延迟优化",
  "Git commit 规范",
  "Vitest 测试框架配置",
  "Qdrant 检索延迟优化",
  "Node.js 运行时要求",
  "pnpm workspace 结构",
  "数据库持久化策略",
];

async function generateSearches(apiKeys) {
  console.log("\n📌 Generating search queries for analytics...");
  let count = 0;

  const allTokens = [
    { token: AUTH_TOKEN, label: "master" },
    ...apiKeys.map((k) => ({ token: k.fullKey, label: k.name })),
  ];

  for (const query of SEARCH_QUERIES) {
    const tokenInfo = pick(allTokens);
    const project = Math.random() > 0.3 ? pick(PROJECTS) : undefined;
    const scope = Math.random() > 0.5 ? pick(SCOPES) : undefined;

    const body = {
      query,
      limit: 5 + Math.floor(Math.random() * 10),
      threshold: 0.3 + Math.random() * 0.4,
      ...(project && { project }),
      ...(scope && { memory_scope: scope }),
    };

    await api("POST", "/api/search", body, tokenInfo.token);
    count++;
    await sleep(300);
  }

  // Do extra search rounds for richer analytics data
  for (let round = 0; round < 3; round++) {
    for (const query of SEARCH_QUERIES.slice(0, 10)) {
      const tokenInfo = pick(allTokens);
      await api(
        "POST",
        "/api/search",
        { query, limit: 5, project: pick(PROJECTS) },
        tokenInfo.token,
      );
      count++;
      await sleep(150);
    }
  }

  console.log(`  ✅ Generated ${count} search queries`);
}

// =========================================================================
// 5. Generate some forget operations for audit diversity
// =========================================================================

async function generateForgets() {
  console.log("\n📌 Fetching memory IDs for forget operations...");

  // Search to get some memory IDs
  const { data } = await api("POST", "/api/search", {
    query: "测试数据",
    limit: 5,
    threshold: 0.1,
  });

  if (!data?.results?.length) {
    console.log("  ⚠️ No memories found to forget");
    return;
  }

  let forgotten = 0;
  for (const result of data.results.slice(0, 3)) {
    const { status } = await api("POST", "/api/forget", {
      id: result.id,
      action: pick(["archive", "outdated"]),
      reason: "Test data cleanup - integration testing",
    });
    if (status === 200) forgotten++;
    await sleep(200);
  }

  console.log(`  ✅ Forgot ${forgotten} memories`);
}

// =========================================================================
// 6. Check status endpoint
// =========================================================================

async function checkStatus() {
  console.log("\n📌 Checking status...");
  const { data } = await api("GET", "/api/status?project=easy-memory");
  console.log(
    `  ✅ Status: total_memories=${data?.total_memories}, unique_projects=${data?.unique_projects}`,
  );
}

// =========================================================================
// Main
// =========================================================================

async function main() {
  console.log("🚀 Starting test data seeding...\n");
  console.log(`  Base URL: ${BASE}`);

  // Verify server is up
  const healthRes = await fetch(`${BASE}/health`);
  if (!healthRes.ok) {
    console.error("❌ Server not reachable!");
    process.exit(1);
  }
  console.log("  ✅ Server is healthy\n");

  // Step 1: Create test users
  await createTestUsers();

  // Step 2: Create API keys
  const apiKeys = await createApiKeys();

  // Step 3: Seed memories
  await seedMemories(apiKeys);

  // Step 4: Generate search queries
  await generateSearches(apiKeys);

  // Step 5: Generate forget operations
  await generateForgets();

  // Step 6: Check status
  await checkStatus();

  console.log("\n✅ All test data seeded successfully!");
  console.log("\n📊 Summary:");
  console.log(`  - Test users: 3 (alice, bob, charlie)`);
  console.log(`  - API Keys: ${apiKeys.length}`);
  console.log(`  - Memories: ~${MEMORY_CONTENTS.length}`);
  console.log(`  - Search queries: ~${SEARCH_QUERIES.length * 4}`);
  console.log(`  - Forget operations: 3\n`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
