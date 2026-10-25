#!/usr/bin/env python3
"""Verify and install one HAP on one explicitly selected hdc target."""
from __future__ import annotations
import argparse
from pathlib import Path
import re
import subprocess
import sys

from payload_build import ABILITY, ARTIFACT, BUNDLE, BuildError, validate_artifact, validate_target


def hdc_command(hdc: str, args: list[str]) -> str:
    result = subprocess.run([hdc, *args], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace')
    output = result.stdout.strip()
    print(output)
    if result.returncode or re.search(r'\b(failed|failure|error|denied)\b', output, re.IGNORECASE):
        raise BuildError('hdc command failed; stop and inspect: ' + output)
    return output


def require_target(hdc: str, target: str) -> None:
    validate_target(target)
    listed = hdc_command(hdc, ['list', 'targets'])
    # Plain `list targets` prints one exact connect key per line.
    if target not in [line.strip() for line in listed.splitlines()]:
        raise BuildError('Selected target is not listed: ' + target + '. Reconnect it and select its exact ID.')


def install(app: Path, hdc: str, target: str, connect: bool = False, check: bool = False) -> None:
    validate_target(target)
    info = validate_artifact(app)
    if connect:
        if not re.fullmatch(r'[A-Za-z0-9_.-]+:[0-9]{1,5}', target):
            raise BuildError('--connect requires an explicit HOST:PORT network target')
        hdc_command(hdc, ['tconn', target])
    require_target(hdc, target)
    print('VERIFIED SHA256: ' + info['sha256'])
    if check:
        print('DEPLOY CHECK OK: ' + target + '; no installation performed')
        return
    output = hdc_command(hdc, ['-t', target, 'install', '-r', str(app / 'dist' / ARTIFACT)])
    if 'success' not in output.lower() or re.search(r'\b(failed|error)\b', output, re.IGNORECASE):
        raise BuildError('Cannot confirm installation; stop before launch: ' + output)
    output = hdc_command(hdc, ['-t', target, 'shell', 'aa', 'start', '-a', ABILITY, '-b', BUNDLE])
    if 'success' not in output.lower():
        raise BuildError('Cannot confirm ability start; inspect device screen: ' + output)
    print('DEPLOY OK: ' + target + '; verify the visible app and set its role')


def pull_logs(hdc: str, target: str, remote: str, destination: Path) -> None:
    require_target(hdc, target)
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+/payload-export-[A-Za-z0-9_.-]+\.json', remote) or '..' in remote:
        raise BuildError('Use the exact absolute payload-export-*.json path displayed by this app')
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        raise BuildError('Destination already exists; choose a new evidence filename')
    hdc_command(hdc, ['-t', target, 'file', 'recv', remote, str(destination)])
    if not destination.is_file() or destination.stat().st_size == 0:
        raise BuildError('No exported file received. App sandbox access depends on board image; use UI history/hilog evidence if denied.')
    print('LOG FILE: ' + str(destination.resolve()))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    install_parser = sub.add_parser('install')
    install_parser.add_argument('--hdc', required=True, help='actual hdc executable path, never a guessed path')
    install_parser.add_argument('--target', required=True, help='exact ID from hdc list targets')
    install_parser.add_argument('--connect', action='store_true', help='explicitly connect a network HOST:PORT first')
    install_parser.add_argument('--check', action='store_true', help='verify HAP and selected target without installing')
    log_parser = sub.add_parser('pull-logs')
    log_parser.add_argument('--hdc', required=True)
    log_parser.add_argument('--target', required=True)
    log_parser.add_argument('--remote', required=True)
    log_parser.add_argument('--out', required=True)
    args = parser.parse_args()
    try:
        if args.command == 'install':
            install(Path(__file__).resolve().parents[1] / 'payload-app', args.hdc, args.target, args.connect, args.check)
        else:
            pull_logs(args.hdc, args.target, args.remote, Path(args.out))
        return 0
    except (BuildError, OSError) as error:
        print('STOP: ' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
