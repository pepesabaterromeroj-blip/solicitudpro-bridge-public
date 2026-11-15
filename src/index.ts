import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { AppServerClient } from "./app-server-client.js";
import { BridgeService } from "./bridge-service.js";
import { runStdioServer } from "./mcp-server.js";
import { ProjectRegistry } from "./project-registry.js";
import { TaskStore } from "./task-store.js";
import { startHttpSmokeServer } from "./http-smoke.js";
import { runFixedCodexSmoke } from "./codex-smoke.js";

// Compiled entrypoint lives in dist/src. The development entrypoint lives in src.
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.basename(path.dirname(moduleDirectory)) === "dist"
  ? path.resolve(moduleDirectory, "..", "..")
  : path.resolve(moduleDirectory, "..");
const configPath = process.env.SOLICITUDPRO_BRIDGE_CONFIG ?? path.join(root, "config", "local.json");

if (process.env.SOLICITUDPRO_BRIDGE_HTTP_SMOKE === "1") {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const port = Number(process.env.SOLICITUDPRO_BRIDGE_HTTP_PORT ?? "8787");
  const http = await startHttpSmokeServer({
    host: "127.0.0.1", port,
    smoke: () => runFixedCodexSmoke(config.codex?.command ?? "codex"),
  });
  process.stderr.write(`Bridge external-smoke listening on 127.0.0.1:${http.port}\n`);
  const shutdownHttp = () => { void http.close().finally(() => process.exit(0)); };
  process.once("SIGINT", shutdownHttp);
  process.once("SIGTERM", shutdownHttp);
} else {
const statePath = process.env.SOLICITUDPRO_BRIDGE_STATE ?? path.join(root, "data", "state.json");
const pidPath = path.join(path.dirname(statePath), "bridge.pid");

const registry = await ProjectRegistry.load(configPath);
const store = await TaskStore.open(statePath);
const appServer = new AppServerClient({ command: registry.config.codex?.command ?? "codex" });
const service = new BridgeService(registry, store, appServer);

await mkdir(path.dirname(pidPath), { recursive: true });
await writeFile(pidPath, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });

const shutdown = async () => {
  service.shutdown();
  await store.drain();
  await unlink(pidPath).catch(() => undefined);
};
process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
process.once("exit", () => { service.shutdown(); });

await runStdioServer(service);
process.stdin.once("end", () => { void shutdown().finally(() => process.exit(0)); });
}
