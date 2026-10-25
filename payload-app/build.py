#!/usr/bin/env python3
"""Course-compatible entry point. Implementation lives in ../tools/payload_build.py."""
from pathlib import Path
import sys

APP = Path(__file__).resolve().parent
sys.path.insert(0, str(APP.parent / 'tools'))
from payload_build import main

if __name__ == '__main__':
    raise SystemExit(main(APP))
