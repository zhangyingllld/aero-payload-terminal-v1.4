import test from 'node:test';
import assert from 'node:assert/strict';
import { ByteFramer, encodeMessage, parseMessage } from '../../payload-app/entry/src/main/ets/core/protocol.ts';
import { capabilityForRole, validateCapability, validateActionValue } from '../../payload-app/entry/src/main/ets/core/capabilities.ts';

const hello = () => ({ protocolVersion: 1, type: 'hello', messageId: 'm1', sessionId: '', sourceId: 'TERM-01', targetId: 'CAM-01', seq: 0, requestId: '', sentAt: '2026-10-22T00:00:00.000Z', body: { role: 'controller', bootId: 'boot1' } });

test('framing retains a split Chinese UTF-8 code point and consumes coalesced messages', () => {
  const framer = new ByteFramer();
  const bytes = new TextEncoder().encode('图像\n环境\n');
  assert.equal(framer.push(bytes.slice(0, 1)).length, 0);
  const frames = framer.push(bytes.slice(1));
  assert.deepEqual(frames.map(b => new TextDecoder('utf-8', { fatal: true }).decode(b)), ['图像', '环境']);
  assert.equal(framer.push(new TextEncoder().encode('partial')).length, 0);
  framer.reset();
  assert.equal(framer.push(new Uint8Array([10]))[0].length, 0);
});

test('an unterminated oversized frame cannot grow memory indefinitely', () => {
  const framer = new ByteFramer();
  assert.throws(() => framer.push(new Uint8Array(65537)), /FRAME|BUFFER/);
  framer.reset();
  assert.equal(framer.push(new TextEncoder().encode('{}\n')).length, 1);
});

test('compact encoding round trips and malformed envelopes never reach engine', () => {
  const message = hello();
  assert.deepEqual(parseMessage(encodeMessage(message)), message);
  for (const bad of [null, [], {}, { ...message, protocolVersion: 2 }, { ...message, seq: -1 }, { ...message, sourceId: 12 }, { ...message, body: [] }, { ...message, type: 'script' }, { ...message, body: { role: 'camera', bootId: 5 } }]) {
    assert.throws(() => parseMessage(JSON.stringify(bad)));
  }
  assert.throws(() => parseMessage('{broken'));
  assert.throws(() => parseMessage(JSON.stringify({ ...message, body: { role: 'controller', bootId: 'b', nesting: { a: { b: { c: { d: { e: {} } } } } } } })), /DEPTH/);
});

test('all three simulated descriptors expose renderer data without a device-specific page', () => {
  for (const [role, id] of [['camera', 'CAM-01'], ['environment', 'ENV-01'], ['light', 'LIGHT-01']]) {
    const cap = validateCapability(capabilityForRole(role, id), id);
    assert.equal(cap.simulated, true);
    assert.ok(cap.metrics.length >= 2);
    assert.ok(cap.actions.length >= 1);
    for (const a of cap.actions) assert.ok(['button', 'switch', 'select', 'slider'].includes(a.control));
  }
});

test('descriptor validator rejects duplicate IDs, unsafe bindings, unsupported widgets and excessive payloads', () => {
  const good = capabilityForRole('light', 'LIGHT-01');
  const changes = [
    c => c.metrics.push({ ...c.metrics[0] }),
    c => c.actions.push({ ...c.actions[0] }),
    c => c.actions[0].boundMetricId = 'missing',
    c => c.actions[0].valueType = 'string',
    c => c.actions[1].step = 0,
    c => c.actions[1].max = -1,
    c => c.metrics[0].display = 'remote-script',
    c => c.metrics[0].validForMs = -1,
    c => c.deviceId = 'CAM-01',
    c => c.descriptorVersion = '2.0',
    c => c.name = 'a'.repeat(17000),
    c => c.actions[0].options = null
  ];
  for (const change of changes) {
    const c = structuredClone(good); change(c);
    assert.throws(() => validateCapability(c, 'LIGHT-01'));
  }
  const brightness = good.actions.find(a => a.id === 'set_brightness');
  assert.equal(validateActionValue(brightness, 100), true);
  for (const value of [-1, 101, 1.5, '40', false, NaN, Infinity]) assert.equal(validateActionValue(brightness, value), false);
});
