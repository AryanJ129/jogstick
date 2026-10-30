//! Windows injection through SendInput: virtual key + scan code (foreground
//! window's layout) + KEYEVENTF_EXTENDEDKEY for nav keys; absolute mouse moves in
//! virtual-desktop coordinates (relative moves go through pointer acceleration).
//! Every event carries `EVENT_TAG` in `dwExtraInfo`.

use crate::combo::Mods;
use crate::injector::{Backend, KeyOpts, MouseBtn};
use crate::keymap::{KeyDef, Modifier};
use crate::EVENT_TAG;
use std::mem::size_of;
use windows::Win32::Foundation::POINT;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, GetKeyboardLayout, MapVirtualKeyExW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE,
    KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, MAPVK_VK_TO_VSC_EX, MOUSEEVENTF_ABSOLUTE,
    MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP,
    MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL,
    MOUSEINPUT, MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetForegroundWindow, GetSystemMetrics, GetWindowThreadProcessId, SM_CXVIRTUALSCREEN,
    SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

fn send(inputs: &[INPUT]) -> Result<(), String> {
    // SAFETY: `inputs` is a valid slice of initialised INPUT structs.
    let sent = unsafe { SendInput(inputs, size_of::<INPUT>() as i32) };
    if sent as usize == inputs.len() {
        Ok(())
    } else {
        Err(format!("SendInput sent {sent}/{} events: {}", inputs.len(), windows::core::Error::from_thread()))
    }
}

/// Scan code for `vk` in the foreground window's keyboard layout, and whether the
/// layout says it is an extended (E0-prefixed) key.
fn scan_code(vk: u16) -> (u16, bool) {
    // SAFETY: plain Win32 queries with no pointer arguments we own.
    unsafe {
        let thread = GetWindowThreadProcessId(GetForegroundWindow(), None);
        let layout = GetKeyboardLayout(thread);
        let sc = MapVirtualKeyExW(u32::from(vk), MAPVK_VK_TO_VSC_EX, Some(layout));
        ((sc & 0xFF) as u16, sc & 0xFF00 == 0xE000)
    }
}

pub fn key_input(vk: u16, extended: bool, down: bool) -> INPUT {
    let (scan, _) = scan_code(vk);
    let mut flags = KEYBD_EVENT_FLAGS(0);
    if extended {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    if !down {
        flags |= KEYEVENTF_KEYUP;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: EVENT_TAG as usize,
            },
        },
    }
}

fn mouse_input(dx: i32, dy: i32, flags: MOUSE_EVENT_FLAGS) -> INPUT {
    mouse_input_data(dx, dy, 0, flags)
}

/// `data` is the signed wheel delta for MOUSEEVENTF_WHEEL / HWHEEL (mouseData is a DWORD).
fn mouse_input_data(dx: i32, dy: i32, data: i32, flags: MOUSE_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT { dx, dy, mouseData: data as u32, dwFlags: flags, time: 0, dwExtraInfo: EVENT_TAG as usize },
        },
    }
}

/// One wheel notch.
const WHEEL_DELTA: i32 = 120;

fn async_down(vk: u16) -> bool {
    // SAFETY: plain query; the high bit means "down now".
    (unsafe { GetAsyncKeyState(i32::from(vk)) } as u16) & 0x8000 != 0
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VirtualDesktop {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

pub fn virtual_desktop() -> VirtualDesktop {
    // SAFETY: GetSystemMetrics has no preconditions.
    unsafe {
        VirtualDesktop {
            x: GetSystemMetrics(SM_XVIRTUALSCREEN),
            y: GetSystemMetrics(SM_YVIRTUALSCREEN),
            w: GetSystemMetrics(SM_CXVIRTUALSCREEN),
            h: GetSystemMetrics(SM_CYVIRTUALSCREEN),
        }
    }
}

/// Physical pixel → SendInput's 0..65535 virtual-desktop space.
pub fn normalize(x: f64, y: f64, vd: VirtualDesktop) -> (i32, i32) {
    let nx = ((x - f64::from(vd.x)) * 65535.0 / f64::from((vd.w - 1).max(1))).round();
    let ny = ((y - f64::from(vd.y)) * 65535.0 / f64::from((vd.h - 1).max(1))).round();
    (nx.clamp(0.0, 65535.0) as i32, ny.clamp(0.0, 65535.0) as i32)
}

#[derive(Default)]
pub struct WinBackend;

impl WinBackend {
    pub fn new() -> Result<Self, String> {
        Ok(WinBackend)
    }
}

impl Backend for WinBackend {
    fn key(&mut self, key: &KeyDef, down: bool, _mods: Mods, opts: KeyOpts) -> Result<(), String> {
        let extended = key.win_extended && !opts.force_no_extended;
        send(&[key_input(key.win_vk, extended, down)])
    }

    fn modifiers(&mut self, from: Mods, to: Mods) -> Result<(), String> {
        let inputs: Vec<INPUT> = Modifier::ALL
            .into_iter()
            .filter(|m| from.has(*m) != to.has(*m))
            .map(|m| key_input(m.win_vk(), false, to.has(m)))
            .collect();
        if inputs.is_empty() {
            return Ok(());
        }
        send(&inputs)
    }

    fn mouse_button(&mut self, btn: MouseBtn, down: bool, _mods: Mods) -> Result<(), String> {
        let flags = match (btn, down) {
            (MouseBtn::Left, true) => MOUSEEVENTF_LEFTDOWN,
            (MouseBtn::Left, false) => MOUSEEVENTF_LEFTUP,
            (MouseBtn::Right, true) => MOUSEEVENTF_RIGHTDOWN,
            (MouseBtn::Right, false) => MOUSEEVENTF_RIGHTUP,
            (MouseBtn::Middle, true) => MOUSEEVENTF_MIDDLEDOWN,
            (MouseBtn::Middle, false) => MOUSEEVENTF_MIDDLEUP,
        };
        send(&[mouse_input(0, 0, flags)])
    }

    fn mouse_move_to(&mut self, x: f64, y: f64, _dragging: Option<MouseBtn>, _mods: Mods) -> Result<(), String> {
        let (nx, ny) = normalize(x, y, virtual_desktop());
        send(&[mouse_input(nx, ny, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK)])
    }

    fn scroll(&mut self, dx: i32, dy: i32, pixels: bool, _mods: Mods) -> Result<(), String> {
        // Lines → whole notches; "pixels" are passed as raw wheel units for smooth scrolling.
        let unit = if pixels { 1 } else { WHEEL_DELTA };
        let mut inputs = Vec::new();
        if dy != 0 {
            inputs.push(mouse_input_data(0, 0, dy * unit, MOUSEEVENTF_WHEEL));
        }
        if dx != 0 {
            inputs.push(mouse_input_data(0, 0, dx * unit, MOUSEEVENTF_HWHEEL));
        }
        if inputs.is_empty() {
            return Ok(());
        }
        send(&inputs)
    }

    fn cursor_position(&self) -> Result<(f64, f64), String> {
        let mut p = POINT::default();
        // SAFETY: `p` is a valid out-pointer.
        unsafe { GetCursorPos(&mut p) }.map_err(|e| format!("GetCursorPos: {e}"))?;
        Ok((f64::from(p.x), f64::from(p.y)))
    }

    fn key_is_down(&self, key: &KeyDef) -> bool {
        async_down(key.win_vk)
    }

    fn modifier_is_down(&self, m: Modifier) -> bool {
        async_down(m.win_vk())
    }

    fn button_is_down(&self, btn: MouseBtn) -> bool {
        // VK_LBUTTON / VK_RBUTTON / VK_MBUTTON (physical buttons, not swapped).
        async_down(match btn {
            MouseBtn::Left => 0x01,
            MouseBtn::Right => 0x02,
            MouseBtn::Middle => 0x04,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_maps_corners() {
        let vd = VirtualDesktop { x: -1920, y: 0, w: 3840, h: 1080 };
        assert_eq!(normalize(-1920.0, 0.0, vd), (0, 0));
        assert_eq!(normalize(1919.0, 1079.0, vd), (65535, 65535));
    }
}
