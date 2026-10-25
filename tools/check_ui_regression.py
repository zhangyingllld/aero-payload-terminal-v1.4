"""Assert visible role/port and running status in captured native UI layouts."""
import argparse
import json
from pathlib import Path


def attributes(node):
    if isinstance(node, dict):
        if 'attributes' in node:
            yield node['attributes']
        for key, value in node.items():
            if key != 'attributes':
                yield from attributes(value)
    elif isinstance(node, list):
        for item in node:
            yield from attributes(item)


def check_role_port(layout):
    nodes = list(attributes(layout))
    texts = [node.get('text', '') for node in nodes]
    assert '4 环境载荷' in texts, 'Expected environment role to be visibly selected'
    assert '本机载荷服务端口' in texts, 'Role changed but port label did not update'
    assert any(node.get('type') == 'TextInput' and node.get('text') == '43180' for node in nodes), 'Environment port must visibly show 43180'
    assert not any(node.get('type') == 'TextInput' and node.get('text') == '43181' for node in nodes), 'Old controller port remains visible'


def check_running(layout):
    texts = [node.get('text', '') for node in attributes(layout)]
    assert '停止连接' in texts and '模拟运行' in texts, 'Runtime has not started'
    assert '运行中' in texts, 'Running status badge did not update'
    assert '未启动' not in texts, 'Stale not-started status is still displayed'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--role-layout', type=Path, required=True)
    parser.add_argument('--running-layout', type=Path, required=True)
    args = parser.parse_args()
    failed = 0
    for name, path, check in [('role-port', args.role_layout, check_role_port), ('running-status', args.running_layout, check_running)]:
        try:
            check(json.loads(path.read_text(encoding='utf-8')))
            print('PASS ' + name)
        except AssertionError as error:
            failed += 1
            print('FAIL ' + name + ': ' + str(error))
    return 1 if failed else 0


if __name__ == '__main__':
    raise SystemExit(main())
