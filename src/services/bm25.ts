/**
 * @module bm25
 * @description 应用层 BM25 稀疏向量编码器。
 *
 * 设计决策 [ADR 补充二十]:
 * - 纯 JS 实现，零外部依赖（无 model inference 开销）
 * - 使用 FNV-1a hash 实现 term→index 的确定性映射
 * - CJK 字符单字分词 + 英文 word-level 分词
 * - BM25 TF 分量作为 sparse vector values（无 IDF，由 RRF 融合补偿）
 *
 * 用途: 与 dense vector（bge-m3 1024d）配合，通过 RRF 融合实现混合检索。
 * sparse vector 捕获关键词精确匹配，dense vector 捕获语义相似度。
 */

/** Qdrant 兼容的稀疏向量结构 */
export interface SparseVector {
  /** 词项索引（唯一，已排序） */
  indices: number[];
  /** 对应权重值（与 indices 等长） */
  values: number[];
}

export interface BM25Config {
  /** Hash 空间大小（default: 30000）。越大碰撞越少，但稀疏度越高 */
  vocabSize?: number;
  /** 词频饱和参数（default: 1.2）。越大，高频词的权重增长越慢 */
  k1?: number;
  /** 文档长度归一化参数（default: 0.75）。0=不归一化，1=完全归一化 */
  b?: number;
  /** 假设的平均文档长度（default: 256 tokens）。用于长度归一化 */
  avgDocLength?: number;
}

/**
 * 英文 stop words（高频低信息量词）。
 * 精简集合，覆盖最常见的功能词。中文无需 stop words（单字分词粒度足够小）。
 */
const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "and",
  "but",
  "or",
  "nor",
  "not",
  "so",
  "yet",
  "both",
  "either",
  "neither",
  "each",
  "every",
  "all",
  "any",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "only",
  "own",
  "same",
  "than",
  "too",
  "very",
  "just",
  "because",
  "if",
  "when",
  "where",
  "how",
  "what",
  "which",
  "who",
  "whom",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "he",
  "she",
  "they",
  "we",
  "you",
  "i",
  "me",
  "him",
  "her",
  "us",
  "them",
  "my",
  "your",
  "his",
  "our",
  "their",
]);

/**
 * 分词正则：匹配 CJK 单字 + ASCII 字母/数字序列。
 *
 * CJK 范围:
 * - \u4e00-\u9fff: CJK 统一汉字（基本集）
 * - \u3400-\u4dbf: CJK 统一汉字扩展 A
 * - \uf900-\ufaff: CJK 兼容汉字
 * - \u3000-\u303f: CJK 标点（过滤，不匹配）
 */
const TOKEN_PATTERN = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]|[a-z0-9]+/g;

/**
 * BM25 稀疏向量编码器。
 *
 * 将文本转换为 Qdrant 兼容的 sparse vector，用于关键词精确匹配。
 * 与 dense vector 的 RRF 融合可显著提升"精确术语 + 语义理解"混合检索效果。
 */
export class BM25Encoder {
  readonly vocabSize: number;
  private readonly k1: number;
  private readonly b: number;
  private readonly avgDocLength: number;

  constructor(config: BM25Config = {}) {
    this.vocabSize = config.vocabSize ?? 30000;
    this.k1 = config.k1 ?? 1.2;
    this.b = config.b ?? 0.75;
    this.avgDocLength = config.avgDocLength ?? 256;
  }

  /**
   * 将文本编码为稀疏向量。
   *
   * Pipeline: text → lowercase → tokenize → stop words 过滤 →
   *           term frequency → BM25 TF score → hash → sparse vector
   *
   * @param text 待编码文本
   * @returns Qdrant 兼容的 SparseVector（indices 已排序且唯一）
   */
  encode(text: string): SparseVector {
    const tokens = this.tokenize(text);
    if (tokens.length === 0) {
      return { indices: [], values: [] };
    }

    // 计算词频 (Term Frequency)
    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }

    // 计算 BM25 TF 分量，通过 hash 映射到 index
    const docLen = tokens.length;
    const entries = new Map<number, number>();

    for (const [term, count] of tf) {
      const index = this.hashTerm(term);

      // BM25 TF 公式: (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgdl))
      const tfScore =
        (count * (this.k1 + 1)) /
        (count +
          this.k1 * (1 - this.b + this.b * (docLen / this.avgDocLength)));

      // Hash 碰撞时累加分数（vocabSize=30000 时碰撞率极低）
      entries.set(index, (entries.get(index) ?? 0) + tfScore);
    }

    // 按 index 排序（Qdrant 要求 indices 有序）
    const sorted = [...entries.entries()].sort((a, b) => a[0] - b[0]);

    return {
      indices: sorted.map(([i]) => i),
      values: sorted.map(([, v]) => v),
    };
  }

  /**
   * 分词器：CJK 单字 + 英文 word-level + stop words 过滤。
   *
   * @param text 原始文本
   * @returns 过滤后的 token 数组
   */
  tokenize(text: string): string[] {
    const normalized = text.toLowerCase().trim();
    if (normalized.length === 0) return [];

    const tokens: string[] = [];
    let match: RegExpExecArray | null;

    // 重置 regex lastIndex（全局正则需要每次重置）
    TOKEN_PATTERN.lastIndex = 0;
    while ((match = TOKEN_PATTERN.exec(normalized)) !== null) {
      const token = match[0];
      if (token.length > 0 && !STOP_WORDS.has(token)) {
        tokens.push(token);
      }
    }

    return tokens;
  }

  /**
   * FNV-1a 32-bit hash → 确定性 index 映射。
   *
   * 特性:
   * - 确定性：同一 term 永远映射到同一 index
   * - 分布均匀：FNV-1a 在短字符串上分布优秀
   * - 高效：O(n) 字符串长度
   *
   * @param term 词项
   * @returns [0, vocabSize) 范围内的整数索引
   */
  hashTerm(term: string): number {
    let hash = 0x811c9dc5; // FNV offset basis (32-bit)
    for (let i = 0; i < term.length; i++) {
      hash ^= term.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193); // FNV prime
      hash = hash >>> 0; // 强制无符号 32-bit
    }
    return hash % this.vocabSize;
  }
}
