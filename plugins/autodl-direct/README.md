# AutoDL Direct

本地自建的 Codex 插件，直接访问 AutoDL 官方开发者 API。业务代码由本项目编写，未使用第三方 AutoDL 项目的代码。它不是 AutoDL 官方发布的插件。此版本由 GitHub 私有仓库分发，采用 MIT 许可证。

采用当前 Agent Plugins 格式（根目录 `plugin.json`、`mcp.json`、`skills/`），同时附带 Codex 兼容清单。配有独立的浅色和深色图标，品牌色为青绿色。

## 安装

需要 Node.js 22 及以上、支持 `codex plugin` 的 Codex。Windows 的 PowerShell 与 OpenSSH 用于凭据配置和远程任务。本包已经构建，不需要运行 npm 安装依赖。

将 ZIP 解压到一个准备长期保留的本地目录，进入其中的 `autodl-direct` 文件夹，在本机 PowerShell 中运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install-Plugin.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Configure-Token.ps1
```

从其他目录运行时使用脚本的完整路径。安装脚本会注册一个本地插件目录并安装 `autodl-direct`。它不启动或创建任何 GPU 实例。凭据配置脚本只调用余额查询进行验证，然后使用 Windows DPAPI 加密保存到 `%LOCALAPPDATA%\CodexAutoDL\token.dpapi`。不需要向聊天提供 Token，也不会把 Token 写进插件包。

安装后保留解压目录，避免插件目录引用失效。配置后，在新聊天中使用 AutoDL Direct，或重启插件连接。可先说：“使用 AutoDL Direct 检查配置，查询我的余额和 Pro 实例。”

也可由启动 Codex 的本机环境提供 `AUTODL_TOKEN`，其优先级高于 DPAPI 凭据。可用 `AUTODL_CREDENTIAL_FILE` 指定 DPAPI 文件位置。

## 实现的工具

| 工具 | 功能 |
| --- | --- |
| `autodl_setup_status` | 离线检查运行环境及凭据是否存在 |
| `autodl_balance` | 查询余额、代金券、累计消费，转换为元 |
| `autodl_list_instances` | 分页查询 Pro 实例 |
| `autodl_instance_status` | 查询状态，验证开关机结果 |
| `autodl_instance_info` | 读取详情和 SSH 地址，隐藏密码及 Jupyter Token |
| `autodl_list_images` | 查询 Pro 私有镜像和保存状态 |
| `autodl_create_instance` | 预览或创建按量计费 Pro 实例 |
| `autodl_power_on` | 预览或执行 GPU 模式开机 |
| `autodl_power_off` | 预览或执行关机 |
| `autodl_save_image` | 预览或保存系统盘镜像 |

变更默认 `execute=false`，仅返回具体请求预览，不发网络请求。`execute=true` 执行真实 API 操作。用户已经给出的授权可以用于后续执行，不要求每次重新确认。实例释放和企业弹性部署未包含在此版本中。

## SSH 与训练任务

Skill 引导 Codex 使用系统自带的 SSH 和 SCP/SFTP 执行命令、传输文件、运行后台任务并取回结果。需要先配置实例的 SSH 密钥或一个可用的 SSH 别名；本包没有内置 SSH 密码自动登录功能。普通实例可以走已有 SSH 工作流，Pro API 不会查询或管理普通实例。

API 接受开关机请求不等于操作已经完成，Skill 要求继续检查状态。开机后 SSH 也可能尚未就绪。插件不提供自动关机调度、创建前报价或预算上限；任务时长和收尾动作应按实际任务安排。开机命令失败不会触发自动关机。

## 可审查的代码与依赖

- `src/api.mjs`：固定官方 API 地址、鉴权、HTTP 请求、错误处理与凭据脱敏。
- `src/tools.mjs`：10 个工具的输入校验、预览和执行。
- `src/server.mjs`：注册 MCP 工具并启动本地 stdio 进程。
- `scripts/Configure-Token.ps1`：交互式配置本机加密凭据。
- `scripts/Read-Token.ps1`：MCP 内部使用的解密助手，请勿将其输出到聊天或日志。
- `dist/server.mjs`：上述代码和协议库的可运行打包产物，无需运行时下载依赖。

协议层使用 MCP 官方 TypeScript SDK `@modelcontextprotocol/server@2.2.0`、其 `core@2.2.0` 和输入校验库 `zod@4.6.5`。具体版本锁定在 `tooling/package-lock.json`，许可证见 `THIRD_PARTY_NOTICES.txt`。本地构建会另生成 `dependency-lock.json` 副本和 `dist/build-inputs.json` 报告，两者不进入 Git。这不意味着完全没有第三方库：AutoDL 业务逻辑由我们自建，MCP 协议和参数校验使用列出的通用库。

Token 只用于列出的 AutoDL 官方地址，请求不跟随重定向；创建等变更不自动重试。状态与详情按官方文档使用 GET 加 JSON Body。API 输出和错误均脱敏，失败时保留请求 ID。插件代码仍运行在当前用户权限下；DPAPI 不是对同一用户进程的隔离边界。

### 重新构建和复查

`tooling/` 附有构建脚本、版本锁和离线测试。只有重新构建或测试时才需要安装这些开发依赖；直接使用插件无需此步骤。

```powershell
npm.cmd ci --prefix tooling --ignore-scripts --no-audit --no-fund
node tooling/build.mjs
node --test tooling/verify.test.mjs
```

测试使用模拟 API 和无效的固定测试凭据，启动的 MCP 子进程不会读取你的实际 Token。它验证参数、请求格式、预览、脱敏和工具连接，不执行真实租卡操作。

## 验证与边界

验证结果见 `VERIFICATION.md`。本机安装发现、MCP 调用、离线契约测试与真实账户 API 测试分别报告。未配置账户时，不宣称真实开关机、租卡或 SSH 任务已经跑通。

## 官方参考

- [AutoDL 通用 API](https://www.autodl.com/docs/common_api/)
- [AutoDL Pro API](https://www.autodl.com/docs/instance_pro_api/)
- [Codex 插件格式与本地安装](https://developers.openai.com/plugins/build/plugins)
- [MCP 官方 SDK](https://github.com/modelcontextprotocol/typescript-sdk)

该包供本地使用。上传到账号不会使这个本地进程自动在网页或移动端运行；公共目录发布还需要相应的托管、认证与审核流程。
