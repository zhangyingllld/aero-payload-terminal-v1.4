#!/usr/bin/env python3
"""Verify this release's listed source/doc files before making local changes."""
import hashlib
import json
from pathlib import Path
import sys


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    try:
        manifest = json.loads((root / 'SOURCE-MANIFEST.json').read_text(encoding='utf-8'))
        failures = []
        for item in manifest['files']:
            target = (root / item['path']).resolve()
            if not target.is_relative_to(root) or not target.is_file():
                failures.append(item['path'] + ': missing or outside release')
                continue
            actual = hashlib.sha256(target.read_bytes()).hexdigest()
            if actual != item['sha256']:
                failures.append(item['path'] + ': changed')
        if failures:
            print('\n'.join(failures))
            print('SOURCE CHECK FAILED: inspect changes; intentional exercises also change hashes.')
            return 1
        print('SOURCE CHECK OK: ' + str(len(manifest['files'])) + ' listed files match this release.')
        return 0
    except (OSError, ValueError, KeyError, TypeError) as error:
        print('SOURCE CHECK FAILED: ' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
