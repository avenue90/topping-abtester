import { validateCondition, validateLevel } from './levels.js?v=hardware-9';

export function isDx1II(name) {
  return /(?:^|[^A-Z0-9])DX1\s*II(?:$|[^A-Z0-9])/.test(
    String(name).normalize('NFKC').toUpperCase());
}

// Based on the user's DX1 II descriptor, not a guessed register map.
export function hasDx1ControlReports(device) {
  const is16Byte = r => r.reportId === 0 &&
    (r.items || []).reduce((bits, i) => bits + i.reportSize * i.reportCount, 0) === 128;
  return isDx1II(device.productName) && device.vendorId === 0x152a && device.productId === 0x8750 &&
    device.collections.some(c => c.usagePage === 1 && c.usage === 0 &&
      (c.inputReports || []).some(is16Byte) && (c.outputReports || []).some(is16Byte));
}

// Descriptor inspection never opens the device or sends a HID report.
// There is deliberately no guessed DX5 II write implementation here.
export async function inspectDx1(hid = globalThis.navigator?.hid) {
  if (!hid) throw new Error('WebHID needs a supported browser such as desktop Chrome or Edge on localhost or HTTPS.');
  const devices = await hid.requestDevice({ filters: [{ vendorId: 0x152a }] });
  if (!devices.length) return null;
  if (!isDx1II(devices[0].productName)) {
    throw new Error(`Selected ${devices[0].productName || 'unknown device'}, not DX1 II.`);
  }
  function collection(c) {
    const reports = key => (c[key] || []).map(r => ({ reportId: r.reportId,
      items: (r.items || []).map(i => ({ reportSize: i.reportSize, reportCount: i.reportCount })) }));
    return { usagePage: c.usagePage, usage: c.usage, inputReports: reports('inputReports'),
      outputReports: reports('outputReports'), featureReports: reports('featureReports'),
      children: (c.children || []).map(collection) };
  }
  return devices.map(d => ({ name: d.productName, vendorId: d.vendorId, productId: d.productId,
    controlInterfaceCandidate: hasDx1ControlReports(d),
    collections: d.collections.map(collection) }));
}

export class DemoDevice {
  constructor() {
    this.state = { volumeDb: -35, peq: false, preampDb: 0, gain: 'low', trimDb: 0 };
  }
  async readState() { return { ...this.state }; }
  async setVolume(value) { validateLevel(value); this.state.volumeDb = value; }
  async setGain(value) {
    validateCondition({ ...this.state, gain: value });
    this.state.gain = value;
  }
  async setPeq(peq, preampDb) {
    validateCondition({ ...this.state, peq, preampDb });
    Object.assign(this.state, { peq, preampDb });
  }
}
