// Opt-in, read-only. Never invoked by CI or by the offline test suite.
import { pathToFileURL } from 'node:url';
import { AutoDLClient, createTools, SafeError, scanInstances } from '../dist/server.mjs';

export async function verifyLive(args, client = new AutoDLClient()) {
  if (args.length !== 1 || !/^pro-[A-Za-z0-9-]{1,80}$/.test(args[0])) throw new SafeError('USAGE', 'verify-live.mjs <pro-ID>；仅查询。');
  const instance_uuid = args[0];
  const tools = createTools(client);
  const invoke = name => {
    const tool = tools.find(item => item.name === name);
    return tool.run(tool.schema.parse(name === 'autodl_balance' ? {} : { instance_uuid }));
  };
  const balance = await invoke('autodl_balance');
  const scan = await scanInstances(client, instance_uuid);
  const status = await invoke('autodl_instance_status');
  const info = await invoke('autodl_instance_info');
  return { observed_at: new Date().toISOString(), instance_uuid, readOnly: true,
    balance: { valid_numbers: [balance.balance_yuan, balance.accumulated_yuan, balance.voucher_yuan].every(Number.isFinite), request_id: balance.request_id },
    list: { found: Boolean(scan.found), status: scan.found?.status, requests: scan.requests },
    status: { data: status.data, source: status.source, request_id: status.request_id, diagnostics: status.diagnostics },
    info: { source: info.source, request_id: info.request_id, diagnostics: info.diagnostics,
      connection_fields_valid: info.connection?.available === true,
      credentials_redacted: info.data?.root_password === '[REDACTED]' && info.data?.jupyter_token === '[REDACTED]',
      authentication: info.connection?.authentication },
    mutations_executed: 0, ssh_executed: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await verifyLive(process.argv.slice(2)), null, 2)); }
  catch (error) { console.log(JSON.stringify({ code: error instanceof SafeError ? error.code : 'INTERNAL', request_id: error.requestId })); process.exitCode = 1; }
}
