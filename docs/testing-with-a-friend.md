# Testing Jogstick on Windows with DaVinci Resolve

Thanks for helping. Jogstick turns an Xbox controller into an editing surface for DaVinci Resolve. Before
building the app, we need to know three things that only a real PC running Resolve can tell us. A
small program, `jogstick-probe.exe`, guides you through each test and writes down the results.

**Time:** about an hour, in three parts (one per test; you can do them on different days).
**You need:** Windows 10/11, DaVinci Resolve (Free is fine), an Xbox controller, a throwaway Resolve project.
**Privacy:** the probe makes no network connections. It reads the controller, sends keys and mouse
movements to Resolve **only while Resolve is the window in front**, and saves results in a folder next to itself.

## Once your controller is connected

1. Plug the controller in: USB cable, Xbox Wireless Adapter, or Bluetooth.
2. Open Resolve **normally** (not as administrator) with a throwaway project.
3. Start `jogstick-probe.exe` (see Download and First launch below).
4. Pick **Test 1** (type `1`, press Enter).
5. Check the controller **buzzes** when the probe finds it. The probe asks you; if it didn't, see
   "Before the tests" below.

## 1. Download

1. Open the release page: <https://github.com/AryanJ129/jogstick/releases/tag/probe-v0.1.1>
2. Download `jogstick-probe.exe`. Put it in its own folder, e.g. `Downloads\jogstick`.
3. Optional: compare its SHA-256 with `SHA256SUMS` on the release page. In PowerShell:
   `Get-FileHash .\jogstick-probe.exe`

## 2. First launch (Windows SmartScreen)

The probe isn't code-signed yet, so Windows warns you the first time:

1. Double-click `jogstick-probe.exe`.
2. If you see **"Windows protected your PC"**, click **More info**, then **Run anyway**.
3. A black console window opens with a menu. Each test below starts from that menu
   (type the number, press Enter).

## 3. Before the tests

- **Controller vibration on.** The probe uses short buzzes to tell you when each step starts and ends.
  Vibration is on by default; if you've turned it off (for example in the Xbox Accessories app or in
  Steam's controller settings), turn it back on.
- **Xbox Game Bar enabled** (Settings → Gaming → Xbox Game Bar). Test 3 asks you to record the screen
  with **Win + Alt + R**, which only works when Game Bar is on.
- **Steam closed** if you can. Steam can also map the controller to keys; the probe records whether it was running.
- **Resolve not running as administrator**, unless a test asks you to.

### How answering works

The probe asks short questions in its window. Type `y` or `n` and press Enter. For numbers (an Edit
Index count, a timecode like `01:00:12:05`, wheel values like `0.00 0.03 -0.01 -0.02`), type them and press Enter.

If you're not sure, type **`?`** and press Enter (for number questions, Enter on its own works too). The
probe records "not sure" for that question and moves on. It isn't counted as a failure, and nothing is
undone or redone on a guess.

## 4. Test 1: controller (`1` pad), about 15 minutes

Checks that the controller keeps being read while Resolve is the active window. The probe checks for
missed input by itself, using the controller's own change counter, so you don't need to count perfectly.

1. Open Resolve with any project. Connect the controller.
2. **Take Resolve out of full screen** (Workspace → Full Screen Window, so it's off) and make its window smaller.
3. Start the probe and choose `1`. It buzzes the controller and asks whether you felt it. Then read the five steps it prints.
4. **Put the probe window beside Resolve** so you can see both, press Enter in the probe, then switch to Resolve
   with **Alt+Tab**. From now on Resolve stays in front; you only watch the probe window.
5. Do the steps. The controller buzzes once when a step starts and twice when it ends:
   1. Press **A** about **100** times, then hold **Y** for 1 second.
   2. Move the **left stick** in circles and to every edge for 30 seconds.
   3. Squeeze **LT** slowly and release, then **RT**, then quick pulls, for 15 seconds.
   4. **View + Menu** together ×5, **View** alone ×5, hold **LB** and press **A** ×5, then hold **Y** for 1 second.
   5. Leave it until 10 minutes have passed (two buzzes).
6. Switch back to the probe window and answer the last question.

**Laptop only, Test 1 only:** please run Test 1 a second time **unplugged** (on battery). Tests 2 and 3
don't need a battery run. Results add up in the same file.

## 5. Test 2: keys (`2` keys), about 20 minutes

Checks that Resolve accepts the keys Jogstick will send, how fast it can take them, and the slow-shuttle trick.

Set up first (the probe repeats this):

- Edit page, a **new empty timeline**. Note its frame rate.
- Effects → Toolbox → Generators → drag **Solid Color** onto V1, and drag its end out to **at least 3 minutes**.
- Open the **Edit Index** (top-left of the Edit page): you'll read how many events it lists.
- Put the playhead in the middle of the clip, then click once on an empty part of the timeline (below the
  clip) so the timeline has keyboard focus.

Then follow the probe. Each time it says _"Switch to Resolve with Alt+Tab"_, do that **with Alt+Tab, not
by clicking inside Resolve** (a click on the timeline ruler moves the playhead and spoils the measurement),
and keep your hands off the mouse and keyboard until it says _"Switch back to this window"_. It asks you to
read the Edit Index count or the timecode above the viewer, and to answer y/n questions.

Step 4 sends arrow keys with a deliberate bug, so the playhead **not** moving properly there is the expected result.
Step 6 (Resolve as administrator) is optional.

## 6. Test 3: color wheels (`3` wheel), about 20 minutes

Checks how Resolve's color wheels react to mouse drags.

1. Color page, a clip selected, **Workspace → Full Screen** mode on, the **Primaries – Color Wheels** palette showing.
2. Start a screen recording: click on Resolve, press **Win + Alt + R** (Xbox Game Bar). Press it again at the end.
   The video lands in `Videos\Captures`.
3. In the probe choose `3`. You mark three points by hovering the mouse and pressing **A** on the controller:
   the centre of the **Lift** wheel, the centre of the **Offset** wheel, and the **Lift master dial** under the Lift wheel.
4. The probe adds a fresh node (Alt+S) and runs seven short drags. After each one it asks whether the wheel
   changed; if it did, you type the numbers shown under the wheel and the probe undoes the change (Ctrl+Z).
   Switch to Resolve with Alt+Tab when asked, as in Test 2.
5. Delete the extra node when it's done.

## 7. Export your Resolve keyboard shortcuts

DaVinci Resolve → **Keyboard Customization** (Ctrl+Alt+K) → the **⋯** menu at the top right → **Export Preset** →
save the file. This lets us check every shortcut Jogstick will use against your actual setup.

## 8. Send back

1. Zip the **`jogstick-probe-results`** folder (it's next to `jogstick-probe.exe`).
2. Send Aryan: that zip, the exported keyboard preset file, and the screen recording from Test 3.

If anything goes wrong (a crash, a stuck key, a confusing question), write down what you saw. Stuck keys:
press and release Ctrl, Shift and Alt once each.
