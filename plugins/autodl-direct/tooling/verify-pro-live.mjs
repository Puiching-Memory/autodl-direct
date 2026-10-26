// Explicit opt-in, read-only public network check; never run as an offline test.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)),'..'));
const output = process.argv[3];
const manifest = JSON.parse(await readFile(path.join(root,'.codex-plugin/plugin.json'),'utf8'));
const mcp = JSON.parse(await readFile(path.join(root,'.mcp.json'),'utf8')).mcpServers['autodl-direct'];
const env = {...process.env,AUTODL_TOKEN:'',AUTODL_CREDENTIAL_FILE:path.join(root,'absent-live-fixture.dpapi')};
const transport = new StdioClientTransport({command:process.execPath,args:mcp.args,cwd:path.resolve(root,mcp.cwd ?? '.'),env,stderr:'pipe'});
const client = new Client({name:'autodl-pro-public-verifier',version:'1.0.0'});
let stderr='';transport.stderr?.on('data',x=>stderr+=x);
const parse = result => { if(result.isError) throw Error(result.content[0].text);return result.structuredContent ?? JSON.parse(result.content[0].text); };
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  const setup = parse(await client.callTool({name:'autodl_setup_status',arguments:{}}));
  if(setup.credentialsConfigured) throw Error('Live public check must have no credentials.');
  const catalog = parse(await client.callTool({name:'autodl_pro_catalog',arguments:{gpu_name:'vGPU-48GB'}}));
  const key_preview = parse(await client.callTool({name:'autodl_prepare_ssh_key',arguments:{key_name:'public-verification-preview'}}));
  const evidence = {observed_at:new Date().toISOString(),plugin_version:manifest.version,server_version:client.getServerVersion(),tool_count:tools.length,
    credentialsConfigured:setup.credentialsConfigured,catalog,key_preview:{executed:key_preview.executed,action:key_preview.preview.action},stderr,
    paid_operations:0,remote_ssh_login:'not_tested',startup_installation:'not_tested_on_real_instance'};
  if(output) await writeFile(output,JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence));
} finally { await client.close(); }
