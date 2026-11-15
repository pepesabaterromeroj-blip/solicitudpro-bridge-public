import { execFile } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ProjectRegistry, ProjectConfig } from './project-registry.js';
import { readProjectGitStatus } from './project-git-status.js';
import type { ProjectContextSnapshot } from './relay-protocol.js';

const run = promisify(execFile);
const MAX_SOURCES = 4, MAX_FILE_BYTES = 16_384, MAX_OUTPUT_BYTES = 3_800;
type Source = NonNullable<ProjectConfig['contextSources']>[number];
const sensitive = /(?:password|secret|token|bearer|api[_ -]?key|credential|cookie|sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{12,}|https?:\/\/|[a-z]:\\|\/Users\/|\/home\/|@|\b[67]\d{8}\b|[A-Za-z0-9_-]{24,})/i;
function safeText(line: string): string | null {
  const text = line.replace(/[*`_]/g, '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 200 || sensitive.test(text) || /[<>\x00-\x1f]/.test(text)) return null;
  return text;
}
function validateSource(source: Source): void {
  const rel = source?.path;
  if (!rel || typeof rel !== 'string' || rel.length > 160 || !/^[A-Za-z0-9._/-]+\.md$/.test(rel) ||
      rel.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.')) ||
      /(?:^|\/)[^/]*(?:secret|credential|token|password|private|api[_-]?key)[^/]*\//i.test(`${rel}/`) ||
      !(rel === 'AGENTS.md' || rel.startsWith('docs/')) ||
      !['instructions', 'operational', 'continuity', 'phase-result'].includes(source.role)) throw new Error('Unsafe context source');
}
function extract(lines: string[], role: Source['role']): { excerpts: string[]; state: string | null; phase: string | null; action: string | null } {
  const title = safeText(lines.find(line => /^#\s+/.test(line)) ?? '');
  const status = safeText(lines.find(line => /^Estado:\s*/i.test(line)) ?? '');
  let action: string | null = null;
  if (role === 'operational' || role === 'continuity') {
    const at = lines.findIndex(line => /^#{1,3}\s+.*(?:pr[oó]ximos pasos|siguiente acci[oó]n)/i.test(line));
    if (at >= 0) {
      for (const line of lines.slice(at + 1, at + 12)) {
        if (/^#{1,3}\s+/.test(line)) break;
        if (/^\d+\.\s+/.test(line)) { action = safeText(line.replace(/^\d+\.\s+/, '')); break; }
      }
    }
  }
  const phase = role === 'phase-result' ? title?.match(/\bC\d{1,3}[A-Z]?(?:\s+GLOBAL)?\b/i)?.[0]?.toUpperCase() ?? null : null;
  const excerpts = [title, status, action].filter((v): v is string => Boolean(v)).slice(0, 3);
  return { excerpts, state: role === 'phase-result' ? status : null, phase, action };
}
export async function readProjectContextSnapshot(registry: ProjectRegistry, project: string, deviceId: string): Promise<ProjectContextSnapshot> {
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(project)) throw new Error('Project not authorized');
  const configured = registry.resolve(project);
  const sources = configured.contextSources;
  if (!sources?.length || sources.length > MAX_SOURCES) throw new Error('Context source configuration unavailable');
  for (const source of sources) validateSource(source);
  if (new Set(sources.map(source => source.path)).size !== sources.length) throw new Error('Duplicate context source');
  const git = await readProjectGitStatus(registry, project, deviceId);
  const result: ProjectContextSnapshot = { project, deviceId, git, contextSources: [], currentState: null, currentPhase: null, nextAction: null, warnings: [] };
  let dated = false;
  for (const source of sources) {
    const target = path.resolve(configured.path, ...source.path.split('/'));
    const relative = path.relative(configured.path, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe context source');
    let metadata;
    try { metadata = await lstat(target); }
    catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      result.contextSources.push({ path: source.path, role: source.role, status: 'missing', dirty: false, excerpts: [] });
      result.warnings.push('SOURCE_MISSING'); continue;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('Unsafe context source');
    const canonical = await realpath(target);
    const inside = path.relative(configured.path, canonical);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('Unsafe context source');
    if (metadata.size > MAX_FILE_BYTES) {
      result.contextSources.push({ path: source.path, role: source.role, status: 'oversize', dirty: false, excerpts: [] });
      result.warnings.push('SOURCE_OVERSIZE'); continue;
    }
    const [contents, porcelain] = await Promise.all([
      readFile(target, 'utf8'),
      run('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', configured.path, 'status', '--porcelain=v1', '-uall', '--', source.path],
        { windowsHide: true, timeout: 10_000, maxBuffer: 100_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } }),
    ]);
    if (Buffer.byteLength(contents) > MAX_FILE_BYTES) throw new Error('Context source changed during read');
    const dirty = Boolean(porcelain.stdout.trim());
    const parsed = extract(contents.split(/\r?\n/), source.role);
    result.contextSources.push({ path: source.path, role: source.role, status: 'ok', dirty, excerpts: parsed.excerpts });
    if (source.role === 'phase-result') { result.currentState = parsed.state ?? result.currentState; result.currentPhase = parsed.phase ?? result.currentPhase; }
    if (source.role === 'operational') result.nextAction = parsed.action ?? result.nextAction;
    if (dirty && !result.warnings.includes('SOURCE_LOCAL_DIRTY')) result.warnings.push('SOURCE_LOCAL_DIRTY');
    if (/20\d\d-\d\d-\d\d/.test(contents.slice(0, 500))) dated = true;
  }
  if (dated) result.warnings.push('DOCUMENTATION_DATED_REVALIDATE');
  if (!result.contextSources.some(source => source.dirty) && !git.clean) result.warnings.push('LOCAL_CHANGES_OUTSIDE_SOURCES');
  while (Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT_BYTES) {
    const source = result.contextSources.find(source => source.excerpts.length);
    if (!source) throw new Error('Context output limit exceeded');
    source.excerpts.pop();
    if (!result.warnings.includes('EXCERPTS_TRUNCATED')) result.warnings.push('EXCERPTS_TRUNCATED');
  }
  return result;
}
