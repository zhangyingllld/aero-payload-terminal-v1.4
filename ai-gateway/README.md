# AI 试验助手：电脑代理与板端接入

这个功能调用真实 DeepSeek 模型分析**模拟载荷**记录。它可以解释“结果未确认”、整理本次启动后的近期事件、提出人工检查建议。它不会抓拍、开灯、改采样周期，也不会自动重发命令。没有联网或模型额度时，原有载荷控制照常使用。

## 1. 需要准备什么

- 一台能访问 `https://api.deepseek.com` 的 Windows 电脑。
- Python 3.10 或更高版本；代理只使用标准库，不需要 pip 安装依赖。
- 一块通过 USB/HDC 连接的开发板。需要使用 AI 的其他板，也要分别连接 USB 并设置转发。
- 有可用额度的 DeepSeek API Key，以及自行设置的组内连接口令。

**两种口令用途不同。** DeepSeek API Key 只由电脑代理读取，不能填进板上。板上填写的是组内连接口令，长度为 24～128 位，可用字母、数字、下划线、短横线。两个值都不要写进源码、演示截图或发送给组员的压缩包。

## 2. 启动电脑代理

在本包根目录打开 PowerShell。下列输入采用密码输入框式的隐藏回显，命令历史只记录命令本身，不记录输入的值。

```powershell
$aiKeyInput = Read-Host '输入 DeepSeek API Key（不会显示）' -AsSecureString
$aiProxyInput = Read-Host '输入组内连接口令（24至128位，不会显示）' -AsSecureString
$aiKeyCredential = New-Object System.Management.Automation.PSCredential('unused', $aiKeyInput)
$aiProxyCredential = New-Object System.Management.Automation.PSCredential('unused', $aiProxyInput)
$env:DEEPSEEK_API_KEY = $aiKeyCredential.GetNetworkCredential().Password
$env:PAYLOAD_AI_PROXY_TOKEN = $aiProxyCredential.GetNetworkCredential().Password
$env:DEEPSEEK_MODEL = 'deepseek-flash'
try {
    python .\ai-gateway\gateway.py
} finally {
    Remove-Item Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:PAYLOAD_AI_PROXY_TOKEN -ErrorAction SilentlyContinue
}
```

看到 `AI gateway ready on 127.0.0.1:43190` 就说明代理已启动。保持这个窗口运行。`Ctrl+C` 停止代理。

代理只监听电脑回环地址，不开放局域网或公网端口，不需要添加防火墙入站规则。若交付包另附本机加密配置启动器，可以使用该启动器；不要把本机的加密配置文件放进交付包。

## 3. 给每块需要 AI 的板设置 USB 转发

在第二个 PowerShell 窗口执行。先从 `list targets` 找到目标设备编号，再替换 `$Board`。不要把示例占位文字直接执行。

```powershell
$Hdc = 'D:\OpenHarmony\Sdk\23\toolchains\hdc.exe'
& $Hdc list targets
$Board = '替换为实际USB设备编号'
& $Hdc -t $Board rport tcp:43190 tcp:43190
```

这一步把**板上的** `127.0.0.1:43190` 转发到**电脑上的** `127.0.0.1:43190`。重插 USB、重启 HDC 或板子后，需要检查并重新建立转发。五块板可使用相同组内口令和同一个电脑代理；每块板须分别执行一次转发命令，分析请求一次只处理一个。

## 4. 在应用里怎么用

1. 先按原步骤启动主操作端和载荷端，做一次模拟抓拍或一次照明操作。
2. 打开“AI 试验助手”的“连接设置”，填入**组内连接口令**，点击“保存连接口令”。
3. 点击“预览待发送记录”，可以看到当前的匿名数据。设备用 `D1` 等代号，请求用 `R1`，事件用 `E1`；没有 IP、设备原始编号、原始日志详情、图片或任何密钥。点击分析时会重新读取快照。
4. 点击“分析当前记录”。只有点击时才请求模型，不会后台定时调用。正常等待期间保持 USB 连接和电脑代理运行。
5. 阅读“已知事实／可能原因／建议检查／记录范围”。报告下面显示所用模型、耗时、纳入的事件数。
6. 报告对应**点击时的快照**。“查看报告依据”显示该成功报告使用的快照，与“预览待发送记录”不同。继续操作设备后，旧报告不会自动变化；需要重新点击分析。新请求处理中或失败时仍保留上次成功报告，新请求成功后才一起替换报告、模型耗时及证据。

报告仅使用当前状态和本机最近一次启动后的最多 80 条事件。若历史更长，界面会把未纳入数量交给模型说明。未启动的角色、空载荷和仅有启动记录的情况不会提交分析。模型输出需人工核对，不能当成新的设备回执。

## 5. 演示建议

先做一次正常模拟抓拍，再让载荷端演示“丢弃最终回执”。主操作端出现“结果未确认”后，点击分析。预期助手解释：已经收到受理，最终结果缺少证据，不能认定成功或失败，应先核对当前状态和对应请求回执，不能自动重复抓拍。

再恢复正常通信，做一次成功操作后重新分析，检查助手是否按不同请求编号分别说明。不要把演示故障说成真实硬件故障。

## 6. 常见问题

| 界面提示 | 处理方法 |
|---|---|
| 无法连接 AI 助手 | 检查电脑代理窗口是否运行、USB 是否在线，再检查 HDC rport 转发。 |
| 组内连接口令不匹配 | 核对电脑 `PAYLOAD_AI_PROXY_TOKEN` 与板端保存值；不是 DeepSeek API Key。 |
| 正在处理或请求过于频繁 | 等当前请求结束，或等待一分钟后手动重试。不要重复快速点击。 |
| 模型服务暂时不可用 | 检查电脑联网、DeepSeek 额度和模型名；代理不会自动重试收费请求。 |
| 返回格式不符合要求 | 本次结果不展示；稍后手动重试。原设备操作不受影响。 |

## 7. 开发接入

`AiAssistantPanel` 接收 `view: AppView`、`eligible: boolean`、`gatewayToken: string` 和 `onTokenChange(value)`。`eligible` 由父页面校验运行状态和所选身份一致，避免切角色时分析旧身份的快照。由父页面把组内连接口令保存到应用私有配置。模型 API Key 永远不传给组件。

```typescript
AiAssistantPanel({
  view: this.view,
  eligible: this.view.running && this.view.config.role === this.config.role && this.view.config.nodeId === this.config.nodeId,
  gatewayToken: this.aiProxyToken,
  onTokenChange: (value: string) => { this.saveAiProxyToken(value); }
})
```

`aiSummary.ts` 只生成白名单结构，不使用任意日志文本。`AiClient.ets` 只请求固定本机 `/analyze` 地址，不引用控制引擎。`gateway.py` 对收到的结构再次校验。代理固定上游为 `https://api.deepseek.com/chat/completions`，禁止重定向，不继承环境代理，不提供通用 URL 转发或工具调用。

默认单并发、每分钟最多 6 次、请求最多 64 KiB、上游响应最多 64 KiB、模型正文最多 16 KiB，无自动重试。每次上游调用在独立 Python 子进程内运行，**45 秒总截止时间**涵盖连接、握手、等待响应和持续空行保活；到时终止并回收子进程，关闭其 HTTPS 连接，避免仅超时返回后后台请求仍在运行。模型密钥经进程标准输入管道传递，不出现在命令行或临时文件。只有 `finish_reason=stop` 的完整响应可采用，截断或工具调用响应会失败并保留旧报告。没有 HTTP 访问日志，也不会输出密钥、请求正文或上游异常详情。

默认 `deepseek-flash`，显式关闭思考模式，输出上限 1000 token。模型名可通过 `DEEPSEEK_MODEL` 配置；端点不可配置。依据：[DeepSeek 首次调用](https://api-docs.deepseek.com/)、[Chat Completions 参数](https://api-docs.deepseek.com/api/create-chat-completion/)，核对日期 2026-10-24。

## 8. 测试命令

```powershell
python -m unittest discover -s ai-gateway -p test_gateway.py -v
node --import ./tests/register.mjs --experimental-strip-types --test ./tests/core/ai-summary.test.mjs
node --import ./tests/platform/ai-client-register.mjs --test ./tests/platform/ai-client.test.mjs
```

这些测试使用本地假上游，检查鉴权、脱敏、证据范围、格式、限流、限长、单并发、错误隐藏、固定端点、拒绝重定向及禁止工具调用；**不等同于真实模型或实板测试**。真实模型结果与板端界面需另行记录验收。
