import type { ActionSpec, AppConfig, AppView, Capability, CommandRecord, EventRecord, MetricSpec, PayloadView, Reading, Value } from './models';
import type { WireBody, WireMessage } from './protocol';
import { defaultConfig, emptyPayload, initialView } from './models';
import { capabilityForRole, validateActionValue, validateCapability } from './capabilities';
import { encodeMessage, parseMessage, validateReadings } from './protocol';
export interface EngineIO { now(): number; send(connectionId: string, message: WireMessage): void; connect(peerId: string, host: string, port: number): void; listen(port: number): void; close(connectionId: string): void; stop(): void; changed(view: AppView): void; log(event: EventRecord): void; }
interface Connection { id: string; peerId: string; peerRole: string; peerBoot: string; inbound: boolean; session: string; rxSeq: number; txSeq: number; lastRx: number; lastTx: number; hasCapability: boolean; hasSnapshot: boolean; ready: boolean; invalid: number; incompatible: boolean; closeAt: number; }
interface Peer { id: string; host: string; port: number; retryAt: number; attempt: number; connecting: boolean; blocked: boolean; }
interface PendingCommand { record: CommandRecord; connectionId: string; session: string; sentAt: number; accepted: boolean; }
interface ExecutedRequest { sourceId: string; requestId: string; actionId: string; value: Value; status: string; code: string; detail: string; revision: number; result: Reading[]; }
interface Execution { request: ExecutedRequest; connectionId: string; session: string; due: number; fault: string; }

// The runtime supplies a monotonic local clock. No remote wall clock drives deadlines.
// Connections and commands are deliberately separate: reconnect never replays a command.
export class PayloadEngine {
  private io: EngineIO;
  private view: AppView = initialView();
  private connections: Map<string, Connection> = new Map<string, Connection>();
  private peers: Peer[] = [];
  private pending: Map<string, PendingCommand> = new Map<string, PendingCommand>();
  private requests: Map<string, ExecutedRequest> = new Map<string, ExecutedRequest>();
  private execution: Execution | undefined = undefined;
  private bootId: string = '';
  private serial: number = 0;
  private requestSerial: number = 0;
  private lastAgeAt: number = 0;
  private lastSampleAt: number = 0;
  private lastAggregateAt: number = 0;
  private aggregateRevision: number = 0;
  private receivedAggregateRevision: number = -1;
  private sampleIndex: number = 0;
  constructor(io: EngineIO) { this.io = io; }

  start(config: AppConfig): void {
    if (this.view.running) this.stop();
    const history: EventRecord[] = this.view.events;
    this.view = initialView(); this.view.events = history;
    this.view.config = JSON.parse(JSON.stringify(config)) as AppConfig;
    if (!this.validConfig(config)) { this.view.error = '配置无效：请核对角色、节点ID、主机和端口'; this.publish(); return; }
    this.connections.clear(); this.pending.clear(); this.requests.clear(); this.peers = []; this.execution = undefined;
    this.serial = 0; this.requestSerial = 0; this.aggregateRevision = 0; this.receivedAggregateRevision = -1; this.sampleIndex = 0;
    this.bootId = config.nodeId + '-' + this.io.now().toString(36) + '-' + Math.floor(Math.random() * 0xFFFFFFF).toString(36);
    this.lastAgeAt = this.io.now(); this.lastSampleAt = this.io.now(); this.lastAggregateAt = this.io.now();
    this.view.running = true; this.view.status = '运行中 · 受控局域网课程模拟';
    if (config.role === 'controller') {
      this.view.payloads = [emptyPayload('CAM-01'), emptyPayload('ENV-01'), emptyPayload('LIGHT-01')];
      this.peers = [this.newPeer('CAM-01', config.cameraHost, config.cameraPort), this.newPeer('ENV-01', config.environmentHost, config.environmentPort), this.newPeer('LIGHT-01', config.lightHost, config.lightPort)];
      this.io.listen(config.listenPort);
    } else if (config.role === 'observer') {
      this.peers = [this.newPeer('TERM-01', config.controllerHost, config.controllerPort)];
    } else {
      this.view.local = emptyPayload(config.nodeId);
      this.view.local.capability = capabilityForRole(config.role, config.nodeId);
      this.view.local.name = this.view.local.capability.name;
      this.view.local.bootId = this.bootId; this.view.local.stateRevision = 1; this.view.local.linkState = 'READY';
      if (config.role === 'camera') this.view.local.readings = [{ id: 'mode', value: 'single', ageMs: 0 }, { id: 'captureCount', value: 0, ageMs: 0 }, { id: 'imageId', value: 'sample-0', ageMs: 0 }];
      if (config.role === 'environment') this.view.local.readings = [{ id: 'temperature', value: 24, ageMs: 0 }, { id: 'humidity', value: 55, ageMs: 0 }, { id: 'interval', value: 1, ageMs: 0 }];
      if (config.role === 'light') this.view.local.readings = [{ id: 'power', value: false, ageMs: 0 }, { id: 'brightness', value: 0, ageMs: 0 }];
      this.io.listen(config.listenPort);
    }
    this.addEvent(config.nodeId, 'started', '角色启动：' + config.role + '；模拟数据', '');
    for (const peer of this.peers) this.connectPeer(peer);
    this.publish();
  }

  stop(): void {
    if (!this.view.running) return;
    this.advanceAges();
    for (const item of this.pending.values()) this.markUnknown(item, '应用停止，结果未确认；不会自动重发');
    this.view.running = false; this.connections.clear(); this.peers = []; this.execution = undefined;
    this.io.stop();
    for (const p of this.view.payloads) p.linkState = 'DISCONNECTED';
    this.view.mainLinkState = 'DISCONNECTED'; this.view.local.linkState = 'DISCONNECTED'; this.view.status = '已停止';
    this.addEvent(this.view.config.nodeId, 'stopped', '应用已停止', ''); this.publish();
  }

  connected(connectionId: string, peerId: string, inbound: boolean): void {
    if (!this.view.running) { this.io.close(connectionId); return; }
    if (this.connections.has(connectionId)) return;
    if (this.connections.size >= 16 || (!inbound && this.findConnection(peerId))) { this.io.close(connectionId); return; }
    const now: number = this.io.now();
    const c: Connection = { id: connectionId, peerId: peerId, peerRole: '', peerBoot: '', inbound: inbound, session: '', rxSeq: 0, txSeq: 0, lastRx: now, lastTx: now, hasCapability: false, hasSnapshot: false, ready: false, invalid: 0, incompatible: false, closeAt: 0 };
    this.connections.set(connectionId, c);
    if (!inbound) {
      const peer: Peer | undefined = this.peers.find((p: Peer): boolean => p.id === peerId);
      if (!peer) { this.connections.delete(connectionId); this.io.close(connectionId); return; }
      peer.connecting = false; this.setLink(peerId, 'NEGOTIATING');
      this.send(c, 'hello', { role: this.view.config.role, bootId: this.bootId }, '');
    }
    this.publish();
  }

  received(connectionId: string, message: WireMessage): void {
    if (!this.view.running || this.view.paused) return;
    const c: Connection | undefined = this.connections.get(connectionId);
    if (!c || c.incompatible) return;
    let m: WireMessage;
    try { m = parseMessage(encodeMessage(message)); }
    catch {
      c.invalid++;
      this.addEvent(c.peerId, 'invalid-frame', '无效消息；连续次数 ' + c.invalid, '');
      if (c.invalid >= 3) this.retire(c, '连续三个无效格式帧');
      this.publish(); return;
    }
    this.advanceAges();
    if (m.targetId !== this.view.config.nodeId) { this.error(c, 'IDENTITY_MISMATCH', 'targetId与本节点不符', m.requestId); return; }
    if (m.type === 'hello') { this.hello(c, m); this.publish(); return; }
    if (m.type === 'helloAck') { this.helloAck(c, m); this.publish(); return; }
    if (m.sourceId !== c.peerId) { this.error(c, 'IDENTITY_MISMATCH', 'sourceId与连接绑定不符', m.requestId); return; }
    if (m.type === 'error' && c.session === '' && m.sessionId === '') {
      this.addEvent(c.peerId, 'protocol-error', (m.body.code as string) + ': ' + m.body.detail, m.requestId);
      if (m.body.code === 'CONTROLLER_BUSY') this.retire(c, 'CONTROLLER_BUSY');
      else this.incompatible(c, m.body.code as string);
      this.publish(); return;
    }
    if (!c.session || m.sessionId !== c.session) { this.error(c, 'STALE_SESSION', '会话不匹配，拒绝旧消息', m.requestId); return; }
    if (m.seq <= c.rxSeq) { this.error(c, 'STALE_SEQUENCE', '消息序号未递增', m.requestId); return; }
    c.rxSeq = m.seq; c.invalid = 0;
    // The role check runs before dispatch, not only in the UI.
    if (m.type === 'command' && (this.view.config.role === 'controller' || c.peerRole !== 'controller' || !this.isPayload())) {
      this.error(c, 'FORBIDDEN_ROLE', '只读监看连接不允许控制命令', m.requestId); this.publish(); return;
    }
    if (m.type === 'heartbeat') this.touch(c);
    else if (m.type === 'command' && c.ready) { this.touch(c); this.execute(c, m); }
    else if (m.type === 'capability' && this.view.config.role === 'controller' && !c.inbound) this.capability(c, m.body);
    else if ((m.type === 'snapshot' || m.type === 'telemetry') && this.view.config.role === 'controller' && !c.inbound) this.payloadSnapshot(c, m.body);
    else if (m.type === 'snapshot' && this.view.config.role === 'observer' && !c.inbound) this.aggregate(c, m.body);
    else if (m.type === 'commandStatus' && this.view.config.role === 'controller' && !c.inbound) { this.touch(c); this.commandStatus(c, m); }
    else if (m.type === 'event' && this.view.config.role === 'observer' && c.hasSnapshot) { if (m.body.event && this.validEvent(m.body.event)) { this.touch(c); this.appendEvent(m.body.event, true); } }
    else if (m.type === 'error') { this.touch(c); this.addEvent(c.peerId, 'protocol-error', (m.body.code as string) + ': ' + m.body.detail, m.requestId); }
    else this.error(c, 'UNEXPECTED_MESSAGE', '当前角色或握手阶段不接受此消息', m.requestId);
    this.publish();
  }

  closed(connectionId: string, reason: string): void {
    if (!this.view.running) return;
    if (connectionId.indexOf('connect:') === 0) {
      const id: string = connectionId.substring(8);
      const peer: Peer | undefined = this.peers.find((p: Peer): boolean => p.id === id);
      if (peer && !this.findConnection(id)) { peer.connecting = false; this.scheduleRetry(peer); this.setLink(id, 'OFFLINE'); this.addEvent(id, 'connect-failed', reason, ''); }
    } else {
      const c: Connection | undefined = this.connections.get(connectionId);
      if (!c) return;
      this.connections.delete(connectionId);
      for (const item of this.pending.values()) if (item.connectionId === connectionId) this.markUnknown(item, '连接中断，结果未确认；不会自动重发');
      if (!c.inbound) {
        this.setLink(c.peerId, c.incompatible ? 'INCOMPATIBLE' : 'OFFLINE');
        const peer: Peer | undefined = this.peers.find((p: Peer): boolean => p.id === c.peerId);
        if (peer && !peer.blocked) this.scheduleRetry(peer);
      } else if (this.isPayload()) this.view.mainLinkState = 'OFFLINE';
      this.addEvent(c.peerId, 'offline', reason, '');
    }
    if (this.view.config.role === 'controller') this.broadcastAggregate();
    this.publish();
  }

  tick(): void {
    if (!this.view.running) return;
    this.advanceAges(); const now: number = this.io.now();
    if (this.execution && now >= this.execution.due) this.finishExecution();
    if (this.isPayload()) this.sample(now);
    for (const item of this.pending.values()) if (now - item.sentAt >= 5000) this.markUnknown(item, '5秒未获最终回执：结果未确认，可能已经执行');
    for (const c of Array.from(this.connections.values())) {
      if (c.closeAt > 0 && now >= c.closeAt) { this.retire(c, '协议拒绝'); continue; }
      if (this.view.paused) continue;
      const silence: number = now - c.lastRx;
      if (silence >= 6000) { this.retire(c, '6秒未收到有效会话消息'); continue; }
      if (silence >= 3000 && !c.inbound) this.setLink(c.peerId, 'STALE');
      if (silence >= 3000 && c.inbound && this.isPayload()) this.view.mainLinkState = 'STALE';
      if (c.session && !c.incompatible && now - c.lastTx >= 1000) this.send(c, 'heartbeat', {}, '');
    }
    if (!this.view.paused) {
      for (const peer of this.peers) if (!peer.blocked && !peer.connecting && !this.findConnection(peer.id) && now >= peer.retryAt) this.connectPeer(peer);
      if (this.view.config.role === 'controller' && now - this.lastAggregateAt >= 1000) this.broadcastAggregate();
    }
    this.publish();
  }

  command(deviceId: string, actionId: string, value: Value): void {
    if (this.view.config.role !== 'controller') { this.view.error = 'FORBIDDEN_ROLE：监看端只读'; this.publish(); return; }
    const p: PayloadView | undefined = this.payload(deviceId); const c: Connection | undefined = this.findConnection(deviceId);
    if (!this.view.running || this.view.paused || !p || !c || !c.ready || p.linkState !== 'READY') { this.view.error = '载荷未就绪，控制已禁用'; this.publish(); return; }
    this.advanceAges();
    const a: ActionSpec | undefined = p.capability.actions.find((item: ActionSpec): boolean => item.id === actionId);
    if (!a || !validateActionValue(a, value)) { this.view.error = 'INVALID_ARGUMENT：参数不符合能力描述'; this.addEvent(deviceId, 'rejected-local', this.view.error, ''); this.publish(); return; }
    const validState: boolean = p.capability.metrics.every((m: MetricSpec): boolean => { const r: Reading | undefined = p.readings.find((item: Reading): boolean => item.id === m.id); return r !== undefined && r.ageMs <= m.validForMs; });
    if (!validState) { this.view.error = '数据已过期，请等待完整状态更新'; this.publish(); return; }
    for (const item of this.pending.values()) if (item.record.deviceId === deviceId && (item.record.status === 'waiting' || item.record.status === 'accepted')) { this.view.error = '该载荷已有待确认请求'; this.publish(); return; }
    // Unknown outcomes remain matchable for late replies in their original session.
    // A new lastCommand is only a display selection, not permission to discard history.
    for (const item of this.pending.values()) {
      const origin: Connection | undefined = this.connections.get(item.connectionId);
      const terminal: boolean = item.record.status === 'completed' || item.record.status === 'failed' || item.record.status === 'rejected';
      if (terminal || !origin || origin.session !== item.session) this.pending.delete(item.record.requestId);
    }
    if (this.pending.size >= 128) { this.view.error = 'PENDING_TABLE_FULL：未决请求已达128条，请等待最终回执或明确重建会话；旧命令不会重发'; this.addEvent(deviceId, 'rejected-local', this.view.error, ''); this.publish(); return; }
    this.requestSerial++;
    const record: CommandRecord = { requestId: this.bootId + '-req-' + this.requestSerial, deviceId: deviceId, actionId: actionId, status: 'waiting', detail: '等待回执；发送成功不代表执行完成', value: value, time: this.timestamp() };
    this.pending.set(record.requestId, { record: record, connectionId: c.id, session: c.session, sentAt: this.io.now(), accepted: false });
    p.lastCommand = record; this.view.error = '';
    this.addEvent(deviceId, 'command', actionId + ' = ' + JSON.stringify(value), record.requestId);
    this.send(c, 'command', { actionId: actionId, args: { value: value } }, record.requestId);
    this.publish();
  }

  setPaused(paused: boolean): void {
    if (!this.view.running) return;
    this.view.paused = paused;
    this.view.status = paused ? '模拟通信已暂停；本地模拟仍运行' : '运行中 · 受控局域网课程模拟';
    this.addEvent(this.view.config.nodeId, paused ? 'paused' : 'resumed', paused ? '暂停通信（故障演示）' : '恢复通信，重新读取状态；不重发控制', '');
    if (!paused) for (const c of Array.from(this.connections.values())) this.retire(c, '恢复通信建立新会话');
    this.publish();
  }

  setFault(mode: string): void {
    if (!this.isPayload() || ['none', 'reject-next', 'fail-next', 'drop-next-result'].indexOf(mode) < 0) { this.view.error = '故障注入仅适用于模拟载荷'; this.publish(); return; }
    this.view.fault = mode; this.addEvent(this.view.config.nodeId, 'simulation-fault', '模拟故障：' + mode, ''); this.publish();
  }

  restoreEvents(events: EventRecord[]): void {
    this.view.events = [];
    if (Array.isArray(events)) {
      for (const e of events.slice(-10000)) if (this.validEvent(e)) this.view.events.push(JSON.parse(JSON.stringify(e)) as EventRecord);
    }
    this.publish();
  }

  getView(): AppView { this.advanceAges(); return JSON.parse(JSON.stringify(this.view)) as AppView; }

  private validConfig(c: AppConfig): boolean {
    if (['controller', 'observer', 'camera', 'environment', 'light'].indexOf(c.role) < 0 || typeof c.nodeId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(c.nodeId)) return false;
    if (c.nodeId !== defaultConfig(c.role).nodeId) return false;
    for (const port of [c.listenPort, c.controllerPort, c.cameraPort, c.environmentPort, c.lightPort]) if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
    for (const host of [c.controllerHost, c.cameraHost, c.environmentHost, c.lightHost]) if (typeof host !== 'string' || host.length === 0 || host.length > 253) return false;
    return true;
  }
  private newPeer(id: string, host: string, port: number): Peer { return { id: id, host: host, port: port, retryAt: 0, attempt: 0, connecting: false, blocked: false }; }
  private isPayload(): boolean { return this.view.config.role === 'camera' || this.view.config.role === 'environment' || this.view.config.role === 'light'; }
  private timestamp(): string { return new Date().toISOString(); }
  private publish(): void { this.io.changed(this.getView()); }
  private payload(id: string): PayloadView | undefined { return this.view.payloads.find((p: PayloadView): boolean => p.deviceId === id); }
  private findConnection(id: string): Connection | undefined { for (const c of this.connections.values()) if (!c.inbound && c.peerId === id) return c; return undefined; }
  private connectPeer(peer: Peer): void { peer.connecting = true; this.setLink(peer.id, 'CONNECTING'); this.io.connect(peer.id, peer.host, peer.port); }
  private scheduleRetry(peer: Peer): void { peer.retryAt = this.io.now() + [1000, 2000, 5000][Math.min(peer.attempt, 2)]; peer.attempt++; peer.connecting = false; }
  private setLink(id: string, state: string): void {
    if (this.view.config.role === 'observer') {
      this.view.mainLinkState = state;
      if (state !== 'READY') for (const p of this.view.payloads) if (p.linkState === 'READY') p.linkState = 'STALE';
    } else { const p: PayloadView | undefined = this.payload(id); if (p) p.linkState = state; }
  }
  private advanceAges(): void {
    const now: number = this.io.now(); const delta: number = Math.max(0, now - this.lastAgeAt); this.lastAgeAt = now;
    if (!this.view.running) return;
    for (const p of this.view.payloads) for (const r of p.readings) r.ageMs += delta;
    for (const r of this.view.local.readings) r.ageMs += delta;
  }
  private send(c: Connection, type: string, body: WireBody, requestId: string): void {
    if (this.view.paused || !this.view.running) return;
    this.serial++; if (type !== 'hello') c.txSeq++;
    const m: WireMessage = { protocolVersion: 1, type: type, messageId: this.bootId + '-msg-' + this.serial, sessionId: type === 'hello' ? '' : c.session, sourceId: this.view.config.nodeId, targetId: c.peerId, seq: type === 'hello' ? 0 : c.txSeq, requestId: requestId, sentAt: this.timestamp(), body: body };
    c.lastTx = this.io.now(); this.io.send(c.id, m);
  }
  private error(c: Connection, code: string, detail: string, requestId: string): void { this.send(c, 'error', { code: code, detail: detail }, requestId); this.addEvent(c.peerId, 'protocol-error', code + ': ' + detail, requestId); }
  private retire(c: Connection, detail: string): void { this.closed(c.id, detail); this.io.close(c.id); }
  private incompatible(c: Connection, detail: string): void {
    c.incompatible = true; c.ready = false; c.closeAt = this.io.now() + 250;
    const peer: Peer | undefined = this.peers.find((p: Peer): boolean => p.id === c.peerId); if (peer) peer.blocked = true;
    this.setLink(c.peerId, 'INCOMPATIBLE'); this.view.error = detail; this.addEvent(c.peerId, 'incompatible', detail, '');
  }
  private touch(c: Connection): void {
    c.lastRx = this.io.now();
    if (c.ready && !c.inbound) this.setLink(c.peerId, 'READY');
    if (c.ready && c.inbound && this.isPayload()) this.view.mainLinkState = 'READY';
  }
  private expectedRole(id: string): string { if (id === 'CAM-01') return 'camera'; if (id === 'ENV-01') return 'environment'; if (id === 'LIGHT-01') return 'light'; if (id === 'TERM-01') return 'controller'; return ''; }

  private hello(c: Connection, m: WireMessage): void {
    if (!c.inbound || c.session !== '' || m.sessionId !== '') { this.error(c, 'STALE_SESSION', 'hello必须开始新连接', ''); return; }
    c.peerId = m.sourceId;
    const permittedRole: string = this.view.config.role === 'controller' ? 'observer' : 'controller';
    const permittedId: string = permittedRole === 'observer' ? 'VIEW-01' : 'TERM-01';
    if ((!this.isPayload() && this.view.config.role !== 'controller') || m.body.role !== permittedRole || m.sourceId !== permittedId) {
      this.error(c, 'FORBIDDEN_ROLE', '当前服务不接受该身份或角色', ''); c.incompatible = true; c.closeAt = this.io.now() + 250; return;
    }
    for (const other of Array.from(this.connections.values())) {
      if (other.id !== c.id && other.inbound && other.ready && (this.isPayload() || other.peerId === m.sourceId)) {
        if (this.io.now() - other.lastRx < 6000) { this.error(c, 'CONTROLLER_BUSY', '已有有效控制者或相同设备身份', ''); c.incompatible = true; c.closeAt = this.io.now() + 250; return; }
        this.retire(other, '控制会话租约已过期');
      }
    }
    this.serial++; c.session = this.bootId + '-session-' + this.serial;
    c.peerRole = m.body.role as string; c.peerBoot = m.body.bootId as string; c.ready = true; c.lastRx = this.io.now();
    this.send(c, 'helloAck', { role: this.view.config.role, bootId: this.bootId }, '');
    if (this.isPayload()) { this.view.mainLinkState = 'READY'; this.send(c, 'capability', { capability: this.view.local.capability }, ''); this.sendLocalSnapshot(c, 'snapshot'); }
    else this.sendAggregate(c);
    this.addEvent(c.peerId, 'connected', '身份与会话已建立', '');
  }
  private helloAck(c: Connection, m: WireMessage): void {
    if (c.inbound || c.session !== '' || m.sessionId === '' || m.sourceId !== c.peerId || m.body.role !== this.expectedRole(c.peerId)) { this.incompatible(c, 'IDENTITY_MISMATCH：握手身份或角色不符'); return; }
    c.session = m.sessionId; c.peerRole = m.body.role as string; c.peerBoot = m.body.bootId as string; c.rxSeq = m.seq; c.lastRx = this.io.now();
    if (this.view.config.role === 'observer') this.receivedAggregateRevision = -1;
  }
  private capability(c: Connection, body: WireBody): void {
    const p: PayloadView | undefined = this.payload(c.peerId); if (!p || !body.capability) return;
    try {
      const cap: Capability = validateCapability(body.capability, c.peerId);
      if (c.hasCapability && JSON.stringify(cap) !== JSON.stringify(p.capability)) throw new Error('CAPABILITY_CHANGED');
      p.capability = cap; p.name = cap.name; c.hasCapability = true; this.touch(c);
    } catch { this.incompatible(c, 'INVALID_DESCRIPTOR：描述格式、类型或绑定无效'); }
  }
  private validSnapshot(cap: Capability, metrics: Reading[]): boolean {
    try { validateReadings(metrics); } catch { return false; }
    if (metrics.length !== cap.metrics.length) return false;
    const typesValid: boolean = cap.metrics.every((m: MetricSpec): boolean => {
      const r: Reading | undefined = metrics.find((reading: Reading): boolean => reading.id === m.id);
      return r !== undefined && typeof r.value === m.valueType && (m.display !== 'image' || (typeof r.value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(r.value)));
    });
    if (!typesValid) return false;
    return cap.actions.every((a: ActionSpec): boolean => { if (a.control === 'button') return true; const r: Reading | undefined = metrics.find((reading: Reading): boolean => reading.id === a.boundMetricId); return r !== undefined && validateActionValue(a, r.value); });
  }
  private payloadSnapshot(c: Connection, body: WireBody): void {
    const p: PayloadView | undefined = this.payload(c.peerId);
    if (!p || !c.hasCapability || !body.metrics || body.stateRevision === undefined || body.deviceBootId !== c.peerBoot || !this.validSnapshot(p.capability, body.metrics)) { this.error(c, 'INVALID_SNAPSHOT', '完整状态或bootId无效', ''); return; }
    if (c.hasSnapshot && body.stateRevision < p.stateRevision) { this.error(c, 'STALE_REVISION', '拒绝旧状态版本', ''); return; }
    if (c.hasSnapshot && body.stateRevision === p.stateRevision && !body.metrics.every((r: Reading): boolean => { const old: Reading | undefined = p.readings.find((item: Reading): boolean => item.id === r.id); return old !== undefined && old.value === r.value; })) { this.error(c, 'REVISION_CONFLICT', '相同状态版本不能改变数值', ''); return; }
    p.readings = JSON.parse(JSON.stringify(body.metrics)) as Reading[]; p.stateRevision = body.stateRevision; p.bootId = body.deviceBootId;
    const trendMetric: MetricSpec | undefined = p.capability.metrics.find((m: MetricSpec): boolean => m.display === 'line');
    if (trendMetric) { const r: Reading | undefined = p.readings.find((item: Reading): boolean => item.id === trendMetric.id); if (r && typeof r.value === 'number') { p.trend.push(r.value); if (p.trend.length > 60) p.trend.shift(); } }
    const wasReady: boolean = c.ready;
    c.hasSnapshot = true;
    if (!c.ready) c.ready = p.capability.metrics.every((metric: MetricSpec): boolean => { const r: Reading | undefined = p.readings.find((item: Reading): boolean => item.id === metric.id); return r !== undefined && r.ageMs <= metric.validForMs; });
    this.touch(c);
    const peer: Peer | undefined = this.peers.find((item: Peer): boolean => item.id === c.peerId); if (peer) peer.attempt = 0;
    if (!wasReady && c.ready) this.broadcastAggregate();
  }
  private aggregate(c: Connection, body: WireBody): void {
    if (body.mainBootId !== c.peerBoot || !body.payloads || body.snapshotRevision === undefined || body.snapshotRevision < this.receivedAggregateRevision) { this.error(c, 'INVALID_SNAPSHOT', '监看快照身份或版本无效', ''); return; }
    const ids: Set<string> = new Set<string>();
    try {
      for (const p of body.payloads) {
        if (!p || typeof p.deviceId !== 'string' || ids.has(p.deviceId) || ['DISCONNECTED', 'CONNECTING', 'NEGOTIATING', 'READY', 'STALE', 'OFFLINE', 'INCOMPATIBLE'].indexOf(p.linkState) < 0 || !Array.isArray(p.readings) || !Array.isArray(p.trend) || p.trend.length > 60 || !p.lastCommand || typeof p.bootId !== 'string' || !Number.isInteger(p.stateRevision) || p.stateRevision < 0) throw new Error('INVALID_AGGREGATE');
        ids.add(p.deviceId);
        if (p.capability.metrics.length > 0) { validateCapability(p.capability, p.deviceId); if (p.readings.length > 0 && !this.validSnapshot(p.capability, p.readings)) throw new Error('INVALID_READINGS'); }
        else if (p.linkState === 'READY') throw new Error('MISSING_CAPABILITY');
      }
    } catch { this.error(c, 'INVALID_SNAPSHOT', '监看聚合状态校验失败', ''); return; }
    this.receivedAggregateRevision = body.snapshotRevision;
    this.view.payloads = JSON.parse(JSON.stringify(body.payloads)) as PayloadView[];
    c.hasSnapshot = true; c.ready = true; this.touch(c);
    const peer: Peer | undefined = this.peers.find((item: Peer): boolean => item.id === c.peerId); if (peer) peer.attempt = 0;
  }

  private execute(c: Connection, m: WireMessage): void {
    const value: Value = m.body.args && m.body.args.value !== undefined ? m.body.args.value : true;
    const actionId: string = m.body.actionId as string; const key: string = m.sourceId + '|' + m.requestId;
    const previous: ExecutedRequest | undefined = this.requests.get(key);
    if (previous) {
      if (previous.actionId !== actionId || previous.value !== value) this.error(c, 'REQUEST_ID_CONFLICT', '请求标识已绑定另一命令；原请求终态不变', m.requestId);
      else this.reply(c, previous);
      return;
    }
    if (this.requests.size >= 5000) { this.send(c, 'commandStatus', { status: 'rejected', code: 'REQUEST_TABLE_FULL', detail: '本次服务启动周期请求记录已达5000条；明确重启后再操作' }, m.requestId); this.addEvent(m.sourceId, 'capacity', 'REQUEST_TABLE_FULL：未执行', m.requestId); return; }
    const r: ExecutedRequest = { sourceId: m.sourceId, requestId: m.requestId, actionId: actionId, value: value, status: 'accepted', code: 'OK', detail: '模拟载荷已接收', revision: this.view.local.stateRevision, result: [] };
    this.requests.set(key, r);
    const a: ActionSpec | undefined = this.view.local.capability.actions.find((item: ActionSpec): boolean => item.id === actionId);
    let code: string = ''; let detail: string = '';
    if (!a) { code = 'UNKNOWN_ACTION'; detail = '操作未在能力描述中声明'; }
    else if (!validateActionValue(a, value) || (a.control !== 'button' && (!m.body.args || m.body.args.value === undefined))) { code = 'INVALID_ARGUMENT'; detail = '参数类型、范围或枚举无效'; }
    else if (this.execution) { code = 'PAYLOAD_BUSY'; detail = '已有请求执行中'; }
    else if (this.view.fault === 'reject-next') { code = 'SIMULATED_REJECTION'; detail = '模拟拒绝（未执行）'; this.view.fault = 'none'; }
    if (code !== '') { r.status = 'rejected'; r.code = code; r.detail = detail; this.localCommand(r); this.reply(c, r); return; }
    const fault: string = this.view.fault; this.view.fault = 'none';
    this.execution = { request: r, connectionId: c.id, session: c.session, due: this.io.now() + 200, fault: fault };
    this.localCommand(r); this.reply(c, r);
  }
  private finishExecution(): void {
    const job: Execution | undefined = this.execution; if (!job) return;
    this.execution = undefined; const r: ExecutedRequest = job.request;
    if (job.fault === 'fail-next') { r.status = 'failed'; r.code = 'EXECUTION_FAILED'; r.detail = '模拟执行失败；真实状态未改变'; }
    else {
      if (r.actionId === 'capture') { const count: number = (this.localValue('captureCount') as number) + 1; this.setLocal('captureCount', count); this.setLocal('imageId', 'sample-' + count % 3); }
      if (r.actionId === 'set_mode') this.setLocal('mode', r.value);
      if (r.actionId === 'set_interval') this.setLocal('interval', r.value);
      if (r.actionId === 'set_power') this.setLocal('power', r.value);
      if (r.actionId === 'set_brightness') this.setLocal('brightness', r.value);
      this.view.local.stateRevision++; r.status = 'completed'; r.code = 'OK'; r.detail = '模拟执行完成';
    }
    r.revision = this.view.local.stateRevision; r.result = JSON.parse(JSON.stringify(this.view.local.readings)) as Reading[];
    this.localCommand(r);
    const c: Connection | undefined = this.connections.get(job.connectionId);
    if (c && c.session === job.session) {
      if (job.fault !== 'drop-next-result') this.reply(c, r);
      else this.addEvent(this.view.config.nodeId, 'simulation-drop', '模拟丢弃最终回执；动作已执行', r.requestId);
      this.sendLocalSnapshot(c, 'snapshot');
    }
  }
  private reply(c: Connection, r: ExecutedRequest): void { this.send(c, 'commandStatus', { status: r.status, code: r.code, detail: r.detail, stateRevision: r.revision, result: r.result }, r.requestId); }
  private localCommand(r: ExecutedRequest): void {
    this.view.local.lastCommand = { requestId: r.requestId, deviceId: this.view.config.nodeId, actionId: r.actionId, status: r.status, detail: r.detail, value: r.value, time: this.timestamp() };
    this.addEvent(this.view.config.nodeId, r.status, r.detail, r.requestId);
  }
  private commandStatus(c: Connection, m: WireMessage): void {
    const item: PendingCommand | undefined = this.pending.get(m.requestId); if (!item || item.connectionId !== c.id || item.session !== c.session || item.record.deviceId !== c.peerId) { this.addEvent(c.peerId, 'unmatched-status', '回执无当前会话匹配请求', m.requestId); return; }
    const current: string = item.record.status; const status: string = m.body.status as string;
    if (current === 'completed' || current === 'failed' || current === 'rejected') { if (status !== current) this.addEvent(c.peerId, 'contradictory-status', '忽略矛盾终态：' + status, m.requestId); return; }
    if (item.accepted && status === 'rejected') { this.addEvent(c.peerId, 'contradictory-status', '已接收请求不能退回拒绝状态', m.requestId); return; }
    if (current === 'unknown' && status === 'accepted') return;
    if (status === 'accepted') item.accepted = true;
    item.record.status = status; item.record.detail = (current === 'unknown' ? '迟到回执；' : '') + m.body.detail; item.record.time = this.timestamp();
    this.addEvent(c.peerId, status, item.record.detail, m.requestId);
    this.broadcastAggregate();
  }
  private markUnknown(item: PendingCommand, reason: string): void {
    if (item.record.status !== 'waiting' && item.record.status !== 'accepted') return;
    item.record.status = 'unknown'; item.record.detail = reason; item.record.time = this.timestamp();
    this.addEvent(item.record.deviceId, 'unknown', reason, item.record.requestId);
  }

  private localValue(id: string): Value { const r: Reading | undefined = this.view.local.readings.find((item: Reading): boolean => item.id === id); return r ? r.value : ''; }
  private setLocal(id: string, value: Value): void { const r: Reading | undefined = this.view.local.readings.find((item: Reading): boolean => item.id === id); if (r) { r.value = value; r.ageMs = 0; } }
  private sample(now: number): void {
    let period: number = 1000; if (this.view.config.role === 'environment') period = (this.localValue('interval') as number) * 1000;
    if (now - this.lastSampleAt < period) return;
    this.lastSampleAt = now; this.sampleIndex++;
    if (this.view.config.role === 'environment') {
      this.setLocal('temperature', Math.round((24 + Math.sin(this.sampleIndex / 4) * 2) * 10) / 10);
      this.setLocal('humidity', Math.round((55 + Math.cos(this.sampleIndex / 5) * 8) * 10) / 10);
      this.view.local.stateRevision++; this.view.local.trend.push(this.localValue('temperature') as number); if (this.view.local.trend.length > 60) this.view.local.trend.shift();
    }
    if (this.view.config.role === 'camera' && this.localValue('mode') === 'continuous') { const count: number = (this.localValue('captureCount') as number) + 1; this.setLocal('captureCount', count); this.setLocal('imageId', 'sample-' + count % 3); this.view.local.stateRevision++; }
    for (const r of this.view.local.readings) r.ageMs = 0;
    for (const c of this.connections.values()) if (c.ready && c.inbound && !c.incompatible) this.sendLocalSnapshot(c, 'telemetry');
  }
  private sendLocalSnapshot(c: Connection, type: string): void { this.send(c, type, { deviceBootId: this.bootId, stateRevision: this.view.local.stateRevision, metrics: JSON.parse(JSON.stringify(this.view.local.readings)) as Reading[] }, ''); }
  private sendAggregate(c: Connection): void { this.aggregateRevision++; this.send(c, 'snapshot', { mainBootId: this.bootId, snapshotRevision: this.aggregateRevision, payloads: JSON.parse(JSON.stringify(this.view.payloads)) as PayloadView[] }, ''); }
  private broadcastAggregate(): void { if (this.view.config.role !== 'controller') return; this.lastAggregateAt = this.io.now(); for (const c of this.connections.values()) if (c.inbound && c.ready && !c.incompatible && c.peerRole === 'observer') this.sendAggregate(c); }

  private validEvent(e: EventRecord): boolean { return e !== null && typeof e === 'object' && typeof e.id === 'string' && e.id.length > 0 && e.id.length <= 256 && typeof e.time === 'string' && e.time.length <= 64 && typeof e.deviceId === 'string' && e.deviceId.length <= 64 && typeof e.kind === 'string' && e.kind.length <= 64 && typeof e.detail === 'string' && e.detail.length <= 2048 && typeof e.requestId === 'string' && e.requestId.length <= 256; }
  private appendEvent(e: EventRecord, dedupe: boolean): void {
    if (dedupe && this.view.events.some((item: EventRecord): boolean => item.id === e.id)) return;
    const copy: EventRecord = JSON.parse(JSON.stringify(e)) as EventRecord; this.view.events.push(copy);
    if (this.view.events.length > 10000) { this.view.events.shift(); this.view.error = '事件记录已达10000条，最旧事件已轮换；请及时导出'; }
    this.io.log(copy);
  }
  private addEvent(deviceId: string, kind: string, detail: string, requestId: string): void {
    this.serial++; const e: EventRecord = { id: this.bootId + '-event-' + this.serial, time: this.timestamp(), deviceId: deviceId, kind: kind, detail: detail, requestId: requestId };
    this.appendEvent(e, false);
    if (this.view.config.role === 'controller') for (const c of this.connections.values()) if (c.inbound && c.ready && !c.incompatible && c.peerRole === 'observer') this.send(c, 'event', { event: e }, '');
  }
}
