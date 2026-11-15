import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ProjectRegistry } from '../src/project-registry.js';
import { readProjectContextSnapshot } from '../src/project-context-snapshot.js';

test('configured context only: Git, bounded excerpts, local dirty flag, missing/oversize and no writes', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'bridge-context-'));
  const repo = path.join(base, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
  await mkdir(path.join(repo, 'docs'), { recursive: true });
  await writeFile(path.join(repo, 'AGENTS.md'), '# Project instructions\n## Git\n## Security\n');
  await writeFile(path.join(repo, 'docs', 'OPERATIVE.md'), 'Última verificación: 2026-10-27\n## Estado técnico\n- C19 global está cerrada.\n## Próximos pasos\n1. Revisar el checkout antes de la siguiente fase.\npassword=SHOULD_NOT_LEAK\n');
  await writeFile(path.join(repo, 'docs', 'RESULT.md'), '# Resultado C19 GLOBAL\nEstado: **C19 GLOBAL CERRADA**.\n');
  await writeFile(path.join(repo, '.env'), 'SUPER_SECRET_DO_NOT_LEAK');
  git('add', 'AGENTS.md', 'docs'); git('commit', '-qm', 'base');
  await writeFile(path.join(repo, 'docs', 'OPERATIVE.md'), 'Última verificación: 2026-10-27\n## Estado técnico\n- C19 global está cerrada.\n## Próximos pasos\n1. Revisar el checkout antes de la siguiente fase.\npassword=SHOULD_NOT_LEAK\n');
  await writeFile(path.join(repo, 'docs', 'LARGE.md'), 'x'.repeat(17_000));
  const sources = [
    { path: 'AGENTS.md', role: 'instructions' },
    { path: 'docs/OPERATIVE.md', role: 'operational' },
    { path: 'docs/RESULT.md', role: 'phase-result' },
    { path: 'docs/MISSING.md', role: 'continuity' },
  ];
  const config = path.join(base, 'local.json');
  const load = async (selected = sources) => { await writeFile(config, JSON.stringify({ projects: { solicitudpro: { path: repo, contextSources: selected } } })); return ProjectRegistry.load(config); };
  const beforeHead = git('rev-parse', 'HEAD'), beforeStatus = git('status', '--porcelain=v1', '-uall');
  const result = await readProjectContextSnapshot(await load(), 'solicitudpro', 'class-windows');
  assert.equal(result.git.head, beforeHead);
  assert.equal(result.git.unstaged, 0);
  assert.equal(result.git.untracked, 2);
  assert.equal(result.currentPhase, 'C19 GLOBAL');
  assert.match(result.currentState ?? '', /C19 GLOBAL CERRADA/);
  assert.match(result.nextAction ?? '', /Revisar el checkout/);
  assert.equal(result.contextSources.find(s => s.path === 'docs/MISSING.md')?.status, 'missing');
  assert.equal(result.contextSources.find(s => s.path === 'docs/OPERATIVE.md')?.dirty, false);
  assert.equal(git('rev-parse', 'HEAD'), beforeHead);
  assert.equal(git('status', '--porcelain=v1', '-uall'), beforeStatus);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 3_800);
  assert.ok(!JSON.stringify(result).includes(base));
  assert.ok(!JSON.stringify(result).includes('SHOULD_NOT_LEAK'));
  assert.ok(!JSON.stringify(result).includes('SUPER_SECRET_DO_NOT_LEAK'));

  await writeFile(path.join(repo, 'docs', 'OPERATIVE.md'), (await readFile(path.join(repo, 'docs', 'OPERATIVE.md'), 'utf8')) + '\nCambio local');
  const dirty = await readProjectContextSnapshot(await load(), 'solicitudpro', 'class-windows');
  assert.equal(dirty.contextSources.find(s => s.path === 'docs/OPERATIVE.md')?.dirty, true);
  assert.equal(dirty.git.unstaged, 1);

  const tooLarge = await readProjectContextSnapshot(await load([...sources.slice(0, 3), { path: 'docs/LARGE.md', role: 'continuity' }]), 'solicitudpro', 'class-windows');
  assert.equal(tooLarge.contextSources.at(-1)?.status, 'oversize');
  await writeFile(path.join(repo, 'docs', 'SENSITIVE.md'), '# secretVALUE_DO_NOT_LEAK\nEstado: tokenVALUE_DO_NOT_LEAK\n## Próximos pasos\n1. Ir a https://private.example/test\n');
  const sanitized = await readProjectContextSnapshot(await load([{ path: 'docs/SENSITIVE.md', role: 'phase-result' }]), 'solicitudpro', 'class-windows');
  assert.equal(sanitized.currentState, null);
  assert.equal(sanitized.contextSources[0]?.excerpts.length, 0);
  assert.ok(!JSON.stringify(sanitized).includes('DO_NOT_LEAK'));
  for (const bad of ['../.env', '/etc/passwd', 'C:\\Windows\\win.ini', 'docs/../.env', '.env', 'docs/*.md', 'docs/secret.md']) {
    await assert.rejects(readProjectContextSnapshot(await load([{ path: bad, role: 'operational' }]), 'solicitudpro', 'class-windows'));
  }
  await assert.rejects(readProjectContextSnapshot(await load(), 'other-project', 'class-windows'));
  try {
    await symlink(path.join(repo, '.env'), path.join(repo, 'docs', 'LEAK.md'));
    await assert.rejects(readProjectContextSnapshot(await load([{ path: 'docs/LEAK.md', role: 'operational' }]), 'solicitudpro', 'class-windows'));
  } catch (error: any) {
    if (error?.code !== 'EPERM') throw error; // Windows without Developer Mode cannot create fixture symlinks.
  }
});
