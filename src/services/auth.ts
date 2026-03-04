/**
 * @module services/auth
 * @description Auth 服务 — 用户 CRUD、密码哈希、JWT 签发/验证。
 *
 * 安全设计:
 * - 密码: crypto.scryptSync (N=16384, r=8, p=1) + 随机 salt
 * - JWT: HMAC-SHA256，secret 从 ADMIN_TOKEN 派生 (HKDF)
 * - 零外部依赖 — 全部使用 Node.js crypto 模块
 *
 * 铁律:
 * - 绝对禁止 console.log (MCP stdio 依赖)
 * - 密码/JWT secret 绝对禁止出现在日志中
 */

import {
  randomBytes,
  scryptSync,
  createHmac,
  createHash,
  timingSafeEqual,
  randomUUID,
} from "node:crypto";
import type Database from "better-sqlite3";
import { log } from "../utils/logger.js";
import type {
  UserRole,
  SafeUserRecord,
  JwtPayload,
  RefreshTokenRecord,
} from "../types/auth-schema.js";
import {
  ROLE_PERMISSIONS,
  ACCESS_TOKEN_EXPIRY_SECONDS,
  REFRESH_TOKEN_EXPIRY_SECONDS,
  REFRESH_TOKEN_REUSE_GRACE_SECONDS,
} from "../types/auth-schema.js";

// =========================================================================
// Constants
// =========================================================================

const SCRYPT_KEY_LEN = 64;
const SCRYPT_COST = 16384; // N
const SCRYPT_BLOCK_SIZE = 8; // r
const SCRYPT_PARALLELIZATION = 1; // p
const SALT_LEN = 32;

/**
 * 默认 Access Token 过期时间 — 使用 auth-schema 中的常量。
 * 旧值 7200 (2h) 已迁移为 900 (15min) + Refresh Token 机制。
 */
const JWT_EXPIRY_SECONDS = ACCESS_TOKEN_EXPIRY_SECONDS;
const JWT_ALGORITHM = "HS256";

// =========================================================================
// Password Hashing
// =========================================================================

/**
 * 哈希密码 — scrypt (salt:hash 格式)。
 * @returns "hex_salt:hex_hash"
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LEN);
  const hash = scryptSync(password, salt, SCRYPT_KEY_LEN, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
  });
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

/**
 * 验证密码 — timing-safe 比较。
 */
export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;

  const salt = Buffer.from(saltHex, "hex");
  const storedHash = Buffer.from(hashHex, "hex");
  const candidateHash = scryptSync(password, salt, SCRYPT_KEY_LEN, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
  });

  if (storedHash.length !== candidateHash.length) return false;
  return timingSafeEqual(storedHash, candidateHash);
}

// =========================================================================
// JWT — Zero-dependency implementation
// =========================================================================

/** Base64url 编码 */
function base64url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64url");
}

/** Base64url 解码 */
function base64urlDecode(input: string): string {
  return Buffer.from(input, "base64url").toString("utf-8");
}

/**
 * 从 ADMIN_TOKEN 派生 JWT 签名密钥 (HKDF-like)。
 * 使用 HMAC-SHA256(adminToken, "jwt-signing-key") 作为派生函数。
 */
export function deriveJwtSecret(adminToken: string): Buffer {
  return createHmac("sha256", adminToken)
    .update("easy-memory-jwt-signing-key-v1")
    .digest();
}

/**
 * 签发 JWT。
 * @param expirySeconds 过期时间（秒），默认 JWT_EXPIRY_SECONDS
 */
export function signJwt(
  payload: Omit<JwtPayload, "iat" | "exp">,
  secret: Buffer,
  expirySeconds: number = JWT_EXPIRY_SECONDS,
): string {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JwtPayload = {
    ...payload,
    iat: now,
    exp: now + expirySeconds,
  };

  const header = base64url(JSON.stringify({ alg: JWT_ALGORITHM, typ: "JWT" }));
  const body = base64url(JSON.stringify(fullPayload));
  const signature = createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest();

  return `${header}.${body}.${base64url(signature)}`;
}

/**
 * 验证并解析 JWT。
 * @returns payload 或 null (无效/过期)
 */
export function verifyJwt(token: string, secret: Buffer): JwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [header, body, sig] = parts;

  // 验证签名
  const expectedSig = createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest();
  const actualSig = Buffer.from(sig, "base64url");

  if (expectedSig.length !== actualSig.length) return null;
  if (!timingSafeEqual(expectedSig, actualSig)) return null;

  // 解析 payload
  try {
    const payload = JSON.parse(base64urlDecode(body)) as JwtPayload;

    // 验证过期
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp <= now) return null;

    // 基本字段校验
    if (
      typeof payload.sub !== "number" ||
      typeof payload.role !== "string" ||
      typeof payload.username !== "string"
    ) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

// =========================================================================
// AuthService
// =========================================================================

export interface AuthServiceConfig {
  adminToken: string;
  adminUsername?: string;
  adminPassword?: string;
  /** JWT 过期时间 (秒)，默认 7200 (2小时) */
  jwtExpirySeconds?: number;
}

export class AuthService {
  private db: Database.Database | null = null;
  private jwtSecret: Buffer;
  private config: AuthServiceConfig;
  private jwtExpirySeconds: number;

  constructor(config: AuthServiceConfig) {
    this.config = config;
    this.jwtSecret = deriveJwtSecret(config.adminToken);
    this.jwtExpirySeconds = config.jwtExpirySeconds ?? JWT_EXPIRY_SECONDS;
  }

  /**
   * 初始化 — 创建表、种子 admin 用户。
   * @param db 可选的共享 DB 连接（与 ApiKeyManager 共享）
   */
  open(db?: Database.Database): void {
    this.db = db ?? null;

    if (!this.db) {
      // 如果没有共享 DB，独立打开（不应发生，仅作防御）
      log.warn("AuthService: No shared DB provided, user management disabled");
      return;
    }

    this.ensureTable();
    this.seedAdminUser();
  }

  /**
   * 创建用户表（如果不存在）。
   */
  private ensureTable(): void {
    if (!this.db) return;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_login_at TEXT,
        is_active INTEGER NOT NULL DEFAULT 1
      );

      CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
      CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
    `);

    // Refresh Token 表 — 支持 token 轮转与复用检测
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        family_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        revoked_at TEXT,
        replaced_by TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token_hash ON refresh_tokens(token_hash);
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family_id ON refresh_tokens(family_id);
    `);
  }

  /**
   * 种子 admin 用户 — 仅当用户表为空且环境变量提供了管理员凭证时执行。
   */
  private seedAdminUser(): void {
    if (!this.db) return;

    const { adminUsername, adminPassword } = this.config;
    if (!adminUsername || !adminPassword) {
      log.info(
        "AuthService: No ADMIN_USERNAME/ADMIN_PASSWORD set, skipping admin seed",
      );
      return;
    }

    // 检查是否已存在同名用户
    const existing = this.db
      .prepare("SELECT id FROM users WHERE username = ?")
      .get(adminUsername) as { id: number } | undefined;

    if (existing) {
      log.info("AuthService: Admin user already exists, skipping seed");
      return;
    }

    const passwordHash = hashPassword(adminPassword);
    try {
      this.db
        .prepare(
          `INSERT INTO users (username, password_hash, role, is_active)
           VALUES (?, ?, 'admin', 1)`,
        )
        .run(adminUsername, passwordHash);

      log.info("AuthService: Admin user seeded successfully", {
        username: adminUsername,
      });
    } catch (err: unknown) {
      // UNIQUE 约束冲突 — 可能是并发初始化或外部先行创建
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE constraint")) {
        log.info(
          "AuthService: Admin user already exists (concurrent seed), skipping",
        );
      } else {
        log.error("AuthService: Failed to seed admin user", { error: msg });
        throw err;
      }
    }
  }

  // =====================================================================
  // User CRUD
  // =====================================================================

  /**
   * 用户登录 — 验证凭证，返回 JWT access token + refresh token。
   */
  login(
    username: string,
    password: string,
  ): {
    accessToken: string;
    refreshToken: string;
    user: SafeUserRecord;
    accessExpiresIn: number;
    refreshExpiresIn: number;
  } | null {
    if (!this.db) return null;

    const row = this.db
      .prepare("SELECT * FROM users WHERE username = ? AND is_active = 1")
      .get(username) as RawUserRow | undefined;

    if (!row) return null;
    if (!verifyPassword(password, row.password_hash)) return null;

    // 更新 last_login_at
    this.db
      .prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?")
      .run(row.id);

    const accessToken = signJwt(
      { sub: row.id, role: row.role as UserRole, username: row.username },
      this.jwtSecret,
      this.jwtExpirySeconds,
    );

    // 创建 Refresh Token
    const refreshResult = this.createRefreshToken(row.id);

    return {
      accessToken,
      refreshToken: refreshResult.rawToken,
      user: toSafeUser(row),
      accessExpiresIn: this.jwtExpirySeconds,
      refreshExpiresIn: REFRESH_TOKEN_EXPIRY_SECONDS,
    };
  }

  /**
   * 注册新用户。
   * @returns 新用户记录或 null (用户名已存在)
   */
  register(
    username: string,
    password: string,
    role: UserRole = "user",
  ): SafeUserRecord | null {
    if (!this.db) return null;

    // 检查用户名唯一性
    const existing = this.db
      .prepare("SELECT id FROM users WHERE username = ?")
      .get(username) as { id: number } | undefined;

    if (existing) return null;

    const passwordHash = hashPassword(password);
    const result = this.db
      .prepare(
        `INSERT INTO users (username, password_hash, role, is_active)
         VALUES (?, ?, ?, 1)`,
      )
      .run(username, passwordHash, role);

    const row = this.db
      .prepare("SELECT * FROM users WHERE id = ?")
      .get(result.lastInsertRowid) as RawUserRow;

    return toSafeUser(row);
  }

  /**
   * 通过 ID 获取用户。
   */
  getUserById(id: number): SafeUserRecord | null {
    if (!this.db) return null;

    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as
      | RawUserRow
      | undefined;

    return row ? toSafeUser(row) : null;
  }

  /**
   * 获取所有用户列表。
   */
  listUsers(): SafeUserRecord[] {
    if (!this.db) return [];

    const rows = this.db
      .prepare("SELECT * FROM users ORDER BY created_at DESC")
      .all() as RawUserRow[];

    return rows.map(toSafeUser);
  }

  /**
   * 更新用户。
   *
   * 安全守卫:
   * - 不允许将最后一个 admin 降级为 user (防止永久锁定)
   * - 不允许停用最后一个 admin
   *
   * @returns 更新后的用户记录，或 null (不存在)，或 'last_admin' (最后一个 admin 保护触发)
   */
  updateUser(
    id: number,
    updates: { role?: UserRole; is_active?: boolean; password?: string },
  ): SafeUserRecord | null | "last_admin" {
    if (!this.db) return null;

    // C4 FIX: 防止最后一个 admin 降级或被停用
    const target = this.db
      .prepare("SELECT role, is_active FROM users WHERE id = ?")
      .get(id) as { role: string; is_active: number } | undefined;

    if (!target) return null;

    if (target.role === "admin") {
      const wouldLoseAdmin =
        (updates.role !== undefined && updates.role !== "admin") ||
        updates.is_active === false;

      if (wouldLoseAdmin) {
        const adminCount = this.db
          .prepare(
            "SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND is_active = 1",
          )
          .get() as { count: number };

        if (adminCount.count <= 1) {
          return "last_admin";
        }
      }
    }

    const setClauses: string[] = ["updated_at = datetime('now')"];
    const params: (string | number)[] = [];

    if (updates.role !== undefined) {
      setClauses.push("role = ?");
      params.push(updates.role);
    }

    if (updates.is_active !== undefined) {
      setClauses.push("is_active = ?");
      params.push(updates.is_active ? 1 : 0);
    }

    if (updates.password !== undefined) {
      setClauses.push("password_hash = ?");
      params.push(hashPassword(updates.password));
    }

    params.push(id);

    this.db
      .prepare(`UPDATE users SET ${setClauses.join(", ")} WHERE id = ?`)
      .run(...params);

    // 安全守卫: 密码变更或停用时撤销所有 refresh tokens (强制重新登录)
    if (updates.password !== undefined || updates.is_active === false) {
      this.revokeAllUserRefreshTokens(id);
    }

    return this.getUserById(id);
  }

  /**
   * 删除用户 (硬删除)。
   * 不允许删除最后一个 admin。
   */
  deleteUser(id: number): boolean {
    if (!this.db) return false;

    // 获取目标用户
    const target = this.db
      .prepare("SELECT role FROM users WHERE id = ?")
      .get(id) as { role: string } | undefined;

    if (!target) return false;

    // 如果要删除 admin，检查是否是最后一个活跃 admin
    if (target.role === "admin") {
      const adminCount = this.db
        .prepare(
          "SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND is_active = 1",
        )
        .get() as { count: number };

      if (adminCount.count <= 1) {
        return false; // 不允许删除最后一个活跃 admin
      }
    }

    // 级联删除用户的所有 refresh tokens
    this.db.prepare("DELETE FROM refresh_tokens WHERE user_id = ?").run(id);

    const result = this.db.prepare("DELETE FROM users WHERE id = ?").run(id);
    return result.changes > 0;
  }

  // =====================================================================
  // Refresh Token Management (令牌轮转机制)
  // =====================================================================

  /**
   * 创建 Refresh Token — 生成随机令牌并存储 hash。
   *
   * @param userId 用户 ID
   * @param familyId 可选的令牌家族 ID（轮转时传入）
   * @returns { rawToken, id, familyId }
   */
  createRefreshToken(
    userId: number,
    familyId?: string,
  ): { rawToken: string; id: string; familyId: string } {
    if (!this.db)
      throw new Error("AuthService: DB not initialized for refresh tokens");

    const id = randomUUID();
    const rawToken = randomBytes(32).toString("hex"); // 256-bit token
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const fid = familyId ?? randomUUID();
    const expiresAt = new Date(
      Date.now() + REFRESH_TOKEN_EXPIRY_SECONDS * 1000,
    ).toISOString();

    this.db
      .prepare(
        `INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, userId, tokenHash, fid, expiresAt);

    return { rawToken, id, familyId: fid };
  }

  /**
   * 轮转 Refresh Token — 验证旧令牌，签发新的 access + refresh token。
   *
   * 安全机制:
   * 1. 正常令牌 → 签发新对，撤销旧令牌
   * 2. 已撤销但在宽限期内 → 返回 replacement 令牌对（多标签页场景）
   * 3. 已撤销超出宽限期 → 令牌复用攻击 → 撤销整个 family → null
   * 4. 用户不存在/已停用 → null
   */
  rotateRefreshToken(rawToken: string): {
    accessToken: string;
    refreshToken: string;
    user: SafeUserRecord;
    accessExpiresIn: number;
    refreshExpiresIn: number;
  } | null {
    if (!this.db) return null;

    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const record = this.db
      .prepare("SELECT * FROM refresh_tokens WHERE token_hash = ?")
      .get(tokenHash) as RefreshTokenRecord | undefined;

    if (!record) return null;

    // 检查过期
    if (new Date(record.expires_at) <= new Date()) {
      // 过期令牌 — 清理
      this.db.prepare("DELETE FROM refresh_tokens WHERE id = ?").run(record.id);
      return null;
    }

    // 验证用户仍存在且活跃
    const user = this.getUserById(record.user_id);
    if (!user || !user.is_active) {
      // 用户已删除/停用 — 撤销所有令牌
      this.revokeTokenFamily(record.family_id);
      return null;
    }

    // Case 1: 令牌未被撤销 — 正常轮转
    if (!record.revoked_at) {
      // C3 FIX: 事务包裹 INSERT + UPDATE — 保证原子性
      const rotateCase1 = this.db.transaction(() => {
        const newRefresh = this.createRefreshToken(
          record.user_id,
          record.family_id,
        );

        // 撤销旧令牌 (标记 replaced_by)
        this.db!.prepare(
          `UPDATE refresh_tokens
             SET revoked_at = datetime('now'), replaced_by = ?
             WHERE id = ?`,
        ).run(newRefresh.id, record.id);

        return newRefresh;
      });

      const newRefresh = rotateCase1();

      const accessToken = signJwt(
        { sub: user.id, role: user.role, username: user.username },
        this.jwtSecret,
        this.jwtExpirySeconds,
      );

      return {
        accessToken,
        refreshToken: newRefresh.rawToken,
        user,
        accessExpiresIn: this.jwtExpirySeconds,
        refreshExpiresIn: REFRESH_TOKEN_EXPIRY_SECONDS,
      };
    }

    // Case 2 & 3: 令牌已被撤销 — 检查宽限期
    const revokedAt = new Date(record.revoked_at).getTime();
    const now = Date.now();
    const gracePeriodMs = REFRESH_TOKEN_REUSE_GRACE_SECONDS * 1000;

    if (record.replaced_by && now - revokedAt < gracePeriodMs) {
      // Case 2: 宽限期内 — 多标签页场景
      // 找到 family 中最新的未撤销令牌
      const latestActive = this.db
        .prepare(
          `SELECT * FROM refresh_tokens
           WHERE family_id = ? AND revoked_at IS NULL
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(record.family_id) as RefreshTokenRecord | undefined;

      if (latestActive) {
        // C3 FIX: 事务包裹 INSERT + UPDATE — 保证原子性
        const rotateCase2 = this.db.transaction(() => {
          const newRefresh = this.createRefreshToken(
            record.user_id,
            record.family_id,
          );

          // 撤销 latestActive（它已被 newRefresh 替代）
          this.db!.prepare(
            `UPDATE refresh_tokens
               SET revoked_at = datetime('now'), replaced_by = ?
               WHERE id = ?`,
          ).run(newRefresh.id, latestActive.id);

          return newRefresh;
        });

        const newRefresh = rotateCase2();

        const accessToken = signJwt(
          { sub: user.id, role: user.role, username: user.username },
          this.jwtSecret,
          this.jwtExpirySeconds,
        );

        return {
          accessToken,
          refreshToken: newRefresh.rawToken,
          user,
          accessExpiresIn: this.jwtExpirySeconds,
          refreshExpiresIn: REFRESH_TOKEN_EXPIRY_SECONDS,
        };
      }
    }

    // Case 3: 超出宽限期或无替代令牌 — 令牌复用攻击
    log.warn("Refresh token reuse detected — revoking family", {
      familyId: record.family_id,
      userId: record.user_id,
    });
    this.revokeTokenFamily(record.family_id);
    return null;
  }

  /**
   * 撤销令牌家族 — 安全响应：令牌复用攻击或用户停用时使用。
   */
  revokeTokenFamily(familyId: string): void {
    if (!this.db) return;
    this.db
      .prepare(
        `UPDATE refresh_tokens
         SET revoked_at = datetime('now')
         WHERE family_id = ? AND revoked_at IS NULL`,
      )
      .run(familyId);
  }

  /**
   * 撤销用户所有 Refresh Token — 密码变更、用户停用时使用。
   */
  revokeAllUserRefreshTokens(userId: number): void {
    if (!this.db) return;
    this.db
      .prepare(
        `UPDATE refresh_tokens
         SET revoked_at = datetime('now')
         WHERE user_id = ? AND revoked_at IS NULL`,
      )
      .run(userId);
  }

  /**
   * 清理过期 Refresh Token — 定期调用防止表无限增长。
   */
  cleanupExpiredRefreshTokens(): number {
    if (!this.db) return 0;
    const result = this.db
      .prepare(
        `DELETE FROM refresh_tokens
         WHERE expires_at < datetime('now')
            OR (revoked_at IS NOT NULL AND revoked_at < datetime('now', '-1 day'))`,
      )
      .run();
    return result.changes;
  }

  /**
   * 验证 JWT token。
   */
  verifyToken(token: string): JwtPayload | null {
    return verifyJwt(token, this.jwtSecret);
  }

  /**
   * 获取角色权限列表。
   */
  getPermissions(role: UserRole): readonly string[] {
    return ROLE_PERMISSIONS[role] ?? [];
  }

  /**
   * 检查角色是否拥有指定权限。
   */
  hasPermission(role: UserRole, permission: string): boolean {
    return (ROLE_PERMISSIONS[role] ?? []).includes(permission);
  }

  /**
   * 获取用户总数。
   */
  getUserCount(): number {
    if (!this.db) return 0;
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM users")
      .get() as { count: number };
    return row.count;
  }

  /**
   * 检查指定用户是否是最后一个活跃的 admin。
   */
  isLastAdmin(userId: number): boolean {
    if (!this.db) return false;
    const target = this.db
      .prepare("SELECT role FROM users WHERE id = ?")
      .get(userId) as { role: string } | undefined;
    if (!target || target.role !== "admin") return false;

    const adminCount = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND is_active = 1",
      )
      .get() as { count: number };
    return adminCount.count <= 1;
  }

  close(): void {
    // DB 由外部管理 (共享连接)，这里不关闭
    this.db = null;
  }
}

// =========================================================================
// Internal Types & Helpers
// =========================================================================

interface RawUserRow {
  id: number;
  username: string;
  password_hash: string;
  role: string;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
  is_active: number;
}

function toSafeUser(row: RawUserRow): SafeUserRecord {
  return {
    id: row.id,
    username: row.username,
    role: row.role as UserRole,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_login_at: row.last_login_at,
    is_active: row.is_active === 1,
  };
}
