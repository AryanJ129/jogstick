//! jogstick-probe: guided hardware checks a tester runs on Windows with DaVinci
//! Resolve, without a developer present. Results go to
//! `jogstick-probe-results/` next to the exe: `report.json` plus recorded pad
//! frames (`*.frames.json`). Zip the folder and send it back.
//!
//!   jogstick-probe            menu
//!   jogstick-probe pad        Spike A: pad input while Resolve has focus
//!   jogstick-probe keys       Spike B: keystrokes reach Resolve
//!   jogstick-probe wheel      Spike C: mouse drags on the color wheels
//!   jogstick-probe info       machine info only

#[cfg(not(windows))]
fn main() {
    eprintln!("jogstick-probe runs on Windows (it talks to Resolve on the tester's PC).");
    eprintln!("On macOS, verify injection with: jogstick-harness --self-test");
    std::process::exit(1);
}

#[cfg(windows)]
fn main() {
    win::main();
}

#[cfg(windows)]
mod win {
    use jogstick_native::app_win::{self, Elevation};
    use jogstick_native::combo::{parse, Os};
    use jogstick_native::injector::{Backend, Injector, KeyOpts, MouseBtn};
    use jogstick_native::keymap::lookup;
    use jogstick_native::pad::{btn, PadFrame};
    use jogstick_native::pad_win;
    use jogstick_native::probe::{self, derive_wheel_points, rate_stats, timecode_to_frames, Pt, Report, WHEEL_NAMES};
    use jogstick_native::PlatformBackend;
    use serde_json::{json, Value};
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    const RESOLVE: &str = "Resolve.exe";

    // ---------- console helpers ----------

    fn say(s: &str) {
        println!("{s}");
    }

    fn heading(s: &str) {
        println!("\n=== {s} ===");
    }

    fn ask(q: &str) -> String {
        print!("{q} ");
        let _ = std::io::stdout().flush();
        let mut line = String::new();
        let _ = std::io::stdin().read_line(&mut line);
        line.trim().to_string()
    }

    fn ask_yn(q: &str) -> Option<bool> {
        loop {
            match ask(&format!("{q} [y/n/?]")).to_ascii_lowercase().as_str() {
                "y" | "yes" => return Some(true),
                "n" | "no" => return Some(false),
                "?" | "unsure" | "u" => return None,
                _ => say("  Please type y, n, or ? if unsure."),
            }
        }
    }

    fn ask_num(q: &str) -> Option<f64> {
        loop {
            let a = ask(q);
            if a.is_empty() || a == "?" {
                return None;
            }
            match a.parse::<f64>() {
                Ok(v) => return Some(v),
                Err(_) => say("  Please type a number (or ? to skip)."),
            }
        }
    }

    fn ask_floats(q: &str, n: usize) -> Option<Vec<f64>> {
        loop {
            let a = ask(q);
            if a.is_empty() || a == "?" {
                return None;
            }
            let v: Result<Vec<f64>, _> =
                a.split([' ', ',', '\t']).filter(|s| !s.is_empty()).map(str::parse::<f64>).collect();
            match v {
                Ok(v) if v.len() == n => return Some(v),
                _ => say(&format!("  Please type {n} numbers separated by spaces (or ? to skip).")),
            }
        }
    }

    fn ask_timecode(q: &str, fps: u32) -> Option<i64> {
        loop {
            let a = ask(q);
            if a.is_empty() || a == "?" {
                return None;
            }
            match timecode_to_frames(&a, fps) {
                Ok(f) => return Some(f),
                Err(e) => say(&format!("  {e}. Type it like 01:00:12:05 (or ? to skip).")),
            }
        }
    }

    fn pause(q: &str) {
        let _ = ask(&format!("{q} (press Enter)"));
    }

    fn now_unix() -> u64 {
        SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
    }

    /// Wait until Resolve's main window is frontmost (a click on its timeline), then settle.
    fn wait_for_resolve(secs: u64) -> bool {
        say(&format!("  → Now click once on Resolve's timeline. Waiting up to {secs} s…"));
        let deadline = Instant::now() + Duration::from_secs(secs);
        while Instant::now() < deadline {
            if let Some(fg) = app_win::foreground() {
                if fg.exe.as_deref().is_some_and(|e| e.eq_ignore_ascii_case(RESOLVE)) {
                    if fg.has_owner {
                        say("  Resolve has a dialog open; close it first.");
                    } else {
                        std::thread::sleep(Duration::from_millis(700));
                        return true;
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        say("  Resolve never came to the front. Skipping this step.");
        false
    }

    fn resolve_focused() -> bool {
        app_win::foreground()
            .is_some_and(|f| !f.has_owner && f.exe.as_deref().is_some_and(|e| e.eq_ignore_ascii_case(RESOLVE)))
    }

    // ---------- results folder ----------

    fn results_dir() -> PathBuf {
        let base = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(Path::to_path_buf))
            .unwrap_or_else(|| PathBuf::from("."));
        let dir = base.join("jogstick-probe-results");
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    fn machine_info() -> Value {
        let ver = std::process::Command::new("cmd")
            .args(["/c", "ver"])
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
        json!({
            "windowsVersion": ver,
            "displays": app_win::displays(),
            "power": app_win::power(),
            "probeElevation": app_win::self_elevation(),
            "steamRunning": !app_win::find_processes("steam.exe").is_empty(),
            "resolveRunning": !app_win::find_processes(RESOLVE).is_empty(),
            "padsConnected": pad_win::connected(),
        })
    }

    fn save(report: &mut Report, dir: &Path) {
        report.machine = machine_info();
        match report.save(&dir.join("report.json")) {
            Ok(()) => say(&format!("\nSaved results to {}", dir.display())),
            Err(e) => say(&format!("\nCould not save the report: {e}")),
        }
    }

    pub fn main() {
        let dpi = app_win::set_dpi_aware();
        say(&format!(
            "jogstick-probe {} — hardware checks for Jogstick (github.com/AryanJ129/jogstick)",
            probe::PROBE_VERSION
        ));
        say("It only reads your controller and sends keys/mouse to DaVinci Resolve while Resolve is in front.");
        say("Nothing is sent over the network. Results are saved in a folder next to this program.");
        if !dpi {
            say("(note: couldn't set per-monitor DPI awareness; recorded in the report)");
        }
        let dir = results_dir();
        let mut report = Report::load_or_new(&dir.join("report.json"));
        let arg = std::env::args().nth(1);
        let choice = match arg.as_deref() {
            Some(a) => a.to_string(),
            None => {
                say("\nWhich check?  1) pad   2) keys   3) wheel   4) info   q) quit");
                ask(">")
            }
        };
        let run = match choice.as_str() {
            "1" | "pad" => Some(pad(&dir)),
            "2" | "keys" => Some(keys()),
            "3" | "wheel" => Some(wheel()),
            "4" | "info" => None,
            _ => {
                say("Nothing to do.");
                return;
            }
        };
        if let Some(mut r) = run {
            r["finishedAt"] = json!(now_unix());
            r["dpiAware"] = json!(dpi);
            report.runs.push(r);
        }
        save(&mut report, &dir);
        say("Send the whole jogstick-probe-results folder (zip it) back to Aryan.");
        pause("Done.");
    }

    // ---------- Spike A: pad ----------

    struct Shared {
        frames: Mutex<Vec<PadFrame>>,
        per_second: Mutex<Vec<u32>>,
        polls: AtomicU32,
        disconnected_polls: AtomicU32,
        packet_changes: AtomicU32,
        packet_skips: AtomicU32,
    }

    fn rumble(slot: u32, pulses: u32) {
        for _ in 0..pulses {
            pad_win::rumble_for(slot, 30000, 30000, 120);
            std::thread::sleep(Duration::from_millis(80));
        }
    }

    #[derive(Clone, Copy, PartialEq, Debug)]
    enum Stage {
        Taps,
        Sweep,
        Triggers,
        Chords,
        Soak,
        Done,
    }

    fn write_frames(dir: &Path, name: &str, frames: &[PadFrame], files: &mut Vec<String>) {
        let file = format!("{name}.frames.json");
        let body = json!({"source": "jogstick-probe pad", "stage": name, "frames": frames});
        if std::fs::write(dir.join(&file), serde_json::to_string(&body).unwrap_or_default()).is_ok() {
            files.push(file);
        }
    }

    fn pad(dir: &Path) -> Value {
        heading("Pad check (about 10 minutes)");
        let mut slots = pad_win::connected();
        for _ in 0..3 {
            if !slots.is_empty() {
                break;
            }
            pause("No Xbox controller found. Connect it (USB, wireless adapter or Bluetooth), then");
            slots = pad_win::connected();
        }
        let Some(&slot) = slots.first() else {
            return json!({"kind": "pad", "error": "no XInput controller connected"});
        };
        let minutes = std::env::args().nth(2).and_then(|m| m.parse::<f64>().ok()).unwrap_or(10.0);
        let power_start = app_win::power();
        say(&format!(
            "Controller found (slot {slot}). Power: {}.",
            match power_start.as_ref().and_then(|p| p.on_ac) {
                Some(true) => "plugged in",
                Some(false) => "on battery",
                None => "unknown",
            }
        ));
        say("What you'll do, with Resolve in front the whole time:");
        say("  1. Press A exactly 100 times, counting yourself (the count stays hidden). Then hold Y for 1 second.");
        say("  2. Move the LEFT stick in full circles and push it to every edge, for 30 seconds.");
        say("  3. Squeeze LT slowly all the way and let go, then RT, then quick pulls on both, for 15 seconds.");
        say("  4. Press View+Menu together 5 times, tap View alone 5 times, then hold LB and press A 5 times. Then hold Y for 1 second.");
        say(&format!("  5. Leave the pad alone (or play with it) until {minutes:.0} minutes have passed. The pad buzzes twice when it's over."));
        say("The pad buzzes once when each step starts and twice when it ends. Put this window beside Resolve so you can watch the step.");
        pause("Ready?");
        if !wait_for_resolve(30) {
            return json!({"kind": "pad", "error": "Resolve never came to the front"});
        }

        let shared = Arc::new(Shared {
            frames: Mutex::new(Vec::new()),
            per_second: Mutex::new(Vec::new()),
            polls: AtomicU32::new(0),
            disconnected_polls: AtomicU32::new(0),
            packet_changes: AtomicU32::new(0),
            packet_skips: AtomicU32::new(0),
        });
        let stop = Arc::new(AtomicBool::new(false));
        let poller = {
            let shared = shared.clone();
            let stop = stop.clone();
            std::thread::spawn(move || {
                let mut last: Option<(u32, PadFrame)> = None;
                let mut sec_start = 0.0;
                let mut sec_count = 0u32;
                pad_win::run(250, slot, &stop, |t, poll| {
                    shared.polls.fetch_add(1, Ordering::Relaxed);
                    if t - sec_start >= 1.0 {
                        shared.per_second.lock().unwrap().push(sec_count);
                        sec_start += 1.0;
                        sec_count = 0;
                    }
                    sec_count += 1;
                    let Some(p) = poll else {
                        shared.disconnected_polls.fetch_add(1, Ordering::Relaxed);
                        return;
                    };
                    let frame = PadFrame::from_xinput(t * 1000.0, p.raw);
                    match &last {
                        Some((pkt, f)) if *pkt == p.packet && f.same_input(&frame) => {}
                        Some((pkt, _)) => {
                            shared.packet_changes.fetch_add(1, Ordering::Relaxed);
                            let skip = p.packet.wrapping_sub(*pkt).saturating_sub(1);
                            shared.packet_skips.fetch_add(skip, Ordering::Relaxed);
                            shared.frames.lock().unwrap().push(frame.clone());
                            last = Some((p.packet, frame));
                        }
                        None => {
                            shared.frames.lock().unwrap().push(frame.clone());
                            last = Some((p.packet, frame));
                        }
                    }
                })
            })
        };

        let started = Instant::now();
        let mut stage = Stage::Taps;
        let mut stage_frames: Vec<PadFrame> = Vec::new();
        let mut files = Vec::new();
        let mut prev: Option<PadFrame> = None;
        let mut a_taps = 0u32;
        let mut y_down_since: Option<f64> = None;
        let mut stage_started_at: Option<f64> = None;
        let mut sweep_max = [0.0f64; 4];
        let (mut lt_max, mut rt_max) = (0.0f64, 0.0f64);
        let (mut fg_samples, mut fg_resolve) = (0u32, 0u32);
        let mut last_fg = Instant::now();
        let mut last_print = Instant::now();
        rumble(slot, 1);
        say("\nStep 1: press A exactly 100 times, then hold Y for 1 second.");

        while stage != Stage::Done {
            std::thread::sleep(Duration::from_millis(10));
            let t_now = started.elapsed().as_secs_f64() * 1000.0;
            if last_fg.elapsed() >= Duration::from_secs(1) {
                last_fg = Instant::now();
                fg_samples += 1;
                if resolve_focused() {
                    fg_resolve += 1;
                }
            }
            let new: Vec<PadFrame> = std::mem::take(&mut *shared.frames.lock().unwrap());
            for f in new {
                let rose = |i: usize| f.pressed(i) && !prev.as_ref().is_some_and(|p| p.pressed(i));
                match stage {
                    Stage::Taps if rose(btn::A) => a_taps += 1,
                    Stage::Sweep => {
                        if stage_started_at.is_none() && (f.axes[0].abs() > 0.3 || f.axes[1].abs() > 0.3) {
                            stage_started_at = Some(f.t);
                        }
                        for (m, a) in sweep_max.iter_mut().zip(f.axes) {
                            *m = m.max(a.abs());
                        }
                    }
                    Stage::Triggers => {
                        if stage_started_at.is_none() && (f.buttons[btn::LT] > 0.1 || f.buttons[btn::RT] > 0.1) {
                            stage_started_at = Some(f.t);
                        }
                        lt_max = lt_max.max(f.buttons[btn::LT]);
                        rt_max = rt_max.max(f.buttons[btn::RT]);
                    }
                    _ => {}
                }
                if f.pressed(btn::Y) {
                    y_down_since.get_or_insert(f.t);
                } else {
                    y_down_since = None;
                }
                stage_frames.push(f.clone());
                prev = Some(f);
            }
            let y_held = y_down_since.is_some_and(|s| t_now - s >= 1000.0);
            let next = match stage {
                Stage::Taps if y_held => Some(("taps", Stage::Sweep, "Step 2: move the LEFT stick in circles and to every edge for 30 seconds (starts when you move it).")),
                Stage::Sweep if stage_started_at.is_some_and(|s| t_now - s >= 30_000.0) => {
                    Some(("sweep", Stage::Triggers, "Step 3: squeeze LT slowly and release, then RT, then quick pulls, for 15 seconds (starts on the first squeeze)."))
                }
                Stage::Triggers if stage_started_at.is_some_and(|s| t_now - s >= 15_000.0) => {
                    Some(("triggers", Stage::Chords, "Step 4: View+Menu together ×5, View alone ×5, hold LB + press A ×5. Then hold Y for 1 second."))
                }
                Stage::Chords if y_held => Some(("chords", Stage::Soak, "Step 5: leave the pad (or use it casually) with Resolve in front until it buzzes twice.")),
                Stage::Soak if started.elapsed().as_secs_f64() >= minutes * 60.0 => Some(("soak", Stage::Done, "")),
                _ => None,
            };
            if let Some((name, to, msg)) = next {
                if name != "soak" {
                    write_frames(dir, name, &stage_frames, &mut files);
                }
                stage_frames.clear();
                stage_started_at = None;
                y_down_since = None;
                stage = to;
                rumble(slot, 2);
                if to != Stage::Done {
                    std::thread::sleep(Duration::from_millis(300));
                    rumble(slot, 1);
                    say(&format!("\n{msg}"));
                }
            }
            if last_print.elapsed() >= Duration::from_secs(5) {
                last_print = Instant::now();
                let hz = shared.per_second.lock().unwrap().last().copied().unwrap_or(0);
                let pct = (fg_resolve * 100).checked_div(fg_samples).unwrap_or(0);
                say(&format!(
                    "  [{:>4.0} s] reading at {hz} Hz · Resolve in front {pct}% of the time · step {stage:?}",
                    started.elapsed().as_secs_f64()
                ));
            }
        }
        stop.store(true, Ordering::Relaxed);
        let high_res = poller.join().unwrap_or(false);
        let power_end = app_win::power();

        heading("Pad check finished — a few questions (click this window first)");
        let said = ask_num("How many times did YOU press A in step 1? (Enter = 100)").unwrap_or(100.0);
        let per_second = shared.per_second.lock().unwrap().clone();
        // Drop the first second (thread start-up) from the rate statistics.
        let stats = rate_stats(per_second.get(1..).unwrap_or(&[]));
        let fg_pct = if fg_samples > 0 { f64::from(fg_resolve) * 100.0 / f64::from(fg_samples) } else { 0.0 };
        let hz_pass = stats.is_some_and(|s| s.p1 >= 200.0);
        let taps_pass = f64::from(a_taps) == said;
        let focus_pass = fg_pct >= 95.0;
        say(&format!(
            "Rate: {} · taps counted {a_taps} (you said {said}) · Resolve in front {fg_pct:.0}%",
            stats.map_or("n/a".into(), |s| format!(
                "median {} Hz, 1st percentile {} Hz, min {} Hz",
                s.median, s.p1, s.min
            ))
        ));
        say(&format!("Result: rate {} · taps {} · Resolve focused {}", pf(hz_pass), pf(taps_pass), pf(focus_pass)));
        json!({
            "kind": "pad",
            "spike": "A",
            "slot": slot,
            "battery": pad_win::battery(slot),
            "minutes": minutes,
            "durationS": started.elapsed().as_secs_f64(),
            "power": {"start": power_start, "end": power_end},
            "timerHighRes": high_res,
            "targetHz": 250,
            "hz": stats,
            "hzPerSecond": per_second,
            "polls": shared.polls.load(Ordering::Relaxed),
            "disconnectedPolls": shared.disconnected_polls.load(Ordering::Relaxed),
            "packetChanges": shared.packet_changes.load(Ordering::Relaxed),
            "packetSkips": shared.packet_skips.load(Ordering::Relaxed),
            "resolveForegroundPct": fg_pct,
            "foregroundSamples": fg_samples,
            "taps": {"counted": a_taps, "testerSaid": said},
            "sweepMaxAbsAxes": sweep_max,
            "triggerMax": {"lt": lt_max, "rt": rt_max},
            "files": files,
            "pass": {"hzP1AtLeast200": hz_pass, "taps": taps_pass, "resolveFocused95": focus_pass},
        })
    }

    fn pf(b: bool) -> &'static str {
        if b {
            "PASS"
        } else {
            "FAIL"
        }
    }

    // ---------- Spike B: keys ----------

    struct Out {
        inj: Injector<PlatformBackend>,
    }

    impl Out {
        fn new() -> Result<Out, String> {
            Ok(Out { inj: Injector::new(PlatformBackend::new()?) })
        }

        /// Tap `combo` only while Resolve's main window is in front.
        fn tap(&mut self, combo: &str, spacing_ms: u64, opts: KeyOpts) -> Result<(), String> {
            if !resolve_focused() {
                return Err("Resolve is no longer in front".into());
            }
            let c = parse(combo, Os::Windows)?;
            self.inj.tap_combo(&c, Duration::from_millis(spacing_ms), opts)
        }

        fn hold(&mut self, code: &str, down: bool) -> Result<(), String> {
            if down && !resolve_focused() {
                return Err("Resolve is no longer in front".into());
            }
            let k = lookup(code).ok_or("unknown key")?;
            if down {
                self.inj.key_down(k, KeyOpts::default())
            } else {
                self.inj.key_up(k, KeyOpts::default())
            }
        }
    }

    impl Drop for Out {
        fn drop(&mut self) {
            let _ = self.inj.release_all();
        }
    }

    /// Run `n` taps of `combo` at a fixed rate on an absolute schedule (no drift).
    fn tap_at_rate(out: &mut Out, combo: &str, n: u32, hz: f64, opts: KeyOpts) -> Result<u32, String> {
        let start = Instant::now();
        for i in 0..n {
            let due = start + Duration::from_secs_f64(f64::from(i) / hz);
            if let Some(d) = due.checked_duration_since(Instant::now()) {
                std::thread::sleep(d);
            }
            out.tap(combo, 0, opts)?;
        }
        Ok(n)
    }

    fn keys() -> Value {
        heading("Keys check (about 15 minutes)");
        let pids = app_win::find_processes(RESOLVE);
        if pids.is_empty() {
            say("Resolve isn't running. Start DaVinci Resolve and run this check again.");
            return json!({"kind": "keys", "error": "Resolve not running"});
        }
        let resolve_elev: Vec<Value> =
            pids.iter().map(|p| json!({"pid": p, "elevation": app_win::elevation(*p)})).collect();
        let elevated = pids.iter().any(|p| app_win::elevation(*p) != Elevation::NotElevated);
        if elevated {
            say("WARNING: Resolve seems to be running as administrator. Windows blocks keys from normal programs to it.");
            say("For this check, restart Resolve normally (not 'Run as administrator').");
        }
        let steam = !app_win::find_processes("steam.exe").is_empty();
        say("Set up Resolve like this:");
        say("  • Edit page, a NEW empty timeline. Note its frame rate (Timeline settings).");
        say("  • Effects → Toolbox → Generators → drag 'Solid Color' onto V1. Drag its end out to at least 3 minutes. No audio.");
        say("  • Open the 'Edit Index' (button at the top-left of the Edit page) so you can see the list of events.");
        say("  • Put the playhead in the middle of the Solid Color clip.");
        pause("When that's ready");
        let fps = loop {
            match ask_num("Timeline frame rate? (24, 25, 30, 50 or 60; for 23.976 type 24, for 29.97 type 30)") {
                Some(v) if [24.0, 25.0, 30.0, 50.0, 60.0].contains(&v) => break v as u32,
                _ => say("  Please type 24, 25, 30, 50 or 60."),
            }
        };
        let mut out = match Out::new() {
            Ok(o) => o,
            Err(e) => return json!({"kind": "keys", "error": e}),
        };
        let layout_before = app_win::foreground_keyboard_layout();

        // K1: one split.
        heading("1/6 · one split (Ctrl+B)");
        let k1 = if wait_for_resolve(20) {
            let layout = app_win::foreground_keyboard_layout();
            let r = out.tap("Mod+B", 16, KeyOpts::default());
            std::thread::sleep(Duration::from_millis(300));
            say("Click back on this window.");
            json!({"sent": r.is_ok(), "error": r.err(), "split": ask_yn("Did the clip split at the playhead?"), "resolveKeyboardLayout": layout})
        } else {
            json!({"skipped": true})
        };

        // K2: 100 combos at each spacing; counted in the Edit Index.
        heading("2/6 · 100 splits at four speeds");
        say("Each round moves the playhead a few frames and splits, 100 times. You read the number of events in the Edit Index before and after.");
        let mut rounds = Vec::new();
        for spacing in [30u64, 16, 8, 0] {
            say(&format!("\nRound with {spacing} ms between keys:"));
            let before = ask_num("How many events does the Edit Index list right now? (the highest # number)");
            if !wait_for_resolve(20) {
                rounds.push(json!({"spacingMs": spacing, "skipped": true}));
                continue;
            }
            let mut sent = 0u32;
            let mut err = None;
            for _ in 0..100 {
                let r = tap_at_rate(&mut out, "ArrowRight", 4, 28.0, KeyOpts::default())
                    .and_then(|_| out.tap("Mod+B", spacing, KeyOpts::default()));
                if let Err(e) = r {
                    err = Some(e);
                    break;
                }
                sent += 1;
                std::thread::sleep(Duration::from_millis(40));
            }
            let _ = out.inj.release_all();
            say("Click back on this window.");
            let after = ask_num("How many events does the Edit Index list now?");
            let landed = before.zip(after).map(|(b, a)| a - b);
            say(&format!("  sent {sent}, landed {}", landed.map_or("?".into(), |l| l.to_string())));
            rounds.push(json!({"spacingMs": spacing, "sent": sent, "before": before, "after": after, "landed": landed, "error": err}));
        }
        let recommended = rounds
            .iter()
            .filter(|r| r["sent"].as_u64() == Some(100) && r["landed"].as_f64() == Some(100.0))
            .filter_map(|r| r["spacingMs"].as_u64())
            .min();

        // K3: arrows at 30 Hz for 30 s.
        heading("3/6 · 900 frame steps");
        say("Press Home in Resolve if you like (any spot works). Read the timecode shown above the timeline viewer.");
        let arrows = arrow_run(&mut out, fps, 900, KeyOpts::default());

        // K4: same without the extended-key flag (expected to fail).
        heading("4/6 · 300 frame steps with a deliberate bug (expected NOT to move correctly)");
        let arrows_no_ext = arrow_run(&mut out, fps, 300, KeyOpts { force_no_extended: true });

        // K5: slow shuttle.
        heading("5/6 · slow shuttle (K+L and J+K held)");
        let shuttle = if wait_for_resolve(20) {
            let hold = |out: &mut Out, a: &str, b: &str| -> Result<(), String> {
                out.hold(a, true)?;
                std::thread::sleep(Duration::from_millis(60));
                out.hold(b, true)?;
                std::thread::sleep(Duration::from_millis(3000));
                out.hold(b, false)?;
                out.hold(a, false)
            };
            let kl = hold(&mut out, "KeyK", "KeyL");
            std::thread::sleep(Duration::from_millis(800));
            let jk =
                if resolve_focused() { hold(&mut out, "KeyK", "KeyJ") } else { Err("Resolve not in front".into()) };
            let _ = out.inj.release_all();
            say("Click back on this window.");
            json!({
                "klSent": kl.is_ok(), "jkSent": jk.is_ok(),
                "klSlowForward": ask_yn("First 3 seconds (K+L): did it play FORWARD slowly, slower than normal speed?"),
                "jkSlowReverse": ask_yn("Next 3 seconds (J+K): did it play BACKWARD slowly?"),
            })
        } else {
            json!({"skipped": true})
        };

        // K6: elevated Resolve (optional).
        heading("6/6 · optional: Resolve as administrator");
        let elevated_test = if ask_yn("Try this now? It means restarting Resolve twice.") == Some(true) {
            pause("Close Resolve, right-click its icon → 'Run as administrator', open the same timeline, then");
            let pids = app_win::find_processes(RESOLVE);
            let detected: Vec<Value> =
                pids.iter().map(|p| json!({"pid": p, "elevation": app_win::elevation(*p)})).collect();
            let r = if wait_for_resolve(30) { out.tap("Mod+B", 30, KeyOpts::default()).is_ok() } else { false };
            say("Click back on this window.");
            let happened = ask_yn("Did the split happen this time?");
            say("Please close Resolve and start it normally again before using Jogstick.");
            json!({"detected": detected, "sent": r, "splitHappened": happened})
        } else {
            json!({"skipped": true})
        };

        json!({
            "kind": "keys",
            "spike": "B",
            "resolve": resolve_elev,
            "probeElevation": app_win::self_elevation(),
            "steamRunning": steam,
            "keyboardLayoutAtStart": layout_before,
            "timelineFps": fps,
            "singleSplit": k1,
            "comboRounds": rounds,
            "recommendedComboSpacingMs": recommended,
            "arrows30Hz": arrows,
            "arrowsNoExtendedFlag": arrows_no_ext,
            "slowShuttle": shuttle,
            "elevatedResolve": elevated_test,
        })
    }

    fn arrow_run(out: &mut Out, fps: u32, n: u32, opts: KeyOpts) -> Value {
        let before = ask_timecode("Timecode now? (like 01:00:12:05)", fps);
        if !wait_for_resolve(20) {
            return json!({"skipped": true});
        }
        let t0 = Instant::now();
        let r = tap_at_rate(out, "ArrowRight", n, 30.0, opts);
        let secs = t0.elapsed().as_secs_f64();
        let _ = out.inj.release_all();
        say("Click back on this window.");
        let after = ask_timecode("Timecode now?", fps);
        let moved = before.zip(after).map(|(b, a)| a - b);
        say(&format!(
            "  sent {n} steps in {secs:.1} s, playhead moved {} frames",
            moved.map_or("?".into(), |m| m.to_string())
        ));
        json!({"sent": r.as_ref().ok(), "error": r.err(), "expected": n, "seconds": secs, "framesMoved": moved, "exact": moved == Some(i64::from(n)), "extendedFlag": !opts.force_no_extended})
    }

    // ---------- Spike C: wheel ----------

    /// Wait for a fresh A press on the pad and return the cursor position at that moment.
    fn capture_on_a(slot: u32, backend: &PlatformBackend) -> Option<Pt> {
        let mut was_down = pad_win::read(slot).is_some_and(|(_, r)| PadFrame::from_xinput(0.0, r).pressed(btn::A));
        let deadline = Instant::now() + Duration::from_secs(120);
        while Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(8));
            let down = pad_win::read(slot).is_some_and(|(_, r)| PadFrame::from_xinput(0.0, r).pressed(btn::A));
            if down && !was_down {
                let (x, y) = backend.cursor_position().ok()?;
                pad_win::rumble_for(slot, 20000, 20000, 80);
                return Some(Pt { x, y });
            }
            was_down = down;
        }
        None
    }

    /// One drag: remember the cursor, press at `from`, move by (dx, dy) over `ms`, release, restore.
    fn drag(out: &mut Out, from: Pt, dx: f64, dy: f64, ms: u64) -> Result<(), String> {
        if !resolve_focused() {
            return Err("Resolve is no longer in front".into());
        }
        let home = out.inj.backend.cursor_position()?;
        out.inj.mouse_move_to(from.x, from.y)?;
        std::thread::sleep(Duration::from_millis(60));
        out.inj.mouse_button(MouseBtn::Left, true)?;
        std::thread::sleep(Duration::from_millis(60));
        let steps = (ms / 10).max(1);
        for i in 1..=steps {
            let f = i as f64 / steps as f64;
            out.inj.mouse_move_to(from.x + dx * f, from.y + dy * f)?;
            std::thread::sleep(Duration::from_millis(10));
        }
        std::thread::sleep(Duration::from_millis(60));
        out.inj.mouse_button(MouseBtn::Left, false)?;
        std::thread::sleep(Duration::from_millis(60));
        out.inj.mouse_move_to(home.0, home.1)
    }

    fn undo(out: &mut Out) {
        let _ = out.tap("Mod+Z", 30, KeyOpts::default());
        std::thread::sleep(Duration::from_millis(300));
    }

    fn wheel() -> Value {
        heading("Color wheels check (about 15 minutes)");
        let Some(&slot) = pad_win::connected().first() else {
            say("Connect the Xbox controller first (it's used to mark points).");
            return json!({"kind": "wheel", "error": "no controller"});
        };
        let mut out = match Out::new() {
            Ok(o) => o,
            Err(e) => return json!({"kind": "wheel", "error": e}),
        };
        say("Set up Resolve like this:");
        say("  • Color page, a clip selected, Workspace → Full Screen mode on, the Primaries Wheels palette showing.");
        say("  • Leave the layout as you'd normally use it.");
        say("  • Start a screen recording: click Resolve, then press Win+Alt+R (Xbox Game Bar). Press Win+Alt+R again at the end.");
        pause("When that's ready");

        heading("Mark three points with the controller");
        say("Move the MOUSE over each spot below, then press A on the controller (the pad buzzes when it's marked).");
        let mut marks = Vec::new();
        for (what, hint) in [
            ("the CENTER of the Lift wheel", "(the leftmost wheel)"),
            ("the CENTER of the Offset wheel", "(the rightmost wheel)"),
            ("the middle of the Lift MASTER wheel", "(the horizontal dial just under the Lift wheel)"),
        ] {
            say(&format!("  → {what} {hint}"));
            match capture_on_a(slot, &out.inj.backend) {
                Some(p) => {
                    say(&format!("    marked at {:.0}, {:.0}", p.x, p.y));
                    marks.push(p);
                }
                None => return json!({"kind": "wheel", "error": "timed out waiting for A"}),
            }
        }
        let window = app_win::foreground();
        let mut points = derive_wheel_points(marks[0], marks[1], marks[2]);

        heading("Check the points");
        say("The probe will move the mouse to each of the 8 points (4 wheel centers, then 4 master dials), 1.5 s each. It doesn't click.");
        let mut derived_ok = None;
        if wait_for_resolve(20) {
            for p in points {
                let _ = out.inj.mouse_move_to(p.x, p.y);
                std::thread::sleep(Duration::from_millis(1500));
            }
            say("Click back on this window.");
            derived_ok = ask_yn("Did the mouse stop on the center of every wheel and every master dial?");
            if derived_ok == Some(false) {
                say("OK, mark all 8 by hand instead: hover, then press A.");
                for (i, name) in WHEEL_NAMES.iter().enumerate() {
                    say(&format!("  → {name}"));
                    if let Some(p) = capture_on_a(slot, &out.inj.backend) {
                        points[i] = p;
                    }
                }
            }
        }

        heading("Drag tests");
        say("Each test drags one wheel, then you type the numbers shown under that wheel, then the probe undoes it (Ctrl+Z).");
        say("First the probe adds a fresh node (Alt+S) so nothing touches your grade.");
        let mut node_added = None;
        if wait_for_resolve(20) {
            let _ = out.tap("Alt+S", 30, KeyOpts::default());
            std::thread::sleep(Duration::from_millis(400));
            say("Click back on this window.");
            node_added = ask_yn("Was a new node added in the node graph?");
        }

        let [lift, _gamma, _gain, offset, lift_m, _, _, _] = points;
        let mut tests = Vec::new();
        let mut run = |out: &mut Out,
                       id: &str,
                       desc: &str,
                       from: Pt,
                       dx: f64,
                       dy: f64,
                       ms: u64,
                       question: Option<&str>,
                       values: Option<(&str, usize)>| {
            say(&format!("\n{id}: {desc}"));
            if !wait_for_resolve(20) {
                tests.push(json!({"id": id, "skipped": true}));
                return;
            }
            let r = drag(out, from, dx, dy, ms);
            say("Click back on this window.");
            let answer = question.map(ask_yn);
            let vals = values.and_then(|(q, n)| ask_floats(q, n));
            if wait_for_resolve(20) {
                undo(out);
            }
            tests.push(json!({"id": id, "from": from, "dx": dx, "dy": dy, "ms": ms, "error": r.err(), "answer": answer, "values": vals}));
        };
        let lift_vals = Some(("Type the 4 numbers under the LIFT wheel (Y R G B), e.g. 0.00 0.03 -0.01 -0.02:", 4));
        run(
            &mut out,
            "W1",
            "press 40 px right of the Lift center and hold, without moving",
            Pt { x: lift.x + 40.0, y: lift.y },
            0.0,
            0.0,
            300,
            Some("Did the Lift indicator JUMP toward the spot that was pressed?"),
            lift_vals,
        );
        run(
            &mut out,
            "W2",
            "drag from the Lift center 100 px right over 1 second",
            lift,
            100.0,
            0.0,
            1000,
            None,
            lift_vals,
        );
        run(&mut out, "W3", "the same drag, fast (0.2 seconds)", lift, 100.0, 0.0, 200, None, lift_vals);
        run(
            &mut out,
            "W4",
            "drag from 40 px right of center, 100 px right over 1 second",
            Pt { x: lift.x + 40.0, y: lift.y },
            100.0,
            0.0,
            1000,
            None,
            lift_vals,
        );
        run(
            &mut out,
            "W5",
            "drag the Lift MASTER dial 100 px right over 1 second",
            lift_m,
            100.0,
            0.0,
            1000,
            Some("Did the Lift master dial change?"),
            lift_vals,
        );
        run(
            &mut out,
            "W6",
            "drag the Lift MASTER dial 100 px UP over 1 second",
            lift_m,
            0.0,
            -100.0,
            1000,
            Some("Did the Lift master dial change?"),
            None,
        );
        run(
            &mut out,
            "W7",
            "drag from the Offset center 100 px right over 1 second",
            offset,
            100.0,
            0.0,
            1000,
            None,
            Some(("Type the 4 numbers under the OFFSET wheel (Y R G B):", 4)),
        );
        let _ = out.inj.release_all();
        say("\nAll done. Stop the screen recording (Win+Alt+R in Resolve). You can delete the extra node.");
        say("The recording is in Videos\\Captures. Please send it along with the results folder.");

        json!({
            "kind": "wheel",
            "spike": "C",
            "marks": marks,
            "points": points.iter().zip(WHEEL_NAMES).map(|(p, n)| json!({"name": n, "x": p.x, "y": p.y})).collect::<Vec<_>>(),
            "derivedPointsLookRight": derived_ok,
            "resolveWindow": window,
            "displays": app_win::displays(),
            "freshNodeAdded": node_added,
            "tests": tests,
        })
    }
}
