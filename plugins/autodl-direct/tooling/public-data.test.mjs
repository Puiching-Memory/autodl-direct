import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PublicDataClient, requestPublicData, createTools } from '../dist/server.mjs';
import { runPublicQuery } from '../scripts/query-public-data.mjs';

const row = id => ({ id, data_name: `video-${id}`, exist_path: `/root/autodl-pub/video-${id}`,
  size: 83857, publisher: 'dataset.example', description: '视频数据集', data_form: 'common_data' });
const page = (index = 1, size = 10, total = 39) => ({ code: 'Success', request_id: 'catalog-request', data: {
  page_index: index, page_size: size, result_total: total, max_page: Math.max(1, Math.ceil(total/size)),
  list: Array.from({ length: Math.min(size, Math.max(0,total-(index-1)*size)) }, (_,i) => row((index-1)*size+i+1))
} });
function mock(status, body, inspect = () => {}, mode) {
  return (url, options, callback) => {
    inspect(url, options);
    const req = new EventEmitter();
    req.setTimeout = (_ms, f) => { req.timeout = f; return req; };
    req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      if (mode === 'timeout') return req.timeout();
      if (mode === 'network') return req.emit('error', new Error('PRIVATE-NETWORK-DETAIL'));
      const res = new EventEmitter(); res.statusCode = status;
      callback(res);
      if (mode === 'abort') return res.emit('aborted');
      res.emit('data', Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
      res.emit('end');
    });
    return req;
  };
}

test('public request uses only the observed HTTPS GET endpoint and sends no credentials', async () => {
  let requests = 0;
  await requestPublicData({ keyword: '视频 & Vimeo=1', page_index: 2, page_size: 7 }, mock(200, page(2,7), (url,options) => {
    requests++;
    assert.equal(url.origin, 'https://www.autodl.com');
    assert.equal(url.pathname, '/api/v1/common_data/list');
    assert.equal(url.searchParams.get('key_word'), '视频 & Vimeo=1');
    assert.equal(url.searchParams.get('page_index'), '2');
    assert.equal(url.searchParams.get('page_size'), '7');
    assert.equal(options.method,'GET');
    assert.deepEqual(options.headers,{Accept:'application/json'});
    assert.equal(url.username,''); assert.equal(url.password,'');
  }));
  assert.equal(requests,1);
});

test('invalid public parameters cannot change destination, headers or credential handling', async () => {
  let calls = 0;
  const transport = () => { calls++; throw new Error('unexpected'); };
  for (const input of [{token:'x'}, {url:'https://other.example'}, {headers:{}}, {keyword:['Vimeo']},
    {keyword:'x'.repeat(201)}, {keyword:'a\nb'}, {page_index:0}, {page_index:1.5}, {page_index:10001},
    {page_size:101}, {page_size:'10'}, null, []]) {
    await assert.rejects(() => requestPublicData(input,transport), error => error.code==='INPUT');
  }
  assert.equal(calls,0);
});

test('public tool works with no credentials and never calls the account client', async () => {
  let privateCalls = 0;
  const account = { call: () => { privateCalls++; throw new Error('private call'); } };
  const catalog = new PublicDataClient({transport:async q => { assert.equal(q.keyword,'Vimeo'); return page(1,20,1); }});
  const env = new Proxy({}, {get(){throw new Error('credential environment read');}});
  const tool = createTools(account,env,catalog).find(x=>x.name==='autodl_list_public_data');
  const result = await tool.run(tool.schema.parse({keyword:' Vimeo '}));
  assert.equal(privateCalls,0); assert.equal(result.items.length,1);
  assert.equal(result.items[0].size_display,'81.89 GB');
  assert.equal(result.items[0].instance_access,'not_verified');
  assert.equal(tool.annotations.readOnlyHint,true);
  assert.equal(tool.annotations.idempotentHint,true);
  assert.equal(tool.annotations.openWorldHint,true);
  assert.throws(()=>tool.schema.parse({keyword:'Vimeo',token:'x'}));
});

test('pagination reports partial, final-page and complete-query coverage honestly', async () => {
  const client = new PublicDataClient({transport:async q=>page(q.page_index,q.page_size)});
  const first = await client.list({page_index:1,page_size:10});
  assert.equal(first.complete_query_result,false); assert.equal(first.pagination.next_page_index,2);
  assert.equal(first.pagination.result_total,39);
  const last = await client.list({page_index:4,page_size:10});
  assert.equal(last.items.length,9); assert.equal(last.pagination.next_page_index,null);
  assert.equal(last.complete_query_result,false);
  const all = await client.list({page_size:100});
  assert.equal(all.items.length,39); assert.equal(all.complete_query_result,true);
});

test('empty results are accepted only with a valid zero-total response', async () => {
  for(const list of [[],null]) {
    const response=page(1,20,0);response.data.list=list;
    const result=await new PublicDataClient({transport:async()=>response}).list();
    assert.deepEqual(result.items,[]);assert.equal(result.complete_query_result,true);
  }
});

test('an out-of-range empty page retains a nonzero total and never claims the full result', async () => {
  const response=page(5,10,39);response.data.list=null;
  const result=await new PublicDataClient({transport:async()=>response}).list({page_index:5,page_size:10});
  assert.deepEqual(result.items,[]);assert.equal(result.pagination.result_total,39);
  assert.equal(result.complete_query_result,false);
});

test('public CLI forwards only the three documented options', async () => {
  let input;
  await runPublicQuery(['--keyword','Vimeo','--page','2','--page-size','7'],{list:async q=>{input=q;return{};}});
  assert.deepEqual(input,{keyword:'Vimeo',page_index:2,page_size:7});
});

test('public CLI rejects credential options, repeated flags and malformed numbers before I/O', async () => {
  let calls=0;
  for(const args of [['--token','x'],['--cookie','x'],['--page'],['--page','1','--page','2'],
    ['--page','1.5'],['--page-size','0'],['--page','1e2']]) {
    await assert.rejects(()=>runPublicQuery(args,{list:async()=>{calls++;return{};}}));
  }
  assert.equal(calls,0);
});

test('schema drift and inconsistent totals fail instead of appearing as no matching dataset', async () => {
  const cases=[];
  for(const change of [{list:null},{list:[]},{result_total:'39'},{max_page:1},{page_index:2},{page_size:99}]) {
    const response=page();Object.assign(response.data,change);cases.push(response);
  }
  const missing=page();delete missing.data;cases.push(missing);
  const duplicate=page();duplicate.data.list[1]=duplicate.data.list[0];cases.push(duplicate);
  for(const response of cases) {
    await assert.rejects(()=>new PublicDataClient({transport:async()=>response}).list({page_size:10}), e=>e.code==='RESPONSE_SCHEMA');
  }
});

test('catalog record identity, path, size and text fields are checked', async () => {
  for(const change of [{id:0},{data_name:''},{exist_path:'../../etc'},{exist_path:'/root/../etc'},
    {exist_path:'/root/\nsecret'},{size:-1},{size:'83857'},{publisher:null},{description:[]},{data_form:null}]) {
    const response=page(1,20,1);Object.assign(response.data.list[0],change);
    await assert.rejects(()=>new PublicDataClient({transport:async()=>response}).list(),e=>e.code==='RESPONSE_SCHEMA');
  }
});

test('public API failure does not trigger credential or browser fallback', async () => {
  let calls=0;
  const client=new PublicDataClient({transport:async()=>{calls++;return{code:'Unauthorized',request_id:'public-failure'};}});
  await assert.rejects(()=>client.list(),e=>e.code==='PUBLIC_DATA_API'&&e.requestId==='public-failure');
  assert.equal(calls,1);
});

test('catalog output is whitelisted and unexpected secret fields are redacted', async () => {
  const response=page(1,20,1);
  response.data.list[0].token='TEST-SECRET';response.data.list[0].description='do not echo TEST-SECRET';
  const result=await new PublicDataClient({transport:async()=>response}).list();
  const encoded=JSON.stringify(result);
  assert.ok(!encoded.includes('TEST-SECRET'));assert.ok(!Object.hasOwn(result.items[0],'token'));
  assert.match(result.items[0].description,/REDACTED/);
});

test('redirects, HTTP errors and non-JSON pages fail explicitly without retries', async () => {
  for(const [status,body,code] of [[302,{},'REDIRECT_BLOCKED'],[403,{},'HTTP_ERROR'],[200,'<html>login</html>','INVALID_RESPONSE']]) {
    let calls=0;
    await assert.rejects(()=>requestPublicData({},mock(status,body,()=>calls++)),e=>e.code===code);
    assert.equal(calls,1);
  }
});

test('large responses, aborts, network failures and deadlines are bounded', async () => {
  for(const [body,mode,code] of [[Buffer.alloc(2*1024*1024+1),undefined,'RESPONSE_TOO_LARGE'],
    [{},'abort','NETWORK'],[{},'network','NETWORK'],[{},'timeout','TIMEOUT']]) {
    await assert.rejects(()=>requestPublicData({},mock(200,body,()=>{},mode)),e=>e.code===code);
  }
  await assert.rejects(()=>new PublicDataClient({transport:async()=>{throw new Error('PRIVATE-NETWORK-DETAIL');}}).list(),
    e=>e.code==='NETWORK'&&!e.message.includes('PRIVATE-NETWORK-DETAIL'));
});
