#!/usr/bin/env python3
"""Build the isolated payload app with the course's prepared Linux toolchain."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import subprocess
import sys
import time
import uuid
import zipfile

BUNDLE = 'com.eduoh.payloadterminal'
ABILITY = 'EntryAbility'
ARTIFACT = 'payload-terminal-signed.hap'


class BuildError(RuntimeError):
    pass


class Toolchain:
    def __init__(self, root: Path, java: str | None = None):
        self.root = root.resolve()
        self.source = self.root / 'source'
        self.sdk = self.source / 'prebuilts/ohos-sdk/linux'
        self.node = self.source / 'prebuilts/build-tools/common/nodejs/node-v16.20.2-linux-x64/bin/node'
        self.modules = self.root / '.cache/qemu-sync-fix/dependencies/node_modules'
        self.hvigor = self.modules / '@ohos/hvigor'
        self.sign = self.source / 'developtools/hapsigner/dist'
        self.jar = self.sdk / '18/toolchains/lib/hap-sign-tool.jar'
        self.hdc = self.sdk / '18/toolchains/hdc'
        self.java = java or shutil.which('java')


def find_eduoh_root(app: Path, env: dict[str, str] | None = None) -> Path:
    env = os.environ if env is None else env
    explicit = env.get('EDUOH_ROOT', '').strip()
    candidates = [Path(explicit).expanduser().resolve()] if explicit else list(app.resolve().parents)
    for candidate in candidates:
        if ((candidate / 'source').is_dir() and (candidate / '.cache/qemu-sync-fix/dependencies/node_modules').is_dir()):
            return candidate
    if explicit:
        raise BuildError('EDUOH_ROOT is not a prepared course tree: ' + explicit)
    raise BuildError('Prepared eduoh tree not found. Set EDUOH_ROOT to the directory containing source/ and .cache/qemu-sync-fix/dependencies/node_modules/.')


def inspect_paths(tc: Toolchain) -> list[str]:
    required = [tc.node, tc.hvigor / 'package.json', tc.hvigor / 'bin/hvigor-simple.js',
                tc.modules / '@ohos/hvigor-ohos-plugin/package.json', tc.sdk / '18/ets',
                tc.jar, tc.sign / 'OpenHarmony.p12', tc.sign / 'OpenHarmonyProfileRelease.pem',
                tc.sign / 'OpenHarmonyApplication.pem', tc.sign / 'UnsgnedReleasedProfileTemplate.json']
    errors = ['Missing prepared tool: ' + str(path) for path in required if not path.exists()]
    if not tc.java:
        errors.append('Java is not available in PATH. Use the course-prepared JDK.')
    return errors


def preflight(app: Path, env: dict[str, str] | None = None) -> Toolchain:
    tc = Toolchain(find_eduoh_root(app, env))
    errors = inspect_paths(tc)
    if platform.system() != 'Linux' or platform.machine().lower() not in ('x86_64', 'amd64'):
        errors.append('Build requires the prepared Linux x86_64 SSH environment; Windows is for editing and USB deployment.')
    if errors:
        raise BuildError('\n'.join(errors))
    try:
        node_version = subprocess.run([str(tc.node), '--version'], capture_output=True, text=True, check=True).stdout.strip()
        if not node_version.startswith('v16.'):
            raise BuildError('Expected prepared Node 16, found ' + node_version)
        version = json.loads((tc.hvigor / 'package.json').read_text(encoding='utf-8'))['version']
        if not str(version).startswith('3.'):
            raise BuildError('Expected prepared Hvigor 3, found ' + str(version))
        java = subprocess.run([str(tc.java), '-version'], capture_output=True, text=True, check=True)
    except (OSError, subprocess.CalledProcessError, ValueError, KeyError) as error:
        raise BuildError('Cannot execute/read prepared toolchain: ' + str(error)) from error
    print('PREFLIGHT OK: Linux x86_64; SDK API18; ' + node_version + '; Hvigor ' + str(version))
    print('EDUOH_ROOT=' + str(tc.root))
    print('JAVA=' + str(tc.java) + ' ' + (java.stderr or java.stdout).splitlines()[0])
    return tc


def validate_hap(path: Path) -> None:
    try:
        if not path.is_file() or path.stat().st_size == 0:
            raise BuildError('Signed HAP is missing or empty: ' + str(path))
        with zipfile.ZipFile(path) as archive:
            bad = archive.testzip()
            if bad:
                raise BuildError('Corrupt HAP member: ' + bad)
            module = json.loads(archive.read('module.json'))
        if module['app']['bundleName'] != BUNDLE:
            raise BuildError('Unexpected HAP bundle; expected ' + BUNDLE)
        if module['module']['mainElement'] != ABILITY or not any(a['name'] == ABILITY for a in module['module']['abilities']):
            raise BuildError('HAP does not declare EntryAbility')
    except (OSError, zipfile.BadZipFile, KeyError, TypeError, ValueError) as error:
        raise BuildError('Invalid HAP: ' + str(error)) from error


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def publish_artifact(app: Path, pending: Path, started: float) -> Path:
    validate_hap(pending)
    artifact = app / 'dist' / ARTIFACT
    info_pending = app / 'dist/build-info.pending.json'
    info = {'bundle': BUNDLE, 'ability': ABILITY, 'sdk': 'API18', 'artifact': ARTIFACT,
            'sha256': sha256(pending), 'bytes': pending.stat().st_size,
            'elapsedSeconds': round(max(0, time.time() - started), 2),
            'completedAt': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
            'signing': 'OpenHarmony public development key; classroom use'}
    info_pending.write_text(json.dumps(info, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    # Each rename is atomic. Manifest publishes last; installers require both + matching hash.
    pending.replace(artifact)
    info_pending.replace(app / 'dist/build-info.json')
    return artifact


def validate_artifact(app: Path) -> dict:
    if (app / '.build.lock').exists():
        raise BuildError('Build is running (or lock needs inspection); do not deploy.')
    try:
        info = json.loads((app / 'dist/build-info.json').read_text(encoding='utf-8'))
        if info.get('bundle') != BUNDLE or info.get('ability') != ABILITY or info.get('artifact') != ARTIFACT:
            raise BuildError('Unexpected build-info identity or artifact name')
        artifact = app / 'dist' / ARTIFACT
        if sha256(artifact) != info.get('sha256'):
            raise BuildError('SHA256 mismatch; obtain HAP and build-info.json from the same successful build')
        validate_hap(artifact)
        return info
    except (OSError, ValueError) as error:
        raise BuildError('No complete verified build: ' + str(error)) from error


def invalidate_outputs(app: Path) -> None:
    for name in [ARTIFACT, 'build-info.json', 'payload-terminal-pending.hap', 'build-info.pending.json']:
        (app / 'dist' / name).unlink(missing_ok=True)


@contextmanager
def build_lock(app: Path):
    lock = app / '.build.lock'
    try:
        handle = lock.open('x', encoding='utf-8')
    except FileExistsError as error:
        raise BuildError('Build lock exists: ' + str(lock) + '. Confirm no build is active before manually removing this lock.') from error
    with handle:
        handle.write(str(os.getpid()) + '\n')
    try:
        yield
    finally:
        lock.unlink(missing_ok=True)


def run_build(app: Path, env: dict[str, str] | None = None) -> Path:
    with build_lock(app):
        invalidate_outputs(app)
        (app / 'logs').mkdir(exist_ok=True)
        log_path = app / 'logs/build.log'
        log_path.write_text('BUILD START: ' + time.strftime('%Y-%m-%dT%H:%M:%S%z') + '\n', encoding='utf-8')
        try:
            tc = preflight(app, env)
            return _build_prepared(app, tc)
        except Exception as error:
            invalidate_outputs(app)
            with log_path.open('a', encoding='utf-8') as log:
                log.write('\nSTOP: ' + str(error) + '\n')
            raise


def _build_prepared(app: Path, tc: Toolchain) -> Path:
    for name in ['logs', 'dist', 'signature', '.cache', 'hvigor']:
        (app / name).mkdir(exist_ok=True)
    link = app / 'node_modules'
    if not link.exists() and not link.is_symlink():
        link.symlink_to(tc.modules, target_is_directory=True)
    if link.resolve() != tc.modules:
        raise BuildError('Unexpected node_modules; inspect it before changing it: ' + str(link))
    (app / 'local.properties').write_text('sdk.dir=' + str(tc.sdk) + '\n', encoding='utf-8')
    (app / 'hvigor/hvigor-config.json5').write_text(json.dumps({'modelVersion': '3.0.2', 'dependencies': {}, 'environment': {'hvigorUserHome': str(app / '.cache/hvigor-home')}}), encoding='utf-8')
    preload = app / '.cache/hvigor-preload.cjs'
    preload.write_text('const path=require("path");const dc=require(path.join(process.env.EDUOH_HVIGOR_DIR,"src/base/daemon/const/daemon-const.js"));dc.DAEMON_LOG_PATH=process.env.EDUOH_HVIGOR_LOG_DIR;\n', encoding='utf-8')
    environment = os.environ.copy()
    environment.update(EDUOH_HVIGOR_DIR=str(tc.hvigor), EDUOH_HVIGOR_LOG_DIR=str(app / '.cache/hvigor-home/log'), NODE_OPTIONS='--require=' + shlex.quote(str(preload)))
    environment['PATH'] = str(tc.node.parent) + os.pathsep + str(Path(str(tc.java)).parent) + os.pathsep + environment.get('PATH', '')
    profile = json.loads((tc.sign / 'UnsgnedReleasedProfileTemplate.json').read_text(encoding='utf-8'))
    profile['uuid'] = str(uuid.uuid4())
    profile['validity'] = {'not-before': int(time.time()) - 86400, 'not-after': int(time.time()) + 315360000}
    profile['bundle-info']['bundle-name'] = BUNDLE
    profile['bundle-info']['apl'] = 'normal'
    profile['acls']['allowed-acls'] = []
    profile_path = app / 'signature/profile.json'
    profile_path.write_text(json.dumps(profile, indent=2), encoding='utf-8')
    pending = app / 'dist/payload-terminal-pending.hap'
    unsigned = app / 'entry/build/default/outputs/default/entry-default-unsigned.hap'
    unsigned.unlink(missing_ok=True)
    started = time.time()
    with (app / 'logs/build.log').open('w', encoding='utf-8') as log:
        def run(args):
            args = list(map(str, args))
            line = '$ ' + shlex.join(args) + '\n'
            print(line, end='', flush=True)
            log.write(line)
            log.flush()
            process = subprocess.Popen(args, cwd=app, env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace')
            assert process.stdout is not None
            for output in process.stdout:
                print(output, end='', flush=True)
                log.write(output)
            if process.wait() != 0:
                raise BuildError('Build step failed; see ' + str(app / 'logs/build.log'))
        run([tc.node, tc.hvigor / 'bin/hvigor-simple.js', '--no-daemon', '--no-parallel', '--mode', 'module', '-p', 'product=default', '-p', 'module=entry@default', 'assembleHap'])
        if not unsigned.is_file():
            raise BuildError('Hvigor did not produce a fresh unsigned HAP')
        # Passwords below belong only to the public development keystore distributed in OpenHarmony source.
        run([tc.java, '-jar', tc.jar, 'sign-profile', '-mode', 'localSign', '-keyAlias', 'openharmony application profile release', '-signAlg', 'SHA256withECDSA', '-profileCertFile', tc.sign / 'OpenHarmonyProfileRelease.pem', '-inFile', profile_path, '-keystoreFile', tc.sign / 'OpenHarmony.p12', '-outFile', app / 'signature/payload-terminal.p7b', '-keyPwd', '123456', '-keystorePwd', '123456'])
        run([tc.java, '-jar', tc.jar, 'sign-app', '-mode', 'localSign', '-keyAlias', 'openharmony application release', '-signAlg', 'SHA256withECDSA', '-appCertFile', tc.sign / 'OpenHarmonyApplication.pem', '-profileFile', app / 'signature/payload-terminal.p7b', '-inFile', unsigned, '-keystoreFile', tc.sign / 'OpenHarmony.p12', '-outFile', pending, '-keyPwd', '123456', '-keystorePwd', '123456'])
    return publish_artifact(app, pending, started)


def validate_target(target: str) -> str:
    if not target or target.lower() == 'all' or target.startswith('-') or re.search(r'[\s*?\[\]]', target):
        raise BuildError('Provide one exact target from hdc list targets; wildcards and multiple targets are forbidden')
    return target


def main(app: Path | None = None) -> int:
    app = app or Path(__file__).resolve().parents[1] / 'payload-app'
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--check', action='store_true', help='read-only toolchain preflight; does not build or change artifacts')
    group.add_argument('--verify-artifact', action='store_true', help='verify existing HAP identity and manifest SHA256')
    group.add_argument('--print-hdc', action='store_true', help='print prepared Linux hdc path')
    args = parser.parse_args()
    try:
        if args.check:
            preflight(app)
        elif args.verify_artifact:
            print(json.dumps(validate_artifact(app), ensure_ascii=False, indent=2))
        elif args.print_hdc:
            tc = Toolchain(find_eduoh_root(app))
            if not tc.hdc.is_file():
                raise BuildError('Missing hdc: ' + str(tc.hdc))
            print(tc.hdc)
        else:
            artifact = run_build(app)
            print('SIGNED HAP: ' + str(artifact))
            print('MANIFEST: ' + str(app / 'dist/build-info.json'))
        return 0
    except (BuildError, OSError, ValueError) as error:
        print('STOP: ' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
