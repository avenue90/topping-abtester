import test from 'node:test';
import assert from 'node:assert/strict';
import { ComparisonController } from '../src/controller.js';
import { DemoDevice, inspectDx1, isDx1II } from '../src/device.js';
const flat = { peq: false, preampDb: 0, gain: 'low', trimDb: 0 };

test('switch uses actual prior state and snapshots editable condition', async () => {
  const device = new DemoDevice();
  const controller = new ComparisonController(device);
  const next = { ...flat, peq: true, preampDb: -20, gain: 'high' };
  const pending = controller.apply('b', next, -29, 0.5);
  next.gain = 'low';
  await pending;
  assert.equal(controller.applied.condition.gain, 'high');
  assert.deepEqual(await device.readState(), { ...flat, peq: true, preampDb: -20, gain: 'high', volumeDb: -29 });
  const writes = [];
  const original = device.setVolume.bind(device);
  device.setVolume = async v => { writes.push(v); await original(v); };
  await controller.apply('a', flat, -35, 0.5);
  assert.equal(writes.at(-1), -35);
  assert.equal(controller.applied.side, 'a');
});

test('overlapping switches are refused', async () => {
  const controller = new ComparisonController(new DemoDevice());
  const first = controller.apply('a', flat, -35, 0.5);
  await assert.rejects(controller.apply('b', flat, -40, 0.5), /progress/);
  await first;
});

test('partial failure never raises final volume or reports successful application', async () => {
  const device = new DemoDevice();
  const controller = new ComparisonController(device);
  await controller.apply('a', flat, -35, 0.5);
  device.setPeq = async () => { throw new Error('Disconnected'); };
  await assert.rejects(controller.apply('b', { ...flat, gain: 'high', peq: true, preampDb: -20 }, -29, 0.5));
  assert.equal(device.state.volumeDb, -49);
  assert.equal(controller.applied, null);
  assert.equal(controller.busy, false);
});

test('unknown state fails before any writes', async () => {
  const device = new DemoDevice();
  device.readState = async () => null;
  const controller = new ComparisonController(device);
  await assert.rejects(controller.apply('a', flat, -40, 0.5), /known/);
  assert.equal(device.state.volumeDb, -35);
});

test('mismatched readback is not success', async () => {
  const device = new DemoDevice();
  device.setGain = async () => {};
  const controller = new ComparisonController(device);
  await assert.rejects(controller.apply('b', { ...flat, gain: 'high' }, -49, 0.5), /did not match/);
  assert.equal(controller.applied, null);
});

test('inspection handles cancellation, model normalization and never opens a device', async () => {
  assert.equal(isDx1II('TOPPING DX1 Ⅱ'), true);
  assert.equal(isDx1II('DX1 II'), true);
  assert.equal(isDx1II('DX1 III'), false);
  assert.equal(await inspectDx1({ requestDevice: async () => [] }), null);
  const descriptor = { productName: 'TOPPING DX1 II', vendorId: 0x152a, productId: 1,
    collections: [], open: () => { throw new Error('Must not open'); } };
  assert.equal((await inspectDx1({ requestDevice: async () => [descriptor] }))[0].name, descriptor.productName);
  await assert.rejects(inspectDx1({ requestDevice: async () => [{ ...descriptor, productName: 'DX5 II' }] }), /not DX1/);
});
