import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeError } from '../src/bridge-errors.js';
import { describeDevices, selectDeviceId } from '../src/device-routing.js';

const code = (error: unknown) => error instanceof BridgeError ? error.code : undefined;

test('device routing is deterministic and never falls back across zero, one or many devices', () => {
  assert.throws(() => selectDeviceId([]), error => code(error) === 'BRIDGE_DEVICE_UNAVAILABLE');
  assert.equal(selectDeviceId(['home-mac']), 'home-mac');
  assert.equal(selectDeviceId(['home-mac'], 'home-mac'), 'home-mac');
  assert.throws(() => selectDeviceId(['home-mac'], 'home-windows'), error => code(error) === 'BRIDGE_DEVICE_UNAVAILABLE');

  const devices = ['home-windows', 'class-windows', 'home-mac'];
  assert.throws(() => selectDeviceId(devices), error => code(error) === 'BRIDGE_DEVICE_AMBIGUOUS');
  assert.equal(selectDeviceId(devices, 'home-mac'), 'home-mac');
  assert.equal(selectDeviceId(devices, 'home-windows'), 'home-windows');
  assert.equal(selectDeviceId(devices, 'class-windows'), 'class-windows');
  assert.throws(() => selectDeviceId(devices, 'missing-device'), error => code(error) === 'BRIDGE_DEVICE_UNAVAILABLE');
});

test('device discovery returns only sorted public identities and connection state', () => {
  const result = describeDevices(['home-windows', 'home-mac', 'class-windows']);
  assert.deepEqual(result, {
    devices: [
      { deviceId: 'class-windows', connected: true },
      { deviceId: 'home-mac', connected: true },
      { deviceId: 'home-windows', connected: true },
    ],
    activeDevices: 3,
    relayProtocolVersion: 2,
  });
  assert.equal(JSON.stringify(result).match(/(?:token|hash|host|path|ip|credential)/i), null);
});
