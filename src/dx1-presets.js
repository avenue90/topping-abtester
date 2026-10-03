// Readback only. Never serializes or writes DSP configuration.
export class PresetCollector {
  constructor() { this.metadata = new Map(); this.presets = []; this.words = []; this.length = null; }
  ingest(frame) {
    if (frame.command !== 0x1106) return false;
    if (frame.count === 2) {
      if (frame.index > 1 || this.words.length || this.presets.length) throw new Error('Unexpected preset metadata.');
      if (this.metadata.has(frame.index)) throw new Error('Duplicate preset metadata.');
      this.metadata.set(frame.index, frame.value);
      if (frame.index === 0 && (frame.value < 1 || frame.value > 3)) throw new Error('Unsupported preset count.');
      return false;
    }
    if (this.metadata.size !== 2 || ![74, 78].includes(frame.count)
        || frame.index !== this.words.length || (this.length !== null && this.length !== frame.count)) {
      throw new Error('Incomplete or reordered preset readback.');
    }
    this.length = frame.count;
    this.words.push(frame.value);
    if (this.words.length === this.length) {
      this.presets.push(decodePreset(this.words)); this.words = [];
      return this.presets.length === this.metadata.get(0);
    }
    return false;
  }
}

export function decodePreset(words) {
  if (![74, 78].includes(words.length) || words.some(v => !Number.isInteger(v) || v < 0 || v > 0xffffffff)) {
    throw new Error('Invalid preset data.');
  }
  const bytes = new Uint8Array(16), view = new DataView(bytes.buffer);
  for (let i = 0; i < 4; i++) view.setUint32(i * 4, words[i], true);
  const nameBytes = bytes.subarray(0, 15), end = nameBytes.indexOf(0);
  const name = new TextDecoder().decode(end < 0 ? nameBytes : nameBytes.subarray(0, end));
  const channel = (enabled, coefficient) => {
    if (![0, 1].includes(enabled) || coefficient <= 0) throw new Error('Invalid preset preamp.');
    // The coefficient is a Q25 amplitude multiplier. Computing the actual gain
    // avoids ambiguities/duplicates in the vendor's nominal dB lookup table.
    const db = 20 * Math.log10(coefficient / 0x2000000);
    if (!Number.isFinite(db) || db < -12.1 || db > 12.1) throw new Error('Unsupported preamp coefficient.');
    return { enabled: Boolean(enabled), coefficient, gainDb: Math.round(db * 100) / 100 };
  };
  return { name, left: channel(words[4], words[5]), right: channel(words[6], words[7]), words: [...words] };
}

export function matchedPreamp(preset) {
  if (!preset) throw new Error('The selected preset was not read from the DAC.');
  const left = preset.left.enabled ? preset.left.gainDb : 0;
  const right = preset.right.enabled ? preset.right.gainDb : 0;
  if (Math.abs(left - right) > 0.01) throw new Error('Left and right pre-gains differ; one volume cannot compensate both.');
  return left;
}
