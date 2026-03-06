/**
 * @module api-key-manager
 * @description API Key 管理服务 — SQLite 持久化 + 内存缓存。
 *
 * 职责:
 * - API Key 的 CRUD + 轮转
 * - 基于 SHA-256 hash 的安全存储
 * - 内存缓存加速热路径查找 (hash→key record)
 * - Per-key 使用统计更新
 *
 * 安全铁律:
 * - 明文 key 仅在创建/轮转时通过 API 返回一次
 * - 数据库和日志中永远只存储 hash + prefix
 * - 绝对禁止 console.log (MCP stdio 依赖)
 */

import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { DATA_PATHS } from "../utils/paths.js";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { log } from "../utils/logger.js";
import type {
  ApiKeyRecord,
  ApiKeyResponse,
  ApiKeyCreateResponse,
  CreateApiKeyInput,
  UpdateApiKeyInput,
  ListApiKeysQuery,
  AdminPaginatedResponse,
  AdminActionRecord,
  AdminAction,
} from "../types/admin-schema.js";
import {
  toApiKeyResponse,
  buildPaginatedResponse,
  DEFAULT_SCOPES,
} from "../types/admin-schema.js";

// =========================================================================
// SQL DDL
// =========================================================================

const CREATE_TABLES_SQL = `
-- API Keys
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  soft_deleted_at TEXT,
  semi_deleted_at TEXT,
  last_used_at TEXT,
  rate_limit_per_minute INTEGER,
  scopes TEXT NOT NULL DEFAULT '[]',
  metadata TEXT NOT NULL DEFAULT '{}',
  total_requests INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT 'system',
  user_id INTEGER
);

-- Admin action audit trail
CREATE TABLE IF NOT EXISTS admin_actions (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  admin_key_prefix TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  client_ip TEXT NOT NULL DEFAULT ''
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_keys_prefix ON api_keys(prefix);
CREATE INDEX IF NOT EXISTS idx_keys_revoked ON api_keys(revoked_at);
CREATE INDEX IF NOT EXISTS idx_admin_actions_ts ON admin_actions(timestamp);
CREATE INDEX IF NOT EXISTS idx_admin_actions_action ON admin_actions(action);
`;

/** 向后兼容迁移 — 为已有数据库添加 user_id 列 */
const MIGRATION_ADD_USER_ID = `
ALTER TABLE api_keys ADD COLUMN user_id INTEGER;
`;
const MIGRATION_ADD_SOFT_DELETED_AT = `
ALTER TABLE api_keys ADD COLUMN soft_deleted_at TEXT;
`;
const MIGRATION_ADD_SEMI_DELETED_AT = `
ALTER TABLE api_keys ADD COLUMN semi_deleted_at TEXT;
`;
const MIGRATION_ADD_USER_ID_INDEX = `
CREATE INDEX IF NOT EXISTS idx_keys_user_id ON api_keys(user_id);
`;
const MIGRATION_ADD_SOFT_DELETED_INDEX = `
CREATE INDEX IF NOT EXISTS idx_keys_soft_deleted ON api_keys(soft_deleted_at);
`;
const MIGRATION_ADD_SEMI_DELETED_INDEX = `
CREATE INDEX IF NOT EXISTS idx_keys_semi_deleted ON api_keys(semi_deleted_at);
`;

// =========================================================================
// Configuration
// =========================================================================

export interface ApiKeyManagerConfig {
  /** SQLite 数据库路径 (default: ~/.easy-memory-admin.db) */
  dbPath?: string;
  /** API Key 前缀标识 (default: "em_") — 生成的 key 以此开头 */
  keyPrefix?: string;
}

// =========================================================================
// ApiKeyManager
// =========================================================================

export class ApiKeyManager {
  private db: BetterSqlite3.Database | null = null;
  private readonly config: Required<ApiKeyManagerConfig>;

  /** 内存缓存: key_hash → ApiKeyRecord (热路径优化) */
  private cache: Map<string, ApiKeyRecord> = new Map();
  /** 内存缓存: key_id → ApiKeyRecord */
  private cacheById: Map<string, ApiKeyRecord> = new Map();

  // Prepared statements
  private stmtInsertKey: BetterSqlite3.Statement | null = null;
  private stmtGetByHash: BetterSqlite3.Statement | null = null;
  private stmtGetById: BetterSqlite3.Statement | null = null;
  private stmtUpdateLastUsed: BetterSqlite3.Statement | null = null;
  private stmtIncrementRequests: BetterSqlite3.Statement | null = null;
  private stmtRevokeKey: BetterSqlite3.Statement | null = null;
  private stmtInsertAction: BetterSqlite3.Statement | null = null;

  constructor(config: ApiKeyManagerConfig = {}) {
    this.config = {
      dbPath: config.dbPath ?? DATA_PATHS.adminDb,
      keyPrefix: config.keyPrefix ?? "em_",
    };
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /**
   * 初始化数据库 — 建表 + 预编译 statements + 加载缓存。
   */
  open(): void {
    if (this.db) return;

    try {
      this.db = new Database(this.config.dbPath);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      this.db.exec(CREATE_TABLES_SQL);

      // 向后兼容迁移
      this.migrateSchemaColumns();

      // 启动时清理超过 30 天的半真删 key
      this.purgeSemiDeletedKeys(30);

      this.prepareStatements();
      this.loadCache();

      log.info("ApiKeyManager initialized", {
        dbPath: this.config.dbPath,
        cachedKeys: this.cache.size,
      });
    } catch (err) {
      log.error("Failed to initialize ApiKeyManager", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * 向后兼容迁移：如果 api_keys 表缺少 user_id 列，添加之。
   * @internal
   */
  private migrateSchemaColumns(): void {
    if (!this.db) return;
    const columns = this.db
      .prepare("PRAGMA table_info(api_keys)")
      .all() as Array<{ name: string }>;
    const hasUserId = columns.some((col) => col.name === "user_id");
    const hasSoftDeletedAt = columns.some(
      (col) => col.name === "soft_deleted_at",
    );
    const hasSemiDeletedAt = columns.some(
      (col) => col.name === "semi_deleted_at",
    );

    if (!hasUserId) {
      this.db.exec(MIGRATION_ADD_USER_ID);
      log.info("Migration: added user_id column to api_keys table");
    }

    if (!hasSoftDeletedAt) {
      this.db.exec(MIGRATION_ADD_SOFT_DELETED_AT);
      log.info("Migration: added soft_deleted_at column to api_keys table");
    }

    if (!hasSemiDeletedAt) {
      this.db.exec(MIGRATION_ADD_SEMI_DELETED_AT);
      log.info("Migration: added semi_deleted_at column to api_keys table");
    }

    // 始终补齐索引（幂等）
    this.db.exec(MIGRATION_ADD_USER_ID_INDEX);
    this.db.exec(MIGRATION_ADD_SOFT_DELETED_INDEX);
    this.db.exec(MIGRATION_ADD_SEMI_DELETED_INDEX);
  }

  /**
   * 暴露内部 DB 实例 — 供 BanManager 共享连接。
   * @internal 仅用于 container.ts 依赖注入
   */
  getDatabase(): BetterSqlite3.Database | null {
    return this.db;
  }

  /**
   * v0.7.0: 获取用户关联的所有活跃 API Key 前缀。
   * 用于 userScopeMiddleware 的数据权限隔离。
   */
  getKeyPrefixesByUserId(userId: number): string[] {
    if (!this.db) return [];
    const rows = this.db
      .prepare(
        `SELECT DISTINCT prefix FROM api_keys
         WHERE user_id = ? AND revoked_at IS NULL AND soft_deleted_at IS NULL`,
      )
      .all(userId) as Array<{ prefix: string }>;
    return rows.map((r) => r.prefix);
  }

  /**
   * 关闭数据库连接。
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.cache.clear();
      this.cacheById.clear();
    }
  }

  // =========================================================================
  // Core API — CRUD
  // =========================================================================

  /**
   * 创建新的 API Key。
   *
   * @param userId 可选 — 关联创建此 key 的用户 ID (v0.6.0 用户自助管理)
   * @returns 包含明文 key 的响应 — ⚠️ key 仅此一次机会展示
   */
  createKey(
    input: CreateApiKeyInput,
    createdBy: string,
    userId?: number,
  ): ApiKeyCreateResponse {
    this.ensureOpen();

    const id = randomUUID();
    const plaintextKey = this.generateKey();
    const keyHash = this.hashKey(plaintextKey);
    const prefix = plaintextKey.slice(0, 8);
    const now = new Date().toISOString();

    const scopes = input.scopes ?? DEFAULT_SCOPES;

    const record: ApiKeyRecord = {
      id,
      name: input.name,
      prefix,
      key_hash: keyHash,
      created_at: now,
      expires_at: input.expires_at ?? null,
      revoked_at: null,
      soft_deleted_at: null,
      semi_deleted_at: null,
      last_used_at: null,
      rate_limit_per_minute: input.rate_limit_per_minute ?? null,
      scopes: JSON.stringify(scopes),
      metadata: JSON.stringify(input.metadata ?? {}),
      total_requests: 0,
      created_by: createdBy,
      user_id: userId ?? null,
    };

    this.stmtInsertKey!.run(
      record.id,
      record.name,
      record.prefix,
      record.key_hash,
      record.created_at,
      record.expires_at,
      record.revoked_at,
      record.soft_deleted_at,
      record.semi_deleted_at,
      record.last_used_at,
      record.rate_limit_per_minute,
      record.scopes,
      record.metadata,
      record.total_requests,
      record.created_by,
      record.user_id,
    );

    // 更新缓存
    this.cache.set(keyHash, record);
    this.cacheById.set(id, record);

    const response = toApiKeyResponse(record) as ApiKeyCreateResponse;
    response.key = plaintextKey;

    log.info("API key created", { id, name: input.name, prefix });

    return response;
  }

  /**
   * 通过 ID 获取 API Key 详情。
   */
  getKeyById(id: string): ApiKeyResponse | null {
    this.ensureOpen();

    const cached = this.cacheById.get(id);
    if (cached) return toApiKeyResponse(cached);

    const record = this.stmtGetById!.get(id) as ApiKeyRecord | undefined;
    if (!record) return null;

    // 更新缓存
    this.cache.set(record.key_hash, record);
    this.cacheById.set(record.id, record);

    return toApiKeyResponse(record);
  }

  /**
   * 通过 Bearer token 的 hash 查找 API Key。
   * 热路径 — 每个请求都调用，使用内存缓存。
   */
  getKeyByHash(keyHash: string): ApiKeyRecord | null {
    // 先查缓存
    const cached = this.cache.get(keyHash);
    if (cached) return cached;

    if (!this.db) return null;

    const record = this.stmtGetByHash!.get(keyHash) as ApiKeyRecord | undefined;
    if (!record) return null;

    // 更新缓存
    this.cache.set(keyHash, record);
    this.cacheById.set(record.id, record);

    return record;
  }

  /**
   * 通过明文 Bearer token 验证并获取 API Key。
   * 内部先 hash 再查找。
   */
  validateKey(plaintextKey: string): ApiKeyRecord | null {
    const keyHash = this.hashKey(plaintextKey);
    const record = this.getKeyByHash(keyHash);
    if (!record) return null;

    // 检查是否已吊销
    if (record.revoked_at) return null;

    // 假删除/半真删 key 不可用
    if (record.soft_deleted_at || record.semi_deleted_at) return null;

    // 检查是否已过期
    if (record.expires_at && record.expires_at < new Date().toISOString()) {
      return null;
    }

    return record;
  }

  /**
   * 列出 API Keys (分页 + 过滤 + 排序)。
   */
  listKeys(query: ListApiKeysQuery): AdminPaginatedResponse<ApiKeyResponse> {
    this.ensureOpen();

    // 每次列表查询前执行轻量清理：删除超过 30 天的半真删 key
    this.purgeSemiDeletedKeys(30);

    const conditions: string[] = [];
    const params: unknown[] = [];

    // 半真删 key 永不在 admin UI 列表中展示
    conditions.push("semi_deleted_at IS NULL");

    // Status 过滤
    if (query.status === "active") {
      conditions.push("soft_deleted_at IS NULL");
      conditions.push("revoked_at IS NULL");
      conditions.push("(expires_at IS NULL OR expires_at > datetime('now'))");
    } else if (query.status === "disabled" || query.status === "revoked") {
      // revoked 作为 disabled 的向后兼容别名
      conditions.push("soft_deleted_at IS NULL");
      conditions.push("revoked_at IS NOT NULL");
    } else if (query.status === "soft_deleted") {
      conditions.push("soft_deleted_at IS NOT NULL");
    }

    // Name 模糊搜索
    if (query.name) {
      conditions.push("name LIKE ?");
      params.push(`%${query.name}%`);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // 排序 — 白名单验证 (Zod 已保证合法值，此处为纵深防御)
    const validSortColumns = [
      "created_at",
      "last_used_at",
      "total_requests",
      "name",
    ];
    const sortBy = validSortColumns.includes(query.sort_by)
      ? query.sort_by
      : "created_at";
    const sortOrder = query.sort_order === "asc" ? "ASC" : "DESC";

    // 计数
    const countSql = `SELECT COUNT(*) as count FROM api_keys ${whereClause}`;
    const countResult = this.db!.prepare(countSql).get(...params) as {
      count: number;
    };

    // 查询
    const offset = (query.page - 1) * query.page_size;
    const dataSql = `SELECT * FROM api_keys ${whereClause} ORDER BY ${sortBy} ${sortOrder} LIMIT ? OFFSET ?`;
    const rows = this.db!.prepare(dataSql).all(
      ...params,
      query.page_size,
      offset,
    ) as ApiKeyRecord[];

    const data = rows.map(toApiKeyResponse);

    return buildPaginatedResponse(
      data,
      countResult.count,
      query.page,
      query.page_size,
    );
  }

  /**
   * 更新 API Key 属性。
   */
  updateKey(id: string, input: UpdateApiKeyInput): ApiKeyResponse | null {
    this.ensureOpen();

    const existing = this.stmtGetById!.get(id) as ApiKeyRecord | undefined;
    if (!existing) return null;

    // 假删除/半真删 key 不允许再修改（包含 enable/disable）
    if (existing.soft_deleted_at || existing.semi_deleted_at) {
      return toApiKeyResponse(existing);
    }

    const setClauses: string[] = [];
    const params: unknown[] = [];

    if (input.name !== undefined) {
      setClauses.push("name = ?");
      params.push(input.name);
    }
    if (input.expires_at !== undefined) {
      setClauses.push("expires_at = ?");
      params.push(input.expires_at);
    }
    if (input.rate_limit_per_minute !== undefined) {
      setClauses.push("rate_limit_per_minute = ?");
      params.push(input.rate_limit_per_minute);
    }
    if (input.scopes !== undefined) {
      setClauses.push("scopes = ?");
      params.push(JSON.stringify(input.scopes));
    }
    if (input.metadata !== undefined) {
      // Merge metadata
      const existingMeta = JSON.parse(existing.metadata || "{}");
      const merged = { ...existingMeta, ...input.metadata };
      setClauses.push("metadata = ?");
      params.push(JSON.stringify(merged));
    }

    if (input.is_active !== undefined) {
      if (input.is_active) {
        // Enable: clear revoked marker (if present)
        if (existing.revoked_at !== null) {
          setClauses.push("revoked_at = ?");
          params.push(null);
        }
      } else {
        // Disable: set revoked marker if currently active
        if (existing.revoked_at === null) {
          setClauses.push("revoked_at = ?");
          params.push(new Date().toISOString());
        }
      }
    }

    if (setClauses.length === 0) return toApiKeyResponse(existing);

    params.push(id);
    const sql = `UPDATE api_keys SET ${setClauses.join(", ")} WHERE id = ?`;
    this.db!.prepare(sql).run(...params);

    // 刷新缓存
    const updated = this.stmtGetById!.get(id) as ApiKeyRecord;
    this.cache.set(updated.key_hash, updated);
    this.cacheById.set(updated.id, updated);

    log.info("API key updated", { id, changes: Object.keys(input) });

    return toApiKeyResponse(updated);
  }

  /**
   * 管理员删除 API Key（两段式）。
   *
   * - 第一次删除：假删除（soft_deleted_at）
   * - 第二次删除：半真删（semi_deleted_at，admin UI 不再显示）
   */
  revokeKey(id: string): ApiKeyResponse | null {
    this.ensureOpen();

    const existing = this.stmtGetById!.get(id) as ApiKeyRecord | undefined;
    if (!existing) return null;

    if (existing.semi_deleted_at) {
      // 已半真删：幂等返回
      return toApiKeyResponse(existing);
    }

    const now = new Date().toISOString();

    // 第一阶段：假删除
    if (!existing.soft_deleted_at) {
      this.db!.prepare(
        "UPDATE api_keys SET soft_deleted_at = ? WHERE id = ?",
      ).run(now, id);

      const updated = { ...existing, soft_deleted_at: now };
      // 从活跃缓存移除，防止继续被鉴权命中
      this.cache.delete(updated.key_hash);
      this.cacheById.set(updated.id, updated);

      log.info("API key soft-deleted", { id, prefix: existing.prefix });
      return toApiKeyResponse(updated);
    }

    // 第二阶段：半真删
    this.db!.prepare(
      "UPDATE api_keys SET semi_deleted_at = ? WHERE id = ?",
    ).run(now, id);

    const updated = { ...existing, semi_deleted_at: now };
    this.cache.delete(updated.key_hash);
    this.cacheById.delete(updated.id);

    log.info("API key semi-deleted", { id, prefix: existing.prefix });

    return toApiKeyResponse(updated);
  }

  /**
   * 轮转 API Key — 生成新 key，吊销旧 key。原子操作。
   *
   * @returns 新 key 的创建响应 (包含明文 key)
   */
  rotateKey(id: string, createdBy: string): ApiKeyCreateResponse | null {
    this.ensureOpen();

    const existing = this.stmtGetById!.get(id) as ApiKeyRecord | undefined;
    if (!existing) return null;
    if (existing.soft_deleted_at || existing.semi_deleted_at) return null;
    if (existing.revoked_at) return null; // 吊销的 key 不能轮转

    // 原子操作: 在事务中同时吊销旧 key + 创建新 key
    const newId = randomUUID();
    const newPlaintextKey = this.generateKey();
    const newKeyHash = this.hashKey(newPlaintextKey);
    const newPrefix = newPlaintextKey.slice(0, 8);
    const now = new Date().toISOString();

    const txn = this.db!.transaction(() => {
      // 1. 吊销旧 key
      this.stmtRevokeKey!.run(now, id);

      // 2. 创建新 key (继承旧 key 的属性)
      this.stmtInsertKey!.run(
        newId,
        existing.name,
        newPrefix,
        newKeyHash,
        now,
        existing.expires_at,
        null, // revoked_at
        null, // soft_deleted_at
        null, // semi_deleted_at
        null, // last_used_at
        existing.rate_limit_per_minute,
        existing.scopes,
        existing.metadata,
        0, // total_requests
        createdBy,
        existing.user_id ?? null, // 继承 user_id
      );
    });

    txn();

    // 刷新缓存: 移除旧 key，添加新 key
    const revokedOld = { ...existing, revoked_at: now };
    this.cache.set(existing.key_hash, revokedOld);
    this.cacheById.set(existing.id, revokedOld);

    const newRecord: ApiKeyRecord = {
      ...existing,
      id: newId,
      prefix: newPrefix,
      key_hash: newKeyHash,
      created_at: now,
      revoked_at: null,
      soft_deleted_at: null,
      semi_deleted_at: null,
      last_used_at: null,
      total_requests: 0,
      created_by: createdBy,
    };
    this.cache.set(newKeyHash, newRecord);
    this.cacheById.set(newId, newRecord);

    log.info("API key rotated", {
      oldId: id,
      newId,
      oldPrefix: existing.prefix,
      newPrefix,
    });

    const response = toApiKeyResponse(newRecord) as ApiKeyCreateResponse;
    response.key = newPlaintextKey;
    return response;
  }

  /**
   * 记录 key 使用 — 更新 last_used_at + 累计 total_requests。
   * 非阻塞: 在单独的 microtask 中执行。
   */
  recordUsage(keyHash: string): void {
    if (!this.db) return;

    try {
      const now = new Date().toISOString();
      this.stmtUpdateLastUsed!.run(now, keyHash);
      this.stmtIncrementRequests!.run(keyHash);

      // 更新缓存
      const cached = this.cache.get(keyHash);
      if (cached) {
        cached.last_used_at = now;
        cached.total_requests++;
      }
    } catch {
      // 静默失败 — 使用日志不应阻塞请求
    }
  }

  // =========================================================================
  // User Self-Service API Key Management (v0.6.0)
  // =========================================================================

  /**
   * 统计指定用户拥有的**活跃** API Key 数量。
   */
  countActiveKeysByUser(userId: number): number {
    this.ensureOpen();
    this.purgeSemiDeletedKeys(30);
    const result = this.db!.prepare(
      "SELECT COUNT(*) AS cnt FROM api_keys WHERE user_id = ? AND revoked_at IS NULL AND soft_deleted_at IS NULL AND semi_deleted_at IS NULL",
    ).get(userId) as { cnt: number } | undefined;
    return result?.cnt ?? 0;
  }

  /**
   * 列出指定用户的 API Keys (含吊销的)。
   */
  listKeysByUser(userId: number): ApiKeyResponse[] {
    this.ensureOpen();
    this.purgeSemiDeletedKeys(30);
    const rows = this.db!.prepare(
      "SELECT * FROM api_keys WHERE user_id = ? AND soft_deleted_at IS NULL AND semi_deleted_at IS NULL ORDER BY created_at DESC",
    ).all(userId) as ApiKeyRecord[];
    return rows.map(toApiKeyResponse);
  }

  /**
   * 为用户创建 API Key — 事务内检查 max 限制防竞态。
   *
   * @param maxKeys 每用户最大活跃 key 数 (默认 2)
   * @throws Error 超出限制时抛出
   */
  createKeyForUser(
    input: CreateApiKeyInput,
    userId: number,
    username: string,
    maxKeys = 2,
  ): ApiKeyCreateResponse {
    this.ensureOpen();

    // 事务内原子性检查+创建 — 防竞态
    let result: ApiKeyCreateResponse | null = null;

    const txn = this.db!.transaction(() => {
      const count = (
        this.db!.prepare(
          "SELECT COUNT(*) AS cnt FROM api_keys WHERE user_id = ? AND revoked_at IS NULL AND soft_deleted_at IS NULL AND semi_deleted_at IS NULL",
        ).get(userId) as { cnt: number }
      ).cnt;

      if (count >= maxKeys) {
        throw new Error(
          `User already has ${count} active API keys (max: ${maxKeys})`,
        );
      }

      // 使用已有的 createKey 方法
      result = this.createKey(input, `user:${username}`, userId);
    });

    txn();

    return result!;
  }

  /**
   * 用户删除自己的 API Key（假删除）。
   * 校验 key 的 user_id 是否匹配。
   *
   * @returns true 如果成功假删除
   */
  revokeKeyForUser(keyId: string, userId: number): boolean {
    this.ensureOpen();

    const record = this.stmtGetById!.get(keyId) as ApiKeyRecord | undefined;
    if (!record) return false;
    if (record.user_id !== userId) return false; // 权限检查
    if (record.soft_deleted_at || record.semi_deleted_at) return false; // 已删除态

    const now = new Date().toISOString();
    this.db!.prepare(
      "UPDATE api_keys SET soft_deleted_at = ? WHERE id = ?",
    ).run(now, keyId);

    // 更新缓存
    const softDeleted = { ...record, soft_deleted_at: now };
    this.cache.delete(record.key_hash);
    this.cacheById.set(record.id, softDeleted);

    log.info("User soft-deleted own API key", {
      keyId,
      userId,
      prefix: record.prefix,
    });

    return true;
  }

  // =========================================================================
  // Admin Action Audit
  // =========================================================================

  /**
   * 记录一条 admin 操作审计日志。
   */
  recordAdminAction(
    action: AdminAction,
    targetType: string,
    targetId: string,
    adminKeyPrefix: string,
    clientIp: string,
    details: Record<string, unknown> = {},
  ): void {
    if (!this.db) return;

    try {
      this.stmtInsertAction!.run(
        randomUUID(),
        new Date().toISOString(),
        adminKeyPrefix,
        action,
        targetType,
        targetId,
        JSON.stringify(details),
        clientIp,
      );
    } catch {
      // 静默失败
    }
  }

  /**
   * 查询 admin 操作审计日志。
   */
  listAdminActions(
    page = 1,
    pageSize = 50,
    action?: string,
  ): AdminPaginatedResponse<AdminActionRecord> {
    this.ensureOpen();

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (action) {
      conditions.push("action = ?");
      params.push(action);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countResult = this.db!.prepare(
      `SELECT COUNT(*) as count FROM admin_actions ${whereClause}`,
    ).get(...params) as { count: number };

    const offset = (page - 1) * pageSize;
    const rows = this.db!.prepare(
      `SELECT * FROM admin_actions ${whereClause} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
    ).all(...params, pageSize, offset) as AdminActionRecord[];

    return buildPaginatedResponse(rows, countResult.count, page, pageSize);
  }

  // =========================================================================
  // Internal Helpers
  // =========================================================================

  /**
   * 生成随机 API Key。
   * 格式: {prefix}{32 bytes hex} → 总长度 ~68 字符
   */
  private generateKey(): string {
    const random = randomBytes(32).toString("hex");
    return `${this.config.keyPrefix}${random}`;
  }

  /**
   * 对明文 key 计算 SHA-256 hash。
   */
  hashKey(plaintext: string): string {
    return createHash("sha256").update(plaintext, "utf8").digest("hex");
  }

  /**
   * 预编译 prepared statements。
   */
  private prepareStatements(): void {
    this.stmtInsertKey = this.db!.prepare(`
      INSERT INTO api_keys (
        id, name, prefix, key_hash, created_at, expires_at,
        revoked_at, soft_deleted_at, semi_deleted_at, last_used_at, rate_limit_per_minute,
        scopes, metadata, total_requests, created_by, user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtGetByHash = this.db!.prepare(
      "SELECT * FROM api_keys WHERE key_hash = ?",
    );

    this.stmtGetById = this.db!.prepare("SELECT * FROM api_keys WHERE id = ?");

    this.stmtUpdateLastUsed = this.db!.prepare(
      "UPDATE api_keys SET last_used_at = ? WHERE key_hash = ?",
    );

    this.stmtIncrementRequests = this.db!.prepare(
      "UPDATE api_keys SET total_requests = total_requests + 1 WHERE key_hash = ?",
    );

    this.stmtRevokeKey = this.db!.prepare(
      "UPDATE api_keys SET revoked_at = ? WHERE id = ?",
    );

    this.stmtInsertAction = this.db!.prepare(`
      INSERT INTO admin_actions (
        id, timestamp, admin_key_prefix, action, target_type,
        target_id, details, client_ip
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  /**
   * 加载全部活跃 key 到内存缓存。
   */
  private loadCache(): void {
    if (!this.db) return;

    const rows = this.db
      .prepare(
        "SELECT * FROM api_keys WHERE revoked_at IS NULL AND soft_deleted_at IS NULL AND semi_deleted_at IS NULL",
      )
      .all() as ApiKeyRecord[];

    for (const row of rows) {
      this.cache.set(row.key_hash, row);
      this.cacheById.set(row.id, row);
    }
  }

  /**
   * 确保数据库已打开。
   */
  private ensureOpen(): void {
    if (!this.db) {
      throw new Error("ApiKeyManager is not initialized. Call open() first.");
    }
  }

  /**
   * 物理清理半真删超过 N 天的 key。
   *
   * @returns 删除条数
   */
  private purgeSemiDeletedKeys(retentionDays: number): number {
    if (!this.db) return 0;

    const cutoff = new Date(
      Date.now() - retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    const stale = this.db
      .prepare(
        "SELECT id, key_hash FROM api_keys WHERE semi_deleted_at IS NOT NULL AND semi_deleted_at <= ?",
      )
      .all(cutoff) as Array<{ id: string; key_hash: string }>;

    if (stale.length === 0) return 0;

    const stmtDelete = this.db.prepare("DELETE FROM api_keys WHERE id = ?");
    const txn = this.db.transaction((rows: Array<{ id: string }>) => {
      for (const row of rows) {
        stmtDelete.run(row.id);
      }
    });
    txn(stale);

    for (const row of stale) {
      this.cache.delete(row.key_hash);
    }
    for (const row of stale) {
      this.cacheById.delete(row.id);
    }

    log.info("Purged stale semi-deleted API keys", {
      purged: stale.length,
      retentionDays,
    });

    return stale.length;
  }
}
