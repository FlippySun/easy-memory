import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ToolResponse = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResponse>;

const toolHandlers = new Map<string, ToolHandler>();
const connectMock = vi.fn().mockResolvedValue(undefined);
const closeMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => {
  class MockMcpServer {
    constructor(_meta: unknown) {}

    tool(
      name: string,
      _description: string,
      _schema: unknown,
      handler: ToolHandler,
    ) {
      toolHandlers.set(name, handler);
    }

    connect = connectMock;
    close = closeMock;
  }

  return { McpServer: MockMcpServer };
});

vi.mock("../../src/utils/logger.js", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../../src/utils/shutdown.js", () => ({
  setupGracefulShutdown: vi.fn(),
}));

vi.mock("../../src/transport/SafeStdioTransport.js", () => ({
  SafeStdioTransport: class {},
}));

describe("createRemoteMcpServer memory_forget mapping", () => {
  beforeEach(() => {
    toolHandlers.clear();
    connectMock.mockClear();
    closeMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers preferred easy_memory aliases", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ status: "ok" }),
        text: vi.fn().mockResolvedValue(""),
      }),
    );

    const { createRemoteMcpServer } =
      await import("../../src/mcp/remote-server.js");

    await createRemoteMcpServer("em_test_key", "https://memory.example.com");

    expect(toolHandlers.get("memory_save")).toBeDefined();
    expect(toolHandlers.get("memory_search")).toBeDefined();
    expect(toolHandlers.get("memory_forget")).toBeDefined();
    expect(toolHandlers.get("memory_status")).toBeDefined();
    expect(toolHandlers.get("easy_memory_save")).toBeDefined();
    expect(toolHandlers.get("easy_memory_search")).toBeDefined();
    expect(toolHandlers.get("easy_memory_forget")).toBeDefined();
    expect(toolHandlers.get("easy_memory_status")).toBeDefined();
  });

  it("easy_memory_search 与 memory_search 走相同远端路径并返回一致结果", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        memories: [{ id: "mem-1", score: 0.9 }],
      }),
      text: vi.fn().mockResolvedValue(""),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { createRemoteMcpServer } =
      await import("../../src/mcp/remote-server.js");

    await createRemoteMcpServer("em_test_key", "https://memory.example.com");

    const canonical = await toolHandlers.get("memory_search")!({
      query: "priority policy",
      project: "demo",
    });
    const alias = await toolHandlers.get("easy_memory_search")!({
      query: "priority policy",
      project: "demo",
    });

    expect(alias).toEqual(canonical);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://memory.example.com/api/search",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://memory.example.com/api/search",
    );
  });

  it("should send id/action/reason payload to /api/forget", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ status: "archived" }),
      text: vi.fn().mockResolvedValue(""),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { createRemoteMcpServer } =
      await import("../../src/mcp/remote-server.js");

    await createRemoteMcpServer("em_test_key", "https://memory.example.com");

    const forgetHandler = toolHandlers.get("memory_forget");
    expect(forgetHandler).toBeDefined();

    const res = await forgetHandler!({
      id: "550e8400-e29b-41d4-a716-446655440000",
      action: "outdated",
      reason: "superseded",
      project: "demo",
    });

    expect(res.isError).toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0] as [string, { body?: string }];
    expect(url).toBe("https://memory.example.com/api/forget");

    const body = JSON.parse(init.body ?? "{}");
    expect(body).toEqual({
      id: "550e8400-e29b-41d4-a716-446655440000",
      action: "outdated",
      reason: "superseded",
      project: "demo",
    });
  });

  it("should support legacy memory_id by mapping it to id", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ status: "archived" }),
      text: vi.fn().mockResolvedValue(""),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { createRemoteMcpServer } =
      await import("../../src/mcp/remote-server.js");

    await createRemoteMcpServer("em_test_key", "https://memory.example.com");

    const forgetHandler = toolHandlers.get("memory_forget");
    expect(forgetHandler).toBeDefined();

    const res = await forgetHandler!({
      memory_id: "550e8400-e29b-41d4-a716-446655440001",
      project: "legacy",
    });

    expect(res.isError).toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0] as [string, { body?: string }];
    expect(url).toBe("https://memory.example.com/api/forget");

    const body = JSON.parse(init.body ?? "{}");
    expect(body.id).toBe("550e8400-e29b-41d4-a716-446655440001");
    expect(body.action).toBe("archive");
    expect(typeof body.reason).toBe("string");
    expect(body.reason.length).toBeGreaterThan(0);
    expect(body.project).toBe("legacy");
  });
});
