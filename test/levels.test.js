import test from 'node:test';
import assert from 'node:assert/strict';
import { targetVolume, effectiveLevel, safeSwitchVolume } from '../src/levels.js';

test('pre-gain is offset by device volume', () => {
  const b = { peq: true, preampDb: -10.2, gain: 'low', trimDb: 0 };
  assert.equal(targetVolume(-35, b), -25);
  assert.equal(effectiveLevel(-25, b), -35.2);
});

test('high gain is offset by 14 dB', () => {
  const b = { peq: false, preampDb: 0, gain: 'high', trimDb: 0 };
  assert.equal(targetVolume(-35, b), -49);
  assert.equal(effectiveLevel(-49, b), -35);
});

test('switch volume stays below both endpoints through gain change', () => {
  const low = { peq: false, preampDb: 0, gain: 'low', trimDb: 0 };
  const high = { peq: false, preampDb: 0, gain: 'high', trimDb: 0 };
  const dip = safeSwitchVolume(-35, low, -49, high);
  assert.equal(dip, -49);
  assert.ok(effectiveLevel(dip, high) <= -35);
});

test('attenuation covers gain-first intermediate states, not just endpoints', () => {
  const from = { peq: false, preampDb: 0, gain: 'low', trimDb: 0 };
  const to = { peq: true, preampDb: -20, gain: 'high', trimDb: 0 };
  const dip = safeSwitchVolume(-35, from, -29, to);
  assert.equal(dip, -49);
  assert.equal(effectiveLevel(dip, { ...from, gain: 'high' }), -35);
});

test('unreachable quiet intermediate state is rejected rather than clamped louder', () => {
  const from = { peq: false, preampDb: 0, gain: 'low', trimDb: 0 };
  const to = { peq: true, preampDb: -20, gain: 'high', trimDb: 0 };
  assert.throws(() => safeSwitchVolume(-95, from, -89, to), /mute/);
});

test('invalid numeric inputs and settings cannot become volume commands', () => {
  const c = { peq: false, preampDb: 0, gain: 'low', trimDb: 0 };
  for (const ref of [NaN, Infinity, -100, 1]) assert.throws(() => targetVolume(ref, c));
  for (const step of [0, -1, NaN, 0.1]) assert.throws(() => targetVolume(-35, c, step));
  for (const bad of [{ preampDb: NaN }, { preampDb: -41 }, { trimDb: 13 }, { gain: 'unknown' }]) {
    assert.throws(() => targetVolume(-35, { ...c, ...bad }));
  }
  assert.throws(() => targetVolume(-0.1, { ...c, peq: true, preampDb: -0.2 }));
});

test('every intermediate state stays below both endpoint levels', () => {
  const states = [];
  for (const gain of ['low', 'high']) for (const peq of [false, true]) {
    for (const preampDb of [-40, -10.2, 0, 10]) states.push({ gain, peq, preampDb, trimDb: 0 });
  }
  for (const from of states) for (const to of states) {
    const a = targetVolume(-50, from), b = targetVolume(-50, to);
    const dip = safeSwitchVolume(a, from, b, to);
    const ceiling = Math.min(effectiveLevel(a, from), effectiveLevel(b, to));
    for (const c of [from, { ...from, gain: to.gain }, to]) {
      assert.ok(effectiveLevel(dip, c) <= ceiling + 1e-9);
    }
  }
});
