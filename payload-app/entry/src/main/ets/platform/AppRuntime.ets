import socket from '@ohos.net.socket';
import util from '@ohos.util';
import fs from '@ohos.file.fs';
import systemDateTime from '@ohos.systemDateTime';
import hilog from '@ohos.hilog';
import type common from '@ohos.app.ability.common';
import type { BusinessError } from '@ohos.base';
import { PayloadEngine } from '../core/engine';
import type { EngineIO } from '../core/engine';
import type { AppConfig, AppView, EventRecord, Value } from '../core/models';
import { defaultConfig } from '../core/models';
import { ByteFramer, encodeMessage, parseMessage } from '../core/protocol';
import type { WireMessage } from '../core/protocol';

// API18's TCP server has no close(). Keep it alive, reject accepts while stopped,
// and reuse it on restart. Force-stopping the application releases the port.
class Listener {
  server: socket.TCPSocketServer = socket.constructTCPSocketServerInstance();
  owner: NativeTransport | null = null;
  generation: number = 0;
  ready: Promise<void>;
  constructor(port: number) {
    this.server.on('connect', (client: socket.TCPSocketConnection) => {
      if (this.owner === null || this.owner.generation !== this.generation) {
        client.close().catch(() => {});
        return;
      }
      this.owner.accept(client);
    });
    this.server.on('error', (error: BusinessError) => {
      if (this.owner !== null) this.owner.fail('监听错误：' + error.message);
    });
    this.ready = this.server.listen({ address: '0.0.0.0', port: port, family: 1 });
  }
}

class Channel {
  id: string;
  peer: string;
  generation: number;
  socket: socket.TCPSocket | socket.TCPSocketConnection;
  framer: ByteFramer = new ByteFramer();
  ready: boolean = false;
  closed: boolean = false;
  queue: string[] = [];
  sending: boolean = false;
  constructor(id: string, peer: string, generation: number, client: socket.TCPSocket | socket.TCPSocketConnection) {
    this.id = id; this.peer = peer; this.generation = generation; this.socket = client;
  }
}

class NativeTransport {
  private static listeners: Map<number, Listener> = new Map();
  private channels: Map<string, Channel> = new Map();
  private sequence: number = 0;
  private onError: (message: string) => void;
  generation: number = 0;
  engine: PayloadEngine;
  constructor(onChange: (view: AppView) => void, onLog: (event: EventRecord) => void, onError: (message: string) => void) {
    this.onError = onError;
    const io: EngineIO = {
      now: (): number => systemDateTime.getUptime(systemDateTime.TimeType.STARTUP, false),
      send: (id: string, message: WireMessage): void => this.send(id, message),
      connect: (peer: string, host: string, port: number): void => { this.connect(peer, host, port); },
      listen: (port: number): void => { this.listen(port); },
      close: (id: string): void => this.close(id),
      stop: (): void => this.stopSockets(),
      changed: onChange,
      log: onLog
    };
    this.engine = new PayloadEngine(io);
  }
  fail(message: string): void { this.engine.stop(); this.onError(message); }
  private active(channel: Channel): boolean {
    return !channel.closed && channel.generation === this.generation && this.channels.get(channel.id) === channel;
  }
  private attach(channel: Channel): void {
    this.channels.set(channel.id, channel);
    channel.socket.on('message', (info: socket.SocketMessageInfo) => {
      if (!this.active(channel)) return;
      try {
        const frames = channel.framer.push(new Uint8Array(info.message));
        for (let i = 0; i < frames.length; i++) {
          if (!this.active(channel)) return;
          const decoder = util.TextDecoder.create('utf-8', { fatal: true });
          this.engine.received(channel.id, parseMessage(decoder.decodeToString(frames[i])));
        }
      } catch (error) { this.lost(channel, '协议错误：' + (error as Error).message); }
    });
    channel.socket.on('close', () => this.lost(channel, '连接关闭'));
    channel.socket.on('error', (error: BusinessError) => this.lost(channel, '网络错误：' + error.message));
  }
  accept(client: socket.TCPSocketConnection): void {
    // Bound inbound resources before the application handshake rejects strangers.
    if (this.channels.size >= 16) { client.close().catch(() => {}); return; }
    const channel = new Channel('in-' + (++this.sequence), '', this.generation, client);
    channel.ready = true;
    this.attach(channel);
    this.engine.connected(channel.id, '', true);
  }
  private async connect(peer: string, host: string, port: number): Promise<void> {
    const client = socket.constructTCPSocketInstance();
    const channel = new Channel('out-' + (++this.sequence), peer, this.generation, client);
    this.attach(channel);
    try {
      await client.bind({ address: '0.0.0.0', port: 0, family: 1 });
      if (!this.active(channel)) return;
      await client.connect({ address: { address: host, port: port, family: 1 }, timeout: 3000 });
      if (!this.active(channel)) return;
      channel.ready = true;
      this.engine.connected(channel.id, peer, false);
    } catch (error) { this.lost(channel, '连接失败：' + (error as Error).message); }
  }
  private async listen(port: number): Promise<void> {
    const generation = this.generation;
    let listener = NativeTransport.listeners.get(port);
    try {
      if (!listener) {
        if (NativeTransport.listeners.size >= 8) throw new Error('本次进程已使用 8 个监听端口，请强制停止应用后重启');
        listener = new Listener(port);
        NativeTransport.listeners.set(port, listener);
      }
      if (listener.owner !== null && listener.owner !== this) throw new Error('端口由另一运行实例占用');
      listener.owner = this;
      listener.generation = generation;
      try {
        await listener.ready;
      } catch (error) {
        // 'error' may already have stopped the engine and advanced generation.
        // Evict this rejected promise before the generation guard, but never a
        // newer listener that happens to use the same port.
        if (NativeTransport.listeners.get(port) === listener) NativeTransport.listeners.delete(port);
        if (listener.owner === this && listener.generation === generation) listener.owner = null;
        throw new Error((error as Error).message);
      }
    } catch (error) {
      if (generation !== this.generation) return;
      if (listener && listener.owner === this) {
        listener.owner = null;
        NativeTransport.listeners.delete(port);
      }
      this.fail('无法监听端口 ' + port + '：' + (error as Error).message);
    }
  }
  private send(id: string, message: WireMessage): void {
    const channel = this.channels.get(id);
    if (!channel || !this.active(channel)) return;
    if (channel.queue.length >= 64) { this.lost(channel, '发送队列已满'); return; }
    channel.queue.push(encodeMessage(message));
    this.drain(channel);
  }
  private async drain(channel: Channel): Promise<void> {
    if (channel.sending) return;
    channel.sending = true;
    try {
      while (this.active(channel) && channel.queue.length > 0) {
        const data = channel.queue.shift();
        if (data !== undefined) await channel.socket.send({ data: data, encoding: 'UTF-8' });
      }
    } catch (error) { this.lost(channel, '发送失败：' + (error as Error).message); }
    finally { channel.sending = false; }
  }
  private lost(channel: Channel, reason: string): void {
    if (!this.active(channel)) return;
    const id = channel.ready || channel.peer === '' ? channel.id : 'connect:' + channel.peer;
    this.close(channel.id);
    this.engine.closed(id, reason);
  }
  private close(id: string): void {
    const channel = this.channels.get(id);
    if (!channel) return;
    channel.closed = true;
    this.channels.delete(id);
    channel.queue = [];
    channel.socket.close().catch(() => {});
  }
  private stopSockets(): void {
    this.generation++;
    NativeTransport.listeners.forEach((listener: Listener) => {
      if (listener.owner === this) listener.owner = null;
    });
    const ids: string[] = [];
    this.channels.forEach((channel: Channel) => ids.push(channel.id));
    ids.forEach((id: string) => this.close(id));
  }
}

interface SavedHistory { schemaVersion: number; events: EventRecord[]; }
interface ExportData { schemaVersion: number; exportedAt: string; simulated: boolean; config: AppConfig; view: AppView; events: EventRecord[]; }

export function checkConfig(config: AppConfig): void {
  if (!config || ['controller', 'observer', 'camera', 'environment', 'light'].indexOf(config.role) < 0)
    throw new Error('角色无效');
  if (typeof config.nodeId !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(config.nodeId)) throw new Error('节点编号格式无效');
  const ports: number[] = [config.listenPort, config.controllerPort, config.cameraPort, config.environmentPort, config.lightPort];
  ports.forEach((port: number) => { if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口必须为 1024–65535 整数'); });
  const hosts: string[] = [config.controllerHost, config.cameraHost, config.environmentHost, config.lightHost];
  hosts.forEach((host: string) => {
    if (typeof host !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) throw new Error('请输入实际 IPv4 地址');
    host.split('.').forEach((part: string) => { if (Number(part) > 255) throw new Error('IPv4 地址数值超出范围'); });
  });
  // P0 fixed identity contract: controller expects these exact stable IDs.
  if (config.nodeId !== defaultConfig(config.role).nodeId) throw new Error('P0 角色编号固定，请使用该角色默认编号');
}

export class AppRuntime {
  private transport: NativeTransport;
  private context: common.UIAbilityContext;
  private onChange: (view: AppView) => void;
  private config: AppConfig = defaultConfig('controller');
  private history: EventRecord[] = [];
  private timer: number = -1;
  private saveTimer: number = -1;
  private platformError: string = '';
  private disposed: boolean = false;
  constructor(context: common.UIAbilityContext, onChange: (view: AppView) => void) {
    this.context = context; this.onChange = onChange;
    this.transport = new NativeTransport((view: AppView) => this.emit(view),
      (event: EventRecord) => this.remember(event), (message: string) => {
        this.clearTick(); this.platformError = message; this.emit(this.transport.engine.getView());
      });
  }
  private emit(view: AppView): void {
    if (this.disposed) return;
    if (this.platformError !== '') view.error = this.platformError;
    this.onChange(view);
  }
  private path(name: string): string { return this.context.filesDir + '/' + name; }
  private writeJson(path: string, text: string): void {
    const temporary = path + '.tmp';
    const file = fs.openSync(temporary, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
    try {
      const bytes = new util.TextEncoder().encodeInto(text);
      if (fs.writeSync(file.fd, text) !== bytes.length) throw new Error('文件写入不完整');
    } finally { fs.closeSync(file); }
    fs.renameSync(temporary, path);
  }
  async load(): Promise<AppConfig> {
    try {
      if (fs.accessSync(this.path('payload-config.json'))) {
        const config = JSON.parse(fs.readTextSync(this.path('payload-config.json'))) as AppConfig;
        checkConfig(config); this.config = config;
      }
      if (fs.accessSync(this.path('payload-history.json'))) {
        const history = JSON.parse(fs.readTextSync(this.path('payload-history.json'))) as SavedHistory;
        if (!history || history.schemaVersion !== 1 || !Array.isArray(history.events)) throw new Error('历史记录格式无效');
        this.history = history.events.filter((event: EventRecord): boolean => {
          return event !== null && typeof event.id === 'string' && typeof event.time === 'string' &&
            typeof event.deviceId === 'string' && typeof event.kind === 'string' && typeof event.detail === 'string' && typeof event.requestId === 'string';
        }).slice(-10000);
        this.transport.engine.restoreEvents(this.history);
      }
    } catch (error) { this.platformError = '读取本地记录失败：' + (error as Error).message; }
    const view = this.transport.engine.getView(); view.config = this.config; this.emit(view);
    return this.config;
  }
  async save(config: AppConfig): Promise<void> {
    checkConfig(config);
    try { this.writeJson(this.path('payload-config.json'), JSON.stringify(config, null, 2)); this.config = config; }
    catch (error) { this.platformError = '保存配置失败：' + (error as Error).message; this.emit(this.transport.engine.getView()); throw new Error((error as Error).message); }
  }
  async start(config: AppConfig): Promise<void> {
    if (this.disposed) throw new Error('页面已销毁');
    this.stop(); this.platformError = '';
    await this.save(config);
    this.transport.engine.start(config);
    this.timer = setInterval(() => this.transport.engine.tick(), 250);
  }
  private clearTick(): void { if (this.timer !== -1) { clearInterval(this.timer); this.timer = -1; } }
  stop(): void { this.clearTick(); this.transport.engine.stop(); this.flush(); }
  command(deviceId: string, actionId: string, value: Value): void { this.transport.engine.command(deviceId, actionId, value); }
  pause(value: boolean): void { this.transport.engine.setPaused(value); }
  fault(mode: string): void { this.transport.engine.setFault(mode); }
  private remember(event: EventRecord): void {
    this.history.push(event);
    if (this.history.length > 10000) this.history = this.history.slice(-10000);
    if (this.saveTimer === -1) this.saveTimer = setTimeout(() => { this.saveTimer = -1; this.flush(); }, 1000);
  }
  private flush(): void {
    if (this.saveTimer !== -1) { clearTimeout(this.saveTimer); this.saveTimer = -1; }
    const saved: SavedHistory = { schemaVersion: 1, events: this.history };
    try { this.writeJson(this.path('payload-history.json'), JSON.stringify(saved)); }
    catch (error) { this.platformError = '保存历史失败：' + (error as Error).message; this.emit(this.transport.engine.getView()); }
  }
  async exportLogs(): Promise<string> {
    this.flush();
    const data: ExportData = { schemaVersion: 1, exportedAt: new Date().toISOString(), simulated: true,
      config: this.config, view: this.transport.engine.getView(), events: this.history };
    const path = this.path('payload-export-' + Date.now() + '.json');
    this.writeJson(path, JSON.stringify(data, null, 2));
    hilog.info(0x0001, 'PayloadTerminal', 'EXPORT_PATH=%{public}s', path);
    return path;
  }
  dispose(): void { this.stop(); this.disposed = true; }
}
