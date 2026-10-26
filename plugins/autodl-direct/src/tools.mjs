import * as z from 'zod/v4';
import { existsSync } from 'node:fs';
import { AutoDLClient, API_ORIGIN, ENDPOINTS, SafeError, credentialFile, redact } from './api.mjs';
import { instanceStatus, instanceInfo, scanInstances, reconcileMutation, safeFailure } from './instances.mjs';
import { PublicDataClient } from './public-data.mjs';
import { ProCatalogClient } from './pro-catalog.mjs';
import { SshManager, validatePublicKey, sshBootstrap } from './ssh.mjs';

const id = z.string().regex(/^pro-[A-Za-z0-9-]{1,80}$/).describe('AutoDL Pro 实例 ID；普通实例不能用于此接口');
const execute = z.boolean().default(false).describe('false 只预览；true 根据用户已有授权执行真实操作');
const command = z.string().max(16384).optional().describe('可选的开机命令。命令失败不会自动关机；不要在此传入凭据');
const publicKey = z.string().max(256).refine(value => { try { validatePublicKey(value); return true; } catch { return false; } }, '需要不含注释的 Ed25519 公钥').optional().describe('本机专用 Ed25519 公钥；开机命令安装到 root 的 authorized_keys，禁止提供私钥');
const keyName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/).refine(x => !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(x));
const page = {
  page_index: z.number().int().min(1).default(1),
  page_size: z.number().int().min(1).max(100).default(20)
};
export function createTools(client = new AutoDLClient(), env = process.env, publicDataClient = new PublicDataClient(), proCatalogClient = new ProCatalogClient(), ssh = new SshManager()) {
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
      // Record the pre-existing IDs before creation, so a timeout never invites
      // a blind second rental. Candidate discovery still cannot prove causality.
      const before = endpoint === 'create' ? await scanInstances(client) : undefined;
      let result;
      try { result = await client.call(endpoint, body); }
      catch (error) {
        if (!['NETWORK', 'TIMEOUT', 'HTTP_ERROR', 'INVALID_RESPONSE', 'RESPONSE_TOO_LARGE', 'REDIRECT_BLOCKED'].includes(error.code)) throw error;
        return { executed: true, accepted: null, outcome: 'unknown', retry_allowed: false,
          failure: safeFailure(error), verification: await reconcileMutation(client, endpoint, body, before),
          note: '变更仅发送一次。已尝试只读核实；观察到目标状态不证明本次请求已成功，创建候选也不是因果证明。核实前不要重复变更。' };
      }
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
    read('autodl_instance_status', '查询实例状态', '查询 Pro 实例状态；失败时有界分页列表回退，注明来源、时间和原始 request_id。', { instance_uuid: id }, input => instanceStatus(client, input)),
    read('autodl_instance_info', '查询实例详情', '获取详情及安全主机、端口、用户名和认证可用性；未验证 SSH 登录。密码和 Token 脱敏，回退列表不猜连接地址。', { instance_uuid: id }, input => instanceInfo(client, input)),
    read('autodl_list_images', '列出私有镜像', '分页查询 Pro 私有镜像与保存状态；公共镜像和 GPU 规格须查官方文档。', page, input => client.call('images', input)),
    read('autodl_pro_catalog', '查询 Pro 库存与标价', '无需登录查询地区聚合 GPU 库存；指定目录中的 gpu_name 返回规格 ID、主机内存和人民币/卡/小时标价。不是账户最终订单报价，不含未核实磁盘收费；不发送 Token 或 Cookie。', {
      gpu_name: z.string().min(1).max(100).regex(/^[^\u0000-\u001f\u007f]*$/u).optional(),
      data_center_list: z.array(z.string().regex(/^[A-Za-z0-9-]{1,80}$/)).min(1).max(20).default(['westDC3','beijingDC2'])
    }, input => proCatalogClient.list(input)),
    { name:'autodl_prepare_ssh_key',title:'准备专用 SSH 密钥',description:'默认预览；execute=true 在本机 SSH 子目录生成或复用专用无口令 Ed25519 密钥。只返回公钥、路径与指纹，私钥不返回或上传，不覆盖已有密钥。',
      schema:z.object({key_name:keyName,execute}).strict(),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false},
      run: input => ssh.key(input.key_name,input.execute) },
    { name:'autodl_prepare_ssh_connection',title:'准备实例 SSH 配置',description:'从 Pro 详情刷新连接信息；默认只预览独立配置，execute=true 写入本机专用配置。保留主机指纹核验，不证明公钥已安装或 SSH 登录成功。',
      schema:z.object({instance_uuid:id,key_name:keyName,execute}).strict(),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true},
      run: async input => {
        const info = await instanceInfo(client,{instance_uuid:input.instance_uuid});
        return {...await ssh.connection(input.instance_uuid,input.key_name,info.connection,input.execute),connection_source:info.source,request_id:info.request_id,observed_at:info.observed_at};
      } },
    read('autodl_list_public_data', '查询公共数据目录', '按名称搜索并分页查询 AutoDL 公共数据集和模型目录，返回挂载路径、目录大小、发布方及简介。不需要Token，不发送Token或Cookie；路径不代表目标实例可访问。目录接口变化时显式报错。', {
      keyword: z.string().max(200).regex(/^[^\u0000-\u001f\u007f]*$/u).default(''),
      page_index: z.number().int().min(1).max(10000).default(1),
      page_size: z.number().int().min(1).max(100).default(20)
    }, input => publicDataClient.list(input)),
    write('autodl_create_instance', '创建 Pro 实例', '创建按量计费的 Pro 实例。默认只预览。需要实名认证；不会设置自动关机或承诺价格上限。', {
      req_gpu_amount: z.number().int().min(1).max(4),
      expand_system_disk_by_gb: z.number().int().min(0).max(500).default(0),
      gpu_spec_uuid: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
      image_uuid: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
      cuda_v_from: z.number().int().min(100).max(999),
      data_center_list: z.array(z.string().regex(/^[A-Za-z0-9-]{1,80}$/)).max(20).optional(),
      instance_name: z.string().max(100).optional(), start_command: command, ssh_public_key: publicKey
    }, 'create', ({ execute: _execute, ssh_public_key, ...body }) => {
      const start_command = sshBootstrap(ssh_public_key,body.start_command);
      return {...body,...(start_command === undefined ? {} : {start_command})};
    }),
    write('autodl_power_on', '开机 Pro 实例', '以 GPU 模式开机并开始计费。默认只预览；开机命令失败不会自动关机。', {
      instance_uuid: id, start_command: command, ssh_public_key: publicKey
    }, 'powerOn', ({ instance_uuid, start_command, ssh_public_key }) => {
      const combined = sshBootstrap(ssh_public_key,start_command);
      return {instance_uuid,payload:'gpu',...(combined === undefined ? {} : {start_command:combined})};
    }),
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
    ...(error.requestId === undefined ? {} : { request_id: error.requestId }),
    ...(error.diagnostics === undefined ? {} : { diagnostics: error.diagnostics }) } :
    { code: 'INTERNAL', message: '操作未完成。请检查本机配置或查看实例状态。' };
  return { content: [{ type: 'text', text: JSON.stringify(safe) }], isError: true };
}
