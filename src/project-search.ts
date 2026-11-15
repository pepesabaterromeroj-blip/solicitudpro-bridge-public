import { execFile } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ProjectRegistry } from './project-registry.js';
import type { ProjectSearchResult } from './relay-protocol.js';

const run = promisify(execFile);
const MAX_FILES = 1000, MAX_FILE_BYTES = 128_000, MAX_SCAN_BYTES = 5_000_000;
const MAX_MATCHES = 10, MAX_SNIPPET = 140, MAX_OUTPUT = 3000;
const rootPattern = /^[A-Za-z0-9_-][A-Za-z0-9._/-]{0,79}$/;
const sensitiveName = /(?:^|\/)(?:\.|[^/]*(?:secret|credential|token|password|private|api[_-]?key|cache|build|dist|storage|node_modules)[^/]*)(?:\/|$)/i;
const sensitiveLine = /(?:password|secret|token|bearer|api[_ -]?key|credential|cookie|sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{12,}|https?:\/\/|[a-z]:\\|\/Users\/|\/home\/|@|\b[67]\d{8}\b|[A-Za-z0-9_-]{24,})/i;
function safeRoot(value: unknown): value is string {
  return typeof value === 'string' && rootPattern.test(value) &&
    value.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.')) && !sensitiveName.test(value);
}
function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return !!rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
export async function searchProject(registry: ProjectRegistry, project: string, query: string, deviceId: string): Promise<ProjectSearchResult> {
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(project)) throw new Error('Project not authorized');
  if (typeof query !== 'string' || query.length < 2 || query.length > 80 || !/^[\p{L}\p{N} _.-]+$/u.test(query) || query.startsWith('.') || query.includes('..') || sensitiveName.test(query)) throw new Error('Invalid query');
  const configured = registry.resolve(project);
  const roots = configured.searchRoots;
  if (!Array.isArray(roots) || !roots.length || roots.length > 5 || roots.some(root => !safeRoot(root)) || new Set(roots).size !== roots.length) throw new Error('Search roots unavailable');
  const repo = configured.path;
  const { stdout } = await run('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', repo, 'ls-files', '-z', '--cached', '--', ...roots], {
    encoding: 'buffer', windowsHide: true, timeout: 10_000, maxBuffer: 500_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  });
  const files = (stdout as Buffer).toString('utf8').split('\0').filter(Boolean).sort();
  let truncated = files.length > MAX_FILES, scanned = 0, totalMatches = 0;
  const matches: ProjectSearchResult['matches'] = [];
  for (const file of files.slice(0, MAX_FILES)) {
    if (!safeRoot(file) || sensitiveName.test(file) || !/\.(?:js|mjs|cjs|ts|tsx|md|sql|css|html)$/i.test(file)) continue;
    if (!roots.some(root => file.startsWith(`${root}/`))) continue;
    const target = path.resolve(repo, ...file.split('/'));
    if (!inside(repo, target)) continue;
    const info = await lstat(target).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) continue;
    const canonical = await realpath(target);
    if (!inside(repo, canonical) || path.normalize(canonical).toLowerCase() !== path.normalize(target).toLowerCase()) continue;
    if (info.size > MAX_FILE_BYTES) { truncated = true; continue; }
    if (scanned + info.size > MAX_SCAN_BYTES) { truncated = true; break; }
    scanned += info.size;
    const bytes = await readFile(target);
    if (bytes.length > MAX_FILE_BYTES || bytes.includes(0)) { truncated = true; continue; }
    const lines = bytes.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (!line.toLocaleLowerCase().includes(query.toLocaleLowerCase()) || sensitiveLine.test(line) || /[\x00-\x08\x0e-\x1f]/.test(line)) continue;
      totalMatches++;
      if (matches.length < MAX_MATCHES) matches.push({ file, line: i + 1, snippet: line.slice(0, MAX_SNIPPET) });
    }
  }
  if (totalMatches > matches.length) truncated = true;
  const result: ProjectSearchResult = { project, deviceId, query, matches, truncated, totalMatches };
  while (Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT && result.matches.length) { result.matches.pop(); result.truncated = true; }
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT) throw new Error('Search output limit exceeded');
  return result;
}
