# Jogstick

An open-source desktop app that turns an Xbox controller into an editing surface for DaVinci Resolve
(analog jog, trigger shuttle, layers, color wheels), built to work on Resolve Free.

**Status: early development. There is no app to install yet.** Right now the repo contains the
engine and native layer under construction, plus `jogstick-probe`, a tool testers run to measure how
Resolve on their machine responds (see [docs/testing-with-a-friend.md](docs/testing-with-a-friend.md)).

Features are listed here only once a test or a recording covers them.

Not affiliated with Blackmagic Design or Microsoft. "for DaVinci Resolve" describes compatibility only.

## Getting started

There's no app to install yet; this is what first run will look like. Full steps, including macOS:
[docs/quick-start.md](docs/quick-start.md).

1. Install (Windows SmartScreen: **More info → Run anyway**). _(Coming in Phase 6.)_
2. Connect the controller (USB, Xbox Wireless Adapter or Bluetooth): Status shows **Controller
   connected** and the pad buzzes once. _(Coming in Phases 3–4.)_
3. Open Resolve normally (not as administrator) and click the timeline once: the overlay shows
   **EDIT**. _(Coming in Phase 3.)_
4. On the Setup screen, bind or skip the commands Resolve has no default shortcut for (Paste insert,
   Previous/Next node). _(Coming in Phase 4.)_
5. For color: Color page, Workspace → Full Screen, Primaries – Color Wheels visible, **View + Menu**
   to switch, then the three-point calibration. _(Coming in Phase 5.)_
6. Pause from the tray. Jogstick only acts while Resolve's main window is in front.

Every control can be remapped; see [ARCHITECTURE.md → Remapping](ARCHITECTURE.md#remapping-first-class).

## Development

```sh
pnpm i
pnpm test                      # engine tests
pnpm -F @jogstick/native build # Node addon (Rust)
scripts/harness-mac.sh         # macOS: injection self-test against jogstick-harness
```

See `BUILD_BRIEF.md` (the spec) and `ARCHITECTURE.md` (what's built and why).

MIT licence.
