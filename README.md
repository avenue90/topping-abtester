# DX1 II level-matched A/B controller

Local DX1 II level-matching app with simulation, live PEQ-only switching, and read-only WebHID diagnostics. Hardware PEQ switching is validated on Next firmware `0x0307`. Gain comparison remains simulation-only because `0x7500` is not a safe gain read on this firmware.

## Run

Run `npm start`, then open **http://127.0.0.1:8000/** in a browser with WebHID support. Do not open `index.html` as a `file://` URL; browser module restrictions prevent it from working. No dependencies need installing. Run `npm test` for regression checks.

The app starts in simulation. **Connect hardware controls** enables PEQ on/off comparison with automatic volume compensation. Hardware mode locks gain and never reads or changes it. **Read DX1 II state** also skips the unsafe gain request.

## Publish with GitHub Pages

This is a static site with no backend or runtime dependencies. `npm run build` copies only `index.html`, `style.css` and `src/` into `public/`. The workflow in `.github/workflows/pages.yml` tests the app, builds that folder, and deploys it when `main` is pushed. It does not deploy the diagnostic fixture, research notes or handoff file. The handoff file and generated `public/` folder are excluded from Git.

Create a **public** GitHub repository, push this project's `main` branch to it, then select **Settings → Pages → Build and deployment → Source: GitHub Actions**. The site URL will be `https://YOUR-USERNAME.github.io/YOUR-REPOSITORY/`. You can share that URL directly on Reddit. The site needs HTTPS for WebHID, which GitHub Pages provides. Actual device access also requires a browser with WebHID support, a connected DX1 II, and the user's explicit device selection. WebHID is not available in every browser. No device information is uploaded by this application; diagnostic JSON downloads stay on the visitor's computer until they choose to share them.

If you only want to publish the current static site without exposing the source repository, GitHub Pages can publish from a private repository on some paid plans, but the website itself is still public. The project currently has no open-source license; publishing the repository does not grant others permission to reuse its code.

Space toggles A/B in simulation when focus is outside a control. For a gain comparison, set both cards to the same PEQ state, with one on low gain and the other high.

## Matching and switching

Target volume = reference − active PEQ pre-gain − high-gain offset + listening trim. The nominal gain offset is 14 dB. DX1 II uses 1 dB volume steps through −10 dB, then 0.5 dB steps above −10 dB. Rounding error is displayed.

This matches the unboosted parts of the signal, not perceived loudness after an EQ change. Listening trim is manual. The hardware adapter never rewrites PEQ coefficients, clipping-prevention pre-gain, routing, firmware or saved settings.

The hardware controller verifies attenuation before PEQ changes, PEQ/preset before restoring volume, and volume/PEQ/preset at completion. Gain commands are excluded from both request builders. Any incoming gain activity stops the session and requires reconnecting because the original gain is unknown. Keep gain unchanged throughout a comparison.

Timeouts, disconnects, configuration activity and mismatched readback stop the session. A failure never triggers a blind restoration to a louder volume. Check the DAC and reconnect before continuing. Keep other controllers closed and avoid the physical knob while switching: WebHID does not provide an atomic multi-command transaction or guaranteed exclusion of other controllers.

Stored preset data is read once per connection for faster switching. Incoming PEQ configuration activity invalidates it; reconnect after editing a preset elsewhere. Silent external changes cannot be ruled out by the browser.

## Diagnostics and verification

**Read DX1 II state** is a separate short session that sends only read requests and closes afterward. **Download diagnostic JSON** exports the diagnostic or connected-controller transcript.

The user-provided firmware/state capture is in `test/fixtures/dx1-next-0307.json`. Physical-device PEQ off/on and volume compensation were exercised successfully. The latest test identified the unsafe gain-read behavior and restored the DAC to its original state. Tests additionally simulate failed writes, false echoes, CRC corruption, unexpected state changes, interleaved responses and disconnects. Current measured results and remaining work are in `HANDOFF.md`.

Protocol provenance and wire details: [docs/PROTOCOL.md](docs/PROTOCOL.md). The implementation uses no third-party runtime dependencies.

## References

- [Official DX1 II manual](https://dl.topping.audio/marketing/DX1_II_V1.0_EN.pdf): nominal headphone gain and output behavior.
- [Topping Home](https://home.toppingaudio.com/peq): vendor protocol source; bundle URLs/hashes are recorded in the protocol notes.
