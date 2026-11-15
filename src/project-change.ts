import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { AppServerClient } from './app-server-client.js';
import { ChangeApprovalStore } from './change-approval.js';
import { ProjectRegistry } from './project-registry.js';
import { readProjectGitStatus } from './project-git-status.js';
import { sanitizeForOutput } from './security.js';
import { buildContextCapsule } from './context-capsule.js';
import { resolveExecutionProfile, type ExecutionCategory, type ReasoningEffort, type RequestedProfile, type SelectedProfile } from './execution-profile.js';
import { observeThreadRuntime, selectCodexRuntime } from './codex-runtime.js';
const exec = promisify(execFile);
async function git(root: string, ...args: string[]) { return (await exec('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', root, ...args], { windowsHide: true, timeout: 10000, maxBuffer: 4_000_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } })).stdout; }
export async function checkoutFingerprint(root: string) {
  const head = (await git(root, 'rev-parse', 'HEAD')).trim();
  const status = await git(root, 'status', '--porcelain=v1', '-uall');
  const index = await git(root, 'diff', '--cached', '--raw', '--no-abbrev', '-z');
  const files = [...new Set((await git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard')).split('\0').filter(Boolean))].sort();
  if (files.length > 10000) throw new Error('Checkout too large');
  const branch = await git(root, 'branch', '--show-current');
  const hash = createHash('sha256').update(head).update(branch).update(status).update(index);
  const hashes: Record<string, string> = {}; let bytes = 0;
  for (const file of files) {
    const full = path.join(root, file); let stat;
    try { stat = await lstat(full); } catch (e: any) { if (e.code === 'ENOENT') { hash.update(file + ':missing'); continue; } throw e; }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsupported checkout entry');
    bytes += stat.size; if (bytes > 100_000_000) throw new Error('Checkout too large');
    const value = createHash('sha256').update(await readFile(full)).digest('hex');
    hashes[file] = value; hash.update(file + ':' + value);
  }
  return { head, status, index, hashes, fingerprint: hash.digest('hex') };
}
function safe(text: string, root: string, limit = 1800) { return sanitizeForOutput(text.replaceAll(root, '[PROJECT]').split('\n').map(line => /(?:gh[pousr]_[a-zA-Z0-9]{15,}|BEGIN .*PRIVATE KEY|(?:password|secret|api[_-]?key|token)\s*[:=]|[?&](?:sig|signature|token)=)/i.test(line) ? '[SENSITIVE_LINE_OMITTED]' : line).join('\n'), limit).replace(/(?:[A-Za-z]:\\Users\\|\/Users\/|\/home\/)[^\r\n`]+/g, '[LOCAL_PATH]'); }
const schema = { type: 'object', additionalProperties: false, properties: { summary: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, tests: { type: 'array', items: { type: 'string' } }, warnings: { type: 'array', items: { type: 'string' } } }, required: ['summary', 'files', 'tests', 'warnings'] };
export class ProjectChangeService {
  private busy = false;
  constructor(private registry: ProjectRegistry, private deviceId: string, private approvals: ChangeApprovalStore, private threadFor: (project: string) => Promise<string>, private command = 'codex', private testPlanner?: (text: string, execution?: { selectedProfile: SelectedProfile; requestedModel: string; requestedReasoning: ReasoningEffort }) => Promise<{ turnId: string; output: string; blockedActions: number }>, private recordThread?: (project: string, metadata: { lastTurnId: string; lastHead: string; selectedProfile: SelectedProfile; requestedReasoning: ReasoningEffort; requestedModel: string; updatedAt: string }) => Promise<void>) {}
  private async turn(project: string, root: string, threadId: string, instruction: string, execution: { selectedProfile: SelectedProfile; requestedReasoning: ReasoningEffort; requestedModel?: string }, text: string, files: string[] = [], outputSchema?: object) {
    const configuredModel = execution.requestedModel && execution.requestedModel !== 'NO_VERIFICADO' ? execution.requestedModel : this.registry.config.codex?.defaultModel;
    if (this.testPlanner) {
      const capsule = await buildContextCapsule({ registry: this.registry, project, deviceId: this.deviceId, selectedProfile: execution.selectedProfile, requestedReasoning: execution.requestedReasoning, requestedModel: configuredModel || 'NO_VERIFICADO', instruction });
      const result = await this.testPlanner(`${capsule.text}\n\n${text}`, { selectedProfile: execution.selectedProfile, requestedModel: configuredModel || 'NO_VERIFICADO', requestedReasoning: execution.requestedReasoning });
      return { ...result, selectedProfile: execution.selectedProfile, requestedModel: configuredModel || 'NO_VERIFICADO', requestedReasoning: execution.requestedReasoning, runtimeModel: 'NO_VERIFICADO', runtimeReasoning: 'NO_VERIFICADO', gitHead: capsule.git.head };
    }
    const client = new AppServerClient({ command: this.command }); let blockedActions = 0; let output = ''; let turnId = '';
    let clean = () => {};
    try {
      await client.start();
      const initial = await client.request<any>('mcpServerStatus/list', {});
      if (!Array.isArray(initial.data) || initial.nextCursor) throw new Error('Cannot isolate external tools');
      const disabledPluginIds = [...new Set(initial.data.map((s: any) => s.pluginId).filter((id: any) => typeof id === 'string'))];
      const configuration = await client.request<any>('config/read', { includeLayers: false, cwd: root });
      const configuredServers = configuration.config?.mcp_servers;
      if (!configuredServers || typeof configuredServers !== 'object') throw new Error('Cannot isolate server configuration');
      const overrides: Record<string, any> = { web_search: 'disabled', 'features.apps': false, mcp_servers: Object.fromEntries(Object.entries(configuredServers).map(([name, value]) => {
        const s = value as any;
        if (typeof s.command === 'string') return [name, { command: s.command, args: Array.isArray(s.args) ? s.args : [], enabled: false }];
        if (typeof s.url === 'string') return [name, { url: s.url, enabled: false }];
        throw new Error('Unsupported external server configuration');
      })) };
      await client.request('thread/resume', { threadId, cwd: root, excludeTurns: true, sandbox: 'read-only', approvalPolicy: 'on-request', config: overrides });
      const catalog = await client.request<any>('mcpServerStatus/list', { threadId });
      if (!Array.isArray(catalog.data) || catalog.nextCursor) throw new Error('Cannot isolate complete tool catalog');
      for (const server of catalog.data) if (server.pluginId && !disabledPluginIds.includes(server.pluginId)) disabledPluginIds.push(server.pluginId);
      if (catalog.data.some((s: any) => !s.pluginId && s.runtimeStatus !== 'disabled')) throw new Error('Change profile requires disabled external MCP servers: ' + catalog.data.filter((s: any) => !s.pluginId).map((s: any) => `${s.name}:${s.runtimeStatus}`).join(','));
      const runtime = await selectCodexRuntime(client, root, configuredModel, execution.requestedReasoning);
      const capsule = await buildContextCapsule({ registry: this.registry, project, deviceId: this.deviceId, selectedProfile: execution.selectedProfile, requestedReasoning: runtime.requestedReasoning, selectedReasoning: runtime.reasoning, requestedModel: runtime.requestedModel, instruction });
      const completion = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { clean(); reject(new Error('Codex change timed out')); }, 150000);
        const notification = (m: any) => {
          if (m.params?.threadId !== threadId) return;
          const item = m.params?.item;
          if (m.method === 'item/completed' && item?.type === 'agentMessage') output = String(item.text ?? '').slice(0, 10000);
          if (m.method === 'turn/completed') { clean(); m.params.turn?.status === 'completed' ? resolve() : reject(new Error('Codex turn failed')); }
        };
        const approval = (a: any) => { blockedActions++; if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(a.method)) client.respondApproval(a.approvalId, 'decline'); else client.stop(); };
        const closed = () => { clean(); reject(new Error('Codex disconnected')); };
        clean = () => { clearTimeout(timer); client.off('notification', notification); client.off('approval', approval); client.off('closed', closed); };
        client.on('notification', notification); client.on('approval', approval); client.on('closed', closed);
      });
      void completion.catch(() => {});
      const response = await client.request<any>('turn/start', { threadId, disabledPluginIds, input: [{ type: 'text', text: `${capsule.text}\n\n${text}`, text_elements: [] }], approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false }, outputSchema, effort: runtime.reasoning, ...(runtime.modelOverride ? { model: runtime.modelOverride } : {}) });
      turnId = response.turn.id; await completion;
      const observed = await observeThreadRuntime(client, threadId, runtime);
      return { turnId, output, blockedActions, selectedProfile: execution.selectedProfile, requestedModel: runtime.requestedModel, requestedReasoning: runtime.requestedReasoning, runtimeModel: observed.runtimeModel, runtimeReasoning: observed.runtimeReasoning, gitHead: capsule.git.head };
    } finally { clean(); client.stop(); }
  }
  private async approvedPaths(project: string, files: string[]) {
    const resolved = this.registry.resolve(project); const roots = resolved.changeRoots ?? [];
    if (!roots.length || !files.length || files.length > 5) throw new Error('Write scope unavailable');
    for (const file of files) {
      if (!/^[a-zA-Z0-9_/-]+\.(?:js|ts|css|html|md|txt)$/.test(file) || file.split('/').some(p => p === '..' || p.startsWith('.')) || /(?:secret|credential|password|token|PLAN_DIARIO|LOG_DIARIO)/i.test(file) || !roots.some(r => /^[a-zA-Z0-9_/-]+$/.test(r) && !r.includes('..') && (file === r || file.startsWith(r + '/')))) throw new Error('File outside authorized scope');
      const full = path.join(resolved.path, file);
      const stat = await lstat(full);
      const canonical = await realpath(full);
      if ((process.platform === 'win32' ? canonical.toLowerCase() !== full.toLowerCase() : canonical !== full) || !stat.isFile() || stat.size > 6000) throw new Error('Only existing small regular files supported');
      if ((await git(resolved.path, 'status', '--porcelain=v1', '--', file)).trim()) throw new Error('Existing local changes protected');
    }
    return resolved.path;
  }
  async prepare(project: string, instruction: string, options: { profile?: RequestedProfile; category?: ExecutionCategory } = {}) {
    if (this.busy) throw new Error('Change operation busy'); this.busy = true;
    try {
      if (typeof instruction !== 'string' || instruction.length < 10 || instruction.length > 500 || /\b(?:git\s+(?:add|commit|push|pull|checkout|reset|clean|stash|merge|rebase)|supabase|cloudflare|production|producción|secret|credential)\b/i.test(instruction)) throw new Error('Instruction outside supported scope');
      const root = this.registry.resolve(project).path; const threadId = await this.threadFor(project);
      const before = await checkoutFingerprint(root);
      const selected = resolveExecutionProfile({ requested: options.profile, operation: 'prepare', category: options.category, instruction });
      const turn = await this.turn(project, root, threadId, instruction, { selectedProfile: selected.profile, requestedReasoning: selected.reasoning }, `PREPARE READ-ONLY. Do not modify anything. Plan only this change: ${instruction}. Return JSON summary, relative existing files (max 5), tests (only the check ID "syntax", no shell), warnings. Never propose dirty files or secrets. Allowed roots: ${JSON.stringify(this.registry.resolve(project).changeRoots ?? [])}`, [], schema);
      if ((await checkoutFingerprint(root)).fingerprint !== before.fingerprint) throw new Error('Checkout changed during prepare');
      const plan = JSON.parse(turn.output);
      if (!Array.isArray(plan.files) || !Array.isArray(plan.tests) || plan.tests.some((v: unknown) => v !== 'syntax') || typeof plan.summary !== 'string' || !Array.isArray(plan.warnings)) throw new Error('Invalid plan');
      await this.approvedPaths(project, plan.files);
      const record = await this.approvals.create({ project, deviceId: this.deviceId, threadId, turnId: turn.turnId, instruction, baseHead: before.head, fingerprint: before.fingerprint, summary: safe(plan.summary, root, 400), files: plan.files, tests: plan.tests, warnings: plan.warnings.map((v: any) => safe(String(v), root, 200)).slice(0, 4), selectedProfile: turn.selectedProfile, requestedModel: turn.requestedModel, requestedReasoning: turn.requestedReasoning });
      await this.recordThread?.(project, { lastTurnId: turn.turnId, lastHead: turn.gitHead, selectedProfile: turn.selectedProfile, requestedReasoning: turn.requestedReasoning, requestedModel: turn.requestedModel, updatedAt: new Date().toISOString() });
      const { instruction: _, humanApproved: __, ...publicRecord } = record;
      return { ...publicRecord, baseGit: await readProjectGitStatus(this.registry, project, this.deviceId), approvalStatus: 'EXPLICIT_USER_APPROVAL_REQUIRED', runtimeModel: turn.runtimeModel, runtimeReasoning: turn.runtimeReasoning };
    } finally { this.busy = false; }
  }
  async approve(approvalId: string) {
    if (this.busy) throw new Error('Change operation busy'); this.busy = true;
    try {
      const plan = await this.approvals.get(approvalId);
      if (plan.deviceId !== this.deviceId || plan.humanApproved) throw new Error('Approval denied');
      const root = await this.approvedPaths(plan.project, plan.files);
      const threadId = await this.threadFor(plan.project); const current = await checkoutFingerprint(root);
      if (plan.threadId !== threadId || plan.baseHead !== current.head || plan.fingerprint !== current.fingerprint) throw new Error('Checkout changed; prepare again');
      await this.approvals.approve(approvalId, plan.digest);
      return { project: plan.project, deviceId: this.deviceId, threadId, approvalId, digest: plan.digest, expiresAt: plan.expiresAt, approvalStatus: 'APPROVED', selectedProfile: plan.selectedProfile, requestedModel: plan.requestedModel, requestedReasoning: plan.requestedReasoning };
    } finally { this.busy = false; }
  }
  async apply(approvalId: string) {
    if (this.busy) throw new Error('Change operation busy'); this.busy = true;
    try {
      const plan = await this.approvals.get(approvalId); const root = await this.approvedPaths(plan.project, plan.files);
      const threadId = await this.threadFor(plan.project); const before = await checkoutFingerprint(root);
      await this.approvals.consume(approvalId, { project: plan.project, deviceId: this.deviceId, threadId, baseHead: before.head, fingerprint: before.fingerprint });
      const replacementSchema = { type: 'object', additionalProperties: false, properties: { summary: { type: 'string' }, replacements: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { file: { type: 'string' }, content: { type: 'string' } }, required: ['file', 'content'] } } }, required: ['summary', 'replacements'] };
      const turn = await this.turn(plan.project, root, threadId, plan.instruction, { selectedProfile: plan.selectedProfile, requestedReasoning: plan.requestedReasoning, requestedModel: plan.requestedModel }, `Generate content for explicitly approved change. Instruction: ${plan.instruction}. Read the CURRENT contents and return JSON summary and replacements: [{file, content}], with complete new contents only for these files: ${JSON.stringify(plan.files)}. Do not modify anything or run tests, Git mutations, network, apps, MCP or services. Do not read secrets. Bridge validates and writes the returned content separately. Max total 6000 characters. If scope is insufficient return empty replacements and summary NEW_APPROVAL_REQUIRED.`, [], replacementSchema);
      const replacement = JSON.parse(turn.output);
      if (!Array.isArray(replacement.replacements) || !replacement.replacements.length || replacement.replacements.length > plan.files.length || JSON.stringify(replacement).length > 8000 || replacement.replacements.some((r: any) => !plan.files.includes(r.file) || typeof r.content !== 'string' || r.content.includes('\0')) || new Set(replacement.replacements.map((r: any) => r.file)).size !== replacement.replacements.length) throw new Error('NEW_APPROVAL_REQUIRED');
      if ((await checkoutFingerprint(root)).fingerprint !== before.fingerprint) throw new Error('Checkout changed during generation');
      await this.approvedPaths(plan.project, plan.files);
      const writer = new AppServerClient({ command: this.command });
      try {
        await writer.start();
        const payload = JSON.stringify(replacement.replacements.map((r: any) => ({ file: path.join(root, r.file), content: r.content, expectedHash: before.hashes[r.file] })));
        const written = await writer.request<any>('command/exec', { command: [process.execPath, '-e', "const fs=require('node:fs'),crypto=require('node:crypto'); const rows=JSON.parse(process.argv[1]),fds=[];try{for(const r of rows){const f=fs.openSync(r.file,'r+');fds.push(f);if(crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')!==r.expectedHash)throw Error('Checkout changed');}rows.forEach((r,i)=>{fs.ftruncateSync(fds[i],0);fs.writeSync(fds[i],Buffer.from(r.content),0,Buffer.byteLength(r.content),0);});}finally{fds.forEach(f=>fs.closeSync(f));}", payload], cwd: root, sandboxPolicy: { type: 'workspaceWrite', writableRoots: plan.files.map(file => path.join(root, file)), networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }, timeoutMs: 15000 });
        if (written.exitCode !== 0) throw new Error('Sandboxed write failed; inspect checkout');
      } finally { writer.stop(); }
      const checks: Array<{ check: string; file: string; exitCode: number }> = [];
      if (plan.tests.includes('syntax')) {
        const client = new AppServerClient({ command: this.command });
        try { await client.start(); for (const file of plan.files.filter(f => f.endsWith('.js'))) {
          const r = await client.request<any>('command/exec', { command: [process.execPath, '--check', path.join(root, file)], cwd: root, sandboxPolicy: { type: 'readOnly', networkAccess: false }, timeoutMs: 15000 }); checks.push({ check: 'syntax', file, exitCode: r.exitCode });
        } } finally { client.stop(); }
      }
      const after = await checkoutFingerprint(root);
      const changedFiles = [...new Set([...Object.keys(before.hashes), ...Object.keys(after.hashes)])].filter(f => before.hashes[f] !== after.hashes[f]);
      const scopeOk = changedFiles.every(f => plan.files.includes(f));
      const status = !(scopeOk && before.head === after.head && before.index === after.index) ? 'POSTCONDITION_FAILED' : checks.some(c => c.exitCode !== 0) ? 'CHECKS_FAILED' : 'completed';
      const diff = await git(root, 'diff', '--no-ext-diff', '--no-textconv', '--', ...plan.files);
      const stat = await git(root, 'diff', '--stat', '--no-ext-diff', '--', ...plan.files);
      await this.recordThread?.(plan.project, { lastTurnId: turn.turnId, lastHead: after.head, selectedProfile: plan.selectedProfile, requestedReasoning: plan.requestedReasoning, requestedModel: plan.requestedModel, updatedAt: new Date().toISOString() });
      return { project: plan.project, deviceId: this.deviceId, threadId, turnId: turn.turnId, status, headBefore: before.head, headAfter: after.head, changedFiles, diffStat: safe(stat, root, 500), tests: checks, summary: safe(String(replacement.summary), root, 400), boundedDiff: safe(diff, root, 1600), truncated: diff.length > 1600, blockedActions: turn.blockedActions, git: await readProjectGitStatus(this.registry, plan.project, this.deviceId), selectedProfile: plan.selectedProfile, requestedModel: plan.requestedModel, requestedReasoning: plan.requestedReasoning, runtimeModel: turn.runtimeModel, runtimeReasoning: turn.runtimeReasoning };
    } finally { this.busy = false; }
  }
}
