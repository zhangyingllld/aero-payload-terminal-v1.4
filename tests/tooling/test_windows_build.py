"""Windows build boundaries: explicit paths, failed builds, and safe publication."""
import json
from pathlib import Path
import shutil
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools'))
try:
    import windows_build as build
except ModuleNotFoundError:
    build = None


class WindowsBuildTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(build, 'The local Windows build entrypoint is not implemented')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.app = self.root / 'payload-app'
        self.app.mkdir()

    def hap(self, name, bundle='com.eduoh.payloadterminal', payload='new'):
        path = self.app / 'dist' / name
        path.parent.mkdir(exist_ok=True)
        with zipfile.ZipFile(path, 'w') as archive:
            archive.writestr('module.json', json.dumps({
                'app': {'bundleName': bundle},
                'module': {'name': 'entry', 'mainElement': 'EntryAbility',
                           'abilities': [{'name': 'EntryAbility'}]},
            }))
            archive.writestr('payload.txt', payload)
        return path

    def previous(self):
        hap = self.hap('payload-terminal-signed.hap', payload='old')
        manifest = hap.with_name('build-info.json')
        manifest.write_text('{"old": true}', encoding='utf-8')
        return hap, manifest, hap.read_bytes(), manifest.read_bytes()

    def toolchain(self):
        return build.Toolchain(self.root / 'DevEco Studio', self.root / 'Sdk')

    def test_explicit_missing_toolchain_does_not_fall_back_to_installed_tools(self):
        tc = self.toolchain()
        errors = '\n'.join(build.inspect_paths(tc))
        self.assertIn(str(self.root / 'DevEco Studio' / 'tools' / 'node' / 'node.exe'), errors)
        self.assertIn(str(self.root / 'Sdk' / '23' / 'ets'), errors)
        self.assertIn('UnsgnedReleasedProfileTemplate.json', errors)
        self.assertIn('OpenHarmony.p12', errors)

    def test_failed_preflight_preserves_published_hap_and_manifest(self):
        hap, manifest, old_hap, old_manifest = self.previous()
        with self.assertRaises(build.BuildError):
            build.run_build(self.app, self.toolchain())
        self.assertEqual(hap.read_bytes(), old_hap)
        self.assertEqual(manifest.read_bytes(), old_manifest)
        self.assertFalse((self.app / '.build.lock').exists())

    def test_compiler_failure_preserves_published_hap_and_manifest(self):
        hap, manifest, old_hap, old_manifest = self.previous()
        # External compilation cannot run against a temporary SDK; retain the real
        # build transaction and inject the failure at its compiler boundary.
        with patch.object(build, 'preflight'), patch.object(
                build, 'compile_and_sign', side_effect=build.BuildError('compiler failed')):
            with self.assertRaisesRegex(build.BuildError, 'compiler failed'):
                build.run_build(self.app, self.toolchain())
        self.assertEqual(hap.read_bytes(), old_hap)
        self.assertEqual(manifest.read_bytes(), old_manifest)
        self.assertFalse((self.app / '.build.lock').exists())

    def test_staging_copies_sources_but_excludes_generated_files(self):
        source = self.app / 'entry/src/main/ets/Index.ets'
        source.parent.mkdir(parents=True)
        source.write_text('source snapshot', encoding='utf-8')
        for name in ('build', 'dist', '.cache', '.hvigor', 'node_modules', 'logs', 'signature'):
            generated = self.app / 'entry' / name / 'old.txt'
            generated.parent.mkdir(parents=True)
            generated.write_text('old output', encoding='utf-8')
        self.assertTrue(hasattr(build, 'staged_app'), 'ASCII build staging is not implemented')
        with build.staged_app(self.app, self.root / 'ascii-build') as staging:
            self.assertTrue(str(staging).isascii())
            self.assertEqual((staging / 'entry/src/main/ets/Index.ets').read_text(encoding='utf-8'),
                             'source snapshot')
            for name in ('build', 'dist', '.cache', '.hvigor', 'node_modules', 'logs', 'signature'):
                self.assertFalse((staging / 'entry' / name).exists())
            staging_directory = staging.parent
        self.assertFalse(staging_directory.exists())
        self.assertEqual(source.read_text(encoding='utf-8'), 'source snapshot')

    def test_non_ascii_checkout_uses_ascii_build_path(self):
        self.app = self.root / '\u4e2d\u6587\u5de5\u7a0b'
        self.app.mkdir()
        (self.app / 'hvigorfile.ts').write_text('export default {};', encoding='utf-8')
        self.assertTrue(hasattr(build, 'staged_app'), 'ASCII build staging is not implemented')
        with build.staged_app(self.app, self.root / 'ascii-build') as staging:
            self.assertTrue(str(staging).isascii())
            self.assertTrue((staging / 'hvigorfile.ts').is_file())

    def test_public_signing_profile_is_bound_to_this_app(self):
        tc = self.toolchain()
        tc.profile_template.parent.mkdir(parents=True)
        certificate = '-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----\n'
        tc.profile_template.write_text(json.dumps({
            'uuid': 'template-id', 'validity': {'not-before': 1, 'not-after': 2},
            'bundle-info': {'bundle-name': 'template.bundle', 'apl': 'system_core',
                            'distribution-certificate': certificate},
            'acls': {'allowed-acls': ['privileged.permission']},
        }), encoding='utf-8')
        with patch.object(build, 'load_application_certificates', return_value=(certificate,), create=True):
            profile, cert = build.prepare_signing(tc, self.app / 'signature', now=100000)
        data = json.loads(profile.read_text(encoding='utf-8'))
        self.assertEqual(data['bundle-info']['bundle-name'], 'com.eduoh.payloadterminal')
        self.assertEqual(data['bundle-info']['apl'], 'normal')
        self.assertEqual(data['acls']['allowed-acls'], [])
        self.assertNotEqual(data['uuid'], 'template-id')
        self.assertLess(data['validity']['not-before'], 100000)
        self.assertGreater(data['validity']['not-after'], 100000)
        self.assertEqual(cert.read_text(encoding='utf-8'), certificate)

    def test_signing_uses_keystore_certificate_instead_of_stale_sdk_template(self):
        tc = self.toolchain()
        tc.profile_template.parent.mkdir(parents=True)
        stale = '-----BEGIN CERTIFICATE-----\nc3RhbGU=\n-----END CERTIFICATE-----\n'
        leaf = '-----BEGIN CERTIFICATE-----\nbGVhZg==\n-----END CERTIFICATE-----\n'
        ca = '-----BEGIN CERTIFICATE-----\nY2E=\n-----END CERTIFICATE-----\n'
        root = '-----BEGIN CERTIFICATE-----\ncm9vdA==\n-----END CERTIFICATE-----\n'
        tc.profile_template.write_text(json.dumps({'bundle-info': {
            'distribution-certificate': stale}}), encoding='utf-8')
        with patch.object(build, 'load_application_certificates', return_value=(leaf, ca, root), create=True):
            profile, cert = build.prepare_signing(tc, self.app / 'signature')
        data = json.loads(profile.read_text(encoding='utf-8'))
        self.assertEqual(data['bundle-info']['distribution-certificate'], leaf)
        self.assertEqual(cert.read_text(encoding='utf-8'), leaf + ca + root)

    def test_corrupt_public_certificate_resource_is_rejected(self):
        tc = self.toolchain()
        tc.application_cert = self.root / 'application.cer'
        tc.application_cert.write_text('not a certificate chain', encoding='utf-8')
        self.assertTrue(hasattr(build, 'load_application_certificates'), 'Public certificate loading is not implemented')
        with self.assertRaisesRegex(build.BuildError, 'certificate'):
            build.load_application_certificates(tc)

    def test_compilation_verifies_signature_with_required_export_paths(self):
        tc = self.toolchain()
        tc.profile_template.parent.mkdir(parents=True)
        tc.profile_template.write_text(json.dumps({'bundle-info': {
            'distribution-certificate': '-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----'}}),
            encoding='utf-8')
        fixture = self.hap('fixture.hap')
        pending = self.app / 'pending.hap'

        def external_tools(args, app, environment, log):
            if 'assembleHap' in args:
                unsigned = app / 'entry/build/default/outputs/default/entry-default-unsigned.hap'
                unsigned.parent.mkdir(parents=True)
                shutil.copy2(fixture, unsigned)
            elif 'sign-app' in args:
                shutil.copy2(fixture, Path(args[args.index('-outFile') + 1]))
            elif 'verify-app' in args:
                for required in ('-outCertChain', '-outProfile'):
                    if required not in args:
                        raise build.BuildError('Missing required verifier parameter ' + required)

        with (self.app / 'test.log').open('w', encoding='utf-8') as log:
            with patch.object(build, '_run', side_effect=external_tools):
                build.compile_and_sign(self.app, tc, pending, log)
        self.assertEqual(pending.read_bytes(), fixture.read_bytes())

    def test_missing_template_certificate_is_rejected_before_writing_profile(self):
        tc = self.toolchain()
        tc.profile_template.parent.mkdir(parents=True)
        tc.profile_template.write_text('{"bundle-info": {}}', encoding='utf-8')
        signature = self.app / 'signature'
        with self.assertRaisesRegex(build.BuildError, 'certificate'):
            build.prepare_signing(tc, signature)
        self.assertFalse(signature.exists())

    def test_wrong_bundle_is_not_published_over_previous_success(self):
        hap, manifest, old_hap, old_manifest = self.previous()
        pending = self.hap('new.hap', bundle='wrong.bundle')
        with self.assertRaisesRegex(build.BuildError, 'bundle'):
            build.publish_artifact(self.app, pending, time.time())
        self.assertEqual(hap.read_bytes(), old_hap)
        self.assertEqual(manifest.read_bytes(), old_manifest)

    def test_success_publishes_matching_api23_manifest(self):
        self.previous()
        artifact = build.publish_artifact(self.app, self.hap('new.hap'), time.time())
        info = build.validate_artifact(self.app)
        self.assertEqual(info['sdk'], 'API23')
        self.assertEqual(info['buildHost'], 'Windows')
        self.assertEqual(info['bundle'], 'com.eduoh.payloadterminal')
        with zipfile.ZipFile(artifact) as archive:
            self.assertEqual(archive.read('payload.txt'), b'new')

    def test_manifest_publication_failure_rolls_back_previous_pair(self):
        hap, manifest, old_hap, old_manifest = self.previous()
        pending = self.hap('new.hap')
        real_replace = build.os.replace
        failed = False

        def fail_manifest_once(source, destination):
            nonlocal failed
            if Path(destination) == manifest and not failed:
                failed = True
                raise OSError('manifest is locked')
            return real_replace(source, destination)

        with patch.object(build.os, 'replace', side_effect=fail_manifest_once):
            with self.assertRaisesRegex(OSError, 'manifest is locked'):
                build.publish_artifact(self.app, pending, time.time())
        self.assertEqual(hap.read_bytes(), old_hap)
        self.assertEqual(manifest.read_bytes(), old_manifest)

    def test_verify_detects_modified_hap(self):
        artifact = build.publish_artifact(self.app, self.hap('new.hap'), time.time())
        with artifact.open('ab') as output:
            output.write(b'tampered')
        with self.assertRaisesRegex(build.BuildError, 'SHA256'):
            build.validate_artifact(self.app)


if __name__ == '__main__':
    unittest.main()
