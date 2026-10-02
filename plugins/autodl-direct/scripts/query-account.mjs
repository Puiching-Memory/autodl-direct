import { pathToFileURL } from 'node:url';
import { createTools, errorResult, SafeError } from '../dist/server.mjs';

const usage = '用法：node scripts/query-account.mjs [status|balance|instances|account] [page_index] [page_size]。仅 instances/account 接受分页参数；此入口只支持查询。';

export async function runQuery(args = [], { client, env = process.env } = {}) {
  const [command = 'account', pageIndex = '1', pageSize = '100'] = args;
  const paged = command === 'instances' || command === 'account';
  if (!['status', 'balance', 'instances', 'account'].includes(command) ||
      args.length > (paged ? 3 : 1) ||
      (paged && (![pageIndex, pageSize].every(value => /^[1-9][0-9]*$/.test(value)) ||
        !Number.isSafeInteger(Number(pageIndex)) || !Number.isSafeInteger(Number(pageSize)) || Number(pageSize) > 100))) {
    throw new SafeError('USAGE', usage);
  }
  const tools = createTools(client, env);
  const call = (name, input = {}) => {
    const tool = tools.find(item => item.name === name);
    return tool.run(tool.schema.parse(input));
  };
  if (command === 'status') return call('autodl_setup_status');
  if (command === 'balance') return call('autodl_balance');
  const pagination = { page_index: Number(pageIndex), page_size: Number(pageSize) };
  if (command === 'instances') return call('autodl_list_instances', pagination);
  const [balance, proInstances] = await Promise.all([
    call('autodl_balance'), call('autodl_list_instances', pagination)
  ]);
  return { readOnly: true, instanceProduct: 'Pro', page_index: pagination.page_index,
    page_size: pagination.page_size, balance, pro_instances: proInstances };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await runQuery(process.argv.slice(2)))); }
  catch (error) {
    console.log(JSON.stringify({ isError: true, ...JSON.parse(errorResult(error).content[0].text) }));
    process.exitCode = 1;
  }
}
