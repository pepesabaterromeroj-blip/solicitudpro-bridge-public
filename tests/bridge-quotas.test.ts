import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeBridgeQuota, BRIDGE_QUOTA_LIMITS } from '../cloud/bridge-quotas.js';

test('daily quotas are independent per device and prepare uses analysis rather than change', async () => {
  const entries = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => entries.get(key),
    put: async (key: string, value: unknown) => { entries.set(key, value); },
  };
  const now = new Date('2026-11-05T12:00:00Z');
  for (let i = 0; i < BRIDGE_QUOTA_LIMITS.analysis; i++) {
    await consumeBridgeQuota(storage, 'analysis', 'class-windows', now);
  }
  await assert.rejects(consumeBridgeQuota(storage, 'analysis', 'class-windows', now), /BRIDGE_ANALYSIS_BUDGET_REACHED/);
  await consumeBridgeQuota(storage, 'analysis', 'home-windows', now);
  assert.equal(entries.has('bridge-quota-v2:change:class-windows'), false);
  assert.equal(entries.has('bridge-quota-v2:change:home-windows'), false);
  await consumeBridgeQuota(storage, 'change', 'class-windows', now);
  assert.deepEqual(entries.get('bridge-quota-v2:change:class-windows'), { day: '2026-11-05', count: 1 });
  await consumeBridgeQuota(storage, 'analysis', 'class-windows', new Date('2026-11-06T00:00:00Z'));
});
