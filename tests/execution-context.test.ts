import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveExecutionProfile } from '../src/execution-profile.js';
import { buildContextCapsule } from '../src/context-capsule.js';
import { ProjectRegistry } from '../src/project-registry.js';
import { selectCodexRuntime } from '../src/codex-runtime.js';

test('semantic profiles resolve deterministically and exceptional is never automatic', () => {
  assert.equal(resolveExecutionProfile({ requested: 'fast', operation: 'analysis', instruction: 'Inspect Git' }).reasoning, 'low');
  assert.equal(resolveExecutionProfile({ requested: 'standard', operation: 'prepare', instruction: 'Change copy' }).reasoning, 'medium');
  assert.equal(resolveExecutionProfile({ requested: 'deep', operation: 'analysis', instruction: 'Review security' }).reasoning, 'high');
  assert.equal(resolveExecutionProfile({ requested: 'exceptional', operation: 'analysis', instruction: 'Explicit exceptional review', supportedEfforts: ['low', 'medium', 'high'] }).reasoning, 'high');
  assert.equal(resolveExecutionProfile({ requested: 'exceptional', operation: 'analysis', instruction: 'Explicit exceptional review', supportedEfforts: ['low', 'medium', 'high', 'xhigh'] }).reasoning, 'xhigh');
  assert.equal(resolveExecutionProfile({ requested: 'auto', operation: 'analysis', instruction: 'Inspect the current Git status' }).profile, 'fast');
  assert.equal(resolveExecutionProfile({ requested: 'auto', operation: 'prepare', instruction: 'Update one bounded file' }).profile, 'standard');
  assert.equal(resolveExecutionProfile({ requested: 'auto', operation: 'analysis', category: 'security', instruction: 'Review authorization boundaries' }).profile, 'deep');
  assert.notEqual(resolveExecutionProfile({ requested: 'auto', operation: 'analysis', category: 'architecture', instruction: 'Review architecture' }).profile, 'exceptional');
});

test('context capsule is bounded, sanitized and makes current checkout authoritative', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'bridge-capsule-'));
  const repo = path.join(base, 'repo');
  await mkdir(path.join(repo, 'docs'), { recursive: true });
  await writeFile(path.join(repo, 'app.js'), 'export const current = true;\n');
  await writeFile(path.join(repo, 'docs', 'STATE.md'), '# C19 HISTORICAL\nEstado: old memory says clean\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { windowsHide: true, stdio: 'pipe' });
  git('init'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture');
  await writeFile(path.join(repo, 'app.js'), 'export const current = false;\n');
  const config = path.join(base, 'local.json');
  await writeFile(config, JSON.stringify({ projects: { fixture: { path: repo, contextSources: [{ path: 'docs/STATE.md', role: 'phase-result' }] } } }));
  const registry = await ProjectRegistry.load(config);
  const capsule = await buildContextCapsule({ registry, project: 'fixture', deviceId: 'home-windows', selectedProfile: 'deep', requestedReasoning: 'high', requestedModel: 'gpt-test', instruction: 'Review security without token=supersecret' });
  assert.match(capsule.text, /CURRENT CHECKOUT STATE OVERRIDES THREAD MEMORY AND HISTORICAL DOCUMENTATION\./);
  assert.match(capsule.text, /clean=false/);
  assert.match(capsule.text, /unstaged=1/);
  assert.match(capsule.text, /profile=deep/);
  assert.doesNotMatch(capsule.text, /supersecret/);
  assert.ok(capsule.text.length <= 2500);
  assert.equal(capsule.git.clean, false);
});

test('runtime selection uses only a configured/catalogued general model and falls reasoning back safely', async () => {
  const calls: string[] = [];
  const client: any = { request: async (method: string) => {
    calls.push(method);
    if (method === 'config/read') return { config: { model: 'gpt-general', model_reasoning_effort: 'medium' } };
    return { data: [{ id: 'gpt-general', supportedReasoningEfforts: ['low', 'medium', 'high'].map(reasoningEffort => ({ reasoningEffort })) }] };
  } };
  const fallback = await selectCodexRuntime(client, 'fixture', 'gpt-general', 'xhigh');
  assert.equal(fallback.requestedModel, 'gpt-general'); assert.equal(fallback.modelOverride, 'gpt-general');
  assert.equal(fallback.reasoning, 'high'); assert.equal(fallback.fallback, true);
  const unavailable = await selectCodexRuntime(client, 'fixture', 'gpt-experimental', 'medium');
  assert.equal(unavailable.modelOverride, undefined); assert.equal(unavailable.runtimeModel, 'gpt-general'); assert.equal(unavailable.fallback, true);
  assert.deepEqual(calls, ['config/read', 'model/list', 'config/read', 'model/list']);
});
