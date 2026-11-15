export type SmokeResult = { bridge: 'ok'; codex: 'ok'; response: 'BRIDGE_E2E_OK' };
export type ProjectGitStatus = {
  project: string; deviceId: string; branch: string; head: string; clean: boolean;
  staged: number; unstaged: number; untracked: number; upstream: string | null; ahead: number; behind: number;
};
export type ProjectContextSnapshot = {
  project: string; deviceId: string; git: ProjectGitStatus;
  contextSources: Array<{ path: string; role: 'instructions' | 'operational' | 'continuity' | 'phase-result'; status: 'ok' | 'missing' | 'oversize'; dirty: boolean; excerpts: string[] }>;
  currentState: string | null; currentPhase: string | null; nextAction: string | null;
  warnings: string[];
};
export type ProjectSearchResult = {
  project: string; deviceId: string; query: string;
  matches: Array<{ file: string; line: number; snippet: string }>;
  truncated: boolean; totalMatches: number;
};
export type ProjectAnalysisResult = { project: string; deviceId: string; threadId: string; threadCreated: boolean; turnId: string; status: 'completed'; result: string; blockedActions: number; selectedProfile: string; requestedModel: string; requestedReasoning: string; runtimeModel: string; runtimeReasoning: string };
export function validProjectAnalysisResult(v: any): v is ProjectAnalysisResult {
  const safeRuntime = (value: unknown) => typeof value === 'string' && value.length <= 80 && /^[A-Za-z0-9._-]+$/.test(value);
  return v && Object.keys(v).sort().join(',') === 'blockedActions,deviceId,project,requestedModel,requestedReasoning,result,runtimeModel,runtimeReasoning,selectedProfile,status,threadCreated,threadId,turnId' &&
    /^[a-z0-9][a-z0-9_-]{1,63}$/.test(v.project ?? '') && /^[a-z0-9-]{2,64}$/.test(v.deviceId ?? '') &&
    /^[a-z0-9-]{10,100}$/i.test(v.threadId ?? '') && /^[a-z0-9-]{3,100}$/i.test(v.turnId ?? '') &&
    typeof v.threadCreated === 'boolean' && v.status === 'completed' && typeof v.result === 'string' && v.result.length <= 1900 &&
    Number.isSafeInteger(v.blockedActions) && v.blockedActions >= 0 && ['fast', 'standard', 'deep', 'exceptional'].includes(v.selectedProfile) &&
    safeRuntime(v.requestedModel) && ['low', 'medium', 'high', 'xhigh'].includes(v.requestedReasoning) && safeRuntime(v.runtimeModel) && safeRuntime(v.runtimeReasoning) &&
    new TextEncoder().encode(JSON.stringify(v)).length <= 3400;
}
export function validProjectSearchResult(value: any): value is ProjectSearchResult {
  const safe = (s: unknown) => typeof s === 'string' && s.length <= 140 &&
    !/(?:password|secret|token|bearer|api[_ -]?key|credential|cookie|sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{12,}|https?:\/\/|[a-z]:\\|\/Users\/|\/home\/|@|\b[67]\d{8}\b|[A-Za-z0-9_-]{24,})/i.test(s);
  return value && Object.keys(value).sort().join(',') === 'deviceId,matches,project,query,totalMatches,truncated' &&
    /^[a-z0-9][a-z0-9_-]{1,63}$/.test(value.project ?? '') && /^[a-z0-9-]{2,64}$/.test(value.deviceId ?? '') &&
    typeof value.query === 'string' && value.query.length >= 2 && value.query.length <= 80 &&
    Number.isSafeInteger(value.totalMatches) && value.totalMatches >= 0 && typeof value.truncated === 'boolean' &&
    Array.isArray(value.matches) && value.matches.length <= 10 && value.matches.length <= value.totalMatches &&
    value.matches.every((m: any) => m && Object.keys(m).sort().join(',') === 'file,line,snippet' &&
      typeof m.file === 'string' && m.file.length <= 180 && /^[A-Za-z0-9._/-]+$/.test(m.file) &&
      m.file.split('/').every((p: string) => p && p !== '.' && p !== '..' && !p.startsWith('.')) &&
      !/(?:^|\/)[^/]*(?:secret|credential|token|password|private|api[_-]?key)[^/]*(?:\/|$)/i.test(m.file) &&
      Number.isSafeInteger(m.line) && m.line > 0 && safe(m.snippet)) &&
    new TextEncoder().encode(JSON.stringify(value)).length <= 3000;
}
export function validProjectContextSnapshot(value: any): value is ProjectContextSnapshot {
  const safe = (v: unknown) => typeof v === 'string' && v.length <= 200 &&
    !/(?:password|secret|token|bearer|api[_ -]?key|credential|cookie|sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{12,}|https?:\/\/|[a-z]:\\|\/Users\/|\/home\/|@|\b[67]\d{8}\b|[A-Za-z0-9_-]{24,})/i.test(v);
  const short = (v: unknown) => v === null || safe(v);
  return value && Object.keys(value).sort().join(',') === 'contextSources,currentPhase,currentState,deviceId,git,nextAction,project,warnings' &&
    validProjectGitStatus(value.git) && value.project === value.git.project && value.deviceId === value.git.deviceId &&
    Array.isArray(value.contextSources) && value.contextSources.length >= 1 && value.contextSources.length <= 4 &&
    value.contextSources.every((source: any) => source && Object.keys(source).sort().join(',') === 'dirty,excerpts,path,role,status' &&
      typeof source.path === 'string' && source.path.length <= 160 && /^[A-Za-z0-9._/-]+\.md$/.test(source.path) &&
      (source.path === 'AGENTS.md' || source.path.startsWith('docs/')) && source.path.split('/').every((part: string) => Boolean(part) && part !== '.' && part !== '..' && !part.startsWith('.')) &&
      !/(?:^|\/)[^/]*(?:secret|credential|token|password|private|api[_-]?key)[^/]*\//i.test(`${source.path}/`) &&
      ['instructions', 'operational', 'continuity', 'phase-result'].includes(source.role) &&
      ['ok', 'missing', 'oversize'].includes(source.status) && typeof source.dirty === 'boolean' &&
      Array.isArray(source.excerpts) && source.excerpts.length <= 3 && source.excerpts.every(safe)) &&
    short(value.currentState) && short(value.currentPhase) && short(value.nextAction) &&
    Array.isArray(value.warnings) && value.warnings.length <= 8 && value.warnings.every((warning: unknown) =>
      ['SOURCE_MISSING', 'SOURCE_OVERSIZE', 'SOURCE_LOCAL_DIRTY', 'DOCUMENTATION_DATED_REVALIDATE', 'LOCAL_CHANGES_OUTSIDE_SOURCES', 'EXCERPTS_TRUNCATED'].includes(warning as string)) &&
    new TextEncoder().encode(JSON.stringify(value)).length <= 3800;
}
export function validProjectGitStatus(value: any): value is ProjectGitStatus {
  if (!value || Object.keys(value).sort().join(',') !== 'ahead,behind,branch,clean,deviceId,head,project,staged,unstaged,untracked,upstream') return false;
  const count = (number: unknown) => Number.isSafeInteger(number) && (number as number) >= 0;
  return /^[a-z0-9][a-z0-9_-]{1,63}$/.test(value.project ?? '') &&
    /^[a-z0-9-]{2,64}$/.test(value.deviceId ?? '') &&
    /^[^\s~^:?*\[\\]{1,128}$/.test(value.branch ?? '') &&
    /^[0-9a-f]{40,64}$/.test(value.head ?? '') &&
    typeof value.clean === 'boolean' && [value.staged, value.unstaged, value.untracked, value.ahead, value.behind].every(count) &&
    (value.upstream === null || (typeof value.upstream === 'string' && /^[^\s~^:?*\[\\]{1,128}$/.test(value.upstream))) &&
    value.clean === (value.staged + value.unstaged + value.untracked === 0);
}
export function validResult(value: any): boolean {
  return value?.type === 'result' && typeof value.id === 'string' && value.ok === true && value.response === 'BRIDGE_E2E_OK';
}
export async function authorizedDevice(auth: string | null, device: string | null, token: string, expected: string): Promise<boolean> {
  if (!token || !expected || device !== expected || !auth?.startsWith('Bearer ')) return false;
  const hash = (value: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const a = new Uint8Array(await hash(auth.slice(7))), b = new Uint8Array(await hash(token));
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
export class SmokeBroker {
  private pending?: { id: string; resolve: (value: SmokeResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
  constructor(private timeout = 100_000) {}
  request(socket?: { send(value: string): void }, requestId = crypto.randomUUID()): Promise<SmokeResult> {
    if (!socket) return Promise.reject(new Error('Device unavailable'));
    if (this.pending) return Promise.reject(new Error('Device busy'));
    return new Promise((resolve, reject) => {
      const id = requestId;
      const timer = setTimeout(() => this.fail('Device timeout'), this.timeout);
      this.pending = { id, resolve, reject, timer };
      try { socket.send(JSON.stringify({ type: 'smoke', id })); } catch { this.fail('Device disconnected'); }
    });
  }
  result(value: any): void {
    if (!this.pending || value?.id !== this.pending.id) return;
    if (!validResult(value)) { this.fail('Device check failed'); return; }
    const pending = this.pending; this.pending = undefined; clearTimeout(pending.timer);
    pending.resolve({ bridge: 'ok', codex: 'ok', response: 'BRIDGE_E2E_OK' });
  }
  disconnect(): void { this.fail('Device disconnected'); }
  private fail(message: string): void {
    if (!this.pending) return;
    const pending = this.pending; this.pending = undefined; clearTimeout(pending.timer); pending.reject(new Error(message));
  }
}
export class ProjectStatusBroker {
  private pending?: { id: string; project: string; deviceId: string; resolve: (value: ProjectGitStatus) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
  constructor(private timeout = 20_000) {}
  request(socket: { send(value: string): void }, project: string, deviceId: string, id = crypto.randomUUID()): Promise<ProjectGitStatus> {
    if (this.pending) return Promise.reject(new Error('Device busy'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail('Device timeout'), this.timeout);
      this.pending = { id, project, deviceId, resolve, reject, timer };
      try { socket.send(JSON.stringify({ type: 'project_git_status', id, project })); } catch { this.fail('Device disconnected'); }
    });
  }
  result(value: any): void {
    const pending = this.pending;
    if (!pending || value?.id !== pending.id) return;
    if (value?.type !== 'project_git_status_result' || value.ok !== true || !validProjectGitStatus(value.status) || value.status.project !== pending.project || value.status.deviceId !== pending.deviceId) {
      this.fail('Project status unavailable'); return;
    }
    this.pending = undefined; clearTimeout(pending.timer); pending.resolve(value.status);
  }
  disconnect(): void { this.fail('Device disconnected'); }
  private fail(message: string): void {
    const pending = this.pending; if (!pending) return;
    this.pending = undefined; clearTimeout(pending.timer); pending.reject(new Error(message));
  }
}
export class ProjectContextBroker {
  private pending?: { id: string; project: string; deviceId: string; resolve: (value: ProjectContextSnapshot) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
  constructor(private timeout = 20_000) {}
  request(socket: { send(value: string): void }, project: string, deviceId: string, id = crypto.randomUUID()): Promise<ProjectContextSnapshot> {
    if (this.pending) return Promise.reject(new Error('Device busy'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail('Device timeout'), this.timeout);
      this.pending = { id, project, deviceId, resolve, reject, timer };
      try { socket.send(JSON.stringify({ type: 'project_context_snapshot', id, project })); } catch { this.fail('Device disconnected'); }
    });
  }
  result(value: any): void {
    const pending = this.pending;
    if (!pending || value?.id !== pending.id) return;
    if (value?.type !== 'project_context_snapshot_result' || value.ok !== true || !validProjectContextSnapshot(value.snapshot) || value.snapshot.project !== pending.project || value.snapshot.deviceId !== pending.deviceId) {
      this.fail('Project context unavailable'); return;
    }
    this.pending = undefined; clearTimeout(pending.timer); pending.resolve(value.snapshot);
  }
  disconnect(): void { this.fail('Device disconnected'); }
  private fail(message: string): void {
    const pending = this.pending; if (!pending) return;
    this.pending = undefined; clearTimeout(pending.timer); pending.reject(new Error(message));
  }
}
export class ProjectSearchBroker {
  private pending?: { id: string; project: string; query: string; deviceId: string; resolve: (value: ProjectSearchResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
  constructor(private timeout = 20_000) {}
  request(socket: { send(value: string): void }, project: string, query: string, deviceId: string, id = crypto.randomUUID()): Promise<ProjectSearchResult> {
    if (this.pending) return Promise.reject(new Error('Device busy'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail('Device timeout'), this.timeout);
      this.pending = { id, project, query, deviceId, resolve, reject, timer };
      try { socket.send(JSON.stringify({ type: 'project_search', id, project, query })); } catch { this.fail('Device disconnected'); }
    });
  }
  result(value: any): void {
    const pending = this.pending;
    if (!pending || value?.id !== pending.id) return;
    if (value?.type !== 'project_search_result' || value.ok !== true || !validProjectSearchResult(value.search) ||
      value.search.project !== pending.project || value.search.query !== pending.query || value.search.deviceId !== pending.deviceId) {
      this.fail('Project search unavailable'); return;
    }
    this.pending = undefined; clearTimeout(pending.timer); pending.resolve(value.search);
  }
  disconnect(): void { this.fail('Device disconnected'); }
  private fail(message: string): void {
    const pending = this.pending; if (!pending) return;
    this.pending = undefined; clearTimeout(pending.timer); pending.reject(new Error(message));
  }
}
export class ProjectAnalyzeBroker {
  private pending?: { id: string; project: string; deviceId: string; resolve: (value: ProjectAnalysisResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
  constructor(private timeout = 180_000) {}
  request(socket: { send(value: string): void }, project: string, instruction: string, deviceId: string, id = crypto.randomUUID(), options: { profile?: string; category?: string } = {}): Promise<ProjectAnalysisResult> {
    if (this.pending) return Promise.reject(new Error('Device busy'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail('Device timeout'), this.timeout);
      this.pending = { id, project, deviceId, resolve, reject, timer };
      try { socket.send(JSON.stringify({ type: 'codex_project_analyze', id, project, instruction, ...options })); } catch { this.fail('Device disconnected'); }
    });
  }
  result(value: any): void {
    const pending = this.pending;
    if (!pending || value?.id !== pending.id) return;
    if (value?.type !== 'codex_project_analyze_result' || value.ok !== true || !validProjectAnalysisResult(value.analysis) ||
      value.analysis.project !== pending.project || value.analysis.deviceId !== pending.deviceId) { this.fail('Codex analysis unavailable'); return; }
    this.pending = undefined; clearTimeout(pending.timer); pending.resolve(value.analysis);
  }
  disconnect(): void { this.fail('Device disconnected'); }
  private fail(message: string): void { const pending = this.pending; if (!pending) return; this.pending = undefined; clearTimeout(pending.timer); pending.reject(new Error(message)); }
}

export class ChangeBroker {
  private pending?: { id: string; device: string; resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
  request(socket: { send(v: string): void }, operation: 'prepare' | 'approve' | 'apply', args: object, device: string, id: string): Promise<any> {
    if (this.pending) return Promise.reject(new Error('Device busy'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.disconnect(), 180000);
      this.pending = { id, device, resolve, reject, timer };
      try { socket.send(JSON.stringify({ type: 'project_change', operation, args, id })); } catch { this.disconnect(); }
    });
  }
  result(v: any) {
    const p = this.pending; if (!p || v?.type !== 'project_change_result' || v.id !== p.id) return;
    if (v.ok !== true || v.value?.deviceId !== p.device || JSON.stringify(v.value).length > 7000) { this.disconnect(); return; }
    clearTimeout(p.timer); this.pending = undefined; p.resolve(v.value);
  }
  disconnect() { const p = this.pending; if (!p) return; this.pending = undefined; clearTimeout(p.timer); p.reject(new Error('Change unavailable; inspect checkout')); }
}
