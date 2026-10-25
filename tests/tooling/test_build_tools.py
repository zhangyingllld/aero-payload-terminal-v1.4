"""Boundary tests: discovery, incomplete SDK, stale output, HAP identity/tampering."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools'))


class BuildToolsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        global build
        import payload_build as build

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.app = self.root / 'eduoh' / 'labs' / 'kit' / 'payload-app'
        self.app.mkdir(parents=True)

    def prepared(self):
        root = self.root / 'eduoh'
        (root / 'source').mkdir()
        (root / '.cache/qemu-sync-fix/dependencies/node_modules').mkdir(parents=True)
        return root

    def hap(self, bundle='com.eduoh.payloadterminal'):
        path = self.app / 'dist/payload-terminal-pending.hap'
        path.parent.mkdir(exist_ok=True)
        with zipfile.ZipFile(path, 'w') as archive:
            archive.writestr('module.json', json.dumps({'app': {'bundleName': bundle}, 'module': {'name': 'entry', 'mainElement': 'EntryAbility', 'abilities': [{'name': 'EntryAbility'}]}}))
        return path

    def test_searches_ancestors_for_prepared_root(self):
        expected = self.prepared()
        self.assertEqual(build.find_eduoh_root(self.app, {}), expected)

    def test_invalid_explicit_root_never_silently_falls_back(self):
        self.prepared()
        with self.assertRaisesRegex(build.BuildError, 'EDUOH_ROOT'):
            build.find_eduoh_root(self.app, {'EDUOH_ROOT': str(self.root / 'wrong')})

    def test_reports_all_missing_signing_and_sdk_inputs(self):
        paths = build.Toolchain(self.prepared(), java='java')
        errors = build.inspect_paths(paths)
        joined = '\n'.join(errors)
        self.assertIn('node-v16.20.2', joined)
        self.assertIn('OpenHarmonyApplication.pem', joined)
        self.assertIn('UnsgnedReleasedProfileTemplate.json', joined)
        self.assertIn('@ohos', joined)

    def test_failed_preflight_removes_previous_published_outputs(self):
        dist = self.app / 'dist'
        dist.mkdir()
        for name in ['payload-terminal-signed.hap', 'build-info.json']:
            (dist / name).write_text('old success')
        with self.assertRaises(build.BuildError):
            build.run_build(self.app, {'EDUOH_ROOT': str(self.root / 'missing')})
        self.assertFalse((dist / 'payload-terminal-signed.hap').exists())
        self.assertFalse((dist / 'build-info.json').exists())
        self.assertFalse((self.app / '.build.lock').exists())

    def test_failed_preflight_replaces_old_success_log_with_current_failure(self):
        logs = self.app / 'logs'
        logs.mkdir()
        (logs / 'build.log').write_text('OLD SUCCESS')
        with self.assertRaises(build.BuildError):
            build.run_build(self.app, {'EDUOH_ROOT': str(self.root / 'missing')})
        log = (logs / 'build.log').read_text(encoding='utf-8')
        self.assertNotIn('OLD SUCCESS', log)
        self.assertIn('STOP:', log)

    def test_publish_validates_identity_before_exposing_artifact(self):
        pending = self.hap('com.eduoh.vibewheel')
        with self.assertRaisesRegex(build.BuildError, 'bundle'):
            build.publish_artifact(self.app, pending, 0)
        self.assertFalse((self.app / 'dist/payload-terminal-signed.hap').exists())

    def test_manifest_detects_tampered_or_incomplete_artifact(self):
        pending = self.hap()
        artifact = build.publish_artifact(self.app, pending, 0)
        info = build.validate_artifact(self.app)
        self.assertEqual(info['bundle'], 'com.eduoh.payloadterminal')
        self.assertEqual(info['artifact'], 'payload-terminal-signed.hap')
        with artifact.open('ab') as file:
            file.write(b'tampered')
        with self.assertRaisesRegex(build.BuildError, 'SHA256'):
            build.validate_artifact(self.app)

    def test_target_requires_one_exact_device_identifier(self):
        for target in ['', '*', 'ABC DEF', 'a?b', '-t', 'all', 'a\nb']:
            with self.subTest(target=target):
                with self.assertRaises(build.BuildError):
                    build.validate_target(target)
        self.assertEqual(build.validate_target('board-ABC012'), 'board-ABC012')
        self.assertEqual(build.validate_target('192.168.50.13:55555'), '192.168.50.13:55555')


if __name__ == '__main__':
    unittest.main()
