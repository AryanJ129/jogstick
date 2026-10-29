# Jogstick: an Xbox controller that edits in DaVinci Resolve

*Build brief for Claude Code · written 2026-10-27, revised 2026-10-28 after an on-machine review · owner: Aryan (GitHub `AryanJ129`, personal account) · name: Jogstick*

## Context

We're building an open-source desktop app that turns a game controller into an editing surface for DaVinci Resolve. Buttons map to Resolve commands, mouse actions and macros; sticks and triggers become analog jog and shuttle; held bumpers become layers; a chord flips the pad between **Edit** and **Color** mode. In Color mode the sticks drive Resolve's own color wheels.

Why this is worth building when plenty of generic mappers exist (JoyToKey, reWASD, Steam Input, AntiMicroX, JoyMapKit, InputConfig, ControllerKeys, Conductor): none of them do deflection-proportional jog, trigger shuttle, Resolve-aware layers, or color wheels from a pad on the free edition. The engine is generic so anyone can map anything; the app is positioned, defaulted and tested as "the controller app for DaVinci Resolve", and the Resolve profile is the only profile that ships in v1.

**Hard constraint: Resolve 21.1 (Sept 2026) moved Python scripting to Studio.** Release notes: "We have moved the ability to script in Python to the Studio version" and "The Python API was being used to hack studio features into the free version." Lua still runs on Free 21.1 but sandboxed (no file I/O, no sockets, no `require`). Consequences, all baked in:
- **Edit mode is unaffected on every edition and version.** It's 100 % keystrokes and mouse events.
- **Color mode v1 drives Resolve's on-screen wheels with synthetic mouse drags** (calibrated once). No scripting, so no edition or version can block it. This is how MIDIGrade has worked since 2016. Spike C confirms how the wheels respond before we build on it.
- **A scripting "precision mode" (exact CDL values) is designed but shelved**: it only runs on Studio or Free ≤ 21.0.4, and nobody on the team has Studio. Its spec stays below for a future contributor; do not build it.

**Who it's for and where it gets tested**
- **The friend: the only machine with Resolve.** Windows, Resolve Free 21.1.1 (latest as of 2026-10-27), Xbox controller. Every Resolve-facing check runs on his PC, driven by the probe tools and release candidates in this brief, without Claude present.
- **Aryan: development machine, no Resolve.** MacBook Air M3, macOS 15.6.1. He is **not** installing Resolve. Development, unit tests and injection tests against our own harness happen here; Resolve verification happens on the friend's PC in batches.
- **Everyone else on GitHub.** The macOS build ships labelled **Preview** until someone verifies it with Resolve on a Mac.

Where it lives: **new public repo `github.com/AryanJ129/jogstick`, MIT licence, on Aryan's personal account.** Not under any Atman, STR or Arkynlabs org. The Mac's active `gh` account is a work account (BusinessSTR) used by another Claude session, so this repo is **pinned to AryanJ129 without switching the global account** (Phase −1).

Quality bar: "works" means the friend holds the pad, cuts a timeline, scrubs with the stick, grades a clip, and it feels good. A green test suite is not done.

## Tech stack (locked)

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Electron 45.1.0** (latest on 2026-10-28; pin exactly). Local Node 22.15 for tooling. | Cross-platform shell, web UI for the mapping editor, mature packaging. |
| Language | TypeScript 5.x, `strict: true`, ESM | |
| Build | `electron-vite` (main / preload / renderer), `electron-builder` (NSIS + portable `.exe` x64; `.dmg` + `.zip` **arm64 only**). `.npmrc`: `node-linker=hoisted` (electron-builder + pnpm needs it). | Resolve 21.1.1 requires macOS 15+ on Apple Silicon, so an Intel Mac build has no users. |
| Renderer | React 19 + Vite, Tailwind v4 consuming `brand/tokens.css`; components per `frontend-craft` | |
| Engine | `packages/engine`: pure TypeScript, **no Electron/Node imports, no timers**, deterministic state machine | Replayable tests from recorded and synthetic pad frames. |
| Native addon | `packages/native`: **our own napi-rs v3 addon** (Rust). macOS: `core-graphics` / `objc2` for CGEvent, NSWorkspace, AX. Windows: `windows` crate for `SendInput` (virtual key + scan code + extended-key flag), cursor, foreground window, **and XInput pad reading**. The same crate builds the `jogstick-probe` and `jogstick-harness` binaries. Prebuilt `.node` files are **CI artifacts bundled into the app** (`asarUnpack`), not published to npm. | No existing wrapper does what we need (see findings). |
| Controller read | **`PadSource` interface, one implementation per OS.** Windows: **XInput in the addon** on a dedicated Rust thread (high-resolution waitable timer, 250 Hz), frames pushed to JS via a napi `ThreadsafeFunction`, rumble via `XInputSetState`. macOS: Chromium Gamepad API in a hidden renderer with `backgroundThrottling: false` (Chromium enables `GCController.shouldMonitorBackgroundEvents`). macOS fallbacks in order: GameController read in Rust (set `handlerQueue`, keep a no-op `valueChangedHandler`), then `@kmamal/sdl`. | **The browser Gamepad API is dead on Windows for us**: Chromium reads Xbox pads through Windows.Gaming.Input, which "does not get inputs from XBox One controllers when not in the foreground" (SDL source). Resolve is always the foreground app. XInput keeps delivering in the background. |
| Profiles | **Bind to Resolve commands, not raw key combos.** Profiles reference command ids (`edit.rippleDelete`); `packages/profiles/resolve-keymap.json` maps each id to its default combo per OS with a source and a `verified` flag; users override per command in the app. | Users with custom shortcuts work without editing profiles; commands with no default become an automatic "bind these" checklist. |
| Color backend v1 | `pointer`: calibrated synthetic drags on Resolve's Primaries wheels, implemented in main via the addon. | Only mechanism that works on Free 21.1+. |
| Color backend (shelved) | `script`: Python bridge writing `SetCDL`. Spec only. | Needs Studio; nobody can test it. |
| Config | JSON validated with `zod`, stored in `app.getPath('userData')/` | |
| Tests | Vitest + `fast-check`; Rust unit tests; harness-based injection tests; one Playwright-electron smoke test | |
| Lint/format | ESLint (typescript-eslint strict) + Prettier; `cargo fmt` + `clippy -D warnings` | |
| CI | GitHub Actions: `windows-latest`, `macos-latest` (Apple Silicon), `ubuntu-latest` (lint + engine tests). Public repo → free runners. | |
| Network | None. No analytics, no crash reporter, no update check in v1. | Trust is the product for an input tool. |

Package manager: `pnpm` workspaces, one monorepo.

## Reference material (read these first, in this order)

**What we're driving**
- Current release 21.1.1 (readme updated 2026-10-01; macOS 15+ on Apple Silicon, Windows 10 Creators Update+): https://www.blackmagicdesign.com/support/content/readme/62817b75bdf744718e93909ca6d58f0d (Free) · https://www.blackmagicdesign.com/support/content/readme/dfbb6e4233c144d1b328c109c7ebc11e (Studio)
- 21.1 Python-to-Studio change: https://www.provideocoalition.com/davinci-resolve-21-1-is-a-huge-update/ · Free 21.1.0.17 hands-on (what Lua can't do): https://xere.my/journal/davinci-resolve-21-1-free-python-scripting-removed-lua-benchmark/ · https://agentcut.dev/blog/resolve-free-21-1-python-scripts-missing/
- Resolve scripting API (21.1.1 transcription): https://wheheohu.github.io/bmd_doc/ResolveAPI/intro · Graph https://wheheohu.github.io/bmd_doc/ResolveAPI/resolve_api/Graph · TimelineItem https://wheheohu.github.io/bmd_doc/ResolveAPI/resolve_api/TimelineItem. Facts: `SetCDL` is write-only; Graph has **no** add/select/label-node method; `GetToolsInNode(i)` and `GetNumNodes()` are the only node inspection.
- Default shortcuts: R15 sheet https://documents.blackmagicdesign.com/UserManuals/DaVinci-Resolve-15-Keyboard-Shortcuts.pdf · current lists https://jayaretv.com/tips/davinci-resolve-keyboard-shortcuts/ · https://massive.io/?p=126289 · presets import/export and multiple keys per command: https://www.tourboxtech.com/en/news/davinci-resolve-keyboard-shortcuts-guide.html

**Prior art (patterns, not code; licences noted)**
- MIDIGrade (65€, the only shipping pad-based grader; synthetic drags at calibrated coordinates): https://www.midigrade.com/ · manual https://www.midigrade.com/MIDIGrade%20manual.pdf — Full Screen required (p. 7), coordinate nudging saved to `adj-coords.txt` (pp. 9, 24), Workspace → Reset UI Layout when coordinates drift (p. 37), rare Windows multi-monitor offsets (p. 37).
- Gamepad MIDI's MIDIGrade layout: https://pounding.systems/blog/gamepad-midi-midigrade-davinci-resolve
- JoyMapKit (Swift, MIT): https://github.com/manaporkun/JoyMapKit — resolve-at-press, chord deferral only for participants, held-modifier ref counting, `releaseAllHeldKeys`.
- InputConfig (Swift, MIT, 132★): https://github.com/ryleighnewman/InputConfig — the most battle-tested macOS injection layer (`Services/InputSimulator.swift`, `Services/HIDDeviceRegistry.swift`).
- ControllerKeys (https://github.com/NSEvent/xbox-controller-mapper, **source-available, not OSS — read, never copy**): chord-window release parking, Guide via IOHIDManager, mouse warp/drag gotchas.
- Free-tier Python bridges (MIT, for the shelved backend): https://github.com/samuelgursky/davinci-resolve-mcp · https://github.com/hiteshK03/davinci-resolve-mcp
- Conductor / midimon (Rust, MIT, archived 2025-11-21): https://github.com/amiable-dev/midimon — cautionary tale.
- gilrs vs Xbox on macOS: https://github.com/openOMSI-Project/openOMSI/pull/1600
- Gamepad API vs Windows background: https://github.com/libsdl-org/SDL/blob/main/src/joystick/windows/SDL_rawinputjoystick.c · https://github.com/chromium/chromium/blob/main/device/gamepad/wgi_data_fetcher_win.cc · https://discuss.bluerobotics.com/t/cockpit-standalone-needs-to-be-the-selected-window-for-controller-to-work/18604
- Windows injection done right: https://github.com/enigo-rs/enigo/blob/v0.6.1/src/win/win_impl.rs · Qt keypad rule https://github.com/qt/qtbase/blob/dev/src/plugins/platforms/windows/qwindowskeymapper.cpp · UIPI https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput
- napi-rs CI template (copy the workflow, not the package): https://github.com/touchifyapp/node-enigo/blob/main/.github/workflows/CI.yml
- macOS fallback input: `@kmamal/sdl` https://github.com/kmamal/node-sdl
- nut.js prebuilds are paywalled: https://github.com/nut-tree/nut.js/ · https://nutjs.dev/

**Platform docs**
- Electron: https://www.electronjs.org/docs/latest/api/system-preferences (`isTrustedAccessibilityClient`) · https://www.electronjs.org/docs/latest/api/browser-window (`backgroundThrottling`)
- Gamepad API: https://developer.mozilla.org/en-US/docs/Web/API/Gamepad_API/Using_the_Gamepad_API · https://w3c.github.io/gamepad/#remapping
- napi-rs https://napi.rs/docs/introduction/getting-started · CGEvent https://developer.apple.com/documentation/coregraphics/cgevent · SendInput https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput

**Skills to invoke (by name)**
`shai` (every session) → `brand-kit` (Phase 1) → `frontend-craft` + `frontend-design` (Phase 4) → `canvas-design` (README cheat sheet, Phase 6) → `watchdog` (end of Phases 3, 5, 6) → `rnd-expert` only if a pinned dependency turns out dead.

**MCP / tooling**
- GitHub via `gh` + git, **always as AryanJ129 through `scripts/gh-as-aryan`** (Phase −1). Every other connected service is out of scope.
- Subagents for independent tracks: (a) native addon + probe + harness + CI, (b) engine + tests. Do not parallelize UI work; it depends on the brand kit.

## Architecture

### Repo layout

```
jogstick/
├─ CLAUDE.md  BUILD_BRIEF.md  ARCHITECTURE.md  README.md  LICENSE (MIT)  .npmrc (node-linker=hoisted)
├─ package.json  pnpm-workspace.yaml  tsconfig.base.json
├─ scripts/ gh-as-aryan  dev-sign-mac.sh
├─ .github/workflows/ ci.yml  native.yml  probe.yml  release.yml
├─ brand/                          # BRAND_KIT.md, tokens.css, brand-preview.html, tray icons (Phase 1)
├─ packages/
│   ├─ engine/                     # pure TS state machine
│   │   ├─ src/ schema.ts profile.ts engine.ts gestures.ts axes.ts layers.ts actions.ts drive.ts transport.ts
│   │   └─ test/ generators/ (synthetic frames)  fixtures/*.frames.json (recorded)  *.test.ts  properties.test.ts
│   ├─ native/                     # napi-rs addon + two binaries
│   │   ├─ Cargo.toml  src/{lib.rs, inject_mac.rs, inject_win.rs, pad_win.rs, app_mac.rs, app_win.rs, keymap.rs}
│   │   ├─ src/bin/{jogstick-probe.rs, jogstick-harness.rs}
│   │   └─ index.d.ts
│   └─ profiles/                   # resolve-default.json, resolve-keymap.json, generic.json, profile.schema.json (generated)
├─ apps/desktop/src/
│   ├─ main/      # tray, input host, gate, output queue + injector, color backend, calibration, store, log
│   ├─ preload/
│   ├─ input/     # macOS only: hidden renderer, Gamepad API poller → IPC frames
│   ├─ overlay/   # click-through always-on-top window: mode/layer label + calibration crosshairs
│   └─ renderer/  # editor UI (React)
└─ docs/ profiles.md  mapping.md  color.md  troubleshooting.md  testing-with-a-friend.md
   (no bridge/ in v1; the script backend is shelved)
```

### Processes and data flow

```
[Xbox pad] ─USB/BT─► OS ─┬─ Windows: XInputGetState on a Rust thread @250 Hz (addon) ─► ThreadsafeFunction ─┐
                         └─ macOS:   Chromium Gamepad API, hidden renderer @250 Hz ─► IPC ──────────────────┤
                                       both emit on change + 120 Hz analog snapshots while any axis is live  │
                                ▼ PadFrame {t (monotonic ms), buttons[17] (value 0..1), axes[4]}  ◄──────────┘
                           main process
              ┌─────────────────┼───────────────────────────────────┐
        engine.step(state, frame, now)              gate: Resolve's main window frontmost, no modal dialog?
              │ Command[]                            (no → releaseAll(), drop frames, keep polling)
   ┌──────────┼────────────────┬───────────────────┬──────────────────────┐
 output queue → injector     color backend      overlay label        haptics → PadSource
 (serialized, timed; addon)  pointer            "EDIT · TRIM"        (XInputSetState / vibrationActuator)
```

- **Engine** is a pure function `step(state, input, now) → {state', commands[]}`. Inputs are `PadFrame`s and `Tick`s (8 ms while any repeat/jog/drive is active; on Windows from the addon thread's high-resolution timer, on macOS from the host). **All timing comes from `now` timestamps with accumulators, never tick counts** (Windows timer resolution drops to ~8–16 ms on battery; a jog must still step the exact number of frames).
- **Commands** are abstract: `Command{id}` (a Resolve command id), `KeyDown{code, mods, owner}`, `KeyUp{code, owner}`, `MouseButton{btn, down}`, `MouseMove{dx,dy}`, `Scroll{dx,dy,units}`, `DriveStart{target}`, `DriveDelta{dx,dy}`, `DriveEnd`, `ModeChanged`, `LayerChanged`, `Haptic{kind}`.
- **Host** resolves `Command{id}` through the keymap (defaults + user overrides) into a combo, and owns the gate, the **output queue**, safety, the color backend, overlay, tray, IPC.
- **Output queue (injector).** One serialized, time-scheduled queue. A combo expands to modifier-down → `comboSpacingMs` → key-down → key-up → `comboSpacingMs` → modifier-up; nothing else interleaves while a combo is in flight, so a second button pressed mid-combo can't pick up the wrong modifiers. Plain jog arrows skip the spacing but still go through the queue to keep order. `releaseAll` drops pending entries, then releases everything held.
- **Editor window** is UI only; it never injects and never counts as a gate match.

### Profile and keymap schema (zod; JSON Schema generated)

```jsonc
// packages/profiles/resolve-default.json
{
  "version": 1,
  "id": "resolve-default",
  "name": "DaVinci Resolve",
  "appMatch": { "win32": ["Resolve.exe"], "darwin": ["com.blackmagic-design.DaVinciResolve", "com.blackmagic-design.DaVinciResolveLite"] },
  "settings": { "deadzone": 0.12, "outerDeadzone": 0.98, "triggerDeadzone": 0.08, "chordWindowMs": 60, "holdThresholdMs": 300,
                "comboSpacingMs": 16, "axisLockRatio": 1.5, "hapticDetents": true },
  "modes": ["edit", "color"],
  "modeSwitch": { "chord": ["view", "menu"], "haptic": "pulse" },
  "layers": [ { "id": "trim", "hold": "lb" }, { "id": "mark", "hold": "rb", "modes": ["edit"] }, { "id": "alt", "hold": "lb", "modes": ["color"] } ],
  "fine": { "hold": "rb", "modes": ["color"], "multiplier": 0.25 },
  "bindings": [
    { "mode": "edit", "input": "a", "action": { "type": "command", "id": "edit.splitClip" } },
    { "mode": "edit", "input": "a", "layer": "trim", "action": { "type": "command", "id": "edit.rippleDelete" } },
    { "mode": "edit", "input": "dpadRight", "action": { "type": "command", "id": "nav.stepFrameForward", "repeat": { "delayMs": 300, "intervalMs": 60 } } },
    { "mode": "edit", "input": "lstick.x", "action": { "type": "jog", "rate": { "min": 2, "max": 30, "curve": "quad" }, "fastAtEdge": true } },
    { "mode": "edit", "input": "rt", "action": { "type": "shuttle", "dir": "forward", "zones": [0.15, 0.45, 0.75], "slowZone": true } },
    { "mode": "color", "input": "lstick", "action": { "type": "wheel", "wheel": "lift", "part": "balance", "gain": 1.0 } },
    { "mode": "color", "input": "rt", "action": { "type": "wheel", "wheel": "active", "part": "master", "dir": 1, "gain": 1.0 } }
  ]
}

// packages/profiles/resolve-keymap.json
{
  "edit.splitClip":     { "label": "Split clip at playhead (blade)", "darwin": "Cmd+B", "win32": "Ctrl+B", "source": "massive.io", "verified": false },
  "edit.rippleDelete":  { "label": "Ripple delete", "darwin": "Shift+Backspace", "win32": "Shift+Backspace", "source": "R15 + jayaretv", "verified": false },
  "color.prevNode":     { "label": "Previous node", "darwin": null, "win32": null, "source": "not in R15 sheet; verify", "verified": false }
}
```

- Combo syntax: `Cmd`/`Ctrl`/`Shift`/`Alt` + W3C `KeyboardEvent.code` names (`KeyB`, `Comma`, `ArrowUp`, `Backspace`, `F13`) with short aliases. The addon owns `code → virtual key` per OS. On macOS `Backspace` is the key labelled delete.
- `null` default = no known default: the Setup screen lists these as "bind once in Resolve's Keyboard Customization, then tell Jogstick the key" (or the user picks a free key like F13–F19 and Jogstick tells them what to bind).
- `verified` flips to `true` only when the friend's exported keyboard preset or a probe run confirms it.
- Action types v1: `command`, `key` (raw combo, for generic profiles), `keySeq` (macro, cancellable), `mouseButton`, `mouseMove`, `scroll`, `jog`, `shuttle`, `wheel`, `modeSet`, `layerToggle`, `none`.
- Inputs: `a b x y lb rb lt rt view menu l3 r3 dpadUp dpadDown dpadLeft dpadRight lstick lstick.x lstick.y rstick rstick.x rstick.y`. `guide` is in the schema but unbound (unreliable on both OSes; on Windows it opens Xbox Game Bar).

### Engine semantics (the spec; write a test against every line)

1. **Deadzone + curve.** Radial deadzone (0.12) → outer deadzone (0.98) → normalize → curve (`linear | quad | cubic | sCurve | custom[]`) → direction via `atan2`. Triggers: scalar deadzone 0.08.
2. **Axis lock.** When a stick's X and Y are bound to *different* actions (Edit: X jog, Y zoom), the stick locks to the dominant axis on leaving the deadzone once `|a| ≥ axisLockRatio · |b|` (or to the larger axis after 40 ms), and stays locked until it returns inside the deadzone. Sticks bound as a 2-D vector (wheel balance, mouse) are never locked. Without this, jogging zooms the timeline.
3. **Digital vs analog paths.** Buttons are edge events processed on the frame they change; sticks/triggers are cached and consumed on the tick. Buttons pressed at value > 0.5; triggers bound digitally use a threshold with edge detection both ways.
4. **Resolve at press, release what you pressed.** The action is resolved at press time (mode + layers at that instant) and stored with the held input; release dispatches exactly that stored action. Changing layer or mode mid-hold never releases the wrong key.
5. **Layers.** Activator is consumed (emits nothing). Momentary; `layerToggle` latches. Lookup: most recently activated layer → base. A layer can be limited to modes. Mode/profile switch clears layers after `releaseAll`.
6. **Chords.** Only chord participants are deferred; everything else fires immediately. Exact-set match, order-independent, within `chordWindowMs`. Larger chord replaces and releases a smaller one. **Releases inside the chord window are parked and replayed after the press/chord dispatch** (prevents the stuck key on a quick tap of a participant; JoyMapKit has that bug).
7. **Gestures.** `hold` fires once at `holdThresholdMs` and suppresses the tap; `doubleTap` defers the single tap and is cancelled by the second *press*; `tap` with a sibling `hold` fires on release before the threshold.
8. **Jog.** Deflection `d` → rate `r = min + (max−min)·curve(d)` frames/s → one step-frame command every `1000/r` ms (time accumulator). With `fastAtEdge` and `d ≥ 0.98`: step-one-second commands at 6 Hz. Return to deadzone stops instantly. **Haptic detents** (if enabled): at `r ≤ 8` fps, a ~12 ms low-motor tick per frame step.
9. **Shuttle.** Trigger value → zone by thresholds, 80 ms debounce. Zone *n*: `K` then `L`×n (or `J`×n). With `slowZone`, the lightest zone is **K held + L held** (slow forward; J+K slow reverse) — verify in Spike B, drop it if Resolve doesn't do it. Release below first zone: release held keys, then `K`. Later-pulled trigger wins.
10. **Jog/shuttle arbitration.** Last started wins: starting a jog while shuttling sends `K` and ends the shuttle first; pulling a trigger while jogging ends the jog.
11. **Repeat.** `repeat {delayMs, intervalMs}` auto-repeats while held (frame step 300/60; **undo/redo 400/120** so a burst of tiny wheel nudges can be undone quickly).
12. **Modifiers.** Bare-modifier bindings hold the modifier (ref-counted). Every key event carries its own binding's modifiers plus standalone-held ones, never another held binding's (otherwise ⌘V then Space sends ⌘Space). Key holds are owner-tagged.
13. **Modes.** Exactly one active. Switch: `releaseAll`, clear layers, end any drive, haptic pulse, overlay label, tray icon.
14. **Gate.** Injection only when Resolve's **main window** is frontmost and no modal dialog is up: Windows — the foreground window belongs to `Resolve.exe` and has no owner window (`GetWindow(hwnd, GW_OWNER) == NULL`; dialogs have one); macOS — the AX focused window's `AXSubrole` is `AXStandardWindow` (not `AXDialog`/`AXSystemDialog`), read with the Accessibility grant we already need, no Screen Recording. Dialog up → pause with overlay "Dialog open — pad paused". Gate loss → `releaseAll`, end drive, drop frames, keep polling. Ignore transient macOS overlays (`com.apple.loginwindow`, `com.apple.ScreenSaver.Engine`, `com.apple.SecurityAgent`, `com.apple.UserNotificationCenter`).
15. **Safety.** The injector tracks everything it has down. `releaseAll` order: **mouse buttons → keys → modifiers**. Runs on gate loss, mode/profile switch, controller disconnect, sleep / screen lock / session switch, exception, native panic, quit. On launch `releaseLeftovers()` posts ups for anything still down after a crash.
16. **Wheel drive (Color) — one cursor, one drive.** A `wheel` binding emits `DriveStart{wheel, part}` on leaving the deadzone, `DriveDelta` each tick (`gain · curve(d) · baseSpeed`, × `fine.multiplier` while RB is held, sub-pixel accumulation), `DriveEnd` on return to deadzone. **Only one drive at a time:** the first to start owns the cursor; other wheel inputs are ignored until it ends + 100 ms. Never hop the cursor between wheels mid-push (each mouse down/up likely creates its own undo entry). `wheel: "active"` targets the wheel most recently driven by a stick (default gain).

### Resolve profile v1 (`resolve-default`)

Shown as command → current default combo. ⌨ = no known default (bind once). Every row is checked against the friend's exported keyboard preset in Phase 0 and the keymap's `verified` flags updated.

**Edit mode**

| Input | Base | hold LB (trim) | hold RB (mark) |
|---|---|---|---|
| A | Split clip at playhead `Mod+B` | Ripple delete `Shift+Backspace` | Source/timeline viewer `Q` |
| X | Cut `Mod+X` | Ripple cut `Mod+Shift+X` | Select clips forward, all tracks `Alt+Y` |
| Y | Copy `Mod+C` | Extend edit `E` | Select nearest clip/gap `Shift+V` |
| B | Paste `Mod+V` | ⌨ Paste insert | Match frame `F` |
| D-pad ↑ / ↓ | Previous / next edit `ArrowUp` / `ArrowDown` | Trim start / end `Shift+[` / `Shift+]` | Mark in / out `I` / `O` |
| D-pad ← / → | Step one frame `ArrowLeft` / `ArrowRight` (repeat) | Nudge `,` / `.` | Ripple start / end to playhead `Mod+Shift+[` / `Mod+Shift+]` |
| Left stick X | **Jog** 2–30 fps, quad, fast at edge (axis-locked) | Jog 1–6 fps (fine) | — |
| Left stick Y | Zoom in / out `Mod+=` / `Mod+-` (axis-locked; verify it zooms the timeline) | Zoom to fit `Shift+Z` | — |
| Right stick | Mouse | — | — |
| LT / RT | **Shuttle** reverse / forward (slow zone + 1×/2×/4×) | — | — |
| L3 | Play / pause `Space` | Play around current frame `/` | Clear in/out `Alt+X` |
| R3 | Left mouse button (held) | | |
| View / Menu | Undo `Mod+Z` / Redo `Mod+Shift+Z` (repeat while held) | | |
| View + Menu | Mode switch Edit ⇄ Color | | |

**Color mode (`pointer` backend).** RB held = **fine** (0.25×) for any drive. No mouse in Color mode; flip to Edit mode (View + Menu) to use the stick mouse.

| Input | Base | hold LB (alt) |
|---|---|---|
| Left stick | Lift wheel balance | Gamma wheel balance |
| Right stick | Gain wheel balance | Offset wheel balance |
| LT / RT | Master wheel of active wheel ↓ / ↑ | — |
| A | Add serial node `Alt+S` | Add parallel node `Alt+P` |
| B | Node on/off `Mod+D` | Bypass all grades `Shift+D` |
| X | Grab still `Alt+Mod+G` | Reset node grade `Shift+Home` |
| Y | Highlight `Shift+H` | — |
| D-pad ↑ / ↓ | Previous / next clip `ArrowUp` / `ArrowDown` | — |
| D-pad ← / → | ⌨ Previous / next node (may have defaults; preset export settles it) | — |
| L3 | Play / pause `Space` | — |
| View / Menu / chord | Undo / Redo (repeat) / mode switch | |

Consistent across modes: L3 play/pause, View undo, Menu redo, View+Menu mode switch, D-pad ↑/↓ previous/next item. Resolve routes many keys by focused panel (timeline vs viewer vs node graph); Setup tells the user to click the timeline once, and `docs/profiles.md` lists focus-dependent bindings.

### Overlay

A small click-through, always-on-top label (corner configurable) shows the current mode/layer: `EDIT`, `EDIT · TRIM`, `EDIT · MARK`, `COLOR`, `COLOR · ALT`, `COLOR · FINE`, `PAUSED (dialog)`, `RECALIBRATE`. It fades 1.5 s after the last change and flashes on mode switch. Resolve runs full screen, so the tray is invisible; this is what makes layers learnable. Setting to disable. The same overlay window draws calibration crosshairs.

### Color backend `pointer` (v1)

1. **Calibration (three points).** Preconditions checklist: Color page, Full Screen mode, Primaries Wheels visible, final layout. User hovers and presses A on: the **Lift** wheel center, the **Offset** wheel center, and the **Lift master wheel**. Gamma and Gain centers are derived by even spacing between Lift and Offset; the other master wheels by the same vertical offset. The overlay draws all 8 derived points; the user nudges any point with the D-pad and confirms. Target: under 30 s. Positions come from the addon's `cursorPosition()` (same coordinate space as injection, sidesteps DPI conversion), stored relative to Resolve's main window plus a display-configuration hash.
2. **Validity.** Window size or display hash changes → Color mode inert, overlay `RECALIBRATE`. Window moves are fine. Docs: Workspace → Reset UI Layout if the wheels moved.
3. **Drive.** `DriveStart`: remember the user's cursor → move to target → mouse down. `DriveDelta`: sub-pixel accumulator → **absolute** move to `target + accumulated` (Windows `SendInput` absolute with `MOUSEEVENTF_VIRTUALDESK`, because relative moves go through pointer acceleration; macOS `*MouseDragged` at the tracked position). `DriveEnd`: mouse up → restore cursor. Travel beyond `regrabPx` (300) or near a screen edge: mouse up, warp to target, mouse down. **Never warp while the button is down.**
4. **Abort** if the physical mouse moves during a drive (> 8 px off expected).
5. **Feel.** Per-part `gain` tuned from Spike C so a full push for 1 s moves a wheel about a quarter of its range; RB = 0.25×.
6. **Undo** is Resolve's own (View, repeats while held). No shadow state.

### Color backend `script` (shelved — spec only, do not build)

Availability: Studio any version (external scripting) or Free ≤ 21.0.4 (in-app Python via Workspace → Scripts). Not Free 21.1+.
- Node targeting (the API can't add/select/label nodes): drive node `N = GetNumNodes()` only if `GetToolsInNode(N)` is empty at first touch, or the app already owns `(clipUniqueId, N)`; otherwise ask for a fresh serial node. Preflight `GetNumNodes()` before each `SetCDL` (returns `False` on missing node / generator clip).
- Mapping: gain → Slope, gamma → Power, lift and offset → Offset, master → all channels. Shadow state per `(clip, node)` from identity; zero-sum RGB push from stick angle; values as `"r g b"` strings.
- Transport: one persistent loopback TCP connection, NDJSON `{seq, op, args}` → `{seq, ok, result|error}`, 1 s heartbeat with per-run `session`, 0600 token file, `127.0.0.1` only, whitelisted ops, no eval. Coalesce to a latest-value slot. Never `OpenPage` while playing. Windows: `SO_EXCLUSIVEADDRUSE` + parent-liveness (orphaned `fuscript.exe` keeps the port).
- Install paths: Windows `%APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility\`; macOS `~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility/` plus both App Store container variants (see gursky's installer). macOS ≤ 21.0 needs Python via `PYTHON3HOME` (`launchctl setenv`) or `/usr/local/bin/python3`.

### Code-read findings

**Bridges (gursky + hitesh).** gursky: raw TCP NDJSON, HMAC with nonces, `ThreadingTCPServer` with every Resolve call under one RLock; a Scripts-menu Python script runs as a child `fuscript` process, so blocking it doesn't block Resolve's UI; ~0.85 ms per call + ~0.35 ms loopback. hitesh: single-threaded `HTTPServer`, HTTP/1.0, no auth, re-enumerates `GetItemListInTrack` on every write. Both Python, so Studio/≤ 21.0.4 only now. Lua on Free 21.1 has no working IPC (`io`, `os.execute`, `require` blocked). Not on the v1 path.

**macOS mappers (JoyMapKit, InputConfig, ControllerKeys).** All read pads through GameController (~120 Hz tick for analog, events for buttons). Rules for our macOS injector:
- One long-lived `CGEventSource(.hidSystemState)`; post at `.cghidEventTap`; tag `eventSourceUserData`.
- **Always write `event.flags` in full, including empty** (unset flags inherit HID state: after a synthetic arrow, Delete became forward-delete and Return became keypad Enter).
- Arrows and F-keys need `maskSecondaryFn` / `maskNumericPad` (probe via a `.privateState` source). Jog is arrow keys, so this matters day one.
- Modifiers go out as `.flagsChanged` with the full resulting set, never as plain keyDown/keyUp.
- Mouse: position from `CGEvent(source: nil).location`; clamp to the display union; `*MouseDragged` while a button is held; reuse `mouseEventNumber` and click count across a drag; `localEventsSuppressionInterval = 0` before `CGWarpMouseCursorPosition`; never warp mid-drag.
- Recovery: `releaseLeftovers()` checks `CGEventSource.keyState/buttonState(.combinedSessionState)` and posts ups.
- AX permission: `AXIsProcessTrusted` / prompt; re-check on activation and on the `com.apple.accessibility.api` distributed notification (lags ~1 s); offer a button to `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`. **The TCC grant is keyed to the code signature**, so ad-hoc builds lose it on every rebuild → see dev signing in Phase −1.
- Frontmost app: `NSWorkspace.didActivateApplicationNotification` (cached, no polling).
- Hardware: wired Xbox on macOS works only for `045E:02EA` (One S), `045E:0B00` (Elite 2), `045E:0B12` (Series X|S); others must use Bluetooth. Guide is swallowed by GameController.

**Conductor / midimon (archived).** README and code diverge: input mode hard-coded `MidiOnly`, `ModeChange` a no-op, hold detection never called, learn mode dead code, per-app switching `// TODO`. Axes quantised to direction events; every enigo call `.unwrap()`; keys only click; no release-all; frontmost app via `osascript`; macros block the input loop; no Windows CI; no releases. Worth taking: templates as commented profiles with metadata; a learn-mode state machine (`idle → waiting → captured | timedOut | cancelled`). Rule: **README claims are tied to tests and recordings; nothing ships as scaffolding.**

**Injection + gamepad (node-enigo, enigo 0.6.1, Chromium, SDL, Qt).**
- **Gamepad API on Windows: unusable in the background.** Chromium's default Windows fetcher for Xbox pads is Windows.Gaming.Input; SDL: "Windows.Gaming.Input does not get inputs from XBox One controllers when not in the foreground" and "Prefer XInput over WindowsGamingInput, it continues to provide data in the background". Blue Robotics Cockpit (Electron) hit focus-dependent loss on Windows 11. `backgroundThrottling:false` only gets past Blink, not the platform API. Chromium also withholds pad data until a pad press is seen.
- **Gamepad API on macOS: fine in the background** (`shouldMonitorBackgroundEvents = YES`). Standard mapping: 0 A, 1 B, 2 X, 3 Y, 4 LB, 5 RB, 6 LT, 7 RT (analog), 8 View, 9 Menu, 10 L3, 11 R3, 12–15 d-pad ↑↓←→, 16 Guide; axes LX, LY, RX, RY with +Y down.
- **XInput on Windows** (what we use): background-safe, max 4 pads, no Guide, rumble works in background (no trigger rumble). USB, Xbox Wireless Adapter and Bluetooth pads all surface through XInput.
- **`@kmamal/sdl`** (macOS fallback): MIT, single maintainer; 0.11.13 stable (SDL 2.32.8), 1.0.0-5 prerelease (SDL 3, Node ≥ 22); prebuilds downloaded by install script (needs `asarUnpack`); unverified in Electron; polls `setInterval(poll, 0)`; set `SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS=1`.
- **node-enigo: don't depend on it** (8 commits over two days, "early alpha", `UNLICENSED` in package.json vs MIT in README). Its napi-rs v3 CI is a fine template.
- **Windows keys:** send `SendInput` with both `wVk` and `wScan` (`MapVirtualKeyExW(MAPVK_VK_TO_VSC_EX)` with the foreground layout) and `KEYEVENTF_EXTENDEDKEY` for RAlt, RCtrl, arrows, Ins, Del, Home, End, PgUp, PgDn, NumLock, PrintScr, Divide. **Qt adds `Qt::KeypadModifier` to arrows/Home/End/Ins/Del/PgUp/PgDn when the extended flag is missing**, so Resolve may see "keypad arrow" and jog does nothing. Absolute mouse moves use virtual-desktop coordinates; relative moves are subject to pointer acceleration.
- **enigo on macOS** posts modifiers as keyboard events, not `flagsChanged`.
- **UIPI:** we can't inject into an elevated Resolve and `SendInput` won't say so → `isProcessElevated(pid)` + warning.
- **Resolve sometimes drops fast synthetic combos** (Bome forum: https://forum.bome.com/t/mtp-with-davinci-resolve-using-keystrokes/1290). `comboSpacingMs` floor is measured in Spike B; the output queue enforces it.
- **Steam Input:** if Steam is running, its desktop layout may also turn the pad into a mouse/keyboard on top of our mapping → detect the Steam process and warn on Status.

## Build sequence

Each phase ends with a check on real hardware. Resolve checks run on the friend's PC via `jogstick-probe` or a release candidate, with a written checklist (`docs/testing-with-a-friend.md`) and a report file he sends back.

### Phase −1: prerequisites on Aryan's Mac (30 min, before any code)

1. **Pin GitHub to AryanJ129 for this repo only. Do not run `gh auth switch`** (the active account is BusinessSTR and another Claude session depends on it).
   - `gh auth status` must list **AryanJ129** with scopes including **`repo` and `workflow`** (`workflow` is required to push `.github/workflows/`). Compare logins case-insensitively.
   - `gh auth token --help` must show a `--user` flag. If it doesn't, stop and ask Aryan before upgrading `gh`.
   - Create `scripts/gh-as-aryan` (committed; contains no secret):
     ```sh
     #!/bin/sh
     GH_TOKEN="$(gh auth token -h github.com -u AryanJ129)" exec gh "$@"
     ```
     `scripts/gh-as-aryan api user --jq .login` must print `AryanJ129`. Use this wrapper for **every** `gh` call in this project.
   - Create the repo: `scripts/gh-as-aryan repo create AryanJ129/jogstick --public --license mit --description "Xbox controller → DaVinci Resolve. Analog jog, layers, color wheels. Works on Resolve Free." --clone`.
   - Repo-local git credentials and identity (never global), run inside the clone:
     ```sh
     git remote set-url origin https://github.com/AryanJ129/jogstick.git   # HTTPS, so an SSH key from another account can't be used
     git config credential.https://github.com.helper ''
     git config --add credential.https://github.com.helper '!f() { test "$1" = get && echo username=AryanJ129 && echo "password=$(gh auth token -h github.com -u AryanJ129)"; }; f'
     git config user.name AryanJ129
     git config user.email "$(scripts/gh-as-aryan api user --jq .id)+AryanJ129@users.noreply.github.com"
     ```
     Verify with a first push that the commit shows under AryanJ129 on GitHub.
   - **Reconnect only if** `gh auth status` no longer lists AryanJ129 or its token is invalid: stop and ask Aryan to run `gh auth login -h github.com` (sign in as AryanJ129, classic token with `repo` + `workflow`), then `gh auth switch -h github.com -u BusinessSTR` to restore his work account as active.
2. **Disk.** `df -h ~` showed ~14 GB free; Aryan's rule stops installs below 20 GB. This project needs roughly 5 GB locally (cargo target, node_modules, Electron cache; Windows binaries build in CI). Check before every install step; if free space is under 20 GB, stop and tell Aryan the expected need and ask what to clear. Never delete his files yourself.
3. **Toolchain** (already present: node 22.15, pnpm, cargo, rustc). Pin Electron 45.1.0.
4. **macOS dev signing.** Create a self-signed code-signing certificate "Jogstick Dev" in the login keychain (ask Aryan to confirm the Keychain prompt), and `scripts/dev-sign-mac.sh` signs dev builds and `jogstick-harness` with it, so the Accessibility grant survives rebuilds. Note: under `pnpm dev`, the grant attaches to `Electron.app` or the terminal, not to Jogstick; document which one to approve.

### Phase 0: repo, CI, probe + harness, friend runs the spikes (3–4 days)

1. Scaffold pnpm workspace (`node-linker=hoisted`), `electron-vite` app, `packages/{engine,native,profiles}`, `CLAUDE.md` (below), `ARCHITECTURE.md` stub, `ci.yml`. First push green.
2. **`jogstick-harness`** (Rust, `winit`): a window that logs every key event (physical key, logical key, **key location — Standard vs Numpad**, modifiers) and mouse event to stdout/JSON. This lets Aryan verify injection on the Mac without Resolve (Delete/Return after an arrow burst; modifier sequencing) and proves on Windows that arrows arrive as Standard, not Numpad (the Qt rule). On `windows-latest` CI, try driving the harness with the injector; if SendInput can't reach the runner's desktop, mark that test local-only.
3. **`jogstick-probe`** (Rust, same crate, Windows x64 first): one exe, guided prompts, writes `jogstick-probe-report.json`. `probe.yml` publishes it as a GitHub prerelease asset (`probe-v0.x`) via `scripts/gh-as-aryan`. Subcommands:
   - `probe pad` — **Spike A.** XInput at 250 Hz with Resolve focused for 10 minutes (AC and battery): effective Hz, 100-tap test, 30-s stick sweep. **Records frames** as engine fixtures (`frames-*.json`). Pass: ≥ 200 Hz, 100/100 taps, no dropped axis data.
   - `probe keys` — **Spike B.** With Resolve frontmost: `Mod+B` split; 100 combos (`Mod+B`, `Mod+Shift+[`, `Alt+Y`) at spacing 0/8/16/30 ms (friend answers Y/N); 30 s of `ArrowRight` at 30 Hz (friend types timecode before/after: expect exactly 900 frames); same with the extended flag off (expect failure); K+L and J+K slow shuttle; detects Resolve elevation and Steam.
   - `probe wheel` — **Spike C.** Three-point calibration, then scripted drags on each wheel and master wheel; friend reports whether pressing anywhere in a wheel adjusts **relatively** or snaps the puck to the click, whether master wheels respond to horizontal drags, and pixels-per-change. He records the screen (Win + Alt + R, Xbox Game Bar). If pucks snap, v1 balance drives start from the puck and `ARCHITECTURE.md` records the strategy.
4. Ask the friend to **export his Resolve keyboard preset** (Keyboard Customization → ⋯ → Export) and send the file with the first report. Inspect its format; if parseable, write a verifier that checks every `resolve-keymap.json` entry and sets `verified`. Decide afterwards whether "import preset" becomes an app feature.
5. `docs/testing-with-a-friend.md`: what to download, SmartScreen "More info → Run anyway", how to run each probe, what to send back.

Done: repo public and green; probe report(s) and the keyboard preset received; spike numbers and the decisions they forced in `ARCHITECTURE.md`.

### Phase 1: brand kit (half a day; Aryan approves)

Run `brand-kit`. Stage 1 inputs: **What:** an open-source desktop app that makes a game controller feel like a real editing surface for DaVinci Resolve. **Who:** indie editors, YouTubers, colorists on a budget, couch editors. **Vibe:** tactile, precise, playful-serious (Speed Editor seriousness, controller joy). **Non-negotiables:** dark-default with light variant; sits next to Resolve's charcoal UI; no purple-blue gradients; accent survives as a 16 px tray icon (Windows + macOS template image) and as the overlay label; 1280×720 minimum. **Runs on:** Electron app, overlay, README, GitHub social preview. Stage 3: ONE direction with references; Aryan's yes before Stage 4. Deliver `brand/BRAND_KIT.md`, `brand/tokens.css` (+ Tailwind v4 `@theme`), `brand/brand-preview.html`, tray icons (connected / paused / color / error).

Name: **Jogstick** (confirmed). npm `jogstick` is free; `gh search repos jogstick` returned 0 results on 2026-10-28. Do a trademark search before v0.1 and tell Aryan if it finds anything. Never "DaVinci" or "Resolve" in the name, package name or bundle id.

### Phase 2: engine (2–3 days; parallel with Phase 0's native work)

Start with **synthetic frame generators** (`test/generators/`: jog sweeps, trigger pulls, diagonal pushes, chords, quick taps, disconnects) so this doesn't wait on the friend; add recorded fixtures from `probe pad` when they arrive. Implement against every semantics item. Coverage ≥ 90 % on `engine.ts`, `gestures.ts`, `axes.ts`, `layers.ts`, `transport.ts`. Property test (`fast-check`): any frame sequence ending all-released yields matched `KeyDown/KeyUp`, `MouseButton` down/up, `DriveStart/DriveEnd`; at most one drive active at any instant. Done: green on all CI OSes; `pnpm engine:replay <fixture>` prints the command log.

### Phase 3: host + addon + Edit mode end-to-end (3–4 days)

Tray app, input host, gate (incl. dialog detection), output queue, injector, keymap resolver with user overrides, `releaseAll`/`releaseLeftovers`, sleep/lock hooks, overlay label, Steam warning.

Addon API (JS main thread only; every injected event tagged — `eventSourceUserData` on macOS, `dwExtraInfo` on Windows; **every napi entry point and the pad thread wrapped in `catch_unwind`: a panic reports an error and triggers `releaseAll`, never aborts the host**):
- Injection: `keyDown(code, mods)`, `keyUp(code, mods)`, `modifierChanged(mods)`, `mouseMoveRel(dx, dy)`, `mouseMoveTo(x, y)`, `mouseButton(btn, down)`, `scroll(dx, dy, units)`, `cursorPosition()`, `releaseAll()`, `releaseLeftovers()`.
- System: `frontmostApp() → {id, name, pid, bounds, isDialog}`, `onFrontmostChanged(cb)`, `isProcessElevated(pid)` (Windows), `isProcessRunning(name)`, `axIsTrusted(prompt)`, `openAxSettings()` (macOS).
- Pad (Windows): `padStart(cb, {hz})`, `padStop()`, `padRumble(index, low, high, ms)`, `padList()`.

`native.yml` builds `win32-x64` and `darwin-arm64`; `release.yml` downloads those artifacts into the app before packaging.

Verify: (a) on the Mac against `jogstick-harness`: every Edit-mode command produces the expected key events, arrows arrive Standard, Delete/Return behave after jogging, `releaseAll` leaves nothing down. (b) Windows release candidate `v0.1.0-rc1` to the friend with a checklist: a 10-cut rough edit using only the pad, a 2-minute scrub with stick and triggers, a dialog open (pad pauses), Steam warning if applicable; he sends a 60-s recording plus the exported Console log. Then run `watchdog` on host + addon.

### Phase 4: mapping editor (3–4 days)

Run `frontend-craft` (reads `brand/`). Screens: (1) **Status**: controller, profile, gate state (incl. "dialog open", "Resolve running as administrator", "Steam may also be mapping your pad"), color calibration state, Pause toggle. (2) **Mapping**: controller silhouette with live highlighting; learn mode (`idle → waiting → captured | timedOut | cancelled`: press the pad control, pick a Resolve command from a searchable list or record a raw combo via renderer `keydown` with `code` + modifiers); layer, mode, gesture; stick/trigger panels with deadzone/curve sliders and a live response plot. (3) **Commands**: the keymap with defaults, user overrides, ⌨ items, `verified` badges. (4) **Profiles**: list, duplicate, import/export, reset. (5) **Setup**: macOS Accessibility walkthrough with live status; Windows SmartScreen note; wired-Xbox-on-Mac note; Color calibration entry. (6) **Console**: rolling event log, exportable. Keyboard-navigable; no accounts, no telemetry. Done: Aryan remaps three bindings without touching JSON and the change round-trips through export/import.

### Phase 5: Color mode with the `pointer` backend (3 days)

Calibration wizard + overlay, drive per spec and Spike C, single-drive ownership, validity checks. Verify on the Mac against the harness (drive sequences, cursor restore, abort on real mouse movement, no warp mid-drag). Then `v0.1.0-rc2` to the friend: calibrate (< 30 s), grade a clip with the pad only (warm the lift, pull gain down, raise gamma, fine with RB, reset node, toggle node, bypass, undo bursts), move the Resolve window (still works), resize it (`RECALIBRATE`), recalibrate; recording + Console log back. Run `watchdog`: real mouse mid-drive, monitor boundaries, Windows DPI 125/150/200 %.

### Phase 6: packaging and v0.1.0 (1–2 days)

`release.yml` on tag: NSIS + portable `.exe` (x64), `.dmg` + `.zip` (arm64, labelled **Preview**), `SHA256SUMS`, published with `scripts/gh-as-aryan`. **Unsigned** (signing later; keep `electron-builder` signing config stubbed). README: 60-s GIF from the friend's recording, the layout cheat sheet (`canvas-design`), the ⌨ checklist, SmartScreen / right-click → Open / Accessibility steps, "macOS re-asks for Accessibility after each update until signing exists", FAQ (Free vs Studio, why color uses the wheels, why no Speed Editor emulation, wired Xbox on Mac, Steam Input). Done: the friend installs v0.1.0 from the Release page without a call and it works.

### Phase 7: friend acceptance → v0.2

Every "I expected X" from the friend becomes an issue; fix the top five; tag v0.2.0. Then, in order: code signing (Apple Developer ID + Windows), a Mac-with-Resolve tester to lift the Preview label, PlayStation layout + haptics polish, Linux build, community profiles (Premiere, FCP).

**Later research (not v1):** a Tangent-protocol path (Resolve talks to Tangent Hub over local TCP; a fake hub could send exact trackball/ring deltas without moving the cursor). Unverified whether Free 21.1 supports Tangent panels, and Tangent's developer-kit licence terms are unknown; only revisit if `pointer` feels bad and someone with Resolve can run it. The `script` backend, if a Studio user volunteers.

## Standards

- TypeScript strict; no `any` outside the addon boundary; `zod` at every IPC and file boundary.
- Engine: zero runtime deps, no Electron/Node imports, no timers.
- Conventional commits; short-lived branches + PRs (even solo); squash merge. All `gh` through `scripts/gh-as-aryan`.
- Every PR: lint, typecheck, Vitest, `cargo clippy -D warnings`, addon + probe + harness build on Windows and macOS.
- Tests: engine ≥ 90 % lines; injector tested against a fake that records commands and against the harness; one Playwright-electron smoke test.
- Security: inject only while the gate matches; no `eval`; no network egress from the app; `pnpm audit` in CI; pinned deps.
- Observability: rolling in-app log (last 2000 events: frame diffs, commands, gate changes, queue, drives, errors), exportable for the friend's reports. Injection errors and native panics are caught, logged and trigger `releaseAll`.
- Docs: `ARCHITECTURE.md` updated in the same PR as any decision; `docs/profiles.md` generated from the zod schema and keymap.

Things NOT to do:
- Do not run `gh auth switch`, change global git config, or push as anyone but AryanJ129.
- Do not install Resolve on Aryan's Mac or assume it's there; Resolve checks go through the friend.
- Do not use nut.js, robotjs or node-enigo; do not use gilrs or raw HID for Xbox pads on macOS; do not read pads through the browser Gamepad API on Windows.
- Do not send arrows/Home/End/Ins/Del/PgUp/PgDn on Windows without `KEYEVENTF_EXTENDEDKEY`.
- Do not bypass the output queue; do not interleave a combo with other output.
- Do not run two wheel drives at once or hop the cursor between wheels mid-push.
- Do not inject when the gate doesn't match or a modal dialog is up; never inject into our own windows.
- Do not implement Speed Editor / Blackmagic panel emulation; no AGPL code (e.g. blackmacro-lib); no code copied from source-available projects (ControllerKeys).
- Do not put "DaVinci" or "Resolve" in the product name, package name or bundle id.
- Do not make any feature depend on scripting or Studio. Do not build the shelved `script` backend.
- Do not invent Resolve API calls or shortcuts: unknown defaults are `null` in the keymap until verified.
- Do not add telemetry, crash reporting or auto-update in v1.
- Do not read window titles on macOS (Screen Recording prompt).
- Do not warp the cursor while a mouse button is held.
- Do not claim a feature in the README that isn't covered by a test or a recording.
- Do not delete files on Aryan's machine to free space; ask.

## CLAUDE.md (commit verbatim in Phase 0)

```markdown
# Jogstick — rules for Claude Code
Owner: Aryan (GitHub AryanJ129, personal account). Read BUILD_BRIEF.md and ARCHITECTURE.md first.
Operating mode: `shai`. Golden Rule: read what exists fully before changing it. Diagnose before treating. Deep, not wide.
GitHub: every gh call via scripts/gh-as-aryan; git uses the repo-local credential helper. Never `gh auth switch` (BusinessSTR is the active account for other work). Never global git config.
Machines: Aryan's MacBook Air M3 has NO Resolve and won't get it. The friend's Windows PC (Resolve Free 21.1.1, Xbox pad) is the only Resolve test rig, reached through jogstick-probe and release candidates.
Disk: check `df -h ~` before installs; under 20 GB free → stop and ask. Never delete Aryan's files.
Done = verified on hardware (harness on the Mac, the friend's report/recording on Windows). Not a green test.
Resolve facts: Python scripting is Studio-only from 21.1; color uses the `pointer` backend; SetCDL is write-only; Graph can't add/select/label nodes.
Input facts: Windows pads via XInput in the addon; macOS via the Gamepad API in a hidden renderer. Windows nav keys carry KEYEVENTF_EXTENDEDKEY. macOS events carry full flags; modifiers go out as flagsChanged. All output goes through the serialized output queue.
Never: nut.js/robotjs/node-enigo, gilrs on macOS, Gamepad API on Windows, Speed Editor emulation, AGPL or source-available code, telemetry, eval, injecting when the gate doesn't match, two drives at once, warping mid-drag.
Commands: pnpm i · pnpm dev · pnpm test · pnpm lint · pnpm -F engine test · pnpm -F native build · pnpm engine:replay <fixture> · pnpm release:dry
Skills: brand-kit (Phase 1) → frontend-craft/frontend-design (Phase 4) → canvas-design (Phase 6) → watchdog (end of 3, 5, 6).
```

## Done criteria

- [ ] `github.com/AryanJ129/jogstick` public, MIT, every commit authored by AryanJ129, CI green on Windows/macOS/Ubuntu; BusinessSTR still the active `gh` account afterwards.
- [ ] Probe reports (Spikes A–C) and the friend's keyboard preset received; numbers and decisions in `ARCHITECTURE.md`; keymap `verified` flags set.
- [ ] `brand/` complete and approved by Aryan at Stage 3.
- [ ] Engine semantics tests + property tests pass on all CI OSes.
- [ ] Mac: every command verified against `jogstick-harness`; `releaseAll` and the gate behave.
- [ ] Friend, Windows + Resolve Free: 10-cut edit, analog jog, shuttle, dialog pause, from rc1; recording in the README.
- [ ] Mapping editor: remap, export, import, works.
- [ ] Friend: Color mode calibrated in under 30 s and a clip graded with the pad, from rc2; inert-and-explained after a window resize.
- [ ] `v0.1.0` Release with Windows (x64) and macOS (arm64, Preview) artifacts and checksums; the friend installed it without a call.
- [ ] `watchdog` reviewed host + addon, Color backend, and the release; findings fixed or filed.

## Decisions (answered by Aryan, 2026-10-28)

- **Friend's setup:** Windows, Resolve Free 21.1.1, Xbox controller. The only Resolve test rig.
- **Aryan's Mac:** MacBook Air M3, macOS 15.6.1, no Resolve, not installing it. Dev + harness only.
- **GitHub:** personal account AryanJ129 (already logged in with `repo` + `workflow`; no reconnect needed), pinned per-repo; BusinessSTR stays the active account.
- **Commits:** AryanJ129's GitHub noreply address.
- **Name:** Jogstick. **Signing:** later.
- **Profile format:** commands, not raw combos (adopted). **Tangent path:** later research, not v1.
- **PlayStation pads:** allowed-but-untested on macOS in v0.1; not offered on Windows until v0.2+ (XInput can't read them).
