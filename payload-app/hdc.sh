#!/usr/bin/env bash
set -euo pipefail
APP_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
SDK_HDC=$(python3 "$APP_DIR/build.py" --print-hdc)
exec "$SDK_HDC" "$@"
