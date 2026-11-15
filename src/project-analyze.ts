import { AppServerClient } from './app-server-client.js';
import type { ProjectRegistry } from './project-registry.js';
import { sanitizeForOutput } from './security.js';
import { buildContextCapsule } from './context-capsule.js';
import { resolveExecutionProfile, type ExecutionCategory, type RequestedProfile } from './execution-profile.js';
import { observeThreadRuntime, selectCodexRuntime } from './codex-runtime.js';
import { ThreadStateStore } from './thread-state.js';

export type AnalysisResult = {
  project: string; deviceId: string; threadId: string; threadCreated: boolean; turnId: string;
  status: 'completed'; result: string; blockedActions: number; selectedProfile: string;
  requestedModel: string; requestedReasoning: string; runtimeModel: string; runtimeReasoning: string;
};
type Client = Pick<AppServerClient, 'start' | 'stop' | 'request' | 'respondApproval' | 'on' | 'off'>;
const forbidden = /\b(?:git\s+(?:add|commit|push|pull|checkout|reset|clean|stash|merge|rebase)|(?:edita|modifica|borra|elimina|crea|escribe|despliega|publica|sube|instala|ejecuta)\s+(?:archivos?|c[oó]digo|cambios?|commits?|comandos?|scripts?|migraciones?|datos?|en\s+supabase)|rm\s+-|remove-item\b)\b/i;
const deleteCommand = /(?:^|[\r\n;&|`])\s*(?:cmd(?:\.exe)?\s+\/c\s+)?del\s+\S/i;
function safeResult(value: string): string {
  return sanitizeForOutput(value, 1900).replace(/(?:[A-Za-z]:\\Users\\|\/Users\/|\/home\/)[^\s)]+/gi, '[LOCAL_PATH]');
}

export class ReadOnlyCodexAnalyzer {
  private busy = false;
  constructor(private registry: ProjectRegistry, private deviceId: string, private stateFile: string, private makeClient: () => Client = () => new AppServerClient()) {}
  async analyze(project: string, instruction: string, options: { profile?: RequestedProfile; category?: ExecutionCategory } = {}): Promise<AnalysisResult> {
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(project)) throw new Error('Project unavailable');
    const resolved = this.registry.resolve(project);
    if (typeof instruction !== 'string' || instruction.trim().length < 10 || instruction.length > 500 || forbidden.test(instruction) || deleteCommand.test(instruction)) throw new Error('Only bounded read-only analysis is supported');
    if (this.busy) throw new Error('Analysis busy');
    this.busy = true;
    const client = this.makeClient();
    try {
      const key = `${this.deviceId}/${project}`;
      const state = new ThreadStateStore(this.stateFile);
      await client.start();
      let threadId = await state.get(key);
      let threadCreated = false;
      if (threadId) {
        try { await client.request('thread/resume', { threadId, cwd: resolved.path, excludeTurns: true, sandbox: 'read-only', approvalPolicy: 'on-request' }); }
        catch (error: any) { if (!/thread (?:not found|does not exist|unknown)/i.test(String(error?.message))) throw error; threadId = undefined; }
      }
      const selected = resolveExecutionProfile({ requested: options.profile, operation: 'analysis', category: options.category, instruction });
      const runtime = await selectCodexRuntime(client, resolved.path, this.registry.config.codex?.defaultModel, selected.reasoning);
      if (!threadId) {
        const created = await client.request<{ thread: { id: string } }>('thread/start', { cwd: resolved.path, sandbox: 'read-only', approvalPolicy: 'on-request', ...(runtime.modelOverride ? { model: runtime.modelOverride } : {}) });
        threadId = created.thread.id;
        if (!/^[a-z0-9-]{10,100}$/i.test(threadId)) throw new Error('Invalid Codex thread ID');
        await state.setThread(key, threadId); threadCreated = true;
      }
      const capsule = await buildContextCapsule({ registry: this.registry, project, deviceId: this.deviceId, selectedProfile: selected.profile, requestedReasoning: runtime.requestedReasoning, selectedReasoning: runtime.reasoning, requestedModel: runtime.requestedModel, instruction: instruction.trim() });
      let output = '', blockedActions = 0;
      let cleanupCompletion = () => {};
      const completion = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error('Codex analysis timed out')); }, 150_000);
        const onNotification = (message: any) => {
          if (message.params?.threadId !== threadId) return;
          if (message.method === 'item/agentMessage/delta') output = (output + String(message.params.delta ?? '')).slice(-6000);
          if (message.method === 'turn/completed') { cleanup(); message.params.turn?.status === 'completed' ? resolve() : reject(new Error('Codex analysis did not complete')); }
        };
        const onApproval = (approval: any) => { blockedActions++; try { client.respondApproval(approval.approvalId, 'decline'); } catch { /* Stop below. */ } };
        const onClosed = () => { cleanup(); reject(new Error('Codex app-server closed')); };
        const cleanup = () => { clearTimeout(timer); client.off('notification', onNotification); client.off('approval', onApproval); client.off('closed', onClosed); };
        cleanupCompletion = cleanup;
        client.on('notification', onNotification); client.on('approval', onApproval); client.on('closed', onClosed);
      });
      let turn;
      try {
        turn = await client.request<{ turn: { id: string } }>('turn/start', { threadId, input: [{ type: 'text', text: `${capsule.text}\n\nPerfil obligatorio: análisis de solo lectura. No modifiques archivos, Git, servicios ni red. Toda solicitud de escritura queda fuera de alcance. No leas ni reveles secretos o archivos de configuración privada.`, text_elements: [] }], effort: runtime.reasoning, ...(runtime.modelOverride ? { model: runtime.modelOverride } : {}) });
        await completion;
      } catch (error) { cleanupCompletion(); void completion.catch(() => {}); throw error; }
      if (!turn.turn?.id || !output.trim()) throw new Error('Codex returned no analysis');
      const observed = await observeThreadRuntime(client, threadId, runtime);
      await state.record(key, { lastTurnId: turn.turn.id, lastHead: capsule.git.head, selectedProfile: selected.profile, requestedReasoning: runtime.requestedReasoning, requestedModel: runtime.requestedModel, updatedAt: new Date().toISOString() });
      return { project, deviceId: this.deviceId, threadId, threadCreated, turnId: turn.turn.id, status: 'completed', result: safeResult(output.trim()), blockedActions, selectedProfile: selected.profile, requestedModel: runtime.requestedModel, requestedReasoning: runtime.requestedReasoning, runtimeModel: observed.runtimeModel, runtimeReasoning: observed.runtimeReasoning };
    } finally { client.stop(); this.busy = false; }
  }
}
