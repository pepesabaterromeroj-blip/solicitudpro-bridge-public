import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ProjectRegistry } from '../src/project-registry.js';
import { ReadOnlyCodexAnalyzer } from '../src/project-analyze.js';

function initGit(root: string) {
  execFileSync('git', ['-C', root, 'init'], { windowsHide: true, stdio: 'pipe' });
  execFileSync('git', ['-C', root, 'add', '.'], { windowsHide: true, stdio: 'pipe' });
  execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'fixture'], { windowsHide: true, stdio: 'pipe' });
}

class FakeCodex extends EventEmitter {
  static nextThread = 1;
  calls: Array<{ method: string; params: any }> = [];
  turn = 0;
  invalid = false;
  requestApproval = false;
  declined = 0;
  async start() {}
  stop() {}
  respondApproval(_: string, decision: string) { assert.equal(decision, 'decline'); this.declined++; }
  async request(method: string, params: any): Promise<any> {
    this.calls.push({ method, params });
    if (method === 'config/read') return { config: { model: 'gpt-test', model_reasoning_effort: 'medium' } };
    if (method === 'model/list') return { data: [{ id: 'gpt-test', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'].map(reasoningEffort => ({ reasoningEffort })) }] };
    if (method === 'thread/start') return { thread: { id: `thread-local-${FakeCodex.nextThread++}` } };
    if (method === 'thread/resume') { if (this.invalid) throw new Error('Thread not found'); return { thread: { id: params.threadId } }; }
    if (method === 'thread/read') return { thread: { id: params.threadId, model: 'gpt-test', reasoningEffort: [...this.calls].reverse().find(call => call.method === 'turn/start')?.params.effort } };
    if (method === 'turn/start') {
      const id = `turn-${++this.turn}`;
      queueMicrotask(() => { if (this.requestApproval) this.emit('approval', { approvalId: 'approval-1', method: 'item/commandExecution/requestApproval' }); this.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: params.threadId, turnId: id, delta: 'Read-only analysis' } }); this.emit('notification', { method: 'turn/completed', params: { threadId: params.threadId, turnId: id, turn: { status: 'completed' } } }); });
      return { turn: { id } };
    }
    throw new Error('Unexpected method');
  }
}

test('one local thread per project/device persists, resumes after restart and denies approvals', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'bridge-analyze-'));
  const state = path.join(base, 'state.json');
  const config = path.join(base, 'local.json');
  await writeFile(config, JSON.stringify({ projects: { solicitudpro: { path: base } } }));
  initGit(base);
  const registry = await ProjectRegistry.load(config);
  const clients: FakeCodex[] = [];
  const make = () => { const client = new FakeCodex(); clients.push(client); return client as any; };
  const first = new ReadOnlyCodexAnalyzer(registry, 'class-windows', state, make);
  const a = await first.analyze('solicitudpro', 'Analiza la documentación actual');
  assert.equal(a.threadCreated, true); assert.equal(a.threadId, 'thread-local-1'); assert.equal(a.turnId, 'turn-1');
  const firstStart = clients[0]!.calls.find(call => call.method === 'thread/start')!;
  assert.equal(firstStart.params.sandbox, 'read-only');
  assert.equal(firstStart.params.approvalPolicy, 'on-request');
  assert.equal(clients[0]!.calls.find(call => call.method === 'turn/start')!.params.effort, 'low');
  assert.equal(a.selectedProfile, 'fast'); assert.equal(a.runtimeModel, 'gpt-test'); assert.equal(a.runtimeReasoning, 'low');
  const b = await first.analyze('solicitudpro', 'Continúa el análisis');
  assert.equal(b.threadId, a.threadId); assert.equal(b.threadCreated, false);
  const resume = clients[1]!.calls.find(call => call.method === 'thread/resume')!;
  assert.equal(resume.params.sandbox, 'read-only');
  assert.equal(resume.params.approvalPolicy, 'on-request');
  const afterRestart = new ReadOnlyCodexAnalyzer(registry, 'class-windows', state, make);
  const c = await afterRestart.analyze('solicitudpro', 'Tercer turno');
  assert.equal(c.threadId, a.threadId); assert.equal(c.threadCreated, false);
  assert.ok(clients[2]!.calls.some(call => call.method === 'thread/resume'));
  const persisted = JSON.parse(await readFile(state, 'utf8')) as any;
  assert.equal(persisted.threads['class-windows/solicitudpro'], a.threadId);
  assert.equal(persisted.metadata['class-windows/solicitudpro'].lastTurnId, c.turnId);
  assert.equal(persisted.metadata['class-windows/solicitudpro'].selectedProfile, 'fast');
  const home = new ReadOnlyCodexAnalyzer(registry, 'home-windows', state, make);
  const h = await home.analyze('solicitudpro', 'Analiza el mismo proyecto desde casa');
  assert.equal(h.threadCreated, true);
  assert.notEqual(h.threadId, a.threadId);
  assert.equal((JSON.parse(await readFile(state, 'utf8')) as any).threads['class-windows/solicitudpro'], a.threadId);
  assert.equal((JSON.parse(await readFile(state, 'utf8')) as any).threads['home-windows/solicitudpro'], h.threadId);
  await assert.rejects(afterRestart.analyze('unknown', 'Analiza'));
  await assert.rejects(afterRestart.analyze('solicitudpro', 'git reset --hard'));
  assert.equal(clients.length, 4, 'Rejected instructions never start Codex');
  assert.equal(a.status, 'completed'); assert.equal(a.result, 'Read-only analysis');
});

test('approval requests are declined and a stale thread ID is replaced only after failed resume', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'bridge-analyze-stale-'));
  const state = path.join(base, 'state.json');
  const config = path.join(base, 'local.json');
  await writeFile(config, JSON.stringify({ projects: { solicitudpro: { path: base } } }));
  initGit(base);
  const registry = await ProjectRegistry.load(config);
  const clients: FakeCodex[] = [];
  const make = () => { const client = new FakeCodex(); client.requestApproval = true; client.invalid = clients.length === 1; clients.push(client); return client as any; };
  const analyzer = new ReadOnlyCodexAnalyzer(registry, 'class-windows', state, make);
  const first = await analyzer.analyze('solicitudpro', 'Inspecciona el proyecto autorizado');
  assert.equal(first.blockedActions, 1); assert.equal(clients[0]!.declined, 1);
  const second = await analyzer.analyze('solicitudpro', 'Inspecciona de nuevo el proyecto');
  assert.equal(second.threadCreated, true);
  assert.notEqual(second.threadId, first.threadId);
  assert.ok(clients[1]!.calls.some(call => call.method === 'thread/resume'));
  assert.ok(clients[1]!.calls.some(call => call.method === 'thread/start'));
  assert.equal(second.blockedActions, 1); assert.equal(clients[1]!.declined, 1);
  assert.equal((JSON.parse(await readFile(state, 'utf8')) as any).threads['class-windows/solicitudpro'], second.threadId);
});

test('Spanish del in a read-only request is allowed while the delete command is rejected', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'bridge-analyze-del-'));
  const config = path.join(base, 'local.json');
  await writeFile(config, JSON.stringify({ projects: { solicitudpro: { path: base } } }));
  initGit(base);
  const registry = await ProjectRegistry.load(config);
  const clients: FakeCodex[] = [];
  const analyzer = new ReadOnlyCodexAnalyzer(registry, 'home-windows', path.join(base, 'state.json'), () => {
    const client = new FakeCodex(); clients.push(client); return client as any;
  });
  for (const instruction of [
    'Confirma la rama y el HEAD del proyecto.',
    'Revisa el estado del archivo sin modificarlo.',
    'Describe la estructura del repositorio.',
  ]) {
    const result = await analyzer.analyze('solicitudpro', instruction);
    assert.equal(result.status, 'completed');
  }
  const allowedCount = clients.length;
  for (const instruction of ['del archivo.txt', 'cmd /c del archivo.txt', 'Confirma Git; del archivo.txt', 'Confirma Git\ndel archivo.txt', 'Ejecuta `del archivo.txt`', 'git reset --hard']) {
    await assert.rejects(analyzer.analyze('solicitudpro', instruction), /Only bounded read-only analysis is supported/);
    assert.equal(clients.length, allowedCount, 'Rejected instructions never start Codex');
  }
});
