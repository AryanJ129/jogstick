//! Platform-independent injector: tracks everything we hold down so `release_all`
//! can undo it in the safe order (mouse buttons → keys → modifiers).

use crate::combo::{Combo, Mods};
use crate::keymap::{self, KeyDef, Modifier};
use std::thread::sleep;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseBtn {
    Left,
    Right,
    Middle,
}

/// One OS's raw output. Every event the backend posts is tagged with `EVENT_TAG`.
pub trait Backend {
    /// Post a non-modifier key event. `mods` is the full modifier set that is down
    /// while this event is delivered (macOS writes it into the event flags).
    fn key(&mut self, key: &KeyDef, down: bool, mods: Mods, opts: KeyOpts) -> Result<(), String>;
    /// Move the modifier state from `from` to `to` (macOS: one flagsChanged per
    /// changed modifier carrying the resulting set; Windows: modifier key events).
    fn modifiers(&mut self, from: Mods, to: Mods) -> Result<(), String>;
    fn mouse_button(&mut self, btn: MouseBtn, down: bool, mods: Mods) -> Result<(), String>;
    /// Absolute move in the OS's injection coordinate space (Windows: physical
    /// virtual-desktop pixels; macOS: global display points). `dragging` = a button is held.
    fn mouse_move_to(&mut self, x: f64, y: f64, dragging: Option<MouseBtn>, mods: Mods) -> Result<(), String>;
    /// Wheel scroll: `dy` > 0 scrolls up / away, `dx` > 0 right. `pixels` = pixel units, else lines.
    fn scroll(&mut self, dx: i32, dy: i32, pixels: bool, mods: Mods) -> Result<(), String>;
    fn cursor_position(&self) -> Result<(f64, f64), String>;
    /// Whether the OS's combined (physical + synthetic) state has this key / modifier / button down.
    /// Used only by `release_leftovers` after a crash.
    fn key_is_down(&self, key: &KeyDef) -> bool;
    fn modifier_is_down(&self, m: Modifier) -> bool;
    fn button_is_down(&self, btn: MouseBtn) -> bool;
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct KeyOpts {
    /// Probe-only: drop KEYEVENTF_EXTENDEDKEY to reproduce the Qt keypad-arrow failure.
    pub force_no_extended: bool,
}

pub struct Injector<B: Backend> {
    pub backend: B,
    mods: Mods,
    keys: Vec<KeyDef>,
    buttons: Vec<MouseBtn>,
}

impl<B: Backend> Injector<B> {
    pub fn new(backend: B) -> Self {
        Self { backend, mods: Mods::NONE, keys: Vec::new(), buttons: Vec::new() }
    }

    pub fn held_mods(&self) -> Mods {
        self.mods
    }
    pub fn held_keys(&self) -> &[KeyDef] {
        &self.keys
    }

    pub fn set_mods(&mut self, to: Mods) -> Result<(), String> {
        if to != self.mods {
            let from = self.mods;
            self.mods = to;
            self.backend.modifiers(from, to)?;
        }
        Ok(())
    }

    pub fn key_down(&mut self, key: KeyDef, opts: KeyOpts) -> Result<(), String> {
        if !self.keys.contains(&key) {
            self.keys.push(key);
        }
        self.backend.key(&key, true, self.mods, opts)
    }

    pub fn key_up(&mut self, key: KeyDef, opts: KeyOpts) -> Result<(), String> {
        self.keys.retain(|k| *k != key);
        self.backend.key(&key, false, self.mods, opts)
    }

    /// modifiers down → spacing → key down → key up → spacing → modifiers up.
    /// Blocking; the app's output queue does the same thing without sleeping.
    pub fn tap_combo(&mut self, combo: &Combo, spacing: Duration, opts: KeyOpts) -> Result<(), String> {
        let base = self.mods;
        let with = base.union(combo.mods);
        if with != base {
            self.set_mods(with)?;
            if !spacing.is_zero() {
                sleep(spacing);
            }
        }
        self.key_down(combo.key, opts)?;
        self.key_up(combo.key, opts)?;
        if with != base {
            if !spacing.is_zero() {
                sleep(spacing);
            }
            self.set_mods(base)?;
        }
        Ok(())
    }

    pub fn mouse_button(&mut self, btn: MouseBtn, down: bool) -> Result<(), String> {
        if down {
            if !self.buttons.contains(&btn) {
                self.buttons.push(btn);
            }
        } else {
            self.buttons.retain(|b| *b != btn);
        }
        self.backend.mouse_button(btn, down, self.mods)
    }

    pub fn held_buttons(&self) -> &[MouseBtn] {
        &self.buttons
    }

    pub fn mouse_move_to(&mut self, x: f64, y: f64) -> Result<(), String> {
        let dragging = self.buttons.first().copied();
        self.backend.mouse_move_to(x, y, dragging, self.mods)
    }

    pub fn mouse_move_rel(&mut self, dx: f64, dy: f64) -> Result<(), String> {
        let (x, y) = self.backend.cursor_position()?;
        self.mouse_move_to(x + dx, y + dy)
    }

    pub fn scroll(&mut self, dx: i32, dy: i32, pixels: bool) -> Result<(), String> {
        self.backend.scroll(dx, dy, pixels, self.mods)
    }

    /// After a crash, the OS may still think something we sent is down. Post an up for
    /// every key, modifier and mouse button the OS reports down, in the `release_all`
    /// order. Run once at launch (it also releases anything physically held then).
    /// Returns what was released.
    pub fn release_leftovers(&mut self) -> Result<Vec<String>, String> {
        let mut released = Vec::new();
        let mut first_err = None;
        for btn in [MouseBtn::Left, MouseBtn::Right, MouseBtn::Middle] {
            if self.backend.button_is_down(btn) {
                released.push(format!("mouse:{btn:?}"));
                if let Err(e) = self.backend.mouse_button(btn, false, Mods::NONE) {
                    first_err.get_or_insert(e);
                }
            }
        }
        for key in keymap::all() {
            if self.backend.key_is_down(key) {
                released.push(key.code.to_string());
                if let Err(e) = self.backend.key(key, false, Mods::NONE, KeyOpts::default()) {
                    first_err.get_or_insert(e);
                }
            }
        }
        let down = Modifier::ALL.into_iter().filter(|m| self.backend.modifier_is_down(*m)).fold(Mods::NONE, Mods::with);
        if down != Mods::NONE {
            released.extend(down.iter().map(|m| format!("mod:{m:?}")));
            if let Err(e) = self.backend.modifiers(down, Mods::NONE) {
                first_err.get_or_insert(e);
            }
        }
        self.keys.clear();
        self.buttons.clear();
        self.mods = Mods::NONE;
        first_err.map_or(Ok(released), Err)
    }

    /// Release in order: mouse buttons → keys → modifiers. Keeps going on errors
    /// and reports the first one, so one failure never leaves the rest stuck.
    pub fn release_all(&mut self) -> Result<(), String> {
        let mut first_err = None;
        for btn in std::mem::take(&mut self.buttons) {
            if let Err(e) = self.backend.mouse_button(btn, false, self.mods) {
                first_err.get_or_insert(e);
            }
        }
        for key in std::mem::take(&mut self.keys) {
            if let Err(e) = self.backend.key(&key, false, self.mods, KeyOpts::default()) {
                first_err.get_or_insert(e);
            }
        }
        if let Err(e) = self.set_mods(Mods::NONE) {
            first_err.get_or_insert(e);
        }
        first_err.map_or(Ok(()), Err)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::combo::{parse, Os};
    use crate::keymap::{lookup, Modifier};

    #[derive(Debug, Clone, PartialEq)]
    pub enum Ev {
        Key(&'static str, bool, u8),
        Mods(u8, u8),
        Btn(MouseBtn, bool),
        Move(f64, f64, bool),
        Scroll(i32, i32, bool),
    }

    #[derive(Default)]
    pub struct Fake {
        pub log: Vec<Ev>,
        /// What the fake OS reports as down (for release_leftovers).
        pub down_keys: Vec<&'static str>,
        pub down_mods: Mods,
        pub down_buttons: Vec<MouseBtn>,
    }

    impl Backend for Fake {
        fn key(&mut self, key: &KeyDef, down: bool, mods: Mods, _: KeyOpts) -> Result<(), String> {
            self.log.push(Ev::Key(key.code, down, mods.0));
            Ok(())
        }
        fn modifiers(&mut self, from: Mods, to: Mods) -> Result<(), String> {
            self.log.push(Ev::Mods(from.0, to.0));
            Ok(())
        }
        fn mouse_button(&mut self, btn: MouseBtn, down: bool, _: Mods) -> Result<(), String> {
            self.log.push(Ev::Btn(btn, down));
            Ok(())
        }
        fn mouse_move_to(&mut self, x: f64, y: f64, d: Option<MouseBtn>, _: Mods) -> Result<(), String> {
            self.log.push(Ev::Move(x, y, d.is_some()));
            Ok(())
        }
        fn scroll(&mut self, dx: i32, dy: i32, pixels: bool, _: Mods) -> Result<(), String> {
            self.log.push(Ev::Scroll(dx, dy, pixels));
            Ok(())
        }
        fn cursor_position(&self) -> Result<(f64, f64), String> {
            Ok((10.0, 20.0))
        }
        fn key_is_down(&self, key: &KeyDef) -> bool {
            self.down_keys.contains(&key.code)
        }
        fn modifier_is_down(&self, m: Modifier) -> bool {
            self.down_mods.has(m)
        }
        fn button_is_down(&self, btn: MouseBtn) -> bool {
            self.down_buttons.contains(&btn)
        }
    }

    #[test]
    fn release_leftovers_posts_ups_for_what_the_os_reports_down() {
        let fake = Fake {
            down_keys: vec!["KeyB", "ArrowLeft"],
            down_mods: Mods::NONE.with(Modifier::Meta).with(Modifier::Shift),
            down_buttons: vec![MouseBtn::Left],
            ..Fake::default()
        };
        let mut inj = Injector::new(fake);
        let released = inj.release_leftovers().unwrap();
        let both = Mods::NONE.with(Modifier::Meta).with(Modifier::Shift).0;
        assert_eq!(
            inj.backend.log,
            vec![
                Ev::Btn(MouseBtn::Left, false),
                Ev::Key("KeyB", false, 0),
                Ev::Key("ArrowLeft", false, 0),
                Ev::Mods(both, 0),
            ],
            "buttons → keys → modifiers"
        );
        assert_eq!(released.len(), 5, "{released:?}");
        assert_eq!(inj.held_mods(), Mods::NONE);
    }

    #[test]
    fn release_leftovers_with_nothing_down_posts_nothing() {
        let mut inj = Injector::new(Fake::default());
        assert!(inj.release_leftovers().unwrap().is_empty());
        assert!(inj.backend.log.is_empty());
    }

    #[test]
    fn relative_move_starts_from_the_cursor() {
        let mut inj = Injector::new(Fake::default());
        inj.mouse_move_rel(5.0, -2.5).unwrap();
        assert_eq!(inj.backend.log, vec![Ev::Move(15.0, 17.5, false)]);
    }

    #[test]
    fn combo_wraps_key_in_its_modifiers() {
        let mut inj = Injector::new(Fake::default());
        let c = parse("Mod+Shift+[", Os::Windows).unwrap();
        inj.tap_combo(&c, Duration::ZERO, KeyOpts::default()).unwrap();
        let m = Mods::NONE.with(Modifier::Ctrl).with(Modifier::Shift).0;
        assert_eq!(
            inj.backend.log,
            vec![Ev::Mods(0, m), Ev::Key("BracketLeft", true, m), Ev::Key("BracketLeft", false, m), Ev::Mods(m, 0)]
        );
        assert_eq!(inj.held_mods(), Mods::NONE);
    }

    #[test]
    fn plain_key_sends_no_modifier_events() {
        let mut inj = Injector::new(Fake::default());
        inj.tap_combo(&parse("ArrowRight", Os::Windows).unwrap(), Duration::ZERO, KeyOpts::default()).unwrap();
        assert_eq!(inj.backend.log, vec![Ev::Key("ArrowRight", true, 0), Ev::Key("ArrowRight", false, 0)]);
    }

    #[test]
    fn combo_keeps_a_held_standalone_modifier() {
        let mut inj = Injector::new(Fake::default());
        let shift = Mods::NONE.with(Modifier::Shift);
        inj.set_mods(shift).unwrap();
        inj.tap_combo(&parse("Ctrl+B", Os::Windows).unwrap(), Duration::ZERO, KeyOpts::default()).unwrap();
        assert_eq!(inj.held_mods(), shift, "Shift stays held after the combo");
    }

    #[test]
    fn release_all_order_is_buttons_keys_mods() {
        let mut inj = Injector::new(Fake::default());
        inj.set_mods(Mods::NONE.with(Modifier::Alt)).unwrap();
        inj.key_down(lookup("KeyA").unwrap(), KeyOpts::default()).unwrap();
        inj.mouse_button(MouseBtn::Left, true).unwrap();
        inj.backend.log.clear();
        inj.release_all().unwrap();
        let alt = Modifier::Alt.bit();
        assert_eq!(
            inj.backend.log,
            vec![Ev::Btn(MouseBtn::Left, false), Ev::Key("KeyA", false, alt), Ev::Mods(alt, 0)]
        );
        assert!(inj.held_keys().is_empty());
        inj.backend.log.clear();
        inj.release_all().unwrap();
        assert!(inj.backend.log.is_empty(), "second release_all is a no-op");
    }

    #[test]
    fn moves_while_button_held_are_drags() {
        let mut inj = Injector::new(Fake::default());
        inj.mouse_move_to(1.0, 1.0).unwrap();
        inj.mouse_button(MouseBtn::Left, true).unwrap();
        inj.mouse_move_to(2.0, 1.0).unwrap();
        assert_eq!(inj.backend.log[0], Ev::Move(1.0, 1.0, false));
        assert_eq!(inj.backend.log[2], Ev::Move(2.0, 1.0, true));
    }
}
