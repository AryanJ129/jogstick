//! jogstick-harness: a window that logs every key and mouse event it receives as
//! JSON lines, so injection can be verified without Resolve.
//!
//!   jogstick-harness              log events until the window closes
//!   jogstick-harness --self-test  focus itself, inject a scripted sequence through
//!                                 our injector, check what arrived, exit 0/1
//!
//! macOS: the binary needs the Accessibility grant to inject (sign it with
//! scripts/dev-sign-mac.sh so the grant survives rebuilds).

use jogstick_native::combo::{parse, Os};
use jogstick_native::injector::{Injector, KeyOpts, MouseBtn};
use jogstick_native::keymap::{lookup, Modifier};
use jogstick_native::PlatformBackend;
use serde_json::json;
use std::time::Duration;
use winit::application::ApplicationHandler;
use winit::event::{ElementState, KeyEvent, MouseButton, WindowEvent};
use winit::event_loop::{ActiveEventLoop, EventLoop, EventLoopProxy};
use winit::keyboard::{KeyLocation, ModifiersState, PhysicalKey};
use winit::window::{Window, WindowId};

#[derive(Debug, Clone, PartialEq)]
enum Rec {
    Key { physical: String, logical: String, location: KeyLocation, pressed: bool, mods: ModifiersState },
    Mods(ModifiersState),
    Mouse { button: MouseButton, pressed: bool },
    Marker(&'static str),
}

#[derive(Debug)]
enum UserEvent {
    Marker(&'static str),
    Done(Result<(), String>),
}

struct App {
    window: Option<Window>,
    self_test: bool,
    started: bool,
    proxy: EventLoopProxy<UserEvent>,
    mods: ModifiersState,
    log: Vec<Rec>,
    exit_code: i32,
}

fn emit(v: serde_json::Value) {
    println!("{v}");
}

impl App {
    fn on_key(&mut self, e: &KeyEvent) {
        let physical = match e.physical_key {
            PhysicalKey::Code(c) => format!("{c:?}"),
            PhysicalKey::Unidentified(n) => format!("Unidentified({n:?})"),
        };
        let logical = format!("{:?}", e.logical_key);
        let pressed = e.state == ElementState::Pressed;
        if !self.self_test {
            emit(
                json!({"type": "key", "physical": physical, "logical": logical, "location": format!("{:?}", e.location),
                "pressed": pressed, "repeat": e.repeat, "text": e.text.as_ref().map(|t| t.to_string()),
                "mods": format!("{:?}", self.mods)}),
            );
        }
        self.log.push(Rec::Key { physical, logical, location: e.location, pressed, mods: self.mods });
    }

    fn start_self_test(&mut self) {
        let window = self.window.as_ref().expect("window");
        let size = window.inner_size();
        let pos = window.inner_position().unwrap_or_default();
        let scale = window.scale_factor();
        // Injection space: physical pixels on Windows, points on macOS.
        let (cx, cy) = if cfg!(target_os = "macos") {
            (
                (f64::from(pos.x) + f64::from(size.width) / 2.0) / scale,
                (f64::from(pos.y) + f64::from(size.height) / 2.0) / scale,
            )
        } else {
            (f64::from(pos.x) + f64::from(size.width) / 2.0, f64::from(pos.y) + f64::from(size.height) / 2.0)
        };
        let proxy = self.proxy.clone();
        std::thread::spawn(move || {
            let r = run_script(&proxy, cx, cy);
            let _ = proxy.send_event(UserEvent::Done(r));
        });
    }
}

fn run_script(proxy: &EventLoopProxy<UserEvent>, cx: f64, cy: f64) -> Result<(), String> {
    let os = Os::current();
    let mut inj = Injector::new(PlatformBackend::new()?);
    let gap = || std::thread::sleep(Duration::from_millis(15));
    let mark = |m: &'static str| {
        std::thread::sleep(Duration::from_millis(150));
        let _ = proxy.send_event(UserEvent::Marker(m));
        std::thread::sleep(Duration::from_millis(50));
    };
    let tap = |inj: &mut Injector<PlatformBackend>, s: &str| -> Result<(), String> {
        inj.tap_combo(&parse(s, os)?, Duration::from_millis(16), KeyOpts::default())?;
        gap();
        Ok(())
    };
    std::thread::sleep(Duration::from_millis(400));

    mark("arrows");
    for _ in 0..30 {
        tap(&mut inj, "ArrowRight")?;
    }
    mark("after-arrows");
    tap(&mut inj, "Backspace")?;
    tap(&mut inj, "Enter")?;
    tap(&mut inj, "Delete")?;
    tap(&mut inj, "Home")?;
    tap(&mut inj, "End")?;
    mark("combos");
    tap(&mut inj, "Mod+B")?;
    tap(&mut inj, "Mod+Shift+[")?;
    tap(&mut inj, "Alt+Y")?;
    mark("rule10");
    tap(&mut inj, "Mod+V")?;
    tap(&mut inj, "Space")?;
    mark("held-shift");
    inj.set_mods(inj.held_mods().with(Modifier::Shift))?;
    gap();
    tap(&mut inj, "ArrowLeft")?;
    inj.set_mods(inj.held_mods().without(Modifier::Shift))?;
    gap();
    mark("release-all");
    inj.set_mods(inj.held_mods().with(Modifier::Alt))?;
    inj.key_down(lookup("KeyA").ok_or("KeyA")?, KeyOpts::default())?;
    gap();
    inj.release_all()?;
    gap();
    mark("mouse");
    inj.mouse_move_to(cx, cy)?;
    gap();
    inj.mouse_button(MouseBtn::Left, true)?;
    gap();
    inj.mouse_move_to(cx + 20.0, cy)?;
    gap();
    inj.mouse_button(MouseBtn::Left, false)?;
    mark("end");
    Ok(())
}

/// Records between two markers.
fn section<'a>(log: &'a [Rec], from: &'static str, to: &'static str) -> &'a [Rec] {
    let a = log.iter().position(|r| *r == Rec::Marker(from)).map_or(log.len(), |i| i + 1);
    let b = log.iter().position(|r| *r == Rec::Marker(to)).unwrap_or(log.len());
    if a <= b {
        &log[a..b]
    } else {
        &[]
    }
}

fn presses(recs: &[Rec]) -> impl Iterator<Item = (&str, &str, KeyLocation, ModifiersState)> + '_ {
    recs.iter().filter_map(|r| match r {
        Rec::Key { physical, logical, location, pressed: true, mods } => {
            Some((physical.as_str(), logical.as_str(), *location, *mods))
        }
        _ => None,
    })
}

fn check(log: &[Rec]) -> Vec<(String, bool, String)> {
    let meta = if cfg!(target_os = "macos") { ModifiersState::SUPER } else { ModifiersState::CONTROL };
    let mut out = Vec::new();
    let mut add = |name: &str, ok: bool, detail: String| out.push((name.to_string(), ok, detail));

    let arrows: Vec<_> = presses(section(log, "arrows", "after-arrows")).collect();
    let right = arrows.iter().filter(|p| p.0 == "ArrowRight").count();
    add("30 ArrowRight presses arrive", right == 30, format!("{right}/30"));
    let std_loc = arrows.iter().filter(|p| p.0 == "ArrowRight" && p.2 == KeyLocation::Standard).count();
    add("arrows arrive as Standard, not Numpad", std_loc == 30 && right == 30, format!("{std_loc}/30 Standard"));
    add(
        "arrows carry no modifiers",
        arrows.iter().all(|p| p.3.is_empty()),
        format!("{:?}", arrows.first().map(|p| p.3)),
    );

    let after: Vec<_> = presses(section(log, "after-arrows", "combos")).collect();
    let find = |phys: &str| after.iter().find(|p| p.0 == phys).copied();
    match find("Backspace") {
        Some(p) => add(
            "Backspace after arrows is Backspace",
            p.1.contains("Backspace") && p.3.is_empty(),
            format!("logical {}", p.1),
        ),
        None => add("Backspace after arrows is Backspace", false, "no Backspace press seen".into()),
    }
    match find("Enter") {
        Some(p) => add(
            "Enter after arrows is Standard Enter",
            p.2 == KeyLocation::Standard && p.1.contains("Enter"),
            format!("{:?} {}", p.2, p.1),
        ),
        None => add("Enter after arrows is Standard Enter", false, "no Enter press seen (NumpadEnter?)".into()),
    }
    for k in ["Delete", "Home", "End"] {
        match find(k) {
            Some(p) => add(&format!("{k} arrives Standard"), p.2 == KeyLocation::Standard, format!("{:?}", p.2)),
            None => add(&format!("{k} arrives Standard"), false, "not seen".into()),
        }
    }

    let combos: Vec<_> = presses(section(log, "combos", "rule10")).collect();
    let b = combos.iter().find(|p| p.0 == "KeyB");
    add("Mod+B: B arrives with exactly Mod", b.is_some_and(|p| p.3 == meta), format!("{:?}", b.map(|p| p.3)));
    let br = combos.iter().find(|p| p.0 == "BracketLeft");
    add(
        "Mod+Shift+[: [ arrives with Mod+Shift",
        br.is_some_and(|p| p.3 == meta | ModifiersState::SHIFT),
        format!("{:?}", br.map(|p| p.3)),
    );
    let y = combos.iter().find(|p| p.0 == "KeyY");
    add(
        "Alt+Y: Y arrives with exactly Alt",
        y.is_some_and(|p| p.3 == ModifiersState::ALT),
        format!("{:?}", y.map(|p| p.3)),
    );

    let r10: Vec<_> = presses(section(log, "rule10", "held-shift")).collect();
    let space = r10.iter().find(|p| p.0 == "Space");
    add(
        "Space after Mod+V carries no modifiers",
        space.is_some_and(|p| p.3.is_empty()),
        format!("{:?}", space.map(|p| p.3)),
    );

    let hs: Vec<_> = presses(section(log, "held-shift", "release-all")).collect();
    let left = hs.iter().find(|p| p.0 == "ArrowLeft");
    add(
        "held Shift applies to ArrowLeft",
        left.is_some_and(|p| p.3 == ModifiersState::SHIFT),
        format!("{:?}", left.map(|p| p.3)),
    );

    let ra = section(log, "release-all", "mouse");
    let a_down = ra.iter().any(|r| matches!(r, Rec::Key { physical, pressed: true, .. } if physical == "KeyA"));
    let a_up = ra.iter().any(|r| matches!(r, Rec::Key { physical, pressed: false, .. } if physical == "KeyA"));
    let last_mods = ra.iter().rev().find_map(|r| if let Rec::Mods(m) = r { Some(*m) } else { None });
    add("release_all releases held key", a_down && a_up, format!("down={a_down} up={a_up}"));
    add("release_all clears modifiers", last_mods.is_some_and(|m| m.is_empty()), format!("{last_mods:?}"));

    let ms = section(log, "mouse", "end");
    let down = ms.iter().any(|r| matches!(r, Rec::Mouse { button: MouseButton::Left, pressed: true }));
    let up = ms.iter().any(|r| matches!(r, Rec::Mouse { button: MouseButton::Left, pressed: false }));
    add("mouse left down/up arrive in the window", down && up, format!("down={down} up={up}"));
    out
}

impl ApplicationHandler<UserEvent> for App {
    fn resumed(&mut self, el: &ActiveEventLoop) {
        if self.window.is_none() {
            let attrs = Window::default_attributes()
                .with_title("jogstick-harness")
                .with_inner_size(winit::dpi::LogicalSize::new(640.0, 400.0));
            let w = el.create_window(attrs).expect("create window");
            w.focus_window();
            self.window = Some(w);
        }
    }

    fn user_event(&mut self, el: &ActiveEventLoop, ev: UserEvent) {
        match ev {
            UserEvent::Marker(m) => self.log.push(Rec::Marker(m)),
            UserEvent::Done(r) => {
                if let Err(e) = r {
                    eprintln!("self-test: injection error: {e}");
                    self.exit_code = 2;
                    el.exit();
                    return;
                }
                let results = check(&self.log);
                let passed = results.iter().filter(|r| r.1).count();
                for (name, ok, detail) in &results {
                    println!("{} {name} ({detail})", if *ok { "PASS" } else { "FAIL" });
                }
                println!("harness self-test: {passed}/{} checks passed", results.len());
                self.exit_code = if passed == results.len() && !results.is_empty() { 0 } else { 1 };
                el.exit();
            }
        }
    }

    fn window_event(&mut self, el: &ActiveEventLoop, _: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => el.exit(),
            WindowEvent::Focused(true) if self.self_test && !self.started => {
                self.started = true;
                self.start_self_test();
            }
            WindowEvent::Focused(f) if !self.self_test => emit(json!({"type": "focus", "focused": f})),
            WindowEvent::ModifiersChanged(m) => {
                self.mods = m.state();
                if !self.self_test {
                    emit(json!({"type": "mods", "mods": format!("{:?}", self.mods)}));
                }
                self.log.push(Rec::Mods(self.mods));
            }
            WindowEvent::KeyboardInput { event, .. } => self.on_key(&event),
            WindowEvent::MouseInput { state, button, .. } => {
                let pressed = state == ElementState::Pressed;
                if !self.self_test {
                    emit(json!({"type": "mouse", "button": format!("{button:?}"), "pressed": pressed}));
                }
                self.log.push(Rec::Mouse { button, pressed });
            }
            WindowEvent::CursorMoved { position, .. } if !self.self_test => {
                emit(json!({"type": "move", "x": position.x, "y": position.y}));
            }
            _ => {}
        }
    }
}

fn main() {
    let self_test = std::env::args().any(|a| a == "--self-test");
    #[cfg(target_os = "macos")]
    if self_test && !jogstick_native::inject_mac::ax_is_trusted(true) {
        eprintln!("self-test: this app lacks the Accessibility grant. Allow \"Jogstick Harness\" in System Settings → Privacy & Security → Accessibility, then run again.");
        std::process::exit(3);
    }
    let event_loop = EventLoop::<UserEvent>::with_user_event().build().expect("event loop");
    let mut app = App {
        window: None,
        self_test,
        started: false,
        proxy: event_loop.create_proxy(),
        mods: ModifiersState::empty(),
        log: Vec::new(),
        exit_code: 0,
    };
    if self_test {
        // Give up if focus never arrives (e.g. a CI desktop that can't focus windows).
        let proxy = app.proxy.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(20));
            let _ = proxy.send_event(UserEvent::Done(Err("timed out waiting for focus/events".into())));
        });
    }
    event_loop.run_app(&mut app).expect("run");
    std::process::exit(app.exit_code);
}
