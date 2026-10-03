import { targetVolume, effectiveLevel } from './levels.js?v=hardware-8';
import { inspectDx1, DemoDevice } from './device.js?v=hardware-8';
import { ComparisonController } from './controller.js?v=hardware-8';
import { requestDx1Diagnostics } from './dx1-diagnostics.js?v=hardware-8';
import { Dx1Transport, selectDx1 } from './dx1-transport.js?v=hardware-8';
import { Dx1Controller } from './dx1-controller.js?v=hardware-8';

const $ = selector => document.querySelector(selector);
let controller = new ComparisonController(new DemoDevice());
let inspecting = false;
let hardwareReport = null;
const step = () => $('#step').value === 'dx1' ? 'dx1' : Number($('#step').value);
function card(side) { return document.querySelector(`[data-side="${side}"]`); }
function condition(side) {
  const el = card(side);
  return { peq: el.querySelector('.peq').value === 'on',
    preampDb: el.querySelector('.preamp').valueAsNumber,
    gain: el.querySelector('.gain').value,
    trimDb: el.querySelector('.trim').valueAsNumber };
}
function volume(side) {
  return targetVolume($('#reference').valueAsNumber, condition(side), step());
}
function matches(side) {
  const applied = controller.applied;
  return applied?.side === side && applied.volumeDb === volume(side)
    && JSON.stringify(applied.condition) === JSON.stringify(condition(side));
}
function render() {
  const locked = controller.busy || inspecting;
  const webHidAvailable = Boolean(navigator.hid);
  document.querySelectorAll('input, select, button').forEach(el => { el.disabled = locked; });
  $('#download-report').disabled = locked || !hardwareReport;
  const hardware = Boolean(controller.hardware);
  $('#connection').textContent = hardware ? (controller.failure ? 'Hardware stopped · reconnect required' : 'DX1 II connected · live controls') : 'Simulation only · no audio changes';
  $('#connect-hardware').disabled = locked || hardware || !webHidAvailable;
  $('#read-hardware').disabled = locked || hardware || !webHidAvailable;
  $('#connect').disabled = locked || hardware || !webHidAvailable;
  $('#step').disabled = locked || hardware;
  $('#demo').textContent = hardware ? 'Disconnect hardware' : 'Reset simulation';
  document.querySelectorAll('.preamp').forEach(el => { el.disabled = locked || hardware; });
  document.querySelectorAll('.gain').forEach(el => {
    el.disabled = locked || hardware;
    el.querySelector('[value="low"]').textContent = hardware ? 'Unchanged (not read)' : 'Low';
  });
  $('#reference-help').textContent = hardware
    ? 'PEQ-off equivalent at your current gain; initialized from the DAC'
    : 'Set this to your comfortable low-gain, PEQ-off device volume';
  $('#hardware-state').textContent = hardware && controller.state
    ? `${controller.preset.name || 'Stored preset'} (EQ${controller.presetIndex + 1}) · pre-gain ${controller.preampDb} dB · last read ${controller.state.volumeDb} dB / gain unchanged / PEQ ${controller.state.peq ? 'on' : 'off'}`
    : webHidAvailable
      ? 'Live control switches PEQ only. Gain is never read or changed; gain comparison remains available in simulation.'
      : 'WebHID is unavailable in this browser. Simulation still works; live controls require a desktop browser with WebHID support.';
  for (const side of ['a', 'b']) {
    const el = card(side);
    const target = el.querySelector('.target');
    let valid = true;
    let selected = false;
    try {
      const value = volume(side);
      target.textContent = `${value.toFixed(1).replace('-', '−')} dB`;
      selected = Boolean(matches(side));
      const error = effectiveLevel(value, condition(side)) - ($('#reference').valueAsNumber + condition(side).trimDb);
      el.querySelector('.rounding').textContent = `Rounding difference: ${error > 0 ? '+' : ''}${error.toFixed(2)} dB`;
    } catch (error) {
      valid = false;
      target.textContent = 'Unavailable';
      el.querySelector('.rounding').textContent = error.message;
    }
    target.classList.toggle('invalid', !valid);
    el.classList.toggle('active', selected);
    el.querySelector('.choose').disabled = locked || !valid || Boolean(controller.failure);
    el.querySelector('.choose').textContent = `${hardware ? 'Apply' : 'Simulate'} ${side.toUpperCase()}`;
    el.querySelector('.choose').setAttribute('aria-pressed', String(selected));
  }
}
function message(title, detail) {
  $('#message').textContent = title;
  $('#detail').textContent = detail;
}
async function choose(side) {
  if (controller.busy || inspecting) return;
  try {
    const operation = controller.apply(side, condition(side), volume(side), step());
    render();
    if (controller.hardware) message(`Applying ${side.toUpperCase()}…`, 'Reading device state and verifying each hardware change.');
    const result = await operation;
    message(`${controller.hardware ? 'Applied' : 'Simulated'} ${side.toUpperCase()} at ${result.volumeDb.toFixed(1)} dB`,
      `PEQ ${result.condition.peq ? 'on' : 'off'} · ${controller.hardware ? 'gain unchanged' : `${result.condition.gain} gain`}. ${controller.hardware
        ? `Hardware readback verified in ${result.durationMs} ms.` : 'No audio or device settings are changed.'}`);
  } catch (error) {
    message('Comparison not completed', `${error.message} ${controller.hardware
      ? 'Volume is not automatically restored after a failure. Check the DAC, then disconnect and reconnect.'
      : 'No successful state is assumed after an incomplete switch.'}`);
  } finally { render(); }
}
$('#connect').addEventListener('click', async () => {
  if (controller.busy || inspecting) return;
  inspecting = true;
  render();
  try {
    const info = await inspectDx1();
    if (!info) return;
    $('#diagnostics').hidden = false;
    $('#descriptor').textContent = JSON.stringify(info, null, 2);
    message('DX1 II descriptor inspected',
      'The device was not opened and no commands were sent. Use Connect hardware controls for tested firmware 0x0307, or stay in simulation.');
  } catch (error) { message('Could not inspect DX1 II', error.message); }
  finally { inspecting = false; render(); }
});
$('#demo').addEventListener('click', async () => {
  if (controller.busy || inspecting) return;
  inspecting = true; render();
  try {
    if (controller.hardware) await controller.close();
    controller = new ComparisonController(new DemoDevice());
    message('Simulation ready', 'The hardware connection is closed. Any applied DAC settings remain as they are.');
  } catch (error) { message('Could not close hardware session', error.message); }
  finally { inspecting = false; render(); }
});
$('#connect-hardware').addEventListener('click', async () => {
  if (controller.busy || inspecting || controller.hardware) return;
  inspecting = true; render();
  message('Connecting to DX1 II…', 'Reading firmware, output routing and stored PEQ pre-gain. No audio settings are being written.');
  try {
    const device = await selectDx1();
    if (!device) { message('Device selection cancelled', 'Simulation remains active.'); return; }
    const candidate = new Dx1Controller(new Dx1Transport(device));
    try {
      const state = await candidate.connect();
      controller = candidate;
      controller.onChange = reason => {
        if (controller.failure) message('Hardware session stopped', `${controller.failure.message} Disconnect and reconnect before continuing.`);
        else if (reason === 'changed') message('DAC settings changed', 'The previous A/B selection is no longer confirmed. The next switch will read the current device state.');
        render();
      };
      $('#step').value = 'dx1';
      $('#reference').value = Math.min(0, effectiveLevel(state.volumeDb, state)).toFixed(2);
      for (const side of ['a', 'b']) {
        card(side).querySelector('.preamp').value = controller.preampDb;
        card(side).querySelector('.gain').value = state.gain;
        card(side).querySelector('.trim').value = '0';
      }
      card('a').querySelector('.peq').value = 'off';
      card('b').querySelector('.peq').value = 'on';
      hardwareReport = { format: 'dx1-controller-session-v1', firmwareRaw: controller.firmwareRaw,
        presetIndex: controller.presetIndex, preset: controller.preset, initialState: state,
        records: controller.transport.records };
      $('#hardware-report').textContent = JSON.stringify(hardwareReport, null, 2);
      message('DX1 II connected — PEQ A/B ready', 'A is PEQ off; B uses the stored preset. Gain is locked and untouched. Apply A or B changes volume and PEQ only.');
    } catch (error) {
      hardwareReport = { format: 'dx1-controller-session-v1', error: error.message, records: candidate.transport.records };
      $('#hardware-report').textContent = JSON.stringify(hardwareReport, null, 2);
      throw error;
    }
  } catch (error) { message('Could not connect hardware controls', error.message); }
  finally { inspecting = false; render(); }
});
$('#read-hardware').addEventListener('click', async () => {
  if (controller.busy || inspecting) return;
  inspecting = true;
  hardwareReport = null;
  $('#hardware-report').textContent = '';
  render();
  try {
    hardwareReport = await requestDx1Diagnostics({ onProgress: text => {
      message(text, 'Reading device state. A/B remains a simulation.');
    } });
    if (!hardwareReport) {
      message('Device selection cancelled', 'No diagnostic connection was opened.');
      return;
    }
    $('#hardware-report').textContent = JSON.stringify(hardwareReport, null, 2);
    const failed = Object.entries(hardwareReport.reads).find(([, result]) => result.status !== 'received');
    message(failed ? `Hardware read stopped: ${failed[0]} (${failed[1].status})`
      : `Hardware read complete: ${hardwareReport.summary.protocol} firmware protocol`,
    'Download the diagnostic JSON and share it in this task. No audio settings were written. A/B remains simulated.');
  } catch (error) { message('Hardware read failed', error.message); }
  finally { inspecting = false; render(); }
});
$('#download-report').addEventListener('click', () => {
  if (!hardwareReport) return;
  if (controller.hardware) {
    hardwareReport.currentState = controller.state;
    hardwareReport.applied = controller.applied;
    hardwareReport.error = controller.failure?.message ?? null;
  }
  $('#hardware-report').textContent = JSON.stringify(hardwareReport, null, 2);
  const url = URL.createObjectURL(new Blob([JSON.stringify(hardwareReport, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = 'dx1-diagnostics.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
document.querySelectorAll('input, select').forEach(el => el.addEventListener('input', () => {
  if (controller.applied) message('Comparison settings edited', `The last ${controller.hardware ? 'hardware' : 'simulated'} state is retained. Press A or B to apply the edited settings.`);
  render();
}));
document.querySelectorAll('.choose').forEach(el => el.addEventListener('click', () => choose(el.dataset.target)));
document.addEventListener('keydown', event => {
  if (event.code !== 'Space' || event.repeat || event.altKey || event.ctrlKey || event.metaKey
      || document.activeElement.closest('input, select, textarea, button, summary, a, [contenteditable]')) return;
  event.preventDefault();
  choose(controller.applied?.side === 'a' ? 'b' : 'a');
});
render();
