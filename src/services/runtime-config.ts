/**
 * @module runtime-config
 * @description 运行时配置管理 — JSON 文件持久化 + 内存热缓存。
 *
 * 职责:
 * - 管理可在运行时变更的配置项
 * - 配置变更持久化到 JSON 文件（跨重启保留）
 * - 提供默认值 → 运行时覆盖的合并策略
 *
 * 设计:
 * - 初始值来自 AppConfig (环境变量解析结果)
 * - 运行时变更写入 ~/.easy-memory-runtime-config.json
 * - 下次启动时: 环境变量 → 运行时覆盖 → 最终值
 *
 * 铁律: 绝对禁止 console.log (MCP stdio 依赖)
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { log } from "../utils/logger.js";
import type {
  RuntimeConfig,
  UpdateRuntimeConfigInput,
} from "../types/admin-schema.js";

// =========================================================================
// Configuration
// =========================================================================

/**
 * 配置变更回调 — 通知下游服务响应运行时配置变化。
 */
export type RuntimeConfigChangeListener = (
  newConfig: RuntimeConfig,
  changedKeys: string[],
) => void;

export interface RuntimeConfigManagerOptions {
  /** 持久化文件路径 */
  configPath?: string;
  /** 初始默认值 (来自环境变量) */
  defaults: RuntimeConfig;
}

// =========================================================================
// RuntimeConfigManager
// =========================================================================

export class RuntimeConfigManager {
  private readonly configPath: string;
  private readonly defaults: RuntimeConfig;
  private overrides: Partial<RuntimeConfig> = {};

  /** 当前合并后的 effective 配置 */
  private current: RuntimeConfig;

  /** 变更监听器列表 */
  private listeners: RuntimeConfigChangeListener[] = [];

  constructor(options: RuntimeConfigManagerOptions) {
    this.configPath =
      options.configPath ??
      join(process.env.HOME ?? "/tmp", ".easy-memory-runtime-config.json");
    this.defaults = { ...options.defaults };

    // 加载持久化的覆盖
    this.overrides = this.loadOverrides();

    // 合并: defaults + overrides
    this.current = this.merge();

    log.info("RuntimeConfigManager initialized", {
      configPath: this.configPath,
      overrideCount: Object.keys(this.overrides).length,
    });
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * 获取当前 effective 配置。
   */
  getConfig(): RuntimeConfig {
    return { ...this.current };
  }

  /**
   * 获取默认配置 (环境变量值)。
   */
  getDefaults(): RuntimeConfig {
    return { ...this.defaults };
  }

  /**
   * 获取当前运行时覆盖。
   */
  getOverrides(): Partial<RuntimeConfig> {
    return { ...this.overrides };
  }

  /**
   * 更新运行时配置。
   * 仅变更提供的字段，其他保持不变。
   *
   * @returns 更新后的 effective 配置
   */
  updateConfig(input: UpdateRuntimeConfigInput): RuntimeConfig {
    // 应用变更到 overrides
    const changedKeys: string[] = [];
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined) {
        (this.overrides as Record<string, unknown>)[key] = value;
        changedKeys.push(key);
      }
    }

    // 重新合并
    this.current = this.merge();

    // 持久化
    this.persistOverrides();

    log.info("Runtime config updated", {
      changes: changedKeys,
    });

    // 通知监听器
    if (changedKeys.length > 0) {
      this.notifyListeners(changedKeys);
    }

    return { ...this.current };
  }

  /**
   * 重置所有运行时覆盖，恢复到环境变量默认值。
   */
  resetConfig(): RuntimeConfig {
    const previousKeys = Object.keys(this.overrides);
    this.overrides = {};
    this.current = this.merge();
    this.persistOverrides();

    log.info("Runtime config reset to defaults");

    // 通知监听器: 所有之前被覆盖的 key 都已恢复
    if (previousKeys.length > 0) {
      this.notifyListeners(previousKeys);
    }

    return { ...this.current };
  }

  /**
   * 检查某个配置项是否被运行时覆盖。
   */
  isOverridden(key: keyof RuntimeConfig): boolean {
    return key in this.overrides;
  }

  /**
   * 注册配置变更监听器。
   *
   * 当 `updateConfig()` 或 `resetConfig()` 被调用时，
   * 所有注册的监听器会收到新配置和变更的 key 列表。
   *
   * @returns 取消注册函数
   */
  onChange(listener: RuntimeConfigChangeListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  /**
   * 通知所有监听器配置已变更。
   */
  private notifyListeners(changedKeys: string[]): void {
    const config = { ...this.current };
    for (const listener of this.listeners) {
      try {
        listener(config, changedKeys);
      } catch (err) {
        log.error("Runtime config change listener error", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // =========================================================================
  // Internal
  // =========================================================================

  /**
   * 合并 defaults + overrides → effective config。
   */
  private merge(): RuntimeConfig {
    return {
      ...this.defaults,
      ...this.overrides,
    } as RuntimeConfig;
  }

  /**
   * 从文件加载持久化的覆盖。
   */
  private loadOverrides(): Partial<RuntimeConfig> {
    try {
      if (!existsSync(this.configPath)) return {};
      const raw = readFileSync(this.configPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        return {};
      }
      return parsed as Partial<RuntimeConfig>;
    } catch {
      log.warn("Failed to load runtime config overrides, using defaults", {
        configPath: this.configPath,
      });
      return {};
    }
  }

  /**
   * 持久化覆盖到文件。
   */
  private persistOverrides(): void {
    try {
      writeFileSync(
        this.configPath,
        JSON.stringify(this.overrides, null, 2),
        "utf-8",
      );
    } catch (err) {
      log.error("Failed to persist runtime config", {
        error: err instanceof Error ? err.message : String(err),
        configPath: this.configPath,
      });
    }
  }
}
