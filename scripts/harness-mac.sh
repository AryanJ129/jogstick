#!/bin/sh
# Build jogstick-harness as a small signed .app and run its self-test on macOS.
# Wrapping it in an app bundle gives it its own Accessibility (TCC) entry,
# "Jogstick Harness", instead of borrowing the terminal's. Signing with the stable
# "Jogstick Dev" identity keeps that grant across rebuilds.
#
#   scripts/harness-mac.sh            self-test (exit 0 = all checks passed)
#   scripts/harness-mac.sh --log      open the harness and log events until closed
#   scripts/harness-mac.sh --build    build and sign only (signing briefly shows SecurityAgent,
#                                     which takes focus; scripts/e2e.ts signs first, then opens)
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
native="$root/packages/native"
app="$native/target/JogstickHarness.app"
logdir="$native/target/harness-logs"

cargo build --manifest-path "$native/Cargo.toml" --release --features harness --bin jogstick-harness

mkdir -p "$app/Contents/MacOS" "$logdir"
cp "$native/target/release/jogstick-harness" "$app/Contents/MacOS/jogstick-harness"
cat > "$app/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>dev.jogstick.harness</string>
  <key>CFBundleName</key><string>Jogstick Harness</string>
  <key>CFBundleExecutable</key><string>jogstick-harness</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
EOF
"$root/scripts/dev-sign-mac.sh" "$app" >/dev/null
[ "${1:-}" = "--build" ] && exit 0

mode="--self-test"
[ "${1:-}" = "--log" ] && mode="--log"
out="$logdir/stdout.log"
err="$logdir/stderr.log"
: > "$out"
: > "$err"
open -W -n --stdout "$out" --stderr "$err" "$app" --args "$mode"
cat "$out"
cat "$err" >&2
if [ "$mode" = "--self-test" ]; then
  grep -q "checks passed" "$out" || exit 3
  summary="$(grep "checks passed" "$out")"
  passed="$(echo "$summary" | sed -E 's/.*: ([0-9]+)\/([0-9]+).*/\1/')"
  total="$(echo "$summary" | sed -E 's/.*: ([0-9]+)\/([0-9]+).*/\2/')"
  [ "$passed" = "$total" ] && [ "$total" -gt 0 ]
fi
