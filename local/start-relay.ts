import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runFixedCodexSmoke } from '../src/codex-smoke.js';
import { startRelay } from './relay.js';
import { relayPreflight, gatewayHealth } from './relay-preflight.js';
import { relayLog } from './relay-log.js';
import { readProjectGitStatus } from '../src/project-git-status.js';
import { readProjectContextSnapshot } from '../src/project-context-snapshot.js';
import { searchProject } from '../src/project-search.js';
import { ReadOnlyCodexAnalyzer } from '../src/project-analyze.js';
import { AppServerClient } from '../src/app-server-client.js';
import { ChangeApprovalStore } from '../src/change-approval.js';
import { ProjectChangeService } from '../src/project-change.js';
import { ThreadStateStore } from '../src/thread-state.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.basename(path.dirname(directory)) === 'dist' ? path.resolve(directory, '../..') : path.resolve(directory, '..');

async function main() {
  const doctor = process.argv.includes('--doctor');
  const checkOnly = process.argv.includes('--check-config');
  if (!doctor && !checkOnly) relayLog(root, 'startup');
  const config = await relayPreflight(root).catch((error: Error) => {
    const message = 'preflight failure: ' + error.message;
    if (!doctor && !checkOnly) relayLog(root, message);
    console.error(message);
    process.exitCode = 78;
    return undefined;
  });
  if (!config) return;
  const { registry, deviceId, origin, token, command, threadFile } = config;
  if (checkOnly) { console.log('Relay configuration OK'); return; }
  if (doctor) {
    if (process.platform === 'win32') {
      const task = spawnSync('schtasks.exe', ['/Query', '/TN', 'SolicitudPro Bridge Relay'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
      console.log(task.status === 0 ? 'Windows auto-start task found' : 'Windows auto-start task unavailable');
      if (task.status !== 0) process.exitCode = 1;
    }
    const active = await gatewayHealth(origin);
    if (active !== 1) {
      console.error(active === 0 ? 'Gateway online, no relay connected' : 'Gateway online, multiple relays connected');
      process.exitCode = 1;
      return;
    }
    if (process.exitCode) return;
    console.log('BRIDGE READY (local preflight passed; gateway reports one active relay)');
    return;
  }
  const analyzer = new ReadOnlyCodexAnalyzer(registry, deviceId, threadFile, () => new AppServerClient({ command }));
  const threadState = new ThreadStateStore(threadFile);
  const changes = new ProjectChangeService(registry, deviceId, new ChangeApprovalStore(path.join(root, 'data/change-approvals')), async project => {
    const id = await threadState.get(deviceId + '/' + project);
    if (typeof id !== 'string' || !/^[a-z0-9-]{10,100}$/i.test(id)) throw new Error('Run read-only analysis first');
    return id;
  }, command, undefined, (project, metadata) => threadState.record(deviceId + '/' + project, metadata));
  const relay = startRelay({
    origin, deviceId, token,
    smoke: () => runFixedCodexSmoke(command),
    projectStatus: project => readProjectGitStatus(registry, project, deviceId),
    contextSnapshot: project => readProjectContextSnapshot(registry, project, deviceId),
    projectSearch: (project, query) => searchProject(registry, project, query, deviceId),
    projectAnalyze: (project, instruction, options) => analyzer.analyze(project, instruction, options),
    changes: {
      prepare: (project, instruction, options) => changes.prepare(project, instruction, options),
      approve: id => changes.approve(id),
      apply: id => changes.apply(id),
    },
    onStatus: (status, id) => {
      relayLog(root, [deviceId, status, id].filter(Boolean).join(' '));
      if (process.stdout.isTTY) console.log(deviceId, status, id ?? '');
    },
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => relay.stop());
}

try { await main(); }
catch {
  if (!process.argv.includes('--doctor') && !process.argv.includes('--check-config')) relayLog(root, 'startup failure');
  console.error('Relay startup or gateway readiness check failed');
  process.exitCode = 1;
}
