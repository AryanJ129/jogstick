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
