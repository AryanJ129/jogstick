fn main() {
    // Only the Node addon needs napi's link setup; the probe and harness binaries don't.
    if std::env::var_os("CARGO_FEATURE_ADDON").is_some() {
        napi_build::setup();
    }
}
