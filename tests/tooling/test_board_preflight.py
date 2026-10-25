import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


TOOLS = Path(__file__).resolve().parents[2] / 'tools'
sys.path.insert(0, str(TOOLS))


class BoardPreflightTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue((TOOLS / 'board_preflight.py').is_file(), 'Read-only board preflight has not been implemented')
        import board_preflight
        self.tool = board_preflight

    @staticmethod
    def completed(output, code=0):
        return subprocess.CompletedProcess(['hdc'], code, output, '')

    def successful_responses(self, targets='BOARD-A\nBOARD-B\n'):
        return [self.completed(targets), self.completed('OpenHarmony-6.1.0.35'), self.completed('18'),
                self.completed('eth0: flags=4163\n    inet 192.168.1.25 netmask 255.255.255.0\n'
                               'lo: flags=73\n    inet 127.0.0.1 netmask 255.0.0.0\n')]

    def test_exact_explicit_target_works_when_multiple_boards_connected(self):
        with patch.object(self.tool.subprocess, 'run', side_effect=self.successful_responses()) as run:
            report = self.tool.inspect_board('hdc.exe', 'BOARD-B')
        self.assertEqual(report['target'], 'BOARD-B')
        self.assertEqual(report['system']['fullName'], 'OpenHarmony-6.1.0.35')
        self.assertEqual(report['system']['apiVersion'], 18)
        self.assertEqual(report['network']['ipv4Candidates'], ['192.168.1.25'])
        self.assertEqual(run.call_args_list[0].args[0], ['hdc.exe', 'list', 'targets'])
        self.assertEqual([call.args[0] for call in run.call_args_list[1:]], [
            ['hdc.exe', '-t', 'BOARD-B', 'shell', 'param', 'get', 'const.ohos.fullname'],
            ['hdc.exe', '-t', 'BOARD-B', 'shell', 'param', 'get', 'const.ohos.apiversion'],
            ['hdc.exe', '-t', 'BOARD-B', 'shell', 'ifconfig']])

    def test_unknown_target_never_queries_another_board(self):
        with patch.object(self.tool.subprocess, 'run', return_value=self.completed('BOARD-A\n')) as run:
            with self.assertRaisesRegex(self.tool.PreflightError, 'not listed'):
                self.tool.inspect_board('hdc', 'BOARD')
        self.assertEqual(run.call_count, 1)

    def test_empty_device_list_stops_before_queries(self):
        with patch.object(self.tool.subprocess, 'run', return_value=self.completed('[Empty]')) as run:
            with self.assertRaisesRegex(self.tool.PreflightError, 'not listed'):
                self.tool.inspect_board('hdc', 'BOARD-A')
        self.assertEqual(run.call_count, 1)

    def test_missing_target_is_a_cli_usage_error_without_running_hdc(self):
        with patch.object(self.tool.subprocess, 'run') as run, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as stopped:
                self.tool.main(['--hdc', 'hdc'])
        self.assertEqual(stopped.exception.code, 2)
        run.assert_not_called()

    def test_failed_transport_text_is_not_success_even_with_zero_exit_status(self):
        for output in ['[Fail] Not match target founded', 'device unauthorized', 'No permissions',
                       'Connect failed', '[E] connection closed', 'error: device offline']:
            with self.subTest(output=output):
                with patch.object(self.tool.subprocess, 'run', return_value=self.completed(output)):
                    with self.assertRaises(self.tool.PreflightError):
                        self.tool.inspect_board('hdc', 'BOARD-A')

    def test_device_disappears_after_listing_stops_without_reporting_success(self):
        with patch.object(self.tool.subprocess, 'run', side_effect=[self.completed('BOARD-A'), self.completed('[Fail] device offline')]) as run:
            with self.assertRaises(self.tool.PreflightError):
                self.tool.inspect_board('hdc', 'BOARD-A')
        self.assertEqual(run.call_count, 2)

    def test_timeout_is_reported_as_preflight_failure(self):
        with patch.object(self.tool.subprocess, 'run', side_effect=subprocess.TimeoutExpired('hdc', 15)):
            with self.assertRaisesRegex(self.tool.PreflightError, 'timed out'):
                self.tool.inspect_board('hdc', 'BOARD-A')

    def test_legacy_ifconfig_and_multiple_interfaces_keep_candidates(self):
        responses = self.successful_responses()
        responses[-1] = self.completed('inet addr:192.168.5.11 Bcast:192.168.5.255\ninet 10.0.0.9 netmask 255.0.0.0\ninet addr:192.168.5.11\ninet 127.0.0.1\ninet 0.0.0.0\n')
        with patch.object(self.tool.subprocess, 'run', side_effect=responses):
            report = self.tool.inspect_board('hdc', 'BOARD-A')
        self.assertEqual(report['network']['ipv4Candidates'], ['192.168.5.11', '10.0.0.9'])
        self.assertTrue(report['warnings'])

    def test_cli_writes_actual_report_and_preserves_existing_report(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'board-report.json'
            with patch.object(self.tool.subprocess, 'run', side_effect=self.successful_responses()), contextlib.redirect_stdout(io.StringIO()):
                code = self.tool.main(['--hdc', 'hdc', '--target', 'BOARD-B', '--output', str(output)])
            self.assertEqual(code, 0)
            report = json.loads(output.read_text(encoding='utf-8'))
            self.assertEqual(report['target'], 'BOARD-B')
            self.assertTrue(report['readOnly'])
            before = output.read_bytes()
            with patch.object(self.tool.subprocess, 'run') as run, contextlib.redirect_stderr(io.StringIO()):
                code = self.tool.main(['--hdc', 'hdc', '--target', 'BOARD-A', '--output', str(output)])
            self.assertEqual(code, 1)
            self.assertEqual(output.read_bytes(), before)
            run.assert_not_called()

    def test_empty_api_query_is_not_misrepresented_as_verified(self):
        responses = self.successful_responses()
        responses[2] = self.completed('')
        with patch.object(self.tool.subprocess, 'run', side_effect=responses):
            with self.assertRaisesRegex(self.tool.PreflightError, 'API'):
                self.tool.inspect_board('hdc', 'BOARD-A')


if __name__ == '__main__':
    unittest.main()
