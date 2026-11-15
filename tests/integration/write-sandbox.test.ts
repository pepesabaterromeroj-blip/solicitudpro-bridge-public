import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppServerClient } from '../../src/app-server-client.js';
import { execFileSync } from 'node:child_process';

test('real app-server sandbox writes one approved file while denying sibling, outside and Git metadata', { timeout: 60000 }, async () => {
  const config = JSON.parse(await readFile('config/local.json', 'utf8'));
  const base = await mkdtemp(path.join(tmpdir(), 'bridge-write-sandbox-')); const repo = path.join(base, 'repo'); await mkdir(repo);
  const approved = path.join(repo, 'approved.txt'), sibling = path.join(repo, 'sibling.txt'), outside = path.join(base, 'outside.txt');
  for (const file of [approved, sibling, outside]) await writeFile(file, 'before');
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { windowsHide: true, stdio: 'pipe' }).toString();
  git('init'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture');
  const head = git('rev-parse', 'HEAD'); const index = await readFile(path.join(repo, '.git/index'));
  const client = new AppServerClient({ command: config.codex?.command ?? 'codex' });
  const policy = { type: 'workspaceWrite', writableRoots: [approved], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true };
  try {
    await client.start();
    const code = "const fs=require('node:fs'); for(const f of JSON.parse(process.argv[1])) {try{fs.writeFileSync(f,'changed')}catch{}}";
    await client.request('command/exec', { command: [process.execPath, '-e', code, JSON.stringify([approved, sibling, outside, path.join(repo, '.git/index')])], cwd: repo, sandboxPolicy: policy, timeoutMs: 15000 });
    assert.equal(await readFile(approved, 'utf8'), 'changed');
    assert.equal(await readFile(sibling, 'utf8'), 'before'); assert.equal(await readFile(outside, 'utf8'), 'before');
    assert.deepEqual(await readFile(path.join(repo, '.git/index')), index);
    const gitExe = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['git'], { windowsHide: true }).toString().trim().split(/\r?\n/)[0]!;
    try {
      const result = await client.request<any>('command/exec', { command: [gitExe, '-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'denied'], cwd: repo, sandboxPolicy: policy, timeoutMs: 15000 });
      assert.notEqual(result.exitCode, 0);
    } catch (error) { assert.match(String(error), /sandbox|denied/i); }
    assert.equal(git('rev-parse', 'HEAD'), head);
  } finally { client.stop(); }
});
