export type BridgeErrorCode =
  | 'BRIDGE_SMOKE_BUDGET_REACHED'
  | 'BRIDGE_READ_BUDGET_REACHED'
  | 'BRIDGE_ANALYSIS_BUDGET_REACHED'
  | 'BRIDGE_CHANGE_BUDGET_REACHED'
  | 'BRIDGE_DEVICE_AMBIGUOUS'
  | 'BRIDGE_DEVICE_UNAVAILABLE';

export class BridgeError extends Error {
  constructor(readonly code: BridgeErrorCode) { super(code); }
}

export function bridgeErrorMessage(error: unknown, fallback: string): string {
  return error instanceof BridgeError ? error.code : fallback;
}
