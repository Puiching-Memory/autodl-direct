import { SafeError } from './api.mjs';

export const safeFailure = error => ({ code: error instanceof SafeError ? error.code : 'INTERNAL',
  ...(error instanceof SafeError ? { message: error.message, request_id: error.requestId, diagnostics: error.diagnostics } : {}) });
const fallbackCodes = new Set(['RequestParameterIsWrong', 'NETWORK', 'TIMEOUT', 'HTTP_ERROR', 'INVALID_RESPONSE', 'RESPONSE_SCHEMA']);

export async function scanInstances(client, target, { maxPages = 100 } = {}) {
  const entries = [], requests = [];
  for (let page_index = 1; page_index <= maxPages; page_index++) {
    const response = await client.call('list', { page_index, page_size: 100 });
    const data = response.data;
    if (!Array.isArray(data?.list) || !Number.isInteger(data.max_page) || data.max_page < 0)
      throw new SafeError('RESPONSE_SCHEMA', '实例列表缺少有效 list/max_page，不能判断资源不存在。', response.request_id);
    requests.push({ page_index, request_id: response.request_id });
    if (target) {
      const found = data.list.find(item => (item.uuid ?? item.instance_uuid) === target);
      if (found) return { found, requests, complete: false, observed_at: new Date().toISOString() };
    } else entries.push(...data.list);
    if (page_index >= data.max_page) return { found: undefined, entries, requests, complete: true, observed_at: new Date().toISOString() };
  }
  throw new SafeError('PAGINATION_LIMIT', '已到分页读取上限，不能声称资源不存在。');
}

export async function instanceStatus(client, input) {
  let failure;
  try {
    const result = await client.call('status', input);
    if (typeof result.data !== 'string' || !result.data)
      throw new SafeError('RESPONSE_SCHEMA', '状态响应不是非空字符串。', result.request_id);
    return { ...result, source: 'status_api', observed_at: new Date().toISOString() };
  } catch (error) {
    if (!fallbackCodes.has(error.code)) throw error;
    failure = safeFailure(error);
  }
  let scan;
  try { scan = await scanInstances(client, input.instance_uuid); }
  catch (error) { throw new SafeError(error.code ?? 'INTERNAL', '状态接口和列表回退均未取得可靠状态。', error.requestId,
    { primary_failure: failure, fallback_failure: safeFailure(error) }); }
  if (!scan.found) throw new SafeError('INSTANCE_NOT_FOUND', '已扫描全部 Pro 分页，未找到此实例；这不代表普通实例已删除。', undefined,
    { primary_failure: failure, list_requests: scan.requests });
  if (typeof scan.found.status !== 'string' || !scan.found.status)
    throw new SafeError('RESPONSE_SCHEMA', '匹配实例缺少状态，不能确认开关机。');
  return { data: scan.found.status, source: 'paginated_list', instance_uuid: input.instance_uuid,
    observed_at: scan.observed_at, request_id: scan.requests.at(-1).request_id,
    list_requests: scan.requests, primary_failure: failure, status_at: scan.found.status_at };
}

export function connectionInfo(snapshot) {
  const host = snapshot?.proxy_host, port = Number(snapshot?.ssh_port);
  // Only parse a simple SSH command, never execute returned commands.
  const match = /^ssh\s+-p\s+(\d+)\s+([A-Za-z0-9_-]+)@([A-Za-z0-9.-]+)\s*$/.exec(snapshot?.ssh_command ?? '');
  const username = match && match[3] === host && Number(match[1]) === port ? match[2] : null;
  const valid = typeof host === 'string' && /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host) &&
    Number.isInteger(port) && port >= 1 && port <= 65535 && Boolean(username);
  return { available: valid, host: valid ? host : null, port: valid ? port : null, username,
    authentication: { password: Object.hasOwn(snapshot ?? {}, 'root_password') ? 'provided_redacted' : 'unknown',
      local_key: 'not_checked', login: 'not_verified' },
    ...(valid ? { ssh_command: `ssh -p ${port} ${username}@${host}` } : { reason: '详情缺少可验证的连接字段；使用已有授权 SSH 别名，不猜测地址或用户名。' }) };
}

export async function instanceInfo(client, input) {
  try {
    const result = await client.call('snapshot', input);
    if (!result.data || typeof result.data !== 'object' || Array.isArray(result.data))
      throw new SafeError('RESPONSE_SCHEMA', '详情响应不是对象。', result.request_id);
    return { ...result, source: 'snapshot_api', connection: connectionInfo(result.data), observed_at: new Date().toISOString() };
  } catch (error) {
    if (!fallbackCodes.has(error.code)) throw error;
    let scan;
    try { scan = await scanInstances(client, input.instance_uuid); }
    catch (fallbackError) { throw new SafeError(fallbackError.code ?? 'INTERNAL', '详情接口和列表回退均未取得可靠信息。', fallbackError.requestId,
      { primary_failure: safeFailure(error), fallback_failure: safeFailure(fallbackError) }); }
    if (!scan.found) throw error;
    return { data: scan.found, source: 'paginated_list', partial: true, primary_failure: safeFailure(error),
      request_id: scan.requests.at(-1).request_id, observed_at: scan.observed_at, list_requests: scan.requests,
      connection: { available: false, reason: '列表未提供 SSH 连接信息，不能从状态推导地址或认证。' } };
  }
}

export async function reconcileMutation(client, endpoint, body, before) {
  try {
    if (endpoint === 'powerOn' || endpoint === 'powerOff') {
      const status = await instanceStatus(client, { instance_uuid: body.instance_uuid });
      return { observed: status, desired_state_observed: status.data === (endpoint === 'powerOff' ? 'shutdown' : 'running') };
    }
    if (endpoint === 'create') {
      const scan = await scanInstances(client);
      const old = new Set(before.entries.map(item => item.uuid ?? item.instance_uuid));
      const candidates = scan.entries.filter(item => !old.has(item.uuid ?? item.instance_uuid)).map(item => ({
        instance_uuid: item.uuid ?? item.instance_uuid, name: item.name, status: item.status }));
      return { observed_at: scan.observed_at, list_requests: scan.requests, candidates,
        correlation: 'candidate_only_not_proof', before_list_requests: before.requests };
    }
    // Image saving can be asynchronous; a name is not a unique correlation ID.
    const response = await client.call('images', { page_index: 1, page_size: 100 });
    return { request_id: response.request_id, matching_images_on_page_1: response.data?.list?.filter(item => item.name === body.image_name),
      complete: response.data?.max_page <= 1, correlation: 'name_only_not_proof' };
  } catch (error) { return { verification_failure: safeFailure(error) }; }
}
