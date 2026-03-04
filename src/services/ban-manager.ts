/**
 * @module ban-manager
 * @description Ban 管理服务 — 内存热路径 + SQLite 持久化。
 *
 * 职责:
 * - 按 API Key ID 或 IP/CIDR 创建/移除 ban
 * - 临时 ban (TTL) + 永久 ban
 * - 快速 O(1) ban 检查（每个请求都调用）
 *
 * 性能设计:
 * - 活跃 ban 在初始化时全量加载到内存 Map
 * - 写操作同时更新内存和数据库 (write-through)
 * - 过期 ban 的清理在 check 时 lazy 执行
 *
 * 铁律: 绝对禁止 console.log (MCP stdio 依赖)
 */

import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { log } from "../utils/logger.js";
import { DATA_PATHS } from "../utils/paths.js";
import type {
  BanRecord,
  BanResponse,
  CreateBanInput,
  ListBansQuery,
  AdminPaginatedResponse,
} from "../types/admin-schema.js";
import {
  toBanResponse,
  buildPaginatedResponse,
  ipMatchesCidr,
} from "../types/admin-schema.js";

// =========================================================================
// SQL DDL
// =========================================================================

const CREATE_BANS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS bans (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('api_key', 'ip')),
  target TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  created_by TEXT NOT NULL DEFAULT 'system',
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_bans_type ON bans(type, is_active);
CREATE INDEX IF NOT EXISTS idx_bans_target ON bans(target, is_active);
CREATE INDEX IF NOT EXISTS idx_bans_expires ON bans(expires_at);
`;

// =========================================================================
// Configuration
// =========================================================================

export interface BanManagerConfig {
  /** SQLite 数据库路径 — 与 ApiKeyManager 共享同一数据库 */
  dbPath?: string;
}

// =========================================================================
// BanManager
// =========================================================================

export class BanManager {
  private db: BetterSqlite3.Database | null = null;
  private readonly dbPath: string;
  /** 标记是否拥有 DB 生命周期——非共享时自行关闭 */
  private ownsDb = false;

  /** 内存缓存: API Key ID → BanRecord（快速按 key 查 ban） */
  private keyBans: Map<string, BanRecord> = new Map();
  /** 内存缓存: IP/CIDR ban 列表（按 IP 查时需线性遍历 CIDR） */
  private ipBans: Map<string, BanRecord> = new Map();

  // Prepared statements
  private stmtInsertBan: BetterSqlite3.Statement | null = null;
  private stmtDeactivateBan: BetterSqlite3.Statement | null = null;
  private stmtGetBanById: BetterSqlite3.Statement | null = null;

  constructor(config: BanManagerConfig = {}) {
    this.dbPath = config.dbPath ?? DATA_PATHS.adminDb;
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /**
   * 初始化 — 建表 + 加载活跃 ban 到内存。
   *
   * @param existingDb 可选的已打开数据库连接（与 ApiKeyManager 共享）
   */
  open(existingDb?: BetterSqlite3.Database): void {
    if (this.db) return;

    try {
      if (existingDb) {
        this.db = existingDb;
        this.ownsDb = false;
      } else {
        this.db = new Database(this.dbPath);
        this.ownsDb = true;
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("synchronous = NORMAL");
      }

      this.db.exec(CREATE_BANS_TABLE_SQL);
      this.prepareStatements();
      this.loadActiveBans();

      log.info("BanManager initialized", {
        keyBans: this.keyBans.size,
        ipBans: this.ipBans.size,
        sharedDb: !this.ownsDb,
      });
    } catch (err) {
      log.error("Failed to initialize BanManager", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  close(): void {
    // 仅在拥有 DB 连接时关闭（共享 DB 由 ApiKeyManager 管理）
    if (this.ownsDb && this.db) {
      try {
        this.db.close();
      } catch {
        // 静默处理关闭错误
      }
    }
    this.db = null;
    this.ownsDb = false;
    this.keyBans.clear();
    this.ipBans.clear();
  }

  // =========================================================================
  // Ban Check — 热路径 (每个请求调用)
  // =========================================================================

  /**
   * 检查 API Key ID 是否被 ban。
   * O(1) 查找 + lazy 过期清理。
   */
  isKeyBanned(
    keyId: string,
  ):
    | { banned: true; reason: string; expires_at: string | null }
    | { banned: false } {
    const ban = this.keyBans.get(keyId);
    if (!ban) return { banned: false };

    // 检查过期
    if (ban.expires_at && ban.expires_at < new Date().toISOString()) {
      this.keyBans.delete(keyId);
      // 在数据库中标记为非活跃
      this.deactivateBanInDb(ban.id);
      return { banned: false };
    }

    return {
      banned: true,
      reason: ban.reason,
      expires_at: ban.expires_at,
    };
  }

  /**
   * 检查 IP 地址是否被 ban。
   * 遍历所有 IP ban 条目 (含 CIDR 匹配)。
   *
   * 性能: O(n) 其中 n 为活跃 IP ban 数量。
   * 通常 n 很小 (<100)，所以可接受。
   */
  isIpBanned(
    clientIp: string,
  ):
    | { banned: true; reason: string; expires_at: string | null; cidr: string }
    | { banned: false } {
    if (!clientIp) return { banned: false };

    const expiredIds: string[] = [];
    let result: {
      banned: true;
      reason: string;
      expires_at: string | null;
      cidr: string;
    } | null = null;

    for (const [target, ban] of this.ipBans) {
      // 检查过期
      if (ban.expires_at && ban.expires_at < new Date().toISOString()) {
        expiredIds.push(ban.id);
        continue;
      }

      if (ipMatchesCidr(clientIp, target)) {
        result = {
          banned: true,
          reason: ban.reason,
          expires_at: ban.expires_at,
          cidr: target,
        };
        break; // 匹配到一个即可
      }
    }

    // Lazy 清理过期 ban
    for (const id of expiredIds) {
      for (const [target, ban] of this.ipBans) {
        if (ban.id === id) {
          this.ipBans.delete(target);
          this.deactivateBanInDb(id);
          break;
        }
      }
    }

    return result ?? { banned: false };
  }

  // =========================================================================
  // Ban CRUD
  // =========================================================================

  /**
   * 创建新的 ban。
   */
  createBan(input: CreateBanInput, createdBy: string): BanResponse {
    this.ensureOpen();

    const id = randomUUID();
    const now = new Date().toISOString();

    let expiresAt: string | null = null;
    if (input.expires_at) {
      expiresAt = input.expires_at;
    } else if (input.ttl_seconds) {
      expiresAt = new Date(Date.now() + input.ttl_seconds * 1000).toISOString();
    }

    const record: BanRecord = {
      id,
      type: input.type,
      target: input.target,
      reason: input.reason,
      created_at: now,
      expires_at: expiresAt,
      created_by: createdBy,
      is_active: 1,
    };

    this.stmtInsertBan!.run(
      record.id,
      record.type,
      record.target,
      record.reason,
      record.created_at,
      record.expires_at,
      record.created_by,
      record.is_active,
    );

    // 更新内存缓存
    if (input.type === "api_key") {
      this.keyBans.set(input.target, record);
    } else {
      this.ipBans.set(input.target, record);
    }

    log.info("Ban created", {
      id,
      type: input.type,
      target: input.target,
      reason: input.reason,
      expires_at: expiresAt,
    });

    return toBanResponse(record);
  }

  /**
   * 移除 ban (soft deactivate)。
   */
  removeBan(id: string): BanResponse | null {
    this.ensureOpen();

    const record = this.stmtGetBanById!.get(id) as BanRecord | undefined;
    if (!record) return null;

    this.deactivateBanInDb(id);

    // 从内存中移除
    if (record.type === "api_key") {
      this.keyBans.delete(record.target);
    } else {
      this.ipBans.delete(record.target);
    }

    log.info("Ban removed", { id, type: record.type, target: record.target });

    return toBanResponse({ ...record, is_active: 0 });
  }

  /**
   * 获取 ban 详情。
   */
  getBanById(id: string): BanResponse | null {
    this.ensureOpen();

    const record = this.stmtGetBanById!.get(id) as BanRecord | undefined;
    if (!record) return null;

    return toBanResponse(record);
  }

  /**
   * 列出 ban (分页 + 过滤)。
   */
  listBans(query: ListBansQuery): AdminPaginatedResponse<BanResponse> {
    this.ensureOpen();

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.type) {
      conditions.push("type = ?");
      params.push(query.type);
    }

    if (query.status === "active") {
      conditions.push("is_active = 1");
      conditions.push("(expires_at IS NULL OR expires_at > datetime('now'))");
    } else if (query.status === "expired") {
      conditions.push("is_active = 1");
      conditions.push("expires_at IS NOT NULL");
      conditions.push("expires_at <= datetime('now')");
    } else if (query.status === "removed") {
      conditions.push("is_active = 0");
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countResult = this.db!.prepare(
      `SELECT COUNT(*) as count FROM bans ${whereClause}`,
    ).get(...params) as { count: number };

    const offset = (query.page - 1) * query.page_size;
    const rows = this.db!.prepare(
      `SELECT * FROM bans ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).all(...params, query.page_size, offset) as BanRecord[];

    const data = rows.map(toBanResponse);

    return buildPaginatedResponse(
      data,
      countResult.count,
      query.page,
      query.page_size,
    );
  }

  // =========================================================================
  // Internal Helpers
  // =========================================================================

  /**
   * 从数据库加载所有活跃 ban 到内存。
   */
  private loadActiveBans(): void {
    if (!this.db) return;

    const rows = this.db
      .prepare("SELECT * FROM bans WHERE is_active = 1")
      .all() as BanRecord[];

    for (const row of rows) {
      // 跳过已过期的 ban（但保留在 DB 中供审计）
      if (row.expires_at && row.expires_at < new Date().toISOString()) {
        continue;
      }

      if (row.type === "api_key") {
        this.keyBans.set(row.target, row);
      } else {
        this.ipBans.set(row.target, row);
      }
    }
  }

  /**
   * 在数据库中将 ban 标记为非活跃。
   */
  private deactivateBanInDb(id: string): void {
    try {
      this.stmtDeactivateBan?.run(id);
    } catch {
      // 静默失败
    }
  }

  private prepareStatements(): void {
    this.stmtInsertBan = this.db!.prepare(`
      INSERT INTO bans (id, type, target, reason, created_at, expires_at, created_by, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtDeactivateBan = this.db!.prepare(
      "UPDATE bans SET is_active = 0 WHERE id = ?",
    );

    this.stmtGetBanById = this.db!.prepare("SELECT * FROM bans WHERE id = ?");
  }

  private ensureOpen(): void {
    if (!this.db) {
      throw new Error("BanManager is not initialized. Call open() first.");
    }
  }
}
