"""Check an actual `uitest dumpLayout` capture against demonstration UI requirements.

Capture the app at the top of its page. This checks rendered native controls,
not source-code spelling; use separate captures after each user interaction.
"""
import argparse
import json
import re
from pathlib import Path


def attributes(node):
    if isinstance(node, dict):
        if "attributes" in node:
            yield node["attributes"]
        for key, value in node.items():
            if key != "attributes":
                yield from attributes(value)
    elif isinstance(node, list):
        for item in node:
            yield from attributes(item)


def check(layout, role, mode, selected, paused=False, fault=False, unknown=False, tab="devices"):
    nodes = list(attributes(layout))
    texts = [str(node.get("text", "")) for node in nodes]
    ids = {node.get("id", "") for node in nodes}
    visible_ids = {node.get("id", "") for node in nodes if node.get("visible") == "true"}
    assert "航空载荷终端" in texts, "Capture must contain the target application"
    assert "configToggle" in visible_ids, "Connection settings must remain reachable at the top"
    assert "maintenanceToggle" in visible_ids, "Maintenance must remain reachable at the top"
    assert "runToggle" in ids, "Start/stop operation must remain available"
    if mode == "demo":
        assert "roleSelect" not in ids and "saveConfiguration" not in ids, "Configuration must be collapsed by default"
        assert not {"exportLogs", "pauseCommunication", "faultMode"} & ids, "Maintenance controls leaked into demonstration view"
        forbidden = ("教学联机实验", "模拟实验", "状态修订 ", "请求 ", "能力 v", "协议层")
        assert not any(token in text for text in texts for token in forbidden), "Debug or teaching scaffolding leaked into the main view"
    elif mode == "maintenance":
        assert "exportLogs" in ids, "Maintenance must expose log export"
        if role not in ("controller", "observer"):
            assert {"pauseCommunication", "faultMode"} <= ids, "Payload maintenance controls are missing"
    elif mode == "configuration":
        assert {"roleSelect", "saveConfiguration"} <= ids, "Configuration must expose role and save controls"
    if tab == "events":
        assert "任务记录" in texts, "Task history must have its user-facing name"
        assert not any(item.startswith("device-card-") for item in ids), "Device cards must not remain on the task-history tab"
    if role in ("controller", "observer") and mode == "demo" and tab == "devices":
        assert {"payload-CAM-01", "payload-ENV-01", "payload-LIGHT-01"} <= ids, "Three payload selectors are required"
        cards = {item for item in ids if item.startswith("device-card-")}
        assert cards == {"device-card-" + selected}, "Only the selected payload detail must be present: " + repr(cards)
    if role == "observer":
        assert not any(item.startswith("action-") for item in ids), "Observer must not have command controls"
    if paused:
        assert "pausedWarning" in visible_ids, "A paused device must warn even with maintenance closed"
        assert any("通信已暂停" in text for text in texts), "Paused warning must explain the condition"
    if fault:
        assert "faultWarning" in visible_ids, "An armed fault must warn even with maintenance closed"
        assert any("故障演示已启用" in text for text in texts), "Fault warning must be explicit"
    if unknown:
        warnings = [node for node in nodes if node.get("id") == "unknownWarning" and node.get("visible") == "true"]
        assert warnings, "UNKNOWN must have a visible top-level warning"
        assert any("结果未确认" in node.get("text", "") and "避免盲目重复操作" in node.get("text", "")
                   for node in warnings), "Visible UNKNOWN warning must retain the outcome and safe reconciliation guidance"
    assert not any(text in ("single", "continuous") for text in texts), "Mode readings must be localized"


def check_top_anchor(layout):
    nodes = list(attributes(layout))
    scrolls = [node for node in nodes if node.get("type") == "Scroll" and node.get("visible") == "true"]
    titles = [node for node in nodes if node.get("text") == "航空载荷终端" and node.get("visible") == "true"]
    assert scrolls and titles, "Capture must show the app title and its Scroll viewport"
    scroll_bounds = [int(value) for value in re.findall(r"-?\d+", scrolls[0].get("bounds", ""))]
    title_bounds = [int(value) for value in re.findall(r"-?\d+", titles[0].get("bounds", ""))]
    assert len(scroll_bounds) == len(title_bounds) == 4, "Native bounds must be present"
    # At 800x1280 on this board the title begins 25 px below the viewport top.
    assert 0 <= title_bounds[1] - scroll_bounds[1] <= 60, "Short content must remain anchored near the viewport top"


def check_command_result_visible(layout, expected_status):
    assert any(node.get("text") == expected_status and node.get("visible") == "true"
               for node in attributes(layout)), "Command result must be visible on the first screen: " + expected_status


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--layout", type=Path, required=True)
    parser.add_argument("--role", choices=["controller", "observer", "camera", "environment", "light"], required=True)
    parser.add_argument("--mode", choices=["demo", "maintenance", "configuration"], default="demo")
    parser.add_argument("--selected", choices=["CAM-01", "ENV-01", "LIGHT-01"], default="CAM-01")
    parser.add_argument("--tab", choices=["devices", "events"], default="devices")
    parser.add_argument("--paused", action="store_true")
    parser.add_argument("--fault", action="store_true")
    parser.add_argument("--unknown", action="store_true")
    parser.add_argument("--top-anchored", action="store_true", help="800x1280 board: title remains at the viewport top")
    parser.add_argument("--command-status", help="Expected visible human-readable result, e.g. 执行完成")
    args = parser.parse_args()
    try:
        check(json.loads(args.layout.read_text(encoding="utf-8")), args.role, args.mode, args.selected,
              args.paused, args.fault, args.unknown, args.tab)
        if args.top_anchored:
            check_top_anchor(json.loads(args.layout.read_text(encoding="utf-8")))
        if args.command_status:
            check_command_result_visible(json.loads(args.layout.read_text(encoding="utf-8")), args.command_status)
    except AssertionError as error:
        print("FAIL demo-ui: " + str(error))
        return 1
    print("PASS demo-ui: " + args.role + "/" + args.mode)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
