import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SelectedProfile, ReasoningEffort } from './execution-profile.js';

export interface ThreadMetadata {
  lastTurnId: string; lastHead: string; selectedProfile: SelectedProfile;
  requestedReasoning: ReasoningEffort; requestedModel: string; updatedAt: string;
}
type State = { version: 1; threads: Record<string, string>; metadata?: Record<string, ThreadMetadata> };

export class ThreadStateStore {
  constructor(private file: string) {}
  private async read(): Promise<State> {
    let data: State;
    try { data = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error: any) { if (error?.code !== 'ENOENT') throw error; data = { version: 1, threads: {} }; }
    if (data.version !== 1 || !data.threads || typeof data.threads !== 'object' || (data.metadata !== undefined && typeof data.metadata !== 'object')) throw new Error('Invalid local thread state');
    return data;
  }
  async get(key: string): Promise<string | undefined> { return (await this.read()).threads[key]; }
  async setThread(key: string, threadId: string): Promise<void> {
    const data = await this.read(); data.threads[key] = threadId; await this.write(data);
  }
  async record(key: string, metadata: ThreadMetadata): Promise<void> {
    const data = await this.read(); data.metadata ??= {}; data.metadata[key] = metadata; await this.write(data);
  }
  async metadata(key: string): Promise<ThreadMetadata | undefined> { return (await this.read()).metadata?.[key]; }
  private async write(data: State): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
    await rename(temporary, this.file);
  }
}
