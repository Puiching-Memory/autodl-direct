import { pathToFileURL } from 'node:url';
import { PublicDataClient, errorResult, SafeError } from '../dist/server.mjs';

export async function runPublicQuery(args=[],client=new PublicDataClient()) {
  const input={};
  const options={'--keyword':'keyword','--page':'page_index','--page-size':'page_size'};
  for(let i=0;i<args.length;i+=2) {
    const field=options[args[i]],value=args[i+1];
    if(!field||value===undefined||Object.hasOwn(input,field))
      throw new SafeError('USAGE','用法：query-public-data.mjs [--keyword 名称] [--page 页码] [--page-size 每页数量]；不接受Token或Cookie。');
    if(field!=='keyword'&&!/^[1-9][0-9]*$/.test(value))
      throw new SafeError('INPUT','页码和每页数量必须为正整数。');
    input[field]=field==='keyword'?value:Number(value);
  }
  return client.list(input);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await runPublicQuery(process.argv.slice(2)))); }
  catch(error) { console.log(JSON.stringify({isError:true,...JSON.parse(errorResult(error).content[0].text)}));process.exitCode=1; }
}
