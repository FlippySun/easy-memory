/**
 * @module qdrant
 * @description Qdrant 向量数据库客户端封装。
 *
 * 铁律 [CORE_SCHEMA §3.1]: upsert 必须 wait:true
 * 铁律 [CORE_SCHEMA §3.2]: 初始化必须带 apiKey
 * 铁律 [CORE_SCHEMA §3.7]: Collection 名称必须 em_${slugify(project)}
 */

import { QdrantClient } from "@qdrant/js-client-rest";
import { collectionName, THRESHOLDS } from "../types/schema.js";
import { log } from "../utils/logger.js";

/** Qdrant 上传点结构 */
export interface QdrantPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

/** Qdrant 搜索结果 */
export interface QdrantSearchResult {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

export interface QdrantServiceConfig {
  url: string;
  apiKey: string;
  embeddingDimension?: number;
}

/**
 * Qdrant 服务封装类。
 * - 初始化时必须提供 apiKey（安全铁律）
 * - upsert 强制 wait:true
 * - 自动创建 collection（如不存在）
 */
export class QdrantService {
  private readonly client: QdrantClient;
  private readonly embeddingDimension: number;
  private readonly initializedCollections = new Set<string>();

  constructor(config: QdrantServiceConfig) {
    if (!config.apiKey) {
      throw new Error("Qdrant API Key is required [CORE_SCHEMA §3.2]");
    }
    this.client = new QdrantClient({
      url: config.url,
      apiKey: config.apiKey,
    });
    this.embeddingDimension = config.embeddingDimension ?? 768;
  }

  /**
   * D3-2: 验证 Qdrant 连接可用，使用 3 次指数退避重试。
   * 调用时机：服务启动时，在处理任何请求之前。
   * 重试间隔：1s → 2s → 4s（共 ~7s）
   */
  async ensureConnected(): Promise<void> {
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await this.client.getCollections();
        log.info("Qdrant connection verified");
        return;
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (attempt === maxAttempts - 1) {
          log.error("Qdrant connection failed after all retries", {
            error: error.message,
            attempts: maxAttempts,
          });
          throw error;
        }
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        log.warn(
          `Qdrant connection attempt ${attempt + 1}/${maxAttempts} failed, retrying in ${delay}ms`,
          { error: error.message },
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  /**
   * 确保 collection 存在，如果不存在则创建。
   *
   * D-AUDIT: 修复 TOCTOU 竞态 — 并发请求可能同时检测 exists=false 后同时创建，
   * 第二个 createCollection 会抛 "already exists" 错误。
   * 防御策略：catch createCollection 的 "already exists" 错误并视为成功。
   */
  async ensureCollection(project: string): Promise<string> {
    const name = collectionName(project);

    if (this.initializedCollections.has(name)) {
      return name;
    }

    try {
      const exists = await this.client.collectionExists(name);
      if (!exists.exists) {
        log.info(`Creating Qdrant collection: ${name}`);
        try {
          await this.client.createCollection(name, {
            vectors: {
              size: this.embeddingDimension,
              distance: "Cosine",
            },
          });
        } catch (createErr: unknown) {
          // D-AUDIT: TOCTOU 竞态防御 — 另一个并发请求可能已创建该 collection
          const createError =
            createErr instanceof Error
              ? createErr
              : new Error(String(createErr));
          if (
            createError.message.includes("already exists") ||
            createError.message.includes("Already exists")
          ) {
            log.info(
              `Collection ${name} created by concurrent request, proceeding`,
            );
          } else {
            throw createErr;
          }
        }
      }
      this.initializedCollections.add(name);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error("Failed to ensure Qdrant collection", {
        collection: name,
        error: error.message,
      });
      throw error;
    }

    return name;
  }

  /**
   * 写入向量点。强制 wait:true [CORE_SCHEMA §3.1]。
   */
  async upsert(project: string, points: QdrantPoint[]): Promise<void> {
    const name = await this.ensureCollection(project);
    await this.client.upsert(name, {
      points: points.map((p) => ({
        id: p.id,
        vector: p.vector,
        payload: p.payload,
      })),
      wait: true, // ⚠️ 铁律：绝对不能改为 false
    });
  }

  /**
   * 语义搜索。
   */
  async search(
    project: string,
    vector: number[],
    options: {
      limit?: number;
      scoreThreshold?: number;
      filter?: Record<string, unknown>;
    } = {},
  ): Promise<QdrantSearchResult[]> {
    const name = await this.ensureCollection(project);
    const {
      limit = THRESHOLDS.SEARCH_DEFAULT_LIMIT,
      scoreThreshold = THRESHOLDS.SEARCH_MIN_SCORE,
      filter,
    } = options;

    const searchParams: Record<string, unknown> = {
      vector,
      limit,
      score_threshold: scoreThreshold,
      with_payload: true,
    };
    if (filter) {
      searchParams.filter = filter;
    }

    const results = await this.client.search(
      name,
      searchParams as Parameters<typeof this.client.search>[1],
    );

    return results.map((r) => ({
      id: typeof r.id === "string" ? r.id : String(r.id),
      score: r.score,
      payload: (r.payload as Record<string, unknown>) ?? {},
    }));
  }

  /**
   * 通过 setPayload 更新点的 payload（用于 forget 软删除等）。
   */
  async setPayload(
    project: string,
    pointId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const name = await this.ensureCollection(project);
    await this.client.setPayload(name, {
      points: [pointId],
      payload,
      wait: true,
    });
  }

  /**
   * 获取 collection 信息。
   */
  async getCollectionInfo(
    project: string,
  ): Promise<{ name: string; points_count: number } | null> {
    const name = collectionName(project);
    try {
      const info = await this.client.getCollection(name);
      return {
        name,
        points_count: info.points_count ?? 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * 健康检查。
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.client.getCollections();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * D3-6: 清理资源。Qdrant REST 客户端无长连接需关闭，
   * 但清空已初始化集合缓存以防再次使用时出现过时状态。
   */
  close(): void {
    this.initializedCollections.clear();
  }
}
