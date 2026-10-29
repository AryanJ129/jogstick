# Jogstick architecture

Stub as of Phase 0. `BUILD_BRIEF.md` is the spec; this file records what was actually built, the
numbers from the spikes, and the decisions they forced. Update it in the same PR as any decision.

## Layout

- `packages/engine`: pure TypeScript state machine (`step(state, input, now) → {state, commands}`).
  The step machinery has zero runtime dependencies and no timers; `zod` is confined to `schema.ts`
  (profile and keymap validation at load).
- `packages/native`: one Rust crate (napi-rs v3) building three things:
  - the Node addon (`--features addon`), loaded by the desktop app;
  - `jogstick-probe` (Windows): guided spikes A–C for a tester, writes `jogstick-probe-results/report.json`;
  - `jogstick-harness` (`--features harness`, winit): a window that logs every key/mouse event, with a
    `--self-test` that drives it through our injector.
- `packages/profiles`: `resolve-default.json`, `resolve-keymap.json`.
- `apps/desktop`: Electron 45.1.0 shell (electron-vite). The preload is built as CommonJS because
  sandboxed preloads can't be ES modules.

## Injection (implemented in Phase 0, used by the probe and harness)

- `injector.rs` tracks held buttons/keys/modifiers; `release_all` releases mouse buttons → keys → modifiers.
- Windows (`inject_win.rs`): `SendInput` with virtual key + scan code from the foreground window's
  layout; `KEYEVENTF_EXTENDEDKEY` for arrows/Home/End/PgUp/PgDn/Ins/Del; absolute moves in
  virtual-desktop coordinates; every event's `dwExtraInfo` = `0x4A4F4753` ("JOGS").
- macOS (`inject_mac.rs`): one `HIDSystemState` source, posted at the HID tap, flags always written in
  full (arrows carry NumericPad|SecondaryFn, nav/F-keys SecondaryFn), modifiers as `flagsChanged`
  with the resulting set, `*MouseDragged` while a button is held with one event number per drag,
  `eventSourceUserData` tag.

## Pad input

- Windows (`pad_win.rs`): XInput on a dedicated thread paced by a high-resolution waitable timer
  (falls back to `sleep` if unavailable; the probe reports which). Frames are converted to the W3C
  standard layout (`pad.rs`, +Y down).
- The browser Gamepad API is not used on Windows (Windows.Gaming.Input stops delivering when another
  app has focus). Do not "simplify" back to it; see the brief's findings.

## macOS dev signing

`scripts/dev-sign-mac.sh create-cert` made a self-signed "Jogstick Dev" code-signing identity
(login keychain, trusted for code signing only). Signed binaries get a designated requirement of
`identifier <id> and certificate leaf = H"1b4b…3459"`, which is stable across rebuilds, so the
Accessibility grant survives. `scripts/harness-mac.sh` wraps the harness in `JogstickHarness.app`
(bundle id `dev.jogstick.harness`) so it gets its own Accessibility entry instead of the terminal's.

## Spike results

| Spike                             | Status                          | Numbers | Decision                         |
| --------------------------------- | ------------------------------- | ------- | -------------------------------- |
| A: pad input with Resolve focused | waiting for the tester's report | —       | —                                |
| B: keys reach Resolve             | waiting for the tester's report | —       | `comboSpacingMs` default         |
| C: drags on the wheels            | waiting for the tester's report | —       | relative vs puck-follow strategy |

How the probe measures them:

- **A**: polls/s per 1-s window (pass: 1st percentile ≥ 200 Hz), XInput packet-number changes and
  skips (informational: XInput doesn't promise one increment per change), A-press edges counted
  hidden vs the tester's own count, percentage of 1-s samples with Resolve's main window in front
  (≥ 95 %), recorded frames per stage as `*.frames.json`.
- **B**: 100 × (4 arrow taps + `Ctrl+B`) per spacing 30/16/8/0 ms on a Solid Color generator,
  counted as new Edit Index events (arrow taps only move the playhead so each split lands on a new
  frame); 900 arrow taps at 30 Hz measured by timecode; 300 taps with the extended flag forced off
  (expected to fail); K+L / J+K holds; Resolve's elevation and Steam detected; optional elevated run.
- **C**: three marked points, the other five derived; seven drags (press off-puck without moving,
  slow/fast drags from the centre, a drag starting off-puck, master dial horizontal/vertical, offset),
  with the YRGB values the tester reads after each; each drag undone with `Ctrl+Z` on a fresh node.
