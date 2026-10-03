import test from 'node:test';
import assert from 'node:assert/strict';
import { READ_COMMANDS, buildReadRequest, parseFrame, decodeVolume, summarizeReads } from '../src/dx1-protocol.js';
import { diagnoseDx1, requestDx1Diagnostics } from '../src/dx1-diagnostics.js';
import { targetVolume, safeSwitchVolume } from '../src/levels.js';

function response(command, value, count = 1, index = 1) {
  const bytes = Uint8Array.of(0x22, 0x33, 0x1f, count, index,
    command >> 8, command & 255, 0, 0, 0, 0, 0, 0, 0x66, 0x77, 0);
  new DataView(bytes.buffer).setUint32(7, value);
  return bytes;
}
class Device extends EventTarget {
  productName = 'DX1 II'; vendorId = 0x152a; productId = 0x8750; opened = false; sent = [];
  collections = [{ usagePage: 1, usage: 0, inputReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: 16 }] }],
    outputReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: 16 }] }] }];
  values = new Map([[0x1202, 0x0102], [0x8107, 128], [0x7100, 1], [0x7500, 0],
    [0x1204, 6], [0x1206, 0], [0x7400, 0], [0x7601, 590], [0x7200, 0]]);
  async open() { this.opened = true; }
  async close() { this.opened = false; this.closed = true; }
  emit(bytes, reportId = 0) {
    const event = new Event('inputreport'); event.data = new DataView(bytes.buffer); event.reportId = reportId;
    this.dispatchEvent(event);
  }
  async sendReport(id, bytes) {
    assert.equal(id, 0); const frame = parseFrame(bytes); this.sent.push(frame);
    if (this.values.has(frame.command)) this.emit(response(frame.command, this.values.get(frame.command)));
  }
}

test('read frame matches vendor layout; parser handles both report-prefix layouts and view offsets', () => {
  const bytes = buildReadRequest(0x7601);
  assert.equal(Buffer.from(bytes).toString('hex'), '22331001017601000000000000667700');
  const padded = new Uint8Array(24); padded.set(response(0x7601, 590), 4);
  assert.equal(parseFrame(padded.subarray(4, 20)).value, 590);
  const prefixed = new Uint8Array(16); prefixed.set(bytes.subarray(0, 15), 1);
  assert.equal(parseFrame(prefixed).command, 0x7601);
  bytes[13] = 0; assert.equal(parseFrame(bytes), null);
  assert.equal(parseFrame(prefixed, 1), null);
  assert.throws(() => buildReadRequest(0x110e));
});

test('volume grid matches vendor boundaries and invalid wire values are rejected', () => {
  for (const [raw, db] of [[0, -99], [590, -40], [890, -10], [895, -9.5], [990, 0]]) assert.equal(decodeVolume(raw), db);
  for (const raw of [null, NaN, -1, 991, 589, 892]) assert.throws(() => decodeVolume(raw));
  const condition = { peq: false, preampDb: 0, gain: 'low', trimDb: 0 };
  assert.equal(targetVolume(-24.7, condition, 'dx1'), -25);
  assert.equal(targetVolume(-9.3, condition, 'dx1'), -9.5);
  assert.equal(safeSwitchVolume(-10.2, condition, -9, condition, 'dx1'), -11);
});

test('diagnostic session reads legacy state, never writes settings, closes, and distinguishes logical PEQ', async () => {
  const device = new Device();
  const report = await diagnoseDx1(device, { hid: new EventTarget() });
  assert.equal(report.summary.protocol, 'legacy');
  assert.equal(report.summary.headphoneVolumeDb, -40);
  assert.equal(report.summary.peqEnabled, true);
  assert.equal(report.summary.peqRuntimeActive, false);
  assert.equal(report.summary.hardwareWritesEnabled, false);
  assert.equal(device.sent.length, 8);
  assert.ok(device.sent.every(frame => frame.type === 0x10 && frame.value === 0));
  assert.equal(device.closed, true);
});

test('unknown firmware capability stops before model-dependent queries', async () => {
  const device = new Device(); device.values.set(0x8107, 999);
  const report = await diagnoseDx1(device);
  assert.equal(report.summary.protocol, 'unknown'); assert.equal(device.sent.length, 2);
});

test('next protocol collects every output frame and does not query legacy volume', async () => {
  const device = new Device(); device.values.set(0x8107, 192);
  const original = device.sendReport.bind(device);
  device.sendReport = async (id, bytes) => {
    await original(id, bytes);
    if (parseFrame(bytes).command === READ_COMMANDS.nextOutput) {
      // Reverse order deliberately: collector must require every distinct index.
      for (let i = 12; i >= 1; i--) device.emit(response(READ_COMMANDS.nextOutput, i, 12, i));
    }
  };
  const report = await diagnoseDx1(device);
  assert.equal(report.reads.nextOutput.frames.length, 12);
  assert.equal(report.summary.protocol, 'next');
  assert.equal(report.reads.headphoneVolume, undefined);
});

test('timeouts and hung sends stop further requests and release device', async () => {
  const device = new Device(); device.sendReport = () => new Promise(() => {});
  const report = await diagnoseDx1(device, { timeoutMs: 10 });
  assert.equal(report.reads.firmware.status, 'timeout');
  assert.equal(Object.keys(report.reads).length, 1); assert.equal(device.closed, true);
});

test('transport rejection is reported and disconnect cancels pending read', async () => {
  const device = new Device(); device.sendReport = async () => { throw new Error('USB failure'); };
  assert.equal((await diagnoseDx1(device)).reads.firmware.status, 'send-failed');
  const hid = new EventTarget();
  device.sendReport = async () => { const e = new Event('disconnect'); e.device = device; hid.dispatchEvent(e); };
  assert.equal((await diagnoseDx1(device, { hid })).reads.firmware.status, 'disconnected');
});

test('wrong commands, report IDs and write acknowledgments do not satisfy readback', async () => {
  const device = new Device(); device.sendReport = async () => {
    device.emit(response(0x7500, 1)); device.emit(response(0x1202, 1), 1);
    const ack = response(0x1202, 1); ack[2] = 0x2f; device.emit(ack);
  };
  assert.equal((await diagnoseDx1(device, { timeoutMs: 10 })).reads.firmware.status, 'timeout');
  assert.equal(summarizeReads({}).peqEnabled, null);
});

test('chooser ignores media interface and refuses ambiguous or already-open devices', async () => {
  const media = new Device(); media.collections = [];
  const device = new Device();
  const hid = new EventTarget(); hid.requestDevice = async () => [media, device];
  assert.equal((await requestDx1Diagnostics({ hid })).summary.protocol, 'legacy');
  hid.requestDevice = async () => [device, new Device()];
  await assert.rejects(requestDx1Diagnostics({ hid }), /exactly one/);
  device.opened = true; await assert.rejects(diagnoseDx1(device), /already open/);
});
