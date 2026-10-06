import { hasDx1ControlReports } from './device.js?v=hardware-9';
import { READ_COMMANDS, buildReadRequest, parseFrame, summarizeReads } from './dx1-protocol.js?v=hardware-9';

// A short, read-only session. No connect announcement, heartbeat, preset upload,
// mute, gain, volume, or other write command can be sent by this module.
export async function diagnoseDx1(device, { hid = globalThis.navigator?.hid,
  timeoutMs = 900, onProgress = () => {} } = {}) {
  if (!hasDx1ControlReports(device)) throw new Error('Select the DX1 II 16-byte control interface.');
  if (device.opened) throw new Error('The device is already open in this page. Close its current session first.');
  const transcript = { format: 'dx1-diagnostics-v1', createdAt: new Date().toISOString(),
    device: { name: device.productName, vendorId: device.vendorId, productId: device.productId },
    note: 'Read requests only. No audio settings changed. Responses are not an atomic state snapshot.',
    reads: {}, records: [], capped: false };
  let pending = null, disconnected = false;
  const record = (direction, data, frame) => {
    if (transcript.records.length >= 512) { transcript.capped = true; return; }
    const bytes = new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength);
    transcript.records.push({ direction, hex: Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(' '), frame });
  };
  const onInput = event => {
    const frame = parseFrame(event.data, event.reportId);
    record('in', event.data, frame);
    // A write acknowledgment is not a state response.
    if (!frame || ![0x10, 0x11, 0x1f, 0x20].includes(frame.type)
        || !pending || pending.command !== frame.command || frame.count !== pending.count
        || frame.index < 1 || frame.index > pending.count) return;
    pending.frames.set(frame.index, frame);
    if (pending.frames.size === pending.count) pending.finish('received');
  };
  const onDisconnect = event => {
    if (event.device !== device) return;
    disconnected = true;
    pending?.finish('disconnected');
  };
  const read = async (key, count = 1) => {
    if (disconnected) return;
    const command = READ_COMMANDS[key];
    onProgress(`Reading ${key}…`);
    let timer;
    // Bound the send and response together: a hung send must not hang the UI.
    const result = await new Promise(resolve => {
      const frames = new Map();
      pending = { command, count, frames, finish(status, error) {
        clearTimeout(timer);
        pending = null;
        resolve({ status, ...(error ? { error } : {}), frames: [...frames.values()].sort((a, b) => a.index - b.index) });
      } };
      timer = setTimeout(() => pending?.finish('timeout'), timeoutMs);
      const request = buildReadRequest(command);
      record('out', request, parseFrame(request));
      const current = pending;
      try {
        Promise.resolve(device.sendReport(0, request)).catch(error => {
          if (pending === current) current.finish('send-failed', String(error.message ?? error));
        });
      } catch (error) { current.finish('send-failed', String(error.message ?? error)); }
    });
    transcript.reads[key] = result;
    // Do not continue a session whose transport or request timing is uncertain.
    return result.status === 'received';
  };
  device.addEventListener('inputreport', onInput);
  hid?.addEventListener('disconnect', onDisconnect);
  try {
    await device.open();
    // Identify firmware before querying commands whose behavior differs.
    for (const key of ['firmware', 'capability']) if (!await read(key)) return finish();
    const protocol = summarizeReads(transcript.reads).protocol;
    if (protocol === 'unknown' || protocol === 'legacy-without-home-controls') return finish();
    for (const key of ['state', 'peq', 'preset']) if (!await read(key)) return finish();
    if (protocol === 'next') await read('nextOutput', 12);
    else for (const key of ['output', 'headphoneVolume', 'mute']) if (!await read(key)) break;
    return finish();
  } finally {
    pending?.finish('closed');
    device.removeEventListener('inputreport', onInput);
    hid?.removeEventListener('disconnect', onDisconnect);
    if (device.opened) await device.close();
  }
  function finish() {
    transcript.summary = summarizeReads(transcript.reads);
    return transcript;
  }
}

export async function requestDx1Diagnostics(options = {}) {
  const hid = options.hid ?? globalThis.navigator?.hid;
  if (!hid) throw new Error('WebHID is unavailable. Open localhost in a desktop browser with WebHID support.');
  const devices = await hid.requestDevice({ filters: [{ vendorId: 0x152a, productId: 0x8750 }] });
  if (!devices.length) return null;
  const candidates = devices.filter(hasDx1ControlReports);
  if (candidates.length !== 1) throw new Error('Select exactly one DX1 II control interface.');
  return diagnoseDx1(candidates[0], { ...options, hid });
}
