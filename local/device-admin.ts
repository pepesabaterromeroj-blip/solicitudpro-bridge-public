import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { credentialHash, deviceKey, validDeviceId } from '../src/device-auth.js';

// Administrative CLI only; never registered as an MCP tool or cloud endpoint.
const exec = promisify(execFile);
const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.basename(path.dirname(directory)) === 'dist' ? path.resolve(directory, '../..') : path.resolve(directory, '..');
const wrangler = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
const flags = ['--binding', 'OAUTH_KV', '-c', path.join(root, 'cloud/wrangler.jsonc'), '--remote'];

export function configuredGatewayOrigin(config: { relay?: { gatewayOrigin?: unknown } }): string {
  const origin = config.relay?.gatewayOrigin;
  if (typeof origin !== 'string' || origin.length === 0) throw new Error('Local gateway origin is missing');
  return origin;
}

export async function localCredential(file: string): Promise<string> {
  try { await writeFile(file, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 }); }
  catch (error: any) { if (error.code !== 'EEXIST') throw new Error('Could not save local device credential'); }
  const token = (await readFile(file, 'utf8')).trim();
  if (!/^[A-Za-z0-9_-]{43,}$/.test(token)) throw new Error('Existing credential requires manual review; not overwritten');
  if (process.platform === 'win32') {
    try {
      const identity = (await exec('whoami.exe')).stdout.trim();
      await exec('icacls.exe', [file, '/inheritance:r', '/grant:r', `${identity}:(F)`]);
    } catch { throw new Error('Could not restrict local credential permissions'); }
  }
  return token;
}
async function readRecord(id: string): Promise<any> {
  try {
    const result = await exec(process.execPath, [wrangler, 'kv', 'key', 'get', deviceKey(id), ...flags, '--text'], { cwd: root });
    return JSON.parse(result.stdout.trim());
  } catch (error: any) {
    if (/404: Not Found/.test(String(error.stderr))) return null;
    throw new Error('Could not read device registry; verify Wrangler login and account');
  }
}
async function putRecord(id: string, record: unknown): Promise<void> {
  await mkdir(path.join(root, 'tmp'), { recursive: true });
  const temp = await mkdtemp(path.join(root, 'tmp/device-admin-'));
  const file = path.join(temp, 'record.json');
  try {
    await writeFile(file, JSON.stringify(record), { mode: 0o600 });
    await exec(process.execPath, [wrangler, 'kv', 'key', 'put', deviceKey(id), ...flags, '--path', file], { cwd: root });
  } catch { throw new Error('Registry update failed; local credential preserved for safe retry'); }
  finally { await unlink(file).catch(() => {}); await rmdir(temp).catch(() => {}); }
}
async function main() {
  const [action, id] = process.argv.slice(2);
  if (!id || !validDeviceId(id) || !['enroll', 'revoke'].includes(action ?? '')) throw new Error('Usage: npm run device -- enroll|revoke <device-id>');
  const existing = await readRecord(id);
  if (action === 'revoke') {
    await putRecord(id, { version: 1, revoked: true });
    console.log(`Device ${id} revoked; KV propagation applies. Other devices unchanged.`);
    return;
  }
  if (existing?.revoked) throw new Error('Device is revoked; explicit administrative rotation required');
  const configPath = path.join(root, 'config/local.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  // Legacy class migration hashes its CURRENT local credential, never generates a replacement.
  let tokenFile = `config/relay-token-${id}.txt`;
  let token: string;
  if (id === 'class-windows') {
    if (config.relay?.deviceId !== id || !config.relay.tokenFile) throw new Error('Migrate class only on its existing PC with its current local credential');
    tokenFile = config.relay.tokenFile;
    token = (await readFile(path.resolve(root, tokenFile), 'utf8')).trim();
    if (token.length < 32) throw new Error('Invalid legacy credential');
  } else {
    token = await localCredential(path.join(root, tokenFile));
  }
  const hash = await credentialHash(token);
  if (existing && (existing.version !== 1 || existing.hash !== hash)) throw new Error('Device already registered with a different credential; not overwritten');
  await putRecord(id, { version: 1, revoked: false, hash });
  config.relay = { enabled: true, gatewayOrigin: configuredGatewayOrigin(config), deviceId: id, tokenFile };
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  console.log(`Device ${id} enrolled. Credential kept locally; registry contains only SHA-256. Wait for KV propagation before connecting.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Device administration failed'); process.exitCode = 1; });
}
