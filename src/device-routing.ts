import { BridgeError } from './bridge-errors.js';

export const RELAY_PROTOCOL_VERSION = 2;

export type BridgeDevices = {
  devices: Array<{ deviceId: string; connected: true }>;
  activeDevices: number;
  relayProtocolVersion: number;
};

export function selectDeviceId(eligibleDeviceIds: string[], requestedDeviceId?: string): string {
  const devices = [...new Set(eligibleDeviceIds)];
  if (requestedDeviceId !== undefined) {
    if (!devices.includes(requestedDeviceId)) throw new BridgeError('BRIDGE_DEVICE_UNAVAILABLE');
    return requestedDeviceId;
  }
  if (devices.length === 0) throw new BridgeError('BRIDGE_DEVICE_UNAVAILABLE');
  if (devices.length !== 1) throw new BridgeError('BRIDGE_DEVICE_AMBIGUOUS');
  return devices[0]!;
}

export function describeDevices(eligibleDeviceIds: string[]): BridgeDevices {
  const devices = [...new Set(eligibleDeviceIds)].sort().map(deviceId => ({ deviceId, connected: true as const }));
  return { devices, activeDevices: devices.length, relayProtocolVersion: RELAY_PROTOCOL_VERSION };
}
