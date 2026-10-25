#!/usr/bin/env python3
"""Read system/API/network information from one explicitly selected HDC board.

This performs no install, reboot, flashing, property write, or network change.
It does not prove that an app runs, projection works, or five-board links work.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import ipaddress
import json
from pathlib import Path
import re
import subprocess
import sys


class PreflightError(RuntimeError):
    pass


def hdc_query(hdc: str, arguments: list[str]) -> str:
    try:
        completed = subprocess.run(
            [hdc, *arguments], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding='utf-8', errors='replace', timeout=15, check=False)
    except subprocess.TimeoutExpired as error:
        raise PreflightError('HDC query timed out after 15 seconds; check the USB connection.') from error
    except OSError as error:
        raise PreflightError('Cannot run the supplied HDC executable: ' + str(error)) from error
    output = completed.stdout.strip()
    failure = re.search(
        r'\b(?:fail(?:ed|ure)?|error|denied|unauthorized|offline)\b|\[E\]|'
        r'no permissions|no connected (?:device|target)|(?:device|target) not found',
        output, re.IGNORECASE)
    if completed.returncode != 0 or failure:
        raise PreflightError('HDC query failed: ' + (output or 'exit code ' + str(completed.returncode)))
    return output


def inspect_board(hdc: str, target: str) -> dict:
    # HDC IDs are opaque connect keys, never wildcard or automatically chosen.
    if not target or target.startswith('-') or not re.fullmatch(r'[A-Za-z0-9_.:-]+', target):
        raise PreflightError('Use one exact target ID from hdc list targets; spaces and wildcards are not allowed.')
    listed = hdc_query(hdc, ['list', 'targets'])
    targets = [line.strip() for line in listed.splitlines() if line.strip() and line.strip() != '[Empty]']
    if target not in targets:
        raise PreflightError('Selected target is not listed: ' + target + '. Check USB debugging/authorization and copy its exact ID.')
    prefix = ['-t', target, 'shell']
    fullname = hdc_query(hdc, [*prefix, 'param', 'get', 'const.ohos.fullname'])
    if not fullname:
        raise PreflightError('System name query returned no value; inspect this board before deployment.')
    api = hdc_query(hdc, [*prefix, 'param', 'get', 'const.ohos.apiversion'])
    if not api.isdecimal():
        raise PreflightError('API version query returned no integer: ' + repr(api) + '. Inspect the board image before deployment.')
    network = hdc_query(hdc, [*prefix, 'ifconfig'])
    addresses = []
    for match in re.finditer(r'\binet\s+(?:addr:)?(\d{1,3}(?:\.\d{1,3}){3})\b', network):
        try:
            address = ipaddress.IPv4Address(match.group(1))
        except ipaddress.AddressValueError:
            continue
        if not address.is_loopback and not address.is_unspecified and str(address) not in addresses:
            addresses.append(str(address))
    warnings = []
    if not addresses:
        warnings.append('No non-loopback IPv4 address found. USB access alone does not provide the five-board application LAN.')
    elif len(addresses) > 1:
        warnings.append('Multiple IPv4 addresses found. Select the interface on the shared five-board LAN; do not copy the first blindly.')
    if any(ipaddress.IPv4Address(address).is_link_local for address in addresses):
        warnings.append('A link-local address was found. Confirm LAN addressing with all five boards before deployment.')
    warnings.append('This report verifies read-only access and captured values only; it does not verify app installation, projection, or five-board communication.')
    return {
        'schemaVersion': 1,
        'capturedAtUtc': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'readOnly': True,
        'target': target,
        'connectedTargetCount': len(targets),
        'system': {'fullName': fullname, 'apiVersion': int(api)},
        'network': {'ipv4Candidates': addresses, 'ifconfig': network},
        'warnings': warnings,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--hdc', required=True, help='path to the existing hdc/hdc.exe executable')
    parser.add_argument('--target', required=True, help='exact connect key from hdc list targets, even when only one board is attached')
    parser.add_argument('--output', type=Path, help='optional NEW JSON evidence filename; existing files are preserved')
    args = parser.parse_args(argv)
    try:
        if args.output and args.output.exists():
            raise PreflightError('Output already exists; choose a new evidence filename: ' + str(args.output))
        report = inspect_board(args.hdc, args.target)
        serialized = json.dumps(report, ensure_ascii=False, indent=2) + '\n'
        if args.output:
            # Exclusive creation also handles another process creating this path during the queries.
            with args.output.open('x', encoding='utf-8', newline='\n') as stream:
                stream.write(serialized)
        print(serialized, end='')
        return 0
    except (PreflightError, OSError) as error:
        print('STOP: ' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
