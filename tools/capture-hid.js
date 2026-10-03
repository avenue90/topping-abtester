// Run once in the developer console on https://home.toppingaudio.com/peq.
// Passively records outgoing calls and incoming reports while explicitly recording.
// Does not open devices, send commands, change settings or use the network.
(() => {
  'use strict';
  if (globalThis.dx1Capture) throw new Error('Recorder already installed. Reload the page to remove it.');
  if (!globalThis.HIDDevice) throw new Error('WebHID is unavailable on this page.');
  const original = HIDDevice.prototype.sendReport;
  const records = [];
  let label = null;
  let expires = 0;
  let start = 0;
  let capped = false;
  const listeners = new Map();
  let installed = true;
  function matches(device) {
    const name = String(device.productName).normalize('NFKC').toUpperCase();
    return device.vendorId === 0x152a && device.productId === 0x8750
      && /(?:^|[^A-Z0-9])DX1\s*II(?:$|[^A-Z0-9])/.test(name);
  }
  function observe(device, direction, reportId, data) {
    if (!installed || !label || performance.now() >= expires || !matches(device) || reportId !== 0) return;
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    if (!(direction === 'in' ? [15, 16] : [16]).includes(bytes.length)) return;
    if (records.length >= 2000) { capped = true; label = null; return; }
    records.push({ label, direction, ms: Math.round(performance.now() - start), reportId,
      hex: Array.from(bytes, n => n.toString(16).padStart(2, '0')).join(' ') });
  }
  function attach(device) {
    if (!installed || !matches(device) || listeners.has(device) || !device.addEventListener) return;
    const listener = event => {
      try { observe(device, 'in', event.reportId, event.data); } catch { /* Passive only. */ }
    };
    device.addEventListener('inputreport', listener);
    listeners.set(device, listener);
  }
  function wrapper(reportId, data) {
    try {
      attach(this);
      observe(this, 'out', reportId, data);
    } catch { /* Observing must never interfere with the vendor's call. */ }
    return original.call(this, reportId, data);
  }
  HIDDevice.prototype.sendReport = wrapper;
  globalThis.dx1Capture = Object.freeze({
    mark(text) {
      if (typeof text !== 'string' || !text.trim()) throw new Error('Provide the action and its before/after values.');
      if (HIDDevice.prototype.sendReport !== wrapper) throw new Error('Recorder is no longer installed. Reload and reinstall.');
      label = text.slice(0, 160);
      start = performance.now();
      expires = start + 30000;
      return 'Recording for 30 seconds. Perform that action in Topping Home now.';
    },
    stop() { label = null; return `Stopped. ${records.length} reports recorded.`; },
    json() { label = null; return JSON.stringify({ format: 'dx1-passive-v2',
      note: 'Outgoing calls and passive incoming reports; individual calls are not proof of accepted state.', capped, records }, null, 2); },
    uninstall() {
      label = null;
      installed = false;
      for (const [device, listener] of listeners) device.removeEventListener('inputreport', listener);
      listeners.clear();
      if (HIDDevice.prototype.sendReport === wrapper) HIDDevice.prototype.sendReport = original;
      return 'Recorder removed. Reload the page before installing again.';
    }
  });
  // getDevices reads previously granted devices; it never opens a chooser or device.
  try {
    globalThis.navigator?.hid?.getDevices().then(devices => {
      for (const device of devices) attach(device);
    }).catch(() => {});
  } catch { /* The send wrapper can still attach to vendor-owned devices. */ }
  console.info('DX1 recorder installed. Use dx1Capture.mark("action: before → after") before each change; copy(dx1Capture.json()) to copy results.');
})();
