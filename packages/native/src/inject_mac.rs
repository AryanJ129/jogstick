//! macOS injection through CGEvent, following the rules in BUILD_BRIEF.md:
//! one long-lived HID-state source, posted at the HID tap, every event tagged,
//! flags always written in full (unset flags inherit HID state), modifiers sent
//! as flagsChanged with the resulting set, `*MouseDragged` while a button is held.

use crate::combo::Mods;
use crate::injector::{Backend, KeyOpts, MouseBtn};
use crate::keymap::{KeyDef, Modifier};
use crate::EVENT_TAG;
use core_foundation::base::TCFType;
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::string::{CFString, CFStringRef};
use core_graphics::event::{
    CGEvent, CGEventField, CGEventFlags, CGEventTapLocation, CGEventType, CGMouseButton, EventField,
};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use core_graphics::geometry::CGPoint;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
    static kAXTrustedCheckOptionPrompt: CFStringRef;
}

/// Whether this process holds the Accessibility grant that CGEventPost needs.
/// With `prompt`, macOS shows its "allow in System Settings" dialog if it doesn't
/// (the dialog sometimes doesn't appear; the app also offers a direct settings link).
pub fn ax_is_trusted(prompt: bool) -> bool {
    if !prompt {
        // SAFETY: no arguments, no preconditions.
        return unsafe { AXIsProcessTrusted() };
    }
    // SAFETY: kAXTrustedCheckOptionPrompt is a constant CFString owned by the framework.
    let key = unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt) };
    let opts = CFDictionary::from_CFType_pairs(&[(key, CFBoolean::true_value())]);
    // SAFETY: `opts` is a valid CFDictionary for the call's duration.
    unsafe { AXIsProcessTrustedWithOptions(opts.as_concrete_TypeRef()) }
}

fn mod_flags(mods: Mods) -> CGEventFlags {
    let mut f = CGEventFlags::CGEventFlagNull;
    for m in mods.iter() {
        f |= match m {
            Modifier::Shift => CGEventFlags::CGEventFlagShift,
            Modifier::Ctrl => CGEventFlags::CGEventFlagControl,
            Modifier::Alt => CGEventFlags::CGEventFlagAlternate,
            Modifier::Meta => CGEventFlags::CGEventFlagCommand,
        };
    }
    f
}

pub fn key_flags(key: &KeyDef, mods: Mods) -> CGEventFlags {
    let mut f = mod_flags(mods);
    if key.mac_fn {
        f |= CGEventFlags::CGEventFlagSecondaryFn;
    }
    if key.mac_numpad {
        f |= CGEventFlags::CGEventFlagNumericPad;
    }
    f
}

pub struct MacBackend {
    source: CGEventSource,
    mouse_event_number: i64,
}

impl MacBackend {
    pub fn new() -> Result<Self, String> {
        let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
            .map_err(|_| "CGEventSourceCreate failed".to_string())?;
        Ok(Self { source, mouse_event_number: 0 })
    }

    fn post(&self, ev: &CGEvent) {
        ev.set_integer_value_field(EventField::EVENT_SOURCE_USER_DATA, EVENT_TAG);
        ev.post(CGEventTapLocation::HID);
    }
}

const MOUSE_EVENT_NUMBER: CGEventField = EventField::MOUSE_EVENT_NUMBER;

impl Backend for MacBackend {
    fn key(&mut self, key: &KeyDef, down: bool, mods: Mods, _opts: KeyOpts) -> Result<(), String> {
        let ev = CGEvent::new_keyboard_event(self.source.clone(), key.mac, down)
            .map_err(|_| format!("CGEventCreateKeyboardEvent failed for {}", key.code))?;
        ev.set_flags(key_flags(key, mods));
        self.post(&ev);
        Ok(())
    }

    fn modifiers(&mut self, from: Mods, to: Mods) -> Result<(), String> {
        // One flagsChanged per changed modifier, each carrying the full resulting set.
        let mut cur = from;
        for m in Modifier::ALL {
            if from.has(m) == to.has(m) {
                continue;
            }
            cur = if to.has(m) { cur.with(m) } else { cur.without(m) };
            let ev = CGEvent::new_keyboard_event(self.source.clone(), m.mac(), to.has(m))
                .map_err(|_| "CGEventCreateKeyboardEvent failed for modifier".to_string())?;
            ev.set_type(CGEventType::FlagsChanged);
            ev.set_flags(mod_flags(cur));
            self.post(&ev);
        }
        Ok(())
    }

    fn mouse_button(&mut self, btn: MouseBtn, down: bool, mods: Mods) -> Result<(), String> {
        let (x, y) = self.cursor_position()?;
        let (ty, cg_btn) = match (btn, down) {
            (MouseBtn::Left, true) => (CGEventType::LeftMouseDown, CGMouseButton::Left),
            (MouseBtn::Left, false) => (CGEventType::LeftMouseUp, CGMouseButton::Left),
            (MouseBtn::Right, true) => (CGEventType::RightMouseDown, CGMouseButton::Right),
            (MouseBtn::Right, false) => (CGEventType::RightMouseUp, CGMouseButton::Right),
            (MouseBtn::Middle, true) => (CGEventType::OtherMouseDown, CGMouseButton::Center),
            (MouseBtn::Middle, false) => (CGEventType::OtherMouseUp, CGMouseButton::Center),
        };
        if down {
            self.mouse_event_number += 1;
        }
        let ev = CGEvent::new_mouse_event(self.source.clone(), ty, CGPoint::new(x, y), cg_btn)
            .map_err(|_| "CGEventCreateMouseEvent failed".to_string())?;
        ev.set_flags(mod_flags(mods));
        // Down, drags and up share one event number and click count.
        ev.set_integer_value_field(MOUSE_EVENT_NUMBER, self.mouse_event_number);
        ev.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, 1);
        self.post(&ev);
        Ok(())
    }

    fn mouse_move_to(&mut self, x: f64, y: f64, dragging: Option<MouseBtn>, mods: Mods) -> Result<(), String> {
        let (ty, cg_btn) = match dragging {
            None => (CGEventType::MouseMoved, CGMouseButton::Left),
            Some(MouseBtn::Left) => (CGEventType::LeftMouseDragged, CGMouseButton::Left),
            Some(MouseBtn::Right) => (CGEventType::RightMouseDragged, CGMouseButton::Right),
            Some(MouseBtn::Middle) => (CGEventType::OtherMouseDragged, CGMouseButton::Center),
        };
        let ev = CGEvent::new_mouse_event(self.source.clone(), ty, CGPoint::new(x, y), cg_btn)
            .map_err(|_| "CGEventCreateMouseEvent failed".to_string())?;
        ev.set_flags(mod_flags(mods));
        if dragging.is_some() {
            ev.set_integer_value_field(MOUSE_EVENT_NUMBER, self.mouse_event_number);
            ev.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, 1);
        }
        self.post(&ev);
        Ok(())
    }

    fn cursor_position(&self) -> Result<(f64, f64), String> {
        let src = CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
            .map_err(|_| "CGEventSourceCreate failed".to_string())?;
        let ev = CGEvent::new(src).map_err(|_| "CGEventCreate failed".to_string())?;
        let p = ev.location();
        Ok((p.x, p.y))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keymap::lookup;

    #[test]
    fn arrow_flags_include_fn_and_numpad_and_nothing_inherited() {
        let f = key_flags(&lookup("ArrowRight").unwrap(), Mods::NONE);
        assert_eq!(f, CGEventFlags::CGEventFlagSecondaryFn | CGEventFlags::CGEventFlagNumericPad);
    }

    #[test]
    fn backspace_after_arrow_has_empty_flags() {
        // The bug this guards against: Backspace inheriting NumericPad|Fn turns into forward-delete.
        assert_eq!(key_flags(&lookup("Backspace").unwrap(), Mods::NONE), CGEventFlags::CGEventFlagNull);
        assert_eq!(key_flags(&lookup("Enter").unwrap(), Mods::NONE), CGEventFlags::CGEventFlagNull);
    }

    #[test]
    fn modifier_flags_are_exact() {
        let m = Mods::NONE.with(Modifier::Meta).with(Modifier::Shift);
        assert_eq!(
            key_flags(&lookup("KeyB").unwrap(), m),
            CGEventFlags::CGEventFlagCommand | CGEventFlags::CGEventFlagShift
        );
    }
}
