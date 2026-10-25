import type { Role } from './models';

export interface TrialTask {
  schema: number; kind: string; group: string; creatorId: string; sessionId: string;
  revision: number; title: string; createdAt: number; updatedAt: number;
}
export interface TrialFeedback {
  schema: number; kind: string; group: string; creatorId: string; sessionId: string;
  revision: number; memberId: string; role: string; nodeId: string; ready: boolean;
  sequence: number; updatedAt: number;
}
export type TrialRecord = TrialTask | TrialFeedback;

function text(value: string, max: number): boolean {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}
function id(value: string): boolean { return text(value, 160) && /^[A-Za-z0-9_.:-]+$/.test(value); }
function timestamp(value: number): boolean { return Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000; }
function revision(value: number): boolean { return Number.isSafeInteger(value) && value >= 1 && value <= 1000000; }
function roleNodeMatches(role: string, nodeId: string): boolean {
  return (role === 'controller' && nodeId === 'TERM-01') || (role === 'observer' && nodeId === 'VIEW-01') ||
    (role === 'camera' && nodeId === 'CAM-01') || (role === 'environment' && nodeId === 'ENV-01') ||
    (role === 'light' && nodeId === 'LIGHT-01');
}
export function sameTrialSession(a: TrialTask, b: TrialTask): boolean {
  return a.group === b.group && a.creatorId === b.creatorId && a.sessionId === b.sessionId;
}
function commonValid(value: TrialRecord): boolean {
  return value.schema === 1 && text(value.group, 24) && /^[A-Za-z0-9_-]+$/.test(value.group) &&
    id(value.creatorId) && id(value.sessionId) && revision(value.revision) && timestamp(value.updatedAt);
}
export function trialKey(value: TrialTask): string {
  return 'trial/task/' + value.group + '/' + value.creatorId + '/' + value.sessionId + '/' + value.revision;
}
export function feedbackKey(value: TrialFeedback): string {
  return 'trial/ready/' + value.group + '/' + value.creatorId + '/' + value.sessionId + '/' + value.revision + '/' + value.memberId;
}
function copyTask(t: TrialTask): TrialTask {
  return { schema: 1, kind: 'task', group: t.group, creatorId: t.creatorId, sessionId: t.sessionId,
    revision: t.revision, title: t.title, createdAt: t.createdAt, updatedAt: t.updatedAt };
}
function copyFeedback(f: TrialFeedback): TrialFeedback {
  return { schema: 1, kind: 'ready', group: f.group, creatorId: f.creatorId, sessionId: f.sessionId,
    revision: f.revision, memberId: f.memberId, role: f.role, nodeId: f.nodeId, ready: f.ready,
    sequence: f.sequence, updatedAt: f.updatedAt };
}
export function parseTrialRecord(key: string, serialized: string): TrialRecord {
  if (typeof key !== 'string' || key.length > 512 || typeof serialized !== 'string' || serialized.length > 8192) {
    throw new Error('记录长度超过限制');
  }
  const value: TrialRecord = JSON.parse(serialized) as TrialRecord;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !commonValid(value)) throw new Error('试验记录格式无效');
  if (value.kind === 'task') {
    const task: TrialTask = value as TrialTask;
    if (!text(task.title, 80) || !timestamp(task.createdAt) || task.updatedAt < task.createdAt || key !== trialKey(task)) {
      throw new Error('任务字段或创建者键不匹配');
    }
    return copyTask(task);
  }
  if (value.kind === 'ready') {
    const feedback: TrialFeedback = value as TrialFeedback;
    if (!id(feedback.memberId) || !roleNodeMatches(feedback.role, feedback.nodeId) ||
      typeof feedback.ready !== 'boolean' || !revision(feedback.sequence) || key !== feedbackKey(feedback)) {
      throw new Error('成员反馈字段或设备键不匹配');
    }
    return copyFeedback(feedback);
  }
  throw new Error('不支持的试验记录类型');
}
export function newTrial(role: Role, creatorId: string, group: string, title: string, sessionId: string, now: number): TrialTask {
  if (role !== 'controller') throw new Error('仅主操作端可以新建试验任务');
  const task: TrialTask = { schema: 1, kind: 'task', group: group.trim(), creatorId: creatorId,
    sessionId: sessionId, revision: 1, title: title.trim(), createdAt: now, updatedAt: now };
  return parseTrialRecord(trialKey(task), JSON.stringify(task)) as TrialTask;
}
export function reviseTrial(task: TrialTask, role: Role, localId: string, title: string, now: number): TrialTask {
  if (role !== 'controller' || task.creatorId !== localId) throw new Error('只能修订本机创建的任务');
  const revised: TrialTask = copyTask(task);
  revised.revision++;
  revised.title = title.trim();
  revised.updatedAt = now;
  return parseTrialRecord(trialKey(revised), JSON.stringify(revised)) as TrialTask;
}
export function makeFeedback(task: TrialTask, memberId: string, role: Role, nodeId: string, ready: boolean,
  previousSequence: number, now: number): TrialFeedback {
  parseTrialRecord(trialKey(task), JSON.stringify(task));
  if (!Number.isSafeInteger(previousSequence) || previousSequence < 0) throw new Error('反馈序号无效');
  const feedback: TrialFeedback = { schema: 1, kind: 'ready', group: task.group, creatorId: task.creatorId,
    sessionId: task.sessionId, revision: task.revision, memberId: memberId, role: role, nodeId: nodeId,
    ready: ready, sequence: previousSequence + 1, updatedAt: now };
  return parseTrialRecord(feedbackKey(feedback), JSON.stringify(feedback)) as TrialFeedback;
}

// Keys separate declared creators, sessions, revisions and members; this is not an identity proof.
// Records are self-reported by paired same-app participants. No record here is a payload command.
export class TrialBook {
  private taskRecords: TrialTask[] = [];
  private feedbackRecords: TrialFeedback[] = [];

  accept(key: string, serialized: string): boolean {
    const value = parseTrialRecord(key, serialized);
    if (value.kind === 'task') {
      const task = value as TrialTask;
      const existing = this.taskRecords.find((item: TrialTask) => trialKey(item) === key);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(task)) throw new Error('同一任务版本内容冲突，已保留原记录');
        return false;
      }
      this.taskRecords.push(task);
      this.taskRecords.sort((a: TrialTask, b: TrialTask) => b.updatedAt - a.updatedAt || b.revision - a.revision || trialKey(a).localeCompare(trialKey(b)));
      this.taskRecords = this.taskRecords.slice(0, 20);
      return true;
    }
    const feedback = value as TrialFeedback;
    const oldIndex = this.feedbackRecords.findIndex((item: TrialFeedback) => feedbackKey(item) === key);
    if (oldIndex >= 0) {
      const old = this.feedbackRecords[oldIndex];
      if (feedback.sequence < old.sequence) return false;
      if (feedback.sequence === old.sequence) {
        if (JSON.stringify(old) !== JSON.stringify(feedback)) throw new Error('同序号反馈冲突，已保留原记录');
        return false;
      }
      this.feedbackRecords[oldIndex] = feedback;
    } else { this.feedbackRecords.push(feedback); }
    this.feedbackRecords.sort((a: TrialFeedback, b: TrialFeedback) => b.updatedAt - a.updatedAt);
    this.feedbackRecords = this.feedbackRecords.slice(0, 200);
    return true;
  }
  tasks(): TrialTask[] { return this.taskRecords.map((task: TrialTask) => copyTask(task)); }
  latestFor(task: TrialTask): TrialTask | undefined {
    const versions = this.taskRecords.filter((item: TrialTask) => sameTrialSession(item, task));
    versions.sort((a: TrialTask, b: TrialTask) => b.revision - a.revision);
    return versions.length > 0 ? copyTask(versions[0]) : undefined;
  }
  isLatest(task: TrialTask): boolean {
    const latest = this.latestFor(task);
    return latest !== undefined && latest.revision === task.revision;
  }
  feedbackFor(task: TrialTask): TrialFeedback[] {
    return this.feedbackRecords.filter((item: TrialFeedback) => item.group === task.group && item.creatorId === task.creatorId &&
      item.sessionId === task.sessionId && item.revision === task.revision).map((item: TrialFeedback) => copyFeedback(item));
  }
}
