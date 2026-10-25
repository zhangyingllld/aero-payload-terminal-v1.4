import dmApi from '@ohos.distributedDeviceManager';
import kvApi from '@ohos.data.distributedKVStore';
import abilityAccessCtrl from '@ohos.abilityAccessCtrl';
import util from '@ohos.util';
import hilog from '@ohos.hilog';
import type common from '@ohos.app.ability.common';
import type { BusinessError } from '@ohos.base';
import type { Role } from '../core/models';
import { TrialBook, trialKey, feedbackKey, newTrial, reviseTrial, makeFeedback, parseTrialRecord, sameTrialSession } from '../core/distributedTask';
import type { TrialTask, TrialFeedback, TrialRecord } from '../core/distributedTask';

const BUNDLE: string = 'com.eduoh.payloadterminal';
const STORE: string = 'aero_trial_v14';
export interface TrialPeer { id: string; name: string; selected: boolean; available: boolean; status: string; }
export interface DistributedView {
  enabled: boolean; busy: boolean; discovering: boolean; status: string; error: string; localLabel: string;
  localId: string; peers: TrialPeer[]; found: TrialPeer[]; tasks: TrialTask[]; current: TrialTask;
  feedback: TrialFeedback[]; logs: string[]; historical: boolean;
}
interface FoundEvent { device: dmApi.DeviceBasicInfo; }
interface StateEvent { action: dmApi.DeviceStateChange; device: dmApi.DeviceBasicInfo; }
interface FailureEvent { reason: number; }
interface BindResult { deviceId: string; status?: number; reason?: number; }
interface BindError extends BusinessError { reason?: number; errInfo?: string; status?: number; }
interface PendingPeer { deviceId: string; networkId: string; }
function emptyTask(): TrialTask {
  return { schema: 1, kind: 'task', group: '', creatorId: '', sessionId: '', revision: 0, title: '', createdAt: 0, updatedAt: 0 };
}
export function emptyDistributedView(): DistributedView {
  return { enabled: false, busy: false, discovering: false, status: '尚未启用', error: '', localLabel: '', localId: '',
    peers: [], found: [], tasks: [], current: emptyTask(), feedback: [], logs: [], historical: false };
}
export function shortDevice(id: string): string { return id.length > 8 ? id.slice(0, 8) : id; }
function errorText(error: BusinessError): string {
  return (typeof error.code === 'number' ? String(error.code) : '') + ' ' + (error.message || String(error));
}

// This service exclusively uses native DeviceManager + distributed KV. It never sends payload controls.
export class DistributedService {
  private dm: dmApi.DeviceManager | undefined = undefined;
  private manager: kvApi.KVManager | undefined = undefined;
  private store: kvApi.SingleKVStore | undefined = undefined;
  private book: TrialBook = new TrialBook();
  private view: DistributedView = emptyDistributedView();
  private selected: Set<string> = new Set<string>();
  private available: dmApi.DeviceBasicInfo[] = [];
  private found: dmApi.DeviceBasicInfo[] = [];
  private peers: TrialPeer[] = [];
  private currentKey: string = '';
  private pendingBindingId: string = '';
  private role: Role = 'observer';
  private nodeId: string = '';
  private closing: boolean = false;
  private writing: boolean = false;
  private pending: PendingPeer[] = [];
  private activeSync: PendingPeer | undefined = undefined;
  private completedSyncIds: Set<string> = new Set<string>();
  private pendingDone: Promise<void> = Promise.resolve();
  private pendingResolve: (() => void) | undefined = undefined;
  private warningTimer: number = -1;
  private discoveryTimer: number = -1;
  private operations: Promise<void> = Promise.resolve();
  private changed: (view: DistributedView) => void;

  constructor(changed: (view: DistributedView) => void) { this.changed = changed; }
  setIdentity(role: Role, nodeId: string): void { this.role = role; this.nodeId = nodeId; }
  private log(message: string): void {
    this.view.logs = [new Date().toLocaleTimeString() + ' ' + message].concat(this.view.logs).slice(0, 12);
    hilog.info(0x0001, 'AeroDistributed', '%{public}s', message);
  }
  private emit(): void {
    if (this.closing) return;
    const tasks = this.book.tasks();
    let current = tasks.find((t: TrialTask) => trialKey(t) === this.currentKey);
    if (!current && tasks.length > 0) { current = tasks[0]; this.currentKey = trialKey(current); }
    this.view.current = current || emptyTask();
    this.view.tasks = tasks;
    this.view.feedback = current ? this.book.feedbackFor(current) : [];
    this.view.historical = current ? !this.book.isLatest(current) : false;
    this.view.busy = this.writing || this.pending.length > 0;
    this.view.peers = this.peers.map((peer: TrialPeer): TrialPeer => ({ id: peer.id, name: peer.name, selected: this.selected.has(peer.id), available: peer.available, status: peer.status }));
    this.view.found = this.found.map((device: dmApi.DeviceBasicInfo): TrialPeer => ({ id: device.deviceId, name: device.deviceName.slice(0, 60), selected: false, available: false, status: '尚未配对' }));
    this.changed({ enabled: this.view.enabled, busy: this.view.busy, discovering: this.view.discovering,
      status: this.view.status, error: this.view.error, localLabel: this.view.localLabel, localId: this.view.localId,
      peers: this.view.peers, found: this.view.found, tasks: this.view.tasks, current: this.view.current,
      feedback: this.view.feedback, logs: this.view.logs.slice(), historical: this.view.historical });
  }
  private fail(message: string, error: BusinessError): void { this.view.error = message + '：' + errorText(error); this.log(this.view.error); this.emit(); }

  async enable(context: common.UIAbilityContext): Promise<void> {
    if (this.writing || this.view.enabled || this.closing) return;
    this.writing = true; this.view.error = ''; this.view.status = '正在申请分布式权限'; this.emit();
    this.operations = this.initialize(context);
    await this.operations;
    this.writing = false; this.emit();
  }
  private async initialize(context: common.UIAbilityContext): Promise<void> {
    try {
      const result = await abilityAccessCtrl.createAtManager().requestPermissionsFromUser(context, ['ohos.permission.DISTRIBUTED_DATASYNC']);
      if (this.closing) return;
      if (result.authResults.length !== 1 || result.authResults[0] !== 0) {
        this.view.status = '未获得授权'; this.view.error = '请允许分布式数据同步权限后重试；载荷功能仍可使用。'; return;
      }
      this.dm = dmApi.createDeviceManager(BUNDLE);
      this.view.localId = this.dm.getLocalDeviceId();
      this.view.localLabel = this.dm.getLocalDeviceName().slice(0, 60) + ' · ' + shortDevice(this.view.localId);
      this.dm.on('discoverSuccess', this.onFound);
      this.dm.on('discoverFailure', this.onDiscoverFailure);
      this.dm.on('deviceStateChange', this.onDeviceState);
      this.manager = kvApi.createKVManager({ context: context, bundleName: BUNDLE });
      const options: kvApi.Options = { createIfMissing: true, encrypt: true, backup: false, autoSync: false,
        kvStoreType: kvApi.KVStoreType.SINGLE_VERSION, securityLevel: kvApi.SecurityLevel.S1 };
      this.store = await this.manager.getKVStore<kvApi.SingleKVStore>(STORE, options);
      if (this.closing) return;
      this.store.on('dataChange', kvApi.SubscribeType.SUBSCRIBE_TYPE_REMOTE, this.onRemote);
      this.store.on('syncComplete', this.onSyncComplete);
      await this.loadRecords();
      await this.pruneOwnedHistory();
      this.view.enabled = true; this.view.status = '已启用，请选择本组可信设备';
      this.refreshPeers();
      this.log('已打开 OpenHarmony 分布式 KV；记录为已配对同应用成员自报，本机 ' + shortDevice(this.view.localId));
    } catch (error) {
      this.fail('启用失败', error as BusinessError);
      await this.releaseResources();
      this.view.status = '启用失败，可以重试';
    }
  }
  private onFound = (event: FoundEvent): void => {
    if (this.closing || !event.device || event.device.deviceId === this.view.localId) return;
    if (this.available.some((item: dmApi.DeviceBasicInfo) => item.deviceId === event.device.deviceId)) return;
    if (!this.found.some((item: dmApi.DeviceBasicInfo) => item.deviceId === event.device.deviceId) && this.found.length < 20) {
      this.found.push(event.device); this.log('发现设备 ' + shortDevice(event.device.deviceId)); this.emit();
    }
  };
  private onDiscoverFailure = (event: FailureEvent): void => {
    if (this.closing) return;
    this.view.discovering = false; this.view.error = '发现失败，代码 ' + event.reason; this.log(this.view.error); this.emit();
  };
  private onDeviceState = (_event: StateEvent): void => { if (!this.closing) this.refreshPeers(); };
  discover(): void {
    if (!this.dm || !this.view.enabled || this.closing) return;
    try {
      this.stopDiscovery(); this.found = []; this.view.error = '';
      const options: Record<string, number> = { 'discoverTargetType': 1 };
      this.dm.startDiscovering(options); this.view.discovering = true;
      this.view.status = '正在发现设备；请只配对本组开发板';
      this.discoveryTimer = setTimeout(() => { this.stopDiscovery(); this.emit(); }, 110000);
      this.emit();
    } catch (error) { this.fail('发现失败', error as BusinessError); }
  }
  private stopDiscovery(): void {
    if (this.discoveryTimer >= 0) { clearTimeout(this.discoveryTimer); this.discoveryTimer = -1; }
    if (this.dm && this.view.discovering) { try { this.dm.stopDiscovering(); } catch (_) {} }
    this.view.discovering = false;
  }
  bind(id: string): void {
    if (!this.dm || !this.found.some((item: dmApi.DeviceBasicInfo) => item.deviceId === id) || this.closing) return;
    try {
      const options: Record<string, Object> = { 'bindType': 1, 'targetPkgName': BUNDLE, 'appName': '航空试验协同',
        'appOperation': '共享本组试验任务和准备反馈', 'customDescription': '请确认目标是本组开发板' };
      this.pendingBindingId = id;
      this.view.error = ''; this.view.status = '请按系统提示完成两台设备的 PIN 配对'; this.emit();
      this.dm.bindTarget(id, options, (error: BusinessError, result: BindResult) => {
        if (this.closing) return;
        // Some images return {code: 0, reason: nonzero, errInfo: ...} for an authentication failure.
        // The public d.ts only declares deviceId; neither a zero code nor an extra status proves trust.
        const detail = error as BindError;
        const reason = detail && typeof detail.reason === 'number' ? detail.reason :
          (result && typeof result.reason === 'number' ? result.reason : 0);
        const status = result && typeof result.status === 'number' ? result.status :
          (detail && typeof detail.status === 'number' ? detail.status : 0);
        if ((error && error.code !== 0) || reason !== 0 || status < 0) {
          this.pendingBindingId = '';
          this.view.status = '配对未完成';
          this.view.error = '配对失败：代码 ' + (error ? String(error.code) : '无') + '，原因 ' + reason + '，状态 ' + status;
          if (detail && (detail.errInfo || detail.message)) this.view.error += '；' + (detail.errInfo || detail.message).slice(0, 240);
          this.log(this.view.error); this.emit(); return;
        }
        this.log('配对回调已返回 ' + shortDevice(id) + '，等待可用设备列表确认');
        this.view.status = '配对回调已返回，尚需确认目标设备可信可用'; this.refreshPeers();
      });
    } catch (error) { this.pendingBindingId = ''; this.fail('配对失败', error as BusinessError); }
  }
  refreshPeers(): void {
    if (!this.dm || this.closing) return;
    try {
      this.available = this.dm.getAvailableDeviceListSync().filter((item: dmApi.DeviceBasicInfo) => item.deviceId !== this.view.localId && !!item.networkId);
      for (const peer of this.peers) peer.available = false;
      for (const device of this.available) {
        const old = this.peers.find((item: TrialPeer) => item.id === device.deviceId);
        if (old) { old.available = true; old.name = device.deviceName.slice(0, 60); }
        else this.peers.push({ id: device.deviceId, name: device.deviceName.slice(0, 60), selected: false, available: true, status: '尚未同步' });
      }
      this.found = this.found.filter((item: dmApi.DeviceBasicInfo) => !this.available.some((device: dmApi.DeviceBasicInfo) => item.deviceId === device.deviceId));
      if (this.pendingBindingId && this.available.some((item: dmApi.DeviceBasicInfo) => item.deviceId === this.pendingBindingId)) {
        this.log('已从可用设备列表确认可信设备 ' + shortDevice(this.pendingBindingId));
        this.view.status = '已确认目标设备可信可用，请主动选择后同步';
        this.pendingBindingId = '';
      }
      this.emit();
    } catch (error) { this.fail('刷新可信设备失败', error as BusinessError); }
  }
  togglePeer(id: string): void {
    if (this.pending.length > 0 || this.closing) return;
    const peer = this.peers.find((item: TrialPeer) => item.id === id);
    if (!peer) return;
    if (this.selected.has(id)) this.selected.delete(id);
    else if (peer.available && this.selected.size < 5) this.selected.add(id);
    this.emit();
  }
  selectTask(key: string): void {
    if (this.book.tasks().some((task: TrialTask) => trialKey(task) === key)) { this.currentKey = key; this.emit(); }
  }
  private async loadRecords(): Promise<void> {
    if (!this.store) return;
    const entries = await this.store.getEntries('trial/');
    // Invalid records are isolated rather than preventing all other records from loading.
    if (Array.isArray(entries)) for (const entry of entries) this.readEntry(entry);
  }
  private unpackEntry(entry: kvApi.Entry): TrialRecord {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.key !== 'string' ||
      !entry.value || typeof entry.value !== 'object' || Array.isArray(entry.value) || typeof entry.value.value !== 'string') {
      throw new Error('KV 记录包装字段无效');
    }
    return parseTrialRecord(entry.key, entry.value.value as string);
  }
  private readEntry(entry: kvApi.Entry): void {
    try {
      const record = this.unpackEntry(entry);
      const accepted = this.book.accept(entry.key, JSON.stringify(record));
      // Only a newly received higher revision advances the current session. Selecting history remains possible.
      if (accepted && record.kind === 'task') {
        const task = record as TrialTask;
        const current = this.view.current;
        if (current.sessionId && sameTrialSession(task, current) && task.revision > current.revision) {
          const latest = this.book.latestFor(task);
          if (latest) this.currentKey = trialKey(latest);
        }
      }
    }
    catch (error) { this.log('已忽略无效或冲突记录：' + (error as Error).message); }
  }
  private onRemote = (change: kvApi.ChangeNotification): void => {
    if (this.closing) return;
    if (!change || typeof change !== 'object') { this.log('已忽略无效 KV 通知'); this.emit(); return; }
    if (Array.isArray(change.insertEntries)) for (const entry of change.insertEntries) this.readEntry(entry);
    if (Array.isArray(change.updateEntries)) for (const entry of change.updateEntries) this.readEntry(entry);
    const source = typeof change.deviceId === 'string' && change.deviceId.length > 0 ? shortDevice(change.deviceId) : '系统未提供';
    this.log('收到原生 KV 变更（通知来源 ' + source + '）；内容为已配对同应用成员自报');
    this.view.status = '收到成员自报记录，请核对任务标题与版本；不代表实体载荷已准备'; this.emit();
  };
  private async write(key: string, serialized: string): Promise<void> {
    if (!this.store || this.closing) throw new Error('分布式服务尚未启用');
    await this.store.put(key, serialized);
    this.book.accept(key, serialized);
    for (const peer of this.peers) if (this.selected.has(peer.id)) peer.status = '本地有更新，待同步';
    this.view.status = '已保存在本机，请点击同步选定设备';
  }
  private async perform(work: () => Promise<void>): Promise<void> {
    if (!this.view.enabled || this.writing || this.pending.length > 0 || this.closing) return;
    this.writing = true; this.view.error = ''; this.emit();
    this.operations = work().catch((error: BusinessError) => { this.fail('操作未完成', error); });
    await this.operations;
    this.writing = false; this.emit();
  }
  async createTask(group: string, title: string): Promise<void> {
    await this.perform(async () => {
      const task = newTrial(this.role, this.view.localId, group, title, util.generateRandomUUID(true), Date.now());
      await this.write(trialKey(task), JSON.stringify(task)); this.currentKey = trialKey(task);
      this.log('新建试验任务 ' + task.sessionId.slice(0, 8) + '，版本 1');
      await this.pruneOwnedHistory();
    });
  }
  async revise(title: string): Promise<void> {
    await this.perform(async () => {
      if (!this.book.isLatest(this.view.current)) throw new Error('当前为历史版本，请选择最新版本后修订');
      const task = reviseTrial(this.view.current, this.role, this.view.localId, title, Date.now());
      await this.write(trialKey(task), JSON.stringify(task)); this.currentKey = trialKey(task);
      this.log('修订任务，版本 ' + task.revision + '；原准备反馈不会计入新版本');
      await this.pruneOwnedHistory();
    });
  }
  async ready(value: boolean): Promise<void> {
    await this.perform(async () => {
      const current = this.view.current;
      if (!current.sessionId) throw new Error('请先选择试验任务');
      if (!this.book.isLatest(current)) throw new Error('当前为历史版本，不能提交准备反馈，请选择最新版本');
      const old = this.book.feedbackFor(current).find((item: TrialFeedback) => item.memberId === this.view.localId);
      const feedback = makeFeedback(current, this.view.localId, this.role, this.nodeId, value, old ? old.sequence : 0, Date.now());
      await this.write(feedbackKey(feedback), JSON.stringify(feedback));
      this.log('本机自报' + (value ? '已准备' : '取消准备') + '，任务版本 ' + current.revision + '；不代表实物核验');
      await this.pruneOwnedHistory();
    });
  }
  private async pruneOwnedHistory(): Promise<void> {
    if (!this.store) return;
    const entries = await this.store.getEntries('trial/');
    const ownedTasks: TrialTask[] = [];
    const ownedFeedback: TrialFeedback[] = [];
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      try {
        const record = this.unpackEntry(entry);
        if (record.kind === 'task' && record.creatorId === this.view.localId) ownedTasks.push(record as TrialTask);
        if (record.kind === 'ready' && (record as TrialFeedback).memberId === this.view.localId) ownedFeedback.push(record as TrialFeedback);
      } catch (_) {}
    }
    ownedTasks.sort((a: TrialTask, b: TrialTask) => b.updatedAt - a.updatedAt || b.revision - a.revision || trialKey(a).localeCompare(trialKey(b)));
    for (const old of ownedTasks.slice(20)) {
      await this.store.delete(trialKey(old));
    }
    // Feedback about other creators' tasks is still owned by its reporting member and must also be bounded.
    // Never remove a different member's records, even when this device prunes its own old task version.
    ownedFeedback.sort((a: TrialFeedback, b: TrialFeedback) => b.updatedAt - a.updatedAt || b.sequence - a.sequence || feedbackKey(a).localeCompare(feedbackKey(b)));
    for (const old of ownedFeedback.slice(200)) {
      await this.store.delete(feedbackKey(old));
    }
  }
  sync(): void {
    if (!this.store || !this.dm || !this.view.enabled || this.writing || this.pending.length > 0 || this.closing) return;
    this.refreshPeers(); this.view.error = '';
    const targets: PendingPeer[] = [];
    for (const peer of this.peers) {
      if (!this.selected.has(peer.id)) continue;
      const device = this.available.find((item: dmApi.DeviceBasicInfo) => item.deviceId === peer.id);
      if (!device || !device.networkId) { peer.status = '失败：设备不在线'; continue; }
      targets.push({ deviceId: peer.id, networkId: device.networkId }); peer.status = '等待逐台同步';
    }
    if (targets.length === 0) { this.view.error = '请先选中至少一台在线的本组可信设备'; this.emit(); return; }
    this.pending = targets;
    this.completedSyncIds.clear();
    this.pendingDone = new Promise<void>((resolve: () => void) => { this.pendingResolve = resolve; });
    this.log('发起 OpenHarmony KV 逐台双向同步，目标数 ' + targets.length);
    this.startNextSync();
  }
  private startNextSync(): void {
    if (this.activeSync || !this.store) return;
    if (this.pending.length === 0 || this.closing) { this.finishPending(); return; }
    const target = this.pending[0];
    const peer = this.peers.find((item: TrialPeer) => item.id === target.deviceId);
    // Query network ID again when this peer's turn begins: a queued device may have reconnected meanwhile.
    try {
      if (this.dm) {
        const device = this.dm.getAvailableDeviceListSync().find((item: dmApi.DeviceBasicInfo) => item.deviceId === target.deviceId && !!item.networkId);
        if (!device || !device.networkId) throw new Error('选定设备已离线');
        target.networkId = device.networkId;
      }
    } catch (error) {
      if (peer) peer.status = '同步未发起：' + errorText(error as BusinessError);
      this.pending.shift(); this.startNextSync(); this.emit(); return;
    }
    this.activeSync = target;
    if (peer) peer.status = '正在同步';
    this.view.status = '正在逐台同步，当前目标 ' + shortDevice(target.deviceId);
    this.view.error = '';
    this.warningTimer = setTimeout(() => {
      if (!this.activeSync) return;
      if (peer) peer.status = '等待系统结果，当前结果未知';
      this.view.error = '系统同步尚未返回，结果未知。请等待系统返回；长期无返回请退出并重新启动当前应用。不会重试或继续下一台。';
      this.emit();
    }, 30000);
    try {
      // The tested image returns an opaque KV identifier, distinct from DM deviceId/networkId.
      // With autoSync=false and one local request on this handle, one result belongs to this sole request.
      // Never infer a mapping from array position in a request containing multiple peers.
      this.store.sync([target.networkId], kvApi.SyncMode.PUSH_PULL, 0);
      this.emit();
    } catch (error) {
      this.clearSyncWarning(); this.activeSync = undefined;
      if (peer) peer.status = '同步未发起：' + errorText(error as BusinessError);
      this.log('目标 ' + shortDevice(target.deviceId) + ' 的同步未发起：' + errorText(error as BusinessError));
      this.pending.shift(); this.startNextSync(); this.emit();
    }
  }
  private onSyncComplete = (results: Array<[string, number]>): void => {
    if (!this.activeSync) return;
    if (!Array.isArray(results) || results.length !== 1 || !Array.isArray(results[0]) || results[0].length !== 2 ||
      typeof results[0][0] !== 'string' || results[0][0].length === 0 || !Number.isSafeInteger(results[0][1])) {
      this.view.error = '系统未返回唯一有效同步结果，当前结果未知。请等待；长期无返回请退出并重新启动当前应用。';
      this.log('忽略不能唯一归属当前请求的同步回调'); this.emit(); return;
    }
    const result = results[0];
    if (this.completedSyncIds.has(result[0])) { this.log('忽略本批已完成目标的重复回调 ' + shortDevice(result[0])); this.emit(); return; }
    const target = this.activeSync;
    const peer = this.peers.find((item: TrialPeer) => item.id === target.deviceId);
    if (peer) peer.status = result[1] === 0 ? 'KV 同步完成（不代表对端已查看）' : '同步失败，代码 ' + result[1];
    this.log('唯一在途目标 ' + shortDevice(target.deviceId) + '；KV 返回标识 ' + shortDevice(result[0]) + '；结果 ' + result[1]);
    this.completedSyncIds.add(result[0]);
    this.clearSyncWarning(); this.activeSync = undefined; this.pending.shift(); this.view.error = '';
    if (this.pending.length === 0 || this.closing) {
      this.finishPending(); this.view.status = '同步已返回；准备情况以成员自报反馈为准，未核验实体载荷';
    } else { this.startNextSync(); }
    this.emit();
  };
  private clearSyncWarning(): void {
    if (this.warningTimer >= 0) { clearTimeout(this.warningTimer); this.warningTimer = -1; }
  }
  private finishPending(): void {
    this.clearSyncWarning(); this.activeSync = undefined;
    this.pending = [];
    if (this.pendingResolve) this.pendingResolve();
    this.pendingResolve = undefined;
  }
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true; this.stopDiscovery();
    // Do not close a KV handle while asynchronous writes or a native sync are still running.
    await this.operations;
    await this.pendingDone;
    await this.releaseResources();
  }
  private async releaseResources(): Promise<void> {
    this.stopDiscovery();
    if (this.dm) {
      try { this.dm.off('discoverSuccess', this.onFound); this.dm.off('discoverFailure', this.onDiscoverFailure); this.dm.off('deviceStateChange', this.onDeviceState); } catch (_) {}
      try { dmApi.releaseDeviceManager(this.dm); } catch (_) {}
      this.dm = undefined;
    }
    if (this.store) {
      try { this.store.off('dataChange', this.onRemote); this.store.off('syncComplete', this.onSyncComplete); } catch (_) {}
      if (this.manager) { try { await this.manager.closeKVStore(BUNDLE, STORE); } catch (error) { this.log('关闭本地库失败：' + errorText(error as BusinessError)); } }
      this.store = undefined;
    }
    this.manager = undefined; this.view.enabled = false;
  }
}
