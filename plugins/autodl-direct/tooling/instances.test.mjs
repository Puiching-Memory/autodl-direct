import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoDLClient, SafeError, createTools, instanceStatus, instanceInfo, scanInstances, connectionInfo } from '../dist/server.mjs';
import { diagnose } from '../scripts/diagnose-instance.mjs';
const token = 'TEST-ONLY-NOT-A-REAL-CREDENTIAL';
const client = transport => new AutoDLClient({ tokenProvider: async () => token, transport });
const success = data => ({ code: 'Success', data, request_id: 'fixture-list-request' });
const call = async (name, input, selected) => {
  const tool = createTools(selected, {}).find(x => x.name === name);
  return tool.run(tool.schema.parse(input));
};

test('production status and snapshot use GET query; diagnostic modes remain read-only', async () => {
  const specs = [];
  const selected = client(async spec => { specs.push(spec); return success(spec.path.endsWith('/list') ?
    { list: [{ uuid: 'pro-fixture', status: 'shutdown' }], max_page: 1, result_total: 1 } : spec.path.endsWith('/status') ? 'shutdown' : { proxy_host: 'connect.fixture.autodl.com' }); });
  await selected.call('status', { instance_uuid: 'pro-fixture' });
  await selected.call('snapshot', { instance_uuid: 'pro-fixture' });
  assert.deepEqual(specs.map(x => [x.method, x.parameterMode]), [['GET', 'query'], ['GET', 'query']]);
  const report = await diagnose(['pro-fixture'], selected);
  assert.equal(report.attempts.length, 6);
  assert.ok(!JSON.stringify(report).includes('connect.fixture.autodl.com'));
  assert.ok(specs.every(x => !/create|power_|image\/save/.test(x.path)));
  await assert.rejects(() => diagnose(['pro-fixture', '--execute'], selected), error => error.code === 'USAGE');
});

test('status fallback searches later pages using uuid and retains original diagnosis', async () => {
  const specs = [];
  const selected = client(async spec => {
    specs.push(spec);
    if (spec.path.endsWith('/status')) return { code: 'RequestParameterIsWrong', msg: token, request_id: 'body-request' };
    return success({ list: spec.body.page_index === 2 ? [{ uuid: 'pro-fixture', status: 'shutdown' }] : [{ uuid: 'pro-other', status: 'running' }], max_page: 2 });
  });
  const result = await instanceStatus(selected, { instance_uuid: 'pro-fixture' });
  assert.equal(result.data, 'shutdown'); assert.equal(result.source, 'paginated_list');
  assert.equal(result.primary_failure.request_id, 'body-request');
  assert.deepEqual(result.list_requests.map(x => x.page_index), [1, 2]);
  assert.ok(!JSON.stringify(result).includes(token));
});

test('pagination never equates incomplete or malformed results with absence', async () => {
  await assert.rejects(() => scanInstances(client(async () => success({ list: [], max_page: 3 })), 'pro-fixture', { maxPages: 2 }), error => error.code === 'PAGINATION_LIMIT');
  await assert.rejects(() => scanInstances(client(async () => success({ list: [] })), 'pro-fixture'), error => error.code === 'RESPONSE_SCHEMA');
  const absent = await scanInstances(client(async () => success({ list: [], max_page: 0 })), 'pro-fixture');
  assert.equal(absent.complete, true); assert.equal(absent.found, undefined);
});

test('authentication errors are not hidden by fallback', async () => {
  let calls = 0;
  await assert.rejects(() => instanceStatus(client(async () => { calls++; return { code: 'Unauthorized', msg: 'Denied' }; }), { instance_uuid: 'pro-fixture' }), error => error.code === 'Unauthorized');
  assert.equal(calls, 1);
});

test('safe connection reports host, port, user but never claims login or local key validation', async () => {
  const selected = client(async () => success({ proxy_host: 'connect.fixture.autodl.com', ssh_port: 12345,
    ssh_command: 'ssh -p 12345 root@connect.fixture.autodl.com', root_password: 'fixture-password', jupyter_token: 'fixture-jupyter' }));
  const result = await instanceInfo(selected, { instance_uuid: 'pro-fixture' });
  assert.equal(result.connection.available, true); assert.equal(result.connection.username, 'root');
  assert.equal(result.connection.authentication.login, 'not_verified');
  assert.ok(!JSON.stringify(result).includes('fixture-password'));
  assert.equal(connectionInfo({ proxy_host: '-oProxyCommand=evil', ssh_port: 12345 }).available, false);
  assert.equal(connectionInfo({ proxy_host: 'host', ssh_port: 12345, ssh_command: 'ssh -p 12345 root@host; evil' }).available, false);
});

test('snapshot fallback explicitly lacks SSH details', async () => {
  const result = await instanceInfo(client(async spec => spec.path.endsWith('/snapshot') ?
    { code: 'RequestParameterIsWrong', msg: 'wrong', request_id: 'snapshot-error' } : success({ list: [{ uuid: 'pro-fixture', status: 'shutdown' }], max_page: 1 })), { instance_uuid: 'pro-fixture' });
  assert.equal(result.partial, true); assert.equal(result.connection.available, false);
});

test('power mutation timeout triggers read-only verification and no second mutation', async () => {
  const specs = [];
  const selected = client(async spec => {
    specs.push(spec);
    if (spec.path.endsWith('/power_off')) throw new SafeError('TIMEOUT', 'timeout');
    return success('shutdown');
  });
  const result = await call('autodl_power_off', { instance_uuid: 'pro-fixture', execute: true }, selected);
  assert.equal(result.outcome, 'unknown'); assert.equal(result.retry_allowed, false);
  assert.equal(result.verification.desired_state_observed, true);
  assert.equal(specs.filter(x => x.path.endsWith('/power_off')).length, 1);
  assert.equal(result.failure.diagnostics.endpoint, 'powerOff');
});

test('creation timeout uses preflight IDs and reports candidates without proving creation', async () => {
  let listCount = 0, mutations = 0;
  const selected = client(async spec => {
    if (spec.path.endsWith('/create')) { mutations++; throw new SafeError('NETWORK', 'unknown'); }
    listCount++;
    return success({ list: listCount === 1 ? [{ uuid: 'pro-old' }] : [{ uuid: 'pro-old' }, { uuid: 'pro-new', status: 'running' }], max_page: 1 });
  });
  const result = await call('autodl_create_instance', { req_gpu_amount: 1, gpu_spec_uuid: 'fixture', image_uuid: 'fixture', cuda_v_from: 118, execute: true }, selected);
  assert.equal(mutations, 1); assert.equal(result.accepted, null);
  assert.deepEqual(result.verification.candidates.map(x => x.instance_uuid), ['pro-new']);
  assert.equal(result.verification.correlation, 'candidate_only_not_proof');
});

test('failed creation preflight does not send a rental request', async () => {
  let mutations = 0;
  const selected = client(async spec => { if (spec.path.endsWith('/create')) mutations++; throw new SafeError('NETWORK', 'unavailable'); });
  await assert.rejects(() => call('autodl_create_instance', { req_gpu_amount: 1, gpu_spec_uuid: 'fixture', image_uuid: 'fixture', cuda_v_from: 118, execute: true }, selected));
  assert.equal(mutations, 0);
});
