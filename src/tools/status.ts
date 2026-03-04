/**
 * @module status
 * @description memory_status MCP Tool Handler — 简单健康检查。
 *
 * D1-3: 新增 session (uptime_seconds, started_at) 和 pending_count 字段。
 */

import type { QdrantService } from "../services/qdrant.js";
import type { EmbeddingService } from "../services/embedding.js";
import type { BM25Encoder } from "../services/bm25.js";
import type { RateLimiter } from "../utils/rate-limiter.js";
import { log } from "../utils/logger.js";
import {
  MemoryStatusInputSchema,
  CURRENT_SCHEMA_VERSION,
  type MemoryStatusOutput,
} from "../types/schema.js";

import * as z from "zod/v4";

/**
 * D1-3: 进程启动时间戳 — 模块加载即固定，不依赖外部调用。
 */
const SERVER_STARTED_AT = new Date().toISOString();
const SERVER_STARTED_MS = Date.now();

export interface StatusHandlerDeps {
  qdrant: QdrantService;
  embedding: EmbeddingService;
  defaultProject: string;
  /** API 预算护城河（可选注入） */
  rateLimiter?: RateLimiter | undefined;
  /** BM25 稀疏编码器（可选注入，暴露 hybrid_search 状态） */
  bm25?: BM25Encoder | undefined;
}

/**
 * memory_status handler — 返回 Qdrant 和 Embedding 服务状态。
 */
export async function handleStatus(
  rawInput: unknown,
  deps: StatusHandlerDeps,
): Promise<MemoryStatusOutput> {
  // M2: safeParse 统一错误格式
  const parsed = MemoryStatusInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issues = z.prettifyError(parsed.error);
    log.warn("Status input validation failed", { issues });
    return {
      qdrant: "unavailable",
      embedding: "permanently_unavailable",
      collection: null,
      session: {
        uptime_seconds: Math.floor((Date.now() - SERVER_STARTED_MS) / 1000),
        started_at: SERVER_STARTED_AT,
      },
      pending_count: 0,
    };
  }
  const input = parsed.data;
  const project = input.project ?? deps.defaultProject;

  // 并行检查服务状态
  const [qdrantHealthy, embeddingHealthy] = await Promise.all([
    deps.qdrant.healthCheck(),
    deps.embedding.healthCheck(),
  ]);

  // 获取 collection 信息
  let collection: MemoryStatusOutput["collection"] = null;
  if (qdrantHealthy) {
    try {
      const info = await deps.qdrant.getCollectionInfo(project);
      if (info) {
        collection = {
          name: info.name,
          points_count: info.points_count,
          schema_version: CURRENT_SCHEMA_VERSION,
        };
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.warn("Failed to get collection info", { error: error.message });
    }
  }

  const result: MemoryStatusOutput = {
    qdrant: qdrantHealthy ? "ready" : "unavailable",
    embedding: embeddingHealthy ? "ready" : "reconnecting",
    collection,
    // D1-3: 会话信息
    session: {
      uptime_seconds: Math.floor((Date.now() - SERVER_STARTED_MS) / 1000),
      started_at: SERVER_STARTED_AT,
    },
    // D1-3: Phase 1 无 pending 队列，固定返回 0
    pending_count: 0,
  };

  // 注入 API 预算护城河统计
  if (deps.rateLimiter) {
    result.cost_guard = deps.rateLimiter.getStats();
  }

  // 注入混合检索能力状态
  result.hybrid_search = {
    bm25_enabled: !!deps.bm25,
    fusion: deps.bm25 ? "rrf" : "disabled",
    bm25_vocab_size: deps.bm25?.vocabSize ?? 0,
  };

  log.info("memory_status", result);

  return result;
}
