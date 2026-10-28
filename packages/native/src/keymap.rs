//! W3C `KeyboardEvent.code` → per-OS key codes.
//!
//! Windows: virtual key + whether `KEYEVENTF_EXTENDEDKEY` must be set (Qt adds
//! `KeypadModifier` to nav keys that arrive without it, so Resolve would see a
//! keypad arrow). macOS: `kVK_*` virtual keycode + the flags a real keyboard
//! sets for that key (arrows carry NumericPad|SecondaryFn, nav and F-keys SecondaryFn).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyDef {
    pub code: &'static str,
    pub win_vk: u16,
    pub win_extended: bool,
    pub mac: u16,
    pub mac_fn: bool,
    pub mac_numpad: bool,
}

const fn k(code: &'static str, win_vk: u16, win_extended: bool, mac: u16, mac_fn: bool, mac_numpad: bool) -> KeyDef {
    KeyDef { code, win_vk, win_extended, mac, mac_fn, mac_numpad }
}

#[rustfmt::skip]
static KEYS: &[KeyDef] = &[
    k("KeyA", 0x41, false, 0x00, false, false), k("KeyB", 0x42, false, 0x0B, false, false),
    k("KeyC", 0x43, false, 0x08, false, false), k("KeyD", 0x44, false, 0x02, false, false),
    k("KeyE", 0x45, false, 0x0E, false, false), k("KeyF", 0x46, false, 0x03, false, false),
    k("KeyG", 0x47, false, 0x05, false, false), k("KeyH", 0x48, false, 0x04, false, false),
    k("KeyI", 0x49, false, 0x22, false, false), k("KeyJ", 0x4A, false, 0x26, false, false),
    k("KeyK", 0x4B, false, 0x28, false, false), k("KeyL", 0x4C, false, 0x25, false, false),
    k("KeyM", 0x4D, false, 0x2E, false, false), k("KeyN", 0x4E, false, 0x2D, false, false),
    k("KeyO", 0x4F, false, 0x1F, false, false), k("KeyP", 0x50, false, 0x23, false, false),
    k("KeyQ", 0x51, false, 0x0C, false, false), k("KeyR", 0x52, false, 0x0F, false, false),
    k("KeyS", 0x53, false, 0x01, false, false), k("KeyT", 0x54, false, 0x11, false, false),
    k("KeyU", 0x55, false, 0x20, false, false), k("KeyV", 0x56, false, 0x09, false, false),
    k("KeyW", 0x57, false, 0x0D, false, false), k("KeyX", 0x58, false, 0x07, false, false),
    k("KeyY", 0x59, false, 0x10, false, false), k("KeyZ", 0x5A, false, 0x06, false, false),
    k("Digit0", 0x30, false, 0x1D, false, false), k("Digit1", 0x31, false, 0x12, false, false),
    k("Digit2", 0x32, false, 0x13, false, false), k("Digit3", 0x33, false, 0x14, false, false),
    k("Digit4", 0x34, false, 0x15, false, false), k("Digit5", 0x35, false, 0x17, false, false),
    k("Digit6", 0x36, false, 0x16, false, false), k("Digit7", 0x37, false, 0x1A, false, false),
    k("Digit8", 0x38, false, 0x1C, false, false), k("Digit9", 0x39, false, 0x19, false, false),
    k("Minus", 0xBD, false, 0x1B, false, false), k("Equal", 0xBB, false, 0x18, false, false),
    k("BracketLeft", 0xDB, false, 0x21, false, false), k("BracketRight", 0xDD, false, 0x1E, false, false),
    k("Backslash", 0xDC, false, 0x2A, false, false), k("Semicolon", 0xBA, false, 0x29, false, false),
    k("Quote", 0xDE, false, 0x27, false, false), k("Backquote", 0xC0, false, 0x32, false, false),
    k("Comma", 0xBC, false, 0x2B, false, false), k("Period", 0xBE, false, 0x2F, false, false),
    k("Slash", 0xBF, false, 0x2C, false, false),
    k("Space", 0x20, false, 0x31, false, false), k("Enter", 0x0D, false, 0x24, false, false),
    k("Tab", 0x09, false, 0x30, false, false), k("Escape", 0x1B, false, 0x35, false, false),
    // W3C "Backspace" is the key labelled delete on a Mac keyboard.
    k("Backspace", 0x08, false, 0x33, false, false),
    k("Delete", 0x2E, true, 0x75, true, false), k("Insert", 0x2D, true, 0x72, true, false),
    k("Home", 0x24, true, 0x73, true, false), k("End", 0x23, true, 0x77, true, false),
    k("PageUp", 0x21, true, 0x74, true, false), k("PageDown", 0x22, true, 0x79, true, false),
    k("ArrowLeft", 0x25, true, 0x7B, true, true), k("ArrowRight", 0x27, true, 0x7C, true, true),
    k("ArrowUp", 0x26, true, 0x7E, true, true), k("ArrowDown", 0x28, true, 0x7D, true, true),
    k("F1", 0x70, false, 0x7A, true, false), k("F2", 0x71, false, 0x78, true, false),
    k("F3", 0x72, false, 0x63, true, false), k("F4", 0x73, false, 0x76, true, false),
    k("F5", 0x74, false, 0x60, true, false), k("F6", 0x75, false, 0x61, true, false),
    k("F7", 0x76, false, 0x62, true, false), k("F8", 0x77, false, 0x64, true, false),
    k("F9", 0x78, false, 0x65, true, false), k("F10", 0x79, false, 0x6D, true, false),
    k("F11", 0x7A, false, 0x67, true, false), k("F12", 0x7B, false, 0x6F, true, false),
    k("F13", 0x7C, false, 0x69, true, false), k("F14", 0x7D, false, 0x6B, true, false),
    k("F15", 0x7E, false, 0x71, true, false), k("F16", 0x7F, false, 0x6A, true, false),
    k("F17", 0x80, false, 0x40, true, false), k("F18", 0x81, false, 0x4F, true, false),
    k("F19", 0x82, false, 0x50, true, false), k("F20", 0x83, false, 0x5A, true, false),
];

pub fn lookup(code: &str) -> Option<KeyDef> {
    KEYS.iter().copied().find(|d| d.code == code)
}

/// Modifier keys. Windows uses the left-hand virtual keys; macOS the left-hand keycodes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Modifier {
    Shift,
    Ctrl,
    Alt,
    Meta,
}

impl Modifier {
    pub const ALL: [Modifier; 4] = [Modifier::Shift, Modifier::Ctrl, Modifier::Alt, Modifier::Meta];

    pub const fn bit(self) -> u8 {
        match self {
            Modifier::Shift => 1,
            Modifier::Ctrl => 2,
            Modifier::Alt => 4,
            Modifier::Meta => 8,
        }
    }

    pub const fn win_vk(self) -> u16 {
        match self {
            Modifier::Shift => 0xA0, // VK_LSHIFT
            Modifier::Ctrl => 0xA2,  // VK_LCONTROL
            Modifier::Alt => 0xA4,   // VK_LMENU
            Modifier::Meta => 0x5B,  // VK_LWIN
        }
    }

    pub const fn mac(self) -> u16 {
        match self {
            Modifier::Shift => 0x38,
            Modifier::Ctrl => 0x3B,
            Modifier::Alt => 0x3A,
            Modifier::Meta => 0x37,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nav_keys_are_extended_on_windows() {
        for code in
            ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Insert", "Delete"]
        {
            assert!(lookup(code).unwrap().win_extended, "{code} must carry KEYEVENTF_EXTENDEDKEY");
        }
        for code in ["KeyB", "Backspace", "Enter", "Space", "BracketLeft"] {
            assert!(!lookup(code).unwrap().win_extended, "{code} must not be extended");
        }
    }

    #[test]
    fn arrows_carry_numpad_and_fn_on_mac() {
        for code in ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"] {
            let d = lookup(code).unwrap();
            assert!(d.mac_fn && d.mac_numpad, "{code}");
        }
        let bs = lookup("Backspace").unwrap();
        assert!(!bs.mac_fn && !bs.mac_numpad);
    }

    #[test]
    fn codes_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for d in KEYS {
            assert!(seen.insert(d.code), "duplicate {}", d.code);
        }
        assert_eq!(seen.len(), KEYS.len());
    }
}
