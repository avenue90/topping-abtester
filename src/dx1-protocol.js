// Independently implemented from the vendor wire format. See docs/PROTOCOL.md.
// Deliberately exposes read requests only until a device transcript is verified.
export const READ_COMMANDS = Object.freeze({
  firmware: 0x1202, capability: 0x8107, state: 0x7100,
  gain: 0x7500, peq: 0x1204, preset: 0x1206,
  output: 0x7400, headphoneVolume: 0x7601, mute: 0x7200,
  nextOutput: 0x810a,
  presets: 0x1106, preview: 0x111c,
});
// Next firmware does not expose 0x7500 as a read: testing showed high gain
// acknowledged, then low reported after this request. Never issue it as a probe.
const readable = new Set(Object.values(READ_COMMANDS).filter(command => command !== READ_COMMANDS.gain));

export function buildReadRequest(command) {
  if (!readable.has(command)) throw new Error('Command is not an approved DX1 II diagnostic read.');
  // Report ID is passed separately to WebHID. The final byte is padding.
  return Uint8Array.of(0x22, 0x33, 0x10, 1, 1, command >> 8, command & 255,
    0, 0, 0, 0, 0, 0, 0x66, 0x77, 0);
}

export function frameCrc(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc;
}

export function parseFrame(data, reportId = 0, { requireCrc = false } = {}) {
  if (reportId !== 0) return null;
  const bytes = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
  const offset = bytes.length === 16 && bytes[0] === 0 ? 1 : 0;
  if (![15, 16].includes(bytes.length) || bytes.length - offset < 15
      || bytes[offset] !== 0x22 || bytes[offset + 1] !== 0x33
      || bytes[offset + 13] !== 0x66 || bytes[offset + 14] !== 0x77) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 15);
  const checksum = view.getUint16(11);
  if ((requireCrc || checksum !== 0)
      && checksum !== frameCrc(bytes.subarray(offset + 2, offset + 11))) return null;
  const type = view.getUint8(2), count = view.getUint8(3), index = view.getUint8(4);
  if (![0x10, 0x11, 0x1f, 0x20, 0x21, 0x2f].includes(type)
      || !count || index > count) return null;
  return { type, count, index, command: view.getUint16(5), value: view.getUint32(7) };
}

export function decodeVolume(raw) {
  if (!Number.isInteger(raw) || raw < 0 || raw > 990
      || (raw <= 890 ? raw % 10 : raw % 5)) throw new Error('Invalid DX1 II volume value.');
  return raw / 10 - 99;
}

export function decodeNextOutput(frames) {
  if (frames?.length !== 12) throw new Error('Incomplete DX1 output snapshot.');
  const words = Array(12);
  for (const frame of frames) {
    if (frame.command !== READ_COMMANDS.nextOutput || frame.count !== 12
        || frame.index < 1 || frame.index > 12 || words[frame.index - 1] !== undefined) {
      throw new Error('Invalid DX1 output snapshot.');
    }
    words[frame.index - 1] = frame.value;
  }
  const [protocol, state, hp, lo, combined, opt, mute] = words;
  if ((protocol & 255) !== 2 || state > 255 || !(state & 7) || (state >> 6) > 2 || mute > 3) {
    throw new Error('Unsupported DX1 output protocol.');
  }
  return { protocolVersion: 2, capabilities: protocol >>> 8 & 255,
    outputMask: state & 7, fixed0Db: Boolean(state & 8), volumeLinked: Boolean(state & 16),
    controlTarget: state & 32 ? 'opt' : 'analog', peqRoute: ['analog', 'opt', 'both'][state >> 6],
    volumeDb: decodeVolume(hp), lineVolumeDb: decodeVolume(lo),
    combinedVolumeDb: decodeVolume(combined), opticalVolumeDb: decodeVolume(opt),
    analogMuted: Boolean(mute & 1), opticalMuted: Boolean(mute & 2),
  };
}

export function summarizeReads(reads) {
  const single = key => {
    const frames = reads[key]?.frames;
    return frames?.length === 1 && frames[0].count === 1 && frames[0].index === 1
      ? frames[0].value : null;
  };
  const capability = single('capability'), peq = single('peq'), gain = single('gain');
  const rawVolume = single('headphoneVolume');
  let headphoneVolumeDb = null;
  try { headphoneVolumeDb = decodeVolume(rawVolume); } catch { /* Retain raw report. */ }
  let output = null;
  if (capability === 192) {
    try { output = decodeNextOutput(reads.nextOutput?.frames); headphoneVolumeDb = output.volumeDb; }
    catch { /* An incomplete snapshot is never a usable state. */ }
  }
  return {
    protocol: capability === 192 ? 'next' : capability === 128 ? 'legacy'
      : capability === 64 ? 'legacy-without-home-controls' : 'unknown',
    capability, firmwareRaw: single('firmware'), stateRaw: single('state'),
    gain: gain === 1 ? 'high' : gain === 0 ? 'low' : null,
    headphoneVolumeDb,
    output,
    peqEnabled: peq === null ? null : Boolean(peq & (peq & 4 ? 2 : 1)),
    peqRuntimeActive: peq === null ? null : Boolean(peq & 1),
    presetRaw: single('preset'), outputRaw: single('output'), muteRaw: single('mute'),
    hardwareWritesEnabled: false,
  };
}
