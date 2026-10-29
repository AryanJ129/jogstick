//! `PadFrame` in the W3C standard-gamepad layout, plus the XInput → frame mapping.

use serde::{Deserialize, Serialize};

pub const BUTTONS: usize = 17;
pub const AXES: usize = 4;

/// Standard mapping: 0 A, 1 B, 2 X, 3 Y, 4 LB, 5 RB, 6 LT, 7 RT, 8 View, 9 Menu,
/// 10 L3, 11 R3, 12–15 d-pad ↑↓←→, 16 Guide. Axes LX, LY, RX, RY with +Y down.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PadFrame {
    /// Monotonic milliseconds.
    pub t: f64,
    pub buttons: [f64; BUTTONS],
    pub axes: [f64; AXES],
}

pub mod btn {
    pub const A: usize = 0;
    pub const B: usize = 1;
    pub const X: usize = 2;
    pub const Y: usize = 3;
    pub const LB: usize = 4;
    pub const RB: usize = 5;
    pub const LT: usize = 6;
    pub const RT: usize = 7;
    pub const VIEW: usize = 8;
    pub const MENU: usize = 9;
    pub const L3: usize = 10;
    pub const R3: usize = 11;
    pub const UP: usize = 12;
    pub const DOWN: usize = 13;
    pub const LEFT: usize = 14;
    pub const RIGHT: usize = 15;
}

/// Raw XInput gamepad state (`XINPUT_GAMEPAD`), kept OS-independent so the
/// mapping is unit-tested on every platform.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct XinputRaw {
    pub buttons: u16,
    pub left_trigger: u8,
    pub right_trigger: u8,
    pub lx: i16,
    pub ly: i16,
    pub rx: i16,
    pub ry: i16,
}

// XINPUT_GAMEPAD_* bits.
const XI_UP: u16 = 0x0001;
const XI_DOWN: u16 = 0x0002;
const XI_LEFT: u16 = 0x0004;
const XI_RIGHT: u16 = 0x0008;
const XI_START: u16 = 0x0010;
const XI_BACK: u16 = 0x0020;
const XI_L3: u16 = 0x0040;
const XI_R3: u16 = 0x0080;
const XI_LB: u16 = 0x0100;
const XI_RB: u16 = 0x0200;
const XI_A: u16 = 0x1000;
const XI_B: u16 = 0x2000;
const XI_X: u16 = 0x4000;
const XI_Y: u16 = 0x8000;

fn stick(v: i16) -> f64 {
    (f64::from(v) / 32767.0).clamp(-1.0, 1.0)
}

impl PadFrame {
    pub fn from_xinput(t: f64, r: XinputRaw) -> PadFrame {
        let mut b = [0.0; BUTTONS];
        let on = |bit: u16| if r.buttons & bit != 0 { 1.0 } else { 0.0 };
        b[btn::A] = on(XI_A);
        b[btn::B] = on(XI_B);
        b[btn::X] = on(XI_X);
        b[btn::Y] = on(XI_Y);
        b[btn::LB] = on(XI_LB);
        b[btn::RB] = on(XI_RB);
        b[btn::LT] = f64::from(r.left_trigger) / 255.0;
        b[btn::RT] = f64::from(r.right_trigger) / 255.0;
        b[btn::VIEW] = on(XI_BACK);
        b[btn::MENU] = on(XI_START);
        b[btn::L3] = on(XI_L3);
        b[btn::R3] = on(XI_R3);
        b[btn::UP] = on(XI_UP);
        b[btn::DOWN] = on(XI_DOWN);
        b[btn::LEFT] = on(XI_LEFT);
        b[btn::RIGHT] = on(XI_RIGHT);
        // XInput +Y is up; the standard mapping's +Y is down.
        let axes = [stick(r.lx), -stick(r.ly), stick(r.rx), -stick(r.ry)];
        PadFrame { t, buttons: b, axes }
    }

    pub fn pressed(&self, i: usize) -> bool {
        self.buttons[i] > 0.5
    }

    /// Same inputs (ignoring the timestamp).
    pub fn same_input(&self, o: &PadFrame) -> bool {
        self.buttons == o.buttons && self.axes == o.axes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_buttons_triggers_and_flips_y() {
        let f = PadFrame::from_xinput(
            5.0,
            XinputRaw {
                buttons: XI_A | XI_BACK | XI_RIGHT,
                left_trigger: 255,
                right_trigger: 0,
                lx: 32767,
                ly: 32767,
                rx: -32768,
                ry: 0,
            },
        );
        assert!(f.pressed(btn::A) && f.pressed(btn::VIEW) && f.pressed(btn::RIGHT));
        assert!(!f.pressed(btn::B) && !f.pressed(btn::MENU));
        assert_eq!(f.buttons[btn::LT], 1.0);
        assert_eq!(f.axes, [1.0, -1.0, -1.0, -0.0]);
    }

    #[test]
    fn every_digital_bit_maps_to_one_button() {
        let bits =
            [XI_UP, XI_DOWN, XI_LEFT, XI_RIGHT, XI_START, XI_BACK, XI_L3, XI_R3, XI_LB, XI_RB, XI_A, XI_B, XI_X, XI_Y];
        for bit in bits {
            let f = PadFrame::from_xinput(0.0, XinputRaw { buttons: bit, ..Default::default() });
            assert_eq!(f.buttons.iter().filter(|v| **v > 0.5).count(), 1, "bit {bit:#06x}");
        }
    }
}
