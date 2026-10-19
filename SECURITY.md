# 凭据与问题报告

插件在当前用户权限下运行。Windows DPAPI 加密静态存储的 AutoDL Token，不能隔离同一用户下的其他进程。`AUTODL_TOKEN` 环境变量优先于 DPAPI 凭据；`AUTODL_CREDENTIAL_FILE` 可指定 DPAPI 文件位置。

受限 shell 与配置凭据的 Windows 用户可能具有不同的访问或解密能力。凭据读取失败不证明 Token 无效；不要为此把 Token 复制到工作区。包内 `scripts/query-account.mjs` 只提供配置、余额、分页实例列表及单实例状态/详情查询，遵守宿主的权限审批，不修改全局沙箱设置。

Token 只发送到列出的官方接口。请求不跟随重定向，变更不自动重试，密码和 Jupyter Token 会脱敏。系统 SSH 使用现有密钥或配置，不自动收集实例密码。

公共数据目录使用独立的固定 HTTPS GET 地址 `www.autodl.com/api/v1/common_data/list`，不读取或发送账户 Token、Cookie。输入不能修改主机、路径、方法或请求头；响应限制2 MiB和20秒，不跟随重定向，也不自动重试。目录接口失败时不会改用账户凭据。目录中的路径和文本仅作为数据返回，不执行、不自动挂载或下载。

不要提交 Token、DPAPI 文件、SSH 私钥、带凭据的 URL 或未脱敏日志。若误提交，应立即撤销相应凭据；删除文件不能撤销已泄露的凭据。

使用此私有仓库中双方均有权限访问的 Issue 报告问题，仅提供复现步骤、版本和已脱敏的信息。不要在 Issue、PR 或附件中粘贴真实凭据。此文件不承诺特定响应时限。
