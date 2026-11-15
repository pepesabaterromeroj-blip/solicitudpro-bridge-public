import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AppServerClient, type ApprovalEvent } from "./app-server-client.js";
import { readGitState } from "./git-state.js";
import { ProjectRegistry } from "./project-registry.js";
import { sanitizeForOutput, validateStartTaskInput, type StartTaskInput } from "./security.js";
import { readSolicitudProContext } from "./solicitudpro-context.js";
import { TaskStore, type BridgeTask, type TaskStatus } from "./task-store.js";

const execFileAsync = promisify(execFile);

interface ThreadStartResponse { thread: { id: string } }
interface TurnStartResponse { turn: { id: string; status: string } }

export class BridgeService {
  private readonly outputByTurn = new Map<string, string>();

  constructor(
    readonly registry: ProjectRegistry,
    readonly store: TaskStore,
    readonly appServer: AppServerClient,
  ) {
    appServer.on("notification", (notification) => { void this.handleNotification(notification); });
    appServer.on("approval", (approval) => { void this.handleApproval(approval); });
    appServer.on("closed", (error: Error) => { void this.handleClosed(error); });
  }

  async status() {
    const codex = await this.checkCodex();
    return {
      version: "1.0.0",
      codexAvailable: codex.available,
      codexVersion: codex.version,
      appServerAvailable: codex.appServerAvailable,
      appServerActive: this.appServer.isActive(),
      tunnel: this.registry.config.tunnel ?? { enabled: false, status: "not_configured" },
      projects: this.registry.list(),
    };
  }

  async projectState(projectId: string) { return readGitState(this.registry.resolve(projectId).path); }
  threads() { return this.store.list().map((task) => this.publicTask(task)); }
  taskStatus(taskId: string) { const task = this.store.get(taskId); if (!task) throw new Error(`Unknown task: ${taskId}`); return this.publicTask(task); }
  async solicitudproContext() { return readSolicitudProContext(this.registry.resolve("solicitudpro").path); }

  async startTask(input: StartTaskInput): Promise<{ taskId: string; threadId: string; turnId: string; status: string }> {
    const validated = validateStartTaskInput(input);
    const project = this.registry.resolve(validated.project);
    await this.appServer.start();
    const defaults = this.registry.config.codex ?? {};
    const threadParams: Record<string, unknown> = {
      cwd: project.path,
      approvalPolicy: validated.approvalPolicy ?? defaults.defaultApprovalPolicy ?? "on-request",
      model: validated.model ?? defaults.defaultModel ?? undefined,
    };
    const permissions = validated.permissions;
    if (permissions) threadParams.permissions = permissions;
    else threadParams.sandbox = validated.sandbox ?? defaults.defaultSandbox ?? "read-only";
    const thread = await this.appServer.request<ThreadStartResponse>("thread/start", threadParams);
    const turn = await this.appServer.request<TurnStartResponse>("turn/start", {
      threadId: thread.thread.id,
      input: [{ type: "text", text: validated.prompt, text_elements: [] }],
      effort: validated.reasoning ?? defaults.defaultReasoningEffort ?? "medium",
    });
    const task = await this.store.create({ project: project.id, codexThreadId: thread.thread.id, codexTurnId: turn.turn.id });
    await this.store.update(task.id, { status: "running" });
    return { taskId: task.id, threadId: thread.thread.id, turnId: turn.turn.id, status: "running" };
  }

  async continueTask(input: { taskId?: string; threadId?: string; message: string }): Promise<{ taskId: string; threadId: string; turnId: string; status: string }> {
    const source = input.taskId ? this.store.get(input.taskId) : input.threadId ? this.store.findByThread(input.threadId) : undefined;
    if (!source) throw new Error("A known task_id or thread_id is required");
    const message = input.message?.trim();
    if (!message || message.length > 40_000) throw new Error("Message must contain between 1 and 40000 characters");
    const project = this.registry.resolve(source.project);
    await this.appServer.start();
    await this.appServer.request("thread/resume", { threadId: source.codexThreadId, cwd: project.path, excludeTurns: true });
    const turn = await this.appServer.request<TurnStartResponse>("turn/start", {
      threadId: source.codexThreadId,
      input: [{ type: "text", text: message, text_elements: [] }],
    });
    const task = await this.store.create({ project: source.project, codexThreadId: source.codexThreadId, codexTurnId: turn.turn.id });
    await this.store.update(task.id, { status: "running" });
    return { taskId: task.id, threadId: source.codexThreadId, turnId: turn.turn.id, status: "running" };
  }

  async interruptTask(taskId: string): Promise<{ taskId: string; status: string }> {
    const task = this.store.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    if (!new Set(["running", "waiting_approval"]).has(task.status)) throw new Error(`Task is not active: ${task.status}`);
    await this.appServer.request("turn/interrupt", { threadId: task.codexThreadId, turnId: task.codexTurnId });
    await this.store.update(task.id, { status: "interrupted", pendingApproval: undefined });
    return { taskId, status: "interrupted" };
  }

  async respondApproval(taskId: string, approvalId: string, decision: "accept" | "acceptForSession" | "decline" | "cancel") {
    const task = this.store.get(taskId);
    if (!task?.pendingApproval || task.pendingApproval.approvalId !== approvalId) throw new Error("Approval does not belong to this task or is no longer pending");
    this.appServer.respondApproval(approvalId, decision);
    await this.store.update(task.id, { status: "running", pendingApproval: undefined });
    await this.store.addEvent(task.id, { type: "approval_response", summary: `Approval ${decision}` });
    return { taskId, approvalId, decision, status: "running" };
  }

  shutdown(): void { this.appServer.stop(); }

  private async handleNotification(notification: any): Promise<void> {
    const method = notification.method as string;
    const params = notification.params ?? {};
    const task = params.turnId ? this.store.findByTurn(params.turnId) : params.threadId ? this.store.findByThread(params.threadId) : undefined;
    if (!task) return;
    if (method === "item/agentMessage/delta") {
      const accumulated = (this.outputByTurn.get(task.codexTurnId) ?? "") + String(params.delta ?? "");
      this.outputByTurn.set(task.codexTurnId, accumulated.slice(-40_000));
      return;
    }
    if (method === "turn/completed") {
      const rawStatus = params.turn?.status as string;
      const status: TaskStatus = rawStatus === "completed" ? "completed" : rawStatus === "interrupted" ? "interrupted" : "failed";
      await this.store.update(task.id, {
        status,
        finalResult: this.outputByTurn.get(task.codexTurnId) ?? task.finalResult,
        error: params.turn?.error?.message,
        pendingApproval: undefined,
      });
      this.outputByTurn.delete(task.codexTurnId);
      return;
    }
    if (method === "error") await this.store.addEvent(task.id, { type: "error", summary: params.message ?? "Codex reported an error" });
    else if (["turn/started", "item/started", "item/completed"].includes(method)) await this.store.addEvent(task.id, { type: method, summary: method });
  }

  private async handleApproval(approval: ApprovalEvent): Promise<void> {
    const task = approval.turnId ? this.store.findByTurn(approval.turnId) : approval.threadId ? this.store.findByThread(approval.threadId) : undefined;
    if (!task) {
      this.appServer.respondApproval(approval.approvalId, "decline");
      return;
    }
    await this.store.update(task.id, {
      status: "waiting_approval",
      pendingApproval: {
        approvalId: approval.approvalId,
        method: approval.method,
        reason: approval.reason ? sanitizeForOutput(approval.reason, 1_000) : undefined,
        command: approval.command ? sanitizeForOutput(approval.command, 2_000) : undefined,
        createdAt: new Date().toISOString(),
      },
    });
  }

  private async handleClosed(error: Error): Promise<void> {
    for (const task of this.store.list().filter((item) => item.status === "running" || item.status === "waiting_approval")) {
      await this.store.update(task.id, { status: "failed", error: sanitizeForOutput(error.message), pendingApproval: undefined });
    }
  }

  private publicTask(task: BridgeTask) {
    return {
      taskId: task.id,
      threadId: task.codexThreadId,
      turnId: task.codexTurnId,
      project: task.project,
      status: task.status,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      events: task.events,
      pendingApproval: task.pendingApproval,
      finalResult: task.finalResult,
      error: task.error,
    };
  }

  private async checkCodex(): Promise<{ available: boolean; version?: string; appServerAvailable: boolean }> {
    try {
      const command = this.registry.config.codex?.command ?? "codex";
      const { stdout } = await execFileAsync(command, ["--version"], { windowsHide: true });
      const { stdout: help } = await execFileAsync(command, ["app-server", "--help"], { windowsHide: true });
      return { available: true, version: stdout.trim(), appServerAvailable: /Run the app server/i.test(help) };
    } catch {
      return { available: false, appServerAvailable: false };
    }
  }
}
