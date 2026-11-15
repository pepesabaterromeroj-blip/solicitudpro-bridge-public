import test from 'node:test';
import assert from 'node:assert/strict';
import { credentialHash, deviceCredentialHash, verifyDeviceCredential } from '../src/device-auth.js';
import { configuredGatewayOrigin, localCredential } from '../local/device-admin.js';
import { mkdtemp, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('independent credentials cannot impersonate another device; legacy class remains valid', async () => {
  const home = crypto.randomUUID(), legacy = crypto.randomUUID();
  const records: Record<string, unknown> = { 'home-windows': { version: 1, hash: await credentialHash(home), revoked: false } };
  const get = async (id: string) => deviceCredentialHash(id, records[id] ?? null, 'class-windows', legacy);
  assert.equal(await verifyDeviceCredential(`Bearer ${home}`, await get('home-windows')), true);
  assert.equal(await verifyDeviceCredential(`Bearer ${legacy}`, await get('class-windows')), true);
  assert.equal(await verifyDeviceCredential(`Bearer ${home}`, await get('class-windows')), false);
  assert.equal(await verifyDeviceCredential(`Bearer ${legacy}`, await get('home-windows')), false);
  assert.equal(await verifyDeviceCredential('Bearer wrong', await get('home-windows')), false);
  assert.equal(await verifyDeviceCredential(`Bearer ${home}`, await get('unknown')), false);
  records['class-windows'] = { version: 1, revoked: true };
  assert.equal(await verifyDeviceCredential(`Bearer ${legacy}`, await get('class-windows')), false, 'tombstone must override legacy');
  records['home-windows'] = { version: 1, revoked: true };
  assert.equal(await verifyDeviceCredential(`Bearer ${home}`, await get('home-windows')), false);
});

test('malformed registry records fail closed without falling back to legacy', async () => {
  for (const record of [{}, { version: 1, hash: 'bad' }, { version: 2, hash: 'a'.repeat(64), revoked: false }]) {
    assert.equal(await deviceCredentialHash('class-windows', record, 'class-windows', 'legacy'), null);
  }
  assert.equal(await deviceCredentialHash('../invalid', null, '../invalid', 'legacy'), null);
  assert.equal(await verifyDeviceCredential(null, 'a'.repeat(64)), false);
});

test('enrolment creates a random local credential once and refuses to overwrite invalid material', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'device-admin-test-'));
  const file = path.join(dir, 'credential');
  try {
    const first = await localCredential(file);
    assert.equal(first.length, 43);
    assert.equal(await localCredential(file), first);
    assert.equal(await readFile(file, 'utf8'), first);
    await writeFile(file, 'invalid-existing-material');
    await assert.rejects(localCredential(file), /not overwritten/);
    assert.equal(await readFile(file, 'utf8'), 'invalid-existing-material');
  } finally { await unlink(file); await rmdir(dir); }
});

test('enrolment preserves the locally configured gateway origin', () => {
  assert.equal(configuredGatewayOrigin({ relay: { gatewayOrigin: 'https://bridge.example.test' } }), 'https://bridge.example.test');
  assert.throws(() => configuredGatewayOrigin({}), /gateway origin/i);
});
