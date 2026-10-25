import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DistributedService } from '../../payload-app/entry/src/main/ets/platform/DistributedService.ets';
import { state, reset } from './distributed-native-doubles.mjs';
import { trialKey, feedbackKey, newTrial, reviseTrial, makeFeedback } from '../../payload-app/entry/src/main/ets/core/distributedTask.ts';

function setup() {
  reset();
  const fixture = { view: null };
  fixture.service = new DistributedService(view => { fixture.view = view; });
  fixture.service.setIdentity('controller', 'TERM-01');
  state.peers = [
    { deviceId: 'peer-A', deviceName: '开发板 A', deviceType: 'tablet', networkId: 'net-A-old' },
    { deviceId: 'peer-B', deviceName: '开发板 B', deviceType: 'tablet', networkId: 'net-B' }
  ];
  return fixture;
}

test('permission denial leaves payload-independent module disabled and opens no native store', async () => {
  const f = setup(); state.permission = -1;
  await f.service.enable({});
  assert.equal(f.view.enabled, false);
  assert.match(f.view.error, /授权|允许/);
  assert.equal(state.dmCreated, 0); assert.equal(state.opened.length, 0);
  await f.service.close();
});

test('sync uses only explicitly selected trusted peers and refreshes changed network IDs', async () => {
  const f = setup(); await f.service.enable({});
  f.service.togglePeer('peer-A');
  state.peers[0].networkId = 'net-A-new';
  f.service.sync();
  assert.deepEqual(state.requests, [{ ids: ['net-A-new'], mode: 2, delay: 0 }]);
  assert.equal(f.view.busy, true);
  assert.equal(f.view.peers.find(p => p.id === 'peer-B').status, '尚未同步');
  state.store.emit('syncComplete', [['net-A-new', 0]]);
  assert.equal(f.view.busy, false);
  assert.match(f.view.peers[0].status, /不代表对端已查看/);
  assert.equal(f.view.feedback.length, 0);
  await f.service.close();
});

test('one native failure cannot be hidden by another successful peer, and pending writes stay blocked', async () => {
  const f = setup(); await f.service.enable({});
  f.service.togglePeer('peer-A'); f.service.togglePeer('peer-B'); f.service.sync();
  assert.deepEqual(state.requests.map(r => r.ids), [['net-A-old']], 'only one native target can be in flight');
  await f.service.createTask('A-E', '不应在同步中写入');
  assert.equal(state.records.size, 0);
  state.store.emit('syncComplete', [['native-anonymous-A', 0]]);
  assert.equal(f.view.busy, true);
  assert.deepEqual(state.requests.map(r => r.ids), [['net-A-old'], ['net-B']]);
  state.store.emit('syncComplete', [['native-anonymous-B', 15100004]]);
  assert.equal(f.view.busy, false);
  assert.match(f.view.peers.find(p => p.id === 'peer-B').status, /15100004/);
  assert.equal(f.view.feedback.length, 0);
  await f.service.close();
});

function entry(record) {
  return { key: record.kind === 'task' ? trialKey(record) : feedbackKey(record), value: { type: 0, value: JSON.stringify(record) } };
}
function receive(records) {
  state.store.emit('dataChange', { insertEntries: records.map(entry), updateEntries: [], deleteEntries: [], deviceId: '' });
}

test('current session follows higher revisions; explicitly chosen history blocks feedback and revision', async () => {
  const f = setup(); await f.service.enable({}); await f.service.createTask('A-E', '版本一');
  const old = f.view.current; await f.service.ready(true);
  const revised = reviseTrial(old, 'controller', f.view.localId, '版本二', old.updatedAt + 1000);
  receive([revised]);
  assert.equal(f.view.current.revision, 2); assert.equal(f.view.historical, false);
  assert.equal(f.view.feedback.length, 0, 'old version readiness is not counted');
  f.service.selectTask(trialKey(old));
  assert.equal(f.view.historical, true);
  const before = state.records.size;
  await f.service.ready(false); assert.match(f.view.error, /历史/);
  await f.service.revise('不允许分叉'); assert.match(f.view.error, /历史/);
  assert.equal(state.records.size, before);
  receive([old]);
  assert.equal(f.view.current.revision, 1, 'duplicate old arrival must not override deliberate history selection');
  await f.service.close();
});

test('malformed native entry wrappers are isolated and empty remote source remains unattributed', async () => {
  const f = setup(); await f.service.enable({});
  const valid = newTrial('controller', 'peer-A', 'A-E', '有效任务', 'wrap-case', Date.now());
  const malformed = [null, {}, { key: null }, { key: 'trial/task/x' }, { key: 'trial/task/x', value: null },
    { key: 'trial/task/x', value: { value: 7 } }, { key: 'trial/task/x', value: { value: '{' } }];
  assert.doesNotThrow(() => state.store.emit('dataChange', { insertEntries: malformed.concat(entry(valid)), updateEntries: [], deviceId: '' }));
  assert.equal(f.view.current.sessionId, 'wrap-case');
  assert.match(f.view.logs.join('\n'), /自报/);
  assert.doesNotThrow(() => state.store.emit('dataChange', { insertEntries: null, updateEntries: [entry(valid)], deviceId: null }));
  await f.service.close();
});

test('persistent pruning keeps only 20 own task versions and 200 own feedback records, preserving other members', async () => {
  const f = setup(); const now = Date.now() - 10000; const local = 'local-device-1234';
  for (let i = 0; i < 25; i++) {
    const task = newTrial('controller', local, 'A-E', '本机任务', 'own-' + i, now + i);
    const e = entry(task); state.records.set(e.key, e.value.value);
  }
  const foreign = newTrial('controller', 'peer-A', 'A-E', '外部任务', 'foreign', now);
  state.records.set(trialKey(foreign), JSON.stringify(foreign));
  for (let i = 0; i < 205; i++) {
    const task = { ...foreign, sessionId: 'foreign-' + i };
    const feedback = makeFeedback(task, local, 'controller', 'TERM-01', true, 0, now + i);
    state.records.set(feedbackKey(feedback), JSON.stringify(feedback));
  }
  const other = makeFeedback(foreign, 'peer-B', 'observer', 'VIEW-01', true, 0, now);
  state.records.set(feedbackKey(other), JSON.stringify(other));
  await f.service.enable({});
  await f.service.createTask('A-E', '新任务'); await f.service.ready(true);
  const records = [...state.records.values()].map(v => JSON.parse(v));
  assert.equal(records.filter(r => r.kind === 'task' && r.creatorId === local).length, 20);
  assert.equal(records.filter(r => r.kind === 'ready' && r.memberId === local).length, 200);
  assert.equal(state.records.has(trialKey(foreign)), true);
  assert.equal(state.records.has(feedbackKey(other)), true);
  assert.equal(records.some(r => r.kind === 'ready' && r.sessionId === 'foreign-0' && r.memberId === local), false);
  await f.service.close();
});

test('native timeout holds the one in-flight request until a late opaque-ID result, then starts the next peer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = setup(); await f.service.enable({});
  f.service.togglePeer('peer-A'); f.service.togglePeer('peer-B'); f.service.sync();
  t.mock.timers.tick(30001);
  assert.match(f.view.error, /结果未知/); assert.match(f.view.error, /重新启动/);
  f.service.sync(); assert.equal(state.requests.length, 1, 'timeout cannot release the native handle or retry');
  state.store.emit('syncComplete', [['opaque-return-A', 0]]);
  assert.equal(state.requests.length, 2);
  assert.equal(f.view.busy, true);
  state.store.emit('syncComplete', [['opaque-return-A', 0]]);
  assert.equal(f.view.busy, true, 'duplicate A result cannot complete B');
  state.store.emit('syncComplete', [['opaque-return-B', 0]]);
  assert.equal(f.view.busy, false);
  await f.service.close(); t.mock.timers.reset();
});

test('ambiguous multi-result callback cannot be guessed by array position or advance the queue', async () => {
  const f = setup(); await f.service.enable({});
  f.service.togglePeer('peer-A'); f.service.togglePeer('peer-B'); f.service.sync();
  state.store.emit('syncComplete', [['opaque-A', 0], ['opaque-B', 0]]);
  assert.equal(state.requests.length, 1); assert.equal(f.view.busy, true);
  assert.match(f.view.error, /唯一/);
  state.store.emit('syncComplete', [['opaque-A', 0]]);
  state.store.emit('syncComplete', [['opaque-B', 0]]);
  await f.service.close();
});

test('closing waits for native synchronization before closing its store and releasing all handlers', async () => {
  const f = setup(); await f.service.enable({}); f.service.togglePeer('peer-A'); f.service.sync();
  const close = f.service.close();
  await Promise.resolve();
  assert.equal(state.closed, 0);
  state.store.emit('syncComplete', [['net-A-old', 0]]);
  await close;
  assert.equal(state.closed, 1);
  assert.equal(state.released, 1);
  assert.equal(state.store.listenerCount('dataChange'), 0);
  assert.equal(state.store.listenerCount('syncComplete'), 0);
  assert.equal(state.dm.listenerCount('discoverSuccess'), 0);
});

test('local task creation is not labeled remote delivery and encrypted store options are passed to native API', async () => {
  const f = setup(); await f.service.enable({});
  await f.service.createTask('A-E', '供电与模拟载荷检查');
  assert.equal(f.view.current.title, '供电与模拟载荷检查');
  assert.match(f.view.status, /已保存在本机/);
  assert.equal(state.requests.length, 0);
  assert.equal(f.view.feedback.length, 0);
  assert.equal(state.opened[0].options.encrypt, true);
  assert.equal(state.opened[0].options.autoSync, false);
  await f.service.close();
});

test('code zero bind callback does not imply trust, and only an available peer with a network ID becomes selectable', async () => {
  const f = setup(); state.peers = []; await f.service.enable({});
  const peer = { deviceId: 'peer-C', deviceName: '开发板 C', deviceType: 'tablet' };
  state.dm.emit('discoverSuccess', { device: peer });
  f.service.bind('peer-C');
  state.bindCallback({ code: 0 }, { deviceId: 'peer-C' });
  assert.equal(f.view.error, '');
  assert.equal(f.view.peers.length, 0);
  assert.doesNotMatch(f.view.status, /成功|已确认/);
  state.peers = [peer];
  state.dm.emit('deviceStateChange', { action: 1, device: peer });
  assert.equal(f.view.peers.length, 0, 'network ID is required even after AVAILABLE event');
  state.peers = [{ ...peer, networkId: 'net-C' }];
  state.dm.emit('deviceStateChange', { action: 1, device: state.peers[0] });
  assert.equal(f.view.peers.length, 1);
  assert.equal(f.view.peers[0].selected, false);
  assert.match(f.view.status, /可信可用/);
  await f.service.close();
});

test('zero bind code with a nonzero native reason remains a failed authentication', async () => {
  const f = setup(); state.peers = []; await f.service.enable({});
  state.dm.emit('discoverSuccess', { device: { deviceId: 'peer-C', deviceName: 'C', deviceType: 'tablet' } });
  f.service.bind('peer-C');
  state.bindCallback({ code: 0, reason: -20010, errInfo: 'Authentication timed out' }, undefined);
  assert.match(f.view.error, /-20010/);
  assert.doesNotMatch(f.view.error, /undefined/);
  assert.equal(f.view.peers.length, 0);
  await f.service.close();
});

test('an undocumented negative result status is not promoted to successful authentication', async () => {
  const f = setup(); state.peers = []; await f.service.enable({});
  state.dm.emit('discoverSuccess', { device: { deviceId: 'peer-C', deviceName: 'C', deviceType: 'tablet' } });
  f.service.bind('peer-C');
  state.bindCallback(undefined, { deviceId: 'peer-C', status: -4 });
  assert.match(f.view.error, /-4/);
  assert.equal(f.view.peers.length, 0);
  await f.service.close();
});
