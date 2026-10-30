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

- **A**: polls/s per 1-s window (pass: 1st percentile ≥ 200 Hz). **Missed input is detected
  objectively** (probe v0.1.1) with XInput's `dwPacketNumber`, which changes whenever the
  controller's state changes: a jump of more than one between consecutive observed changes means
  states we never polled (`PacketTracker` in `probe.rs`, reset on disconnect, wrap-safe). Every gap is
  logged with its step (taps, sweep, triggers, chords, soak); pass = no gaps while tapping and every
  A press has a release, plus a separate "no gaps in any step" verdict. The tester's own press count
  is kept only as a cross-check. Caveat: XInput documents only that the number changes on a state
  change, not that it steps by exactly one; if a pad reports faster than we poll, gaps would also
  appear at rest, which the per-step breakdown (soak vs taps) shows. Also: percentage of 1-s
  samples with Resolve's main window in front (≥ 95 %), a buzz check at the start, recorded frames
  per stage as `*.frames.json`.
- **B**: 100 × (4 arrow taps + `Ctrl+B`) per spacing 30/16/8/0 ms on a Solid Color generator,
  counted as new Edit Index events (arrow taps only move the playhead so each split lands on a new
  frame); 900 arrow taps at 30 Hz measured by timecode; 300 taps with the extended flag forced off
  (expected to fail); K+L / J+K holds; Resolve's elevation and Steam detected; optional elevated run.
- **C**: three marked points, the other five derived; seven drags (press off-puck without moving,
  slow/fast drags from the centre, a drag starting off-puck, master dial horizontal/vertical, offset),
  with the YRGB values the tester reads after each; each drag undone with `Ctrl+Z` on a fresh node.

## Host (Phase 3)

`apps/desktop/src/main/`. One `Host` owns the engine state and drives it from pad frames plus an 8 ms
tick (and the engine's `wakeAt`).

- **Pad sources** (`pad.ts`): `XInputSource` on Windows (the addon's pad thread), `GamepadSource` on
  macOS (a hidden renderer polling the Gamepad API, every message zod-validated), `ReplaySource` for
  the e2e driver.
- **Gate** (`gate.ts`): open only when the frontmost app matches the profile's `appMatch` (case
  insensitive), is not Jogstick itself, and is not a dialog, elevated, or transient. Reasons are shown
  in the tray and overlay (`PAUSED · DIALOG`, `BLOCKED · ADMIN`). Every close runs `releaseAll`.
- **Output queue** (`queue.ts`): every injected event goes through one serialized queue. Combos with
  extra modifiers go out as mods → wait `comboSpacingMs` → key down/up → wait → base mods; plain keys
  have no spacing. With the gate closed, presses are dropped and releases still go out; a key-up whose
  key-down was never sent is dropped.
- **Keymap** (`engine/keymap.ts`): `resolveCommand` picks the user override, then the shipped default;
  an unbound command logs once and sends nothing.
- **Store** (`store.ts`): the JSON files and hot reload of Remapping (c).
- **Release everywhere:** gate close, pad disconnect, config reload, pause, sleep/lock/shutdown,
  `uncaughtException` all call the addon's `releaseAll`; `releaseLeftovers` runs at start-up.
- **Tray** (`tray.ts`), **overlay** (`overlay.ts`: a click-through label on Resolve's display),
  Steam and elevated-Resolve warnings, **Export Console log…**.
- **Export test report** (`report.ts`): one click writes `jogstick-report-<date>.zip` beside the app
  (Downloads, then Desktop, if that folder isn't writable) and says where: the Console, versions,
  displays, Resolve process/front state, controller, active profile + overrides + settings, unbound
  commands, and gate events and warnings/errors since start-up (kept apart from the Console's 2000
  lines). Built from Jogstick's own state only (app ids, never window titles); every profile
  folder (`C:\Users\<x>`, 8.3 short names, `/Users/<x>`) and the user name are redacted; never
  overwrites; no network. The zip writer is ~60 lines on `node:zlib` (no dependency).
- **Native module fails to load** (a missing/blocked/wrong-arch `.node`): Jogstick can't run, but
  never quits silently. It writes a reduced report (the exact error and code, the native folder's
  file listing, versions, OS, the Console so far) to the same folders, shows the error and the
  report's path with "please send that .zip", then exits 1. The e2e covers it with a junk `.node`.
- **Test with harness** (tray checkbox, off at every launch): the gate also accepts
  `jogstick-harness`, so a real controller can drive it on a machine without Resolve; the overlay
  echoes each command and the keys it resolves to (`TEST · edit.splitClip · Cmd+B`; a press the gate
  drops in a race shows as `dropped` in the Console). Refused while Resolve is in front (the tray
  menu's own foreground doesn't count), and switched off with a notification the moment Resolve
  comes to the front. A switch from one accepted app to another (harness → Resolve) is a gate
  close + releaseAll + re-open. Any app with the harness's id is accepted while it is on.
- **e2e** (`pnpm e2e`, `scripts/e2e.ts`): runs the built host with a replayed pad script against
  `jogstick-harness` (gate pointed at the harness) and checks every key the harness saw, a hot
  reload, and that nothing is held at the end. Runs in CI on Windows.
- **Packaging** (`pnpm package:app`): copies Electron's distribution and fills `resources/` (app,
  native addon, tray icons); no packager dependency. `app.yml` builds the Windows zip on `v*` tags.

**Decision (Phase 3): a transient frontmost window closes the gate.** The brief let transient windows
(tooltips, popovers, menus) keep the gate open. Phase 3 closes it instead (`reason: 'transient'`):
keys sent while a Resolve menu or popover has focus land in that menu, not the timeline, and the
cost is only a short pause. Revisit if the friend's rc1 report shows the pad pausing during normal
editing.

## Remapping (first-class)

Two independent layers, so a user can change either without touching the other:

```
pad control ──(a) profile binding──► action ──(if "command")──► command id ──(b) keymap──► key combo ──► output queue
```

### (a) Pad control → action

- **What can be bound:** any input id (the 17 buttons `a` … `guide`, plus `lstick`, `lstick.x`,
  `lstick.y`, `rstick`, `rstick.x`, `rstick.y`; see `INPUT_IDS` in `schema.ts`), and chords (the profile's
  `chords` list and `modeSwitch`), each **per mode** (`edit`, `color`) and **per layer** (`trim`,
  `mark`, `alt`, or base), with an optional `gesture` (`tap`, `hold`, `doubleTap`).
- **What it can do:** `command` (a Resolve command id, resolved through (b)), `key` (a raw combo),
  `mouseButton` / `mouseMove` / `scroll`, `keySeq` (a cancellable macro), `jog` / `shuttle` / `wheel`
  (analog), `modeSet` / `layerToggle`, or `none`. `none` means explicitly unbound; leaving a binding
  out instead falls through to the base layer.
- **How it resolves:** at press time (semantics 4): mode + the most recently activated layer, then
  base. The release always dispatches what the press resolved.
- **Status:** schema and engine done (Phase 2). **Mapping screen with learn mode: Phase 4.** The
  learn state machine is `idle → waiting → captured | timedOut | cancelled`: press (or click) a pad
  control, then pick a command from a searchable list (labels from the keymap), record a raw combo
  (renderer `keydown`, `code` + modifiers, cross-checked against the addon's keymap), or choose a
  mouse action, macro or nothing. Esc cancels. The generated JSON is shown. A binding that collides
  with an existing one (same mode + layer + input + gesture) is flagged and replaces it only after
  confirmation. The editor window never counts as a gate match, so learning never fires shortcuts.

### (b) Command → keys

- **Resolver (Phase 3):** `user override[os] → shipped default[os] → unbound`. Unbound commands
  (today: `edit.pasteInsert`, `color.prevNode`, `color.nextNode`) appear on the Setup checklist; a
  pad control bound to one does nothing and logs `command <id> has no shortcut` to the Console.
- **Commands screen (Phase 4):** every command with its label, shipped default, user override and
  `verified` badge; set or clear an override with the same key recorder as learn mode. This is for
  people who changed Resolve's shortcuts.
- **Import an exported Resolve preset:** once the friend's exported file shows the format (Phase 0
  step 4), write a parser that turns it into overrides for the commands Jogstick knows (Phase 4).
  The same parser powers the `verified` check. Jogstick never edits Resolve's own files.

### (c) Before the UI exists: JSON files (Phase 3)

The app's user data folder (`app.getPath('userData')`):

- Windows: `%APPDATA%\Jogstick\`
- macOS: `~/Library/Application Support/Jogstick/`

```
<userData>/
  settings.json              { "activeProfile": "my-resolve" }
  profiles/my-resolve.json   a full profile: a copy of resolve-default with a new id
  keymap-overrides.json      { "<command id>": { "win32": "<combo>", "darwin": "<combo>" } }
```

- **Hot reload:** the host watches `<userData>` (debounced 200 ms). On save it parses the file and
  validates it with zod (`ProfileSchema`, `KeymapOverridesSchema`, `HostSettingsSchema`), then runs
  semantic checks: unknown command ids, layers referenced but not defined, combos the addon can't map.
  - **Valid:** `releaseAll`, swap in the new profile/keymap atomically, Console logs `reloaded <file>`.
  - **Invalid:** Console logs the file, the zod path and the message; **the last good version stays
    active**. Nothing is ever applied partially.
- **Example: swap X and B in Edit mode.** In `profiles/my-resolve.json` (a copy of
  `resolve-default.json` with `"id": "my-resolve"` and `"name": "My Resolve"`), change the two base
  bindings:

  ```jsonc
  { "mode": "edit", "input": "x", "action": { "type": "command", "id": "edit.paste" } },
  { "mode": "edit", "input": "b", "action": { "type": "command", "id": "edit.cut" } },
  ```

  Then set `"activeProfile": "my-resolve"` in `settings.json`. To give Paste insert a key you bound in
  Resolve, put this in `keymap-overrides.json`:

  ```json
  { "edit.pasteInsert": { "win32": "F13", "darwin": "F13" } }
  ```

### (d) Profiles

- **Shipped profiles are read-only.** They load from the app's resources and are never written.
  Editing a shipped profile in the UI first makes a copy ("DaVinci Resolve (my copy)") and activates
  it; user changes always go in a copy. (Phase 3 for the file rules; Phase 4 for the screen.)
- **Duplicate** (new id), **export** (one `.json`, optionally with the keymap overrides it relies on),
  **import** (validated exactly like (c); an id collision gets a new id), **reset to default**
  (switches back to the shipped profile; the user copy stays until deleted; resetting the keymap
  clears `keymap-overrides.json`). Profiles screen: Phase 4.
- When an app update changes a shipped profile, user copies aren't touched. The Profiles screen
  notes "based on resolve-default; the shipped version has changed" (Phase 4).
