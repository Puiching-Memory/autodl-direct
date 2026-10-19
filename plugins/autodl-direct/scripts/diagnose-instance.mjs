// Read-only protocol comparison. Credentials stay inside the client.
import { pathToFileURL } from 'node:url';
import { AutoDLClient, SafeError } from '../src/api.mjs';

export async function diagnose(args, client = new AutoDLClient()) {
  if (args.length !== 1 || !/^pro-[A-Za-z0-9-]{1,80}$/.test(args[0]))
    throw new SafeError('USAGE', '用法：node scripts/diagnose-instance.mjs <pro-ID>；只读，不支持变更。');
  const instance_uuid = args[0];
  const attempts = [];
  for (const endpoint of ['status', 'snapshot']) {
    for (const parameterMode of ['body', 'query', 'body+query']) {
      try {
        const response = await client.call(endpoint, { instance_uuid }, { parameterMode });
        // Do not persist connection addresses, passwords or complete snapshots.
        attempts.push({ endpoint, parameter_mode: parameterMode, code: 'Success', request_id: response.request_id,
          ...(endpoint === 'status' ? { status: response.data } : { fields: Object.keys(response.data ?? {}).sort() }) });
      } catch (error) {
        attempts.push({ endpoint, parameter_mode: parameterMode, code: error instanceof SafeError ? error.code : 'INTERNAL',
          request_id: error.requestId, diagnostics: error.diagnostics });
      }
    }
  }
  const list = await client.call('list', { page_index: 1, page_size: 100 });
  const item = list.data?.list?.find(x => (x.uuid ?? x.instance_uuid) === instance_uuid);
  return { readOnly: true, observed_at: new Date().toISOString(), instance_uuid, attempts,
    list: { request_id: list.request_id, max_page: list.data?.max_page, result_total: list.data?.result_total,
      found_on_page_1: Boolean(item), status: item?.status } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await diagnose(process.argv.slice(2)), null, 2)); }
  catch (error) { console.log(JSON.stringify({ code: error instanceof SafeError ? error.code : 'INTERNAL', request_id: error.requestId })); process.exitCode = 1; }
}
