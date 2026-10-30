# Jogstick v0.1.0-rc2 — tester checklist (Windows)

About 20 minutes. Edit mode only; Color mode comes in a later rc. Thank you!

## Set up (5 min)

1. Unzip `Jogstick-0.1.0-rc.2-windows-x64.zip` anywhere (e.g. your Desktop) and run
   **`Jogstick.exe`** inside the folder. Windows says "Windows protected your PC" because the app
   isn't signed yet: click **More info → Run anyway**. If instead an error says Jogstick **could
   not load its input module**, it has already saved a `jogstick-report-<date>.zip` (the message
   says where): send that file and stop there.
2. Nothing opens: Jogstick lives in the **tray** (click the **^** by the clock if you don't see its
   icon). Right-click it for the menu.
3. Connect the Xbox controller, any of three ways. It **buzzes once** when Jogstick has it.
   - **USB cable:** plug it in; Windows sets it up by itself.
   - **Bluetooth** (Xbox One S controllers and newer: the plastic around the Xbox button matches the
     face): hold the small **pair** button on top until the Xbox button flashes fast, then Windows
     Settings → Bluetooth & devices → **Add device** → Bluetooth → **Xbox Wireless Controller**.
   - **Xbox Wireless Adapter** (the USB dongle): plug it in, press its button, then hold the
     controller's **pair** button until the Xbox button stays lit.
4. Open **DaVinci Resolve normally** (not "Run as administrator"), open a project with some clips on
   the Edit page timeline, and click the timeline once. A small **EDIT** label appears in the corner
   and fades after a moment.
5. If the tray menu shows **⚠ Steam is running**: in Steam → Settings → Controller, set **Desktop
   Layout** to none (or quit Steam) — otherwise Steam may also turn the pad into keys and every press
   happens twice.

## The three tests

Record your screen for each test (Win+Alt+R starts and stops the Xbox Game Bar recorder; the
videos land in Videos\Captures) so we can see the label and the timeline together.

- [ ] **1. A 10-cut rough edit using only the pad.** Jog to a spot, **A** to cut (Blade at
      playhead, Ctrl+B), carry on until there are 10 cuts. Then remove a few pieces with **LB + A** (ripple
      delete) and undo/redo with **View / Menu**. Use the keyboard and mouse for nothing.
- [ ] **2. A 2-minute scrub with stick and triggers.** Left stick left/right jogs frame by frame
      (further = faster, all the way = one second at a time). **RT** plays forward, **LT** backward:
      pull harder for faster; let go and it stops. Mix them for two minutes. Note anything that keeps
      moving after you let go, or a frame step that gets lost.
- [ ] **3. The pad pauses when a dialog opens.** With Resolve in front, open any dialog (e.g.
      **File → Project Settings…**). The label shows **PAUSED · DIALOG**
      and the pad does nothing. Close the dialog: the pad works again. Also switch to another app
      (e.g. your browser) and press a few buttons — nothing should happen there.

## Send back

1. **The test report:** tray icon → **Export test report**. It saves
   `jogstick-report-<date>.zip` next to `Jogstick.exe` and tells you where. It holds Jogstick's
   own log and settings only: no personal files, and nothing is sent anywhere.
2. **The screen recordings** of the three tests.
3. **Your exported keyboard preset** from Resolve: DaVinci Resolve → **Keyboard Customization**
   (Ctrl+Alt+K) → the **⋯** menu at the top right → **Export Preset**.
4. **The probe results zip** from `jogstick-probe`, if you haven't sent it yet.

## Cheat sheet (Edit mode)

| Control          | Alone                    | Hold **LB** (TRIM)          | Hold **RB** (MARK)             |
| ---------------- | ------------------------ | --------------------------- | ------------------------------ |
| **A**            | Split clip (blade)       | Ripple delete               | Source/timeline viewer         |
| **X**            | Cut (Ctrl+X)             | Ripple cut                  | Select clips forward           |
| **Y**            | Copy                     | Extend edit (E)             | Select nearest clip/gap        |
| **B**            | Paste                    | Paste insert (needs a key¹) | Match frame                    |
| **D-pad ↑ / ↓**  | Previous / next edit     | Trim start / end            | Mark In / Out                  |
| **D-pad ← / →**  | Step one frame (repeats) | Nudge left / right          | Ripple start / end to playhead |
| **Left stick ↔** | Jog                      | Slow jog                    | —                              |
| **Left stick ↕** | Zoom in / out            | Zoom to fit                 | —                              |
| **Right stick**  | Mouse pointer            | —                           | —                              |
| **R3** (click)   | Mouse click              | —                           | —                              |
| **L3** (click)   | Play / pause             | Play around                 | Clear In/Out                   |
| **LT / RT**      | Shuttle back / forward   |                             |                                |
| **View / Menu**  | Undo / redo              |                             |                                |

¹ Resolve has no default shortcut for Paste insert, so LB + B does nothing yet (the Console notes it).
**View + Menu together** switches to Color mode (the label shows COLOR; it isn't part of this test
and its wheels arrive in a later rc); press them together again to come back to EDIT.

**If something seems stuck** (a key acting as if held down): switch to another app and back.
Jogstick releases everything the moment Resolve isn't in front, and also when the controller
disconnects, the PC sleeps or the screen locks. Please note when it happened for the report.
