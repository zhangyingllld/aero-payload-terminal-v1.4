#!/usr/bin/env bash
set -euo pipefail
APP_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
TARGET=${1:?Usage: bash payload-app/install.sh EXACT_TARGET [--connect]}
shift
SDK_HDC=$(python3 "$APP_DIR/build.py" --print-hdc)
exec python3 "$APP_DIR/../tools/deploy.py" install --hdc "$SDK_HDC" --target "$TARGET" "$@"
