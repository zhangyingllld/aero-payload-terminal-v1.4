# 航空载荷终端应用 v1.4

OpenHarmony ArkTS / ArkUI Stage 应用，包名 `com.eduoh.payloadterminal`，入口 `EntryAbility`。五块板安装同一个 HAP，在应用中分别选择主操作、只读监看、图像、环境、照明角色。

载荷操作与状态回执使用局域网 TCP；任务协同使用 OpenHarmony 设备发现、可信配对和分布式 KV 同步；AI 试验助手经电脑网关调用 DeepSeek。图像、环境和照明载荷使用教学模拟数据。

请在上一级工程根目录运行构建命令：

```powershell
python tools/windows_build.py --check
python tools/windows_build.py
python tools/windows_build.py --verify
```

当前工程使用 API23。已编译包位于本目录的 `dist/payload-terminal-signed.hap`，构建信息位于 `dist/build-info.json`。

完整工程依赖上一级的 `tools/`，请以整个源码目录为工程根目录。详细步骤见 [源码说明](../README.md) 和 [部署使用手册](../docs/航空载荷终端开发部署操作手册.docx)。原课程的 Linux 兼容入口保留，当前操作以 Windows 构建器为准。
