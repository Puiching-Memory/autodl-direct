# AutoDL Direct 工具说明

安装、开发和职责边界见 [仓库 README](../../README.md)，真实与模拟验证见 [VERIFICATION](VERIFICATION.md)，操作流程见 [Skill](skills/autodl/SKILL.md)。本包仅面向 Windows Codex 的 Git 仓库安装路径。

## MCP 工具

| 工具 | 功能 |
| --- | --- |
| `autodl_setup_status` | 离线检查运行环境及凭据是否存在 |
| `autodl_balance` | 查询余额、代金券、累计消费，转换为元 |
| `autodl_list_instances` | 分页查询 Pro 实例，保留平台返回的定时关机字段 |
| `autodl_instance_status` | 查询状态；故障时有界分页回退并报告来源 |
| `autodl_instance_info` | 安全主机、端口、用户名和认证状态；密码及 Token 脱敏 |
| `autodl_list_images` | 分页查询 Pro 私有镜像和保存状态 |
| `autodl_list_public_data` | 无需凭据，按名称搜索和分页查询公共数据集/模型、实例路径、目录大小和发布方 |
| `autodl_create_instance` | 预览或创建按量计费 Pro 实例 |
| `autodl_power_on` | 预览或执行 GPU 模式开机 |
| `autodl_power_off` | 预览或执行关机 |
| `autodl_save_image` | 预览或保存系统盘镜像，不包含数据盘 |

变更默认 `execute=false`，不读取凭据、不发请求；`execute=true` 根据用户已有授权执行。API 接受请求后仍需检查状态或镜像列表。传输结果不确定时，返回 `accepted=null`、`outcome=unknown`、`retry_allowed=false` 并只读核实；创建候选或目标状态不证明本次请求成功。

状态/详情生产请求使用 GET Query，依据真实只读对照；官方文档描述 GET JSON Body，服务端或代理根因仍未定位。回退结果注明来源、时间及原始诊断；详情的部分列表回退不猜 SSH 地址。认证输出只说明字段是否提供及脱敏，不证明本地密钥或 SSH 登录可用。

## 查询故障排查

公共数据目录不需要配置 Token，可直接调用 `autodl_list_public_data`，例如 `{"keyword":"Vimeo","page_index":1,"page_size":20}`。不传 keyword 可浏览目录。根据 `pagination.next_page_index` 翻页；只有 `complete_query_result=true` 才表示本次筛选的全部结果已返回。目录路径不证明某个地区或 Pro 实例能够访问，需通过实例内只读检查确认。

此查询使用控制台的公共目录接口 `GET https://www.autodl.com/api/v1/common_data/list`，未使用或转发 Token/Cookie；不是已承诺稳定的开发者 API。字段变化、分页矛盾、超时、登录页或重定向会显式报错，不作为空结果返回。大小沿用控制台显示规则，不是实测文件字节数。

工具暂未暴露时，在插件根目录运行同样无需凭据的只读入口：

```powershell
node scripts/query-public-data.mjs --keyword Vimeo --page 1 --page-size 20
```

`autodl_setup_status` 只检查凭据存在，不能保证当前进程能解密。`CREDENTIALS_UNREADABLE` 可能来自进程权限、Windows 用户或环境差异，不代表 Token 无效；先检查执行上下文与插件连接。

聊天未暴露 MCP 工具时，在配置凭据的 Windows 用户上下文运行包内只读入口，并遵守宿主审批。在插件根目录：

```powershell
node scripts/query-account.mjs account 1 100
```

支持 `status`（离线检查）、`balance`、`instances <页码> <每页数量>`、`account <页码> <每页数量>`、`instance-status <pro-ID>` 和 `instance-info <pro-ID>`。分页默认 `1 100`，按 `max_page` / `result_total` 继续翻页。错误输出脱敏 JSON 和非零退出码；不接受 Token 参数或变更命令。

不要临时导入源码模拟工具，或直接运行内部 `Read-Token.ps1` 展示凭据。云端进程不能解密本机 DPAPI 文件，应使用有本机访问能力的 Codex 聊天。凭据配置及优先级见 [SECURITY](../../SECURITY.md)。

## 实现入口

- `src/api.mjs`：固定官方地址、鉴权、HTTP、错误与脱敏。
- `src/instances.mjs`：分页回退、连接字段、变更不确定时核实。
- `src/public-data.mjs`：独立的无凭据公共目录请求、分页和记录校验。
- `src/tools.mjs`：参数校验、默认预览与执行。
- `src/server.mjs`：注册 MCP，版本从 Codex 清单读取。
- `scripts/query-account.mjs`：复用运行包的只读查询入口。
- `scripts/query-public-data.mjs`：公共目录的无凭据只读入口。
- `scripts/diagnose-instance.mjs`：只读比较 GET Body、Query 及组合参数。
- `dist/server.mjs`：可直接运行的打包产物；依赖锁和离线测试位于 `tooling/`。
