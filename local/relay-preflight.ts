import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { ProjectRegistry } from '../src/project-registry.js';

const exec = promisify(execFile);
const runOptions = { timeout: 10_000, windowsHide: true };

export async function relayPreflight(root: string) {
  const configPath = path.join(root, 'config/local.json');
  let registry: ProjectRegistry;
  try { registry = await ProjectRegistry.load(configPath); }
  catch { throw new Error('config/local.json missing or invalid, or a configured project path is unavailable'); }
  const relay = registry.config.relay;
  if (relay?.enabled !== true) throw new Error('Enable relay in config/local.json');
  const { deviceId, gatewayOrigin, tokenFile } = relay;
  if (typeof deviceId !== 'string' || !/^[a-z0-9-]{2,64}$/.test(deviceId)) throw new Error('Invalid relay device ID');
  const origin = URL.parse(gatewayOrigin ?? '');
  if (!origin || origin.protocol !== 'https:' || origin.href !== origin.origin + '/') throw new Error('Gateway must be an HTTPS origin without credentials or a path');
  let token: string;
  try {
    if (typeof tokenFile !== 'string' || !tokenFile.trim()) throw new Error();
    token = (await readFile(path.resolve(root, tokenFile), 'utf8')).trim();
    if (!/^[\x21-\x7e]{32,512}$/.test(token)) throw new Error();
  } catch { throw new Error('Device credential missing, unreadable or invalid'); }

  try {
    const project = registry.resolve('solicitudpro');
    const { stdout } = await exec('git', ['--no-optional-locks', 'rev-parse', '--show-toplevel'], { ...runOptions, cwd: project.path });
    if (path.relative(project.path, await realpath(stdout.trim())) !== '') throw new Error();
  } catch { throw new Error('Configure solicitudpro as the root of a valid Git checkout and verify Git is installed'); }

  const command = registry.config.codex?.command ?? 'codex';
  try { await exec(command, ['app-server', '--help'], runOptions); }
  catch { throw new Error('Codex app-server unavailable. Check the configured Codex executable'); }

  const threadFile = path.join(root, 'data/codex-readonly-threads.json');
  try {
    const state = JSON.parse(await readFile(threadFile, 'utf8'));
    if (state?.version !== 1 || !state.threads || typeof state.threads !== 'object' || Array.isArray(state.threads) ||
      Object.values(state.threads).some(id => typeof id !== 'string' || !/^[a-z0-9-]{10,100}$/i.test(id))) throw new Error();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Local Codex thread store is unreadable or invalid');
  }
  return { registry, deviceId, origin: origin.origin, token, command, threadFile };
}

export async function gatewayHealth(origin: string) {
  const response = await fetch(new URL('/health', origin), { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok) throw new Error('Gateway health check failed');
  const health = await response.json() as { activeDevices?: number; relayProtocolVersion?: number };
  if (!Number.isInteger(health.activeDevices) || health.activeDevices! < 0 || health.relayProtocolVersion !== 2) throw new Error('Unexpected gateway health response');
  return health.activeDevices!;
}
