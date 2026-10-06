import { decodeNextOutput, READ_COMMANDS, decodeVolume } from './dx1-protocol.js?v=hardware-9';
import { matchedPreamp } from './dx1-presets.js?v=hardware-9';
import { safePeqSwitchVolume, validateCondition, validateLevel } from './levels.js?v=hardware-9';

// Only volume and PEQ controls are supported. No DSP preset writes,
// output routing, firmware, reset, or persistence commands are exposed.
export function buildControlWrite(control, value) {
  let command, count = 1, index = 1, data;
  if (control === 'volume') {
    validateLevel(value); data = Math.round((value + 99) * 10);
    if (Math.abs(decodeVolume(data) - value) > 0.001) throw new Error('Volume is not on the DX1 II grid.');
    command = READ_COMMANDS.nextOutput; count = 12; index = 3;
  } else if (control === 'peq' && (value === false || [0, 1, 2].includes(value))) {
    command = value === false ? 0x110e : READ_COMMANDS.preset;
    data = value === false ? 0xffffffff : value;
  } else throw new Error('Unsupported hardware write.');
  const bytes = Uint8Array.of(0x22, 0x33, 0x20, count, index, command >> 8, command & 255,
    0, 0, 0, 0, 0, 0, 0x66, 0x77, 0);
  new DataView(bytes.buffer).setUint32(7, data);
  return bytes;
}

function requireHeadphones(output) {
  if (output.outputMask !== 2 || output.fixed0Db || output.volumeLinked || output.controlTarget !== 'analog') {
    throw new Error('A/B requires headphone-only output, adjustable volume, and volume linking off. Set this in Topping Home first.');
  }
  if (!['analog', 'both'].includes(output.peqRoute)) throw new Error('PEQ must be routed to the headphone output.');
}

export class Dx1Controller {
  constructor(transport) {
    this.transport = transport; this.busy = false; this.applied = null; this.hardware = true;
    this.initialized = false; this.state = null; this.preset = null; this.presetIndex = null; this.presets = [];
    this.failure = null; this.transaction = null;
    transport.onFault = error => { this.failure = error; this.applied = null; this.onChange?.(); };
    // Invalidate the displayed applied state when the knob or another controller
    // changes anything relevant. During switching, only expected values may vary.
    transport.listeners.add(frame => this.observe(frame));
  }
  observe(frame) {
    if (!this.initialized) return;
    const t = this.transaction;
    // Gain is unknown. Neither 0 nor 1 can be compared to the nominal value
    // used for level math. Invalidate even during the preflight read batch.
    if (frame.command === READ_COMMANDS.gain) {
      this.failure = new Error('Headphone gain activity detected. Reconnect before continuing.');
      this.applied = null; this.onChange?.(); return;
    }
    if ((frame.command >= 0x9000 && frame.command <= 0x9eff)
        || [0x1106, 0x110b, 0x110f, 0x1110].includes(frame.command)) {
      this.failure = new Error('PEQ configuration activity detected. Reconnect to read the preset again.');
      this.applied = null; this.onChange?.(); return;
    }
    const relevant = [0x7100, 0x7500, 0x1204, 0x1206, 0x111c, 0x810a, 0x1106].includes(frame.command);
    if (!relevant) return;
    if (!t) {
      // Repeated identical broadcasts are common on the real device. They do
      // not invalidate A/B selection or the Space-key toggle.
      const s = this.state;
      if (!s || this.busy) return;
      const outputState = s.outputMask | (s.peqRoute === 'both' ? 128 : 0);
      const changed = frame.command === 0x1204 ? !(frame.value & 4) || Boolean(frame.value & 2) !== s.peq || Boolean(frame.value & 1) !== s.peq
        : frame.command === 0x1206 ? frame.value !== this.presetIndex
        : frame.command === 0x7100 ? ![1, 11].includes(frame.value)
        : frame.command === 0x111c ? frame.index === 0 && (frame.value >>> 24) !== 0
        : frame.command === 0x810a && frame.count === 12 ? (frame.index === 2 && frame.value !== outputState)
          || (frame.index === 3 && frame.value !== Math.round((s.volumeDb + 99) * 10))
          || (frame.index === 7 && Boolean(frame.value & 1) !== s.analogMuted)
        : false;
      if (changed && this.applied) { this.applied = null; this.onChange?.('changed'); }
      return;
    }
    let unexpected = false;
    if (frame.command === 0x1204) unexpected = !(frame.value & 4) || !t.peqs.has(Boolean(frame.value & 2));
    if (frame.command === 0x1206) unexpected = !t.presets.has(frame.value);
    if (frame.command === 0x7100) unexpected = ![1, 11].includes(frame.value);
    if (frame.command === 0x111c && frame.index === 0) unexpected = (frame.value >>> 24) !== 0;
    if (frame.command === 0x810a && frame.count === 12) {
      if (frame.index === 2) unexpected = frame.value !== t.outputState;
      if (frame.index === 3) unexpected = !t.volumes.has(frame.value);
      if (frame.index === 7) unexpected = (frame.value & 1) !== 0;
    }
    if (unexpected) t.conflict = true;
  }
  async single(key) { return (await this.transport.read(key))[0].value; }
  async connect() {
    await this.transport.open();
    try {
      this.firmwareRaw = await this.single('firmware');
      if (await this.single('capability') !== 192 || this.firmwareRaw !== 0x0307) {
        throw new Error('This controller currently supports the verified DX1 II Next firmware 0x0307 only.');
      }
      this.presets = await this.transport.readPresets();
      this.presetIndex = await this.single('preset');
      if (![0, 1, 2].includes(this.presetIndex)) throw new Error('Unknown active preset.');
      this.preset = this.presets[this.presetIndex];
      this.preampDb = matchedPreamp(this.preset);
      this.state = await this.readState();
      this.initialized = true;
      return this.state;
    } catch (error) { await this.transport.close(); throw error; }
  }
  presetPreamp(index) {
    if (!Number.isInteger(index) || index < 0 || index > 2) throw new Error('Invalid EQ profile.');
    return matchedPreamp(this.presets[index]);
  }
  async readState() {
    const reads = await this.transport.readMany(['state', { key: 'nextOutput', count: 12 },
      'peq', 'preset', { key: 'preview', count: 3, base: 0 }]);
    const mode = reads.state[0].value;
    if (![1, 11].includes(mode)) throw new Error('DX1 II must be awake and outside its settings menu.');
    const output = decodeNextOutput(reads.nextOutput);
    requireHeadphones(output);
    const peq = reads.peq[0].value;
    const presetIndex = reads.preset[0].value;
    const preview = reads.preview;
    if ((preview[0].value >>> 24) !== 0) throw new Error('Exit temporary PEQ audition before A/B comparison.');
    if (!(peq & 4)) throw new Error('Unrecognized PEQ state.');
    const enabled = Boolean(peq & 2), active = Boolean(peq & 1);
    if (enabled !== active) throw new Error('PEQ enabled and runtime states differ; matching is unavailable for this signal.');
    if (presetIndex !== this.presetIndex) throw new Error('The active preset changed. Reconnect to load its pre-gain.');
    // A nominal low value keeps level math internally consistent. It cancels
    // between PEQ endpoints because live mode never reads or changes gain.
    this.state = { ...output, gain: 'low', gainKnown: false, peq: enabled,
      preampDb: this.preampDb, trimDb: 0, presetIndex };
    return this.state;
  }
  guard() {
    if (this.failure) throw this.failure;
    if (this.transaction?.conflict) throw new Error('Device settings changed during the switch. Stopped; reconnect before continuing.');
  }
  async apply(side, condition, volumeDb, step) {
    if (this.busy) throw new Error('A switch is already in progress.');
    if (!this.initialized) throw new Error('Connect and read the DX1 II first.');
    this.guard();
    const next = { ...condition };
    validateCondition(next); validateLevel(volumeDb);
    buildControlWrite('volume', volumeDb);
    if (next.gain !== 'low') throw new Error('Live gain switching is unavailable; use simulation for gain comparisons.');
    const targetPreset = next.peq ? (next.presetIndex ?? this.presetIndex) : this.presetIndex;
    const targetPreamp = this.presetPreamp(targetPreset);
    if (step !== 'dx1' || (next.peq && next.preampDb !== targetPreamp)) throw new Error('Use the device-read pre-gain and DX1 II volume steps.');
    this.busy = true; this.applied = null;
    const started = performance.now();
    const timings = {}; let stageStarted = started;
    const mark = name => { const now = performance.now(); timings[name] = Math.round(now - stageStarted); stageStarted = now; };
    try {
      // Stored preset data is fixed for this connection. Incoming configuration
      // activity invalidates it; reconnect after editing PEQ in another app.
      let actual = await this.readState();
      this.guard();
      if (actual.analogMuted) throw new Error('The headphones are muted. Unmute on the DAC before starting A/B.');
      mark('preflight');
      const changePeq = actual.peq !== next.peq || (next.peq && actual.presetIndex !== targetPreset);
      const expected = { ...next, presetIndex: targetPreset };
      const quiet = safePeqSwitchVolume(actual.volumeDb, actual, volumeDb, next, 'dx1');
      const outputState = actual.outputMask | (actual.peqRoute === 'both' ? 128 : 0);
      this.transaction = { conflict: false, outputState,
        volumes: new Set([Math.round((actual.volumeDb + 99) * 10)]),
        peqs: new Set([actual.peq]), presets: new Set([actual.presetIndex]) };
      let wrote = false;

      // Phase 1: Prove attenuation took effect before changing PEQ.
      // An echo can acknowledge a command without proving the resulting level.
      if (actual.volumeDb !== quiet) {
        this.transaction.volumes.add(Math.round((quiet + 99) * 10));
        await this.transport.write(buildControlWrite('volume', quiet));
        this.transaction.volumes = new Set([Math.round((quiet + 99) * 10)]);
        actual = { ...actual, volumeDb: quiet };
        wrote = true;
        if (changePeq) {
          const output = decodeNextOutput(await this.transport.read('nextOutput', { count: 12 }));
          requireHeadphones(output);
          this.guard();
          if (output.analogMuted || output.volumeDb !== quiet) {
            throw new Error('Attenuation readback failed. No gain or PEQ changes were sent.');
          }
        }
      }
      this.guard();

      mark('attenuation');

      // Phase 2: Switch PEQ at the attenuated volume. Live gain is untouched.
      if (changePeq) {
        this.transaction.peqs.add(next.peq);
        this.transaction.presets.add(targetPreset);
        await this.transport.write(buildControlWrite('peq', next.peq ? targetPreset : false));
        this.transaction.presets = new Set([targetPreset]);
        this.transaction.peqs = new Set([next.peq]);
        actual = { ...actual, peq: next.peq };
        wrote = true;
      }
      this.guard();

      mark('eq');

      // Phase 3: An echo alone cannot establish the resulting PEQ state.
      // Verify PEQ and the preset before raising volume.
      if (actual.volumeDb !== volumeDb) {
        const preRaise = await this.transport.readMany(['peq', 'preset']);
        this.verifyPeq(preRaise, expected);
        this.guard();

        // Phase 4: Restore volume to the target level.
        this.transaction.volumes.add(Math.round((volumeDb + 99) * 10));
        await this.transport.write(buildControlWrite('volume', volumeDb));
        this.transaction.volumes = new Set([Math.round((volumeDb + 99) * 10)]);
        actual = { ...actual, volumeDb };
        wrote = true;
      }
      this.guard();

      mark('restore');

      // Phase 5: Confirm the final hardware state matches the target.
      if (wrote) {
        const final = await this.transport.readMany([
          { key: 'nextOutput', count: 12 }, 'peq', 'preset']);
        const output = decodeNextOutput(final.nextOutput);
        requireHeadphones(output);
        const fPeq = final.peq[0].value;
        this.verifyPeq(final, expected);
        if (!(fPeq & 4) || Boolean(fPeq & 1) !== Boolean(fPeq & 2)) {
          throw new Error('PEQ runtime did not match its enabled state.');
        }
        this.guard();
        if (output.analogMuted || output.volumeDb !== volumeDb
            || Boolean(fPeq & 2) !== next.peq) {
          throw new Error('Hardware readback did not match the requested state. Stopped without restoring volume.');
        }
        this.state = { ...output, gain: 'low', gainKnown: false, peq: next.peq,
          preampDb: targetPreamp, trimDb: 0, presetIndex: targetPreset };
      }

      this.guard();
      this.presetIndex = targetPreset; this.preset = this.presets[targetPreset]; this.preampDb = targetPreamp;
      mark('verification');
      this.applied = { side, condition: next, volumeDb, timings, durationMs: Math.round(performance.now() - started) };
      return this.applied;
    } catch (error) {
      this.failure = error; this.applied = null;
      // Never blindly restore a louder endpoint after an uncertain write.
      throw error;
    } finally { this.transaction = null; this.busy = false; }
  }
  verifyPeq(reads, expected) {
    const peq = reads.peq[0].value;
    if (!(peq & 4) || Boolean(peq & 1) !== Boolean(peq & 2)) {
      throw new Error('PEQ runtime did not match its enabled state.');
    }
    if (Boolean(peq & 2) !== expected.peq) {
      throw new Error('Hardware readback did not match the requested state. Stopped without restoring volume.');
    }
    if (reads.preset[0].value !== expected.presetIndex) {
      throw new Error('Preset changed during switch.');
    }
  }
  async close() { this.initialized = false; this.applied = null; await this.transport.close(); }
}
