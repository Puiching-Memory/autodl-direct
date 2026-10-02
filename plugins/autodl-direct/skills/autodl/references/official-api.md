# 官方接口与能力边界

核对日期：2026-10-02。政策、价格、镜像和库存应以实际请求和官方最新文档为准。

- 通用 API：https://www.autodl.com/docs/common_api/
- Pro API：https://www.autodl.com/docs/instance_pro_api/
- 弹性部署：https://www.autodl.com/docs/esd_api_doc/
- SSH、数据上传和下载从帮助站目录进入：https://www.autodl.com/docs/
- Codex 插件格式：https://developers.openai.com/plugins/build/plugins
- Codex MCP 配置：https://learn.chatgpt.com/docs/extend/mcp?surface=cli

开发者 Token 位于 AutoDL 控制台的账号设置。请求头为 `Authorization: <原始 Token>`，不加 Bearer。成功判断为 `code == "Success"`，保留 `request_id` 便于定位错误。余额相关整数除以 1000 才是元。

Pro API 需个人实名认证或企业认证。创建为按量计费；开机支持 GPU 模式。状态和详情按照文档使用 GET 加 JSON Body，本地客户端专门保留此形式。普通容器实例不属于 Pro API；弹性部署需要企业认证，本插件尚未实现。

API 的 `start_command` 执行失败不会自动关机。保存镜像不是数据盘备份。本地工具在未获得账户验证前，不应宣称账户接口、镜像兼容性或真实 SSH 任务已经跑通。
