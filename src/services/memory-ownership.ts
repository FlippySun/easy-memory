/**
 * @module services/memory-ownership
 * @description Legacy memory ownership remediation and stable owner backfill.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ApiKeyManager } from "./api-key-manager.js";
import type { QdrantService } from "./qdrant.js";
import { DATA_PATHS } from "../utils/paths.js";
import { log } from "../utils/logger.js";

const DEFAULT_SCAN_PAGE_SIZE = 100;
const DEFAULT_LIMIT = 1000;
const DEFAULT_SAMPLE_SIZE = 25;

type OwnershipEvidence = {
  keyPrefix: string;
  source: "mcp_audit_memory_id";
};

type RemediationDecision =
  | {
      status: "skip";
      reason:
        | "already_resolved"
        | "system_owned"
        | "missing_user_history"
        | "no_deterministic_evidence"
        | "conflicting_evidence";
    }
  | {
      status: "update";
      reason: "prefix_history" | "mcp_audit_memory_id";
      updates: Record<string, unknown>;
    };

export interface OwnershipRemediationOptions {
  mode?: "dry_run" | "apply";
  project?: string;
  limit?: number;
}

export interface OwnershipRemediationSample {
  point_id: string;
  project: string;
  reason: string;
  updates?: Record<string, unknown>;
}

export interface OwnershipRemediationResult {
  ok: true;
  mode: "dry_run" | "apply";
  batch_id: string;
  scanned_projects: number;
  inspected_points: number;
  planned_updates: number;
  applied_updates: number;
  prefix_history_matches: number;
  mcp_audit_matches: number;
  already_resolved: number;
  system_owned_skipped: number;
  unresolved: number;
  unresolved_samples: OwnershipRemediationSample[];
  applied_samples: OwnershipRemediationSample[];
}

export interface MemoryOwnershipServiceConfig {
  qdrant: QdrantService;
  apiKeyManager: ApiKeyManager;
  auditLogPath?: string;
  maxRotatedFiles?: number;
}

export class MemoryOwnershipService {
  private readonly qdrant: QdrantService;
  private readonly apiKeyManager: ApiKeyManager;
  private readonly auditLogPath: string;
  private readonly maxRotatedFiles: number;

  constructor(config: MemoryOwnershipServiceConfig) {
    this.qdrant = config.qdrant;
    this.apiKeyManager = config.apiKeyManager;
    this.auditLogPath = config.auditLogPath ?? DATA_PATHS.auditLog;
    this.maxRotatedFiles = config.maxRotatedFiles ?? 5;
  }

  async remediateOwnership(
    options: OwnershipRemediationOptions = {},
  ): Promise<OwnershipRemediationResult> {
    const mode = options.mode ?? "dry_run";
    const batchId = randomUUID();
    const limit = options.limit ?? DEFAULT_LIMIT;

    const ownershipEvidence = await this.loadOwnershipEvidence();
    const targetCollections = options.project
      ? [{ project: options.project, name: `em_${options.project}` }]
      : await this.qdrant.listAllCollections();

    const result: OwnershipRemediationResult = {
      ok: true,
      mode,
      batch_id: batchId,
      scanned_projects: targetCollections.length,
      inspected_points: 0,
      planned_updates: 0,
      applied_updates: 0,
      prefix_history_matches: 0,
      mcp_audit_matches: 0,
      already_resolved: 0,
      system_owned_skipped: 0,
      unresolved: 0,
      unresolved_samples: [],
      applied_samples: [],
    };

    let remaining = limit;

    for (const collection of targetCollections) {
      if (remaining <= 0) break;

      let offset: string | null = null;

      while (remaining > 0) {
        const pageSize = Math.min(DEFAULT_SCAN_PAGE_SIZE, remaining);
        const page = await this.qdrant.scrollPoints(collection.project, {
          limit: pageSize,
          offset,
          filter: this.buildCandidateFilter(),
        });

        if (page.points.length === 0) {
          break;
        }

        for (const point of page.points) {
          if (remaining <= 0) break;
          remaining -= 1;
          result.inspected_points += 1;

          let decision = this.planOwnershipUpdate(
            point.id,
            point.payload,
            ownershipEvidence,
          );

          if (decision.status === "skip") {
            this.recordSkip(
              result,
              point.id,
              collection.project,
              decision.reason,
            );
            continue;
          }

          result.planned_updates += 1;
          if (decision.reason === "prefix_history") {
            result.prefix_history_matches += 1;
          } else {
            result.mcp_audit_matches += 1;
          }

          if (result.applied_samples.length < DEFAULT_SAMPLE_SIZE) {
            result.applied_samples.push({
              point_id: point.id,
              project: collection.project,
              reason: decision.reason,
              updates: decision.updates,
            });
          }

          if (mode === "apply") {
            const latestPayload = await this.qdrant.getPointPayload(
              collection.project,
              point.id,
            );
            if (!latestPayload) {
              continue;
            }

            decision = this.planOwnershipUpdate(
              point.id,
              latestPayload,
              ownershipEvidence,
            );
            if (decision.status === "skip") {
              this.recordSkip(
                result,
                point.id,
                collection.project,
                decision.reason,
              );
              continue;
            }

            const guardedUpdates = this.guardUpdates(
              latestPayload,
              decision.updates,
            );
            if (Object.keys(guardedUpdates).length === 0) {
              result.already_resolved += 1;
              continue;
            }

            await this.qdrant.setPayload(
              collection.project,
              point.id,
              guardedUpdates,
            );
            result.applied_updates += 1;
          }
        }

        if (!page.next_offset || page.points.length < pageSize) {
          break;
        }
        offset = page.next_offset;
      }
    }

    return result;
  }

  private buildCandidateFilter(): Record<string, unknown> {
    return {
      must: [
        {
          should: [
            { is_empty: { key: "owner_user_id" } },
            { is_empty: { key: "owner_key_prefix" } },
            { key: "owner_key_prefix", match: { value: "" } },
          ],
        },
      ],
    };
  }

  private planOwnershipUpdate(
    pointId: string,
    payload: Record<string, unknown>,
    ownershipEvidence: Map<string, OwnershipEvidence>,
  ): RemediationDecision {
    const ownerPrefix = String(payload.owner_key_prefix ?? "");
    const ownerUserId = this.readOwnerUserId(payload.owner_user_id);
    const auditEvidence = ownershipEvidence.get(pointId);

    if (ownerUserId != null) {
      if (ownerPrefix.length > 0) {
        return { status: "skip", reason: "already_resolved" };
      }

      if (!auditEvidence) {
        return { status: "skip", reason: "already_resolved" };
      }

      return {
        status: "update",
        reason: auditEvidence.source,
        updates: { owner_key_prefix: auditEvidence.keyPrefix },
      };
    }

    if (ownerPrefix.length > 0) {
      if (ownerPrefix === "master" || ownerPrefix === "stdio") {
        return { status: "skip", reason: "system_owned" };
      }

      if (auditEvidence && auditEvidence.keyPrefix !== ownerPrefix) {
        return { status: "skip", reason: "conflicting_evidence" };
      }

      if (ownerUserId != null) {
        return { status: "skip", reason: "already_resolved" };
      }

      const mappedUserId = this.apiKeyManager.getUserIdByPrefix(ownerPrefix);
      if (mappedUserId == null) {
        return { status: "skip", reason: "missing_user_history" };
      }

      return {
        status: "update",
        reason: "prefix_history",
        updates: { owner_user_id: mappedUserId },
      };
    }

    if (!auditEvidence) {
      return { status: "skip", reason: "no_deterministic_evidence" };
    }

    const updates: Record<string, unknown> = {
      owner_key_prefix: auditEvidence.keyPrefix,
    };
    const mappedUserId = this.apiKeyManager.getUserIdByPrefix(
      auditEvidence.keyPrefix,
    );
    if (mappedUserId != null) {
      updates.owner_user_id = mappedUserId;
    }

    return {
      status: "update",
      reason: auditEvidence.source,
      updates,
    };
  }

  private guardUpdates(
    payload: Record<string, unknown>,
    proposed: Record<string, unknown>,
  ): Record<string, unknown> {
    const updates: Record<string, unknown> = {};

    if (
      proposed.owner_user_id != null &&
      this.readOwnerUserId(payload.owner_user_id) == null
    ) {
      updates.owner_user_id = proposed.owner_user_id;
    }

    if (
      proposed.owner_key_prefix != null &&
      String(payload.owner_key_prefix ?? "").length === 0
    ) {
      updates.owner_key_prefix = proposed.owner_key_prefix;
    }

    return updates;
  }

  private readOwnerUserId(value: unknown): number | null {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      return value;
    }
    if (typeof value === "string" && /^\d+$/.test(value)) {
      return Number(value);
    }
    return null;
  }

  private recordSkip(
    result: OwnershipRemediationResult,
    pointId: string,
    project: string,
    reason: RemediationDecision["reason"],
  ): void {
    if (reason === "already_resolved") {
      result.already_resolved += 1;
      return;
    }
    if (reason === "system_owned") {
      result.system_owned_skipped += 1;
      return;
    }

    result.unresolved += 1;
    if (result.unresolved_samples.length < DEFAULT_SAMPLE_SIZE) {
      result.unresolved_samples.push({
        point_id: pointId,
        project,
        reason,
      });
    }
  }

  private async loadOwnershipEvidence(): Promise<
    Map<string, OwnershipEvidence>
  > {
    const evidence = new Map<string, OwnershipEvidence>();
    const conflicts = new Set<string>();

    for (const path of this.listAuditLogCandidates()) {
      const lines = await this.readJsonLines(path);
      for (const line of lines) {
        if (
          line.operation !== "memory_save" ||
          line.outcome !== "success" ||
          typeof line.memory_id !== "string" ||
          typeof line.key_prefix !== "string" ||
          line.key_prefix.length === 0
        ) {
          continue;
        }

        const memoryId = line.memory_id;
        const keyPrefix = line.key_prefix;
        if (conflicts.has(memoryId)) continue;
        if (!this.isDeterministicEvidencePrefix(keyPrefix)) {
          continue;
        }

        const existing = evidence.get(memoryId);
        if (!existing) {
          evidence.set(memoryId, {
            keyPrefix,
            source: "mcp_audit_memory_id",
          });
          continue;
        }

        if (existing.keyPrefix !== keyPrefix) {
          evidence.delete(memoryId);
          conflicts.add(memoryId);
        }
      }
    }

    log.info("Loaded memory ownership evidence", {
      auditLogPath: this.auditLogPath,
      evidenceCount: evidence.size,
      conflictCount: conflicts.size,
    });

    return evidence;
  }

  private isDeterministicEvidencePrefix(prefix: string): boolean {
    if (prefix === "master" || prefix === "stdio") {
      return true;
    }
    return this.apiKeyManager.hasRecordedPrefix(prefix);
  }

  private listAuditLogCandidates(): string[] {
    const paths = [this.auditLogPath];
    for (let i = 1; i <= this.maxRotatedFiles; i++) {
      paths.push(`${this.auditLogPath}.${i}`);
    }
    return paths;
  }

  private async readJsonLines(
    path: string,
  ): Promise<Array<Record<string, unknown>>> {
    try {
      const content = await readFile(path, "utf-8");
      return content
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as Record<string, unknown>];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  }
}
