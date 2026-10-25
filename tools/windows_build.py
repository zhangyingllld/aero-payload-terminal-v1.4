#!/usr/bin/env python3
"""Build/sign payload-app locally with Windows DevEco Studio and OpenHarmony API 23.

No server, dependency installation, device command, or separately provisioned
signing key is required. The SDK's public classroom development key is used. A failed build
keeps the last published HAP and manifest. Use --check for a read-only preflight.
"""
from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

from payload_build import (ABILITY, ARTIFACT, BUNDLE, BuildError, build_lock,
                           sha256, validate_artifact, validate_hap)


DEFAULT_DEVECO = Path(r'D:\Program Files\Huawei\DevEco Studio')
DEFAULT_SDK = Path(r'D:\OpenHarmony\Sdk')
# Public development keystore shipped by OpenHarmony, never a user's key.
PUBLIC_KEY_PASSWORD = '123456'
# Public CA-issued chain extracted from the verified v1.1 classroom HAP. Its
# release public key matches the SDK's "openharmony application release" key;
# the singleton certificate stored under that alias is only self-issued.
PUBLIC_CERT_SHA256 = (
    '8e93863fc32ee238060bf69a9b37e2608fffb21f93c862dd511cbac9f30024b5',
    'eeb00e63401c85853f677a73c6f12ccb7c53692d44caf459994bb2ce5a47a94d',
    '9aed2a79925eca050cd2bb9d2a7f694e49e5e135d28ebdce53836de76b5080ed',
)


class Toolchain:
    def __init__(self, deveco: Path = DEFAULT_DEVECO, sdk: Path = DEFAULT_SDK):
        self.deveco = Path(deveco).expanduser().resolve()
        self.sdk = Path(sdk).expanduser().resolve()
        self.api = self.sdk / '23'
        self.node = self.deveco / 'tools/node/node.exe'
        self.java = self.deveco / 'jbr/bin/java.exe'
        self.wrapper = self.deveco / 'tools/hvigor/bin/hvigorw.js'
        self.hvigor = self.deveco / 'tools/hvigor/hvigor'
        self.plugin = self.deveco / 'tools/hvigor/hvigor-ohos-plugin'
        self.sign = self.api / 'toolchains/lib'
        self.jar = self.sign / 'hap-sign-tool.jar'
        self.keystore = self.sign / 'OpenHarmony.p12'
        self.profile_cert = self.sign / 'OpenHarmonyProfileRelease.pem'
        self.profile_template = self.sign / 'UnsgnedReleasedProfileTemplate.json'
        self.application_cert = Path(__file__).with_name('openharmony-public-release.cer')


def inspect_paths(tc: Toolchain) -> list[str]:
    required = [tc.node, tc.java, tc.wrapper, tc.hvigor / 'package.json',
                tc.plugin / 'package.json', tc.jar, tc.keystore,
                tc.profile_cert, tc.profile_template, tc.application_cert]
    required.extend(tc.api / part / 'oh-uni-package.json'
                    for part in ('ets', 'js', 'native', 'toolchains'))
    return ['Missing local build input: ' + str(path)
            for path in required if not path.is_file()]


def preflight(tc: Toolchain) -> None:
    errors = inspect_paths(tc)
    if sys.platform != 'win32':
        errors.append('This entrypoint requires Windows; use the Linux builder on Linux.')
    if errors:
        raise BuildError('\n'.join(errors))
    try:
        load_application_certificates(tc)
        versions = {}
        for component in ('ets', 'js', 'native', 'toolchains'):
            meta = json.loads((tc.api / component / 'oh-uni-package.json').read_text(encoding='utf-8-sig'))
            if str(meta['apiVersion']) != '23':
                raise BuildError('Expected API 23 metadata in ' + str(tc.api / component))
            versions[component] = meta['version']
        node = subprocess.run([str(tc.node), '--version'], check=True, capture_output=True,
                              text=True).stdout.strip()
        java = subprocess.run([str(tc.java), '-version'], check=True, capture_output=True, text=True)
        hvigor = json.loads((tc.hvigor / 'package.json').read_text(encoding='utf-8'))['version']
        print('PREFLIGHT OK: Windows; API23; Node ' + node + '; Hvigor ' + hvigor)
        print('SDK=' + str(tc.sdk))
        print('JAVA=' + (java.stderr or java.stdout).splitlines()[0])
        print('SDK components: ' + json.dumps(versions))
        if len(set(versions.values())) > 1:
            print('NOTE: SDK component patch versions differ; no SDK files will be changed.')
    except (OSError, subprocess.CalledProcessError, ValueError, KeyError) as error:
        raise BuildError('Cannot read or execute the local toolchain: ' + str(error)) from error


def load_application_certificates(tc: Toolchain) -> tuple[str, ...]:
    text = tc.application_cert.read_text(encoding='utf-8-sig')
    certificates = re.findall(r'-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----', text)
    if len(certificates) != 3:
        raise BuildError('Expected three public certificates in ' + str(tc.application_cert))
    for certificate, expected in zip(certificates, PUBLIC_CERT_SHA256):
        body = certificate.replace('-----BEGIN CERTIFICATE-----', '').replace('-----END CERTIFICATE-----', '')
        try:
            actual = hashlib.sha256(base64.b64decode(''.join(body.split()), validate=True)).hexdigest()
        except ValueError as error:
            raise BuildError('Invalid public certificate encoding') from error
        if actual != expected:
            raise BuildError('Public certificate fingerprint mismatch: ' + str(tc.application_cert))
    return tuple(certificate + '\n' for certificate in certificates)


def prepare_signing(tc: Toolchain, output: Path, now: float | None = None) -> tuple[Path, Path]:
    try:
        profile = json.loads(tc.profile_template.read_text(encoding='utf-8-sig'))
        certificate = profile.get('bundle-info', {}).get('distribution-certificate', '')
        if '-----BEGIN CERTIFICATE-----' not in certificate or '-----END CERTIFICATE-----' not in certificate:
            raise BuildError('Release profile template has no application certificate')
        # Some SDK templates contain an IDE demo certificate, not the public
        # release key's certificate. Always bind profile and chain to that key.
        certificates = load_application_certificates(tc)
        certificate = certificates[0]
        moment = int(time.time() if now is None else now)
        profile['uuid'] = str(uuid.uuid4())
        profile['validity'] = {'not-before': moment - 86400, 'not-after': moment + 315360000}
        profile['bundle-info']['bundle-name'] = BUNDLE
        profile['bundle-info']['distribution-certificate'] = certificate
        profile['bundle-info']['apl'] = 'normal'
        profile['acls'] = {'allowed-acls': []}
        output.mkdir(parents=True, exist_ok=True)
        profile_file = output / 'profile.json'
        cert_file = output / 'OpenHarmonyApplication.pem'
        profile_file.write_text(json.dumps(profile, indent=2) + '\n', encoding='utf-8')
        cert_file.write_text(''.join(certificates), encoding='utf-8')
        return profile_file, cert_file
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise BuildError('Cannot prepare the public signing profile: ' + str(error)) from error


def _run(arguments: list[object], app: Path, environment: dict[str, str], log) -> None:
    args = list(map(str, arguments))
    visible = args.copy()
    for flag in ('-keyPwd', '-keystorePwd'):
        if flag in visible:
            visible[visible.index(flag) + 1] = '<public-development-key>'
    line = '$ ' + subprocess.list2cmdline(visible) + '\n'
    print(line, end='', flush=True)
    log.write(line)
    log.flush()
    process = subprocess.Popen(args, cwd=app, env=environment, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace')
    assert process.stdout is not None
    for output in process.stdout:
        print(output, end='', flush=True)
        log.write(output)
        log.flush()
    if process.wait() != 0:
        raise BuildError('Local build step failed; see ' + str(log.name))


@contextmanager
def temporary_directory(parent: Path, prefix: str):
    parent = Path(parent).resolve()
    parent.mkdir(parents=True, exist_ok=True)
    directory = Path(tempfile.mkdtemp(prefix=prefix, dir=parent)).resolve()
    if directory.parent != parent:
        raise BuildError('Temporary directory escaped its requested parent: ' + str(directory))
    try:
        yield directory
    finally:
        # Never recursively delete a path unless it still resolves under the
        # exact temporary parent chosen above; do not follow a replaced junction.
        if directory.resolve().parent != parent or not directory.name.startswith(prefix):
            raise BuildError('Refusing unsafe temporary directory cleanup: ' + str(directory))
        shutil.rmtree(directory)


@contextmanager
def staged_app(app: Path, build_root: Path | None = None):
    root = Path(build_root if build_root is not None else tempfile.gettempdir()).resolve()
    if not str(root).isascii():
        raise BuildError('Hvigor requires an ASCII build path; set --build-root to an ASCII directory')
    with temporary_directory(root, 'payload-api23-') as directory:
        staging = directory / 'payload-app'
        shutil.copytree(app, staging, ignore=shutil.ignore_patterns(
            'build', 'dist', '.cache', '.hvigor', 'node_modules', 'oh_modules',
            'logs', 'signature', '.build.lock', '__pycache__'))
        yield staging


def compile_and_sign(app: Path, tc: Toolchain, pending: Path, log) -> None:
    environment = os.environ.copy()
    environment['JAVA_HOME'] = str(tc.java.parent.parent)
    environment['NODE_HOME'] = str(tc.node.parent)
    environment['PATH'] = str(tc.node.parent) + os.pathsep + str(tc.java.parent) + os.pathsep + environment.get('PATH', '')
    # Keep all new Hvigor cache files inside this copied project.
    environment['HVIGOR_USER_HOME'] = str(app / '.cache/hvigor-home')
    (app / 'local.properties').write_text('sdk.dir=' + tc.sdk.as_posix() + '\n', encoding='utf-8')
    unsigned = app / 'entry/build/default/outputs/default/entry-default-unsigned.hap'
    unsigned.unlink(missing_ok=True)
    _run([tc.node, tc.wrapper, '--no-daemon', '--no-parallel', '--mode', 'module',
          '-p', 'product=default', '-p', 'module=entry@default', '-p', 'buildMode=debug',
          'assembleHap', '--stacktrace'], app, environment, log)
    if not unsigned.is_file():
        raise BuildError('Hvigor did not produce a fresh unsigned HAP')
    validate_hap(unsigned)
    profile, certificate = prepare_signing(tc, app / 'signature')
    signed_profile = app / 'signature/payload-terminal.p7b'
    _run([tc.java, '-jar', tc.jar, 'sign-profile', '-mode', 'localSign',
          '-keyAlias', 'openharmony application profile release', '-signAlg', 'SHA256withECDSA',
          '-profileCertFile', tc.profile_cert, '-inFile', profile, '-keystoreFile', tc.keystore,
          '-outFile', signed_profile, '-keyPwd', PUBLIC_KEY_PASSWORD, '-keystorePwd', PUBLIC_KEY_PASSWORD],
         app, environment, log)
    _run([tc.java, '-jar', tc.jar, 'sign-app', '-mode', 'localSign',
          '-keyAlias', 'openharmony application release', '-signAlg', 'SHA256withECDSA',
          '-appCertFile', certificate, '-profileFile', signed_profile, '-inFile', unsigned,
          '-keystoreFile', tc.keystore, '-outFile', pending,
          '-keyPwd', PUBLIC_KEY_PASSWORD, '-keystorePwd', PUBLIC_KEY_PASSWORD], app, environment, log)
    # Verify the actual signature before the publication transaction.
    _run([tc.java, '-jar', tc.jar, 'verify-app', '-inFile', pending,
          '-outCertChain', app / 'signature/verified-chain.cer',
          '-outProfile', app / 'signature/verified-profile.p7b'], app, environment, log)


def publish_artifact(app: Path, pending: Path, started: float) -> Path:
    validate_hap(pending)
    dist = app / 'dist'
    dist.mkdir(exist_ok=True)
    artifact = dist / ARTIFACT
    manifest = dist / 'build-info.json'
    info = {'bundle': BUNDLE, 'ability': ABILITY, 'sdk': 'API23', 'buildHost': 'Windows',
            'artifact': ARTIFACT, 'sha256': sha256(pending), 'bytes': pending.stat().st_size,
            'elapsedSeconds': round(max(0, time.time() - started), 2),
            'completedAt': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
            'signing': 'OpenHarmony public development key; classroom use'}
    # Readers reject .build.lock. Each replace is atomic; if the second fails,
    # restore the preceding pair while the build still owns that lock.
    with temporary_directory(dist, '.publish-') as stage:
        next_info = stage / 'build-info.json'
        next_info.write_text(json.dumps(info, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        previous = []
        for path in (artifact, manifest):
            backup = stage / ('previous-' + path.name)
            if path.exists():
                shutil.copy2(path, backup)
            previous.append((path, backup))
        try:
            os.replace(pending, artifact)
            os.replace(next_info, manifest)
        except OSError:
            for path, backup in previous:
                if backup.exists():
                    os.replace(backup, path)
                else:
                    path.unlink(missing_ok=True)
            raise
    return artifact


def run_build(app: Path, tc: Toolchain, build_root: Path | None = None) -> Path:
    app = Path(app).resolve()
    preflight(tc)
    with build_lock(app):
        (app / 'logs').mkdir(exist_ok=True)
        (app / 'dist').mkdir(exist_ok=True)
        started = time.time()
        pending = app / 'dist/payload-terminal-windows-pending.hap'
        pending.unlink(missing_ok=True)
        with (app / 'logs/windows-build.log').open('w', encoding='utf-8') as log:
            log.write('LOCAL WINDOWS BUILD: ' + time.strftime('%Y-%m-%dT%H:%M:%S%z') + '\n')
            try:
                with staged_app(app, build_root) as staging:
                    log.write('SOURCE PROJECT: ' + str(app) + '\nBUILD SNAPSHOT: ' + str(staging) + '\n')
                    staged_hap = staging / 'payload-terminal-signed.hap'
                    compile_and_sign(staging, tc, staged_hap, log)
                    shutil.copy2(staged_hap, pending)
                return publish_artifact(app, pending, started)
            except Exception as error:
                log.write('\nSTOP: ' + str(error) + '\nPrevious published HAP and manifest retained.\n')
                raise
            finally:
                pending.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, default=Path(__file__).resolve().parents[1] / 'payload-app')
    parser.add_argument('--deveco', type=Path, default=Path(os.environ.get('DEVECO_STUDIO_HOME', str(DEFAULT_DEVECO))),
                        help='DevEco Studio installation directory')
    parser.add_argument('--sdk', type=Path, default=Path(os.environ.get('OHOS_SDK_HOME', str(DEFAULT_SDK))),
                        help='OpenHarmony SDK root containing the 23 directory')
    parser.add_argument('--build-root', type=Path,
                        help='ASCII temporary parent directory; defaults to Windows TEMP')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--check', action='store_true', help='read-only local toolchain preflight')
    mode.add_argument('--verify', '--verify-artifact', dest='verify', action='store_true',
                      help='verify the existing HAP identity and manifest SHA256 without building')
    args = parser.parse_args()
    try:
        if args.verify:
            print(json.dumps(validate_artifact(args.app), ensure_ascii=False, indent=2))
        else:
            tc = Toolchain(args.deveco, args.sdk)
            if args.check:
                preflight(tc)
            else:
                print('SIGNED HAP: ' + str(run_build(args.app, tc, args.build_root)))
                print('MANIFEST: ' + str(args.app / 'dist/build-info.json'))
        return 0
    except (BuildError, OSError, ValueError) as error:
        print('STOP: ' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    raise SystemExit(main())
