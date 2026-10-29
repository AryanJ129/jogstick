# Quick start

What you do once the controller is connected. This page is also the spec for Jogstick's first-run
screens: each step names what the app shows, and anything not built yet says when it lands.

Jogstick only sends keys and mouse movements while **DaVinci Resolve's main window is in front** with
no dialog open. Switch to any other app (or open a Resolve dialog) and the pad goes quiet until you come back.

## Windows

1. **Install.** Download the installer (or the portable `.exe`) from the Releases page and run it. The
   app isn't code-signed yet, so Windows shows "Windows protected your PC": click **More info → Run
   anyway**. _(Releases with the app: coming in Phase 6.)_
2. **Connect the controller** by USB, the Xbox Wireless Adapter or Bluetooth. The Status screen shows
   **Controller connected** and the pad **buzzes once**. _(Status screen: coming in Phase 4; the
   connection buzz: coming in Phase 3.)_
3. **Open Resolve normally**, not with "Run as administrator" (Windows blocks keys from normal apps
   to elevated ones, and Jogstick warns you on the Status screen if it detects this). Click the
   timeline once so it has keyboard focus. The on-screen label shows **EDIT**. _(Overlay label:
   coming in Phase 3.)_
4. **Bind or skip the commands Resolve has no default shortcut for:** Paste insert, Previous node and
   Next node. The **Setup** screen lists them. For each one, either pick a free key (Jogstick suggests
   F13–F19) and add that shortcut in Resolve's Keyboard Customization, or skip it, which leaves that
   pad button unbound. _(Setup screen: coming in Phase 4. Until then, see "Remapping before the
   editor exists" below.)_
5. **Edit.** Left stick jogs, triggers shuttle, LB and RB hold layers (the label shows `EDIT · TRIM`
   or `EDIT · MARK`), View/Menu are undo/redo. The full layout is in `docs/profiles.md`.
   _(Coming in Phase 3.)_
6. **Color.** Go to the **Color** page, turn on **Workspace → Full Screen**, and make sure the
   **Primaries – Color Wheels** palette is visible. Press **View + Menu** together to switch to
   Color mode (the label shows **COLOR**). The first time, run the **three-point calibration**: hover
   the mouse over the Lift wheel centre, the Offset wheel centre and the Lift master dial, pressing **A**
   on each. If you later resize Resolve or change displays, the label shows **RECALIBRATE**.
   _(Color mode and calibration: coming in Phase 5.)_
7. **Pause** any time from the **tray icon** (or the Pause toggle on the Status screen). _(Coming in Phase 3.)_

## macOS

The same steps as Windows, with these differences:

- **Install.** Open the `.dmg` and drag Jogstick to Applications. It isn't signed with an Apple
  Developer ID yet, so the first time, **right-click the app → Open**. _(Coming in Phase 6.)_
- **Accessibility grant (first launch).** macOS only lets apps send keys and mouse events after you
  allow them: System Settings → Privacy & Security → **Accessibility** → turn on **Jogstick**. The
  Setup screen shows whether the grant is active and has a button that opens the right settings page.
  Until the app is signed, macOS asks again after each update. _(Coming in Phases 3–4.)_
- **Wired Xbox controllers.** Over USB, macOS reads only the **Xbox One S** (`045E:02EA`), **Elite
  Series 2** (`045E:0B00`) and **Series X|S** (`045E:0B12`) controllers. Every other Xbox controller
  must be paired over **Bluetooth**.
- **Preview.** The macOS build is labelled **Preview** until someone verifies it with Resolve on a Mac.

## Remapping

Every pad control can be remapped, per mode and per layer. See `ARCHITECTURE.md` → Remapping for how
it works.

- **Mapping screen:** click a control on the controller picture (or press it), then choose a Resolve
  command, record a key combo, or pick a mouse action, a macro, or nothing. _(Coming in Phase 4.)_
- **Commands screen:** if you changed Resolve's shortcuts, tell Jogstick the new key for each
  command, or import your exported Resolve keyboard preset. _(Coming in Phase 4; preset import once
  we know the file format.)_
- **Profiles screen:** duplicate, export, import, reset to default. The shipped Resolve profile is
  never edited; your changes always live in a copy. _(Coming in Phase 4.)_

### Remapping before the editor exists

From Phase 3 you can remap by editing JSON files in Jogstick's user data folder. They are reloaded as
soon as you save; an invalid file is rejected with an error in the Console and the last good version
stays active. Paths and an example (swap X and B) are in `ARCHITECTURE.md` → Remapping → (c).
