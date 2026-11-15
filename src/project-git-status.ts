import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { ProjectRegistry } from './project-registry.js';
import { parsePorcelainV1 } from './git-state.js';
import type { ProjectGitStatus } from './relay-protocol.js';

const run = promisify(execFile);
export async function readProjectGitStatus(registry: ProjectRegistry, project: string, deviceId: string): Promise<ProjectGitStatus> {
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(project)) throw new Error('Project not authorized');
  const repo = registry.resolve(project).path;
  const git = async (...args: string[]) => (await run('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', repo, ...args], {
    windowsHide: true, timeout: 10_000, maxBuffer: 1_000_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  })).stdout.trimEnd();
  const [root, branch, head, porcelain] = await Promise.all([
    git('rev-parse', '--show-toplevel'), git('branch', '--show-current'),
    git('rev-parse', 'HEAD'), git('status', '--porcelain=v1', '-uall'),
  ]);
  if (path.normalize(root).toLowerCase() !== path.normalize(repo).toLowerCase()) throw new Error('Configured project is not a Git root');
  const parsed = parsePorcelainV1(porcelain);
  let upstream: string | null = null, ahead = 0, behind = 0;
  try { upstream = (await git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}')).trim(); }
  catch { upstream = null; }
  if (upstream) {
    const counts = (await git('rev-list', '--left-right', '--count', 'HEAD...@{upstream}')).trim().split(/\s+/);
    ahead = Number(counts[0]); behind = Number(counts[1]);
    if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) throw new Error('Invalid Git counts');
  }
  return { project, deviceId, branch: branch || 'HEAD', head, clean: parsed.clean,
    staged: parsed.staged.length, unstaged: parsed.unstaged.length, untracked: parsed.untracked.length,
    upstream, ahead, behind };
}
