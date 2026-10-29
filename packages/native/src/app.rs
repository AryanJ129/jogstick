//! OS-independent view of "what is in front", for the gate.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Frontmost {
    /// Windows: the exe name (`Resolve.exe`); macOS: the bundle identifier.
    pub id: String,
    pub name: String,
    pub pid: u32,
    /// x, y, w, h of the focused window (Windows: physical pixels; macOS: points).
    pub bounds: Option<[f64; 4]>,
    /// The focused window is not the app's main window: an owned window on Windows,
    /// any AXSubrole other than AXStandardWindow (or a modal) on macOS.
    pub is_dialog: bool,
}

/// macOS windows that briefly take focus without the user leaving Resolve; the gate
/// keeps its previous state while one of these is in front.
pub const TRANSIENT_MAC: &[&str] = &[
    "com.apple.loginwindow",
    "com.apple.ScreenSaver.Engine",
    "com.apple.SecurityAgent",
    "com.apple.UserNotificationCenter",
];

#[cfg(target_os = "macos")]
pub fn frontmost() -> Option<Frontmost> {
    let w = crate::app_mac::front_window()?;
    let (id, name) = crate::app_mac::bundle_info(w.pid).unwrap_or_else(|| (format!("pid:{}", w.pid), String::new()));
    let is_dialog = w.modal || w.subrole.as_deref() != Some("AXStandardWindow");
    Some(Frontmost { id, name, pid: w.pid, bounds: w.bounds, is_dialog })
}

#[cfg(windows)]
pub fn frontmost() -> Option<Frontmost> {
    let f = crate::app_win::foreground()?;
    let id = f.exe.clone().unwrap_or_else(|| format!("pid:{}", f.pid));
    let name = id.strip_suffix(".exe").or_else(|| id.strip_suffix(".EXE")).unwrap_or(&id).to_string();
    let bounds = f.rect.map(|[l, t, r, b]| [f64::from(l), f64::from(t), f64::from(r - l), f64::from(b - t)]);
    Some(Frontmost { id, name, pid: f.pid, bounds, is_dialog: f.has_owner })
}

#[cfg(target_os = "macos")]
pub fn is_process_running(name: &str) -> bool {
    !crate::app_mac::find_processes(name).is_empty()
}

#[cfg(windows)]
pub fn is_process_running(name: &str) -> bool {
    !crate::app_win::find_processes(name).is_empty()
}
