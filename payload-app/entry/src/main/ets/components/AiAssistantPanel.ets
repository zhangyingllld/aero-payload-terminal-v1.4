import { initialView } from '../core/models';
import type { AppView } from '../core/models';
import { buildAiSummary, hasAiEvidence } from '../core/aiSummary';
import type { AiSummary } from '../core/aiSummary';
import { analyzeAiSummary } from '../platform/AiClient';
import type { AiAnswer } from '../platform/AiClient';

interface SuccessfulAiReport { text: string; meta: string; evidence: string; }

@Component
export struct AiAssistantPanel {
  @Prop view: AppView = initialView();
  @Prop eligible: boolean = true;
  @Prop @Watch('syncToken') gatewayToken: string = '';
  onTokenChange: (value: string) => void = (_value: string): void => {};
  @State tokenDraft: string = '';
  @State showSettings: boolean = false;
  @State showEvidence: boolean = false;
  @State busy: boolean = false;
  @State lastReport: SuccessfulAiReport = { text: '', meta: '', evidence: '' };
  @State notice: string = '';
  @State evidenceText: string = '';
  @State evidenceLabel: string = '';
  private mounted: boolean = false;
  private generation: number = 0;

  syncToken(): void { this.tokenDraft = this.gatewayToken; }
  aboutToAppear(): void { this.mounted = true; this.syncToken(); }
  aboutToDisappear(): void { this.mounted = false; this.generation++; }

  saveToken(): void {
    const token: string = this.tokenDraft.trim();
    if (!/^[A-Za-z0-9_-]{24,128}$/.test(token)) { this.notice = '请输入24至128位字母、数字、下划线或短横线组成的组内连接口令。'; return; }
    this.onTokenChange(token); this.notice = '已提交连接口令。';
  }

  preview(): void {
    if (!this.eligible || !this.view.running) { this.notice = '当前角色尚未启动，请启动后再查看待发送记录。'; return; }
    this.evidenceText = JSON.stringify(buildAiSummary(this.view), null, 2);
    this.evidenceLabel = '当前待发送快照；不代表下方旧报告的依据。点击分析时会重新读取。';
    this.showEvidence = true;
  }

  showReportEvidence(): void {
    this.evidenceText = this.lastReport.evidence;
    this.evidenceLabel = '下方成功报告的原始脱敏快照，与当前设备状态可能不同。';
    this.showEvidence = true;
  }

  async analyze(): Promise<void> {
    if (this.busy) { return; }
    if (!this.eligible || !this.view.running) { this.notice = '请先启动当前角色。未启动或正在切换角色时不会发送旧状态和旧记录。'; return; }
    const snapshot: AiSummary = buildAiSummary(this.view);
    if (!hasAiEvidence(snapshot)) { this.notice = '目前只有启动信息。请先连接载荷并产生读数、操作结果或连接异常，再进行分析。'; return; }
    const pendingEvidence: string = JSON.stringify(snapshot, null, 2);
    this.busy = true; this.notice = '正在分析脱敏后的模拟记录，请稍候…';
    this.generation++; const current: number = this.generation;
    try {
      const answer: AiAnswer = await analyzeAiSummary(snapshot, this.tokenDraft.trim());
      if (!this.mounted || current !== this.generation) { return; }
      this.lastReport = { text: answer.text,
        meta: answer.model + ' · ' + (answer.elapsedMs / 1000).toFixed(1) + '秒 · ' + snapshot.events.length.toString() + '条事件',
        evidence: pendingEvidence };
      if (this.showEvidence) {
        this.evidenceText = pendingEvidence;
        this.evidenceLabel = '本次成功报告的原始脱敏快照。';
      }
      this.notice = '分析完成。报告对应点击时的状态快照，后续设备变化不会自动更新报告。';
    } catch (error) {
      if (this.mounted && current === this.generation) { this.notice = (error as Error).message; }
    } finally {
      if (this.mounted && current === this.generation) { this.busy = false; }
    }
  }

  build() {
    Column({ space: 12 }) {
      Row() {
        Column({ space: 3 }) {
          Text('AI 试验助手').fontSize(20).fontWeight(FontWeight.Bold).fontColor('#173649')
          Text('解释记录 · 整理结论 · 提供检查建议').fontSize(12).fontColor('#56717F')
        }.alignItems(HorizontalAlign.Start).layoutWeight(1)
        Button(this.showSettings ? '收起设置' : '连接设置', { type: ButtonType.Normal })
          .fontSize(12).height(32).borderRadius(8).backgroundColor('#E8F3F2').fontColor('#007F83')
          .onClick(() => { this.showSettings = !this.showSettings; }).id('aiSettingsButton')
      }.width('100%')
      Text('点击后向模型发送脱敏模拟记录：数值、命令状态和匿名事件。不会发送IP、原始日志、真实图像或控制指令。')
        .fontSize(13).fontColor('#56717F').width('100%')
      if (!this.eligible || !this.view.running) {
        Text('当前角色尚未启动。启动并产生有效状态或任务记录后，才可以分析。').fontSize(13).fontColor('#81602E').width('100%')
      }
      if (this.showSettings) {
        Column({ space: 8 }) {
          Text('组内连接口令（不是模型API密钥）').fontSize(13).fontColor('#173649').width('100%')
          TextInput({ text: this.tokenDraft, placeholder: '输入电脑代理配置的连接口令' })
            .type(InputType.Password).maxLength(128).height(42)
            .onChange((value: string) => { this.tokenDraft = value; }).id('aiProxyTokenInput')
          Text('电脑代理通过USB端口转发提供服务；模型密钥只保存在电脑。').fontSize(12).fontColor('#56717F')
          Button('保存连接口令').fontSize(13).height(34).backgroundColor('#007F83')
            .onClick(() => { this.saveToken(); }).id('aiSaveTokenButton')
        }.width('100%').padding(12).backgroundColor('#F0F5F6').borderRadius(10)
      }
      Row({ space: 10 }) {
        Button(this.busy ? '正在分析…' : '分析当前记录', { type: ButtonType.Normal })
          .layoutWeight(1).height(42).borderRadius(10).backgroundColor('#007F83').fontColor('#FFFFFF')
          .enabled(!this.busy && this.eligible && this.view.running).onClick(() => { this.analyze(); }).id('aiAnalyzeButton')
        Button('预览待发送记录', { type: ButtonType.Normal })
          .height(42).borderRadius(10).backgroundColor('#E8F3F2').fontColor('#007F83').fontSize(13)
          .enabled(!this.busy && this.eligible && this.view.running).onClick(() => { this.preview(); }).id('aiEvidenceButton')
      }.width('100%')
      if (this.notice.length > 0) { Text(this.notice).fontSize(13).fontColor('#56717F').width('100%').id('aiNotice') }
      if (this.lastReport.text.length > 0) {
        Column({ space: 8 }) {
          Text(this.busy ? '上次成功报告（本次请求处理中）' : '最近一次成功报告').fontSize(13).fontColor('#173649').width('100%')
          Text(this.lastReport.meta).fontSize(12).fontColor('#007F83').width('100%').id('aiReportMeta')
          Text(this.lastReport.text).fontSize(14).fontColor('#173649').lineHeight(23).width('100%').copyOption(CopyOptions.LocalDevice).id('aiReportText')
          Text('模型建议供人工核对；不能替代实际回执，也不会自动操作设备。').fontSize(12).fontColor('#81602E').width('100%')
          Button('查看报告依据').fontSize(12).height(32).backgroundColor('#456575')
            .onClick(() => { this.showReportEvidence(); }).id('aiReportEvidenceButton')
        }.width('100%').padding(12).backgroundColor('#F2F7F7').borderRadius(10)
      }
      if (this.showEvidence) {
        Text(this.evidenceLabel).fontSize(12).fontColor('#81602E').width('100%')
        Text(this.evidenceText).fontSize(11).fontColor('#56717F').width('100%').copyOption(CopyOptions.LocalDevice).id('aiEvidenceText')
        Button('收起记录').fontSize(12).height(30).backgroundColor('#456575').onClick(() => { this.showEvidence = false; })
      }
    }.width('100%').padding(16).backgroundColor('#FFFFFF').borderRadius(16)
  }
}
