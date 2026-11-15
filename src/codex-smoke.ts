import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { AppServerClient } from "./app-server-client.js";

const EXPECTED = "BRIDGE_E2E_OK";

export async function runFixedCodexSmoke(command: string): Promise<{ bridge: "ok"; codex: "ok"; response: "BRIDGE_E2E_OK" }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "bridge-e2e-smoke-"));
  const client = new AppServerClient({ command });
  try {
    await client.start();
    const thread = await client.request<{ thread: { id: string } }>("thread/start", {
      cwd, sandbox: "read-only", approvalPolicy: "untrusted",
    });
    let output = "";
    const completion = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error("Codex smoke timed out")); }, 90_000);
      const onNotification = (message: any) => {
        if (message.params?.threadId !== thread.thread.id) return;
        if (message.method === "item/agentMessage/delta") output += String(message.params.delta ?? "");
        if (message.method === "turn/completed") {
          cleanup();
          message.params.turn?.status === "completed" ? resolve() : reject(new Error("Codex smoke did not complete"));
        }
      };
      const onClosed = () => { cleanup(); reject(new Error("Codex app-server closed")); };
      const cleanup = () => { clearTimeout(timeout); client.off("notification", onNotification); client.off("closed", onClosed); };
      client.on("notification", onNotification);
      client.on("closed", onClosed);
    });
    await client.request("turn/start", {
      threadId: thread.thread.id,
      input: [{ type: "text", text: `Sin usar herramientas, archivos ni red, responde exactamente ${EXPECTED}`, text_elements: [] }],
      effort: "low",
    });
    await completion;
    if (output.trim() !== EXPECTED) throw new Error("Codex returned an unexpected response");
    return { bridge: "ok", codex: "ok", response: EXPECTED };
  } finally {
    client.stop();
    await rm(cwd, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
}
