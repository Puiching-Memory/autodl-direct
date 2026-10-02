import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { AutoDLClient, createTools, requestJson, redact, SafeError } from '../dist/server.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const plugin = path.resolve(directory, '..');
const dummyToken = 'TEST-ONLY-AUTODL-CREDENTIAL-NEVER-VALID';
const testEnv = { ...process.env, AUTODL_TOKEN: '', AUTODL_CREDENTIAL_FILE: path.join(directory, 'absent-credential.dpapi') };
const parseResult = result => result.structuredContent ?? JSON.parse(result.content[0].text);
const calls = [];
const client = new AutoDLClient({ tokenProvider: async () => dummyToken, transport: async request => {
  calls.push(request); return { code: 'Success', data: 'accepted', request_id: 'fixture-request' };
} });
const find = (name, selected = client) => createTools(selected, testEnv).find(tool => tool.name === name);
const invoke = (name, input, selected) => {
  const tool = find(name, selected); return tool.run(tool.schema.parse(input));
};

test('all four mutation previews require no credentials or API requests', async () => {
  const never = new AutoDLClient({ tokenProvider: async () => { throw new Error('credential lookup forbidden'); },
    transport: async () => { throw new Error('network forbidden'); } });
  for (const [name, args] of [
    ['autodl_create_instance', { req_gpu_amount: 1, gpu_spec_uuid: 'pro6000-p', image_uuid: 'image-fixture', cuda_v_from: 118 }],
    ['autodl_power_on', { instance_uuid: 'pro-fixture' }],
    ['autodl_power_off', { instance_uuid: 'pro-fixture' }],
    ['autodl_save_image', { instance_uuid: 'pro-fixture', image_name: 'fixture' }]
  ]) {
    const result = await invoke(name, args, never);
    assert.equal(result.executed, false);
    assert.ok(result.preview.url.startsWith('https://api.autodl.com/api/v1/dev/'));
    assert.equal(result.preview.body.execute, undefined);
  }
});

test('explicit execution sends exactly one documented operation and reports acceptance', async () => {
  const before = calls.length;
  const result = await invoke('autodl_power_on', { instance_uuid: 'pro-fixture', execute: true });
  assert.equal(calls.length, before + 1);
  assert.equal(calls.at(-1).path, '/api/v1/dev/instance/pro/power_on');
  assert.deepEqual(calls.at(-1).body, { instance_uuid: 'pro-fixture', payload: 'gpu' });
  assert.equal(result.accepted, true);
  assert.equal(result.completed, undefined);
});

test('input validation rejects non-Pro IDs, excessive GPU counts, unexpected fields and coercion', () => {
  assert.throws(() => find('autodl_power_off').schema.parse({ instance_uuid: 'standard-123', execute: true }));
  assert.throws(() => find('autodl_power_off').schema.parse({ instance_uuid: 'pro-fixture', execute: 'true' }));
  assert.throws(() => find('autodl_power_off').schema.parse({ instance_uuid: 'pro-fixture', host: 'other.example' }));
  assert.throws(() => find('autodl_create_instance').schema.parse({ req_gpu_amount: 5, gpu_spec_uuid: 'pro6000-p', image_uuid: 'image-fixture', cuda_v_from: 118 }));
});

test('balance units are converted according to the official API contract', async () => {
  const selected = new AutoDLClient({ tokenProvider: async () => dummyToken, transport: async () => ({
    code: 'Success', data: { assets: 12345, accumulate: 6789, voucher_balance: 500 }, request_id: 'balance-fixture'
  }) });
  assert.deepEqual(await invoke('autodl_balance', {}, selected), {
    balance_yuan: 12.345, accumulated_yuan: 6.789, voucher_yuan: 0.5, request_id: 'balance-fixture'
  });
});

test('nested credentials and their appearances in other fields are redacted', () => {
  const original = { root_password: 'fixture-password', nested: { jupyter_token: 'fixture-jupyter' },
    msg: 'fixture-password fixture-jupyter ' + dummyToken, url: 'https://panel.example/?token=fixture-query' };
  const safe = redact(original, [dummyToken]);
  for (const secret of ['fixture-password', 'fixture-jupyter', dummyToken, 'fixture-query']) {
    assert.ok(!JSON.stringify(safe).includes(secret));
  }
  assert.equal(original.root_password, 'fixture-password');
});

test('successful snapshots and API error messages do not reveal credentials', async () => {
  const selected = new AutoDLClient({ tokenProvider: async () => dummyToken, transport: async () => ({
    code: 'Success', data: { root_password: 'fixture-password', jupyter_token: 'fixture-jupyter', proxy_host: 'connect.example.autodl.com', msg: dummyToken }
  }) });
  const safe = await selected.call('snapshot', { instance_uuid: 'pro-fixture' });
  assert.equal(safe.data.root_password, '[REDACTED]');
  assert.ok(!JSON.stringify(safe).includes(dummyToken));
  const failing = new AutoDLClient({ tokenProvider: async () => dummyToken, transport: async () => ({
    code: 'Denied', msg: 'reflected: ' + dummyToken, request_id: 'fixture-request'
  }) });
  await assert.rejects(() => failing.call('list', {}), error => error.code === 'Denied' && error.requestId === 'fixture-request' && !error.message.includes(dummyToken));
});

function mockRequest(statusCode, response, captured) {
  return (url, options, callback) => {
    captured.url = url.href; captured.options = options;
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = error => req.emit('error', error);
    req.end = body => {
      captured.body = body;
      queueMicrotask(() => {
        const res = new EventEmitter(); res.statusCode = statusCode;
        callback(res); res.emit('data', Buffer.from(JSON.stringify(response))); res.emit('end');
      });
    };
    return req;
  };
}

test('GET JSON body and raw Authorization are preserved without Bearer conversion', async () => {
  const captured = {};
  const result = await requestJson({ path: '/api/v1/dev/instance/pro/status', method: 'GET', token: dummyToken,
    body: { instance_uuid: 'pro-fixture' } }, mockRequest(200, { code: 'Success', data: 'running' }, captured));
  assert.equal(captured.url, 'https://api.autodl.com/api/v1/dev/instance/pro/status');
  assert.equal(captured.options.method, 'GET');
  assert.equal(captured.options.headers.Authorization, dummyToken);
  assert.deepEqual(JSON.parse(captured.body), { instance_uuid: 'pro-fixture' });
  assert.equal(result.data, 'running');
});

test('redirects are rejected and mutation network errors are not retried', async () => {
  await assert.rejects(() => requestJson({ path: '/api/v1/dev/wallet/balance', method: 'POST', token: dummyToken },
    mockRequest(302, { next: 'https://other.example/' }, {})), error => error.code === 'REDIRECT_BLOCKED');
  let attempts = 0;
  const selected = new AutoDLClient({ tokenProvider: async () => dummyToken, transport: async () => {
    attempts++; throw new Error('raw private error ' + dummyToken);
  } });
  await assert.rejects(() => selected.call('create', {}), error => error.code === 'NETWORK' && !error.message.includes(dummyToken));
  assert.equal(attempts, 1);
});

test('transport blocks unknown origins, paths and methods before credential transmission', async () => {
  let calls = 0;
  const never = () => { calls++; throw new Error('unexpected network request'); };
  for (const [method, apiPath] of [
    ['POST', 'https://other.example/api/v1/dev/wallet/balance'],
    ['POST', '//other.example/api/v1/dev/wallet/balance'],
    ['POST', '/api/v1/dev/instance/pro/release'],
    ['GET', '/api/v1/dev/wallet/balance']
  ]) {
    await assert.rejects(() => requestJson({ method, path: apiPath, token: dummyToken }, never),
      error => error.code === 'ENDPOINT');
  }
  assert.equal(calls, 0);
});

test('MCP official client discovers ten tools and performs harmless calls against built runtime', { timeout: 20000 }, async () => {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(plugin, 'dist/server.mjs')], env: testEnv, stderr: 'pipe' });
  const protocol = new Client({ name: 'autodl-direct-verifier', version: '1.0.0' });
  let diagnostics = '';
  transport.stderr?.on('data', chunk => { diagnostics += chunk.toString(); });
  try {
    await protocol.connect(transport);
    const { tools } = await protocol.listTools();
    assert.equal(tools.length, 10);
    assert.ok(tools.find(x => x.name === 'autodl_balance').annotations.readOnlyHint);
    assert.equal(tools.find(x => x.name === 'autodl_balance').annotations.openWorldHint, true);
    assert.equal(tools.find(x => x.name === 'autodl_setup_status').annotations.openWorldHint, false);
    const setup = parseResult(await protocol.callTool({ name: 'autodl_setup_status', arguments: {} }));
    assert.equal(setup.credentialsConfigured, false);
    const preview = parseResult(await protocol.callTool({ name: 'autodl_power_off', arguments: { instance_uuid: 'pro-fixture' } }));
    assert.equal(preview.executed, false);
    const missing = await protocol.callTool({ name: 'autodl_balance', arguments: {} });
    assert.equal(missing.isError, true);
    assert.equal(parseResult(missing).code, 'CREDENTIALS_MISSING');
    const invalid = await protocol.callTool({ name: 'autodl_power_off', arguments: { instance_uuid: 'standard-invalid', execute: true } });
    assert.equal(invalid.isError, true);
  } finally { await protocol.close(); }
  assert.equal(diagnostics, '');
});

test('portable and compatibility manifests resolve contained assets and actual runtime', async () => {
  const manifest = JSON.parse(await readFile(path.join(plugin, 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'autodl-direct');
  assert.ok(manifest.extensions['com.openai'].interface.shortDescription.length <= 30);
  const overlay = JSON.parse(await readFile(path.join(plugin, '.codex-plugin/plugin.json'), 'utf8'));
  assert.equal(overlay.version, manifest.version);
  for (const field of ['composerIcon', 'composerIconDark', 'logo', 'logoDark']) {
    const rel = manifest.extensions['com.openai'].interface[field];
    assert.ok(rel.startsWith('./assets/'));
    const svg = await readFile(path.join(plugin, rel), 'utf8');
    assert.ok(svg.includes('width="512" height="512"'));
  }
  const mcp = JSON.parse(await readFile(path.join(plugin, 'mcp.json'), 'utf8'));
  const runtime = mcp.mcpServers['autodl-direct'];
  assert.equal(runtime.type, 'stdio');
  assert.ok((await readFile(path.join(plugin, runtime.args[0].replace('${PLUGIN_ROOT}/', '')))).length > 0);
});
