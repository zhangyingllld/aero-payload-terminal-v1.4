import { PayloadEngine } from '../../payload-app/entry/src/main/ets/core/engine.ts';
import { defaultConfig } from '../../payload-app/entry/src/main/ets/core/models.ts';
import { encodeMessage, parseMessage } from '../../payload-app/entry/src/main/ets/core/protocol.ts';

// Engines and serializers are real. Only the socket and monotonic clock are replaced.
export class Network {
  time = 1000; serial = 0; nodes = new Map(); queue = []; routes = new Map(); sent = []; blocked = new Set(); drop = () => false;
  add(role) {
    const config = defaultConfig(role); const id = config.nodeId;
    const engine = new PayloadEngine({
      now: () => this.time,
      send: (connectionId, message) => { const sent = { from: id, connectionId, message: structuredClone(message) }; this.sent.push(sent); this.queue.push(() => { const r = this.routes.get(id + ':' + connectionId); if (r && !this.blocked.has(id) && !this.blocked.has(r.id) && !this.drop(sent)) this.nodes.get(r.id).received(r.connectionId, parseMessage(encodeMessage(message))); }); },
      connect: peerId => this.queue.push(() => { if (!this.nodes.has(peerId)) { engine.closed('connect:' + peerId, 'refused'); return; } this.join(id, peerId); }),
      listen: () => {},
      close: connectionId => this.cut(id, connectionId),
      stop: () => { for (const key of [...this.routes.keys()]) if (key.startsWith(id + ':')) this.cut(id, key.slice(id.length + 1)); },
      changed: () => {}, log: () => {}
    });
    this.nodes.set(id, engine); engine.start(config); return engine;
  }
  join(from, to) {
    const a = 'c' + ++this.serial, b = 'c' + ++this.serial;
    this.routes.set(from + ':' + a, { id: to, connectionId: b }); this.routes.set(to + ':' + b, { id: from, connectionId: a });
    this.nodes.get(to).connected(b, '', true); this.nodes.get(from).connected(a, to, false);
  }
  cut(from, connectionId) {
    const key = from + ':' + connectionId; const r = this.routes.get(key); if (!r) return;
    this.routes.delete(key); this.routes.delete(r.id + ':' + r.connectionId);
    this.queue.push(() => { this.nodes.get(from).closed(connectionId, 'socket closed'); this.nodes.get(r.id).closed(r.connectionId, 'socket closed'); });
  }
  flush() { let guard = 0; while (this.queue.length) { if (++guard > 10000) throw Error('protocol loop'); this.queue.shift()(); } }
  advance(ms) { const end = this.time + ms; while (this.time < end) { this.time = Math.min(end, this.time + 250); for (const engine of this.nodes.values()) engine.tick(); this.flush(); } }
  complete() { this.advance(250); }
  five() { this.add('camera'); this.add('environment'); this.add('light'); this.add('controller'); this.add('observer'); this.flush(); return this; }
  engine(id) { return this.nodes.get(id); }
  view(id) { return this.engine(id).getView(); }
  payload(id, on = 'TERM-01') { return this.view(on).payloads.find(p => p.deviceId === id); }
  latest(from, type) { return this.sent.findLast(s => s.from === from && s.message.type === type); }
  injectDuplicate(sent, change = () => {}) {
    const r = this.routes.get(sent.from + ':' + sent.connectionId); const m = structuredClone(sent.message);
    m.seq = this.sent.filter(s => s.from === sent.from && s.connectionId === sent.connectionId).reduce((max, s) => Math.max(max, s.message.seq), 0) + 100;
    m.messageId += '-injected-' + m.seq; change(m); this.nodes.get(r.id).received(r.connectionId, m); this.flush();
  }
}
export const reading = (payload, id) => payload.readings.find(r => r.id === id)?.value;
