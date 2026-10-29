//! macOS app detection for the gate: the frontmost app and whether its focused window
//! is Resolve's main window or a dialog, read through the Accessibility API (the same
//! grant injection needs; no Screen Recording), plus process lookup through libproc.

use core_foundation::base::{CFType, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::bundle::CFBundle;
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::number::CFNumber;
use core_foundation::string::{CFString, CFStringRef};
use core_foundation::url::CFURL;
use core_graphics::geometry::{CGPoint, CGSize};
use core_graphics::window::{
    copy_window_info, kCGNullWindowID, kCGWindowLayer, kCGWindowListExcludeDesktopElements,
    kCGWindowListOptionOnScreenOnly, kCGWindowOwnerPID,
};
use std::ffi::c_void;
use std::os::raw::c_int;

type AXUIElementRef = CFTypeRef;
type AXError = i32;
const AX_SUCCESS: AXError = 0;
const AX_VALUE_CGPOINT: u32 = 1;
const AX_VALUE_CGSIZE: u32 = 2;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    fn AXUIElementCreateApplication(pid: c_int) -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(element: AXUIElementRef, attribute: CFStringRef, value: *mut CFTypeRef)
        -> AXError;
    fn AXUIElementGetPid(element: AXUIElementRef, pid: *mut c_int) -> AXError;
    fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, seconds: f32) -> AXError;
    fn AXValueGetValue(value: CFTypeRef, kind: u32, out: *mut c_void) -> bool;
}

extern "C" {
    fn proc_pidpath(pid: c_int, buffer: *mut c_void, buffersize: u32) -> c_int;
    fn proc_listallpids(buffer: *mut c_void, buffersize: c_int) -> c_int;
}

const PROC_PIDPATHINFO_MAXSIZE: usize = 4096;

/// An owned AX element / CF value, released on drop.
struct Owned(CFTypeRef);

impl Owned {
    fn new(r: CFTypeRef) -> Option<Owned> {
        // `then`, not `then_some`: an eagerly built Owned(null) would be dropped → CFRelease(NULL) traps.
        (!r.is_null()).then(|| Owned(r))
    }

    fn attr(&self, name: &'static str) -> Option<Owned> {
        let key = CFString::from_static_string(name);
        let mut out: CFTypeRef = std::ptr::null();
        // SAFETY: `self.0` is a live AX element; `out` receives a +1 reference or stays null.
        let err = unsafe { AXUIElementCopyAttributeValue(self.0, key.as_concrete_TypeRef(), &mut out) };
        if err == AX_SUCCESS {
            Owned::new(out)
        } else {
            None
        }
    }

    fn as_string(&self) -> Option<String> {
        // SAFETY: we hold a reference; wrap_under_get_rule retains it for the CFType's lifetime.
        let v = unsafe { CFType::wrap_under_get_rule(self.0) };
        v.downcast::<CFString>().map(|s| s.to_string())
    }

    fn as_bool(&self) -> Option<bool> {
        // SAFETY: as above.
        let v = unsafe { CFType::wrap_under_get_rule(self.0) };
        v.downcast::<CFBoolean>().map(bool::from)
    }

    fn value<T: Default>(&self, kind: u32) -> Option<T> {
        let mut out = T::default();
        // SAFETY: `kind` matches T (CGPoint ↔ 1, CGSize ↔ 2); AXValueGetValue returns false on mismatch.
        unsafe { AXValueGetValue(self.0, kind, &mut out as *mut T as *mut c_void) }.then_some(out)
    }
}

impl Drop for Owned {
    fn drop(&mut self) {
        // SAFETY: we own exactly one reference.
        unsafe { core_foundation::base::CFRelease(self.0) };
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct FrontWindow {
    pub pid: u32,
    /// `AXSubrole` of the focused window: `AXStandardWindow` for main windows,
    /// `AXDialog` / `AXSystemDialog` / `AXFloatingWindow` for the rest. None = no focused window.
    pub subrole: Option<String>,
    pub modal: bool,
    /// x, y, w, h in global display points.
    pub bounds: Option<[f64; 4]>,
}

/// Owner of the front-most on-screen normal (layer 0) window. Owner PIDs need no Screen
/// Recording permission. Only a candidate: an active app with no windows (Finder on the
/// desktop) leaves another app's window on top, so the caller confirms with AXFrontmost.
fn top_window_pid() -> Option<u32> {
    let list =
        copy_window_info(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID)?;
    // SAFETY: framework-owned constant keys.
    let (layer_key, pid_key) =
        unsafe { (CFString::wrap_under_get_rule(kCGWindowLayer), CFString::wrap_under_get_rule(kCGWindowOwnerPID)) };
    list.iter().find_map(|item| {
        // SAFETY: CGWindowListCopyWindowInfo returns an array of CFDictionary.
        let dict: CFDictionary<CFString, CFType> = unsafe { TCFType::wrap_under_get_rule(*item as CFDictionaryRef) };
        let num = |k: &CFString| dict.find(k).and_then(|v| v.downcast::<CFNumber>()).and_then(|n| n.to_i64());
        (num(&layer_key) == Some(0)).then(|| num(&pid_key)).flatten().map(|p| p as u32)
    })
}

fn app_element(pid: u32) -> Option<Owned> {
    // SAFETY: returns a +1 reference we own (an element for any pid; calls on it may fail).
    let app = Owned::new(unsafe { AXUIElementCreateApplication(pid as c_int) })?;
    // A hung app must not hang the gate: AX calls to it time out after 250 ms.
    // SAFETY: live element.
    unsafe { AXUIElementSetMessagingTimeout(app.0, 0.25) };
    Some(app)
}

/// The active application: the top window's owner if AX confirms it is frontmost, else
/// AX's system-wide focused application. None if neither works (gate stays closed).
fn active_app() -> Option<(u32, Owned)> {
    if let Some(pid) = top_window_pid() {
        if let Some(app) = app_element(pid) {
            if app.attr("AXFrontmost").and_then(|v| v.as_bool()) == Some(true) {
                return Some((pid, app));
            }
        }
    }
    // SAFETY: returns a +1 reference we own.
    let system = Owned::new(unsafe { AXUIElementCreateSystemWide() })?;
    // SAFETY: live element.
    unsafe { AXUIElementSetMessagingTimeout(system.0, 0.25) };
    let app = system.attr("AXFocusedApplication")?;
    let mut pid: c_int = 0;
    // SAFETY: live element, valid out-pointer.
    if unsafe { AXUIElementGetPid(app.0, &mut pid) } != AX_SUCCESS {
        return None;
    }
    Some((pid as u32, app))
}

/// The active application and its focused window. None if AX isn't trusted or nothing is focused.
pub fn front_window() -> Option<FrontWindow> {
    let (pid, app) = active_app()?;
    let window = app.attr("AXFocusedWindow");
    let subrole = window.as_ref().and_then(|w| w.attr("AXSubrole")).and_then(|s| s.as_string());
    let modal = window.as_ref().and_then(|w| w.attr("AXModal")).and_then(|m| m.as_bool()).unwrap_or(false);
    let bounds = window.as_ref().and_then(|w| {
        let p: CGPoint = w.attr("AXPosition")?.value(AX_VALUE_CGPOINT)?;
        let s: CGSize = w.attr("AXSize")?.value(AX_VALUE_CGSIZE)?;
        Some([p.x, p.y, s.width, s.height])
    });
    Some(FrontWindow { pid, subrole, modal, bounds })
}

pub fn process_path(pid: u32) -> Option<String> {
    let mut buf = vec![0u8; PROC_PIDPATHINFO_MAXSIZE];
    // SAFETY: buffer and its length are valid.
    let n = unsafe { proc_pidpath(pid as c_int, buf.as_mut_ptr().cast(), buf.len() as u32) };
    if n <= 0 {
        return None;
    }
    buf.truncate(n as usize);
    String::from_utf8(buf).ok()
}

/// `/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/MacOS/Resolve`
/// → `/Applications/DaVinci Resolve/DaVinci Resolve.app` (the outermost bundle wins for helpers).
pub fn bundle_path(exe: &str) -> Option<&str> {
    // `.bundle` too: SecurityAgent (the password prompt) runs from SecurityAgent.bundle.
    [".app/", ".bundle/"]
        .iter()
        .filter_map(|ext| exe.find(ext).map(|i| &exe[..i + ext.len() - 1]))
        .min_by_key(|s| s.len())
}

/// Bundle identifier and display name of the app that owns `pid`.
pub fn bundle_info(pid: u32) -> Option<(String, String)> {
    let exe = process_path(pid)?;
    let fallback_name = exe.rsplit('/').next().unwrap_or(&exe).to_string();
    let Some(bundle) = bundle_path(&exe) else {
        return Some((fallback_name.clone(), fallback_name));
    };
    let url = CFURL::from_path(bundle, true)?;
    let b = CFBundle::new(url)?;
    let info = b.info_dictionary();
    let get = |k: &'static str| {
        info.find(CFString::from_static_string(k)).and_then(|v| v.downcast::<CFString>()).map(|s| s.to_string())
    };
    let id = get("CFBundleIdentifier").unwrap_or_else(|| fallback_name.clone());
    let name = get("CFBundleName").unwrap_or(fallback_name);
    Some((id, name))
}

pub fn all_pids() -> Vec<u32> {
    // SAFETY: a null buffer asks for the count.
    let n = unsafe { proc_listallpids(std::ptr::null_mut(), 0) };
    if n <= 0 {
        return Vec::new();
    }
    let mut pids = vec![0 as c_int; n as usize + 64];
    let bytes = (pids.len() * std::mem::size_of::<c_int>()) as c_int;
    // SAFETY: buffer and its byte length are valid.
    let got = unsafe { proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
    pids.truncate(got.max(0) as usize);
    pids.into_iter().filter(|p| *p > 0).map(|p| p as u32).collect()
}

/// PIDs whose executable file name equals `name` (case-insensitive), e.g. `steam_osx`.
pub fn find_processes(name: &str) -> Vec<u32> {
    all_pids()
        .into_iter()
        .filter(|pid| {
            process_path(*pid).is_some_and(|p| p.rsplit('/').next().is_some_and(|f| f.eq_ignore_ascii_case(name)))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundle_path_takes_the_outermost_app() {
        assert_eq!(
            bundle_path("/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/MacOS/Resolve"),
            Some("/Applications/DaVinci Resolve/DaVinci Resolve.app")
        );
        assert_eq!(
            bundle_path("/A/Outer.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper"),
            Some("/A/Outer.app")
        );
        assert_eq!(
            bundle_path(
                "/System/Library/Frameworks/Security.framework/Versions/A/MachServices/SecurityAgent.bundle/Contents/MacOS/SecurityAgent"
            ),
            Some("/System/Library/Frameworks/Security.framework/Versions/A/MachServices/SecurityAgent.bundle")
        );
        assert_eq!(bundle_path("/usr/bin/true"), None);
    }

    /// Manual diagnostic: `cargo test -- --ignored --nocapture ax_diagnostic`.
    #[test]
    #[ignore]
    fn ax_diagnostic() {
        let which = std::env::var("AXDIAG").unwrap_or_default();
        // SAFETY: +1 reference we own.
        let system = Owned::new(unsafe { AXUIElementCreateSystemWide() }).unwrap();
        let attr = if which == "uielement" { "AXFocusedUIElement" } else { "AXFocusedApplication" };
        let key = CFString::from_static_string(attr);
        let mut out: CFTypeRef = std::ptr::null();
        // SAFETY: live element, valid out-pointer.
        let err = unsafe { AXUIElementCopyAttributeValue(system.0, key.as_concrete_TypeRef(), &mut out) };
        println!("{attr}: AXError {err}, out null: {}", out.is_null());
        drop(Owned::new(out));
        println!("top window pid: {:?}", top_window_pid());
        println!("front_window: {:?}", front_window());
        println!("frontmost: {:?}", crate::app::frontmost());
    }

    #[test]
    fn finds_this_test_process() {
        let me = std::process::id();
        let path = process_path(me).expect("own path");
        let file = path.rsplit('/').next().unwrap();
        assert!(find_processes(file).contains(&me));
        assert!(all_pids().contains(&me));
    }
}
