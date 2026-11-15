import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface ChangePlan {
  project: string; deviceId: string; threadId: string; turnId: string;
  instruction: string; baseHead: string; fingerprint: string;
  summary: string; files: string[]; tests: string[]; warnings: string[];
  selectedProfile: 'fast' | 'standard' | 'deep' | 'exceptional';
  requestedModel: string; requestedReasoning: 'low' | 'medium' | 'high' | 'xhigh';
}
export interface ChangeApproval extends ChangePlan {
  approvalId: string; digest: string; expiresAt: string; humanApproved: boolean;
}
const validId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
const digest = (plan: ChangePlan) => createHash('sha256').update(JSON.stringify(plan)).digest('hex');
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Plan state stays local; user confirmation is delegated to the authenticated MCP client. */
export class ChangeApprovalStore {
  constructor(private directory: string, private now = () => Date.now(), private ttl = 10 * 60_000) {}
  async create(plan: ChangePlan): Promise<ChangeApproval> {
    if (!plan.files.length || plan.files.length > 10 || plan.files.some(file => !file || path.isAbsolute(file) || file.includes('\\') || file.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.')))) throw new Error('Invalid approved file scope');
    const approval: ChangeApproval = { ...plan, approvalId: randomUUID(), digest: digest(plan), expiresAt: new Date(this.now() + this.ttl).toISOString(), humanApproved: false };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (process.platform === 'win32') {
      const exec = promisify(execFile); const identity = (await exec('whoami.exe', [], { windowsHide: true })).stdout.trim();
      await exec('icacls.exe', [this.directory, '/inheritance:r', '/grant:r', `${identity}:(OI)(CI)F`], { windowsHide: true });
    }
    await writeFile(this.file(approval.approvalId), JSON.stringify(approval), { mode: 0o600, flag: 'wx' });
    return approval;
  }
  private file(id: string) { if (!validId(id)) throw new Error('Approval unavailable'); return path.join(this.directory, `${id}.json`); }
  async get(id: string): Promise<ChangeApproval> {
    const record: ChangeApproval = JSON.parse(await readFile(this.file(id), 'utf8'));
    const { approvalId, digest: stored, expiresAt, humanApproved, ...plan } = record;
    if (approvalId !== id || !equal(digest(plan), stored) || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= this.now() ||
      !['fast', 'standard', 'deep', 'exceptional'].includes(plan.selectedProfile) || !['low', 'medium', 'high', 'xhigh'].includes(plan.requestedReasoning) ||
      typeof plan.requestedModel !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(plan.requestedModel)) throw new Error('Approval expired or invalid');
    return record;
  }
  async approveLocally(id: string, expectedDigest: string): Promise<void> { return this.approve(id, expectedDigest); }
  async approve(id: string, expectedDigest: string): Promise<void> {
    const record = await this.get(id);
    if (record.humanApproved || !equal(record.digest, expectedDigest)) throw new Error('Plan changed or already approved');
    const handle = await open(this.file(id), 'r+');
    try { await handle.truncate(0); await handle.writeFile(JSON.stringify({ ...record, humanApproved: true })); } finally { await handle.close(); }
  }
  async consume(id: string, binding: Pick<ChangePlan, 'project' | 'deviceId' | 'threadId' | 'baseHead' | 'fingerprint'>): Promise<ChangeApproval> {
    const record = await this.get(id);
    if (!record.humanApproved || (['project', 'deviceId', 'threadId', 'baseHead', 'fingerprint'] as const).some(key => record[key] !== binding[key])) throw new Error('Approval denied; prepare again');
    // Exclusive durable claim: fail closed even if a process crashes before the rename.
    const claim = await open(path.join(this.directory, `${id}.claimed`), 'wx', 0o600); await claim.close();
    await rename(this.file(id), path.join(this.directory, `${id}.used.json`));
    return record;
  }
}
