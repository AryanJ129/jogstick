//! Node addon surface. Phase 0 exposes only what the desktop shell needs to prove
//! the addon loads; the full injection/pad API lands in Phase 3.

use napi_derive::napi;

#[napi]
pub fn native_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[napi]
pub fn cursor_position() -> napi::Result<Vec<f64>> {
    use crate::injector::Backend;
    let b = crate::PlatformBackend::new().map_err(napi::Error::from_reason)?;
    let (x, y) = b.cursor_position().map_err(napi::Error::from_reason)?;
    Ok(vec![x, y])
}
