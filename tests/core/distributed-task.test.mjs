import test from 'node:test';
import assert from 'node:assert/strict';
import { TrialBook, parseTrialRecord, trialKey, feedbackKey, newTrial, reviseTrial, makeFeedback } from '../../payload-app/entry/src/main/ets/core/distributedTask.ts';

const owner = 'device-owner-1234';
const member = 'device-member-5678';
const now = 1792800000000;
function task(overrides = {}) {
  return { schema: 1, kind: 'task', group: 'A-E', creatorId: owner, sessionId: 'trial-001', revision: 1,
    title: '载荷地面协同试验', createdAt: now, updatedAt: now, ...overrides };
}
function ack(t, overrides = {}) {
  return { schema: 1, kind: 'ready', group: t.group, creatorId: t.creatorId, sessionId: t.sessionId,
    revision: t.revision, memberId: member, role: 'observer', nodeId: 'VIEW-01', ready: true,
    sequence: 1, updatedAt: now + 1000, ...overrides };
}
function ingest(book, value) {
  return book.accept(value.kind === 'task' ? trialKey(value) : feedbackKey(value), JSON.stringify(value));
}

test('malformed and oversized data cannot enter the task book or bypass key ownership', () => {
  const t = task();
  for (const text of ['{', 'null', '[]', '"text"', ' '.repeat(9000)]) {
    assert.throws(() => parseTrialRecord(trialKey(t), text));
  }
  for (const broken of [task({ title: 'a'.repeat(81) }), task({ title: '' }), task({ revision: 0 }),
    task({ group: '../another' }), task({ createdAt: 'today' }), task({ creatorId: '' })]) {
    assert.throws(() => parseTrialRecord(trialKey(t), JSON.stringify(broken)));
  }
  assert.throws(() => parseTrialRecord(trialKey(t), JSON.stringify(task({ creatorId: member }))));
  assert.throws(() => parseTrialRecord(feedbackKey(ack(t)), JSON.stringify(ack(t, { ready: 'yes' }))));
});

test('only the main operator creates a task, and input is validated rather than silently truncated', () => {
  assert.throws(() => newTrial('observer', owner, 'A-E', '试验', 'trial-001', now));
  assert.throws(() => newTrial('controller', owner, 'A-E', 'a'.repeat(81), 'trial-001', now));
  const t = newTrial('controller', owner, ' A-E ', '  试验  ', 'trial-001', now);
  assert.equal(t.title, '试验');
  assert.equal(t.group, 'A-E');
});

test('same revision cannot silently replace task content, and another creator has an independent task', () => {
  const book = new TrialBook(); const t = task();
  assert.equal(ingest(book, t), true);
  assert.equal(ingest(book, t), false);
  assert.throws(() => ingest(book, task({ title: '替换内容' })));
  ingest(book, task({ creatorId: member }));
  assert.equal(book.tasks().length, 2);
});

test('another device cannot revise an owner task, and a valid revision keeps the original session', () => {
  const t = task();
  assert.throws(() => reviseTrial(t, 'controller', member, '越权修改', now + 2000));
  assert.throws(() => reviseTrial(t, 'observer', owner, '角色越权', now + 2000));
  const revised = reviseTrial(t, 'controller', owner, '增加准备检查', now + 2000);
  assert.equal(revised.sessionId, 'trial-001');
  assert.equal(revised.creatorId, owner);
  assert.equal(revised.revision, 2);
  assert.equal(revised.createdAt, now);
  assert.equal(revised.updatedAt, now + 2000);
});

test('prepared members are tied to exact task and revision, not role name or a previous session', () => {
  const book = new TrialBook(); const t = task(); ingest(book, t);
  ingest(book, ack(t));
  ingest(book, ack(t, { memberId: 'device-other-9012', nodeId: 'VIEW-01' }));
  assert.equal(book.feedbackFor(t).length, 2);
  const revised = task({ revision: 2, title: '修订后的试验', updatedAt: now + 2000 });
  ingest(book, revised);
  assert.equal(book.feedbackFor(revised).length, 0);
  assert.equal(book.feedbackFor(task({ sessionId: 'trial-002' })).length, 0);
});

test('a delayed ready feedback cannot override a later cancellation or conflict at the same sequence', () => {
  const book = new TrialBook(); const t = task(); ingest(book, t);
  ingest(book, ack(t, { sequence: 2, ready: false, updatedAt: now + 3000 }));
  assert.equal(ingest(book, ack(t)), false);
  assert.equal(book.feedbackFor(t)[0].ready, false);
  assert.throws(() => ingest(book, ack(t, { sequence: 2, ready: true, updatedAt: now + 3000 })));
});

test('read-only observer can confirm task readiness without becoming a controller', () => {
  const result = makeFeedback(task(), member, 'observer', 'VIEW-01', true, 0, now + 1000);
  assert.equal(result.role, 'observer');
  assert.equal(result.sequence, 1);
  assert.equal(result.kind, 'ready');
  assert.equal(result.ready, true);
  assert.equal('command' in result, false);
});

test('history is bounded and old feedback never counts against a different task', () => {
  const book = new TrialBook();
  for (let i = 1; i <= 25; i++) ingest(book, task({ sessionId: 'trial-' + i, createdAt: now + i, updatedAt: now + i }));
  assert.equal(book.tasks().length, 20);
  assert.equal(book.tasks()[0].sessionId, 'trial-25');
  assert.equal(book.tasks().some(t => t.sessionId === 'trial-1'), false);
  ingest(book, ack(task({ sessionId: 'trial-1' })));
  assert.equal(book.feedbackFor(book.tasks()[0]).length, 0);
});

test('callers cannot mutate accepted task or feedback through returned view objects', () => {
  const book = new TrialBook(); const t = task(); ingest(book, t); ingest(book, ack(t));
  book.tasks()[0].title = '被改动';
  book.feedbackFor(t)[0].ready = false;
  assert.equal(book.tasks()[0].title, '载荷地面协同试验');
  assert.equal(book.feedbackFor(t)[0].ready, true);
});

test('latest revision is scoped to creator, group and session, not the last arrival or clock', () => {
  const book = new TrialBook(); const t = task(); ingest(book, t);
  const latest = task({ revision: 3, title: '新版', updatedAt: now + 1000 });
  ingest(book, latest);
  ingest(book, task({ revision: 2, updatedAt: now + 2000 }));
  ingest(book, task({ creatorId: member, revision: 9 }));
  assert.equal(book.latestFor(t).revision, 3);
  assert.equal(book.isLatest(t), false);
  assert.equal(book.isLatest(latest), true);
  book.latestFor(t).title = '外部修改';
  assert.equal(book.latestFor(t).title, '新版');
});

test('self-reported feedback must have a consistent role and configured node ID', () => {
  const t = task();
  for (const mismatch of [{ role: 'controller', nodeId: 'VIEW-01' }, { role: 'observer', nodeId: 'CAM-01' },
    { role: 'camera', nodeId: 'ENV-01' }, { role: 'light', nodeId: 'LIGHT-02' }, { role: 'environment', nodeId: 'TERM-01' }]) {
    const feedback = ack(t, mismatch);
    assert.throws(() => parseTrialRecord(feedbackKey(feedback), JSON.stringify(feedback)));
  }
  for (const [role, nodeId] of [['controller', 'TERM-01'], ['observer', 'VIEW-01'], ['camera', 'CAM-01'],
    ['environment', 'ENV-01'], ['light', 'LIGHT-01']]) {
    assert.equal(makeFeedback(t, member, role, nodeId, true, 0, now).role, role);
  }
});
