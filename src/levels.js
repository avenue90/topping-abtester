export const GAIN_DIFFERENCE_DB = 14;
export const MIN_VOLUME_DB = -99;
export const MAX_VOLUME_DB = 0;

function finiteRange(value, min, max, label) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max} dB.`);
  }
}
export function validateStep(stepDb) {
  if (!['dx1', 0.5, 1].includes(stepDb)) throw new Error('Choose DX1 II steps, 0.5 or 1 dB.');
}
export function quantizeVolume(value, stepDb, down = false) {
  validateStep(stepDb);
  const step = stepDb === 'dx1' ? (value <= -10 ? 1 : 0.5) : stepDb;
  return (down ? Math.floor(value / step) : Math.round(value / step)) * step;
}
export function validateCondition(condition) {
  if (typeof condition.peq !== 'boolean' || !['low', 'high'].includes(condition.gain)) {
    throw new Error('Invalid PEQ or headphone gain selection.');
  }
  finiteRange(condition.preampDb, -40, 10, 'Pre-gain');
  finiteRange(condition.trimDb, -12, 12, 'Listening trim');
}
export function targetVolume(referenceDb, condition, stepDb = 0.5) {
  finiteRange(referenceDb, MIN_VOLUME_DB, MAX_VOLUME_DB, 'Reference volume');
  validateCondition(condition);
  validateStep(stepDb);
  const raw = referenceDb - effectiveLevel(0, condition) + condition.trimDb;
  validateLevel(raw); // Do not round an unreachable level into the valid range.
  return quantizeVolume(raw, stepDb);
}
export function effectiveLevel(volumeDb, condition) {
  return volumeDb + (condition.peq ? condition.preampDb : 0)
    + (condition.gain === 'high' ? GAIN_DIFFERENCE_DB : 0);
}
export function safeSwitchVolume(fromVolume, fromCondition, toVolume, toCondition, stepDb = 0.5) {
  validateLevel(fromVolume);
  validateLevel(toVolume);
  validateCondition(fromCondition);
  validateCondition(toCondition);
  validateStep(stepDb);
  // The controller writes gain first, then PEQ. Include that intermediate state.
  const intermediate = { ...fromCondition, gain: toCondition.gain };
  const offsets = [fromCondition, intermediate, toCondition].map(c => effectiveLevel(0, c));
  const ceiling = Math.min(effectiveLevel(fromVolume, fromCondition), effectiveLevel(toVolume, toCondition));
  const safe = quantizeVolume(Math.min(fromVolume, toVolume,
    ceiling - Math.max(...offsets)), stepDb, true);
  if (safe < MIN_VOLUME_DB) {
    throw new Error('This transition needs a verified mute operation; the required attenuation is below −99 dB.');
  }
  return safe;
}
export function validateLevel(volumeDb) {
  if (!Number.isFinite(volumeDb) || volumeDb < MIN_VOLUME_DB || volumeDb > MAX_VOLUME_DB) {
    throw new Error(`Calculated volume is outside ${MIN_VOLUME_DB}…${MAX_VOLUME_DB} dB. Adjust the reference volume or trim.`);
  }
}
