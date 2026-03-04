/**
 * @module utils/ip
 * @description 统一的客户端 IP 提取工具 — 消除散落的重复逻辑。
 *
 * 安全策略:
 * - trustProxy=true 时读取 X-Forwarded-For (反向代理场景)
 * - trustProxy=false 时不信任代理头，返回 "unknown" (直连场景暂无 socket 地址)
 * - 多层代理: 取第一个 IP (client-most)
 *
 * 铁律: 绝对禁止 console.log (MCP stdio 依赖)
 */

import type { Context } from "hono";

/**
 * 从 HTTP 请求中提取客户端 IP。
 *
 * @param c         Hono Context
 * @param trustProxy 是否信任反向代理 X-Forwarded-For 头
 * @returns 客户端 IP 字符串，无法确定时返回 "unknown"
 */
export function getClientIp(c: Context, trustProxy = true): string {
  if (trustProxy) {
    const forwarded = c.req.header("X-Forwarded-For");
    if (forwarded) {
      const firstIp = forwarded.split(",")[0]?.trim();
      if (firstIp) return firstIp;
    }

    // 尝试其他代理头
    const realIp = c.req.header("X-Real-IP");
    if (realIp) return realIp.trim();
  }

  return "unknown";
}
