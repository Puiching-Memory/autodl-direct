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
| `autodl_pro_catalog` | 无需登录查询地区聚合库存；指定 gpu_name 返回可用于创建的规格 ID 与人民币/卡/小时标价 |
| `autodl_prepare_ssh_key` | 预览或生成/复用本机专用无口令 Ed25519 密钥，仅返回公钥、指纹和路径 |
| `autodl_prepare_ssh_connection` | 查询实例详情，预览或写入独立 SSH 配置；保留主机指纹验证 |
| `autodl_create_instance` | 预览或创建按量计费 Pro 实例 |
| `autodl_power_on` | 预览或执行 GPU 模式开机 |
| `autodl_power_off` | 预览或执行关机 |
| `autodl_save_image` | 预览或保存系统盘镜像，不包含数据盘 |

生命周期变更默认 `execute=false`，不读取凭据、不发请求；`execute=true` 根据用户已有授权执行。SSH 密钥预览不写文件；SSH 配置预览会只读查询实例详情，但不写文件。API 接受请求后仍需检查状态或镜像列表。传输结果不确定时，返回 `accepted=null`、`outcome=unknown`、`retry_allowed=false` 并只读核实；创建候选或目标状态不证明本次请求成功。

状态/详情生产请求使用 GET Query，依据真实只读对照；官方文档描述 GET JSON Body，服务端或代理根因仍未定位。回退结果注明来源、时间及原始诊断；详情的部分列表回退不猜 SSH 地址。认证输出只说明字段是否提供及脱敏，不证明本地密钥或 SSH 登录可用。

## 查询故障排查

### 无登录的 Pro 库存与标价

调用 `autodl_pro_catalog`，先不传 `gpu_name` 获取准确名称；再传例如 `{"gpu_name":"vGPU-48GB"}` 查询规格。默认地区 `westDC3`、`beijingDC2` 可通过 `data_center_list` 调整。`gpu_spec_uuid` 可直接用于 Pro 创建；`spec_id` 是官网内部编号，两者不能混用。`host_memory_gib_range` 是主机内存，不能当作显存。

```powershell
node scripts/query-pro-catalog.mjs --gpu-name vGPU-48GB --regions westDC3,beijingDC2
```

该只读入口与 MCP 均不读取或发送账户 Token/Cookie。库存是地区聚合快照；标价与公开会员等级价不证明账户享有折扣。账户订单预览接口仍要求网页登录，插件明确返回 `account_final_quote=unavailable_without_web_session`，不会伪装成最终报价；磁盘收费仍需核实。官网接口未承诺稳定，变化会显式报错。

### 专用 SSH 接入

1. `autodl_prepare_ssh_key({"key_name":"my-training","execute":true})` 在 `%USERPROFILE%/.ssh/autodl-direct/` 生成或复用密钥。仅返回公钥、指纹和文件路径；不覆盖已有密钥，私钥不返回或上传。密钥无口令，依赖本机用户与 OpenSSH 文件权限保护。
2. 将返回的 `ssh_public_key` 传入 `autodl_create_instance` 或 `autodl_power_on`。默认先看预览，再按已有授权执行。只在 root 的 `authorized_keys` 中追加该公钥，不替换其他密钥；公钥不是秘密。该路径用于新建/开机操作，不会直接配置已经运行的实例。不能仅为安装密钥擅自重启已有任务。
3. 实例启动后调用 `autodl_prepare_ssh_connection({"instance_uuid":"pro-...","key_name":"my-training","execute":true})`。工具只写专用配置，返回 SSH/SCP/SFTP 参数数组，不修改用户主配置。
4. 使用系统 SSH 核验主机指纹并执行无害命令。公钥安装和实际登录成功仍需远端验证；首次连接不能跳过主机验证。连接工具不会自动开机，也不自动执行 SSH。

开机命令安装公钥失败不会关机，不停止计费。需要私钥密码或其他系统用户时使用已有授权配置，不从 API 提取明文密码。远程传输和训练仍由项目组织。

### 公共数据目录

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
- `src/pro-catalog.mjs`：独立的无凭据 Pro 库存/标价查询。
- `src/ssh.mjs`：专用密钥、独立配置与公钥开机安装命令；不执行远程 SSH。
- `src/tools.mjs`：参数校验、默认预览与执行。
- `src/server.mjs`：注册 MCP，版本从 Codex 清单读取。
- `scripts/query-account.mjs`：复用运行包的只读查询入口。
- `scripts/query-public-data.mjs`：公共目录的无凭据只读入口。
- `scripts/query-pro-catalog.mjs`：Pro 库存和标价的无凭据只读入口。
- `scripts/diagnose-instance.mjs`：只读比较 GET Body、Query 及组合参数。
- `dist/server.mjs`：可直接运行的打包产物；依赖锁和离线测试位于 `tooling/`。
