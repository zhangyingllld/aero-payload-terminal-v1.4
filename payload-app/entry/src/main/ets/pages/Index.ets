import type common from '@ohos.app.ability.common';
import { defaultConfig, initialView } from '../core/models';
import type { ActionSpec, AppConfig, AppView, EventRecord, MetricSpec, PayloadView, Reading, Role, Value } from '../core/models';
import { AppRuntime } from '../platform/AppRuntime';
import { DistributedPanel } from '../components/DistributedPanel';
import { AiAssistantPanel } from '../components/AiAssistantPanel';
import { AiSettings } from '../platform/AiSettings';

interface BadgeParams {
  label: string;
  color: string;
}

interface TextFieldParams {
  label: string;
  value: string;
  placeholder: string;
  change: (text: string) => void;
}

interface HostFieldParams {
  label: string;
  host: string;
  port: string;
  hostChange: (text: string) => void;
  portChange: (text: string) => void;
}

// Remote views are generated from capability descriptors; device role affects setup only.
@Component
struct TrendLine {
  @Prop @Watch('redraw') samples: number[] = [];
  private context: CanvasRenderingContext2D = new CanvasRenderingContext2D(new RenderingContextSettings(true));
  private canvasWidth: number = 280;

  redraw(): void {
    const ctx = this.context;
    const width = this.canvasWidth;
    ctx.clearRect(0, 0, width, 76);
    ctx.strokeStyle = '#DCE8EB';
    ctx.lineWidth = 1;
    for (let row = 0; row < 3; row++) {
      ctx.beginPath();
      ctx.moveTo(0, 12 + row * 26);
      ctx.lineTo(width, 12 + row * 26);
      ctx.stroke();
    }
    if (this.samples.length < 2) { return; }
    let low = this.samples[0];
    let high = this.samples[0];
    for (let index = 1; index < this.samples.length; index++) {
      low = Math.min(low, this.samples[index]);
      high = Math.max(high, this.samples[index]);
    }
    const padding = Math.max((high - low) * 0.15, 0.5);
    low -= padding;
    high += padding;
    ctx.beginPath();
    for (let index = 0; index < this.samples.length; index++) {
      const x = 3 + index * (width - 6) / (this.samples.length - 1);
      const y = 67 - (this.samples[index] - low) * 58 / (high - low);
      if (index === 0) { ctx.moveTo(x, y); } else { ctx.lineTo(x, y); }
    }
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#007F83';
    ctx.stroke();
  }

  build() {
    Canvas(this.context).width('100%').height(76)
      .onReady(() => { this.redraw(); })
      .onAreaChange((_oldArea: Area, newArea: Area) => {
        this.canvasWidth = Number(newArea.width);
        this.redraw();
      })
      .accessibilityText('模拟指标近期变化趋势；纵轴按当前数据范围缩放')
  }
}

@Entry
@Component
struct Index {
  @State view: AppView = initialView();
  @State config: AppConfig = defaultConfig('controller');
  @State listenPortText: string = '43181';
  @State controllerPortText: string = '43181';
  @State cameraPortText: string = '43180';
  @State environmentPortText: string = '43180';
  @State lightPortText: string = '43180';
  @State loaded: boolean = false;
  @State busy: boolean = false;
  @State showConfig: boolean = false;
  @State showMaintenance: boolean = false;
  @State selectedPayloadId: string = 'CAM-01';
  @State selectedTab: string = 'devices';
  @State notice: string = '';
  @State maintenanceNotice: string = '';
  @State aiProxyToken: string = '';
  private aiSettings: AiSettings | null = null;
  private runtime: AppRuntime | null = null;
  private mounted: boolean = false;
  private roles: Role[] = ['controller', 'observer', 'camera', 'environment', 'light'];

  aboutToAppear(): void {
    this.mounted = true;
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    this.aiSettings = new AiSettings(context);
    try { this.aiProxyToken = this.aiSettings.load(); } catch (_error) { this.notice = 'AI 连接口令未能读取，可在试验助手中重新填写。'; }
    this.runtime = new AppRuntime(context, (view: AppView) => {
      if (this.mounted) { this.view = view; }
    });
    this.loadConfiguration();
  }

  aboutToDisappear(): void {
    this.mounted = false;
    if (this.runtime !== null) { this.runtime.dispose(); }
    this.runtime = null;
  }

  saveAiToken(value: string): void {
    try {
      if (this.aiSettings !== null) { this.aiSettings.save(value); this.aiProxyToken = value.trim(); }
    } catch (_error) { this.notice = 'AI 连接口令保存失败，请重试。'; }
  }

  async loadConfiguration(): Promise<void> {
    const runtime = this.runtime;
    if (runtime === null) { return; }
    try {
      const config = await runtime.load();
      if (this.mounted) { this.applyConfiguration(config); }
    } catch (error) {
      if (this.mounted) { this.notice = '读取配置失败：' + (error as Error).message; }
    } finally {
      if (this.mounted) { this.loaded = true; }
    }
  }

  applyConfiguration(config: AppConfig): void {
    this.config = config;
    this.listenPortText = String(config.listenPort);
    this.controllerPortText = String(config.controllerPort);
    this.cameraPortText = String(config.cameraPort);
    this.environmentPortText = String(config.environmentPort);
    this.lightPortText = String(config.lightPort);
  }

  selectRole(index: number): void {
    if (this.view.running || index < 0 || index >= this.roles.length) { return; }
    this.applyConfiguration(defaultConfig(this.roles[index]));
    const empty = initialView();
    empty.config = this.config;
    empty.events = this.view.events;
    this.view = empty;
    this.notice = '已选择' + this.roleLabel(this.config.role) + '；请核对本机编号和局域网地址。';
  }

  roleLabel(role: Role): string {
    if (role === 'controller') { return '1 主操作'; }
    if (role === 'observer') { return '2 只读监看'; }
    if (role === 'camera') { return '3 图像载荷'; }
    if (role === 'environment') { return '4 环境载荷'; }
    return '5 照明载荷';
  }

  roleDescription(): string {
    if (this.config.role === 'controller') { return '连接三台载荷，按上报能力操作，并向监看端提供状态。'; }
    if (this.config.role === 'observer') { return '连接主操作端，仅接收状态、指标与事件。'; }
    return '在本机运行模拟载荷，等待主操作端连接。';
  }

  isTerminal(): boolean { return this.config.role === 'controller' || this.config.role === 'observer'; }

  readPort(text: string): number {
    const value = Number(text);
    return text.trim().length > 0 && Number.isInteger(value) && value >= 1024 && value <= 65535 ? value : 0;
  }

  prepareConfiguration(): boolean {
    const listen = this.readPort(this.listenPortText);
    const controller = this.readPort(this.controllerPortText);
    const camera = this.readPort(this.cameraPortText);
    const environment = this.readPort(this.environmentPortText);
    const light = this.readPort(this.lightPortText);
    if (this.config.nodeId.trim().length === 0) {
      this.notice = '请输入本机节点编号。';
      return false;
    }
    if (listen === 0 || controller === 0 || camera === 0 || environment === 0 || light === 0) {
      this.notice = '端口必须为 1024–65535 的整数。';
      return false;
    }
    if (this.config.role === 'controller' && (this.config.cameraHost.trim().length === 0 ||
      this.config.environmentHost.trim().length === 0 || this.config.lightHost.trim().length === 0)) {
      this.notice = '请填写三台载荷的局域网地址。';
      return false;
    }
    if (this.config.role === 'observer' && this.config.controllerHost.trim().length === 0) {
      this.notice = '请填写主操作端的局域网地址。';
      return false;
    }
    this.config.nodeId = this.config.nodeId.trim();
    this.config.controllerHost = this.config.controllerHost.trim();
    this.config.cameraHost = this.config.cameraHost.trim();
    this.config.environmentHost = this.config.environmentHost.trim();
    this.config.lightHost = this.config.lightHost.trim();
    this.config.listenPort = listen;
    this.config.controllerPort = controller;
    this.config.cameraPort = camera;
    this.config.environmentPort = environment;
    this.config.lightPort = light;
    return true;
  }

  async saveConfiguration(): Promise<void> {
    const runtime = this.runtime;
    if (runtime === null || this.busy || !this.prepareConfiguration()) { return; }
    this.busy = true;
    try {
      await runtime.save(this.config);
      if (this.mounted) { this.notice = '配置已保存到本机。'; }
    } catch (error) {
      if (this.mounted) { this.notice = '保存失败：' + (error as Error).message; }
    } finally {
      if (this.mounted) { this.busy = false; }
    }
  }

  async start(): Promise<void> {
    const runtime = this.runtime;
    if (runtime === null || this.busy || !this.prepareConfiguration()) { return; }
    this.busy = true;
    this.notice = '';
    try {
      await runtime.start(this.config);
      if (this.mounted && this.view.running) { this.showConfig = false; }
    } catch (error) {
      if (this.mounted) { this.notice = '启动失败：' + (error as Error).message; }
    } finally {
      if (this.mounted) { this.busy = false; }
    }
  }

  stop(): void {
    if (this.runtime !== null) { this.runtime.stop(); }
    this.notice = '连接已停止，可修改角色与配置。';
  }

  async exportLogs(): Promise<void> {
    const runtime = this.runtime;
    if (runtime === null || this.busy) { return; }
    this.busy = true;
    try {
      const path = await runtime.exportLogs();
      if (this.mounted) { this.maintenanceNotice = '日志已导出到本机沙箱：' + path + '。按部署手册用 hdc 提取。'; }
    } catch (error) {
      if (this.mounted) { this.maintenanceNotice = '导出失败：' + (error as Error).message; }
    } finally {
      if (this.mounted) { this.busy = false; }
    }
  }

  linkLabel(state: string): string {
    if (state === 'READY') { return '已就绪'; }
    if (state === 'CONNECTING') { return '连接中'; }
    if (state === 'NEGOTIATING') { return '能力协商中'; }
    if (state === 'STALE') { return '数据过期'; }
    if (state === 'OFFLINE') { return '已离线'; }
    if (state === 'INCOMPATIBLE') { return '版本不兼容'; }
    return '未连接';
  }

  stateColor(state: string): string {
    if (state === 'READY' || state === 'completed') { return '#007A70'; }
    if (state === 'STALE' || state === 'unknown' || state === 'waiting' || state === 'accepted') { return '#986000'; }
    if (state === 'OFFLINE' || state === 'INCOMPATIBLE' || state === 'failed' || state === 'rejected') { return '#B5473E'; }
    return '#647587';
  }

  commandLabel(status: string): string {
    if (status === 'waiting') { return '等待回执'; }
    if (status === 'accepted') { return '已受理'; }
    if (status === 'completed') { return '执行完成'; }
    if (status === 'failed') { return '执行失败'; }
    if (status === 'rejected') { return '已拒绝'; }
    if (status === 'unknown') { return '结果未确认'; }
    return '暂无命令';
  }

  // ForEach retains children with the same key. Resolve the immutable snapshot
  // through @State on every render/event, instead of capturing the first item.
  currentPayload(payload: PayloadView): PayloadView {
    if (this.view.local.deviceId === payload.deviceId) { return this.view.local; }
    for (let index = 0; index < this.view.payloads.length; index++) {
      if (this.view.payloads[index].deviceId === payload.deviceId) { return this.view.payloads[index]; }
    }
    return payload;
  }

  findReading(payload: PayloadView, id: string): Reading | null {
    const current = this.currentPayload(payload);
    for (let index = 0; index < current.readings.length; index++) {
      if (current.readings[index].id === id) { return current.readings[index]; }
    }
    return null;
  }

  readingValue(payload: PayloadView, spec: MetricSpec): string {
    const reading = this.findReading(payload, spec.id);
    if (reading === null) { return '—'; }
    if (typeof reading.value === 'boolean') { return reading.value ? '开启' : '关闭'; }
    if (typeof reading.value === 'number') {
      return Number.isInteger(reading.value) ? String(reading.value) : reading.value.toFixed(1);
    }
    if (spec.id === 'mode' && reading.value === 'single') { return '单次'; }
    if (spec.id === 'mode' && reading.value === 'continuous') { return '连续'; }
    return String(reading.value);
  }

  readingIsFresh(payload: PayloadView, spec: MetricSpec): boolean {
    const reading = this.findReading(payload, spec.id);
    return reading !== null && reading.ageMs >= 0 && reading.ageMs <= spec.validForMs &&
      (this.currentPayload(payload).linkState === 'READY' || this.currentPayload(payload).linkState === 'STALE');
  }

  freshnessLabel(payload: PayloadView, spec: MetricSpec): string {
    const reading = this.findReading(payload, spec.id);
    if (reading === null) { return '未知 · 尚未收到数据'; }
    const age = reading.ageMs < 1000 ? '<1 秒' : String(Math.floor(reading.ageMs / 1000)) + ' 秒';
    return (this.readingIsFresh(payload, spec) ? '已更新 · ' : '过期 · ') + age + '前';
  }

  controlValue(payload: PayloadView, action: ActionSpec): Value {
    const reading = this.findReading(payload, action.boundMetricId);
    if (reading !== null) { return reading.value; }
    if (action.options.length > 0) { return action.options[0].value; }
    if (action.valueType === 'boolean') { return false; }
    if (action.valueType === 'number') { return action.min; }
    return '';
  }

  controlNumber(payload: PayloadView, action: ActionSpec): number {
    const value = this.controlValue(payload, action);
    return typeof value === 'number' ? Math.max(action.min, Math.min(action.max, value)) : action.min;
  }

  selectOptions(action: ActionSpec): SelectOption[] {
    const options: SelectOption[] = [];
    for (let index = 0; index < action.options.length; index++) { options.push({ value: action.options[index].label }); }
    return options;
  }

  selectedOption(payload: PayloadView, action: ActionSpec): number {
    const value = this.controlValue(payload, action);
    for (let index = 0; index < action.options.length; index++) {
      if (action.options[index].value === value) { return index; }
    }
    return -1;
  }

  optionLabel(payload: PayloadView, action: ActionSpec): string {
    const index = this.selectedOption(payload, action);
    return index < 0 ? '选择参数' : action.options[index].label;
  }

  canCommand(payload: PayloadView): boolean {
    const current = this.currentPayload(payload);
    return this.config.role === 'controller' && this.view.running && current.linkState === 'READY' &&
      current.lastCommand.status !== 'waiting' && current.lastCommand.status !== 'accepted';
  }

  sendCommand(payload: PayloadView, action: ActionSpec, value: Value): void {
    if (this.runtime !== null && this.canCommand(payload)) { this.runtime.command(payload.deviceId, action.id, value); }
  }

  faultIndex(): number {
    if (this.view.fault === 'reject-next') { return 1; }
    if (this.view.fault === 'fail-next') { return 2; }
    if (this.view.fault === 'drop-next-result') { return 3; }
    return 0;
  }

  faultLabel(): string {
    if (this.view.fault === 'reject-next') { return '下一命令：拒绝受理'; }
    if (this.view.fault === 'fail-next') { return '下一命令：执行失败'; }
    if (this.view.fault === 'drop-next-result') { return '下一命令：丢弃最终回执'; }
    return '正常运行';
  }

  setFault(index: number): void {
    const modes: string[] = ['none', 'reject-next', 'fail-next', 'drop-next-result'];
    if (this.runtime !== null && index >= 0 && index < modes.length) { this.runtime.fault(modes[index]); }
  }

  readyCount(): number {
    let count = 0;
    for (let index = 0; index < this.view.payloads.length; index++) {
      if (this.view.payloads[index].linkState === 'READY') { count++; }
    }
    return count;
  }

  payloadLabel(id: string): string {
    if (id === 'CAM-01') { return '图像'; }
    if (id === 'ENV-01') { return '环境'; }
    return '照明';
  }

  payloadState(id: string): string {
    for (let index = 0; index < this.view.payloads.length; index++) {
      if (this.view.payloads[index].deviceId === id) { return this.view.payloads[index].linkState; }
    }
    return 'DISCONNECTED';
  }

  selectedPayloads(): PayloadView[] {
    return this.view.payloads.filter((payload: PayloadView): boolean => payload.deviceId === this.selectedPayloadId);
  }

  unknownDevices(): string {
    const ids: string[] = [];
    for (let index = 0; index < this.view.payloads.length; index++) {
      if (this.view.payloads[index].lastCommand.status === 'unknown') { ids.push(this.view.payloads[index].deviceId); }
    }
    if (!this.isTerminal() && this.view.local.lastCommand.status === 'unknown') { ids.push(this.view.local.deviceId); }
    return ids.join('、');
  }

  summaryText(): string {
    if (!this.view.running) { return '检查连接设置后启动本机。'; }
    if (this.config.role === 'observer') { return '只读接收主操作端的载荷状态与任务记录。'; }
    if (this.config.role === 'controller') { return '选择载荷查看状态与操作；未就绪设备不可控制。'; }
    return '模拟数据持续更新，等待主操作端指令。';
  }

  commandActionLabel(actionId: string): string {
    if (actionId === 'capture') { return '模拟抓拍'; }
    if (actionId === 'set_mode') { return '工作模式调整'; }
    if (actionId === 'set_interval') { return '采样间隔调整'; }
    if (actionId === 'set_power') { return '照明电源调整'; }
    if (actionId === 'set_brightness') { return '照明亮度调整'; }
    return '载荷操作';
  }

  eventLabel(kind: string): string {
    if (kind === 'started') { return '启动'; }
    if (kind === 'stopped') { return '停止'; }
    if (kind === 'connected') { return '连接建立'; }
    if (kind === 'connect-failed' || kind === 'offline') { return '连接中断'; }
    if (kind === 'paused') { return '通信暂停'; }
    if (kind === 'resumed') { return '通信恢复'; }
    if (kind === 'command') { return '操作发出'; }
    if (kind === 'simulation-fault' || kind === 'simulation-drop') { return '故障演示'; }
    if (kind === 'accepted' || kind === 'completed' || kind === 'failed' || kind === 'unknown' || kind === 'rejected') {
      return this.commandLabel(kind);
    }
    return '运行提示';
  }

  eventSummary(event: EventRecord): string {
    if (event.kind === 'started') { return '本机已启动。'; }
    if (event.kind === 'stopped') { return '本机已停止。'; }
    if (event.kind === 'connected') { return '设备连接已建立。'; }
    if (event.kind === 'connect-failed' || event.kind === 'offline') { return '设备暂不可用，请检查设备和网络。'; }
    if (event.kind === 'paused') { return '通信已暂停，数据将逐步过期。'; }
    if (event.kind === 'resumed') { return '通信已恢复，重新读取状态；历史操作不会自动重发。'; }
    if (event.kind === 'unknown') { return '未收到最终回执，请核对载荷状态，避免盲目重复操作。'; }
    if (event.kind === 'simulation-fault') { return '故障演示设置已更新，详情见运维工具。'; }
    if (event.kind === 'simulation-drop') { return '本次模拟动作已执行，最终回执被演示设置丢弃。'; }
    if (event.kind === 'command') { return this.commandActionLabel(event.detail.split(' = ')[0]) + '已发送，等待载荷确认。'; }
    if (event.kind === 'accepted' || event.kind === 'completed' || event.kind === 'failed' || event.kind === 'rejected') {
      return event.detail;
    }
    return '发现运行异常，详情见运维工具中的完整记录。';
  }

  recentEvents(): EventRecord[] {
    // Filter the display only; runtime history and exported evidence stay complete.
    const events: EventRecord[] = this.showMaintenance ? this.view.events :
      this.view.events.filter((event: EventRecord): boolean => event.kind !== 'connect-failed');
    return events.slice(-30).reverse();
  }

  @Builder
  badge(params: BadgeParams) {
    Text(params.label).fontSize(11).fontWeight(FontWeight.Medium).fontColor(params.color)
      .padding({ left: 8, right: 8, top: 5, bottom: 5 }).backgroundColor('#F1F5F6').borderRadius(6)
  }

  @Builder
  header() {
    Row({ space: 10 }) {
      Image($r('app.media.app_icon')).width(42).height(42).objectFit(ImageFit.Contain)
        .borderRadius(12).accessibilityText('航空载荷终端图标').id('appBrandIcon')
      Column({ space: 3 }) {
        Text('航空载荷终端').fontSize(21).fontWeight(FontWeight.Bold).fontColor('#122B40')
        Text('地面协同 · 模拟数据').fontSize(11).fontColor('#647587').letterSpacing(1)
      }.alignItems(HorizontalAlign.Start).layoutWeight(1)
      this.badge({ label: this.view.running ? '运行中' : '未启动', color: this.view.running ? '#007A70' : '#647587' })
    }.width('100%')
  }

  @Builder
  textField(params: TextFieldParams) {
    Column({ space: 5 }) {
      Text(params.label).fontSize(12).fontColor('#526678')
      TextInput({ text: params.value, placeholder: params.placeholder }).height(44).fontSize(14)
        .backgroundColor('#F2F6F8').borderRadius(8).fontColor('#122B40')
        .type(InputType.Number).maxLength(5).enabled(!this.view.running && !this.busy && this.loaded)
        .onChange((text: string) => { params.change(text); })
    }.width('100%').alignItems(HorizontalAlign.Start)
  }

  @Builder
  hostField(params: HostFieldParams) {
    Column({ space: 5 }) {
      Text(params.label).fontSize(12).fontColor('#526678')
      Row({ space: 8 }) {
        TextInput({ text: params.host, placeholder: '192.168.50.13' }).height(44).fontSize(14)
          .backgroundColor('#F2F6F8').borderRadius(8).fontColor('#122B40').layoutWeight(1)
          .maxLength(128).enabled(!this.view.running && !this.busy && this.loaded)
          .onChange((text: string) => { params.hostChange(text); })
        TextInput({ text: params.port, placeholder: '端口' }).width(86).height(44).fontSize(14)
          .type(InputType.Number).maxLength(5).backgroundColor('#F2F6F8').borderRadius(8).fontColor('#122B40')
          .enabled(!this.view.running && !this.busy && this.loaded)
          .onChange((text: string) => { params.portChange(text); })
      }.width('100%')
    }.width('100%').alignItems(HorizontalAlign.Start)
  }

  @Builder
  setupCard() {
    Column({ space: 10 }) {
      Row({ space: 6 }) {
        Column({ space: 4 }) {
          Text(this.roleLabel(this.config.role)).fontSize(14).fontWeight(FontWeight.Bold).fontColor('#122B40')
          Text(this.config.nodeId).fontSize(10).fontColor('#647587')
        }.alignItems(HorizontalAlign.Start).layoutWeight(1)
        Button(this.showConfig ? '收起设置' : '连接设置', { type: ButtonType.Normal })
          .height(40).fontSize(12).fontColor('#007F83').backgroundColor('#EAF5F4').borderRadius(8)
          .onClick(() => { this.showConfig = !this.showConfig; }).id('configToggle')
        Button(this.showMaintenance ? '收起运维' : '运维工具', { type: ButtonType.Normal })
          .height(40).fontSize(12).fontColor('#526678').backgroundColor('#F2F6F8').borderRadius(8)
          .onClick(() => { this.showMaintenance = !this.showMaintenance; }).id('maintenanceToggle')
        Button(this.busy ? '处理中…' : (this.view.running ? '停止连接' : '启动本机'), { type: ButtonType.Normal })
          .height(40).fontSize(12).fontWeight(FontWeight.Medium).borderRadius(8)
          .fontColor('#FFFFFF').backgroundColor(this.view.running ? '#526678' : '#007F83')
          .enabled(this.loaded && !this.busy)
          .onClick(() => { if (this.view.running) { this.stop(); } else { this.start(); } }).id('runToggle')
      }.width('100%')
      if (this.showConfig) {
        Select([{ value: '1 主操作' }, { value: '2 只读监看' }, { value: '3 图像载荷' },
          { value: '4 环境载荷' }, { value: '5 照明载荷' }])
          .selected(this.roles.indexOf(this.config.role)).value(this.roleLabel(this.config.role)).width('100%').height(44)
          .font({ size: 14 }).fontColor('#122B40').backgroundColor('#F2F6F8').borderRadius(8)
          .enabled(!this.view.running && !this.busy && this.loaded)
          .onSelect((index: number) => { this.selectRole(index); }).id('roleSelect')
        Text(this.roleDescription()).fontSize(12).fontColor('#647587').lineHeight(18).width('100%')
        Text('本机节点编号：' + this.config.nodeId + '（按角色固定）').fontSize(12).fontColor('#526678').width('100%')
        if (this.config.role === 'controller') {
          this.hostField({ label: '图像载荷 · 地址 / 端口', host: this.config.cameraHost, port: this.cameraPortText,
            hostChange: (text: string) => { this.config.cameraHost = text; }, portChange: (text: string) => { this.cameraPortText = text; } })
          this.hostField({ label: '环境载荷 · 地址 / 端口', host: this.config.environmentHost, port: this.environmentPortText,
            hostChange: (text: string) => { this.config.environmentHost = text; }, portChange: (text: string) => { this.environmentPortText = text; } })
          this.hostField({ label: '照明载荷 · 地址 / 端口', host: this.config.lightHost, port: this.lightPortText,
            hostChange: (text: string) => { this.config.lightHost = text; }, portChange: (text: string) => { this.lightPortText = text; } })
        } else if (this.config.role === 'observer') {
          this.hostField({ label: '主操作端 · 地址 / 端口', host: this.config.controllerHost, port: this.controllerPortText,
            hostChange: (text: string) => { this.config.controllerHost = text; }, portChange: (text: string) => { this.controllerPortText = text; } })
        }
        if (this.config.role !== 'observer') {
          this.textField({ label: this.config.role === 'controller' ? '本机监看服务端口' : '本机载荷服务端口',
            value: this.listenPortText, placeholder: '43180', change: (text: string) => { this.listenPortText = text; } })
        }
        Text(this.view.running ? '运行期间配置已锁定；停止连接后可修改。' : '地址为示例值，请改为各开发板的实际局域网 IP。')
          .fontSize(11).fontColor('#647587').lineHeight(17).width('100%')
        Button('保存配置', { type: ButtonType.Normal }).height(42).width('100%')
          .fontSize(14).fontColor('#007F83').backgroundColor('#EAF5F4').borderRadius(8)
          .enabled(this.loaded && !this.busy && !this.view.running)
          .onClick(() => { this.saveConfiguration(); }).id('saveConfiguration')
      }
    }.width('100%').padding(12).backgroundColor('#FFFFFF').borderRadius(14).alignItems(HorizontalAlign.Start)
  }

  @Builder
  connectionSummary() {
    Column({ space: 6 }) {
      Row() {
        Text(this.isTerminal() ? '任务连接' : '本机载荷').fontSize(14).fontWeight(FontWeight.Bold).fontColor('#FFFFFF')
          .layoutWeight(1)
        Text(this.isTerminal() ? String(this.readyCount()) + ' / ' + String(this.view.payloads.length) + ' 就绪' :
          (!this.view.running ? '未启动' : (this.view.paused ? '通信暂停' : '模拟运行'))).fontSize(12).fontColor('#A6E0DB')
      }.width('100%')
      Text(this.showMaintenance && this.view.status.length > 0 ? this.view.status : this.summaryText())
        .fontSize(11).fontColor('#C9D6E0').lineHeight(17).width('100%')
      if (this.config.role === 'observer') {
        Row({ space: 8 }) {
          Text('上游主操作端').fontSize(11).fontColor('#B8C9D6')
          Text(this.linkLabel(this.view.mainLinkState)).fontSize(12).fontWeight(FontWeight.Medium)
            .fontColor(this.view.mainLinkState === 'READY' ? '#8DDED2' : '#FFD598')
        }.width('100%')
      }
    }.width('100%').padding(12).borderRadius(14).backgroundColor('#122B40').alignItems(HorizontalAlign.Start)
  }

  @Builder
  operationalWarnings() {
    if (this.view.paused) {
      Text('通信已暂停 · 遥测与心跳停止，请在运维工具恢复通信。')
        .fontSize(12).fontColor('#866000').lineHeight(18).width('100%')
        .padding(10).backgroundColor('#FFF4D7').borderRadius(8).id('pausedWarning')
    }
    if (this.view.fault !== 'none') {
      Text('故障演示已启用 · ' + this.faultLabel())
        .fontSize(12).fontColor('#A43F36').lineHeight(18).width('100%')
        .padding(10).backgroundColor('#FFF0EC').borderRadius(8).id('faultWarning')
    }
    if (this.unknownDevices().length > 0) {
      Text(this.unknownDevices() + '：结果未确认。请核对当前状态，避免盲目重复操作。')
        .fontSize(12).fontColor('#866000').lineHeight(18).width('100%')
        .padding(10).backgroundColor('#FFF4D7').borderRadius(8).id('unknownWarning')
    }
  }

  @Builder
  payloadSelector() {
    Row({ space: 6 }) {
      ForEach(['CAM-01', 'ENV-01', 'LIGHT-01'], (id: string) => {
        Button({ type: ButtonType.Normal }) {
          Column({ space: 3 }) {
            Text(this.payloadLabel(id)).fontSize(13).fontWeight(FontWeight.Medium)
              .fontColor(this.selectedPayloadId === id ? '#FFFFFF' : '#344C60')
            Text(this.linkLabel(this.payloadState(id))).fontSize(10)
              .fontColor(this.selectedPayloadId === id ? '#D6F4EE' : this.stateColor(this.payloadState(id)))
          }
        }.layoutWeight(1).height(48).borderRadius(9)
          .backgroundColor(this.selectedPayloadId === id ? '#007F83' : '#FFFFFF')
          .onClick(() => { this.selectedPayloadId = id; }).id('payload-' + id)
      }, (id: string) => id)
    }.width('100%')
  }

  @Builder
  metricRow(payload: PayloadView, metric: MetricSpec) {
    Column({ space: 6 }) {
      Row({ space: 8 }) {
        Column({ space: 4 }) {
          Text(metric.label).fontSize(12).fontColor('#526678')
          Text(this.freshnessLabel(payload, metric)).fontSize(10)
            .fontColor(this.readingIsFresh(payload, metric) ? '#7B8A98' : '#986000')
        }.alignItems(HorizontalAlign.Start).layoutWeight(1)
        Text(this.readingValue(payload, metric) + (metric.unit.length > 0 ? ' ' + metric.unit : ''))
          .fontSize(metric.display === 'image' || metric.display === 'text' ? 14 : 20)
          .fontWeight(FontWeight.Medium).fontColor(this.readingIsFresh(payload, metric) ? '#122B40' : '#8C7B62')
          .textAlign(TextAlign.End).constraintSize({ maxWidth: '58%' }).maxLines(2)
      }.width('100%')
      if (metric.display === 'line') {
        TrendLine({ samples: this.currentPayload(payload).trend })
        Text(this.currentPayload(payload).trend.length < 2 ? '等待至少两个采样点' : '最近 ' + String(this.currentPayload(payload).trend.length) + ' 次采样 · 纵轴自动缩放')
          .fontSize(10).fontColor('#7B8A98')
      } else if (metric.display === 'image') {
        Stack({ alignContent: Alignment.BottomStart }) {
          Image($r('app.media.simulated_scene')).width('100%').height(100).objectFit(ImageFit.Cover)
          Text('固定示意图 · 非实时影像').fontSize(10).fontColor('#FFFFFF')
            .padding(6).backgroundColor('#99223542').margin(8).borderRadius(4)
        }.width('100%').height(100).borderRadius(9).clip(true)
      }
    }.width('100%').padding(10).backgroundColor('#F4F8F9').borderRadius(10).alignItems(HorizontalAlign.Start)
  }

  @Builder
  actionControl(payload: PayloadView, action: ActionSpec) {
    if (action.control === 'button') {
      Button(action.label, { type: ButtonType.Normal }).width('100%').height(46).borderRadius(8)
        .fontSize(14).fontColor('#FFFFFF').backgroundColor('#007F83').enabled(this.canCommand(payload))
        .onClick(() => { this.sendCommand(payload, action, this.controlValue(payload, action)); })
        .id('action-' + payload.deviceId + '-' + action.id)
    } else if (action.control === 'switch') {
      Row({ space: 12 }) {
        Text(action.label).fontSize(14).fontColor('#122B40').layoutWeight(1)
        Toggle({ type: ToggleType.Switch, isOn: this.controlValue(payload, action) === true })
          .selectedColor('#007F83').enabled(this.canCommand(payload))
          .onChange((value: boolean) => {
            if (value !== this.controlValue(payload, action)) { this.sendCommand(payload, action, value); }
          }).id('action-' + payload.deviceId + '-' + action.id)
      }.width('100%').constraintSize({ minHeight: 46 })
    } else if (action.control === 'select') {
      Column({ space: 6 }) {
        Text(action.label).fontSize(12).fontColor('#526678')
        Select(this.selectOptions(action)).selected(this.selectedOption(payload, action))
          .value(this.optionLabel(payload, action)).width('100%').height(46).font({ size: 14 })
          .fontColor('#122B40').backgroundColor('#EAF5F4').borderRadius(8).enabled(this.canCommand(payload))
          .onSelect((index: number) => {
            if (index >= 0 && index < action.options.length) { this.sendCommand(payload, action, action.options[index].value); }
          }).id('action-' + payload.deviceId + '-' + action.id)
      }.width('100%').alignItems(HorizontalAlign.Start)
    } else if (action.control === 'slider') {
      Column({ space: 2 }) {
        Row() {
          Text(action.label).fontSize(12).fontColor('#526678').layoutWeight(1)
          Text(String(this.controlNumber(payload, action))).fontSize(14).fontWeight(FontWeight.Medium).fontColor('#007F83')
        }.width('100%')
        Slider({ value: this.controlNumber(payload, action), min: action.min, max: action.max,
          step: action.step, style: SliderStyle.OutSet })
          .width('100%').height(44).selectedColor('#007F83').blockColor('#007F83')
          .enabled(this.canCommand(payload)).showTips(true)
          .onChange((value: number, mode: SliderChangeMode) => {
            if (mode === SliderChangeMode.End) { this.sendCommand(payload, action, value); }
          }).id('action-' + payload.deviceId + '-' + action.id)
        Row() {
          Text(String(action.min)).fontSize(10).fontColor('#7B8A98').layoutWeight(1)
          Text('松手后发送').fontSize(10).fontColor('#7B8A98').layoutWeight(1).textAlign(TextAlign.Center)
          Text(String(action.max)).fontSize(10).fontColor('#7B8A98').layoutWeight(1).textAlign(TextAlign.End)
        }.width('100%')
      }.width('100%').alignItems(HorizontalAlign.Start)
    }
  }

  @Builder
  deviceCard(payload: PayloadView) {
    Column({ space: 10 }) {
      Row({ space: 8 }) {
        Column({ space: 4 }) {
          Text(this.currentPayload(payload).name.length > 0 ? this.currentPayload(payload).name : this.currentPayload(payload).deviceId).fontSize(16)
            .fontWeight(FontWeight.Bold).fontColor('#122B40')
          Text(this.currentPayload(payload).deviceId).fontSize(10).fontColor('#7B8A98')
        }.alignItems(HorizontalAlign.Start).layoutWeight(1)
        this.badge({ label: this.linkLabel(this.currentPayload(payload).linkState), color: this.stateColor(this.currentPayload(payload).linkState) })
      }.width('100%')
      if (this.currentPayload(payload).capability.metrics.length === 0) {
        Text('设备未就绪，等待状态同步。').fontSize(12).fontColor('#7B8A98').padding({ top: 12, bottom: 12 })
      }
      if (this.config.role === 'controller' && this.currentPayload(payload).capability.actions.length > 0) {
        ForEach(this.currentPayload(payload).capability.actions, (action: ActionSpec) => {
          this.actionControl(payload, action)
        }, (action: ActionSpec) => JSON.stringify(action))
        if (!this.canCommand(payload)) {
          Text(this.currentPayload(payload).lastCommand.status === 'waiting' || this.currentPayload(payload).lastCommand.status === 'accepted' ?
            '正在等待本次命令结果。' : '设备就绪后可操作。').fontSize(11).fontColor('#986000')
        }
      }
      if (this.currentPayload(payload).lastCommand.requestId.length > 0) {
        Column({ space: 5 }) {
          Row() {
            Text('最近命令').fontSize(11).fontColor('#647587').layoutWeight(1)
            Text(this.commandLabel(this.currentPayload(payload).lastCommand.status)).fontSize(12).fontWeight(FontWeight.Medium)
              .fontColor(this.stateColor(this.currentPayload(payload).lastCommand.status))
          }.width('100%')
          Text(this.commandActionLabel(this.currentPayload(payload).lastCommand.actionId) + ' · ' + this.currentPayload(payload).lastCommand.detail)
            .fontSize(11).fontColor('#647587').lineHeight(17).width('100%')
          if (this.showMaintenance) {
            Text('请求 ' + this.currentPayload(payload).lastCommand.requestId).fontSize(9).fontColor('#7B8A98').width('100%')
          }
          if (this.currentPayload(payload).lastCommand.status === 'unknown') {
            Text('未收到最终回执；操作可能已执行。请核对设备当前状态，避免盲目重复操作。')
              .fontSize(11).fontColor('#986000').lineHeight(17).width('100%')
          }
        }.width('100%').padding(10).backgroundColor('#F7F8FA').borderRadius(8).alignItems(HorizontalAlign.Start)
          .id('command-result-' + payload.deviceId)
      }
      Flex({ direction: FlexDirection.Row, wrap: FlexWrap.Wrap, justifyContent: FlexAlign.SpaceBetween }) {
        ForEach(this.currentPayload(payload).capability.metrics, (metric: MetricSpec) => {
          Column() {
            this.metricRow(payload, metric)
          }.width(metric.display === 'line' || metric.display === 'image' ? '100%' : '48.5%')
            .margin({ bottom: 8 })
        }, (metric: MetricSpec) => JSON.stringify(metric))
      }.width('100%')
      if (this.showMaintenance) {
        Text('能力 v' + String(this.currentPayload(payload).capability.revision) + ' · 状态修订 ' + String(this.currentPayload(payload).stateRevision))
          .fontSize(10).fontColor('#7B8A98').width('100%')
        Text('启动 ' + (this.currentPayload(payload).bootId.length > 0 ? this.currentPayload(payload).bootId : '待同步'))
          .fontSize(10).fontColor('#7B8A98').width('100%')
      }
    }.width('100%').padding(12).backgroundColor('#FFFFFF').borderRadius(14).alignItems(HorizontalAlign.Start)
      .id('device-card-' + payload.deviceId)
  }

  @Builder
  simulationControls() {
    Column({ space: 12 }) {
      Text('通信与故障演示').fontSize(15).fontWeight(FontWeight.Bold).fontColor('#122B40')
      Text('暂停通信可观察过期与离线；本地模拟继续运行。故障只作用于下一条命令。')
        .fontSize(12).fontColor('#647587').lineHeight(18).width('100%')
      Button(this.view.paused ? '恢复通信' : '暂停通信', { type: ButtonType.Normal })
        .height(46).width('100%').fontSize(14).fontColor('#007F83').backgroundColor('#EAF5F4').borderRadius(8)
        .enabled(this.view.running).onClick(() => {
          if (this.runtime !== null) { this.runtime.pause(!this.view.paused); }
        }).id('pauseCommunication')
      Text('下一命令故障注入').fontSize(12).fontColor('#526678')
      Select([{ value: '正常运行' }, { value: '下一命令：拒绝受理' }, { value: '下一命令：执行失败' },
        { value: '下一命令：丢弃最终回执' }]).selected(this.faultIndex()).value(this.faultLabel())
        .width('100%').height(46).font({ size: 13 }).fontColor('#122B40').backgroundColor('#F2F6F8')
        .borderRadius(8).enabled(this.view.running).onSelect((index: number) => { this.setFault(index); }).id('faultMode')
      if (this.view.paused) {
        Text('通信已暂停，遥测与心跳均停止。恢复后会建立新会话，不自动重发控制命令。')
          .fontSize(11).fontColor('#986000').lineHeight(18).width('100%')
      }
    }.width('100%').padding(16).backgroundColor('#FFFFFF').borderRadius(16).alignItems(HorizontalAlign.Start)
  }

  @Builder
  maintenancePanel() {
    Column({ space: 10 }) {
      Text('运维工具').fontSize(15).fontWeight(FontWeight.Bold).fontColor('#122B40')
      Text('排查连接与核对回执。关闭此面板不会恢复通信或清除故障设置。')
        .fontSize(11).fontColor('#647587').lineHeight(18).width('100%')
      if (!this.isTerminal()) { this.simulationControls() }
      Button('导出日志', { type: ButtonType.Normal }).height(44).width('100%').fontSize(14).borderRadius(8)
        .fontColor('#526678').backgroundColor('#F2F6F8').enabled(this.loaded && !this.busy)
        .onClick(() => { this.exportLogs(); }).id('exportLogs')
      if (this.maintenanceNotice.length > 0) {
        Text(this.maintenanceNotice).fontSize(11).fontColor('#526678').lineHeight(18).width('100%')
          .copyOption(CopyOptions.InApp)
      }
    }.width('100%').padding(12).backgroundColor('#FFFFFF').borderRadius(14).alignItems(HorizontalAlign.Start)
  }

  @Builder
  eventList() {
    Column({ space: 12 }) {
      Row() {
        Text('任务记录').fontSize(15).fontWeight(FontWeight.Bold).fontColor('#122B40').layoutWeight(1)
        Text('最近 30 条 / UTC').fontSize(10).fontColor('#7B8A98')
      }.width('100%')
      if (this.recentEvents().length === 0) {
        Text('暂无记录。启动后将在此记录连接状态与操作结果。')
          .fontSize(12).fontColor('#7B8A98').lineHeight(20).padding({ top: 14, bottom: 14 })
      }
      ForEach(this.recentEvents(), (event: EventRecord) => {
        Column({ space: 5 }) {
          Row({ space: 6 }) {
            Text(event.time.length > 18 ? event.time.substring(11, 19) : event.time).fontSize(10).fontColor('#7B8A98')
            Text(event.deviceId).fontSize(10).fontColor('#007F83').layoutWeight(1)
            Text(this.eventLabel(event.kind)).fontSize(10).fontColor('#526678')
          }.width('100%')
          Text(this.showMaintenance ? event.detail : this.eventSummary(event)).fontSize(12).fontColor('#344C60').lineHeight(19).width('100%')
          if (this.showMaintenance) {
            Text('类型 ' + event.kind).fontSize(10).fontColor('#7B8A98').width('100%')
            if (event.requestId.length > 0) {
              Text('请求 ' + event.requestId).fontSize(9).fontColor('#7B8A98').width('100%')
            }
          }
          Divider().color('#EDF1F4').margin({ top: 6 })
        }.width('100%').alignItems(HorizontalAlign.Start)
      }, (event: EventRecord) => event.id)
    }.width('100%').padding(16).backgroundColor('#FFFFFF').borderRadius(16).alignItems(HorizontalAlign.Start)
  }

  build() {
    Scroll() {
      Column({ space: 10 }) {
        this.header()
        this.setupCard()
        this.operationalWarnings()
        if (this.notice.length > 0 || this.view.error.length > 0) {
          Column({ space: 6 }) {
            if (this.notice.length > 0) {
              Text(this.notice).fontSize(12).fontColor('#526678').lineHeight(19).width('100%').copyOption(CopyOptions.InApp)
            }
            if (this.view.error.length > 0) {
              Text(this.view.error).fontSize(12).fontColor('#B5473E').lineHeight(19).width('100%')
            }
          }.width('100%').padding(12).backgroundColor('#FFFFFF').borderRadius(10).alignItems(HorizontalAlign.Start)
        }
        this.connectionSummary()
        if (this.showMaintenance) { this.maintenancePanel() }
        Row({ space: 8 }) {
          Button(this.isTerminal() ? '载荷状态' : '本机状态', { type: ButtonType.Normal })
            .layoutWeight(1).height(42).fontSize(14).borderRadius(8)
            .backgroundColor(this.selectedTab === 'devices' ? '#DDEDEA' : '#FFFFFF')
            .fontColor(this.selectedTab === 'devices' ? '#007F83' : '#647587')
            .onClick(() => { this.selectedTab = 'devices'; }).id('devicesTab')
          Button('任务记录', { type: ButtonType.Normal })
            .layoutWeight(1).height(42).fontSize(14).borderRadius(8)
            .backgroundColor(this.selectedTab === 'events' ? '#DDEDEA' : '#FFFFFF')
            .fontColor(this.selectedTab === 'events' ? '#007F83' : '#647587')
            .onClick(() => { this.selectedTab = 'events'; }).id('eventsTab')
        }.width('100%')
        Row({ space: 8 }) {
          Button('分布式协同', { type: ButtonType.Normal }).layoutWeight(1).height(42).fontSize(14).borderRadius(8)
            .backgroundColor(this.selectedTab === 'distributed' ? '#DDEDEA' : '#FFFFFF')
            .fontColor(this.selectedTab === 'distributed' ? '#007F83' : '#647587')
            .onClick(() => { this.selectedTab = 'distributed'; }).id('distributedTab')
          Button('AI 试验助手', { type: ButtonType.Normal }).layoutWeight(1).height(42).fontSize(14).borderRadius(8)
            .backgroundColor(this.selectedTab === 'ai' ? '#DDEDEA' : '#FFFFFF')
            .fontColor(this.selectedTab === 'ai' ? '#007F83' : '#647587')
            .onClick(() => { this.selectedTab = 'ai'; }).id('aiTab')
        }.width('100%')
        Column() {
          DistributedPanel({ role: this.config.role, nodeId: this.config.nodeId })
        }.width('100%').visibility(this.selectedTab === 'distributed' ? Visibility.Visible : Visibility.None)
        Column() {
          AiAssistantPanel({ view: this.view, gatewayToken: this.aiProxyToken,
            eligible: this.view.running && this.view.config.role === this.config.role && this.view.config.nodeId === this.config.nodeId,
            onTokenChange: (value: string) => { this.saveAiToken(value); } })
        }.width('100%').visibility(this.selectedTab === 'ai' ? Visibility.Visible : Visibility.None)
        if (this.selectedTab === 'events') {
          this.eventList()
        } else if (this.selectedTab === 'devices' && this.isTerminal()) {
          this.payloadSelector()
          if (this.config.role === 'observer') {
            Text('只读监看').fontSize(11).fontColor('#647587').width('100%')
          }
          if (this.view.payloads.length === 0) {
            Column({ space: 8 }) {
              Text(this.view.running ? '等待载荷状态' : '准备开始地面协同').fontSize(15)
                .fontWeight(FontWeight.Medium).fontColor('#344C60')
              Text(this.config.role === 'observer' ? '主操作端就绪后，这里将同步载荷状态。' :
                '先在三台载荷板启动对应角色，再启动主操作端。')
                .fontSize(12).fontColor('#7B8A98').lineHeight(20).textAlign(TextAlign.Center)
            }.width('100%').padding(26).backgroundColor('#FFFFFF').borderRadius(16)
          }
          ForEach(this.selectedPayloads(), (payload: PayloadView) => {
            this.deviceCard(payload)
          }, (payload: PayloadView) => payload.deviceId)
        } else if (this.selectedTab === 'devices') {
          if (this.view.local.capability.metrics.length > 0) {
            this.deviceCard(this.view.local)
          } else {
            Text('启动本机后显示模拟载荷的实际当前状态。').fontSize(12).fontColor('#7B8A98')
              .padding(20).width('100%').backgroundColor('#FFFFFF').borderRadius(12)
          }
        }
        Text('OpenHarmony · 航空地面协同').fontSize(10).fontColor('#8C9AA6').margin({ top: 3, bottom: 12 })
      }.width('100%').padding({ left: 16, right: 16, top: 16, bottom: 24 }).alignItems(HorizontalAlign.Start)
    }.width('100%').height('100%').backgroundColor('#EDF3F6').scrollBar(BarState.Auto).align(Alignment.TopStart)
  }
}

