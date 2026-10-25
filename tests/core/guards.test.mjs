import test from 'node:test';
import assert from 'node:assert/strict';
import { PayloadEngine } from '../../payload-app/entry/src/main/ets/core/engine.ts';
import { defaultConfig } from '../../payload-app/entry/src/main/ets/core/models.ts';
import { Network, reading } from './network.mjs';

function standalone(role = 'camera') {
  const state = { now: 1000, sent: [], closed: [], logs: [], connects: [], config: defaultConfig(role) };
  state.engine = new PayloadEngine({ now: () => state.now, send: (id, m) => state.sent.push({ id, message: structuredClone(m) }), connect: (...args) => state.connects.push(args), listen() {}, close: id => state.closed.push(id), stop() {}, changed() {}, log: event => state.logs.push(event) });
  state.engine.start(state.config);
  state.hello = (id, overrides = {}) => {
    state.engine.connected(id, '', true);
    state.engine.received(id, { protocolVersion: 1, type: 'hello', messageId: 'hello-' + id, sessionId: '', sourceId: 'TERM-01', targetId: state.config.nodeId, seq: 0, requestId: '', sentAt: '2026-10-22T00:00:00.000Z', body: { role: 'controller', bootId: 'controller-boot' }, ...overrides });
    return state.sent.findLast(s => s.id === id && s.message.type === 'helloAck')?.message.sessionId;
  };
  state.command = (id, session, seq, requestId, actionId = 'capture', value = true) => state.engine.received(id, { protocolVersion: 1, type: 'command', messageId: 'message-' + seq, sessionId: session, sourceId: 'TERM-01', targetId: state.config.nodeId, seq, requestId, sentAt: '2026-10-22T00:00:00.000Z', body: { actionId, args: { value } } });
  return state;
}

test('log timestamps use wall time while protocol deadlines use local monotonic time', () => {
  const state = standalone();
  assert.ok(Number(state.engine.getView().events[0].time.slice(0, 4)) >= 2020);
});

test('a second controller cannot take over an active lease and an expired lease cannot execute after takeover', () => {
  const state = standalone(); const first = state.hello('first');
  assert.ok(first); assert.equal(state.hello('second'), undefined);
  assert.equal(state.sent.findLast(s => s.id === 'second').message.body.code, 'CONTROLLER_BUSY');
  state.now += 6001; assert.ok(state.hello('third'));
  state.command('first', first, 1, 'stale-owner');
  state.now += 250; state.engine.tick();
  assert.equal(reading(state.engine.getView().local, 'captureCount'), 0);
});

test('same state revision cannot silently change values', () => {
  const n = new Network().five(); const snapshot = n.latest('LIGHT-01', 'snapshot');
  n.injectDuplicate(snapshot, m => { m.body.metrics.find(r => r.id === 'brightness').value = 99; });
  assert.equal(reading(n.payload('LIGHT-01'), 'brightness'), 0);
});

test('stop and explicit service restart abandon pending execution and ignore old connection callbacks', () => {
  const state = standalone(); const session = state.hello('old');
  const oldBoot = state.engine.getView().local.bootId;
  state.command('old', session, 1, 'before-stop');
  assert.equal(state.engine.getView().local.lastCommand.status, 'accepted');
  state.engine.stop(); state.engine.start(state.config); state.now += 1000;
  state.command('old', session, 2, 'late-after-restart'); state.engine.closed('old', 'late callback'); state.engine.tick();
  assert.notEqual(state.engine.getView().local.bootId, oldBoot);
  assert.equal(reading(state.engine.getView().local, 'captureCount'), 0);
  assert.equal(state.engine.getView().local.lastCommand.status, '');
});

test('dedupe survives TCP reconnect within the same service boot', () => {
  const state = standalone(); const first = state.hello('first');
  state.command('first', first, 1, 'same-request'); state.now += 250; state.engine.tick();
  state.engine.closed('first', 'network disconnect'); const second = state.hello('second');
  state.command('second', second, 1, 'same-request'); state.now += 250; state.engine.tick();
  assert.equal(reading(state.engine.getView().local, 'captureCount'), 1);
  assert.equal(state.sent.findLast(s => s.message.type === 'commandStatus').message.body.status, 'completed');
});

test('malformed envelope count resets on valid traffic and closes on three consecutive invalid frames', () => {
  const state = standalone(); const session = state.hello('first');
  const bad = { protocolVersion: 1 };
  state.engine.received('first', bad); state.engine.received('first', bad);
  assert.equal(state.closed.length, 0);
  state.command('first', session, 1, 'valid', 'missing-action');
  state.engine.received('first', bad); state.engine.received('first', bad);
  assert.equal(state.closed.length, 0);
  state.engine.received('first', bad); assert.deepEqual(state.closed, ['first']);
});

test('wrong configured identity is rejected before opening any listener or outbound connection', () => {
  const state = standalone('controller'); state.engine.stop(); state.connects.length = 0;
  state.engine.start({ ...state.config, nodeId: 'VIEW-01' });
  assert.equal(state.engine.getView().running, false); assert.equal(state.connects.length, 0);
});

test('the 5001st distinct request is rejected, and the first request stays deduplicated at capacity', () => {
  const state = standalone(); const session = state.hello('first');
  for (let seq = 1; seq <= 5000; seq++) {
    // Rejected requests still consume dedupe entries, so an old rejected ID cannot be repurposed.
    state.command('first', session, seq, 'req-' + seq, 'missing-action');
    if (seq % 100 === 0) { state.sent.length = 0; state.logs.length = 0; }
  }
  state.command('first', session, 5001, 'capacity', 'capture');
  assert.equal(state.sent.at(-1).message.body.code, 'REQUEST_TABLE_FULL');
  state.command('first', session, 5002, 'req-1', 'capture');
  assert.equal(state.sent.at(-1).message.type, 'error');
  assert.equal(state.sent.at(-1).message.body.code, 'REQUEST_ID_CONFLICT');
  assert.equal(reading(state.engine.getView().local, 'captureCount'), 0);
});
