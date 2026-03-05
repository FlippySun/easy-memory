import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerTools } from "../../src/mcp/server.js";
import type { AppContainer } from "../../src/container.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type ToolResponse = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResponse>;

describe("mcp/server registerTools 审计链路", () => {
  let handlers: Record<string, ToolHandler>;
  let buildEntryMock: ReturnType<typeof vi.fn>;
  let auditRecordMock: ReturnType<typeof vi.fn>;
  let analyticsIngestMock: ReturnType<typeof vi.fn>;
  let rateLimitCheckMock: ReturnType<typeof vi.fn>;
  let container: AppContainer;

  beforeEach(() => {
    handlers = {};

    buildEntryMock = vi.fn((params: Record<string, unknown>) => ({
      event_id: "evt-1",
      timestamp: new Date().toISOString(),
      key_prefix: String(params.keyPrefix ?? ""),
      user_agent: String(params.userAgent ?? ""),
      client_ip: String(params.clientIp ?? ""),
      operation: String(params.operation ?? "memory_status"),
      project: String(params.project ?? "default-project"),
      outcome: String(params.outcome ?? "success"),
      outcome_detail: String(params.outcomeDetail ?? ""),
      elapsed_ms: Number(params.elapsedMs ?? 0),
      http_method: String(params.httpMethod ?? "MCP"),
      http_path: String(params.httpPath ?? "mcp://stdio"),
      http_status: Number(params.httpStatus ?? 200),
      ...((params.extra as Record<string, unknown> | undefined) ?? {}),
    }));

    auditRecordMock = vi.fn();
    analyticsIngestMock = vi.fn();
    rateLimitCheckMock = vi.fn();

    container = {
      config: {
        defaultProject: "default-project",
      },
      qdrant: {
        hybridSearch: vi.fn().mockResolvedValue([
          {
            id: "mem-1",
            score: 0.91,
            payload: {
              content: "cached memory",
              fact_type: "observation",
              tags: ["ui"],
              source: "conversation",
              confidence: 0.8,
              lifecycle: "active",
              created_at: new Date().toISOString(),
            },
          },
        ]),
      },
      embedding: {
        embedWithMeta: vi.fn().mockResolvedValue({
          vector: new Array(8).fill(0.1),
          model: "bge-m3",
        }),
      },
      rateLimiter: {
        checkRate: rateLimitCheckMock,
      },
      bm25: {
        encode: vi.fn().mockReturnValue(undefined),
      },
      audit: {
        buildEntry: buildEntryMock,
        record: auditRecordMock,
      },
      analytics: {
        ingestEvent: analyticsIngestMock,
      },
    } as unknown as AppContainer;

    const fakeServer = {
      tool: vi.fn(
        (
          name: string,
          _description: string,
          _schema: unknown,
          handler: ToolHandler,
        ) => {
          handlers[name] = handler;
        },
      ),
    } as unknown as McpServer;

    registerTools(fakeServer, container, {
      auditContext: {
        keyPrefix: "key_pref",
        clientIp: "203.0.113.9",
        userAgent: "vitest-agent",
        httpMethod: "POST",
        httpPath: "/mcp",
      },
    });
  });

  it("memory_search 成功时写入 audit + analytics", async () => {
    const handler = handlers.memory_search;
    expect(handler).toBeDefined();

    const response = await handler({
      query: "ui contract drift",
      project: "web-ui",
      limit: 5,
      threshold: 0.55,
    });

    expect(response.isError).toBeUndefined();
    expect(buildEntryMock).toHaveBeenCalledTimes(1);
    expect(auditRecordMock).toHaveBeenCalledTimes(1);
    expect(analyticsIngestMock).toHaveBeenCalledTimes(1);

    const buildCall = buildEntryMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(buildCall.operation).toBe("memory_search");
    expect(buildCall.project).toBe("web-ui");
    expect(buildCall.outcome).toBe("success");
    expect(buildCall.httpMethod).toBe("POST");
    expect(buildCall.httpPath).toBe("/mcp");
    expect(buildCall.keyPrefix).toBe("key_pref");

    const extra = (buildCall.extra ?? {}) as Record<string, unknown>;
    expect(extra.result_count).toBe(1);
    expect(extra.search_hit).toBe(true);
    expect(extra.search_limit).toBe(5);
    expect(extra.search_threshold).toBe(0.55);
  });

  it("memory_search 限流时写入 rate_limited 审计", async () => {
    rateLimitCheckMock.mockImplementation(() => {
      throw new Error("Rate limit exceeded");
    });

    const handler = handlers.memory_search;
    const response = await handler({ query: "rate-limit-case" });

    const payload = JSON.parse(response.content[0]!.text) as {
      status: string;
      message: string;
    };
    expect(payload.status).toBe("rate_limited");

    expect(buildEntryMock).toHaveBeenCalledTimes(1);
    const buildCall = buildEntryMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(buildCall.outcome).toBe("rate_limited");
    expect(buildCall.httpStatus).toBe(429);
    expect(buildCall.operation).toBe("memory_search");

    expect(auditRecordMock).toHaveBeenCalledTimes(1);
    expect(analyticsIngestMock).toHaveBeenCalledTimes(1);
  });
});
