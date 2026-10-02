# 验证记录

验证日期：2026-10-02。版本：AutoDL Direct 0.1.2，GitHub 私有分发版。

## 官方接口依据

接口、鉴权和实例产品限制依据 [AutoDL 通用 API](https://www.autodl.com/docs/common_api/) 和 [Pro API](https://www.autodl.com/docs/instance_pro_api/)。插件格式依据 [Codex 官方插件文档](https://developers.openai.com/plugins/build/plugins)。本包由本地工作区自建，与 AutoDL 官方无隶属关系。

## 本机实测

本次复查环境：Windows、Node.js 26.5.0、Codex CLI 0.159.0-alpha.12.1。初始 0.1.0 版曾在 Codex CLI 0.159.2 上验证。插件声明最低 Node.js 22，GitHub CI 配置了 Node.js 22 和 24；此记录中的本机结果使用 Node.js 26.5.0。

| 检查 | 结果 |
| --- | --- |
| Portable 和 Codex 兼容清单、相对路径、运行文件 | 通过 |
| 浅色和深色 SVG 图标、品牌色配置 | 文件和清单引用有效 |
| 三个 PowerShell 脚本语法解析 | 0 个语法错误 |
| Codex 注册插件目录、安装并启用插件 | 隔离配置验证通过；当前用户真实配置已安装并启用 |
| GitHub 仓库布局下的安装脚本 | 正确找到仓库根目录；原有目录清单未被修改 |
| Codex app-server 读取插件 | 正确识别插件界面、Skill 和 MCP 服务 |
| Codex app-server 连接 MCP | 成功发现全部 10 个工具；`toolsError=null` |
| MCP 官方客户端连接并调用 | 配置检查、参数预览、缺少凭据和错误输入处理通过 |
| Windows DPAPI 凭据读取 | 已修复继承 PowerShell 7 模块目录时的兼容问题；使用默认 Windows PowerShell 模块目录 |
| 真实账户只读余额查询 | 当前 Windows 用户加密保存凭据后，插件自动读取并查询成功；不记录 Token 或余额值 |
| 离线测试 | 12 项通过，0 项失败 |

离线测试覆盖：四种变更操作的预览不读取凭据、不联网；显式执行只发送一次请求；Pro ID 和数量等参数校验；余额单位换算；嵌套凭据与错误脱敏；GET JSON Body 和原样 Authorization；拒绝重定向；拒绝未知地址、路径和方法；变更不自动重试；打包后的 MCP 连接和工具发现；清单与资源引用。

离线测试使用单独的测试配置，不修改真实账户凭据；模拟请求使用固定的无效测试凭据。DPAPI 回归测试只在临时目录加密并读取无效测试凭据，覆盖继承冲突模块目录的情况。本机安装验证另外检查了当前用户真实的 Codex 插件配置和工具加载。

## 尚未实测

真实账户的 Token 验证、DPAPI 加密保存、插件自动读取和只读余额查询已在当前 Windows 用户下验证。尚未使用真实 AutoDL 账户测试实例列表、创建、开关机或保存镜像。

未实测真实实例的 SSH 登录、文件传输、训练任务或结果下载。Skill 提供流程指导，需要可用的 SSH 密钥或 SSH 配置，完成状态必须以远端证据确认。

账户访问、GPU 资源供应、实际计费和 API 完成状态不能由离线测试证明。普通实例可以使用系统 SSH；本包实例管理 API 只覆盖 Pro。未包含实例释放、企业弹性部署、自动关机调度或预算上限。

## 自行复查

`src/` 为业务源码，`dist/` 为可运行产物，`tooling/` 提供构建和测试代码及锁定依赖。按 README 中的命令可重新构建和运行测试。ZIP 包不包含凭据、开发依赖目录或本次测试的 Codex 配置。
