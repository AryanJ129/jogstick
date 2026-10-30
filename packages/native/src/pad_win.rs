//! XInput pad reading on a dedicated thread paced by a high-resolution waitable
//! timer. XInput keeps delivering while another app (Resolve) has focus, unlike
//! Windows.Gaming.Input, which Chromium's Gamepad API uses.

use crate::pad::XinputRaw;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Threading::{
    CreateWaitableTimerExW, GetCurrentThread, SetThreadPriority, SetWaitableTimer, WaitForSingleObject,
    CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, INFINITE, THREAD_PRIORITY_ABOVE_NORMAL, TIMER_ALL_ACCESS,
};
use windows::Win32::UI::Input::XboxController::{
    XInputGetBatteryInformation, XInputGetState, XInputSetState, BATTERY_DEVTYPE_GAMEPAD, XINPUT_BATTERY_INFORMATION,
    XINPUT_STATE, XINPUT_VIBRATION,
};

const ERROR_SUCCESS: u32 = 0;

/// One poll of one slot.
#[derive(Debug, Clone, Copy)]
pub struct Poll {
    /// Seconds since the loop started.
    pub t: f64,
    pub slot: u32,
    /// `dwPacketNumber`: increments whenever the controller state changes.
    pub packet: u32,
    pub raw: XinputRaw,
}

pub fn read(slot: u32) -> Option<(u32, XinputRaw)> {
    let mut st = XINPUT_STATE::default();
    // SAFETY: `st` is a valid out-pointer.
    if unsafe { XInputGetState(slot, &mut st) } != ERROR_SUCCESS {
        return None;
    }
    let g = st.Gamepad;
    Some((
        st.dwPacketNumber,
        XinputRaw {
            buttons: g.wButtons.0,
            left_trigger: g.bLeftTrigger,
            right_trigger: g.bRightTrigger,
            lx: g.sThumbLX,
            ly: g.sThumbLY,
            rx: g.sThumbRX,
            ry: g.sThumbRY,
        },
    ))
}

/// Connected slots (0–3).
pub fn connected() -> Vec<u32> {
    (0..4).filter(|s| read(*s).is_some()).collect()
}

/// Battery: (type, level) as XInput reports them. Wired pads report type 1 (wired).
pub fn battery(slot: u32) -> Option<(u8, u8)> {
    let mut b = XINPUT_BATTERY_INFORMATION::default();
    // SAFETY: `b` is a valid out-pointer.
    if unsafe { XInputGetBatteryInformation(slot, BATTERY_DEVTYPE_GAMEPAD, &mut b) } != ERROR_SUCCESS {
        return None;
    }
    Some((b.BatteryType.0, b.BatteryLevel.0))
}

/// Set both motors (0..=65535). Works while the app is in the background.
pub fn rumble(slot: u32, low: u16, high: u16) {
    let v = XINPUT_VIBRATION { wLeftMotorSpeed: low, wRightMotorSpeed: high };
    // SAFETY: `v` is a valid pointer for the call's duration.
    unsafe {
        XInputSetState(slot, &v);
    }
}

pub fn rumble_for(slot: u32, low: u16, high: u16, ms: u64) {
    rumble(slot, low, high);
    std::thread::sleep(Duration::from_millis(ms));
    rumble(slot, 0, 0);
}

struct Timer(HANDLE);

impl Timer {
    fn high_res() -> Option<Timer> {
        // SAFETY: null name and attributes are allowed; the handle is closed in Drop.
        unsafe { CreateWaitableTimerExW(None, None, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS.0) }
            .ok()
            .map(Timer)
    }

    fn sleep(&self, d: Duration) {
        // Negative = relative, in 100 ns units.
        let due = -(d.as_nanos() as i64 / 100).max(1);
        // SAFETY: `self.0` is a live timer handle; `due` outlives the call.
        unsafe {
            if SetWaitableTimer(self.0, &due, 0, None, None, false).is_ok() {
                WaitForSingleObject(self.0, INFINITE);
            } else {
                std::thread::sleep(d);
            }
        }
    }
}

impl Drop for Timer {
    fn drop(&mut self) {
        // SAFETY: we own the handle.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

/// Poll `slot` at `hz` until `stop` is set, calling `on_poll` every iteration
/// (including when the pad is disconnected: `raw` is then `None`).
/// Returns whether the high-resolution timer was available.
pub fn run(hz: u32, slot: u32, stop: &AtomicBool, mut on_poll: impl FnMut(f64, Option<Poll>)) -> bool {
    pace(hz, stop, |t| {
        let poll = read(slot).map(|(packet, raw)| Poll { t, slot, packet, raw });
        on_poll(t, poll);
    })
}

/// Call `tick(seconds since start)` at `hz` on the current thread until `stop` is set,
/// paced by a high-resolution waitable timer (falls back to `sleep`). The thread is
/// raised to above-normal priority. Returns whether the high-resolution timer was used.
pub fn pace(hz: u32, stop: &AtomicBool, mut tick: impl FnMut(f64)) -> bool {
    // SAFETY: adjusting our own thread's priority.
    unsafe {
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_ABOVE_NORMAL);
    }
    let timer = Timer::high_res();
    let high_res = timer.is_some();
    let period = Duration::from_secs_f64(1.0 / f64::from(hz));
    let start = Instant::now();
    let mut next = start + period;
    while !stop.load(Ordering::Relaxed) {
        tick(start.elapsed().as_secs_f64());
        let now = Instant::now();
        if next > now {
            let wait = next - now;
            match &timer {
                Some(tm) => tm.sleep(wait),
                None => std::thread::sleep(wait),
            }
            next += period;
        } else {
            // Fell behind (e.g. the machine was busy): resync rather than burst.
            next = now + period;
        }
    }
    high_res
}
