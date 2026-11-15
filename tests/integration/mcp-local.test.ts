import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parsePorcelainV1 } from "../../src/git-state.js";

const root = path.resolve(import.meta.dirname, "..", "..");
const execFileAsync = promisify(execFile);
async function observedGit(repoPath: string) {
  const run = async (...args: string[]) => (await execFileAsync("git", ["-C", repoPath, ...args])).stdout.trimEnd();
  const [branch, head, status] = await Promise.all([
    run("branch", "--show-current"),
    run("rev-parse", "HEAD"),
    run("status", "--porcelain=v1", "-uall"),
  ]);
  return { branch, head, ...parsePorcelainV1(status) };
}
const runtime = await mkdtemp(path.join(tmpdir(), "bridge-integration-"));
function connection() {
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "dist", "src", "index.js")],
  cwd: root,
  stderr: "pipe",
  env: { ...process.env as Record<string, string>, SOLICITUDPRO_BRIDGE_STATE: path.join(runtime, "state.json") },
});
const client = new Client({ name: "solicitudpro-bridge-integration", version: "1.0.0" });
return { transport, client };
}
let { transport, client } = connection();

test("Windows lifecycle checks and stops the verified Bridge entrypoint", { skip: process.platform !== "win32" }, async (t) => {
  const localTransport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "dist", "src", "index.js")], cwd: root });
  const localClient = new Client({ name: "bridge-lifecycle-test", version: "1.0.0" });
  await localClient.connect(localTransport);
  t.after(() => localClient.close());
  const exec = promisify(execFile);
  const status = await exec("powershell.exe", ["-NoProfile", "-File", path.join(root, "status-bridge.ps1")]);
  assert.match(status.stdout, /Bridge\s*:\s*active/);
  const stopped = await exec("powershell.exe", ["-NoProfile", "-File", path.join(root, "stop-bridge.ps1")]);
  assert.match(stopped.stdout, /Stopped SolicitudPro Bridge process/);
  const inactive = await exec("powershell.exe", ["-NoProfile", "-File", path.join(root, "status-bridge.ps1")]);
  assert.match(inactive.stdout, /Bridge\s*:\s*inactive/);
});

function structured<T>(response: Awaited<ReturnType<Client["callTool"]>>): T {
  return response.structuredContent as T;
}

async function pollTask(taskId: string, timeoutMs = 300_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await client.callTool({ name: "codex_task_status", arguments: { task_id: taskId } });
    const task = structured<any>(response);
    if (["completed", "failed", "interrupted", "waiting_approval"].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out waiting for task ${taskId}`);
}

test("MCP discovery, safe reads, rejection, and real Codex continuation", { timeout: 700_000 }, async (t) => {
  await client.connect(transport);
  t.after(async () => { await client.close(); await rm(runtime, { recursive: true, force: true }); });

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    ["bridge_status", "codex_continue_task", "codex_interrupt_task", "codex_respond_approval", "codex_start_task", "codex_task_status", "codex_threads", "project_state", "solicitudpro_context"].sort(),
  );

  const bridge = structured<any>(await client.callTool({ name: "bridge_status", arguments: {} }));
  assert.equal(bridge.codexAvailable, true);
  assert.equal(bridge.appServerAvailable, true);
  assert.equal(bridge.tunnel.enabled, false);

  const git = structured<any>(await client.callTool({ name: "project_state", arguments: { project: "solicitudpro" } }));
  const initialGit = await observedGit(git.gitRoot);
  for (const field of ["branch", "head", "clean", "staged", "unstaged", "untracked"] as const) {
    assert.deepEqual(git[field], initialGit[field], `project_state ${field} differs from Git`);
  }

  const context = structured<any>(await client.callTool({ name: "solicitudpro_context", arguments: {} }));
  assert.equal(context.branch, git.branch);
  assert.equal(context.head, git.head);

  const rejected = await client.callTool({ name: "project_state", arguments: { project: "not-authorized" } });
  assert.equal(rejected.isError, true);

  const startResponse = await client.callTool({
    name: "codex_start_task",
    arguments: {
      project: "solicitudpro",
      sandbox: "read-only",
      reasoning: "low",
      prompt: "Inspect the current Git checkout without modifying anything. Reply with exactly three lines: BRANCH=<branch>, HEAD=<full SHA>, CLEAN=<YES or NO>.",
    },
  });
  assert.notEqual(startResponse.isError, true, JSON.stringify(startResponse));
  const started = structured<any>(startResponse);
  const first = await pollTask(started.taskId);
  assert.equal(first.status, "completed", JSON.stringify(first));
  assert.match(first.finalResult, new RegExp(`BRANCH=${git.branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"));
  assert.match(first.finalResult, new RegExp(`HEAD=${git.head}`, "i"));
  assert.match(first.finalResult, new RegExp(`CLEAN=${git.clean ? "YES" : "NO"}`, "i"));

  const continued = structured<any>(await client.callTool({
    name: "codex_continue_task",
    arguments: { task_id: started.taskId, message: "Using the same conversation, reply with only the main remote fetch URL. Do not modify anything." },
  }));
  assert.equal(continued.threadId, started.threadId);
  const second = await pollTask(continued.taskId);
  assert.equal(second.status, "completed", JSON.stringify(second));
  assert.match(second.finalResult, /github\.com\/[^/\s]+\/solicitudpro/i);

  await client.close();
  ({ transport, client } = connection());
  await client.connect(transport);
  const recovered = structured<any>(await client.callTool({ name: "codex_task_status", arguments: { task_id: continued.taskId } }));
  assert.equal(recovered.threadId, started.threadId);
  const resumed = structured<any>(await client.callTool({
    name: "codex_continue_task",
    arguments: { task_id: continued.taskId, message: "Reply only with the same main remote fetch URL you just inspected. Do not modify anything." },
  }));
  assert.equal(resumed.threadId, started.threadId);
  const third = await pollTask(resumed.taskId);
  assert.equal(third.status, "completed", JSON.stringify(third));
  assert.match(third.finalResult, /github\.com\/[^/\s]+\/solicitudpro/i);

  const active = structured<any>(await client.callTool({ name: "codex_continue_task", arguments: {
    task_id: resumed.taskId,
    message: "Read the README and project documentation in this repository, without modifying anything, and prepare a detailed summary. This is an interruption test.",
  } }));
  // turn/start acknowledges scheduling before the server has an active turn.
  // Wait for an observed item event, rather than a fixed startup delay.
  const activeDeadline = Date.now() + 30_000;
  let executing = false;
  while (Date.now() < activeDeadline) {
    const observed = structured<any>(await client.callTool({ name: "codex_task_status", arguments: { task_id: active.taskId } }));
    if (observed.events.some((event: any) => event.type === "item/started")) { executing = true; break; }
    assert.equal(observed.status, "running", JSON.stringify(observed));
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(executing, true, "No active item was observed before interrupt");
  const interrupted = await client.callTool({ name: "codex_interrupt_task", arguments: { task_id: active.taskId } });
  assert.notEqual(interrupted.isError, true, JSON.stringify(interrupted));
  assert.equal((await pollTask(active.taskId)).status, "interrupted");

  const finalGit = structured<any>(await client.callTool({ name: "project_state", arguments: { project: "solicitudpro" } }));
  const afterGit = await observedGit(git.gitRoot);
  assert.deepEqual(afterGit, initialGit, "Codex changed the inspected repository");
  for (const field of ["branch", "head", "clean", "staged", "unstaged", "untracked"] as const) {
    assert.deepEqual(finalGit[field], afterGit[field], `final project_state ${field} differs from Git`);
  }
});
