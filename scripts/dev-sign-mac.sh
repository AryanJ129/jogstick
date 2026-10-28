#!/bin/sh
# Sign macOS dev builds with a stable self-signed identity so the Accessibility
# (TCC) grant survives rebuilds. Ad-hoc signatures are keyed to the code hash
# and lose the grant on every build.
#
#   scripts/dev-sign-mac.sh create-cert      one-time: create "Jogstick Dev" in the login keychain
#   scripts/dev-sign-mac.sh <path> [...]     sign binaries or .app bundles
set -eu

IDENTITY="Jogstick Dev"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if [ "$(uname)" != "Darwin" ]; then
  echo "dev-sign-mac.sh: macOS only" >&2
  exit 1
fi

if [ "${1:-}" = "create-cert" ]; then
  if security find-certificate -c "$IDENTITY" "$KEYCHAIN" >/dev/null 2>&1; then
    echo "\"$IDENTITY\" already exists in the login keychain; nothing to do."
    exit 0
  fi
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  cat > "$tmp/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $IDENTITY
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -config "$tmp/cert.cnf" -keyout "$tmp/key.pem" -out "$tmp/cert.pem" 2>/dev/null
  pass="$(openssl rand -hex 16)"
  openssl pkcs12 -export -inkey "$tmp/key.pem" -in "$tmp/cert.pem" \
    -name "$IDENTITY" -passout "pass:$pass" -out "$tmp/id.p12"
  security import "$tmp/id.p12" -k "$KEYCHAIN" -P "$pass" -T /usr/bin/codesign
  # Trust for code signing only, in the user domain. macOS asks for confirmation.
  security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$tmp/cert.pem"
  security find-identity -v -p codesigning | grep "$IDENTITY"
  exit 0
fi

if [ $# -eq 0 ]; then
  echo "usage: $0 create-cert | <path>..." >&2
  exit 2
fi

for target in "$@"; do
  codesign --force --sign "$IDENTITY" --timestamp=none "$target"
  codesign --verify --verbose=1 "$target"
done
