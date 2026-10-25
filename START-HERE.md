# 源码快速入口

1. 在本目录打开 PowerShell，运行 `python tools/verify_source.py` 检查文件。
2. 直接安装已有包前，运行 `python tools/windows_build.py --verify` 核对 HAP。
3. 修改应用后，需要重新构建时先运行 `python tools/windows_build.py --check`，再运行 `python tools/windows_build.py`。

- [目录结构与构建说明](README.md)
- [已编译安装包](payload-app/dist/payload-terminal-signed.hap)
- [部署、载荷操作和五板联调](docs/航空载荷终端开发部署操作手册.docx)
- [AI 网关配置](ai-gateway/README.md)

- [面向使用者的软件使用手册](docs/航空载荷终端软件使用手册.docx)
