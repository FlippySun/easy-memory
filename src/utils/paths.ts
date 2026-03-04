/**
 * @module paths
 * @description 数据目录路径解析工具。
 *
 * 核心职责:
 * - 集中管理所有持久化文件（SQLite DB、JSONL 日志、运行时配置）的存储路径
 * - 通过 DATA_DIR 环境变量支持 Docker volume 挂载，确保容器重建后数据不丢失
 *
 * 优先级: DATA_DIR env > HOME env > /tmp (最终回退)
 *
 * 铁律: 本模块不进行 IO 操作（不创建目录），仅做路径计算。
 *       目录创建由 Dockerfile 或启动脚本负责。
 */

import { join } from "node:path";

/**
 * 获取数据存储根目录。
 *
 * 优先级:
 * 1. `DATA_DIR` 环境变量 — Docker 推荐 `/data`
 * 2. `HOME` 环境变量 — 本地开发 `~`
 * 3. `/tmp` — 最终兜底（不可靠，仅防崩溃）
 *
 * @returns 数据存储根目录的绝对路径
 */
export function getDataDir(): string {
  return process.env.DATA_DIR ?? process.env.HOME ?? "/tmp";
}

/**
 * 预定义的数据文件路径。
 * 所有需要持久化的服务都必须通过本对象获取路径，禁止各自硬编码。
 */
export const DATA_PATHS = {
  /** Admin SQLite 数据库 — API Keys / Bans / Users / Refresh Tokens */
  get adminDb(): string {
    return join(getDataDir(), ".easy-memory-admin.db");
  },
  /** Analytics SQLite 数据库 — 聚合分析 */
  get analyticsDb(): string {
    return join(getDataDir(), ".easy-memory-analytics.db");
  },
  /** 审计 JSONL 日志 — 热写入层 */
  get auditLog(): string {
    return join(getDataDir(), ".easy-memory-audit.jsonl");
  },
  /** 运行时配置 JSON — 动态配置覆盖 */
  get runtimeConfig(): string {
    return join(getDataDir(), ".easy-memory-runtime-config.json");
  },
  /** 日志备用文件 — stderr 不可用时的降级输出 */
  get fallbackLog(): string {
    return join(getDataDir(), ".easy-memory-fallback.log");
  },
} as const;
