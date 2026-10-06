import { safeSwitchVolume, validateCondition, validateLevel, validateStep } from './levels.js?v=hardware-9';

export class ComparisonController {
  constructor(device) { this.device = device; this.busy = false; this.applied = null; }
  async apply(side, condition, volumeDb, stepDb) {
    if (this.busy) throw new Error('A switch is already in progress.');
    const next = { ...condition };
    validateCondition(next);
    validateLevel(volumeDb);
    validateStep(stepDb);
    this.busy = true;
    this.applied = null;
    try {
      // Use device state, never values from editable form fields.
      const previous = await this.device.readState();
      if (!previous) throw new Error('Cannot switch without a known device state.');
      const quietVolume = safeSwitchVolume(previous.volumeDb, previous, volumeDb, next, stepDb);
      await this.device.setVolume(quietVolume);
      await this.device.setGain(next.gain);
      await this.device.setPeq(next.peq, next.preampDb);
      await this.device.setVolume(volumeDb);
      const actual = await this.device.readState();
      if (!actual || actual.volumeDb !== volumeDb || actual.gain !== next.gain || actual.peq !== next.peq
          || (next.peq && actual.preampDb !== next.preampDb)) {
        throw new Error('Device state did not match the requested comparison.');
      }
      this.applied = { side, condition: next, volumeDb };
      return this.applied;
    } finally { this.busy = false; }
  }
}
