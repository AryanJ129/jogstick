//! Jogstick native layer: key/mouse injection, pad reading and app detection,
//! shared by the Node addon (`addon` feature), `jogstick-probe` and `jogstick-harness`.

pub mod combo;
pub mod injector;
pub mod keymap;
pub mod pad;
pub mod probe;

#[cfg(target_os = "macos")]
pub mod inject_mac;

#[cfg(windows)]
pub mod app_win;
#[cfg(windows)]
pub mod inject_win;
#[cfg(windows)]
pub mod pad_win;

#[cfg(feature = "addon")]
mod addon;

/// Value written into every injected event (`dwExtraInfo` on Windows,
/// `eventSourceUserData` on macOS) so our own code can recognise it. ASCII "JOGS".
pub const EVENT_TAG: i64 = 0x4A4F_4753;

/// The platform injector backend.
#[cfg(target_os = "macos")]
pub type PlatformBackend = inject_mac::MacBackend;
#[cfg(windows)]
pub type PlatformBackend = inject_win::WinBackend;
