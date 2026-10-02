import https from 'node:https';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

export const API_ORIGIN = 'https://api.autodl.com';
export const ENDPOINTS = Object.freeze({
  balance: ['POST', '/api/v1/dev/wallet/balance'],
  list: ['POST', '/api/v1/dev/instance/pro/list'],
  status: ['GET', '/api/v1/dev/instance/pro/status'],
  snapshot: ['GET', '/api/v1/dev/instance/pro/snapshot'],
  images: ['POST', '/api/v1/dev/instance/pro/image/private/list'],
  create: ['POST', '/api/v1/dev/instance/pro/create'],
  powerOn: ['POST', '/api/v1/dev/instance/pro/power_on'],
  powerOff: ['POST', '/api/v1/dev/instance/pro/power_off'],
  saveImage: ['POST', '/api/v1/dev/instance/pro/image/save']
});

export class SafeError extends Error {
  constructor(code, message, requestId) {
    super(message);
    this.name = 'SafeError';
    this.code = code;
    this.requestId = requestId;
  }
}

const sensitiveKey = /^(authorization|password|root_password|jupyter_token|token|secret|cookie|private_key)$|_(password|token|secret)$/i;

export function redact(value, knownSecrets = []) {
  const secrets = new Set(knownSecrets.filter(x => typeof x === 'string' && x.length > 0));
  const collect = item => {
    if (Array.isArray(item)) return item.forEach(collect);
    if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        if (sensitiveKey.test(key) && typeof child === 'string' && child) secrets.add(child);
        collect(child);
      }
    }
  };
  collect(value);
  const scrub = item => {
    if (typeof item === 'string') {
      for (const secret of secrets) item = item.split(secret).join('[REDACTED]');
      return item.replace(/([?&](?:token|password|secret)=)[^&#\s]+/gi, '$1[REDACTED]');
    }
    if (Array.isArray(item)) return item.map(scrub);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(
      ([key, child]) => [key, sensitiveKey.test(key) ? '[REDACTED]' : scrub(child)]
    ));
    return item;
  };
  return scrub(value);
}

export function credentialFile(env = process.env) {
  if (env.AUTODL_CREDENTIAL_FILE) return path.resolve(env.AUTODL_CREDENTIAL_FILE);
  return env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'CodexAutoDL', 'token.dpapi') : undefined;
}

export async function loadToken(env = process.env) {
  if (env.AUTODL_TOKEN?.trim()) return env.AUTODL_TOKEN.trim();
  const file = credentialFile(env);
  if (process.platform !== 'win32' || !file || !existsSync(file)) {
    throw new SafeError('CREDENTIALS_MISSING', '请先在本机运行 scripts/Configure-Token.ps1，或在启动 Codex 的环境中设置 AUTODL_TOKEN。');
  }
  try {
    const script = fileURLToPath(new URL('../scripts/Read-Token.ps1', import.meta.url));
    // PowerShell 7 module paths can prevent Windows PowerShell from loading its
    // own security module. Let the credential reader use the classic defaults.
    const readerEnv = Object.fromEntries(Object.entries(env)
      .filter(([key, value]) => key.toLowerCase() !== 'psmodulepath' && value !== undefined));
    const powershell = path.join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await promisify(execFile)(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-CredentialFile', file
    ], { env: readerEnv, windowsHide: true, timeout: 10000, maxBuffer: 65536 });
    if (!stdout.trim()) throw new Error('empty');
    return stdout.trim();
  } catch {
    throw new SafeError('CREDENTIALS_UNREADABLE', '无法解密本机凭据。请在当前 Windows 用户下重新运行 Configure-Token.ps1。');
  }
}

// https.request is deliberate: AutoDL documents JSON bodies on its GET endpoints.
// fetch refuses GET bodies. Redirects and automatic retries are never followed.
export function requestJson(spec, requestImpl = https.request) {
  if (!Object.values(ENDPOINTS).some(([method, apiPath]) => method === spec.method && apiPath === spec.path)) {
    return Promise.reject(new SafeError('ENDPOINT', '仅允许调用列出的 AutoDL 官方 API 地址与请求方法。'));
  }
  return new Promise((resolve, reject) => {
    const body = spec.body === undefined ? undefined : JSON.stringify(spec.body);
    const req = requestImpl(new URL(spec.path, API_ORIGIN), {
      method: spec.method,
      headers: {
        Authorization: spec.token,
        Accept: 'application/json',
        ...(body === undefined ? {} : {
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)
        })
      }
    }, res => {
      const chunks = [];
      let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) {
          req.destroy(new SafeError('RESPONSE_TOO_LARGE', 'AutoDL 响应超过读取上限。'));
        } else chunks.push(chunk);
      });
      res.on('error', () => reject(new SafeError('NETWORK', '读取 AutoDL 响应失败；变更结果可能未知，请先查询状态。')));
      res.on('end', () => {
        if (res.statusCode >= 300 && res.statusCode < 400) {
          return reject(new SafeError('REDIRECT_BLOCKED', '官方 API 返回重定向，凭据未转发到其他地址。'));
        }
        let json;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return reject(new SafeError('INVALID_RESPONSE', `AutoDL 返回非 JSON 响应（HTTP ${res.statusCode}）。`)); }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new SafeError('HTTP_ERROR', `AutoDL 请求失败（HTTP ${res.statusCode}）。`, json?.request_id));
        }
        resolve(json);
      });
    });
    req.setTimeout(20000, () => req.destroy(new SafeError('TIMEOUT', 'AutoDL 请求超时；变更结果可能未知，请先查询状态。')));
    req.on('error', error => reject(error instanceof SafeError ? error :
      new SafeError('NETWORK', '无法连接 AutoDL 官方 API；变更结果可能未知，请先查询状态。')));
    req.end(body);
  });
}

export class AutoDLClient {
  constructor({ tokenProvider = loadToken, transport = requestJson } = {}) {
    this.tokenProvider = tokenProvider;
    this.transport = transport;
  }
  async call(endpoint, body) {
    if (!Object.hasOwn(ENDPOINTS, endpoint)) throw new SafeError('ENDPOINT', '未知接口。');
    const token = await this.tokenProvider();
    if (!token) throw new SafeError('CREDENTIALS_MISSING', '未配置 AutoDL 开发者 Token。');
    const [method, apiPath] = ENDPOINTS[endpoint];
    let response;
    try {
      response = await this.transport({ method, path: apiPath, token, body });
    } catch (error) {
      if (error instanceof SafeError) {
        throw new SafeError(error.code, redact(error.message, [token]), redact(error.requestId, [token]));
      }
      throw new SafeError('NETWORK', 'AutoDL 请求未完成；变更结果可能未知，请先查询状态。');
    }
    if (!response || response.code !== 'Success') {
      const safe = redact(response ?? {}, [token]);
      throw new SafeError(String(safe.code ?? 'API_ERROR'), String(safe.msg ?? 'AutoDL 请求失败。'), safe.request_id);
    }
    return redact({ data: response.data, request_id: response.request_id }, [token]);
  }
}
