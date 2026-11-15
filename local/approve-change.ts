import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ChangeApprovalStore } from '../src/change-approval.js';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.basename(path.dirname(here)) === 'dist' ? path.resolve(here, '../..') : path.resolve(here, '..');
if (!stdin.isTTY || !stdout.isTTY) throw new Error('Human terminal required');
const id = process.argv[2]; if (!id || process.argv.length !== 3) throw new Error('Usage: npm run approve-change -- approvalId');
const store = new ChangeApprovalStore(path.join(root, 'data/change-approvals'));
const plan = await store.get(id);
console.log(JSON.stringify({ project: plan.project, deviceId: plan.deviceId, threadId: plan.threadId, baseHead: plan.baseHead, summary: plan.summary, files: plan.files, tests: plan.tests, warnings: plan.warnings, expiresAt: plan.expiresAt }, null, 2));
const ui = createInterface({ input: stdin, output: stdout });
try {
  const answer = await ui.question(`Type APPROVE ${id} to approve this exact plan: `);
  if (answer !== `APPROVE ${id}`) throw new Error('Approval declined');
  await store.approveLocally(id, plan.digest);
  console.log('Plan approved locally; APPLY may consume it once before expiry.');
} finally { ui.close(); }
