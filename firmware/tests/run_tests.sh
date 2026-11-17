#!/usr/bin/env bash
# Host-side firmware tests. Run from anywhere:
#   firmware/tests/run_tests.sh
#
# These compile the same policy/sha256 sources that go into the Pico image,
# so they run in CI (and long before a remote OTA) without hardware.
set -euo pipefail

cd "$(dirname "$0")/.."
CXX="${CXX:-g++}"
FLAGS="-std=c++17 -O2 -Wall -Wextra -Werror -I src"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

"$CXX" $FLAGS tests/test_policy.cpp -o "$OUT/test_policy"
"$CXX" $FLAGS tests/test_sha256.cpp src/sha256.cpp -o "$OUT/test_sha256"

"$OUT/test_policy"
"$OUT/test_sha256"

# The built image must fit the flash layout and pass the server validator.
BIN=".pio/build/pico-w/firmware.bin"
if [[ -f "$BIN" ]]; then
  SIZE=$(stat -c%s "$BIN")
  MAX=921600  # 900 KiB, matches backend/ota-server/app/firmware_image.py
  if (( SIZE > MAX )); then
    echo "FAIL $BIN is $SIZE bytes, above the ${MAX}-byte OTA limit" >&2
    exit 1
  fi
  echo "artifact: $BIN is $SIZE bytes (limit $MAX)"
else
  echo "artifact: $BIN not built yet (skipping size check)"
fi
