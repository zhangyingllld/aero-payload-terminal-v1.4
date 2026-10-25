"""Synthetic layout fixtures validate the checker; these are not hardware evidence."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tools'))
from check_demo_ui import check


def node(text='', identifier='', visible=True):
    return {'attributes': {'id': identifier, 'text': text, 'visible': str(visible).lower()}}


def fixture(warning):
    return {'children': [node('航空载荷终端'), node(identifier='configToggle'),
                         node(identifier='maintenanceToggle'), node(identifier='runToggle'), warning]}


class UnknownWarningLayoutTests(unittest.TestCase):
    def validate(self, layout):
        check(layout, 'camera', 'demo', 'CAM-01', unknown=True)

    def test_visible_top_warning_is_sufficient_without_lower_command_card(self):
        layout = fixture(node('CAM-01：结果未确认。请核对当前状态，避免盲目重复操作。', 'unknownWarning'))
        self.validate(layout)

    def test_hidden_warning_cannot_be_replaced_by_lower_command_card(self):
        layout = fixture(node('结果未确认。避免盲目重复操作。', 'unknownWarning', visible=False))
        layout['children'] += [node('结果未确认'), node('避免盲目重复操作')]
        with self.assertRaises(AssertionError):
            self.validate(layout)

    def test_missing_top_warning_rejects_unrelated_matching_text(self):
        layout = fixture(node('结果未确认'))
        layout['children'].append(node('避免盲目重复操作'))
        with self.assertRaises(AssertionError):
            self.validate(layout)

    def test_guidance_must_be_inside_the_visible_warning(self):
        layout = fixture(node('结果未确认', 'unknownWarning'))
        layout['children'].append(node('避免盲目重复操作'))
        with self.assertRaises(AssertionError):
            self.validate(layout)


if __name__ == '__main__':
    unittest.main()
