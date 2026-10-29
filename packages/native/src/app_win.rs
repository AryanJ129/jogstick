//! Windows app/system detection: foreground process and whether it's a dialog,
//! process elevation (UIPI blocks injection into elevated apps silently),
//! running processes (Steam), power source, displays and keyboard layout.

use serde::Serialize;
use windows::core::BOOL;
use windows::Win32::Foundation::{CloseHandle, HANDLE, LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO};

const MONITORINFOF_PRIMARY: u32 = 1;
use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::Win32::System::Threading::{
    GetCurrentProcessId, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::HiDpi::{
    GetDpiForMonitor, SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, MDT_EFFECTIVE_DPI,
};
use windows::Win32::UI::Input::KeyboardAndMouse::GetKeyboardLayout;
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindow, GetWindowRect, GetWindowThreadProcessId, GW_OWNER,
};

/// Same coordinate space as GetCursorPos/SendInput: physical pixels. Electron is already PMv2.
pub fn set_dpi_aware() -> bool {
    // SAFETY: process-wide setting with no pointer arguments.
    unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) }.is_ok()
}

struct OwnedHandle(HANDLE);
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: we own the handle.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

fn process_image_name(pid: u32) -> Option<String> {
    // SAFETY: handle is closed by OwnedHandle; buffer and length are valid.
    unsafe {
        let h = OwnedHandle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?);
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        QueryFullProcessImageNameW(h.0, PROCESS_NAME_WIN32, windows::core::PWSTR(buf.as_mut_ptr()), &mut len).ok()?;
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        Some(path.rsplit('\\').next().unwrap_or(&path).to_string())
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Foreground {
    pub pid: u32,
    pub exe: Option<String>,
    /// Owned windows are dialogs (Save project?, render settings…).
    pub has_owner: bool,
    pub rect: Option<[i32; 4]>,
}

pub fn foreground() -> Option<Foreground> {
    // SAFETY: plain Win32 queries on the current foreground window.
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let has_owner = GetWindow(hwnd, GW_OWNER).map(|h| !h.0.is_null()).unwrap_or(false);
        let mut r = RECT::default();
        let rect = GetWindowRect(hwnd, &mut r).ok().map(|_| [r.left, r.top, r.right, r.bottom]);
        Some(Foreground { pid, exe: process_image_name(pid), has_owner, rect })
    }
}

pub fn foreground_is(exe: &str) -> bool {
    foreground().and_then(|f| f.exe).is_some_and(|e| e.eq_ignore_ascii_case(exe))
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Elevation {
    Elevated,
    NotElevated,
    /// We couldn't open the token; from a non-elevated caller this usually means the target is elevated.
    Unknown {
        reason: String,
    },
}

pub fn elevation(pid: u32) -> Elevation {
    // SAFETY: handles are closed by OwnedHandle; out-pointers are valid.
    unsafe {
        let proc_h = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(h) => OwnedHandle(h),
            Err(e) => return Elevation::Unknown { reason: format!("OpenProcess: {e}") },
        };
        let mut tok = HANDLE::default();
        if let Err(e) = OpenProcessToken(proc_h.0, TOKEN_QUERY, &mut tok) {
            return Elevation::Unknown { reason: format!("OpenProcessToken: {e}") };
        }
        let tok = OwnedHandle(tok);
        let mut el = TOKEN_ELEVATION::default();
        let mut len = 0u32;
        if let Err(e) = GetTokenInformation(
            tok.0,
            TokenElevation,
            Some(&mut el as *mut _ as *mut _),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut len,
        ) {
            return Elevation::Unknown { reason: format!("GetTokenInformation: {e}") };
        }
        if el.TokenIsElevated != 0 {
            Elevation::Elevated
        } else {
            Elevation::NotElevated
        }
    }
}

pub fn self_elevation() -> Elevation {
    // SAFETY: no preconditions.
    elevation(unsafe { GetCurrentProcessId() })
}

/// PIDs of running processes whose image name matches `exe` (case-insensitive).
pub fn find_processes(exe: &str) -> Vec<u32> {
    let mut out = Vec::new();
    // SAFETY: snapshot handle is closed by OwnedHandle; entry has dwSize set.
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
        let snap = OwnedHandle(snap);
        let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut ok = Process32FirstW(snap.0, &mut e).is_ok();
        while ok {
            let n = e.szExeFile.iter().position(|c| *c == 0).unwrap_or(e.szExeFile.len());
            if String::from_utf16_lossy(&e.szExeFile[..n]).eq_ignore_ascii_case(exe) {
                out.push(e.th32ProcessID);
            }
            ok = Process32NextW(snap.0, &mut e).is_ok();
        }
    }
    out
}

#[derive(Debug, Clone, Serialize)]
pub struct Power {
    pub on_ac: Option<bool>,
    pub has_battery: bool,
    pub battery_percent: Option<u8>,
}

pub fn power() -> Option<Power> {
    let mut s = SYSTEM_POWER_STATUS::default();
    // SAFETY: valid out-pointer.
    unsafe { GetSystemPowerStatus(&mut s) }.ok()?;
    Some(Power {
        on_ac: match s.ACLineStatus {
            0 => Some(false),
            1 => Some(true),
            _ => None,
        },
        has_battery: s.BatteryFlag != 128 && s.BatteryFlag != 255,
        battery_percent: (s.BatteryLifePercent <= 100).then_some(s.BatteryLifePercent),
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct Display {
    pub rect: [i32; 4],
    pub dpi: u32,
    pub scale_percent: u32,
    pub primary: bool,
}

unsafe extern "system" fn monitor_cb(m: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
    let out = &mut *(data.0 as *mut Vec<Display>);
    let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    if GetMonitorInfoW(m, &mut info).as_bool() {
        let (mut dx, mut dy) = (96u32, 96u32);
        let _ = GetDpiForMonitor(m, MDT_EFFECTIVE_DPI, &mut dx, &mut dy);
        let r = info.rcMonitor;
        out.push(Display {
            rect: [r.left, r.top, r.right, r.bottom],
            dpi: dx,
            scale_percent: dx * 100 / 96,
            primary: info.dwFlags & MONITORINFOF_PRIMARY != 0,
        });
    }
    true.into()
}

pub fn displays() -> Vec<Display> {
    let mut out: Vec<Display> = Vec::new();
    // SAFETY: the callback only runs during this call and writes into `out`.
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(monitor_cb), LPARAM(&mut out as *mut _ as isize));
    }
    out
}

/// Keyboard layout (HKL) of the foreground window's thread, e.g. `0x04090409` for US English.
pub fn foreground_keyboard_layout() -> String {
    // SAFETY: plain queries.
    unsafe {
        let thread = GetWindowThreadProcessId(GetForegroundWindow(), None);
        format!("{:#010x}", GetKeyboardLayout(thread).0 as usize)
    }
}
