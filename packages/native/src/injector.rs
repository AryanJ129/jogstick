//! Platform-independent injector: tracks everything we hold down so `release_all`
//! can undo it in the safe order (mouse buttons → keys → modifiers).

use crate::combo::{Combo, Mods};
use crate::keymap::KeyDef;
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
    fn cursor_position(&self) -> Result<(f64, f64), String>;
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

    pub fn mouse_move_to(&mut self, x: f64, y: f64) -> Result<(), String> {
        let dragging = self.buttons.first().copied();
        self.backend.mouse_move_to(x, y, dragging, self.mods)
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
    }

    #[derive(Default)]
    pub struct Fake {
        pub log: Vec<Ev>,
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
        fn cursor_position(&self) -> Result<(f64, f64), String> {
            Ok((0.0, 0.0))
        }
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
