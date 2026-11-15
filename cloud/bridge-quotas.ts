import { BridgeError, type BridgeErrorCode } from '../src/bridge-errors.js';

export const BRIDGE_QUOTA_LIMITS = { smoke: 75, read: 750, analysis: 150, change: 150 } as const;
export type BridgeQuotaKind = keyof typeof BRIDGE_QUOTA_LIMITS;
type QuotaStorage = { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void> };
const codes: Record<BridgeQuotaKind, BridgeErrorCode> = {
  smoke: 'BRIDGE_SMOKE_BUDGET_REACHED', read: 'BRIDGE_READ_BUDGET_REACHED',
  analysis: 'BRIDGE_ANALYSIS_BUDGET_REACHED', change: 'BRIDGE_CHANGE_BUDGET_REACHED',
};

export async function consumeBridgeQuota(storage: QuotaStorage, kind: BridgeQuotaKind, deviceId: string, now = new Date()): Promise<void> {
  const key = `bridge-quota-v2:${kind}:${deviceId}`;
  const day = now.toISOString().slice(0, 10);
  const previous = await storage.get(key) as { day?: string; count?: number } | undefined;
  const count = previous?.day === day && Number.isSafeInteger(previous.count) && previous.count! >= 0 ? previous.count! : 0;
  if (count >= BRIDGE_QUOTA_LIMITS[kind]) throw new BridgeError(codes[kind]);
  await storage.put(key, { day, count: count + 1 });
}
