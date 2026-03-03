/**
 * MCP Server 真机测试脚本 — 通过 child_process 与 MCP Server 进行全链路 JSON-RPC 通信
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const SERVER_PATH = new URL("../dist/index.js", import.meta.url).pathname;

function startServer() {
  const child = spawn("node", [SERVER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      EASY_MEMORY_MODE: "mcp",
      QDRANT_URL: "http://localhost:6333",
      QDRANT_API_KEY: "easy-memory-dev",
      OLLAMA_BASE_URL: "http://localhost:11434",
      OLLAMA_MODEL: "bge-m3",
      EMBEDDING_PROVIDER: "ollama",
    },
  });

  let stderrBuf = "";
  child.stderr.on("data", (chunk) => {
    stderrBuf += chunk.toString();
  });

  const rl = createInterface({ input: child.stdout });
  const responseQueue = [];
  const waiters = [];

  rl.on("line", (line) => {
    try {
      const obj = JSON.parse(line);
      if (waiters.length > 0) {
        waiters.shift()(obj);
      } else {
        responseQueue.push(obj);
      }
    } catch {
      /* ignore non-JSON lines */
    }
  });

  function send(obj) {
    child.stdin.write(JSON.stringify(obj) + "\n");
  }

  function waitResponse(timeoutMs = 30000) {
    if (responseQueue.length > 0) {
      return Promise.resolve(responseQueue.shift());
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timeout waiting for response")),
        timeoutMs,
      );
      waiters.push((resp) => {
        clearTimeout(timer);
        resolve(resp);
      });
    });
  }

  return { child, send, waitResponse, getStderr: () => stderrBuf };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("=== MCP Server Real Machine Test ===\n");

  const { child, send, waitResponse, getStderr } = startServer();
  await sleep(1500);

  let passed = 0;
  let failed = 0;

  function assert(label, condition, detail = "") {
    if (condition) {
      console.log(`  ✅ ${label}`);
      passed++;
    } else {
      console.log(`  ❌ ${label} ${detail}`);
      failed++;
    }
  }

  try {
    // ---- Step 1: Initialize ----
    console.log("📡 Step 1: Initialize");
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "real-test", version: "0.1.0" },
      },
    });
    const initResp = await waitResponse();
    assert(
      "Protocol handshake",
      initResp.result?.protocolVersion === "2024-11-05",
    );
    assert(
      "Server name = easy-memory",
      initResp.result?.serverInfo?.name === "easy-memory",
    );
    assert(
      "Tools capability exists",
      initResp.result?.capabilities?.tools != null,
    );

    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await sleep(500);

    // ---- Step 2: Save memory ----
    console.log("\n💾 Step 2: memory_save");
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "memory_save",
        arguments: {
          content:
            "GitHub Copilot uses Claude Opus 4.6 as its underlying AI model, supporting TypeScript, Python, Java and more.",
          tags: ["copilot", "ai", "model", "realtest"],
          project: "test-realworld",
        },
      },
    });
    const saveResp = await waitResponse();
    const saveData = JSON.parse(saveResp.result?.content?.[0]?.text ?? "{}");
    assert(
      "Save status=saved",
      saveData.status === "saved",
      `got: ${saveData.status}`,
    );
    assert(
      "Save has UUID id",
      typeof saveData.id === "string" && saveData.id.length > 0,
    );
    const savedId = saveData.id;
    console.log(`  📝 Saved ID: ${savedId}`);

    await sleep(2000); // Wait for Qdrant write

    // ---- Step 3: Search (should recall) ----
    console.log("\n🔍 Step 3: memory_search (expect recall)");
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "memory_search",
        arguments: {
          query: "What model does Copilot use",
          project: "test-realworld",
          limit: 5,
        },
      },
    });
    const searchResp = await waitResponse();
    const searchData = JSON.parse(
      searchResp.result?.content?.[0]?.text ?? "{}",
    );
    assert("Has memories array", Array.isArray(searchData.memories));
    assert(
      "Found memories > 0",
      searchData.memories?.length > 0,
      `got ${searchData.memories?.length ?? 0}`,
    );
    assert("Has system_note", typeof searchData.system_note === "string");
    if (searchData.memories?.length > 0) {
      const top = searchData.memories[0];
      assert("Top result contains 'Copilot'", top.content?.includes("Copilot"));
      assert(
        "Top result has MEMORY_CONTENT boundary",
        top.content?.includes("[MEMORY_CONTENT_START]"),
      );
      assert("Top result score > 0.3", top.score > 0.3, `score=${top.score}`);
      assert("Top result lifecycle=active", top.lifecycle === "active");
      console.log(
        `  📊 Top score: ${top.score?.toFixed(4)}, fact_type: ${top.fact_type}`,
      );
    }

    // ---- Step 4: Status ----
    console.log("\n🏥 Step 4: memory_status");
    send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "memory_status", arguments: {} },
    });
    const statusResp = await waitResponse();
    const statusData = JSON.parse(
      statusResp.result?.content?.[0]?.text ?? "{}",
    );
    assert(
      "Qdrant=ready",
      statusData.qdrant === "ready",
      `got: ${statusData.qdrant}`,
    );
    assert(
      "Embedding=ready",
      statusData.embedding === "ready",
      `got: ${statusData.embedding}`,
    );
    assert("Has session info", statusData.session != null);
    assert(
      "Has uptime",
      typeof statusData.session?.uptime_seconds === "number",
    );
    console.log(
      `  📊 Qdrant: ${statusData.qdrant}, Embedding: ${statusData.embedding}, Uptime: ${statusData.session?.uptime_seconds}s`,
    );

    // ---- Step 5: Forget (soft delete) ----
    console.log("\n🗑️  Step 5: memory_forget");
    send({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "memory_forget",
        arguments: {
          id: savedId,
          action: "archive",
          reason: "Real machine test cleanup",
          project: "test-realworld",
        },
      },
    });
    const forgetResp = await waitResponse();
    const forgetData = JSON.parse(
      forgetResp.result?.content?.[0]?.text ?? "{}",
    );
    assert(
      "Forget status=archived",
      forgetData.status === "archived",
      `got: ${forgetData.status}`,
    );
    assert("Has message", typeof forgetData.message === "string");
    console.log(`  📝 ${forgetData.message}`);

    await sleep(1000);

    // ---- Step 6: Search after forget (should not return archived) ----
    console.log("\n🔍 Step 6: memory_search after forget");
    send({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "memory_search",
        arguments: {
          query: "What model does Copilot use",
          project: "test-realworld",
          limit: 5,
        },
      },
    });
    const search2Resp = await waitResponse();
    const search2Data = JSON.parse(
      search2Resp.result?.content?.[0]?.text ?? "{}",
    );
    const activeAfterForget = (search2Data.memories ?? []).filter(
      (m) => m.id === savedId && m.lifecycle === "active",
    );
    assert(
      "Archived memory not in active results",
      activeAfterForget.length === 0,
      `still found ${activeAfterForget.length} active entries for forgotten ID`,
    );
    console.log(
      `  📊 Results after forget: ${search2Data.memories?.length ?? 0} total, 0 active for forgotten ID`,
    );

    // ---- Step 7: Duplicate detection ----
    console.log("\n🔄 Step 7: Duplicate save detection");
    send({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "memory_save",
        arguments: {
          content:
            "GitHub Copilot uses Claude Opus 4.6 as its underlying AI model, supporting TypeScript, Python, Java and more.",
          tags: ["copilot", "ai", "model", "realtest"],
          project: "test-realworld",
        },
      },
    });
    const dupResp = await waitResponse();
    const dupData = JSON.parse(dupResp.result?.content?.[0]?.text ?? "{}");
    assert(
      "Duplicate detected",
      dupData.status === "duplicate" || dupData.status === "duplicate_merged",
      `got: ${dupData.status}`,
    );
    console.log(`  📝 Dedup status: ${dupData.status}`);

    // ---- Step 8: Search with include_outdated ----
    console.log("\n🔍 Step 8: memory_search with include_outdated=true");
    send({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "memory_search",
        arguments: {
          query: "What model does Copilot use",
          project: "test-realworld",
          limit: 10,
          include_outdated: true,
        },
      },
    });
    const search3Resp = await waitResponse();
    const search3Data = JSON.parse(
      search3Resp.result?.content?.[0]?.text ?? "{}",
    );
    const archivedInResults = (search3Data.memories ?? []).filter(
      (m) => m.id === savedId && m.lifecycle === "archived",
    );
    assert(
      "Archived memory visible with include_outdated",
      archivedInResults.length > 0,
      `not found in ${search3Data.memories?.length ?? 0} results`,
    );
    console.log(
      `  📊 With include_outdated: ${search3Data.memories?.length ?? 0} total, found archived: ${archivedInResults.length}`,
    );
  } catch (err) {
    console.error("\n💥 TEST ERROR:", err.message);
    failed++;
  } finally {
    child.stdin.end();
    await sleep(1000);
    child.kill("SIGTERM");
    await sleep(500);

    console.log("\n" + "=".repeat(50));
    console.log(`📊 Results: ${passed} passed, ${failed} failed`);
    console.log("=".repeat(50));

    if (failed > 0) {
      console.log("\n--- Server Logs (last 30 lines) ---");
      const lines = getStderr().split("\n").slice(-30);
      console.log(lines.join("\n"));
    }

    process.exit(failed > 0 ? 1 : 0);
  }
}

main();
