import type { Capability, EventRecord, PayloadView, Reading, Value } from './models';
import { isValue, utf8Length } from './capabilities';
export interface CommandArgs { value?: Value; }
export interface WireBody { role?: string; bootId?: string; capability?: Capability; deviceBootId?: string; stateRevision?: number; metrics?: Reading[]; actionId?: string; args?: CommandArgs; status?: string; code?: string; detail?: string; mainBootId?: string; snapshotRevision?: number; payloads?: PayloadView[]; event?: EventRecord; result?: Reading[]; }
export interface WireMessage { protocolVersion: number; type: string; messageId: string; sessionId: string; sourceId: string; targetId: string; seq: number; requestId: string; sentAt: string; body: WireBody; }
export class ByteFramer {
  private pending: number[] = [];
  push(chunk: Uint8Array): Uint8Array[] {
    const frames: Uint8Array[] = [];
    for (let i: number = 0; i < chunk.length; i++) {
      if (chunk[i] === 10) { frames.push(new Uint8Array(this.pending)); this.pending = []; }
      else {
        this.pending.push(chunk[i]);
        if (this.pending.length > 131072) { this.reset(); throw new Error('BUFFER_TOO_LARGE'); }
        if (this.pending.length > 65536) { this.reset(); throw new Error('FRAME_TOO_LARGE'); }
      }
    }
    return frames;
  }
  reset(): void { this.pending = []; }
}
function requireText(value: string, name: string, allowEmpty: boolean): void { if (typeof value !== 'string' || value.length > 256 || (!allowEmpty && value.length === 0)) throw new Error('INVALID_FRAME: ' + name); }
function objectDepth(text: string): void {
  let depth: number = 0; let quoted: boolean = false; let escaped: boolean = false;
  for (let i: number = 0; i < text.length; i++) {
    const char: string = text.charAt(i);
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
    else if (char === '"') quoted = true;
    else if (char === '{') { depth++; if (depth > 6) throw new Error('MAX_OBJECT_DEPTH'); }
    else if (char === '}') depth--;
  }
}
export function validateReadings(metrics: Reading[]): void {
  if (!Array.isArray(metrics) || metrics.length > 32) throw new Error('INVALID_FRAME: metrics');
  const ids: Set<string> = new Set<string>();
  for (const r of metrics) {
    if (!r || typeof r !== 'object') throw new Error('INVALID_FRAME: reading');
    requireText(r.id, 'reading.id', false);
    if (ids.has(r.id) || !isValue(r.value) || !Number.isFinite(r.ageMs) || r.ageMs < 0) throw new Error('INVALID_FRAME: reading');
    ids.add(r.id);
  }
}
export function parseMessage(text: string): WireMessage {
  if (utf8Length(text.trimEnd()) > 65536) throw new Error('FRAME_TOO_LARGE');
  objectDepth(text);
  const m: WireMessage = JSON.parse(text) as WireMessage;
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('INVALID_FRAME: envelope');
  if (m.protocolVersion !== 1) throw new Error('UNSUPPORTED_VERSION');
  if (['hello', 'helloAck', 'capability', 'snapshot', 'telemetry', 'command', 'commandStatus', 'event', 'heartbeat', 'error'].indexOf(m.type) < 0) throw new Error('INVALID_FRAME: type');
  requireText(m.messageId, 'messageId', false); requireText(m.sessionId, 'sessionId', m.type === 'hello' || m.type === 'error');
  requireText(m.sourceId, 'sourceId', false); requireText(m.targetId, 'targetId', false); requireText(m.sentAt, 'sentAt', false);
  if (!Number.isFinite(Date.parse(m.sentAt))) throw new Error('INVALID_FRAME: sentAt');
  if (m.requestId === undefined && m.type !== 'command' && m.type !== 'commandStatus') m.requestId = '';
  requireText(m.requestId, 'requestId', m.type !== 'command' && m.type !== 'commandStatus');
  if (!Number.isInteger(m.seq) || m.seq < (m.type === 'hello' ? 0 : 1)) throw new Error('INVALID_FRAME: seq');
  if (!m.body || typeof m.body !== 'object' || Array.isArray(m.body)) throw new Error('INVALID_FRAME: body');
  const b: WireBody = m.body;
  if (m.type === 'hello' || m.type === 'helloAck') {
    if (typeof b.role !== 'string' || ['controller', 'observer', 'camera', 'environment', 'light'].indexOf(b.role) < 0) throw new Error('INVALID_FRAME: role');
    requireText(b.bootId as string, 'bootId', false);
  }
  if (m.type === 'command') { requireText(b.actionId as string, 'actionId', false); if (!b.args || typeof b.args !== 'object' || Array.isArray(b.args)) throw new Error('INVALID_FRAME: args'); if (b.args.value !== undefined && !isValue(b.args.value)) throw new Error('INVALID_FRAME: value'); }
  if (m.type === 'commandStatus') { if (typeof b.status !== 'string' || ['accepted', 'completed', 'failed', 'rejected'].indexOf(b.status) < 0) throw new Error('INVALID_FRAME: status'); }
  if (m.type === 'error' || m.type === 'commandStatus') { requireText(b.code as string, 'code', false); requireText(b.detail as string, 'detail', true); }
  if (b.stateRevision !== undefined && (!Number.isInteger(b.stateRevision) || b.stateRevision < 0)) throw new Error('INVALID_FRAME: stateRevision');
  if (b.metrics !== undefined) validateReadings(b.metrics);
  if (b.result !== undefined) validateReadings(b.result);
  if (m.type === 'capability' && (!b.capability || typeof b.capability !== 'object' || Array.isArray(b.capability))) throw new Error('INVALID_FRAME: capability');
  if (m.type === 'snapshot' || m.type === 'telemetry') {
    if (b.payloads !== undefined) { if (!Array.isArray(b.payloads) || b.payloads.length > 16 || !Number.isInteger(b.snapshotRevision) || (b.snapshotRevision as number) < 0) throw new Error('INVALID_FRAME: payloads'); requireText(b.mainBootId as string, 'mainBootId', false); }
    else { requireText(b.deviceBootId as string, 'deviceBootId', false); if (b.metrics === undefined || b.stateRevision === undefined) throw new Error('INVALID_FRAME: snapshot'); }
  }
  if (m.type === 'event' && (!b.event || typeof b.event !== 'object' || Array.isArray(b.event))) throw new Error('INVALID_FRAME: event');
  return m;
}
export function encodeMessage(message: WireMessage): string { return JSON.stringify(message) + '\n'; }
