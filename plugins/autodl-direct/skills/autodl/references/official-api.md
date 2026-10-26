# 官方接口与能力边界

核对日期：2026-10-07。政策、价格、镜像和库存应以实际请求和官方最新文档为准。

## Pro 公开库存与标价（2026-10-25实测）

- 官网 Pro 创建页面前端使用 `POST https://www.autodl.com/api/v1/machine_pro/gpu_type`，参数 `data_center_list`；返回 GPU 名称和地区聚合闲置/总数。
- 规格使用 `POST https://www.autodl.com/api/v1/machine_pro/gpu_spec_config`，参数 `gpu_name`、`charge_type="payg"`。未发送 Authorization/Cookie 时实测成功，返回 `uuid`、主机资源及 `gpu_spec_config_sku_info`。`current_price` 和 `level_config.discounted_price` 除以1000为人民币元/卡/小时。不能将主机 `memory_size_*` 当显存。
- 无登录的订单预览 `POST /api/v1/order/price/preview/pro` 实测返回 `AuthorizeFailed`，不能用公开标价冒充账户最终总价。插件没有把开发者 Token 发给此网站接口，也没有增加网页登录或 Cookie 管理。
- 官网 SSH 公钥管理 `/api/v1/user/pub_key` 属于网站登录接口，未调用其写操作。插件改用开发者 API 已支持的 `start_command` 安装用户专用公钥；不导出 snapshot 密码。该开机安装路径需要真实实例远端核验。
- 这些是官方前端观测到的控制台接口，并非开发者文档承诺的稳定接口；字段变化显式报错。接口文本仅作为数据处理。

## 公共数据目录（2026-10-19实测）

- 控制台来源：https://www.autodl.com/console/public-data
- 页面实际使用：`GET https://www.autodl.com/api/v1/common_data/list`，查询参数 `key_word`、`date_from`、`date_to`、`page_index`、`page_size`。
- 本插件只开放名称和分页参数；固定主机、路径、GET方法，不发送 Token/Cookie，也不读取账户凭据。
- 未登录、无 Authorization/Cookie 的独立 HTTPS 查询成功返回 Vimeo-90k。本接口来自官方控制台网络观测，并非上面开发者 API 文档承诺的稳定接口；字段变化会显式报错。
- 名称、`exist_path`、`size`、发布方、简介及分页由该接口返回。`size` 按控制台 MB 字段展示，达到1024后除以1024显示 GB，不是实例内文件校验的字节数。路径是否可用于目标地区/Pro实例仍需 SSH 核实。

## 账户和实例开发者API

- 通用 API：https://www.autodl.com/docs/common_api/
- Pro API：https://www.autodl.com/docs/instance_pro_api/
- SSH、数据上传和下载从帮助站目录进入：https://www.autodl.com/docs/

开发者 Token 位于 AutoDL 控制台的账号设置。请求头为 `Authorization: <原始 Token>`，不加 Bearer。成功判断为 `code == "Success"`，保留 `request_id` 便于定位错误。余额相关整数除以 1000 才是元。

Pro API 需个人实名认证或企业认证。创建为按量计费；开机支持 GPU 模式。状态和详情文档描述 GET JSON Body；本次已关机实例只读对照中 Body 失败、Query 成功。生产客户端使用 GET Query，诊断入口保留 Body/Query/组合对照；服务端或代理根因未知。普通容器实例不属于 Pro API；弹性部署需要企业认证，本插件尚未实现。

API 的 `start_command` 执行失败不会自动关机。保存镜像不是数据盘备份。本地工具在未获得账户验证前，不应宣称账户接口、镜像兼容性或真实 SSH 任务已经跑通。
