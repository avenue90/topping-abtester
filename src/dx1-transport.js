import { hasDx1ControlReports } from './device.js?v=hardware-8';
import { parseFrame, READ_COMMANDS, buildReadRequest } from './dx1-protocol.js?v=hardware-8';
import { PresetCollector } from './dx1-presets.js?v=hardware-8';

export class Dx1Transport {
  constructor(device, { hid = globalThis.navigator?.hid, timeoutMs = 1800, requireCrc = true } = {}) {
    if (!hasDx1ControlReports(device)) throw new Error('Not a DX1 II control interface.');
    this.device = device; this.hid = hid; this.timeoutMs = timeoutMs; this.requireCrc = requireCrc;
    this.pending = null; this.failure = null; this.records = []; this.listeners = new Set();
    this.onInput = event => {
      const frame = parseFrame(event.data, event.reportId, { requireCrc: this.requireCrc });
      if (!frame) return;
      this.record('in', frame);
      for (const listener of this.listeners) listener(frame);
      const pending = this.pending;
      if (!pending || !pending.issued.has(frame.command) || !pending.responseTypes.includes(frame.type)) return;
      try { const result = pending.accept(frame); if (result) pending.finish(null, result); }
      catch (error) { pending.finish(error); }
    };
    this.onDisconnect = event => { if (event.device === this.device) this.fail(new Error('DX1 II disconnected.')); };
  }
  record(direction, frame) {
    this.records.push({ direction, ms: Date.now(), ...frame });
    if (this.records.length > 1000) this.records.shift();
  }
  async open() {
    if (this.device.opened) throw new Error('DX1 II already has a session in this page.');
    this.device.addEventListener('inputreport', this.onInput);
    this.hid?.addEventListener('disconnect', this.onDisconnect);
    try { await this.device.open(); } catch (error) { await this.close(); throw error; }
  }
  fail(error) {
    this.failure = error;
    this.pending?.finish(error);
    this.onFault?.(error);
  }
  async close() {
    this.fail(new Error('DX1 II session closed.'));
    this.device.removeEventListener('inputreport', this.onInput);
    this.hid?.removeEventListener('disconnect', this.onDisconnect);
    if (this.device.opened) await this.device.close();
  }
  assertReady() {
    if (this.failure) throw this.failure;
    if (!this.device.opened) throw new Error('DX1 II is not connected.');
    if (this.pending) throw new Error('A DX1 II request is already in progress.');
  }
  async exchange(bytes, accept, timeoutMs = this.timeoutMs, responseTypes = [0x10, 0x11, 0x1f, 0x20]) {
    this.assertReady();
    const requests = Array.isArray(bytes) ? bytes : [bytes];
    const command = parseFrame(requests[0]).command;
    return new Promise((resolve, reject) => {
      let finished = false, sent = false, result = null;
      const finish = (error, value) => {
        if (finished) return;
        if (!error) { result = value; if (!sent) return; }
        finished = true; clearTimeout(timer); this.pending = null;
        if (error) { this.failure = error; this.onFault?.(error); reject(error); }
        else resolve(result);
      };
      const timer = setTimeout(() => finish(new Error(`DX1 II 0x${command.toString(16)} timed out. Reconnect before trying again.`)), timeoutMs);
      const issued = new Set();
      this.pending = { command, issued, accept, finish, responseTypes };
      (async () => {
        for (const request of requests) {
          if (finished) return;
          const frame = parseFrame(request);
          issued.add(frame.command);
          this.record('out', frame);
          await this.device.sendReport(0, request);
        }
        sent = true; if (result) finish(null, result);
      })().catch(error => finish(error));
    });
  }
  read(key, { count = 1, base = 1 } = {}) {
    const frames = new Map();
    return this.exchange(buildReadRequest(READ_COMMANDS[key]), frame => {
      if (frame.count !== count || frame.index < base || frame.index >= base + count) return null;
      // A second start frame invalidates the preceding partial snapshot.
      if (frame.index === base) frames.clear();
      if (!frames.size && frame.index !== base) return null;
      frames.set(frame.index, frame);
      return frames.size === count ? [...frames.values()].sort((a, b) => a.index - b.index) : null;
    });
  }
  readPresets() {
    const collector = new PresetCollector();
    return this.exchange(buildReadRequest(READ_COMMANDS.presets), frame => collector.ingest(frame) ? collector.presets : null, 5000);
  }
  readMany(specs) {
    // Independent reads can be in flight together. Physical writes remain
    // strictly sequential and cannot interleave with this batch.
    const collectors = new Map(), results = {};
    const requests = specs.map(spec => {
      const { key, count = 1, base = 1 } = typeof spec === 'string' ? { key: spec } : spec;
      const command = READ_COMMANDS[key];
      if (collectors.has(command)) throw new Error('Duplicate read in a batch.');
      collectors.set(command, { key, count, base, frames: new Map() });
      return buildReadRequest(command);
    });
    if (!requests.length) throw new Error('Empty read batch.');
    return this.exchange(requests, frame => {
      const c = collectors.get(frame.command);
      if (!c || frame.count !== c.count || frame.index < c.base || frame.index >= c.base + c.count) return null;
      if (frame.index === c.base) { c.frames.clear(); delete results[c.key]; }
      if (!c.frames.size && frame.index !== c.base) return null;
      c.frames.set(frame.index, frame);
      if (c.frames.size === c.count) results[c.key] = [...c.frames.values()].sort((a,b) => a.index-b.index);
      return Object.keys(results).length === specs.length ? results : null;
    });
  }
  async write(bytes) {
    this.assertReady();
    // Use echo/readback for these vendor commands; a sendReport resolution alone
    // must never count as accepted state. This serializes sends and bounds hangs.
    const requested = parseFrame(bytes);
    return this.exchange(bytes, frame => frame.count === requested.count && frame.index === requested.index
      && frame.value === requested.value ? [frame] : null, this.timeoutMs, [0x10, 0x11, 0x1f, 0x20, 0x21]);
  }
}

export async function selectDx1(hid = globalThis.navigator?.hid) {
  if (!hid) throw new Error('This browser does not support WebHID.');
  const granted = (await hid.getDevices()).filter(hasDx1ControlReports);
  if (granted.length === 1) return granted[0];
  const devices = await hid.requestDevice({ filters: [{ vendorId: 0x152a, productId: 0x8750 }] });
  if (!devices.length) return null;
  const selected = devices.filter(hasDx1ControlReports);
  if (selected.length !== 1) throw new Error('Select exactly one DX1 II control interface.');
  return selected[0];
}
