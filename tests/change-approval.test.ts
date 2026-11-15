import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChangeApprovalStore, type ChangePlan } from '../src/change-approval.js';

test('local plan approval survives restart, binds checkout/device/thread and is single-use', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'approval-test-'));
  let now = 1_800_000_000_000;
  const store = new ChangeApprovalStore(dir, () => now);
  const plan: ChangePlan = { project: 'fixture', deviceId: 'class-windows', threadId: 'thread-id', turnId: 'turn-id', instruction: 'Change a constant', baseHead: 'a'.repeat(40), fingerprint: 'b'.repeat(64), summary: 'Change constant', files: ['app.js'], tests: ['syntax'], warnings: [], selectedProfile: 'standard', requestedModel: 'gpt-test', requestedReasoning: 'medium' };
  const pending = await store.create(plan);
  await assert.rejects(store.consume(pending.approvalId, plan));
  await assert.rejects(store.approveLocally(pending.approvalId, 'wrong'));
  await store.approveLocally(pending.approvalId, pending.digest);
  const restarted = new ChangeApprovalStore(dir, () => now);
  for (const key of ['project', 'deviceId', 'threadId', 'baseHead', 'fingerprint'] as const) await assert.rejects(restarted.consume(pending.approvalId, { ...plan, [key]: 'different' }));
  const results = await Promise.allSettled([restarted.consume(pending.approvalId, plan), restarted.consume(pending.approvalId, plan)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  await assert.rejects(restarted.consume(pending.approvalId, plan));
  await assert.rejects(restarted.approve(pending.approvalId, pending.digest));
  const expired = await store.create(plan); await store.approveLocally(expired.approvalId, expired.digest);
  now += 600_001; await assert.rejects(store.consume(expired.approvalId, plan));
  await assert.rejects(store.approve(expired.approvalId, expired.digest));
  await assert.rejects(store.get('../../anything'));
  await assert.rejects(store.get('00000000-0000-4000-8000-000000000000'));
});
