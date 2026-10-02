---
name: autodl
description: 使用本地自建 AutoDL Direct 插件查询余额和 Pro 实例、创建或开关机 GPU 实例、保存镜像，并配合系统 SSH 上传代码、训练、查看日志和取回结果。用户提到 AutoDL GPU 工作流时使用。
---

# AutoDL Direct

Use the bundled `autodl-direct` MCP tools. This is a local integration written in this workspace, not an AutoDL-authored product. Its API requests go directly to `https://api.autodl.com`. It has no account-sharing service.

## Connect and inspect

1. Call the exposed `autodl_setup_status` MCP tool. If the tools are not exposed in this chat, use the documented read-only fallback below; do not import `src/` or `dist/server.mjs` into an ad hoc shell to simulate tools. `credentialsConfigured=true` only means that a credential exists; it does not prove the current process can decrypt it. If credentials are missing, direct the user to run `scripts/Configure-Token.ps1` in a local terminal. Never ask the user to paste a Token into chat. Never run or display the internal `Read-Token.ps1` helper yourself.
2. Use `autodl_balance`, `autodl_list_instances`, and the specific instance's status to establish the current account state. This API lists Pro instances only. A missing standard instance is not evidence that it was deleted.
3. Use pagination when looking for a specific instance. Do not claim the first page contains all account resources.
4. Consult the official pages in `references/official-api.md` for product permissions, GPU/image IDs, regions, pricing, and data retention. Do not treat the local documentation date as proof of current rules.

## Read-only fallback when MCP tools are unavailable

Some chats expose this Skill and local shell access without exposing this plugin's MCP tools. For account queries in that case, resolve the plugin root from this Skill's location (`../..` from its directory), then run its packaged `scripts/query-account.mjs`. Use the installed version's path, not a hard-coded cache version. This entry point reuses the bundled API client, keeps credentials internal, and supports only configuration, balance and paginated Pro-instance queries:

```powershell
node "<plugin-root>/scripts/query-account.mjs" account 1 100
```

`status` checks credential existence without decrypting it or contacting AutoDL. `balance` queries only the wallet. `instances <page_index> <page_size>` queries one page, and `account <page_index> <page_size>` queries both the wallet and one page. Inspect `pro_instances.data.max_page` / `result_total` and continue pagination as required; never describe an incomplete page as the entire account.

On Windows, encrypted credentials belong to the Windows user who configured them. A restricted shell may discover the file but fail to read it in that user context. For an already-authorized account query, run this exact read-only entry point with `exec_command` using `sandbox_permissions="require_escalated"`, a short justification covering the current user's encrypted credential and AutoDL read-only network access, and no credential values in the command. Honor the host's approval decision. Do not disable the sandbox globally, extract the Token, or copy credentials into the workspace. Use an available Node.js executable; no runtime dependencies need installing.

On `CREDENTIALS_UNREADABLE`, check the execution context and plugin connection before asking the user to reconfigure. Do not claim the Token is invalid based on that error. If this chat cannot execute on the local Windows host or the host denies the required permission, explain that boundary and direct the user to a local Codex chat with the actual MCP tools. Local DPAPI credentials cannot authenticate a cloud-only process. This fallback has no mutation commands; creating, starting, stopping or imaging instances requires the actual MCP tools and the existing authorization rules below.

## Perform requested actions

Mutation tools default to a request preview (`execute=false`). Inspect concrete parameters before execution. The user's existing authorization persists: if it already covers the operation and target, use `execute=true` without asking again. Request missing target, GPU specification, image or runtime constraints only when they cannot be inferred.

Creating or starting an instance begins billing. The plugin has no price quotation endpoint, spending cap, or automatic shutdown scheduler. Do not promise those safeguards. Agree a run duration and completion behavior as needed for the task, and implement the shutdown using an authorized workflow. A `start_command` failure does not stop the instance.

After a mutation, API acceptance is only a submission result. Poll the instance status with reasonable delays until the requested transition is confirmed; after image saving, check the private-image list. Network errors and timeouts can leave the outcome unknown. Query state before retrying a mutation, especially creation.

## Run work through system SSH

Use the operating system's OpenSSH and SCP/SFTP. Prefer an existing user-authorized SSH alias and key. If authentication or host verification requires the user, present the exact connection command for their local terminal; do not scrape passwords from outputs or disable host-key verification. Pro connection details can be refreshed with `autodl_instance_info`; the password remains redacted.

1. Refresh connection details after each start. A running status does not prove SSH is ready; verify connectivity with a harmless command and bounded retries.
2. Use a login shell on the remote instance so its Python/Conda environment is available. Do not assume the exact image-specific environment without checking it.
3. Upload only requested project inputs and exclude unrelated local files. For long jobs, start a background process with a log and recorded process ID. Report how to inspect and stop that job.
4. Monitor logs, remote exit status and output files. Copy results to the user-requested local destination and verify the transfer before reporting success.
5. When the user's task includes shutdown, request it through `autodl_power_off` and confirm the stopped state. Preserve required outputs and system/data disk backups according to the user's instructions.

The plugin does not expose instance release or elastic-deployment tools in this version. For standard instances, use the existing SSH workflow and the official console for unsupported lifecycle operations.
