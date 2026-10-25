import type common from '@ohos.app.ability.common';
import type { Role } from '../core/models';
import { trialKey } from '../core/distributedTask';
import type { TrialTask, TrialFeedback } from '../core/distributedTask';
import { DistributedService, emptyDistributedView, shortDevice } from '../platform/DistributedService';
import type { DistributedView, TrialPeer } from '../platform/DistributedService';

@Component
export struct DistributedPanel {
  @Prop @Watch('identityChanged') role: Role = 'observer';
  @Prop @Watch('identityChanged') nodeId: string = 'VIEW-01';
  @State expanded: boolean = true;
  @State state: DistributedView = emptyDistributedView();
  @State groupText: string = 'A-E';
  @State titleText: string = '地面载荷协同试验';
  @State showHistory: boolean = false;
  @State showDetails: boolean = false;
  @State closing: boolean = false;
  private service: DistributedService | undefined = undefined;

  aboutToAppear(): void { this.createService(); }
  aboutToDisappear(): void {
    if (this.service) { this.service.close(); this.service = undefined; }
  }
  private createService(): void {
    this.service = new DistributedService((view: DistributedView) => { this.state = view; });
    this.identityChanged();
  }
  identityChanged(): void { if (this.service) this.service.setIdentity(this.role, this.nodeId); }
  private async enable(): Promise<void> {
    if (!this.service) this.createService();
    this.identityChanged();
    if (this.service) await this.service.enable(getContext(this) as common.UIAbilityContext);
  }
  private async stop(): Promise<void> {
    if (!this.service || this.closing) return;
    this.closing = true;
    await this.service.close();
    this.service = undefined; this.state = emptyDistributedView(); this.closing = false;
    this.createService();
  }
  private readyCount(): number { return this.state.feedback.filter((item: TrialFeedback) => item.ready).length; }
  private roleName(role: string): string {
    if (role === 'controller') return '主操作';
    if (role === 'observer') return '只读监看';
    if (role === 'camera') return '图像载荷';
    if (role === 'environment') return '环境载荷';
    if (role === 'light') return '照明载荷';
    return '成员';
  }
  private localReady(): boolean {
    const item = this.state.feedback.find((feedback: TrialFeedback) => feedback.memberId === this.state.localId);
    return item ? item.ready : false;
  }

  @Builder
  deviceSetup() {
    Text('1. 配对并选择本组设备').fontSize(17).fontWeight(FontWeight.Medium).fontColor('#183B4B')
    Text('首次使用：两台设备都启用此模块，再发现设备、按系统提示输入 PIN。选中可信设备后才会向它同步。')
      .fontSize(13).fontColor('#506873').width('100%')
    Row({ space: 10 }) {
      Button(this.state.discovering ? '重新发现' : '发现设备').height(38).fontSize(14).backgroundColor('#007F83')
        .onClick(() => { if (this.service) this.service.discover(); }).id('distributedDiscover')
      Button('刷新可信设备').height(38).fontSize(14).backgroundColor('#456575')
        .onClick(() => { if (this.service) this.service.refreshPeers(); }).id('distributedRefresh')
    }.width('100%')
    if (this.state.found.length > 0) {
      ForEach(this.state.found, (peer: TrialPeer) => {
        Row({ space: 10 }) {
          Column({ space: 3 }) {
            Text(peer.name || '发现的设备').fontSize(14).fontColor('#183B4B')
            Text('标识 ' + shortDevice(peer.id)).fontSize(12).fontColor('#647781')
          }.alignItems(HorizontalAlign.Start).layoutWeight(1)
          Button('配对').height(34).fontSize(13).backgroundColor('#456575')
            .onClick(() => { if (this.service) this.service.bind(peer.id); })
        }.width('100%').padding(10).backgroundColor('#F1F6F8').borderRadius(8)
      }, (peer: TrialPeer) => JSON.stringify(peer) + ':' + String(this.state.busy))
    }
    if (this.state.peers.length === 0) {
      Text('还没有可用的可信设备。请先完成配对；两块板须在同一局域网。').fontSize(13).fontColor('#647781')
    } else {
      ForEach(this.state.peers, (peer: TrialPeer) => {
        Column({ space: 6 }) {
          Row({ space: 10 }) {
            Column({ space: 3 }) {
              Text(peer.name || '可信设备').fontSize(15).fontWeight(FontWeight.Medium).fontColor('#183B4B')
              Text(shortDevice(peer.id) + ' · ' + (peer.available ? '在线' : '离线')).fontSize(12).fontColor('#647781')
            }.alignItems(HorizontalAlign.Start).layoutWeight(1)
            Button(peer.selected ? '已选中 ✓' : '选择').height(34).fontSize(13)
              .backgroundColor(peer.selected ? '#007F83' : '#657C89')
              .enabled(!this.state.busy && (peer.available || peer.selected))
              .onClick(() => { if (this.service) this.service.togglePeer(peer.id); })
          }.width('100%')
          Text(peer.status).fontSize(12).fontColor('#506873').width('100%')
        }.width('100%').alignItems(HorizontalAlign.Start).padding(10).backgroundColor('#F1F6F8').borderRadius(8)
      }, (peer: TrialPeer) => JSON.stringify(peer) + ':' + String(this.state.busy))
    }
    Button('同步选定设备').width('100%').height(42).fontSize(15).backgroundColor('#007F83')
      .enabled(!this.state.busy && !this.closing && this.state.peers.some((peer: TrialPeer) => peer.selected))
      .onClick(() => { if (this.service) this.service.sync(); }).id('distributedSync')
    Text('选定设备逐台同步。完成只表示 KV 同步返回成功；准备状态来自已配对同应用成员自报，未核验实体载荷。')
      .fontSize(12).fontColor('#647781').width('100%')
  }

  @Builder
  taskEditor() {
    if (this.role === 'controller') {
      Text('2. 新建或修订试验任务').fontSize(17).fontWeight(FontWeight.Medium).fontColor('#183B4B')
      TextInput({ text: this.groupText, placeholder: '组号，如 A-E，仅字母、数字、横线或下划线' })
        .maxLength(24).onChange((value: string) => { this.groupText = value; }).id('distributedGroup')
      TextInput({ text: this.titleText, placeholder: '试验标题，最多 80 字' })
        .maxLength(80).onChange((value: string) => { this.titleText = value; }).id('distributedTitle')
      Row({ space: 10 }) {
        Button('新建任务').height(38).fontSize(14).backgroundColor('#007F83').enabled(!this.state.busy && !this.closing)
          .onClick(() => { if (this.service) { this.identityChanged(); this.service.createTask(this.groupText, this.titleText); } })
          .id('distributedCreate')
        if (this.state.current.creatorId === this.state.localId && this.state.current.sessionId.length > 0) {
          Button('修订当前任务').height(38).fontSize(14).backgroundColor('#456575').enabled(!this.state.busy && !this.closing && !this.state.historical)
            .onClick(() => { if (this.service) { this.identityChanged(); this.service.revise(this.titleText); } })
            .id('distributedRevise')
        }
      }.width('100%')
      Text('新建或修订后请主动同步。新版本需要重新确认准备，旧版本反馈不会沿用。')
        .fontSize(12).fontColor('#647781').width('100%')
    }
  }

  @Builder
  currentTask() {
    Text('当前任务与成员反馈').fontSize(17).fontWeight(FontWeight.Medium).fontColor('#183B4B')
    if (this.state.current.sessionId.length === 0) {
      Text('暂无任务。主操作端新建并同步任务后，可在这里查看和确认准备。').fontSize(14).fontColor('#647781')
    } else {
      Column({ space: 8 }) {
        Text(this.state.current.title).fontSize(20).fontWeight(FontWeight.Bold).fontColor('#183B4B').width('100%')
        Text('组号 ' + this.state.current.group + ' · 版本 ' + this.state.current.revision + ' · 任务 ' + this.state.current.sessionId.slice(0, 8))
          .fontSize(13).fontColor('#506873').width('100%')
        Text('创建设备 ' + shortDevice(this.state.current.creatorId) + ' · ' + new Date(this.state.current.updatedAt).toLocaleString())
          .fontSize(12).fontColor('#647781').width('100%')
        if (this.state.historical) {
          Text('历史版本：仅供查阅，不能修订或提交准备。请在任务记录中选择最新版本。')
            .fontSize(13).fontColor('#A13C29').width('100%')
        }
        Text('成员自报准备：' + this.readyCount() + ' 台（本任务、本版本）').fontSize(16).fontWeight(FontWeight.Medium).fontColor('#007F83')
        Button(this.localReady() ? '取消本机准备' : '本机报告已准备').width('100%').height(42)
          .backgroundColor(this.localReady() ? '#647781' : '#007F83').enabled(!this.state.busy && !this.closing && !this.state.historical)
          .onClick(() => { if (this.service) { this.identityChanged(); this.service.ready(!this.localReady()); } })
          .id('distributedReady')
        Text('准备反馈为成员自报，不代表物理设备已核验，不会启动载荷。报告或取消后，请同步给主操作端。').fontSize(12).fontColor('#647781').width('100%')
        ForEach(this.state.feedback, (feedback: TrialFeedback) => {
          Text(feedback.nodeId + ' · ' + this.roleName(feedback.role) + ' · ' + shortDevice(feedback.memberId) + '：' +
            (feedback.ready ? '自报已准备' : '自报取消准备') + (feedback.memberId === this.state.localId ? '（本机）' : '（成员自报）'))
            .fontSize(13).fontColor(feedback.ready ? '#007F83' : '#647781').width('100%')
        }, (feedback: TrialFeedback) => JSON.stringify(feedback))
      }.width('100%').alignItems(HorizontalAlign.Start).padding(14).backgroundColor('#EAF5F4').borderRadius(10)
    }
    if (this.state.tasks.length > 1) {
      Button(this.showHistory ? '收起任务记录' : '选择任务 / 最近记录').height(34).fontSize(13).backgroundColor('#456575')
        .onClick(() => { this.showHistory = !this.showHistory; }).id('distributedHistory')
      if (this.showHistory) {
        ForEach(this.state.tasks, (task: TrialTask) => {
          Button(task.title + ' · v' + task.revision + ' · ' + task.sessionId.slice(0, 6), { type: ButtonType.Normal })
            .width('100%').height(42).fontSize(13).borderRadius(6)
            .backgroundColor(trialKey(task) === trialKey(this.state.current) ? '#007F83' : '#657C89')
            .onClick(() => { if (this.service) this.service.selectTask(trialKey(task)); })
        }, (task: TrialTask) => trialKey(task))
        Text('显示最近 20 条任务版本。历史版本不能提交准备。收到同一任务的新版本时自动切换。').fontSize(12).fontColor('#647781')
      }
    }
  }

  build() {
    Column({ space: 12 }) {
      Row({ space: 12 }) {
        Column({ space: 4 }) {
          Text('分布式试验协同').fontSize(20).fontWeight(FontWeight.Bold).fontColor('#183B4B')
          Text('共享任务卡 · 成员报告准备').fontSize(13).fontColor('#647781')
        }.alignItems(HorizontalAlign.Start).layoutWeight(1)
        Button(this.expanded ? '收起' : '展开').fontSize(13).height(34).backgroundColor('#456575')
          .onClick(() => { this.expanded = !this.expanded; }).id('distributedExpand')
      }.width('100%')
      if (this.expanded) {
        Text('使用 OpenHarmony 设备管理和分布式 KV，同组设备通过 PIN 配对。任务和准备状态为已配对同应用成员自报。')
          .fontSize(13).fontColor('#506873').width('100%')
        if (!this.state.enabled) {
          Button(this.state.busy ? '正在启用…' : '授权并启用').width('100%').height(42).backgroundColor('#007F83')
            .enabled(!this.state.busy && !this.closing).onClick(() => { this.enable(); }).id('distributedEnable')
        } else {
          Text('本机 ' + this.state.localLabel).fontSize(12).fontColor('#647781').width('100%')
          this.deviceSetup()
          Divider().color('#DCE8EB')
          this.taskEditor()
          this.currentTask()
          Button(this.closing ? '正在释放服务…' : '关闭分布式模块').height(34).fontSize(13).backgroundColor('#647781')
            .enabled(!this.state.busy && !this.closing).onClick(() => { this.stop(); }).id('distributedStop')
        }
        Text(this.state.status).fontSize(13).fontColor('#506873').width('100%')
        if (this.state.error.length > 0) {
          Text(this.state.error).fontSize(13).fontColor('#A13C29').width('100%')
        }
        if (this.state.logs.length > 0) {
          Button(this.showDetails ? '收起过程记录' : '查看过程记录').height(30).fontSize(12).backgroundColor('#647781')
            .onClick(() => { this.showDetails = !this.showDetails; })
          if (this.showDetails) {
            ForEach(this.state.logs, (line: string, index: number) => {
              Text(line).fontSize(12).fontColor('#647781').width('100%')
            }, (line: string, index: number) => String(index) + line)
          }
        }
      }
    }.width('100%').alignItems(HorizontalAlign.Start).padding(18).backgroundColor('#FFFFFF').borderRadius(14)
  }
}
