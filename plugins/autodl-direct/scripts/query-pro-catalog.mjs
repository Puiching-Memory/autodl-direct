import { pathToFileURL } from 'node:url';
import { ProCatalogClient, SafeError, errorResult } from '../dist/server.mjs';
export async function runProQuery(args = [], client = new ProCatalogClient()) {
  const input = {}; const seen = new Set();
  for (let i=0;i<args.length;i+=2) {
    const flag = args[i], value = args[i+1];
    if (!['--gpu-name','--regions'].includes(flag) || value === undefined || seen.has(flag))
      throw new SafeError('USAGE','用法：query-pro-catalog.mjs [--gpu-name 目录中的GPU名称] [--regions westDC3,beijingDC2]；不接受凭据。');
    seen.add(flag);
    if (flag === '--gpu-name') input.gpu_name = value;
    else input.data_center_list = value.split(',');
  }
  return client.list(input);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await runProQuery(process.argv.slice(2)))); }
  catch(error) { console.log(JSON.stringify({isError:true,...JSON.parse(errorResult(error).content[0].text)})); process.exitCode=1; }
}
