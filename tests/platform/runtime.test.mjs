import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { AppRuntime, checkConfig } from '../../payload-app/entry/src/main/ets/platform/AppRuntime.ets';
import { defaultConfig } from '../../payload-app/entry/src/main/ets/core/models.ts';
import { shutdown, unusedPort } from './ohos-mocks.mjs';
const runtimes = [];
const directories = [];
after(async () => {
  for (const runtime of runtimes) runtime.dispose();
  await shutdown();
  for (const dir of directories) {
    const resolved = path.resolve(dir);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('payload-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
function instance() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payload-test-')); directories.push(dir);
  const result = { dir, view: null, runtime: null };
  result.runtime = new AppRuntime({ filesDir: dir }, view => { result.view = view; }); runtimes.push(result.runtime); return result;
}
async function until(predicate, description, timeout = 7000) {
  const limit = performance.now() + timeout;
  while (performance.now() < limit) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  assert.fail('Timed out: ' + description);
}
test('native adapter validates fixed role IDs and IPv4 configuration', () => {
  const config = defaultConfig('camera'); checkConfig(config);
  config.cameraHost = '999.1.1.1'; assert.throws(() => checkConfig(config), /IPv4/);
  config.cameraHost = '127.0.0.1'; config.nodeId = 'OTHER'; assert.throws(() => checkConfig(config), /编号固定/);
});
test('configuration survives recreation and malformed storage is visible', async () => {
  const first = instance(); const config = defaultConfig('observer'); config.controllerHost = '127.0.0.1';
  await first.runtime.save(config);
  const other = new AppRuntime({ filesDir: first.dir }, view => { first.view = view; }); runtimes.push(other);
  assert.equal((await other.load()).role, 'observer');
  fs.writeFileSync(path.join(first.dir, 'payload-config.json'), '{bad');
  await other.load(); assert.match(first.view.error, /读取本地记录失败/);
});
test('first retry after a busy listening port is released does not reuse a failed listener', async () => {
  const blocker = net.createServer();
  await new Promise(resolve => blocker.listen(0, '0.0.0.0', resolve));
  const config = defaultConfig('camera'); config.listenPort = blocker.address().port;
  const peer = instance(); await peer.runtime.load();
  try {
    await peer.runtime.start(config);
    await until(() => peer.view && !peer.view.running && peer.view.error !== '', 'busy port failure surfaced');
  } finally { await new Promise(resolve => blocker.close(resolve)); }
  await peer.runtime.start(config);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(peer.view.running, true, peer.view.error);
  assert.equal(peer.view.error, '');
  peer.runtime.stop();
});
test('five native runtime adapters communicate over actual loopback TCP, export, and restart', async () => {
  const ports = await Promise.all([unusedPort(), unusedPort(), unusedPort(), unusedPort()]);
  assert.equal(new Set(ports).size, 4);
  const roles = ['controller', 'observer', 'camera', 'environment', 'light'];
  const peers = roles.map(() => instance());
  const configs = roles.map(role => {
    const config = defaultConfig(role);
    config.controllerHost = config.cameraHost = config.environmentHost = config.lightHost = '127.0.0.1';
    config.controllerPort = ports[0]; config.cameraPort = ports[1]; config.environmentPort = ports[2]; config.lightPort = ports[3];
    config.listenPort = role === 'controller' ? ports[0] : role === 'camera' ? ports[1] : role === 'environment' ? ports[2] : ports[3];
    return config;
  });
  for (const i of [2, 3, 4, 0, 1]) { await peers[i].runtime.load(); await peers[i].runtime.start(configs[i]); }
  const controller = peers[0]; const observer = peers[1];
  await until(() => controller.view?.payloads.length === 3 && controller.view.payloads.every(item => item.linkState === 'READY'), 'three payloads READY');
  await until(() => observer.view?.payloads.length === 3 && observer.view.mainLinkState === 'READY', 'observer snapshot');
  const light = controller.view.payloads.find(item => item.deviceId === 'LIGHT-01');
  const action = light.capability.actions.find(item => item.control === 'slider');
  assert.ok(action, 'capability-generated slider');
  controller.runtime.command('LIGHT-01', action.id, 73);
  await until(() => controller.view.payloads.find(item => item.deviceId === 'LIGHT-01').lastCommand.status === 'completed', 'command completed');
  const exportPath = await controller.runtime.exportLogs();
  const exported = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
  assert.equal(exported.simulated, true); assert.ok(exported.events.length > 0); assert.equal(exported.view.config.role, 'controller');
  const oldRequest = controller.view.payloads.find(item => item.deviceId === 'LIGHT-01').lastCommand.requestId;
  observer.runtime.command('LIGHT-01', action.id, 99);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(controller.view.payloads.find(item => item.deviceId === 'LIGHT-01').lastCommand.requestId, oldRequest, 'observer cannot control');
  peers[4].runtime.stop();
  await until(() => controller.view.payloads.find(item => item.deviceId === 'LIGHT-01').linkState !== 'READY', 'stop disconnects');
  await peers[4].runtime.start(configs[4]);
  await until(() => controller.view.payloads.find(item => item.deviceId === 'LIGHT-01').linkState === 'READY', 'same listener restart');
  assert.equal(controller.view.payloads.find(item => item.deviceId === 'LIGHT-01').lastCommand.status === 'waiting', false, 'no replay after restart');
  for (const peer of peers) peer.runtime.stop();
});
