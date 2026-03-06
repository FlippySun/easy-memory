/**
 * @module qdrant
 * @description Qdrant 向量数据库客户端封装。
 *
 * 铁律 [CORE_SCHEMA §3.1]: upsert 必须 wait:true
 * 铁律 [CORE_SCHEMA §3.2]: 初始化必须带 apiKey
 * 铁律 [CORE_SCHEMA §3.7]: Collection 名称必须 em_${slugify(project)}
 *
 * [ADR 补充二十] Dense + Sparse + RRF 混合检索:
 * - Collection 使用 named vectors: dense (1024d Cosine) + sparse (bm25)
 * - upsert 同时写入 dense + sparse 向量
 * - hybridSearch 使用 prefetch + RRF fusion
 */

import { QdrantClient } from "@qdrant/js-client-rest";
import { collectionName, THRESHOLDS } from "../types/schema.js";
import { log } from "../utils/logger.js";
import type { SparseVector } from "./bm25.js";

/** Qdrant 上传点结构 */
export interface QdrantPoint {
  id: string;
  vector: number[];
  /** BM25 稀疏向量（可选，用于混合检索） */
  sparseVector?: SparseVector;
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
    this.embeddingDimension = config.embeddingDimension ?? 1024;
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
   * 确保 collection 存在且向量配置兼容。
   *
   * D-AUDIT: 修复 TOCTOU 竞态 — 并发请求可能同时检测 exists=false 后同时创建，
   * 第二个 createCollection 会抛 "already exists" 错误。
   * 防御策略：catch createCollection 的 "already exists" 错误并视为成功。
   *
   * [FIX C-2]: 旧 collection 迁移检测 — 如果 collection 已存在但向量配置不兼容
   * （如旧版 unnamed vectors 768d vs 新版 named vectors "dense" 1024d），
   * 拒绝启动并提供明确的迁移指引，避免运行时 400 错误。
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
              dense: {
                size: this.embeddingDimension,
                distance: "Cosine",
              },
            },
            sparse_vectors: {
              bm25: {},
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
      } else {
        // [FIX C-2]: 验证已有 collection 的向量配置兼容性
        await this.validateCollectionConfig(name);
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
   * [FIX C-2]: 验证已有 collection 的向量配置是否与当前预期兼容。
   *
   * 检测场景：
   * - 旧版使用 unnamed vectors (768d) → 新版需要 named vectors "dense" (1024d)
   * - 维度不匹配（如 768 vs 1024）
   *
   * 不兼容时抛出描述性错误，而非运行时 400。
   */
  private async validateCollectionConfig(name: string): Promise<void> {
    try {
      const info = await this.client.getCollection(name);
      const vectorsConfig = info.config?.params?.vectors;

      if (!vectorsConfig) {
        // 无法获取向量配置 — 保守通过（可能是老版本 Qdrant 不返回此字段）
        log.warn(
          `Cannot verify vector config for collection ${name}, proceeding cautiously`,
        );
        return;
      }

      // Case 1: Unnamed vector (旧版模式) — 没有 "dense" 命名向量
      if (
        typeof vectorsConfig === "object" &&
        "size" in vectorsConfig &&
        !("dense" in vectorsConfig)
      ) {
        const oldSize = (vectorsConfig as { size: number }).size;
        throw new Error(
          `Collection "${name}" uses legacy unnamed vectors (${oldSize}d). ` +
            `Current version requires named vectors ("dense": ${this.embeddingDimension}d). ` +
            `Migration required: backup data, delete collection, and re-import. ` +
            `See README.md for migration guide.`,
        );
      }

      // Case 2: Named vector "dense" 存在但维度不匹配
      if (typeof vectorsConfig === "object" && "dense" in vectorsConfig) {
        const denseConfig = (vectorsConfig as Record<string, { size?: number }>)
          .dense;
        if (denseConfig?.size && denseConfig.size !== this.embeddingDimension) {
          throw new Error(
            `Collection "${name}" dense vector dimension mismatch: ` +
              `existing=${denseConfig.size}, expected=${this.embeddingDimension}. ` +
              `This may indicate a model change (e.g., nomic-embed-text 768d → bge-m3 1024d). ` +
              `Migration required: backup data, delete collection, and re-import with new model.`,
          );
        }
      }
    } catch (err: unknown) {
      // 如果是我们自己抛的兼容性错误，直接重新抛出
      if (err instanceof Error && err.message.includes("Migration required")) {
        throw err;
      }
      // 其他错误（如网络问题获取集合信息失败）— 记录警告但不阻断
      const error = err instanceof Error ? err : new Error(String(err));
      log.warn(
        `Failed to validate collection config for ${name}, proceeding cautiously`,
        { error: error.message },
      );
    }
  }

  /**
   * 写入向量点。强制 wait:true [CORE_SCHEMA §3.1]。
   * 使用 named vectors: dense (必须) + bm25 sparse (可选)。
   */
  async upsert(project: string, points: QdrantPoint[]): Promise<void> {
    const name = await this.ensureCollection(project);
    await this.client.upsert(name, {
      points: points.map((p) => ({
        id: p.id,
        vector: {
          dense: p.vector,
          ...(p.sparseVector
            ? {
                bm25: {
                  indices: p.sparseVector.indices,
                  values: p.sparseVector.values,
                },
              }
            : {}),
        },
        payload: p.payload,
      })),
      wait: true, // ⚠️ 铁律：绝对不能改为 false
    });
  }

  /**
   * 纯 Dense 语义搜索（使用 named vector "dense"）。
   * 向后兼容接口 — 仅使用稠密向量检索。
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

    const queryParams: Record<string, unknown> = {
      query: vector,
      using: "dense",
      limit,
      score_threshold: scoreThreshold,
      with_payload: true,
    };
    if (filter) {
      queryParams.filter = filter;
    }

    const result = await this.client.query(
      name,
      queryParams as Parameters<typeof this.client.query>[1],
    );

    return (result.points ?? []).map((r) => ({
      id: typeof r.id === "string" ? r.id : String(r.id),
      score: r.score ?? 0,
      payload: (r.payload as Record<string, unknown>) ?? {},
    }));
  }

  /**
   * Dense + Sparse + RRF 混合检索 [ADR 补充二十]。
   *
   * 工作流：
   * 1. prefetch 阶段：分别用 dense 和 bm25 sparse 向量各召回 prefetchLimit 个候选
   * 2. fusion 阶段：Qdrant 内置 RRF (Reciprocal Rank Fusion) 合并两路结果
   * 3. 返回 top-K 最终结果
   *
   * 当 sparseVector 为空或 undefined 时，自动降级为纯 dense 搜索。
   */
  async hybridSearch(
    project: string,
    denseVector: number[],
    sparseVector: SparseVector | undefined,
    options: {
      limit?: number;
      scoreThreshold?: number;
      filter?: Record<string, unknown>;
    } = {},
  ): Promise<QdrantSearchResult[]> {
    // 降级：无稀疏向量时走纯 dense 路径
    if (!sparseVector || sparseVector.indices.length === 0) {
      return this.search(project, denseVector, options);
    }

    const name = await this.ensureCollection(project);
    const {
      limit = THRESHOLDS.SEARCH_DEFAULT_LIMIT,
      scoreThreshold,
      filter,
    } = options;

    // prefetch 召回量 = max(limit * 3, 20)，确保 RRF 有足够候选
    const prefetchLimit = Math.max(limit * 3, 20);

    // [FIX C-1]: scoreThreshold 加在 dense prefetch 子查询上（非 RRF 顶层）
    // 原因: RRF 分数是 rank-based fusion 分数，语义 ≠ cosine similarity
    // dense prefetch 过质量关，BM25 sparse 不加 threshold（score 语义不同）
    const densePrefetch: Record<string, unknown> = {
      query: denseVector,
      using: "dense",
      limit: prefetchLimit,
    };
    if (scoreThreshold != null) {
      densePrefetch.score_threshold = scoreThreshold;
    }
    // [FIX H-6]: filter 注入到 prefetch 子查询，避免召回不满足 lifecycle 过滤的候选
    if (filter) {
      densePrefetch.filter = filter;
    }

    const sparsePrefetch: Record<string, unknown> = {
      query: {
        indices: sparseVector.indices,
        values: sparseVector.values,
      },
      using: "bm25",
      limit: prefetchLimit,
    };
    // [FIX H-6]: sparse prefetch 同样注入 filter
    if (filter) {
      sparsePrefetch.filter = filter;
    }

    const prefetch: Record<string, unknown>[] = [densePrefetch, sparsePrefetch];

    const queryParams: Record<string, unknown> = {
      prefetch,
      query: { fusion: "rrf" },
      limit,
      with_payload: true,
    };
    // 顶层 filter 保留（双重保障：prefetch + fusion 两层都过滤）
    if (filter) {
      queryParams.filter = filter;
    }

    const result = await this.client.query(
      name,
      queryParams as Parameters<typeof this.client.query>[1],
    );

    return (result.points ?? []).map((r) => ({
      id: typeof r.id === "string" ? r.id : String(r.id),
      score: r.score ?? 0,
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
   * [FIX D12/C8]: 检索指定点的 payload，用于 forget 前验证点存在性和当前状态。
   * 返回 null 表示点不存在。
   */
  async getPointPayload(
    project: string,
    pointId: string,
  ): Promise<Record<string, unknown> | null> {
    const name = await this.ensureCollection(project);
    try {
      const result = await this.client.retrieve(name, {
        ids: [pointId],
        with_payload: true,
        with_vector: false,
      });
      if (!result || result.length === 0) return null;
      return (result[0].payload as Record<string, unknown>) ?? null;
    } catch {
      return null;
    }
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
   * v0.7.0: 分页浏览记忆点 — 用于 Memory Browser。
   * 使用 Qdrant scroll API，支持 offset-based 分页和过滤。
   */
  async scrollPoints(
    project: string,
    options: {
      limit?: number;
      offset?: string | null;
      filter?: Record<string, unknown>;
      withVector?: boolean;
    } = {},
  ): Promise<{
    points: Array<{ id: string; payload: Record<string, unknown> }>;
    next_offset: string | null;
  }> {
    const name = await this.ensureCollection(project);
    const { limit = 20, offset = null, filter, withVector = false } = options;

    const scrollRequest: Record<string, unknown> = {
      limit,
      with_payload: true,
      with_vector: withVector,
    };
    if (offset) {
      scrollRequest.offset = offset;
    }
    if (filter) {
      scrollRequest.filter = filter;
    }

    const result = await this.client.scroll(name, scrollRequest);

    const points = (result.points ?? []).map((p) => ({
      id: String(p.id),
      payload: (p.payload as Record<string, unknown>) ?? {},
    }));

    const nextOffset = result.next_page_offset
      ? String(result.next_page_offset)
      : null;

    return { points, next_offset: nextOffset };
  }

  /**
   * v0.7.0: 列出所有 em_* Collection 及各自的 points_count。
   * 用于 Memory Browser 存储分布统计和项目列表。
   */
  async listAllCollections(): Promise<
    Array<{ name: string; project: string; points_count: number }>
  > {
    const collectionsResponse = await this.client.getCollections();
    const collections = collectionsResponse.collections ?? [];

    const emCollections = collections.filter((c) => c.name.startsWith("em_"));

    const results: Array<{
      name: string;
      project: string;
      points_count: number;
    }> = [];
    for (const col of emCollections) {
      try {
        const info = await this.client.getCollection(col.name);
        results.push({
          name: col.name,
          project: col.name.replace(/^em_/, ""),
          points_count: info.points_count ?? 0,
        });
      } catch {
        // collection might have been deleted concurrently
        results.push({
          name: col.name,
          project: col.name.replace(/^em_/, ""),
          points_count: 0,
        });
      }
    }

    return results;
  }

  /**
   * D3-6: 清理资源。Qdrant REST 客户端无长连接需关闭，
   * 但清空已初始化集合缓存以防再次使用时出现过时状态。
   */
  close(): void {
    this.initializedCollections.clear();
  }
}
