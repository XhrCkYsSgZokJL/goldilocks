#!/usr/bin/env bash
# Repairs the @xmtp/node-bindings darwin-arm64 prebuilt.
#
# @xmtp/node-bindings@1.10.0 ships an Apple Silicon binary whose LC_LOAD_DYLIB
# for libiconv points at a Nix build-sandbox path
# (/nix/store/...-libiconv-.../lib/libiconv.2.dylib) that does not exist on a
# normal Mac. require() of the bindings then throws ERR_DLOPEN_FAILED and the
# agent process exits on boot. The darwin-x64 prebuilt of the same version is
# unaffected. We repoint that one load command at the system libiconv.
#
# Runs automatically via the npm "postinstall" hook. Idempotent: a no-op on
# anything other than Apple Silicon macOS, and a no-op once the binary is clean.
set -euo pipefail

[ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ] || exit 0

cd "$(dirname "$0")/.."
BIN="node_modules/@xmtp/node-bindings/dist/bindings_node.darwin-arm64.node"
[ -f "$BIN" ] || exit 0
command -v otool >/dev/null 2>&1 || exit 0

BAD="$(otool -L "$BIN" 2>/dev/null | awk '/\/nix\/store\/.*libiconv/{print $1; exit}' || true)"
[ -n "$BAD" ] || exit 0   # already patched, or not affected

echo "patch-xmtp-bindings: $BIN links a missing Nix libiconv — repairing"
echo "  $BAD"
echo "  -> /usr/lib/libiconv.2.dylib"
install_name_tool -change "$BAD" /usr/lib/libiconv.2.dylib "$BIN"
codesign --force --sign - "$BIN" >/dev/null 2>&1 || true
echo "patch-xmtp-bindings: done"
