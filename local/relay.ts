import WebSocket from 'ws';
import { isExecutionCategory, isRequestedProfile, type ExecutionCategory, type RequestedProfile } from '../src/execution-profile.js';
type ProfileOptions = { profile?: RequestedProfile; category?: ExecutionCategory };
type ChangeHandlers = { prepare(project: string, instruction: string, options?: ProfileOptions): Promise<any>; approve(approvalId: string): Promise<any>; apply(approvalId: string): Promise<any> };
import { validProjectGitStatus, validProjectContextSnapshot, validProjectSearchResult, validProjectAnalysisResult, type SmokeResult, type ProjectGitStatus, type ProjectContextSnapshot, type ProjectSearchResult, type ProjectAnalysisResult } from '../src/relay-protocol.js';
const LOCAL_SMOKE_PER_MINUTE = 100;
// Above the combined per-device gateway daily budgets; the gateway reports quota errors first.
const LOCAL_REQUESTS_PER_MINUTE = 1200;

export function startRelay(options: { origin: string; deviceId: string; token: string; smoke: () => Promise<SmokeResult>; projectStatus?: (project: string) => Promise<ProjectGitStatus>; contextSnapshot?: (project: string) => Promise<ProjectContextSnapshot>; projectSearch?: (project: string, query: string) => Promise<ProjectSearchResult>; projectAnalyze?: (project: string, instruction: string, options?: ProfileOptions) => Promise<ProjectAnalysisResult>; changes?: ChangeHandlers; onStatus?: (status: string, requestId?: string) => void; now?: () => number }) {
  const url = new URL(options.origin);
  const local = ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (!local && url.protocol !== 'https:') || !/^[a-z0-9-]{2,64}$/.test(options.deviceId) || options.token.length < 32) throw new Error('Invalid relay configuration');
  url.pathname = '/relay'; url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  let socket: WebSocket | undefined, retry: ReturnType<typeof setTimeout> | undefined, heartbeat: ReturnType<typeof setInterval> | undefined;
  let stopped = false, busy = false, calls = 0, readCalls = 0, lastPong = Date.now();
  let backoff = 1000, windowStart = (options.now ?? Date.now)();
  const seen = new Set<string>();
  const remember = (id: string) => {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > 512) seen.delete(seen.values().next().value!);
    return true;
  };
  const connect = () => {
    if (stopped) return;
    socket = new WebSocket(url, { headers: { Authorization: `Bearer ${options.token}`, 'X-Device-Id': options.deviceId }, maxPayload: 4096, handshakeTimeout: 15_000 });
    const current = socket;
    current.on('open', () => {
      lastPong = Date.now(); backoff = 1000; options.onStatus?.('connected');
      heartbeat = setInterval(() => {
        if (current.readyState !== WebSocket.OPEN) return;
        if (Date.now() - lastPong > 60_000) current.terminate();
        else current.send('ping');
      }, 20_000);
    });
    current.on('message', async data => {
      if (data.toString() === 'pong') { lastPong = Date.now(); return; }
      if (stopped || current.readyState !== WebSocket.OPEN) return;
      let message: any;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      const now = (options.now ?? Date.now)();
      if (now - windowStart >= 60_000 || now < windowStart) {
        calls = readCalls = 0;
        windowStart = now;
      }
      if (message.type === 'project_change') {
        const args = message.args;
        const prepareKeys = args && Object.keys(args).every(key => ['instruction', 'project', 'profile', 'category'].includes(key)) && ['instruction', 'project'].every(key => key in args);
        const prepare = message.operation === 'prepare' && prepareKeys && /^[a-z0-9][a-z0-9_-]{1,63}$/.test(args.project) && typeof args.instruction === 'string' && args.instruction.length >= 10 && args.instruction.length <= 500 && (args.profile === undefined || isRequestedProfile(args.profile)) && (args.category === undefined || isExecutionCategory(args.category));
        const byId = ['approve', 'apply'].includes(message.operation) && args && Object.keys(args).join(',') === 'approvalId' && /^[0-9a-f-]{36}$/.test(args.approvalId);
        if ((!prepare && !byId) || Object.keys(message).sort().join(',') !== 'args,id,operation,type' || !/^[0-9a-f-]{36}$/.test(message.id) || !remember(message.id)) return;
        if (busy || readCalls >= LOCAL_REQUESTS_PER_MINUTE || !options.changes) { current.send(JSON.stringify({ type: 'project_change_result', id: message.id, ok: false })); return; }
        busy = true; readCalls++; options.onStatus?.(`change-${message.operation}-started`, message.id);
        try {
          const value = prepare ? await options.changes.prepare(args.project, args.instruction, { profile: args.profile, category: args.category }) : message.operation === 'approve' ? await options.changes.approve(args.approvalId) : await options.changes.apply(args.approvalId);
          if (JSON.stringify(value).length > 7000 || value.deviceId !== options.deviceId) throw new Error('Invalid result');
          if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify({ type: 'project_change_result', id: message.id, ok: true, value }));
          options.onStatus?.(`change-${message.operation}-ok`, message.id);
        } catch { if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify({ type: 'project_change_result', id: message.id, ok: false })); options.onStatus?.(`change-${message.operation}-denied`, message.id); }
        finally { busy = false; }
        return;
      }
      const isSmoke = message.type === 'smoke' && Object.keys(message).sort().join(',') === 'id,type';
      const isRead = message.type === 'project_git_status' && Object.keys(message).sort().join(',') === 'id,project,type' && /^[a-z0-9][a-z0-9_-]{1,63}$/.test(message.project ?? '');
      const isContext = message.type === 'project_context_snapshot' && Object.keys(message).sort().join(',') === 'id,project,type' && /^[a-z0-9][a-z0-9_-]{1,63}$/.test(message.project ?? '');
      const isSearch = message.type === 'project_search' && Object.keys(message).sort().join(',') === 'id,project,query,type' && /^[a-z0-9][a-z0-9_-]{1,63}$/.test(message.project ?? '') && typeof message.query === 'string' && message.query.length >= 2 && message.query.length <= 80 && /^[\p{L}\p{N} _.-]+$/u.test(message.query) && !message.query.includes('..') && !message.query.startsWith('.');
      const analyzeKeys = Object.keys(message).every(key => ['id', 'instruction', 'project', 'type', 'profile', 'category'].includes(key)) && ['id', 'instruction', 'project', 'type'].every(key => key in message);
      const isAnalyze = message.type === 'codex_project_analyze' && analyzeKeys && /^[a-z0-9][a-z0-9_-]{1,63}$/.test(message.project ?? '') && typeof message.instruction === 'string' && message.instruction.length >= 10 && message.instruction.length <= 500 && (message.profile === undefined || isRequestedProfile(message.profile)) && (message.category === undefined || isExecutionCategory(message.category));
      if ((!isSmoke && !isRead && !isContext && !isSearch && !isAnalyze) || !/^[0-9a-f-]{36}$/.test(message.id) || !remember(message.id)) return;
      const resultType = isSmoke ? 'result' : isContext ? 'project_context_snapshot_result' : isSearch ? 'project_search_result' : isAnalyze ? 'codex_project_analyze_result' : 'project_git_status_result';
      if (busy || (isSmoke ? calls >= LOCAL_SMOKE_PER_MINUTE : readCalls >= LOCAL_REQUESTS_PER_MINUTE)) { current.send(JSON.stringify({ type: resultType, id: message.id, ok: false })); return; }
      busy = true; if (isSmoke) calls++; else readCalls++;
      if (isAnalyze) {
        options.onStatus?.('analysis-started', message.id);
        try {
          if (!options.projectAnalyze) throw new Error('Analysis unavailable');
          const analysis = await options.projectAnalyze(message.project, message.instruction, { profile: message.profile, category: message.category });
          if (!validProjectAnalysisResult(analysis) || analysis.project !== message.project || analysis.deviceId !== options.deviceId) throw new Error('Invalid analysis');
          if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify({ type: resultType, id: message.id, ok: true, analysis }));
          options.onStatus?.('analysis-ok', message.id);
        } catch {
          if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify({ type: resultType, id: message.id, ok: false }));
          options.onStatus?.('analysis-failed', message.id);
        } finally { busy = false; }
        return;
      }
      if (isSearch) {
        options.onStatus?.('search-started', message.id);
        try {
          if (!options.projectSearch) throw new Error('Project search unavailable');
          const search = await options.projectSearch(message.project, message.query);
          if (!validProjectSearchResult(search) || search.project !== message.project || search.query !== message.query || search.deviceId !== options.deviceId) throw new Error('Invalid search');
          if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify({ type: resultType, id: message.id, ok: true, search }));
          options.onStatus?.('search-ok', message.id);
        } catch {
          if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify({ type: resultType, id: message.id, ok: false }));
          options.onStatus?.('search-failed', message.id);
        } finally { busy = false; }
        return;
      }
      if (isContext) {
        options.onStatus?.('context-started', message.id);
        try {
          if (!options.contextSnapshot) throw new Error('Project context unavailable');
          const snapshot = await options.contextSnapshot(message.project);
          if (!validProjectContextSnapshot(snapshot) || snapshot.project !== message.project || snapshot.deviceId !== options.deviceId) throw new Error('Invalid context');
          if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify({ type: resultType, id: message.id, ok: true, snapshot }));
          options.onStatus?.('context-ok', message.id);
        } catch {
          if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify({ type: resultType, id: message.id, ok: false }));
          options.onStatus?.('context-failed', message.id);
        } finally { busy = false; }
        return;
      }
      if (isRead) {
        options.onStatus?.('git-status-started', message.id);
        try {
          if (!options.projectStatus) throw new Error('Project status unavailable');
          const status = await options.projectStatus(message.project);
          if (!validProjectGitStatus(status) || status.project !== message.project || status.deviceId !== options.deviceId) throw new Error('Invalid project status');
          if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify({ type: 'project_git_status_result', id: message.id, ok: true, status }));
          options.onStatus?.('git-status-ok', message.id);
        } catch {
          if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify({ type: 'project_git_status_result', id: message.id, ok: false }));
          options.onStatus?.('git-status-failed', message.id);
        } finally { busy = false; }
        return;
      }
      options.onStatus?.('smoke-started', message.id);
      try {
        const result = await options.smoke();
        if (result.response !== 'BRIDGE_E2E_OK') throw new Error('Invalid response');
        if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify({ type: 'result', id: message.id, ok: true, response: 'BRIDGE_E2E_OK' }));
        options.onStatus?.('smoke-ok', message.id);
      } catch {
        if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify({ type: 'result', id: message.id, ok: false }));
        options.onStatus?.('smoke-failed', message.id);
      } finally { busy = false; }
    });
    current.on('error', () => options.onStatus?.('connection-error'));
    current.on('close', () => {
      clearInterval(heartbeat);
      options.onStatus?.('disconnected');
      if (stopped) return;
      options.onStatus?.('reconnect-scheduled');
      retry = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    });
  };
  connect();
  return { stop() { stopped = true; clearTimeout(retry); clearInterval(heartbeat); socket?.close(1000, 'Stopped'); } };
}
