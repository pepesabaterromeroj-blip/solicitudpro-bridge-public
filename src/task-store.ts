import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { sanitizeForOutput, sanitizeValue } from "./security.js";

export type TaskStatus = "starting" | "running" | "waiting_approval" | "completed" | "failed" | "interrupted";

export interface TaskEvent {
  at?: string;
  type: string;
  summary: string;
}

export interface PendingApproval {
  approvalId: string;
  method: string;
  reason?: string;
  command?: string;
  createdAt: string;
}

export interface BridgeTask {
  id: string;
  project: string;
  codexThreadId: string;
  codexTurnId: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  events: TaskEvent[];
  finalResult?: string;
  error?: string;
  pendingApproval?: PendingApproval;
}

interface StoreData { version: 1; tasks: BridgeTask[] }

export class TaskStore {
  private writes: Promise<void> = Promise.resolve();
  private constructor(private readonly filePath: string, private data: StoreData) {}

  static async open(filePath: string): Promise<TaskStore> {
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as StoreData;
      return new TaskStore(filePath, parsed.version === 1 && Array.isArray(parsed.tasks) ? parsed : { version: 1, tasks: [] });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return new TaskStore(filePath, { version: 1, tasks: [] });
    }
  }

  list(): BridgeTask[] { return this.data.tasks.map((task) => structuredClone(task)); }
  get(id: string): BridgeTask | undefined { const task = this.data.tasks.find((item) => item.id === id); return task ? structuredClone(task) : undefined; }
  findByThread(threadId: string): BridgeTask | undefined { const task = [...this.data.tasks].reverse().find((item) => item.codexThreadId === threadId); return task ? structuredClone(task) : undefined; }
  findByTurn(turnId: string): BridgeTask | undefined { const task = [...this.data.tasks].reverse().find((item) => item.codexTurnId === turnId); return task ? structuredClone(task) : undefined; }

  async create(input: Pick<BridgeTask, "project" | "codexThreadId" | "codexTurnId">): Promise<BridgeTask> {
    const now = new Date().toISOString();
    const task: BridgeTask = { id: randomUUID(), ...input, status: "starting", createdAt: now, updatedAt: now, events: [] };
    this.data.tasks.push(task);
    await this.flush();
    return structuredClone(task);
  }

  async update(id: string, patch: Partial<Omit<BridgeTask, "id" | "project" | "createdAt">>): Promise<BridgeTask> {
    const task = this.data.tasks.find((item) => item.id === id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    Object.assign(task, sanitizeValue(patch), { updatedAt: new Date().toISOString() });
    if (task.finalResult) task.finalResult = sanitizeForOutput(task.finalResult);
    if (task.error) task.error = sanitizeForOutput(task.error, 4_000);
    await this.flush();
    return structuredClone(task);
  }

  async addEvent(id: string, event: TaskEvent): Promise<void> {
    const task = this.data.tasks.find((item) => item.id === id);
    if (!task) return;
    task.events.push({ at: event.at ?? new Date().toISOString(), type: event.type, summary: sanitizeForOutput(event.summary, 2_000) });
    task.events = task.events.slice(-50);
    task.updatedAt = new Date().toISOString();
    await this.flush();
  }

  async drain(): Promise<void> { await this.writes; }

  private flush(): Promise<void> {
    const snapshot = `${JSON.stringify(this.data, null, 2)}\n`;
    const operation = this.writes.then(() => this.writeSnapshot(snapshot));
    this.writes = operation.catch(() => undefined);
    return operation;
  }

  private async writeSnapshot(snapshot: string): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, snapshot, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
