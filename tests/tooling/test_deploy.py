import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tools'))
import payload_build as build


class DeploymentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        global deploy
        import deploy

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = Path(self.temp.name)
        (self.app / 'dist').mkdir()
        pending = self.app / 'dist/pending.hap'
        with zipfile.ZipFile(pending, 'w') as z:
            z.writestr('module.json', json.dumps({'app': {'bundleName': 'com.eduoh.payloadterminal'}, 'module': {'mainElement': 'EntryAbility', 'abilities': [{'name': 'EntryAbility'}]}}))
        build.publish_artifact(self.app, pending, 0)

    def test_absent_target_cannot_install_on_another_connected_board(self):
        with patch.object(deploy, 'hdc_command', return_value='OTHER-BOARD\n') as hdc:
            with self.assertRaisesRegex(build.BuildError, 'not listed'):
                deploy.install(self.app, 'hdc', 'MY-BOARD')
            self.assertEqual(hdc.call_args_list[0].args, ('hdc', ['list', 'targets']))
            self.assertEqual(hdc.call_count, 1)

    def test_install_and_launch_always_pin_exact_target(self):
        with patch.object(deploy, 'hdc_command', side_effect=['BOARD-A\nBOARD-B\n', 'install bundle successfully', 'start ability successfully']) as hdc:
            deploy.install(self.app, 'hdc', 'BOARD-B')
            self.assertEqual(hdc.call_args_list[1].args[1], ['-t', 'BOARD-B', 'install', '-r', str(self.app / 'dist/payload-terminal-signed.hap')])
            self.assertEqual(hdc.call_args_list[2].args[1], ['-t', 'BOARD-B', 'shell', 'aa', 'start', '-a', 'EntryAbility', '-b', 'com.eduoh.payloadterminal'])

    def test_no_launch_after_install_output_reports_failure(self):
        with patch.object(deploy, 'hdc_command', side_effect=['BOARD-A\n', 'install failed']) as hdc:
            with self.assertRaisesRegex(build.BuildError, 'installation'):
                deploy.install(self.app, 'hdc', 'BOARD-A')
            self.assertEqual(hdc.call_count, 2)

    def test_check_does_not_install(self):
        with patch.object(deploy, 'hdc_command', return_value='BOARD-A\n') as hdc:
            deploy.install(self.app, 'hdc', 'BOARD-A', check=True)
            self.assertEqual(hdc.call_count, 1)


if __name__ == '__main__':
    unittest.main()
