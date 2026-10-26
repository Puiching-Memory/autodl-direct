# 凭据与问题报告

插件在当前用户权限下运行。Windows DPAPI 加密静态存储的 AutoDL Token，不能隔离同一用户下的其他进程。`AUTODL_TOKEN` 环境变量优先于 DPAPI 凭据；`AUTODL_CREDENTIAL_FILE` 可指定 DPAPI 文件位置。

受限 shell 与配置凭据的 Windows 用户可能具有不同的访问或解密能力。凭据读取失败不证明 Token 无效；不要为此把 Token 复制到工作区。包内 `scripts/query-account.mjs` 只提供配置、余额、分页实例列表及单实例状态/详情查询，遵守宿主的权限审批，不修改全局沙箱设置。

Token 只发送到列出的官方接口。请求不跟随重定向，变更不自动重试，密码和 Jupyter Token 会脱敏。系统 SSH 使用现有密钥或配置，不自动收集实例密码。

Pro 库存/标价查询只使用固定 `www.autodl.com/api/v1/machine_pro/gpu_type` 与 `gpu_spec_config` 的 POST JSON 只读接口，同样不读取或发送账户 Token/Cookie，响应限制2 MiB和20秒；账户订单报价的登录要求不会触发凭据转发。

SSH 工具只管理用户目录下专用 `~/.ssh/autodl-direct/` 子目录：生成无口令 Ed25519 密钥、拒绝路径穿越/符号链接和覆盖其他密钥；通过系统 ssh-keygen 核验公私钥匹配，但不返回私钥。创建/开机请求仅附带经校验的公钥，远端追加至 root 的 authorized_keys；不收集或传递实例密码。独立 SSH 配置保留 `StrictHostKeyChecking ask` 与现有 known_hosts，不启用 Agent 转发，也不自动执行网络登录。配置文件存在只证明本地准备完成，不证明远端授权或登录成功。

公共数据目录使用独立的固定 HTTPS GET 地址 `www.autodl.com/api/v1/common_data/list`，不读取或发送账户 Token、Cookie。输入不能修改主机、路径、方法或请求头；响应限制2 MiB和20秒，不跟随重定向，也不自动重试。目录接口失败时不会改用账户凭据。目录中的路径和文本仅作为数据返回，不执行、不自动挂载或下载。

不要提交 Token、DPAPI 文件、SSH 私钥、带凭据的 URL 或未脱敏日志。若误提交，应立即撤销相应凭据；删除文件不能撤销已泄露的凭据。

使用此私有仓库中双方均有权限访问的 Issue 报告问题，仅提供复现步骤、版本和已脱敏的信息。不要在 Issue、PR 或附件中粘贴真实凭据。此文件不承诺特定响应时限。
