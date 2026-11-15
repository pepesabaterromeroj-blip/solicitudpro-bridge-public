import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import { sanitizeForOutput, sanitizeValue } from "./security.js";

type RequestId = number;
type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export interface AppServerTransport extends EventEmitter {
  write(line: string): void;
  isAlive(): boolean;
  stop(): void;
}

export class ChildProcessTransport extends EventEmitter implements AppServerTransport {
  private readonly child: ChildProcessWithoutNullStreams;

  constructor(command = "codex") {
    super();
    this.child = spawn(command, ["app-server", "--listen", "stdio://"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.emit("line", line));
    this.child.stderr.on("data", (chunk) => this.emit("stderr", sanitizeForOutput(String(chunk), 4_000)));
    this.child.on("error", (error) => this.emit("error", error));
    this.child.on("exit", (code, signal) => this.emit("exit", code, signal));
  }

  write(line: string): void { this.child.stdin.write(`${line}\n`); }
  isAlive(): boolean { return this.child.exitCode === null && !this.child.killed; }
  stop(): void { if (this.isAlive()) this.child.kill(); }
}

export interface AppServerClientOptions {
  command?: string;
  transportFactory?: () => AppServerTransport;
}

export interface ApprovalEvent {
  approvalId: string;
  method: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  reason?: string;
  command?: string;
}

export class AppServerClient extends EventEmitter {
  private transport?: AppServerTransport;
  private nextId = 1;
  private started = false;
  private startPromise?: Promise<void>;
  private readonly pending = new Map<RequestId, { resolve: (value: any) => void; reject: (reason: Error) => void }>();
  private readonly approvals = new Map<string, { rpcId: RequestId; method: string }>();

  constructor(private readonly options: AppServerClientOptions = {}) { super(); }

  isActive(): boolean { return Boolean(this.started && this.transport?.isAlive()); }

  async start(): Promise<void> {
    if (this.isActive()) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.initialize();
    try { await this.startPromise; } finally { this.startPromise = undefined; }
  }

  private async initialize(): Promise<void> {
    this.transport = this.options.transportFactory?.() ?? new ChildProcessTransport(this.options.command);
    this.transport.on("line", (line: string) => this.handleLine(line));
    this.transport.on("stderr", (line: string) => this.emit("diagnostic", line));
    this.transport.on("error", (error: Error) => this.handleExit(error));
    this.transport.on("exit", (code: number | null, signal?: string | null) => this.handleExit(new Error(`app-server exited (${code ?? signal ?? "unknown"})`)));
    await this.request("initialize", { clientInfo: { name: "solicitudpro_bridge", title: "SolicitudPro Bridge", version: "1.0.0" }, capabilities: null });
    this.notify("initialized");
    this.started = true;
  }

  async request<T = any>(method: string, params?: unknown): Promise<T> {
    if (method !== "initialize") await this.start();
    if (!this.transport?.isAlive()) throw new Error("Codex app-server is not available");
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.transport.write(JSON.stringify({ method, id, params }));
    return promise;
  }

  notify(method: string, params?: unknown): void {
    if (!this.transport?.isAlive()) throw new Error("Codex app-server is not available");
    this.transport.write(JSON.stringify(params === undefined ? { method } : { method, params }));
  }

  respondApproval(approvalId: string, decision: ApprovalDecision): void {
    const approval = this.approvals.get(approvalId);
    if (!approval) throw new Error(`Unknown approval id: ${approvalId}`);
    if (!this.transport?.isAlive()) throw new Error("Codex app-server is not available");
    this.transport.write(JSON.stringify({ id: approval.rpcId, result: { decision } }));
    this.approvals.delete(approvalId);
  }

  stop(): void {
    this.transport?.stop();
    this.started = false;
  }

  private handleLine(line: string): void {
    let message: any;
    try { message = JSON.parse(line); } catch { this.emit("diagnostic", "Ignored malformed app-server output"); return; }
    if (message.id !== undefined && ("result" in message || "error" in message) && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(sanitizeForOutput(message.error.message ?? "app-server request failed")));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      const approvalId = `appserver:${message.id}`;
      this.approvals.set(approvalId, { rpcId: message.id, method: message.method });
      const params = sanitizeValue(message.params ?? {});
      this.emit("approval", { approvalId, method: message.method, ...params } satisfies ApprovalEvent);
      return;
    }
    if (message.method) this.emit("notification", sanitizeValue(message));
  }

  private handleExit(error: Error): void {
    if (!this.started && this.pending.size === 0) return;
    this.started = false;
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    this.emit("closed", error);
  }
}
