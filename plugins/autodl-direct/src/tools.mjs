import * as z from 'zod/v4';
import { existsSync } from 'node:fs';
import { AutoDLClient, API_ORIGIN, ENDPOINTS, SafeError, credentialFile, redact } from './api.mjs';

const id = z.string().regex(/^pro-[A-Za-z0-9-]{1,80}$/).describe('AutoDL Pro 实例 ID；普通实例不能用于此接口');
const execute = z.boolean().default(false).describe('false 只预览；true 根据用户已有授权执行真实操作');
const command = z.string().max(16384).optional().describe('可选的开机命令。命令失败不会自动关机；不要在此传入凭据');
const page = {
  page_index: z.number().int().min(1).default(1),
  page_size: z.number().int().min(1).max(100).default(20)
};

export function createTools(client = new AutoDLClient(), env = process.env) {
  const read = (name, title, description, shape, run, openWorld = true) => ({
    name, title, description, schema: z.object(shape).strict(), run,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: openWorld }
  });
  const write = (name, title, description, shape, endpoint, map, destructive = false) => ({
    name, title, description, schema: z.object({ ...shape, execute }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: destructive, idempotentHint: false, openWorldHint: true },
    run: async input => {
      const body = map(input);
      const [method, apiPath] = ENDPOINTS[endpoint];
      if (!input.execute) return {
        executed: false, preview: { method, url: API_ORIGIN + apiPath, body: redact(body) },
        note: '仅预览，未发送请求。execute=true 会执行真实操作；应先确认用户授权已覆盖目标与操作。'
      };
      const result = await client.call(endpoint, body);
      return { executed: true, accepted: true, ...result,
        note: '官方 API 已接受请求；实际完成情况请再查询实例状态或镜像列表。' };
    }
  });
  return [
    read('autodl_setup_status', '检查本机配置', '无需 Token、无需联网；检查运行环境和是否存在凭据。不会读取或展示凭据内容。', {}, async () => ({
      runtime: 'local', platform: process.platform, node: process.versions.node,
      credentialsConfigured: Boolean(env.AUTODL_TOKEN?.trim() || (credentialFile(env) && existsSync(credentialFile(env)))),
      apiOrigin: API_ORIGIN, instanceProduct: 'Pro',
      nativeSsh: '通过系统 SSH 使用已有的密钥或 SSH 配置。'
    }), false),
    read('autodl_balance', '查询余额', '查询余额、累计消费与代金券；金额转换为人民币元。', {}, async () => {
      const result = await client.call('balance');
      const { assets, accumulate, voucher_balance } = result.data ?? {};
      if (![assets, accumulate, voucher_balance].every(Number.isFinite)) throw new SafeError('RESPONSE_SCHEMA', 'AutoDL 余额字段与文档不符。');
      return { balance_yuan: assets / 1000, accumulated_yuan: accumulate / 1000,
        voucher_yuan: voucher_balance / 1000, request_id: result.request_id };
    }),
    read('autodl_list_instances', '列出 Pro 实例', '分页查询 Pro 实例列表。普通容器实例不会在此列出。', page, input => client.call('list', input)),
    read('autodl_instance_status', '查询实例状态', '查询 Pro 实例状态；判断开关机是否真正完成。', { instance_uuid: id }, input => client.call('status', input)),
    read('autodl_instance_info', '查询实例详情', '获取硬件、使用情况与 SSH 地址。密码和 Jupyter Token 始终脱敏；价格来自实例详情，不是创建前报价。', { instance_uuid: id }, input => client.call('snapshot', input)),
    read('autodl_list_images', '列出私有镜像', '分页查询 Pro 私有镜像与保存状态；公共镜像和 GPU 规格须查官方文档。', page, input => client.call('images', input)),
    write('autodl_create_instance', '创建 Pro 实例', '创建按量计费的 Pro 实例。默认只预览。需要实名认证；不会设置自动关机或承诺价格上限。', {
      req_gpu_amount: z.number().int().min(1).max(4),
      expand_system_disk_by_gb: z.number().int().min(0).max(500).default(0),
      gpu_spec_uuid: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
      image_uuid: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
      cuda_v_from: z.number().int().min(100).max(999),
      data_center_list: z.array(z.string().regex(/^[A-Za-z0-9-]{1,80}$/)).max(20).optional(),
      instance_name: z.string().max(100).optional(), start_command: command
    }, 'create', ({ execute: _execute, ...body }) => body),
    write('autodl_power_on', '开机 Pro 实例', '以 GPU 模式开机并开始计费。默认只预览；开机命令失败不会自动关机。', {
      instance_uuid: id, start_command: command
    }, 'powerOn', ({ instance_uuid, start_command }) => ({ instance_uuid, payload: 'gpu', ...(start_command === undefined ? {} : { start_command }) })),
    write('autodl_power_off', '关机 Pro 实例', '关机以停止 GPU 计费，会中断训练或服务。默认只预览；调用后须检查状态。', {
      instance_uuid: id
    }, 'powerOff', ({ instance_uuid }) => ({ instance_uuid }), true),
    write('autodl_save_image', '保存 Pro 镜像', '保存实例系统盘镜像。默认只预览；不包含数据盘，需要查询镜像列表确认完成。', {
      instance_uuid: id, image_name: z.string().min(1).max(100)
    }, 'saveImage', ({ instance_uuid, image_name }) => ({ instance_uuid, image_name }))
  ];
}

export function toolResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

export function errorResult(error) {
  const safe = error instanceof SafeError ? { code: error.code, message: error.message,
    ...(error.requestId === undefined ? {} : { request_id: error.requestId }) } :
    { code: 'INTERNAL', message: '操作未完成。请检查本机配置或查看实例状态。' };
  return { content: [{ type: 'text', text: JSON.stringify(safe) }], isError: true };
}
