# DX1 II protocol research — 2026-09-27

Initial findings came from the public Topping Home web v1.14.0 application; subsequent user diagnostics and direct hardware readbacks verified the Next 0x0307 path described below. No vendor implementation was imported or executed. The project's codec is independently written; numeric wire constants and message layouts are interoperability facts.

Sources downloaded from https://home.toppingaudio.com/peq:

- [Transport and command definitions](https://home.toppingaudio.com/_next/static/chunks/86bfa3320274f028.js), SHA-256 `b22ff86cc07ca02c615b6a1ad8e33465a7a92a808714880eb3b5385867b8384b`.
- [DX1 state, volume and firmware variants](https://home.toppingaudio.com/_next/static/chunks/6092f6fde85568a5.js), SHA-256 `0dd7203a36d4332fba9a28fdc8351db9100283122b94d149b3a697146d652ad2`.

The downloaded bundles are research scratch files in `/tmp/dx1-vendor`, not redistributed project dependencies. They may disappear; the URLs and hashes identify the source version.

## Framing

For the DX1 II's VID 0x152a / PID 0x8750, the vendor selects its legacy-8750 transport profile, excluding other named models that share that PID. WebHID report ID is 0. Its 16-byte payload is:

```
22 33 TYPE COUNT INDEX CMD_H CMD_L VALUE_3 VALUE_2 VALUE_1 VALUE_0 CRC_H CRC_L 66 77 00
```

Command and value are big endian. Single requests use count 1/index 1. Vendor default requests have zero CRC bytes. The vendor parser also accepts an incoming leading-zero report-prefix layout. Our diagnostic parser preserves raw incoming packets, accepts both layouts, and validates incoming CRC16 (Modbus polynomial 0xa001, initial 0xffff, nine TYPE-through-value bytes, stored big endian). Read requests use type 0x10. Vendor response handling accepts 0x10, 0x11, 0x1f and 0x20; an outgoing write acknowledgment alone is not readback.

## DX1-specific facts

| Field | Command | Meaning |
| --- | --- | --- |
| Firmware | 0x1202 | Preserve raw until actual firmware response is available |
| Home capability | 0x8107 | 64 unsupported home controls; 128 legacy; 192 next |
| Device state | 0x7100 | Working/standby/menu/save etc.; not merely a boolean |
| Headphone gain | 0x7500 | 0 low, 1 high |
| Legacy HP volume | 0x7601 | raw = (dB + 99) × 10 |
| Legacy LO / combined volume | 0x7602 / 0x7603 | Separate targets; not used by diagnostics |
| Legacy output route | 0x7400 | 0 HP, 1 LO, 2 combined in vendor state model |
| Legacy mute | 0x7200 | 0 unmuted, 1 muted |
| PEQ enabled | 0x1204 | bit 0 runtime active; bit 2 logical-state valid; if valid, bit 1 logical enabled |
| Current preset | 0x1206 | Raw retained; bootstrap and firmware-dependent interpretation needs verification |
| Next output snapshot | 0x810a | 12 frames, indices 1–12; includes output mask, fixed output, volume linkage, routing, four volumes and mute |

Volume range is -99…0 dB in the vendor app. Its quantizer uses whole dB at/below -10 dB, then half dB above -10. This replaces the earlier assumption that every volume supports 0.5 dB increments. Generic steps remain explicitly labeled simulation options.

PEQ bypass is not a preamp rewrite: the vendor uses preset-switch command 0x110e with all-ones value to bypass and a firmware-mapped preset index to enable. Preamp values are stored in preset data, with separate channel enable state and a coefficient lookup. Reading PEQ enable alone does not establish the preamp or guarantee PEQ acts on the headphone route. The next firmware adds output/PEQ routing state; legacy and next cannot be treated as interchangeable.

The vendor's normal legacy connection announces 0x1101=1, then 0x1120=1, and starts 0x111a heartbeats. Those are writes, so our diagnostic session deliberately does not send them. Some units may therefore time out on direct reads. This is an unresolved compatibility question, not evidence of failure. Do not silently add this handshake or a volume writer merely to make a timeout disappear.

## Verified hardware implementation — 2026-09-28

The user's capture establishes firmware raw 775 (0x0307), capability 192, headphone mask 2, analog/both PEQ routing, variable unlinked volume. Direct reads work without handshake or heartbeat. Other firmware variants remain unsupported by the controller.

Next headphone volume writes use type 0x20, command 0x810a, count 12, index 3, raw=(dB+99)*10. Gain writes use 0x7500, value 0/1. PEQ bypass uses 0x110e=0xffffffff; enabling the existing preset uses 0x1206 with its zero-based index. No DSP coefficient, route, mute or preset-content writes are exposed.

Actual volume writes can return a full type **0x21** output snapshot. The transport now accepts the matching field as write acknowledgment, then performs the required independent readback. Type 0x21 cannot satisfy an explicit read request. Acknowledgment alone does not establish application.

Preset command 0x1106 returns two metadata words (indices 0/1), followed by ordered 78-word presets on this device. First four words contain the name in little-endian character order. Words 4/5 and 6/7 contain left/right preamp enable and Q25 amplitude coefficient; gain is 20 log10(coefficient / 0x2000000). User's EQ2 index 1 has coefficient 10369292 on both channels, approximately -10.2 dB. The collector also supports the source-derived 74-word shape, not yet verified on this DAC.

Hardware testing established that a type `0x10` request for gain command `0x7500` is not a safe read on Next firmware `0x0307`: after high gain was acknowledged, sending this request produced low-gain responses and the DAC subsequently read back low. The public vendor Next implementation likewise excludes gain from its explicit read allowlist. Production `buildReadRequest(0x7500)` now throws, diagnostics skip gain, and live mode rejects gain changes before any write. Live PEQ matching remains valid because gain is left unchanged and cancels from the relative endpoint calculation.

A short hardware probe sent the vendor connection (`0x1101=1`) and agreement (`0x1120=1`) announcements. It received firmware, PEQ and partial preset data but no gain frame before closing after approximately 1.44 seconds. This is inconclusive: the preset stream alone takes roughly four seconds. It does not prove that a complete vendor bootstrap cannot supply gain. Gain querying remains unverified and blocked.

The production controller snapshots route, mute, volume, PEQ logical/runtime state, preset index and temporary preview state. It verifies attenuation before PEQ changes, PEQ/preset before raising volume, and final output/PEQ/preset afterward. It never sends command `0x7500` in hardware mode. Any incoming gain event stops the session, including while idle or reading preflight state; comparing that event against the nominal low-gain calculation value would be incorrect.

With other controllers closed, the final PEQ-only build completed PEQ off in 1328 ms and PEQ on in 1334 ms. The DAC was restored and read back at -20 dB, PEQ on, with gain untouched. Unit tests cover ignored/mismatched acknowledgments, unsafe intermediate conditions, transport errors, disconnects and batch correlation, but do not replace hardware evidence.
