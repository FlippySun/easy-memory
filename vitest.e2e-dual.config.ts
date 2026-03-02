import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/e2e-dual-engine.test.ts"],
    testTimeout: 180_000, // 远端 API + 冷启动需要充足时间
    hookTimeout: 60_000, // beforeAll/afterAll 健康检查
  },
});
