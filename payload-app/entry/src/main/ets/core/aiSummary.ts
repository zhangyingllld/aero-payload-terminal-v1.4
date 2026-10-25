import type { AppView, EventRecord, PayloadView, Value } from './models';

export interface AiReading { metric: string; value: Value; ageMs: number; }
export interface AiCommand { request: string; action: string; status: string; value: Value; }
export interface AiPayload { device: string; kind: string; link: string; readings: AiReading[]; command: AiCommand; }
export interface AiEvent { ref: string; device: string; kind: string; request: string; offsetMs: number; }
export interface AiWindow { included: number; omitted: number; }
export interface AiSummary { schemaVersion: number; simulated: boolean; role: string; window: AiWindow; payloads: AiPayload[]; events: AiEvent[]; }

const EVENT_KINDS: string[] = ['started', 'stopped', 'invalid-frame', 'protocol-error', 'connect-failed', 'offline', 'rejected-local', 'command', 'paused', 'resumed', 'simulation-fault', 'incompatible', 'connected', 'capacity', 'simulation-drop', 'unmatched-status', 'contradictory-status', 'accepted', 'completed', 'failed', 'rejected', 'unknown'];

function choice(value: string, allowed: string[], fallback: string): string { return allowed.indexOf(value) >= 0 ? value : fallback; }
function alias(value: string, values: string[], prefix: string): string {
  let index: number = values.indexOf(value);
  if (index < 0) { values.push(value); index = values.length - 1; }
  return prefix + (index + 1).toString();
}
function numeric(value: Value, low: number, high: number): boolean { return typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high; }
function validMetric(metric: string, value: Value): boolean {
  if (metric === 'mode') { return value === 'single' || value === 'continuous'; }
  if (metric === 'power') { return typeof value === 'boolean'; }
  if (metric === 'captureCount') { return numeric(value, 0, 1000000000) && Number.isInteger(value); }
  if (metric === 'brightness') { return numeric(value, 0, 100); }
  if (metric === 'interval') { return numeric(value, 1, 5); }
  if (metric === 'temperature' || metric === 'humidity') { return numeric(value, -1000000, 1000000); }
  return false;
}
function validAction(action: string, value: Value): boolean {
  if (action === 'capture' || action === 'set_power') { return typeof value === 'boolean'; }
  if (action === 'set_mode') { return validMetric('mode', value); }
  if (action === 'set_interval') { return validMetric('interval', value); }
  if (action === 'set_brightness') { return validMetric('brightness', value); }
  return false;
}

// Build a fresh allowlisted object: no network addresses, raw IDs, arbitrary labels/log strings, config or image bytes.
export function buildAiSummary(view: AppView): AiSummary {
  const safeRole: string = choice(view.config.role, ['controller', 'observer', 'camera', 'environment', 'light'], 'controller');
  if (!view.running) {
    return { schemaVersion: 1, simulated: true, role: safeRole,
      window: { included: 0, omitted: view.events.length }, payloads: [], events: [] };
  }
  const devices: string[] = []; const requests: string[] = [];
  const input: EventRecord[] = view.events;
  let start: number = 0;
  for (let i: number = input.length - 1; i >= 0; i--) {
    if (input[i].kind === 'started' && input[i].deviceId === view.config.nodeId) { start = i; break; }
  }
  const selected: EventRecord[] = input.slice(Math.max(start, input.length - 80));
  const base: number = selected.length > 0 ? Date.parse(selected[selected.length - 1].time) : 0;
  const events: AiEvent[] = [];
  for (let i: number = 0; i < selected.length; i++) {
    const event: EventRecord = selected[i]; const timestamp: number = Date.parse(event.time);
    events.push({ ref: 'E' + (i + 1).toString(), device: alias(event.deviceId, devices, 'D'),
      kind: choice(event.kind, EVENT_KINDS, 'other'), request: event.requestId ? alias(event.requestId, requests, 'R') : '',
      offsetMs: Number.isFinite(timestamp) && Number.isFinite(base) ? Math.max(-1000000000000, Math.min(0, timestamp - base)) : 0 });
  }
  const source: PayloadView[] = view.config.role === 'controller' || view.config.role === 'observer' ? view.payloads : [view.local];
  const payloads: AiPayload[] = [];
  for (const payload of source.slice(0, 5)) {
    if (!payload.deviceId || !payload.deviceId.trim()) { continue; }
    const readings: AiReading[] = [];
    for (const reading of payload.readings.slice(0, 32)) {
      if (validMetric(reading.id, reading.value) && Number.isFinite(reading.ageMs) && readings.length < 8) {
        readings.push({ metric: reading.id, value: reading.value, ageMs: Math.max(0, Math.min(1000000000000, reading.ageMs)) });
      }
    }
    const command: AiCommand = { request: payload.lastCommand.requestId ? alias(payload.lastCommand.requestId, requests, 'R') : '', action: '', status: '', value: '' };
    if (validAction(payload.lastCommand.actionId, payload.lastCommand.value)) {
      command.action = payload.lastCommand.actionId; command.value = payload.lastCommand.value;
      command.status = choice(payload.lastCommand.status, ['waiting', 'accepted', 'completed', 'failed', 'rejected', 'unknown'], '');
    }
    payloads.push({ device: alias(payload.deviceId, devices, 'D'), kind: choice(payload.capability.payloadType, ['camera', 'environment', 'lighting'], 'other'),
      link: choice(payload.linkState, ['DISCONNECTED', 'CONNECTING', 'NEGOTIATING', 'READY', 'STALE', 'OFFLINE', 'INCOMPATIBLE'], 'DISCONNECTED'), readings: readings, command: command });
  }
  return { schemaVersion: 1, simulated: true, role: safeRole,
    window: { included: events.length, omitted: input.length - events.length }, payloads: payloads, events: events };
}

export function hasAiEvidence(summary: AiSummary): boolean {
  if (summary.payloads.some((payload: AiPayload): boolean => payload.kind !== 'other' && (payload.readings.length > 0 || payload.command.action.length > 0))) { return true; }
  const useful: string[] = ['command', 'accepted', 'completed', 'failed', 'rejected', 'unknown', 'offline', 'connect-failed', 'protocol-error', 'incompatible', 'invalid-frame', 'paused', 'resumed', 'simulation-fault', 'simulation-drop'];
  return summary.events.some((event: AiEvent): boolean => useful.indexOf(event.kind) >= 0);
}
