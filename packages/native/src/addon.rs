//! Node addon surface (BUILD_BRIEF.md, Phase 3). Injection runs on the JS main thread
//! only; the pad and frontmost watchers run on their own threads and only call back.
//! Every entry point and both threads are wrapped in `catch_unwind`: a panic is reported
//! as an error and everything the injector holds is released; it never aborts the host.

use crate::combo::Mods;
use crate::injector::{Backend, Injector, KeyOpts, MouseBtn};
use crate::keymap::{self, Modifier};
use crate::PlatformBackend;
use napi::bindgen_prelude::Unknown;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::Status;
use napi_derive::napi;
use std::cell::RefCell;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

thread_local! {
    static INJ: RefCell<Option<Injector<PlatformBackend>>> = const { RefCell::new(None) };
}

fn panic_message(p: &(dyn std::any::Any + Send)) -> String {
    p.downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| p.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic".into())
}

/// Best effort after a panic: release whatever the injector holds.
fn emergency_release() {
    let _ = catch_unwind(|| {
        INJ.with(|cell| {
            if let Ok(mut slot) = cell.try_borrow_mut() {
                if let Some(inj) = slot.as_mut() {
                    let _ = inj.release_all();
                }
            }
        })
    });
}

fn guarded<T>(name: &str, f: impl FnOnce() -> Result<T, String>) -> napi::Result<T> {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(napi::Error::from_reason(format!("{name}: {e}"))),
        Err(p) => {
            emergency_release();
            Err(napi::Error::from_reason(format!(
                "{name}: native panic ({}); released all held keys and buttons",
                panic_message(&*p)
            )))
        }
    }
}

fn with_injector<T>(f: impl FnOnce(&mut Injector<PlatformBackend>) -> Result<T, String>) -> Result<T, String> {
    INJ.with(|cell| {
        let mut slot = cell.try_borrow_mut().map_err(|_| "injector is busy (re-entrant call)".to_string())?;
        if slot.is_none() {
            *slot = Some(Injector::new(PlatformBackend::new()?));
        }
        f(slot.as_mut().expect("just set"))
    })
}

fn parse_mods(names: &[String]) -> Result<Mods, String> {
    names.iter().try_fold(Mods::NONE, |acc, n| {
        let m = match n.as_str() {
            "Shift" => Modifier::Shift,
            "Ctrl" => Modifier::Ctrl,
            "Alt" => Modifier::Alt,
            "Meta" | "Cmd" => Modifier::Meta,
            other => return Err(format!("unknown modifier {other:?} (expected Shift, Ctrl, Alt, Meta)")),
        };
        Ok(acc.with(m))
    })
}

fn mod_names(m: Mods) -> Vec<String> {
    m.iter().map(|m| format!("{m:?}")).collect()
}

fn key(code: &str) -> Result<keymap::KeyDef, String> {
    keymap::lookup(code).ok_or_else(|| format!("unknown key code {code:?}"))
}

fn button(name: &str) -> Result<MouseBtn, String> {
    match name {
        "left" => Ok(MouseBtn::Left),
        "right" => Ok(MouseBtn::Right),
        "middle" => Ok(MouseBtn::Middle),
        other => Err(format!("unknown mouse button {other:?}")),
    }
}

// --- injection -----------------------------------------------------------------------

#[napi]
pub fn native_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Whether the keymap knows this W3C `KeyboardEvent.code`.
#[napi]
pub fn is_known_code(code: String) -> bool {
    keymap::lookup(&code).is_some()
}

/// Key down with exactly `mods` held (modifier events are sent first if they differ).
#[napi]
pub fn key_down(code: String, mods: Vec<String>) -> napi::Result<()> {
    guarded("keyDown", || {
        let (k, m) = (key(&code)?, parse_mods(&mods)?);
        with_injector(|inj| {
            inj.set_mods(m)?;
            inj.key_down(k, KeyOpts::default())
        })
    })
}

#[napi]
pub fn key_up(code: String, mods: Vec<String>) -> napi::Result<()> {
    guarded("keyUp", || {
        let (k, m) = (key(&code)?, parse_mods(&mods)?);
        with_injector(|inj| {
            inj.set_mods(m)?;
            inj.key_up(k, KeyOpts::default())
        })
    })
}

/// Move the held modifier set to exactly `mods`.
#[napi]
pub fn modifier_changed(mods: Vec<String>) -> napi::Result<()> {
    guarded("modifierChanged", || {
        let m = parse_mods(&mods)?;
        with_injector(|inj| inj.set_mods(m))
    })
}

#[napi]
pub fn mouse_move_rel(dx: f64, dy: f64) -> napi::Result<()> {
    guarded("mouseMoveRel", || with_injector(|inj| inj.mouse_move_rel(dx, dy)))
}

#[napi]
pub fn mouse_move_to(x: f64, y: f64) -> napi::Result<()> {
    guarded("mouseMoveTo", || with_injector(|inj| inj.mouse_move_to(x, y)))
}

#[napi]
pub fn mouse_button(btn: String, down: bool) -> napi::Result<()> {
    guarded("mouseButton", || {
        let b = button(&btn)?;
        with_injector(|inj| inj.mouse_button(b, down))
    })
}

/// `units`: "lines" or "pixels". dy > 0 scrolls up.
#[napi]
pub fn scroll(dx: i32, dy: i32, units: String) -> napi::Result<()> {
    guarded("scroll", || {
        let pixels = match units.as_str() {
            "pixels" => true,
            "lines" => false,
            other => return Err(format!("unknown scroll units {other:?}")),
        };
        with_injector(|inj| inj.scroll(dx, dy, pixels))
    })
}

#[napi]
pub fn cursor_position() -> napi::Result<Vec<f64>> {
    guarded("cursorPosition", || {
        let b = PlatformBackend::new()?;
        let (x, y) = b.cursor_position()?;
        Ok(vec![x, y])
    })
}

/// Release everything we hold: mouse buttons → keys → modifiers.
#[napi]
pub fn release_all() -> napi::Result<()> {
    guarded("releaseAll", || with_injector(|inj| inj.release_all()))
}

/// At launch: post ups for anything the OS still reports down (after a crash). Returns what was released.
#[napi]
pub fn release_leftovers() -> napi::Result<Vec<String>> {
    guarded("releaseLeftovers", || with_injector(|inj| inj.release_leftovers()))
}

#[napi(object)]
pub struct HeldState {
    pub keys: Vec<String>,
    pub mods: Vec<String>,
    pub buttons: Vec<String>,
}

/// What the injector believes it is holding.
#[napi]
pub fn held_state() -> napi::Result<HeldState> {
    guarded("heldState", || {
        with_injector(|inj| {
            Ok(HeldState {
                keys: inj.held_keys().iter().map(|k| k.code.to_string()).collect(),
                mods: mod_names(inj.held_mods()),
                buttons: inj.held_buttons().iter().map(|b| format!("{b:?}").to_lowercase()).collect(),
            })
        })
    })
}

/// What the OS reports down among every key/modifier/button Jogstick can send (diagnostics, tests).
#[napi]
pub fn os_held_state() -> napi::Result<HeldState> {
    guarded("osHeldState", || {
        let b = PlatformBackend::new()?;
        Ok(HeldState {
            keys: keymap::all().iter().filter(|k| b.key_is_down(k)).map(|k| k.code.to_string()).collect(),
            mods: Modifier::ALL.into_iter().filter(|m| b.modifier_is_down(*m)).map(|m| format!("{m:?}")).collect(),
            buttons: [MouseBtn::Left, MouseBtn::Right, MouseBtn::Middle]
                .into_iter()
                .filter(|btn| b.button_is_down(*btn))
                .map(|btn| format!("{btn:?}").to_lowercase())
                .collect(),
        })
    })
}

// --- system ----------------------------------------------------------------------------

#[napi(object)]
#[derive(Clone, PartialEq)]
pub struct FrontmostInfo {
    pub id: String,
    pub name: String,
    pub pid: u32,
    /// [x, y, w, h] of the focused window.
    pub bounds: Option<Vec<f64>>,
    pub is_dialog: bool,
    /// macOS overlays that briefly take focus (screen saver, notifications): keep the gate as it was.
    pub transient: bool,
}

fn frontmost_info() -> Option<FrontmostInfo> {
    crate::app::frontmost().map(|f| FrontmostInfo {
        transient: crate::app::TRANSIENT_MAC.contains(&f.id.as_str()),
        id: f.id,
        name: f.name,
        pid: f.pid,
        bounds: f.bounds.map(|b| b.to_vec()),
        is_dialog: f.is_dialog,
    })
}

#[napi]
pub fn frontmost_app() -> napi::Result<Option<FrontmostInfo>> {
    guarded("frontmostApp", || Ok(frontmost_info()))
}

type FrontCb = ThreadsafeFunction<Option<FrontmostInfo>, Unknown<'static>, Option<FrontmostInfo>, Status, false>;
type PadCb = ThreadsafeFunction<PadEvent, Unknown<'static>, PadEvent, Status, false>;

struct Worker {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl Worker {
    fn spawn(name: &str, body: impl FnOnce(Arc<AtomicBool>) + Send + 'static) -> Result<Worker, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let s = stop.clone();
        let join = std::thread::Builder::new().name(name.into()).spawn(move || body(s)).map_err(|e| e.to_string())?;
        Ok(Worker { stop, join: Some(join) })
    }

    fn stop(mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

static FRONT: Mutex<Option<Worker>> = Mutex::new(None);
static PAD: Mutex<Option<Worker>> = Mutex::new(None);

/// Call `cb(frontmost | null)` whenever the frontmost app, its focused window's dialog state
/// or bounds change (polled every `intervalMs`, default 25, on a native thread).
/// Replaces any previous watcher.
#[napi]
pub fn on_frontmost_changed(cb: FrontCb, interval_ms: Option<u32>) -> napi::Result<()> {
    guarded("onFrontmostChanged", || {
        let every = Duration::from_millis(u64::from(interval_ms.unwrap_or(25).max(5)));
        let mut slot = FRONT.lock().map_err(|_| "frontmost watcher lock poisoned".to_string())?;
        if let Some(w) = slot.take() {
            w.stop();
        }
        *slot = Some(Worker::spawn("jogstick-frontmost", move |stop| {
            let mut last: Option<Option<FrontmostInfo>> = None;
            while !stop.load(Ordering::Relaxed) {
                match catch_unwind(frontmost_info) {
                    Ok(now) => {
                        if last.as_ref() != Some(&now) {
                            cb.call(now.clone(), ThreadsafeFunctionCallMode::NonBlocking);
                            last = Some(now);
                        }
                    }
                    // A panic reads as "nothing in front": the gate closes and the host releases all.
                    Err(_) => {
                        cb.call(None, ThreadsafeFunctionCallMode::NonBlocking);
                        last = Some(None);
                    }
                }
                std::thread::sleep(every);
            }
        })?);
        Ok(())
    })
}

#[napi]
pub fn off_frontmost_changed() -> napi::Result<()> {
    guarded("offFrontmostChanged", || {
        if let Some(w) = FRONT.lock().map_err(|_| "lock poisoned".to_string())?.take() {
            w.stop();
        }
        Ok(())
    })
}

/// Windows: whether `pid` runs elevated (UIPI blocks our input to it). null = unknown or not Windows.
#[napi]
pub fn is_process_elevated(pid: u32) -> napi::Result<Option<bool>> {
    guarded("isProcessElevated", || {
        #[cfg(windows)]
        {
            use crate::app_win::{elevation, Elevation};
            Ok(match elevation(pid) {
                Elevation::Elevated => Some(true),
                Elevation::NotElevated => Some(false),
                // From a non-elevated caller, "can't open the token" usually means elevated.
                Elevation::Unknown { .. } => None,
            })
        }
        #[cfg(not(windows))]
        {
            let _ = pid;
            Ok(None)
        }
    })
}

/// Whether a process with this executable name runs (`steam.exe`, `steam_osx`).
#[napi]
pub fn is_process_running(name: String) -> napi::Result<bool> {
    guarded("isProcessRunning", || Ok(crate::app::is_process_running(&name)))
}

/// macOS: whether we hold the Accessibility grant (`prompt` shows the system dialog). Windows: always true.
#[napi]
pub fn ax_is_trusted(prompt: bool) -> napi::Result<bool> {
    guarded("axIsTrusted", || {
        #[cfg(target_os = "macos")]
        {
            Ok(crate::inject_mac::ax_is_trusted(prompt))
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = prompt;
            Ok(true)
        }
    })
}

/// macOS: open System Settings → Privacy & Security → Accessibility.
#[napi]
pub fn open_ax_settings() -> napi::Result<()> {
    guarded("openAxSettings", || {
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open")
                .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
                .spawn()
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
        #[cfg(not(target_os = "macos"))]
        {
            Ok(())
        }
    })
}

// --- pad (Windows: XInput) ------------------------------------------------------------

#[napi(object)]
#[derive(Clone)]
pub struct PadEvent {
    /// "frame" | "connected" | "disconnected" | "error"
    pub kind: String,
    pub index: u32,
    /// Standard mapping, 17 values in 0..1.
    pub buttons: Option<Vec<f64>>,
    /// LX, LY, RX, RY in -1..1, +Y down.
    pub axes: Option<Vec<f64>>,
    /// XInput dwPacketNumber.
    pub packet: Option<u32>,
    pub message: Option<String>,
}

#[napi(object)]
pub struct PadOptions {
    /// Poll rate, default 250.
    pub hz: Option<u32>,
}

#[cfg(windows)]
fn pad_loop(hz: u32, stop: &AtomicBool, emit: &dyn Fn(PadEvent)) {
    use crate::pad::{btn, PadFrame};
    use crate::pad_win::{connected, pace, read};
    let ev = |kind: &str, index: u32| PadEvent {
        kind: kind.into(),
        index,
        buttons: None,
        axes: None,
        packet: None,
        message: None,
    };
    let mut active: Option<u32> = None;
    let mut last_packet: Option<u32> = None;
    let (mut scan_at, mut last_emit) = (0.0_f64, 0.0_f64);
    pace(hz, stop, |t| {
        let Some(slot) = active else {
            if t >= scan_at {
                scan_at = t + 0.25;
                if let Some(s) = connected().first() {
                    active = Some(*s);
                    last_packet = None;
                    emit(ev("connected", *s));
                }
            }
            return;
        };
        let Some((packet, raw)) = read(slot) else {
            active = None;
            emit(ev("disconnected", slot));
            return;
        };
        let f = PadFrame::from_xinput(t * 1000.0, raw);
        let live = f.axes.iter().any(|a| a.abs() > 0.02) || f.buttons[btn::LT] > 0.0 || f.buttons[btn::RT] > 0.0;
        // Emit on every state change, plus 120 Hz snapshots while a stick or trigger is off rest
        // (the host uses them as its high-resolution tick).
        if last_packet != Some(packet) || (live && t - last_emit >= 1.0 / 120.0) {
            last_packet = Some(packet);
            last_emit = t;
            emit(PadEvent {
                buttons: Some(f.buttons.to_vec()),
                axes: Some(f.axes.to_vec()),
                packet: Some(packet),
                ..ev("frame", slot)
            });
        }
    });
}

/// Start polling XInput (Windows). `cb(event)` gets frames on change plus 120 Hz snapshots
/// while analog input is live, and connected / disconnected / error events.
#[napi]
pub fn pad_start(cb: PadCb, opts: Option<PadOptions>) -> napi::Result<()> {
    guarded("padStart", || {
        #[cfg(windows)]
        {
            let hz = opts.and_then(|o| o.hz).unwrap_or(250).clamp(60, 1000);
            let mut slot = PAD.lock().map_err(|_| "pad lock poisoned".to_string())?;
            if let Some(w) = slot.take() {
                w.stop();
            }
            *slot = Some(Worker::spawn("jogstick-pad", move |stop| {
                let emit = |e: PadEvent| {
                    cb.call(e, ThreadsafeFunctionCallMode::NonBlocking);
                };
                if let Err(p) = catch_unwind(AssertUnwindSafe(|| pad_loop(hz, &stop, &emit))) {
                    // The host releases everything when it sees this.
                    emit(PadEvent {
                        kind: "error".into(),
                        index: 0,
                        buttons: None,
                        axes: None,
                        packet: None,
                        message: Some(format!("pad thread panic: {}", panic_message(&*p))),
                    });
                }
            })?);
            Ok(())
        }
        #[cfg(not(windows))]
        {
            let _ = (cb, opts, &PAD);
            Err("padStart is Windows-only; macOS reads the pad through the Gamepad API".into())
        }
    })
}

#[napi]
pub fn pad_stop() -> napi::Result<()> {
    guarded("padStop", || {
        if let Some(w) = PAD.lock().map_err(|_| "pad lock poisoned".to_string())?.take() {
            w.stop();
        }
        Ok(())
    })
}

/// Rumble `index` with motor strengths 0..1 for `ms` (Windows; returns immediately).
#[napi]
pub fn pad_rumble(index: u32, low: f64, high: f64, ms: u32) -> napi::Result<()> {
    guarded("padRumble", || {
        #[cfg(windows)]
        {
            let to = |v: f64| (v.clamp(0.0, 1.0) * 65535.0) as u16;
            let (l, h, d) = (to(low), to(high), u64::from(ms.min(2000)));
            std::thread::Builder::new()
                .name("jogstick-rumble".into())
                .spawn(move || {
                    let _ = catch_unwind(|| crate::pad_win::rumble_for(index, l, h, d));
                })
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
        #[cfg(not(windows))]
        {
            let _ = (index, low, high, ms);
            Err("padRumble is Windows-only".into())
        }
    })
}

/// Connected XInput slots (Windows; empty elsewhere).
#[napi]
pub fn pad_list() -> napi::Result<Vec<u32>> {
    guarded("padList", || {
        #[cfg(windows)]
        {
            Ok(crate::pad_win::connected())
        }
        #[cfg(not(windows))]
        {
            Ok(Vec::new())
        }
    })
}
