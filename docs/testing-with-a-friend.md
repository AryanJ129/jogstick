# Testing Jogstick on Windows with DaVinci Resolve

Thanks for helping. Jogstick turns an Xbox controller into an editing surface for DaVinci Resolve. Before
building the app, we need to know three things that only a real PC running Resolve can tell us. A
small program, `jogstick-probe.exe`, guides you through each test and writes down the results.

**Time:** about 40 minutes in total, in three sittings if you like.
**You need:** Windows 10/11, DaVinci Resolve (Free is fine), an Xbox controller, a throwaway Resolve project.
**Privacy:** the probe makes no network connections. It reads the controller, sends keys and mouse
movements to Resolve **only while Resolve is the window in front**, and saves results in a folder next to itself.

## 1. Download

1. Open the release page (the link Aryan sent you, under `github.com/AryanJ129/jogstick/releases`).
2. Download `jogstick-probe.exe`. Put it in its own folder, e.g. `Downloads\jogstick`.
3. Optional: compare its SHA-256 with `SHA256SUMS` on the release page. In PowerShell:
   `Get-FileHash .\jogstick-probe.exe`

## 2. First launch (Windows SmartScreen)

The probe isn't code-signed yet, so Windows warns you the first time:

1. Double-click `jogstick-probe.exe`.
2. If you see **"Windows protected your PC"**, click **More info**, then **Run anyway**.
3. A black console window opens with a menu. Each test below starts from that menu
   (type the number, press Enter).

Run Resolve **normally**, not as administrator, unless a test asks you to. Close Steam if it's open,
or note that it was open (Steam can also map the controller; the probe records whether it's running).

## 3. Test 1: controller (`1` pad), about 12 minutes

Checks that the controller keeps being read while Resolve is the active window.

1. Open Resolve with any project. Connect the controller.
2. Start the probe and choose `1`. Read the five steps it prints.
3. **Put the probe window beside Resolve** so you can see both, press Enter, then switch to Resolve
   with **Alt+Tab**. From now on Resolve stays in front; you only watch the probe window.
4. Do the steps. The controller buzzes once when a step starts and twice when it ends:
   1. Press **A** exactly **100** times, counting yourself (the probe hides its count), then hold **Y** for 1 second.
   2. Move the **left stick** in circles and to every edge for 30 seconds.
   3. Squeeze **LT** slowly and release, then **RT**, then quick pulls, for 15 seconds.
   4. **View + Menu** together ×5, **View** alone ×5, hold **LB** and press **A** ×5, then hold **Y** for 1 second.
   5. Leave it until 10 minutes have passed (two buzzes).
5. Click the probe window and answer the question.

If you're on a laptop, please run Test 1 a second time **unplugged** (on battery). Results add up in the same file.

## 4. Test 2: keys (`2` keys), about 15 minutes

Checks that Resolve accepts the keys Jogstick will send, how fast it can take them, and the slow-shuttle trick.

Set up first (the probe repeats this):

- Edit page, a **new empty timeline**. Note its frame rate.
- Effects → Toolbox → Generators → drag **Solid Color** onto V1, and drag its end out to **at least 3 minutes**.
- Open the **Edit Index** (top-left of the Edit page): you'll read how many events it lists.
- Put the playhead in the middle of the clip, then click once on an empty part of the timeline (below the
  clip) so the timeline has keyboard focus.

Then follow the probe. Each time it says _"Switch to Resolve with Alt+Tab"_, do that **with Alt+Tab, not
by clicking inside Resolve** (a click on the timeline ruler moves the playhead and spoils the measurement),
and keep your hands off the mouse and keyboard until it says _"Switch back to this window"_. It asks you to read the Edit
Index count or the timecode above the viewer, and to answer y/n questions. Typing `?` is fine when you're unsure.

Step 4 sends arrow keys with a deliberate bug, so the playhead **not** moving properly there is the expected result.
Step 6 (Resolve as administrator) is optional.

## 5. Test 3: color wheels (`3` wheel), about 15 minutes

Checks how Resolve's color wheels react to mouse drags.

1. Color page, a clip selected, **Workspace → Full Screen** mode on, the **Primaries – Color Wheels** palette showing.
2. Start a screen recording: click on Resolve, press **Win + Alt + R** (Xbox Game Bar). Press it again at the end.
   The video lands in `Videos\Captures`.
3. In the probe choose `3`. You mark three points by hovering the mouse and pressing **A** on the controller:
   the centre of the **Lift** wheel, the centre of the **Offset** wheel, and the **Lift master dial** under the Lift wheel.
4. The probe adds a fresh node (Alt+S) and runs seven short drags. After each one it asks whether the wheel
   changed; if it did, you type the numbers shown under the wheel (e.g. `0.00 0.03 -0.01 -0.02`) and the
   probe undoes the change (Ctrl+Z). Switch to Resolve with Alt+Tab when asked, as in Test 2.
5. Delete the extra node when it's done.

## 6. Export your Resolve keyboard shortcuts

DaVinci Resolve → **Keyboard Customization** (Ctrl+Alt+K) → the **⋯** menu at the top right → **Export Preset** →
save the file. This lets us check every shortcut Jogstick will use against your actual setup.

## 7. Send back

1. Zip the **`jogstick-probe-results`** folder (it's next to `jogstick-probe.exe`).
2. Send Aryan: that zip, the exported keyboard preset file, and the screen recording from Test 3.

If anything goes wrong (a crash, a stuck key, a confusing question), write down what you saw. Stuck keys:
press and release Ctrl, Shift and Alt once each.
