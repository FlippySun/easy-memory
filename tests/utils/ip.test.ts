/**
 * @module tests/utils/ip.test
 * @description 共享 IP 提取工具单元测试。
 */

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { getClientIp } from "../../src/utils/ip.js";

describe("getClientIp", () => {
  async function requestWithHeaders(
    headers: Record<string, string>,
    trustProxy: boolean,
  ): Promise<string> {
    const app = new Hono();
    let extractedIp = "";
    app.get("/test", (c) => {
      extractedIp = getClientIp(c, trustProxy);
      return c.json({ ip: extractedIp });
    });

    await app.request("/test", { headers });
    return extractedIp;
  }

  it("should extract first IP from X-Forwarded-For when trustProxy=true", async () => {
    const ip = await requestWithHeaders(
      { "X-Forwarded-For": "1.2.3.4, 10.0.0.1" },
      true,
    );
    expect(ip).toBe("1.2.3.4");
  });

  it("should trim whitespace from X-Forwarded-For", async () => {
    const ip = await requestWithHeaders(
      { "X-Forwarded-For": "  1.2.3.4  , 10.0.0.1" },
      true,
    );
    expect(ip).toBe("1.2.3.4");
  });

  it("should fallback to X-Real-IP when no X-Forwarded-For", async () => {
    const ip = await requestWithHeaders({ "X-Real-IP": "5.6.7.8" }, true);
    expect(ip).toBe("5.6.7.8");
  });

  it("should return 'unknown' when no proxy headers and trustProxy=true", async () => {
    const ip = await requestWithHeaders({}, true);
    expect(ip).toBe("unknown");
  });

  it("should ignore proxy headers when trustProxy=false", async () => {
    const ip = await requestWithHeaders(
      { "X-Forwarded-For": "1.2.3.4", "X-Real-IP": "5.6.7.8" },
      false,
    );
    expect(ip).toBe("unknown");
  });

  it("should handle empty X-Forwarded-For gracefully", async () => {
    const ip = await requestWithHeaders({ "X-Forwarded-For": "" }, true);
    expect(ip).toBe("unknown");
  });

  it("should handle single IP in X-Forwarded-For", async () => {
    const ip = await requestWithHeaders(
      { "X-Forwarded-For": "192.168.1.1" },
      true,
    );
    expect(ip).toBe("192.168.1.1");
  });
});
