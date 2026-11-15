import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpSmokeServer } from "../../src/http-smoke.js";
import { runFixedCodexSmoke } from "../../src/codex-smoke.js";

test("HTTP MCP reaches real Codex without reading a configured project", { timeout: 120_000 }, async () => {
  const config = JSON.parse(await readFile(new URL("../../config/local.json", import.meta.url), "utf8"));
  const runtime = await startHttpSmokeServer({ host: "127.0.0.1", port: 0, smoke: () => runFixedCodexSmoke(config.codex?.command ?? "codex") });
  const client = new Client({ name: "bridge-real-http-smoke", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${runtime.port}/mcp`)));
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["bridge_e2e_smoke"]);
    const response = await client.callTool({ name: "bridge_e2e_smoke", arguments: {} });
    assert.deepEqual(response.structuredContent, { bridge: "ok", codex: "ok", response: "BRIDGE_E2E_OK" });
  } finally { await client.close(); await runtime.close(); }
});
