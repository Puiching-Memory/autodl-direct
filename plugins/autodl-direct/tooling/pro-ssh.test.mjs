import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, lstat, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ProCatalogClient, requestProCatalog, SshManager, sshBootstrap, validatePublicKey, createTools } from '../dist/server.mjs';
import { runProQuery } from '../scripts/query-pro-catalog.mjs';
const response = data => ({code:'Success',data,request_id:'fixture-id'});
const types = () => response([{gpu_type:'vGPU-48GB',gpu_idle_num:1,gpu_total_number:330}]);
const specs = () => response([{id:5,uuid:'v-48g',name:'4090-48G',gpu_name:'vGPU-48GB',gpu_spec_name:'通用型',
  cpu_num_from:12,cpu_num_to:22,memory_size_from:64*2**30,memory_size_to:100*2**30,
  gpu_spec_config_sku_info:[{type:'payg',current_price:3030,level_config:[{level_name:'normal_user',discounted_price:3030},{level_name:'member_user',discounted_price:2880}]}]}]);
const client = () => new ProCatalogClient({transport:async kind => kind==='types'?types():specs()});
const publicKey = 'ssh-ed25519 '+Buffer.concat([Buffer.from([0,0,0,11]),Buffer.from('ssh-ed25519'),Buffer.from([0,0,0,32]),Buffer.alloc(32,7)]).toString('base64');
function mock(status, body, inspect = () => {}, mode) {
  return (url,options,callback) => {
    const req = new EventEmitter(); req.destroy=()=>{};req.setTimeout=(_ms,f)=>{req.timeout=f;};
    req.end=payload=>queueMicrotask(()=>{
      inspect(url,options,JSON.parse(payload));
      if (mode==='timeout') return req.timeout();
      if (mode==='network') return req.emit('error',new Error('SECRET-TRANSPORT'));
      const res = new EventEmitter();res.statusCode=status;callback(res);
      if (mode==='abort') return res.emit('aborted');
      res.emit('data',Buffer.isBuffer(body)?body:Buffer.from(typeof body==='string'?body:JSON.stringify(body)));res.emit('end');
    }); return req;
  };
}
test('fixed console endpoints send exact read-only JSON without account credentials',async()=>{
  for (const [kind,body,suffix] of [['types',{data_center_list:['westDC3']},'gpu_type'],['specs',{gpu_name:'vGPU-48GB',charge_type:'payg'},'gpu_spec_config']]) {
    await requestProCatalog(kind,body,mock(200,types(),(url,options,payload)=>{
      assert.equal(url.origin,'https://www.autodl.com');assert.equal(url.pathname,`/api/v1/machine_pro/${suffix}`);
      assert.equal(options.method,'POST');assert.deepEqual(payload,body);
      assert.deepEqual(Object.keys(options.headers).sort(),['Accept','Content-Length','Content-Type']);
    }));
  }
});
test('catalog resolves API spec IDs, memory and thousandths of yuan without claiming final quote',async()=>{
  const result=await client().list({gpu_name:'vGPU-48GB'});
  assert.equal(result.specs[0].gpu_spec_uuid,'v-48g');assert.equal(result.specs[0].list_yuan_per_gpu_hour,3.03);
  assert.equal(result.specs[0].published_level_prices[1].yuan_per_gpu_hour,2.88);
  assert.deepEqual(result.specs[0].host_memory_gib_range,[64,100]);assert.equal(result.specs[0].gpu_vram_gib,undefined);
  assert.equal(result.account_final_quote,'unavailable_without_web_session');
  const tool=createTools({call(){throw Error('account access forbidden');}}, {}, undefined, client()).find(x=>x.name==='autodl_pro_catalog');
  assert.equal((await tool.run(tool.schema.parse({}))).gpu_types.length,1);
  assert.throws(()=>tool.schema.parse({token:'x'}));
});
test('invalid catalog inputs fail before transport; no endpoint override or token fallback',async()=>{
  let calls=0;const catalog=new ProCatalogClient({transport:()=>{calls++;throw Error('unexpected');}});
  for(const input of [{token:'x'},[],null,{gpu_name:''},{gpu_name:'x\ny'},{data_center_list:[]},{data_center_list:['x','x']},{data_center_list:['../x']}])
    await assert.rejects(()=>catalog.list(input),x=>x.code==='INPUT');
  await assert.rejects(()=>requestProCatalog('create',{},()=>{calls++;}),x=>x.code==='INPUT');
  await assert.rejects(()=>requestProCatalog('specs',{gpu_name:'x',charge_type:'payg',token:'x'},()=>{calls++;}),x=>x.code==='INPUT');
  await assert.rejects(()=>requestProCatalog('specs',{gpu_name:undefined,charge_type:'payg'},()=>{calls++;}),x=>x.code==='INPUT');
  assert.equal(calls,0);
});
test('login failures, missing price, zero price and schema drift never become empty/zero-cost success',async()=>{
  for(const mutate of [r=>r.data=null,r=>r.data[0].gpu_spec_config_sku_info[0].current_price=0,r=>r.data[0].gpu_spec_config_sku_info[0].current_price='3030',r=>r.data[0].uuid='bad/uuid',r=>r.data[0].memory_size_from=-1]) {
    const s=specs();mutate(s);
    await assert.rejects(()=>new ProCatalogClient({transport:async kind=>kind==='types'?types():s}).list({gpu_name:'vGPU-48GB'}),x=>x.code==='RESPONSE_SCHEMA');
  }
  await assert.rejects(()=>new ProCatalogClient({transport:async()=>({code:'AuthorizeFailed',data:null})}).list(),x=>x.code==='PRO_CATALOG_API');
  await assert.rejects(()=>client().list({gpu_name:'invented-GPU'}),x=>x.code==='GPU_NOT_LISTED');
});
test('catalog HTTP faults are bounded, nonredirecting, single attempt and sanitized',async()=>{
  for(const [status,body,mode,code] of [[302,{},null,'REDIRECT_BLOCKED'],[401,{},null,'HTTP_ERROR'],[200,'<html>login',null,'INVALID_RESPONSE'],[200,Buffer.alloc(2*1024*1024+1),null,'RESPONSE_TOO_LARGE'],[200,{},'timeout','TIMEOUT'],[200,{},'network','NETWORK'],[200,{},'abort','NETWORK']]) {
    let calls=0;
    await assert.rejects(()=>requestProCatalog('types',{data_center_list:['westDC3']},mock(status,body,()=>calls++,mode)),x=>x.code===code&&!x.message.includes('SECRET'));
    assert.equal(calls,1);
  }
});
test('catalog CLI rejects credential flags and duplicates',async()=>{
  let value,calls=0;const fake={list:async q=>{calls++;value=q;return{};}};
  await runProQuery(['--gpu-name','vGPU-48GB','--regions','westDC3,beijingDC2'],fake);
  assert.deepEqual(value,{gpu_name:'vGPU-48GB',data_center_list:['westDC3','beijingDC2']});
  for(const args of [['--token','x'],['--cookie','x'],['--gpu-name'],['--regions','a','--regions','b']]) await assert.rejects(()=>runProQuery(args,fake));
  assert.equal(calls,1);
});
test('public-key bootstrap preserves workload and rejects private keys, shell injection and oversized commands',async()=>{
  assert.equal(validatePublicKey(publicKey),publicKey);
  for(const key of ['-----BEGIN OPENSSH PRIVATE KEY-----',publicKey+'\nwhoami',publicKey+"';id;#",'ssh-ed25519 AAAA','ssh-rsa AAAA']) assert.throws(()=>sshBootstrap(key),x=>x.code==='INPUT');
  const command=sshBootstrap(publicKey,'printf hello');
  assert.ok(command.includes("printf '\\n%s\\n'"));assert.ok(command.endsWith('(\nprintf hello\n)'));
  assert.equal(sshBootstrap(undefined,'echo old'),'echo old');assert.throws(()=>sshBootstrap(publicKey,'x'.repeat(16300)),x=>x.code==='INPUT');
  const tool=createTools({call(){throw Error('not allowed');}}).find(x=>x.name==='autodl_create_instance');
  const preview=await tool.run(tool.schema.parse({req_gpu_amount:1,gpu_spec_uuid:'v-48g',image_uuid:'fixture',cuda_v_from:130,ssh_public_key:publicKey,start_command:'echo ready'}));
  assert.equal(preview.executed,false);assert.equal(preview.preview.body.ssh_public_key,undefined);assert.ok(preview.preview.body.start_command.includes(publicKey));
  const power=createTools({call(){throw Error('not allowed');}}).find(x=>x.name==='autodl_power_on');
  const powerPreview=await power.run(power.schema.parse({instance_uuid:'pro-fixture',ssh_public_key:publicKey}));
  assert.equal(powerPreview.preview.body.payload,'gpu');assert.ok(powerPreview.preview.body.start_command.includes(publicKey));
});
test('POSIX public-key installer appends safely to a file without a newline and is repeatable',{timeout:20000},async()=>{
  const temp=await mkdtemp(path.join(tmpdir(),'autodl-ssh-test-'));
  try {
    await mkdir(path.join(temp,'.ssh'));
    await writeFile(path.join(temp,'.ssh','authorized_keys'),'existing-authorized-key');
    let command=sshBootstrap(publicKey,'printf done > workload-result').replaceAll('/root/.ssh','.ssh');
    // Git Bash on NTFS cannot establish Linux directory/file modes. Exercise
    // append/dedup/workload logic here, leaving remote permission checks explicit.
    if(process.platform==='win32') command=command.replace('install -d -m 700','mkdir -p').replace('chmod 600 .ssh/authorized_keys','true');
    const bash=process.platform==='win32'?path.join(process.env.ProgramFiles ?? 'C:/Program Files','Git/bin/bash.exe'):'bash';
    for(let i=0;i<2;i++) await promisify(execFile)(bash,['-c',command],{cwd:temp,windowsHide:true,timeout:10000});
    const keys=(await readFile(path.join(temp,'.ssh','authorized_keys'),'utf8')).trim().split('\n');
    assert.deepEqual(keys,['existing-authorized-key',publicKey]);assert.equal(await readFile(path.join(temp,'workload-result'),'utf8'),'done');
  } finally { assert.equal(path.dirname(temp),tmpdir());assert.ok(path.basename(temp).startsWith('autodl-ssh-test-'));await rm(temp,{recursive:true,force:true}); }
});
test('native SSH key generation reuses exact key, writes dedicated config and leaves private bytes out of results',{timeout:30000},async()=>{
  const temp=await mkdtemp(path.join(tmpdir(),'autodl-ssh-test-'));const root=path.join(temp,'keys');
  try {
    const manager=new SshManager({root});
    const preview=await manager.key('fixture');assert.equal(preview.executed,false);
    await assert.rejects(()=>lstat(root),x=>x.code==='ENOENT');
    const first=await manager.key('fixture',true);assert.equal(first.created,true);assert.ok(first.fingerprint.startsWith('SHA256:'));
    const second=await manager.key('fixture',true);assert.equal(second.created,false);assert.equal(second.ssh_public_key,first.ssh_public_key);
    assert.ok(!JSON.stringify(second).includes('BEGIN OPENSSH PRIVATE KEY'));
    const connection={available:true,host:'connect.example.autodl.com',port:12345,username:'root'};
    const before=await manager.connection('pro-fixture','fixture',connection);assert.equal(before.executed,false);
    const config=await manager.connection('pro-fixture','fixture',connection,true);
    assert.ok((await readFile(config.config_path,'utf8')).includes('StrictHostKeyChecking ask'));
    // Parse with real OpenSSH; this is configuration validation, not network/login proof.
    const parsed=await promisify(execFile)('ssh',['-G','-F',config.config_path,'pro-fixture'],{windowsHide:true,timeout:10000});
    assert.match(parsed.stdout,/hostname connect\.example\.autodl\.com/);assert.match(parsed.stdout,/port 12345/);
    await manager.connection('pro-fixture','fixture',{...connection,port:23456},true);
    assert.match(await readFile(config.config_path,'utf8'),/Port 23456/);
    await writeFile(config.config_path,'# user-owned\n');
    await assert.rejects(()=>manager.connection('pro-fixture','fixture',connection,true),x=>x.code==='SSH_CONFIG_EXISTS');
    for(const name of ['../escape','CON','x/y','-option','a\nb']) await assert.rejects(()=>manager.key(name,true),x=>x.code==='INPUT');
    await assert.rejects(()=>manager.connection('pro-fixture','fixture',{...connection,host:'host\nProxyCommand bad'},true),x=>x.code==='SSH_CONNECTION');
    await assert.rejects(()=>manager.connection('pro-fixture','fixture',{...connection,username:'ubuntu'},true),x=>x.code==='SSH_CONNECTION');
    await writeFile(path.join(root,'partial'),'existing');
    await assert.rejects(()=>manager.key('partial',true),x=>x.code==='SSH_KEY_INCOMPLETE');
    assert.equal(await readFile(path.join(root,'partial'),'utf8'),'existing');
  } finally { assert.equal(path.dirname(temp),tmpdir());assert.ok(path.basename(temp).startsWith('autodl-ssh-test-'));await rm(temp,{recursive:true,force:true}); }
});
test('SSH helper refuses writes through a directory junction/symlink',async()=>{
  const temp=await mkdtemp(path.join(tmpdir(),'autodl-ssh-test-'));
  try {
    const target=path.join(temp,'target');await mkdir(target);
    const link=path.join(temp,'linked');await symlink(target,link,process.platform==='win32'?'junction':'dir');
    await assert.rejects(()=>new SshManager({root:path.join(link,'keys')}).key('fixture',true),x=>x.code==='SSH_PATH');
  } finally { assert.equal(path.dirname(temp),tmpdir());assert.ok(path.basename(temp).startsWith('autodl-ssh-test-'));await rm(temp,{recursive:true,force:true}); }
});
