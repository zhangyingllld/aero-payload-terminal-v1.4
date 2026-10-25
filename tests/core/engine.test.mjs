import test from 'node:test';
import assert from 'node:assert/strict';
import { Network, reading } from './network.mjs';

test('five nodes negotiate independently and observer receives all descriptor-generated controls', () => {
  const n = new Network().five();
  assert.equal(n.view('TERM-01').payloads.length, 3);
  for (const id of ['CAM-01', 'ENV-01', 'LIGHT-01']) {
    assert.equal(n.payload(id).linkState, 'READY');
    assert.equal(n.payload(id, 'VIEW-01').linkState, 'READY');
    assert.deepEqual(n.payload(id, 'VIEW-01').capability, n.payload(id).capability);
  }
  assert.equal(n.view('VIEW-01').mainLinkState, 'READY');
  n.engine('TERM-01').command('LIGHT-01', 'set_brightness', 40); n.flush();
  assert.equal(n.payload('LIGHT-01').lastCommand.status, 'accepted');
  assert.equal(reading(n.payload('LIGHT-01'), 'brightness'), 0);
  n.complete();
  assert.equal(n.payload('LIGHT-01').lastCommand.status, 'completed');
  assert.equal(reading(n.payload('LIGHT-01'), 'brightness'), 40);
  n.advance(1000);
  assert.equal(reading(n.payload('LIGHT-01', 'VIEW-01'), 'brightness'), 40);
});

test('observer command is denied by controller protocol, even with a manually constructed wire command', () => {
  const n = new Network().five();
  const hello = n.latest('VIEW-01', 'hello');
  const ack = n.sent.find(s => s.from === 'TERM-01' && s.message.type === 'helloAck');
  const original = structuredClone(hello);
  original.message.type = 'command'; original.message.sessionId = ack.message.sessionId;
  original.message.requestId = 'evil-1'; original.message.body = { actionId: 'set_power', args: { value: true } };
  n.injectDuplicate(original);
  const error = n.latest('TERM-01', 'error').message;
  assert.equal(error.body.code, 'FORBIDDEN_ROLE');
  assert.equal(reading(n.view('LIGHT-01').local, 'power'), false);
  n.engine('VIEW-01').command('LIGHT-01', 'set_power', true);
  assert.match(n.view('VIEW-01').error, /只读|FORBIDDEN_ROLE/);
});

test('same request returns cached result and conflicting reuse is an error without contradictory terminal state', () => {
  const n = new Network().five();
  n.engine('TERM-01').command('CAM-01', 'capture', true); n.flush(); n.complete();
  const sent = n.latest('TERM-01', 'command');
  assert.equal(reading(n.view('CAM-01').local, 'captureCount'), 1);
  n.injectDuplicate(sent);
  assert.equal(reading(n.view('CAM-01').local, 'captureCount'), 1);
  n.injectDuplicate(sent, m => { m.seq += 1; m.body.actionId = 'set_mode'; m.body.args.value = 'continuous'; });
  assert.equal(n.latest('CAM-01', 'error').message.body.code, 'REQUEST_ID_CONFLICT');
  assert.equal(n.payload('CAM-01').lastCommand.status, 'completed');
  assert.equal(n.view('CAM-01').local.lastCommand.status, 'completed');
});

test('simulation rejects, fails, and drops only the next final reply without optimistic state updates', () => {
  const n = new Network().five(); const ctl = n.engine('TERM-01'); const light = n.engine('LIGHT-01');
  light.setFault('reject-next'); ctl.command('LIGHT-01', 'set_power', true); n.flush();
  assert.equal(n.payload('LIGHT-01').lastCommand.status, 'rejected'); assert.equal(reading(light.getView().local, 'power'), false);
  light.setFault('fail-next'); ctl.command('LIGHT-01', 'set_power', true); n.flush(); n.complete();
  assert.equal(n.payload('LIGHT-01').lastCommand.status, 'failed'); assert.equal(reading(light.getView().local, 'power'), false);
  light.setFault('drop-next-result'); ctl.command('LIGHT-01', 'set_power', true); n.flush(); n.complete();
  assert.equal(n.payload('LIGHT-01').lastCommand.status, 'accepted'); assert.equal(reading(light.getView().local, 'power'), true);
  n.advance(4750);
  assert.equal(n.payload('LIGHT-01').lastCommand.status, 'unknown');
  assert.equal(n.payload('LIGHT-01').linkState, 'READY');
});

test('silence marks stale at 3 seconds and offline at 6 while other payloads continue', () => {
  const n = new Network().five(); n.engine('CAM-01').setPaused(true);
  n.advance(3000); assert.equal(n.payload('CAM-01').linkState, 'STALE');
  assert.equal(n.payload('LIGHT-01').linkState, 'READY');
  n.advance(3000); assert.equal(n.payload('CAM-01').linkState, 'OFFLINE');
  assert.notEqual(n.payload('CAM-01', 'VIEW-01').linkState, 'READY');
});

test('reconnect establishes a new session and never replays an unresolved capture', () => {
  const n = new Network().five(); const camera = n.engine('CAM-01');
  camera.setFault('drop-next-result'); n.engine('TERM-01').command('CAM-01', 'capture', true); n.flush(); n.complete();
  const sent = n.latest('TERM-01', 'command'); const oldSession = sent.message.sessionId;
  n.cut(sent.from, sent.connectionId); n.flush();
  assert.equal(n.payload('CAM-01').lastCommand.status, 'unknown');
  n.advance(2000);
  assert.equal(n.payload('CAM-01').linkState, 'READY');
  assert.notEqual(n.latest('CAM-01', 'helloAck').message.sessionId, oldSession);
  assert.equal(n.sent.filter(s => s.from === 'TERM-01' && s.message.type === 'command').length, 1);
  assert.equal(reading(camera.getView().local, 'captureCount'), 1);
  assert.equal(n.payload('CAM-01').lastCommand.status, 'unknown');
});

test('old session and old sequence messages cannot mutate the payload', () => {
  const n = new Network().five(); n.engine('TERM-01').command('LIGHT-01', 'set_power', true); n.flush(); n.complete();
  const sent = n.latest('TERM-01', 'command');
  n.injectDuplicate(sent, m => { m.sessionId = 'old-session'; m.body.args.value = false; m.requestId = 'old'; });
  assert.equal(reading(n.view('LIGHT-01').local, 'power'), true);
  assert.equal(n.latest('LIGHT-01', 'error').message.body.code, 'STALE_SESSION');
});

test('heartbeat alone does not refresh telemetry and disconnected upstream makes observer data stale', () => {
  const n = new Network().five(); const before = n.payload('ENV-01').readings[0].ageMs;
  const original = n.engine('ENV-01'); original.setPaused(true);
  n.advance(3250);
  assert.ok(n.payload('ENV-01').readings[0].ageMs >= before + 3250);
  const upstream = n.latest('VIEW-01', 'hello'); n.cut('VIEW-01', upstream.connectionId); n.flush();
  assert.equal(n.view('VIEW-01').mainLinkState, 'OFFLINE');
  assert.ok(n.view('VIEW-01').payloads.every(p => p.linkState !== 'READY'));
});

test('event restoration is bounded and cannot resurrect online payload state', () => {
  const n = new Network(); const ctl = n.add('controller');
  ctl.restoreEvents(Array.from({ length: 10020 }, (_, i) => ({ id: 'e' + i, time: '2026-10-22T00:00:00.000Z', deviceId: 'CAM-01', kind: 'completed', detail: 'history', requestId: '' })));
  assert.equal(ctl.getView().events.length, 10000);
  assert.equal(ctl.getView().events[0].id, 'e20');
  assert.ok(ctl.getView().payloads.every(p => p.linkState !== 'READY'));
});

test('valid heartbeats preserve link readiness but cannot make old telemetry fresh', () => {
  const n = new Network().five();
  // Replace environmental telemetry with heartbeats on the same real protocol path.
  n.drop = s => s.from === 'ENV-01' && s.message.type === 'telemetry';
  const envConnection = n.latest('ENV-01', 'snapshot');
  for (let i = 0; i < 16; i++) {
    n.advance(1000);
    const latest = n.sent.findLast(s => s.from === 'ENV-01' && s.connectionId === envConnection.connectionId);
    const route = n.routes.get('ENV-01:' + latest.connectionId);
    const heartbeat = structuredClone(latest.message); heartbeat.type = 'heartbeat'; heartbeat.body = {};
    n.engine(route.id).received(route.connectionId, heartbeat);
    n.flush();
  }
  assert.equal(n.payload('ENV-01').linkState, 'READY');
  assert.ok(n.payload('ENV-01').readings[0].ageMs >= 16000);
  n.engine('TERM-01').command('ENV-01', 'set_interval', 2);
  assert.match(n.view('TERM-01').error, /过期/);
});

test('accepted request cannot become rejected and late matching final reply resolves unknown', () => {
  const n = new Network().five();
  n.engine('CAM-01').setFault('drop-next-result'); n.engine('TERM-01').command('CAM-01', 'capture', true); n.flush();
  const accepted = n.latest('CAM-01', 'commandStatus');
  n.injectDuplicate(accepted, m => { m.body.status = 'rejected'; m.body.code = 'BAD'; });
  assert.equal(n.payload('CAM-01').lastCommand.status, 'accepted');
  n.advance(5000);
  assert.equal(n.payload('CAM-01').lastCommand.status, 'unknown');
  n.injectDuplicate(accepted, m => { m.seq += 1; m.body.status = 'completed'; m.body.code = 'OK'; });
  assert.equal(n.payload('CAM-01').lastCommand.status, 'completed');
  assert.match(n.payload('CAM-01').lastCommand.detail, /迟到/);
});

test('out-of-range bound state does not replace valid telemetry', () => {
  const n = new Network().five(); const snapshot = n.latest('LIGHT-01', 'snapshot');
  n.injectDuplicate(snapshot, m => { m.body.stateRevision += 1; m.body.metrics.find(r => r.id === 'brightness').value = 101; });
  assert.equal(reading(n.payload('LIGHT-01'), 'brightness'), 0);
});

test('initial stale snapshot never enables controls before fresh state arrives', () => {
  const n = new Network(); n.drop = s => s.from === 'CAM-01' && s.message.type === 'snapshot'; n.five();
  const snapshot = n.latest('CAM-01', 'snapshot');
  n.injectDuplicate(snapshot, m => { for (const r of m.body.metrics) r.ageMs = 10001; });
  assert.equal(n.payload('CAM-01').linkState, 'NEGOTIATING');
});

test('a late final reply for an older unknown request updates history without replacing the newest command card', () => {
  const n = new Network().five(); const controller = n.engine('TERM-01');
  n.engine('CAM-01').setFault('drop-next-result'); controller.command('CAM-01', 'capture', true); n.flush();
  const oldAccepted = n.latest('CAM-01', 'commandStatus'); const oldId = oldAccepted.message.requestId;
  n.advance(5000); assert.equal(n.payload('CAM-01').lastCommand.status, 'unknown');
  controller.command('CAM-01', 'capture', true); n.flush();
  const newestId = n.payload('CAM-01').lastCommand.requestId;
  assert.notEqual(newestId, oldId); assert.equal(n.payload('CAM-01').lastCommand.status, 'accepted');
  n.injectDuplicate(oldAccepted, m => { m.body.status = 'completed'; m.body.code = 'OK'; });
  assert.ok(n.view('TERM-01').events.some(e => e.requestId === oldId && e.kind === 'completed' && e.detail.includes('迟到')));
  assert.equal(n.view('TERM-01').events.some(e => e.requestId === oldId && e.kind === 'unmatched-status'), false);
  assert.equal(n.payload('CAM-01').lastCommand.requestId, newestId);
  assert.equal(n.payload('CAM-01').lastCommand.status, 'accepted');
});

test('unresolved request capacity rejects new control, retains old requests, and releases a slot after a late final reply', () => {
  const n = new Network(); const camera = n.add('camera'); const controller = n.add('controller'); n.flush();
  let firstAccepted;
  for (let i = 0; i < 128; i++) {
    camera.setFault('drop-next-result'); controller.command('CAM-01', 'capture', true); n.flush();
    if (i === 0) firstAccepted = n.latest('CAM-01', 'commandStatus');
    n.time += 5000; camera.tick(); controller.tick(); n.flush();
    assert.equal(n.payload('CAM-01').lastCommand.status, 'unknown');
  }
  const count = n.sent.filter(s => s.from === 'TERM-01' && s.message.type === 'command').length;
  controller.command('CAM-01', 'capture', true); n.flush();
  assert.match(n.view('TERM-01').error, /PENDING_TABLE_FULL/);
  assert.equal(n.sent.filter(s => s.from === 'TERM-01' && s.message.type === 'command').length, count);
  assert.equal(n.payload('CAM-01').lastCommand.status, 'unknown');
  n.injectDuplicate(firstAccepted, m => { m.body.status = 'completed'; m.body.code = 'OK'; });
  assert.ok(n.view('TERM-01').events.some(e => e.requestId === firstAccepted.message.requestId && e.kind === 'completed'));
  controller.command('CAM-01', 'capture', true); n.flush();
  assert.equal(n.sent.filter(s => s.from === 'TERM-01' && s.message.type === 'command').length, count + 1);
});
