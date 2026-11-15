import { createServer, type Server } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createSmokeMcpServer } from "./mcp-server.js";

type SmokeResponse = { bridge: "ok"; codex: "ok"; response: "BRIDGE_E2E_OK" };

export async function startHttpSmokeServer(options: { host: string; port: number; smoke: () => Promise<SmokeResponse> }): Promise<{ port: number; close: () => Promise<void> }> {
  if (options.host !== "127.0.0.1" && options.host !== "::1") throw new Error("HTTP smoke must bind to loopback only");
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error("Invalid HTTP port");
  const active = new Set<StreamableHTTPServerTransport>();
  let remaining = 10;
  const server: Server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.url === "/health" && req.method === "GET") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ status: "ok", mode: "external-smoke" }));
      return;
    }
    if (req.url !== "/mcp") { res.writeHead(404).end(); return; }
    if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }).end(); return; }
    const mcp = createSmokeMcpServer(async () => {
      if (remaining <= 0) throw new Error("Smoke call limit reached");
      remaining--;
      return options.smoke();
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    active.add(transport);
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500).end("MCP request failed");
    } finally {
      active.delete(transport);
      await mcp.close();
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port, options.host, resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP server has no port");
  return {
    port: address.port,
    close: async () => {
      await Promise.all([...active].map((transport) => transport.close()));
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
