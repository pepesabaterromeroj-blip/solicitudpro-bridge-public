import { spawnSync } from 'node:child_process';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LAUNCH_AGENT_LABEL = 'com.solicitudpro.bridge-relay';

const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const absolute = (name: string, value: string) => {
  if (!path.isAbsolute(value)) throw new Error(`${name} must be absolute`);
  return value;
};

export function launchAgentPaths(home: string): { directory: string; plist: string } {
  const directory = path.join(absolute('home', home), 'Library', 'LaunchAgents');
  return { directory, plist: path.join(directory, `${LAUNCH_AGENT_LABEL}.plist`) };
}

export function renderLaunchAgent(input: { nodePath: string; entryPath: string; workingDirectory: string }): string {
  const nodePath = absolute('nodePath', input.nodePath);
  const entryPath = absolute('entryPath', input.entryPath);
  const workingDirectory = absolute('workingDirectory', input.workingDirectory);
  const pathEntries = [path.dirname(nodePath), '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const pathValue = [...new Set(pathEntries)].join(':');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodePath)}</string>
    <string>${xml(entryPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(pathValue)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>15</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
`;
}

export function launchAgentCommand(action: 'bootstrap' | 'bootout' | 'start' | 'stop' | 'status', uid: number, plist: string): string[] {
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error('Invalid uid');
  absolute('plist', plist);
  const domain = `gui/${uid}`;
  if (action === 'bootstrap') return ['bootstrap', domain, plist];
  if (action === 'bootout') return ['bootout', domain, plist];
  if (action === 'start') return ['bootstrap', domain, plist];
  if (action === 'stop') return ['bootout', domain, plist];
  return ['print', `${domain}/${LAUNCH_AGENT_LABEL}`];
}

function launchctl(args: string[], ignoreFailure = false): void {
  const result = spawnSync('/bin/launchctl', args, { stdio: 'inherit', timeout: 15_000 });
  if (!ignoreFailure && result.status !== 0) throw new Error(`launchctl ${args[0]} failed`);
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('LaunchAgent management is available only on macOS');
  const action = process.argv[2];
  if (action !== 'install' && action !== 'uninstall' && action !== 'start' && action !== 'stop' && action !== 'status') throw new Error('Usage: npm run macos:relay -- install|uninstall|start|stop|status');
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('Unable to determine the current user');
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const root = path.basename(path.dirname(directory)) === 'dist' ? path.resolve(directory, '../..') : path.resolve(directory, '..');
  const entryPath = path.join(root, 'dist/local/start-relay.js');
  const paths = launchAgentPaths(os.homedir());
  if (action === 'install') {
    const check = spawnSync(process.execPath, [entryPath, '--check-config'], { cwd: root, stdio: 'inherit', timeout: 30_000 });
    if (check.status !== 0) throw new Error('Relay configuration check failed');
    await mkdir(paths.directory, { recursive: true });
    await writeFile(paths.plist, renderLaunchAgent({ nodePath: process.execPath, entryPath, workingDirectory: root }), { mode: 0o644 });
    launchctl(launchAgentCommand('bootout', uid, paths.plist), true);
    launchctl(launchAgentCommand('bootstrap', uid, paths.plist));
    console.log('SolicitudPro Bridge LaunchAgent installed and started.');
    return;
  }
  if (action === 'uninstall') {
    launchctl(launchAgentCommand('bootout', uid, paths.plist), true);
    await unlink(paths.plist).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    console.log('SolicitudPro Bridge LaunchAgent removed.');
    return;
  }
  if (action === 'stop') {
    launchctl(launchAgentCommand('stop', uid, paths.plist), true);
    console.log('SolicitudPro Bridge LaunchAgent stopped; plist preserved.');
    return;
  }
  if (action === 'start') {
    const loaded = spawnSync('/bin/launchctl', launchAgentCommand('status', uid, paths.plist), { stdio: 'ignore', timeout: 15_000 }).status === 0;
    launchctl(loaded ? ['kickstart', '-k', `gui/${uid}/${LAUNCH_AGENT_LABEL}`] : launchAgentCommand('start', uid, paths.plist));
    console.log('SolicitudPro Bridge LaunchAgent started.');
    return;
  }
  launchctl(launchAgentCommand(action, uid, paths.plist));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'LaunchAgent operation failed'); process.exitCode = 1; });
}
