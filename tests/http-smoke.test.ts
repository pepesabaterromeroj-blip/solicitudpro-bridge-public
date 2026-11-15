import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startHttpSmokeServer } from "../src/http-smoke.js";
import { createMcpServer } from "../src/mcp-server.js";

test("normal MCP registration still exposes the original nine tools", async () => {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({} as any);
  const client = new Client({ name: "stdio-registration-test", version: "1.0.0" });
  await server.connect(serverTransport);
  try {
    await client.connect(clientTransport);
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [
      "bridge_status", "project_state", "codex_threads", "codex_task_status", "codex_start_task",
      "codex_continue_task", "codex_interrupt_task", "codex_respond_approval", "solicitudpro_context",
    ].sort());
  } finally { await client.close(); await server.close(); }
});

test("HTTP smoke exposes one fixed tool and leaves normal tools unavailable", async () => {
  let calls = 0;
  const runtime = await startHttpSmokeServer({ host: "127.0.0.1", port: 0, smoke: async () => { calls++; return { bridge: "ok", codex: "ok", response: "BRIDGE_E2E_OK" }; } });
  try {
    const base = `http://127.0.0.1:${runtime.port}`;
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok", mode: "external-smoke" });
    const client = new Client({ name: "http-smoke-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    try {
      assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["bridge_e2e_smoke"]);
      const rejected = await client.callTool({ name: "codex_start_task", arguments: { prompt: "unsafe" } });
      assert.equal(rejected.isError, true);
      const rejectedInput = await client.callTool({ name: "bridge_e2e_smoke", arguments: { prompt: "unsafe" } });
      assert.equal(rejectedInput.isError, true);
      assert.equal(calls, 0);
      const answer = await client.callTool({ name: "bridge_e2e_smoke", arguments: {} });
      assert.deepEqual(answer.structuredContent, { bridge: "ok", codex: "ok", response: "BRIDGE_E2E_OK" });
      assert.equal(calls, 1);
    } finally { await client.close(); }
    assert.equal((await fetch(`${base}/other`)).status, 404);
  } finally { await runtime.close(); }
});

test("HTTP smoke rejects non-loopback binding", async () => {
  await assert.rejects(startHttpSmokeServer({ host: "0.0.0.0", port: 0, smoke: async () => ({ bridge: "ok", codex: "ok", response: "BRIDGE_E2E_OK" }) }), /loopback/i);
});
