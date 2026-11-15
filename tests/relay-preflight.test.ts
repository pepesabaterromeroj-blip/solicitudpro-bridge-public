import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { relayPreflight } from '../local/relay-preflight.js';

test('startup rejects missing config, invalid credential and invalid checkout without leaking secrets', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-preflight-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(relayPreflight(root), /config\/local.json missing or invalid/);
  await mkdir(path.join(root, 'config'));
  const relay = { enabled: false, deviceId: 'test-device', gatewayOrigin: 'https://example.test', tokenFile: 'fixture-token' };
  const configure = () => writeFile(path.join(root, 'config/local.json'), JSON.stringify({ projects: { solicitudpro: { path: root } }, relay }));
  await configure();
  await assert.rejects(relayPreflight(root), /Enable relay/);
  relay.enabled = true;
  await configure();
  await assert.rejects(relayPreflight(root), /^Error: Device credential missing, unreadable or invalid$/);
  await writeFile(path.join(root, 'fixture-token'), 'fixture'.repeat(6));
  await assert.rejects(relayPreflight(root), /valid Git checkout/);
});
