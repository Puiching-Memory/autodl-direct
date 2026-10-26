import https from 'node:https';
import { SafeError, redact } from './api.mjs';

// Fixed read-only console endpoints, observed 2026-10-25. Never use the account
// client here: developer credentials are for api.autodl.com, not www.autodl.com.
export const PRO_CATALOG_ORIGIN = 'https://www.autodl.com';
export const PRO_CATALOG_PATHS = Object.freeze({ types: '/api/v1/machine_pro/gpu_type', specs: '/api/v1/machine_pro/gpu_spec_config' });
function parameters(input = {}) {
  if (!input || Array.isArray(input) || typeof input !== 'object' ||
      Object.keys(input).some(k => !['gpu_name', 'data_center_list'].includes(k)))
    throw new SafeError('INPUT', '只接受 gpu_name 和 data_center_list。');
  const { gpu_name, data_center_list = ['westDC3', 'beijingDC2'] } = input;
  if ((gpu_name !== undefined && (typeof gpu_name !== 'string' || !gpu_name.trim() || gpu_name.length > 100 || /[\u0000-\u001f\u007f]/u.test(gpu_name))) ||
      !Array.isArray(data_center_list) || !data_center_list.length || data_center_list.length > 20 ||
      data_center_list.some(x => typeof x !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(x)) || new Set(data_center_list).size !== data_center_list.length)
    throw new SafeError('INPUT', 'GPU 名称最长100字符；地区须为1至20个不同的合法标识。');
  return { ...(gpu_name === undefined ? {} : { gpu_name: gpu_name.trim() }), data_center_list };
}
export function requestProCatalog(kind, body, requestImpl = https.request) {
  if (!Object.hasOwn(PRO_CATALOG_PATHS, kind)) return Promise.reject(new SafeError('INPUT', '不支持的只读规格接口。'));
  // Revalidate the exact body before any network operation, even for direct callers.
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      (kind === 'types' ? Object.keys(body).join() !== 'data_center_list' :
        Object.keys(body).sort().join() !== 'charge_type,gpu_name' || body.charge_type !== 'payg' || typeof body.gpu_name !== 'string'))
    return Promise.reject(new SafeError('INPUT', '规格接口参数不合法。'));
  try { parameters(kind === 'types' ? body : { gpu_name: body.gpu_name }); }
  catch (error) { return Promise.reject(error); }
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    let req, timer, settled = false;
    const fail = error => { if (settled) return; settled = true; clearTimeout(timer); reject(error); req?.destroy(); };
    req = requestImpl(new URL(PRO_CATALOG_PATHS[kind], PRO_CATALOG_ORIGIN), {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let size = 0; const chunks = [];
      res.on('data', chunk => { size += chunk.length; if (size > 2*1024*1024) fail(new SafeError('RESPONSE_TOO_LARGE', '规格响应超过2 MiB。')); else chunks.push(chunk); });
      res.on('aborted', () => fail(new SafeError('NETWORK', '规格响应中断。')));
      res.on('error', () => fail(new SafeError('NETWORK', '规格响应读取失败。')));
      res.on('end', () => {
        if (settled) return;
        if (res.statusCode >= 300 && res.statusCode < 400) return fail(new SafeError('REDIRECT_BLOCKED', '规格接口重定向；未跟随。'));
        if (res.statusCode < 200 || res.statusCode >= 300) return fail(new SafeError('HTTP_ERROR', `规格查询失败（HTTP ${res.statusCode}）。`));
        let value;
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return fail(new SafeError('INVALID_RESPONSE', '规格接口未返回JSON。')); }
        settled = true; clearTimeout(timer); resolve(value);
      });
    });
    timer = setTimeout(() => fail(new SafeError('TIMEOUT', '规格查询超时。')), 20000); timer.unref?.();
    req.setTimeout(20000, () => fail(new SafeError('TIMEOUT', '规格查询超时。')));
    req.on('error', () => fail(new SafeError('NETWORK', '无法连接规格接口。')));
    req.end(payload);
  });
}
function rows(response) {
  if (response?.code !== 'Success') throw new SafeError('PRO_CATALOG_API', '规格查询未成功；不会发送 Token 或 Cookie 重试。', response?.request_id,
    { response_code: String(response?.code ?? 'missing').slice(0,100) });
  if (!Array.isArray(response.data) || response.data.length > 1000) throw new SafeError('RESPONSE_SCHEMA', '规格列表结构已变化，不能视为空库存。', response.request_id);
  return response.data;
}
const integer = (x, min = 0) => Number.isSafeInteger(x) && x >= min;
const text = x => typeof x === 'string' && x.trim() && x.length <= 100 && !/[\u0000-\u001f\u007f]/u.test(x);
const badSchema = () => { throw new SafeError('RESPONSE_SCHEMA', 'GPU 规格或价格字段已变化，不能估算费用。'); };
export class ProCatalogClient {
  constructor({ transport = requestProCatalog } = {}) { this.transport = transport; }
  async list(input = {}) {
    const query = parameters(input);
    const typesResponse = redact(await this.transport('types', { data_center_list: query.data_center_list }));
    const seen = new Set();
    const types = rows(typesResponse).map(row => {
      if (!text(row.gpu_type) || !integer(row.gpu_idle_num) || !integer(row.gpu_total_number) || row.gpu_idle_num > row.gpu_total_number || seen.has(row.gpu_type)) badSchema();
      seen.add(row.gpu_type);
      return { gpu_name: row.gpu_type, idle_gpu_count: row.gpu_idle_num, total_gpu_count: row.gpu_total_number };
    });
    let specs, specResponse;
    if (query.gpu_name !== undefined) {
      if (!seen.has(query.gpu_name)) throw new SafeError('GPU_NOT_LISTED', 'GPU 名称不在所选地区当前目录中；先省略 gpu_name 查询可用名称。');
      specResponse = redact(await this.transport('specs', { gpu_name: query.gpu_name, charge_type: 'payg' }));
      const ids = new Set();
      specs = rows(specResponse).map(row => {
        const sku = row.gpu_spec_config_sku_info?.find(x => x.type === 'payg');
        if (!integer(row.id,1) || !/^[A-Za-z0-9-]{1,100}$/.test(row.uuid ?? '') || ids.has(row.uuid) || row.gpu_name !== query.gpu_name || !text(row.name) || !text(row.gpu_spec_name) ||
            !integer(row.cpu_num_from,1) || !integer(row.cpu_num_to,row.cpu_num_from) || !integer(row.memory_size_from,1) || !integer(row.memory_size_to,row.memory_size_from) ||
            !integer(sku?.current_price,1) || !Array.isArray(sku.level_config)) badSchema();
        ids.add(row.uuid);
        const levels = sku.level_config.map(level => {
          if (!text(level.level_name) || !integer(level.discounted_price,1)) badSchema();
          return { level: level.level_name, yuan_per_gpu_hour: level.discounted_price / 1000 };
        });
        return { gpu_spec_uuid: row.uuid, spec_id: row.id, name: row.name, gpu_name: row.gpu_name, spec_name: row.gpu_spec_name,
          vcpu_range: [row.cpu_num_from,row.cpu_num_to], host_memory_gib_range: [row.memory_size_from/2**30,row.memory_size_to/2**30],
          list_yuan_per_gpu_hour: sku.current_price/1000, published_level_prices: levels,
          price_scope: 'GPU only; account level, coupon and disk charges not resolved' };
      });
    }
    return { source: 'official_pro_console_catalog', authentication: 'none; no Token or Cookie sent',
      api_origin: PRO_CATALOG_ORIGIN, api_paths: PRO_CATALOG_PATHS, observed_at: new Date().toISOString(), data_center_list: query.data_center_list,
      gpu_types: types, ...(specs === undefined ? {} : { specs }), request_ids: [typesResponse.request_id, ...(specResponse ? [specResponse.request_id] : [])],
      account_final_quote: 'unavailable_without_web_session',
      notes: ['来自官网未承诺稳定的控制台只读接口；库存为地区聚合快照，不保证创建成功。',
        '价格单位为人民币元/卡/小时。主机内存不是GPU显存；目录未提供GPU显存字段。',
        '订单价格预览要求网页登录；标价和各等级公开价不是账户最终总价，不含未核实磁盘收费。'] };
  }
}
