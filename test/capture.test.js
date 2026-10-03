import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { hasDx1ControlReports } from '../src/device.js';

test('selects the 16-byte control interface, not the first media interface', () => {
  const report = { reportId: 0, items: [{ reportSize: 8, reportCount: 16 }] };
  const device = { productName: 'DX1 II', vendorId: 5418, productId: 34640,
    collections: [{ usagePage: 12, usage: 1, inputReports: [report], outputReports: [] }] };
  assert.equal(hasDx1ControlReports(device), false);
  device.collections = [{ usagePage: 1, usage: 0, inputReports: [report], outputReports: [report] }];
  assert.equal(hasDx1ControlReports(device), true);
  device.collections[0].outputReports = [{ ...report, reportId: 1 }];
  assert.equal(hasDx1ControlReports(device), false);
});

test('recorder preserves sends, only records during marked window, and can restore method', () => {
  let calls = 0;
  const token = {};
  class HIDDevice {
    constructor() { this.productName = 'DX1 II'; this.vendorId = 5418; this.productId = 34640; }
    sendReport(id, data) { calls++; assert.equal(id, 0); assert.equal(data.byteLength, 16); return token; }
  }
  const original = HIDDevice.prototype.sendReport;
  let time = 0;
  const context = vm.createContext({ HIDDevice, performance: { now: () => time }, console: { info() {} } });
  vm.runInContext(readFileSync(new URL('../tools/capture-hid.js', import.meta.url), 'utf8'), context);
  assert.equal(calls, 0);
  const device = new HIDDevice();
  const data = new Uint8Array(20).subarray(2, 18); data[0] = 0x22;
  assert.equal(device.sendReport(0, data), token);
  context.dx1Capture.mark('volume -40 to -39.5');
  assert.equal(device.sendReport(0, data), token);
  time = 31000;
  device.sendReport(0, data);
  const output = JSON.parse(context.dx1Capture.json());
  assert.equal(output.records.length, 1);
  assert.equal(output.records[0].hex.split(' ').length, 16);
  assert.equal(output.records[0].hex.slice(0, 2), '22');
  context.dx1Capture.uninstall();
  assert.equal(HIDDevice.prototype.sendReport, original);
  assert.equal(calls, 3);
});

test('passive incoming capture preserves view offsets, observes only marked windows, and removes listeners', () => {
  class HIDDevice extends EventTarget {
    productName = 'DX1 II'; vendorId = 5418; productId = 34640;
    sendReport() { return 'unchanged'; }
  }
  const context = vm.createContext({ HIDDevice, performance: { now: () => 0 }, console: { info() {} } });
  vm.runInContext(readFileSync(new URL('../tools/capture-hid.js', import.meta.url), 'utf8'), context);
  const device = new HIDDevice();
  assert.equal(device.sendReport(0, new Uint8Array(16)), 'unchanged');
  const emit = () => {
    const buffer = new Uint8Array(20); buffer[2] = 0x22;
    const event = new Event('inputreport'); event.reportId = 0; event.data = new DataView(buffer.buffer, 2, 16);
    device.dispatchEvent(event);
  };
  emit(); context.dx1Capture.mark('state after gain change'); emit();
  const output = JSON.parse(context.dx1Capture.json());
  assert.equal(output.format, 'dx1-passive-v2'); assert.equal(output.records.length, 1);
  assert.equal(output.records[0].direction, 'in'); assert.equal(output.records[0].hex.slice(0, 2), '22');
  context.dx1Capture.uninstall(); emit();
  assert.equal(JSON.parse(context.dx1Capture.json()).records.length, 1);
});
