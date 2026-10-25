# 航空载荷终端源码 v1.4

| 目录 | 内容 |
|---|---|
| `payload-app/` | OpenHarmony ArkTS / ArkUI 应用、界面、业务逻辑、通信适配及图标资源 |
| `ai-gateway/` | DeepSeek AI 网关与测试代码 |
| `tools/` | Windows 构建、签名、HDC 部署和环境检查脚本 |
| `profiles/` | 五块板的配置清单模板 |
| `tests/` | 核心逻辑、平台适配、分布式和工具测试 |
| `docs/` | 部署、载荷操作、五板联调与 AI 操作手册 |

主要界面与逻辑位于 `payload-app/entry/src/main/ets/`。载荷业务通信使用局域网 TCP，任务协同包含鸿蒙分布式能力，AI 经网关调用 DeepSeek。

从本目录打开 PowerShell，先核对源码：

```powershell
python tools/verify_source.py
```

Windows 构建需要本地 DevEco Studio 与 OpenHarmony API 23 SDK。构建命令：

```powershell
python tools/windows_build.py --check
python tools/windows_build.py
```

构建成功后，安装包生成在 `payload-app/dist/payload-terminal-signed.hap`。

部署、载荷操作和五板联调统一按 [开发部署操作手册](docs/航空载荷终端开发部署操作手册.docx) 操作。日常使用见 [软件使用手册](docs/航空载荷终端软件使用手册.docx)。AI 网关配置见 [ai-gateway/README.md](ai-gateway/README.md)。

## 已编译安装包

已放入可直接安装的签名包：[payload-terminal-signed.hap](payload-app/dist/payload-terminal-signed.hap)。

同目录的 `build-info.json` 记录包名、API 版本、编译时间及 SHA256。此安装包对应当前 v1.4 交付版本。可从本目录运行 `python tools/windows_build.py --verify` 校验安装包。

## 构建文件说明

当前构建入口是 `tools/windows_build.py`，目标为 API23。`tools/payload_build.py` 同时提供 Windows 构建器和部署工具导入的产物校验、签名包身份、设备目标校验及构建锁，属于必需模块。

`payload-app/build.py`、`build.sh`、`hdc.sh`、`install.sh` 是原课程 Linux 兼容入口，保留在发布源码基线中；当前构建和安装按本页 Windows 步骤执行。应用功能源文件、资源、构建配置和已编译 HAP 均与已交付版本一致。
