import https from 'node:https';
import { SafeError, redact } from './api.mjs';

// Observed in AutoDL's public-data console and tested without authentication.
// This console endpoint is separate from the documented developer API.
export const PUBLIC_DATA_ORIGIN = 'https://www.autodl.com';
export const PUBLIC_DATA_PATH = '/api/v1/common_data/list';

function parameters(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['keyword', 'page_index', 'page_size'].includes(key)))
    throw new SafeError('INPUT', '公共数据查询仅接受 keyword、page_index 和 page_size。');
  const { keyword = '', page_index = 1, page_size = 20 } = input;
  if (typeof keyword !== 'string' || keyword.length > 200 || /[\u0000-\u001f\u007f]/u.test(keyword) ||
      !Number.isInteger(page_index) || page_index < 1 || page_index > 10000 ||
      !Number.isInteger(page_size) || page_size < 1 || page_size > 100)
    throw new SafeError('INPUT', 'keyword 最长200字符；页码为1-10000，每页数量为1-100的整数。');
  return { keyword: keyword.trim(), page_index, page_size };
}

export function requestPublicData(input, requestImpl = https.request) {
  let query;
  try { query = parameters(input); } catch (error) { return Promise.reject(error); }
  const url = new URL(PUBLIC_DATA_PATH, PUBLIC_DATA_ORIGIN);
  url.search = new URLSearchParams({ key_word: query.keyword, date_from: '', date_to: '',
    page_index: String(query.page_index), page_size: String(query.page_size) }).toString();
  return new Promise((resolve, reject) => {
    let deadline, settled = false, req;
    const fail = error => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(error);
      req?.destroy();
    };
    req = requestImpl(url, { method: 'GET', headers: { Accept: 'application/json' } }, res => {
      const chunks = [];
      let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024)
          fail(new SafeError('RESPONSE_TOO_LARGE', '公共目录响应超过2 MiB读取上限。'));
        else chunks.push(chunk);
      });
      res.on('error', () => fail(new SafeError('NETWORK', '读取 AutoDL 公共目录失败。')));
      res.on('aborted', () => fail(new SafeError('NETWORK', 'AutoDL 公共目录响应中断。')));
      res.on('end', () => {
        if (settled) return;
        clearTimeout(deadline);
        if (res.statusCode >= 300 && res.statusCode < 400)
          return fail(new SafeError('REDIRECT_BLOCKED', '公共目录返回重定向；未跟随，也未发送账户凭据。'));
        if (res.statusCode < 200 || res.statusCode >= 300)
          return fail(new SafeError('HTTP_ERROR', `公共目录请求失败（HTTP ${res.statusCode}）。`));
        let response;
        try { response = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return fail(new SafeError('INVALID_RESPONSE', '公共目录返回非JSON响应，可能是登录页或接口已变化。')); }
        settled = true;
        resolve(response);
      });
    });
    deadline = setTimeout(() => fail(new SafeError('TIMEOUT', 'AutoDL 公共目录查询超时。')), 20000);
    deadline.unref?.();
    req.setTimeout(20000, () => fail(new SafeError('TIMEOUT', 'AutoDL 公共目录查询超时。')));
    req.on('error', () => fail(new SafeError('NETWORK', '无法连接 AutoDL 公共目录。')));
    req.end();
  });
}

function normalize(response, query) {
  const fail = () => { throw new SafeError('RESPONSE_SCHEMA', '公共目录字段或分页结构已变化，不能将其视为空目录。', response?.request_id); };
  if (!response || response.code !== 'Success')
    throw new SafeError('PUBLIC_DATA_API', 'AutoDL 公共目录查询未成功；不会回退发送 Token 或 Cookie。', response?.request_id,
      { response_code: String(response?.code ?? 'missing').slice(0, 100) });
  const data = response.data;
  if (!data || !Number.isInteger(data.result_total) || data.result_total < 0 ||
      !Number.isInteger(data.max_page) || data.max_page < 0 ||
      data.page_index !== query.page_index || data.page_size !== query.page_size) fail();
  const offset = (query.page_index-1)*query.page_size;
  const list = data.list === null && offset >= data.result_total ? [] : data.list;
  if (!Array.isArray(list) || list.length > query.page_size || list.length > data.result_total ||
      (data.result_total > 0 && data.max_page !== Math.ceil(data.result_total/query.page_size)) ||
      (data.result_total === 0 && data.max_page > 1) ||
      (query.page_index <= data.max_page && list.length === 0 && data.result_total > 0)) fail();
  const ids = new Set();
  const items = list.map(row => {
    if (!row || !Number.isInteger(row.id) || row.id < 1 || ids.has(row.id) ||
        typeof row.data_name !== 'string' || !row.data_name.trim() || row.data_name.length > 500 ||
        typeof row.exist_path !== 'string' || !row.exist_path.startsWith('/') ||
        row.exist_path.length > 4096 || /[\u0000-\u001f\u007f]/u.test(row.exist_path) ||
        row.exist_path.split('/').includes('..') ||
        !Number.isFinite(row.size) || row.size < 0 ||
        !['publisher', 'description', 'data_form'].every(key => typeof row[key] === 'string')) fail();
    ids.add(row.id);
    return { id: row.id, name: row.data_name, instance_path: row.exist_path,
      catalog_size_mb: row.size,
      size_display: row.size >= 1024 ? `${(row.size/1024).toFixed(2)} GB` : `${row.size} MB`,
      kind: row.data_form, publisher: row.publisher, description: row.description,
      instance_access: 'not_verified' };
  });
  if (list.length !== Math.min(query.page_size, Math.max(0, data.result_total-offset))) fail();
  return { source: 'autodl_public_catalog', source_url: 'https://www.autodl.com/console/public-data',
    api_origin: PUBLIC_DATA_ORIGIN, api_path: PUBLIC_DATA_PATH,
    authentication: 'none; no Token or Cookie sent', keyword: query.keyword,
    items, pagination: { page_index: query.page_index, page_size: query.page_size,
      max_page: data.max_page, result_total: data.result_total,
      next_page_index: query.page_index < data.max_page ? query.page_index+1 : null },
    complete_query_result: query.page_index === 1 && items.length === data.result_total,
    request_id: response.request_id, observed_at: new Date().toISOString(),
    notes: ['来自控制台公共目录接口，并非已承诺稳定的开发者API；结构变化将显式报错。',
      '大小按控制台MB字段及其1024进制GB显示规则呈现，不是实测文件字节数。',
      '目录路径不证明目标实例、地区或Pro产品能够挂载和读取，使用前须在实例内检查。'] };
}

export class PublicDataClient {
  constructor({ transport = requestPublicData } = {}) { this.transport = transport; }
  async list(input = {}) {
    const query = parameters(input);
    let response;
    try { response = await this.transport(query); }
    catch (error) {
      if (error instanceof SafeError) throw error;
      throw new SafeError('NETWORK', 'AutoDL 公共目录请求未完成。');
    }
    return normalize(redact(response), query);
  }
}
