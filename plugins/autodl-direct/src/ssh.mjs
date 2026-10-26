import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';
import { mkdir, lstat, open, readFile, writeFile, rename, unlink, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { SafeError } from './api.mjs';

const exec = promisify(execFile);
const marker = '# Managed by AutoDL Direct; dedicated config, no user config edits.\n';
export function validatePublicKey(value) {
  if (typeof value !== 'string' || value.length > 256 || !/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/.test(value))
    throw new SafeError('INPUT', '只接受不含注释或换行的 Ed25519 公钥；不要提供私钥。');
  const encoded = value.split(' ')[1], blob = Buffer.from(encoded,'base64');
  if (blob.toString('base64') !== encoded || blob.length !== 51 || blob.readUInt32BE(0) !== 11 ||
      blob.subarray(4,15).toString() !== 'ssh-ed25519' || blob.readUInt32BE(15) !== 32)
    throw new SafeError('INPUT', 'Ed25519 公钥编码无效。');
  return value;
}
export function sshBootstrap(publicKey, startCommand) {
  if (publicKey === undefined) return startCommand;
  validatePublicKey(publicKey);
  // Exact validated public data, never a private key/password. Runs before the
  // supplied workload; failure prevents the workload but cannot stop GPU billing.
  const setup = `install -d -m 700 /root/.ssh && touch /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys && (grep -qxF '${publicKey}' /root/.ssh/authorized_keys || printf '\\n%s\\n' '${publicKey}' >> /root/.ssh/authorized_keys)`;
  const result = startCommand ? `${setup} && (\n${startCommand}\n)` : setup;
  if (result.length > 16384) throw new SafeError('INPUT', '公钥安装与开机命令合计超过16384字符。');
  return result;
}
function keyName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(value))
    throw new SafeError('INPUT', '密钥名只接受1至64位字母数字、下划线和连字符，不能使用系统设备名。');
  return value;
}
async function stat(file) {
  try { const info = await lstat(file); if (info.isSymbolicLink()) throw new SafeError('SSH_PATH', 'SSH 路径不能是符号链接。'); return info; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export class SshManager {
  constructor({ root = path.join(homedir(),'.ssh','autodl-direct'), run = exec } = {}) {
    if (!path.isAbsolute(root) || /[\r\n\u0000]/.test(root)) throw new SafeError('SSH_PATH', 'SSH 目录须为绝对路径。');
    this.root = path.resolve(root); this.run = run;
  }
  paths(name) { keyName(name); return { privateKey: path.join(this.root,name), publicKey: path.join(this.root,`${name}.pub`) }; }
  async checkRoot(create = false) {
    // Check every existing ancestor to avoid writing through a symlink/junction.
    const parents = []; let current = this.root;
    while (path.dirname(current) !== current) { parents.unshift(current); current = path.dirname(current); }
    for (const dir of parents) { const info = await stat(dir); if (info && !info.isDirectory()) throw new SafeError('SSH_PATH', 'SSH 目录路径被文件占用。'); }
    if (create) { await mkdir(this.root,{recursive:true,mode:0o700}); if (process.platform !== 'win32') await chmod(this.root,0o700); }
  }
  async key(name, execute = false) {
    const files = this.paths(name);
    if (!execute) return { executed:false, preview:{action:'generate_or_reuse_dedicated_ed25519',key_name:name,...files}, note:'执行后创建本机专用无口令密钥；已有密钥不会覆盖，私钥不返回、不上传。' };
    await this.checkRoot(true);
    const lockPath = path.join(this.root,`${name}.lock`);
    let lock;
    try { lock = await open(lockPath,'wx',0o600); }
    catch { throw new SafeError('SSH_LOCK', '密钥正由其他操作使用；请检查后重试。'); }
    try {
      const privateInfo = await stat(files.privateKey), publicInfo = await stat(files.publicKey);
      if (privateInfo && !privateInfo.isFile() || publicInfo && !publicInfo.isFile() || Boolean(privateInfo) !== Boolean(publicInfo))
        throw new SafeError('SSH_KEY_INCOMPLETE', '密钥文件不完整或类型错误；不会覆盖或删除现有文件。');
      let created = false;
      if (!privateInfo) {
        try { await this.run('ssh-keygen',['-q','-t','ed25519','-N','','-C','autodl-direct','-f',files.privateKey],{windowsHide:true,timeout:20000,maxBuffer:16384}); }
        catch { throw new SafeError('SSH_KEYGEN', '系统 ssh-keygen 未完成；检查 OpenSSH 与本机文件权限。'); }
        created = true;
      }
      const publicKey = await this.publicKey(name);
      // Verify the public file matches the private key, without returning private bytes.
      let derived;
      try { derived = await this.run('ssh-keygen',['-y','-P','','-f',files.privateKey],{windowsHide:true,timeout:10000,maxBuffer:16384}); }
      catch { throw new SafeError('SSH_KEY_INVALID', '不能验证专用密钥；不会读取或返回私钥内容。'); }
      if (derived.stdout.trim().split(/\s+/).slice(0,2).join(' ') !== publicKey) throw new SafeError('SSH_KEY_MISMATCH', '公钥与私钥不匹配，拒绝使用。');
      return { executed:true,created,key_name:name,...files,ssh_public_key:publicKey,
        fingerprint:'SHA256:'+createHash('sha256').update(Buffer.from(publicKey.split(' ')[1],'base64')).digest('base64').replace(/=+$/,''),
        remote_authorized:false,login:'not_verified',note:'把 ssh_public_key 传入创建/开机工具；安装公钥需要执行开机命令。私钥只留在本机。' };
    } finally { await lock.close(); await unlink(lockPath); }
  }
  async publicKey(name) {
    await this.checkRoot(); const files = this.paths(name);
    const info = await stat(files.publicKey);
    if (!info?.isFile() || info.size > 4096) throw new SafeError('SSH_KEY_MISSING', '缺少合法专用公钥；先执行 autodl_prepare_ssh_key。');
    const value = (await readFile(files.publicKey,'utf8')).trim().split(/\s+/).slice(0,2).join(' ');
    return validatePublicKey(value);
  }
  async connection(instance, name, connection, execute = false) {
    if (!/^pro-[A-Za-z0-9-]{1,80}$/.test(instance)) throw new SafeError('INPUT', '需要合法 Pro 实例 ID。');
    const files = this.paths(name);
    if (!connection?.available || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(connection.host ?? '') ||
        !Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535 || !/^[A-Za-z0-9_-]+$/.test(connection.username ?? ''))
      throw new SafeError('SSH_CONNECTION', '详情没有经过校验的 SSH 连接地址。');
    if (connection.username !== 'root') throw new SafeError('SSH_CONNECTION', '公钥安装路径只适用于 root，其他用户需要已有授权配置。');
    const configFile = path.join(this.root,`${instance}.conf`);
    const escapedKey = files.privateKey.replaceAll('\\','/').replaceAll('%','%%').replaceAll('"','\\"');
    const config = marker+`Host ${instance}\n  HostName ${connection.host}\n  Port ${connection.port}\n  User ${connection.username}\n  IdentityFile "${escapedKey}"\n  IdentitiesOnly yes\n  StrictHostKeyChecking ask\n  ForwardAgent no\n`;
    const result = { executed:execute,config_path:configFile,config,
      ssh_argv:['ssh','-F',configFile,instance],scp_argv:['scp','-F',configFile],sftp_argv:['sftp','-F',configFile,instance],
      authentication:'public_key_installation_not_verified',host_verification:'required; existing known_hosts retained',login:'not_verified',
      note:'独立配置不会修改用户主配置。首次连接须核验主机指纹；实际 SSH 登录仍需执行系统 SSH 验证。' };
    if (!execute) return result;
    await this.publicKey(name);
    const privateInfo = await stat(files.privateKey);
    if (!privateInfo?.isFile()) throw new SafeError('SSH_KEY_MISSING', '缺少本机专用私钥。');
    const previous = await stat(configFile);
    if (previous && (!previous.isFile() || previous.size > 16384 || !(await readFile(configFile,'utf8')).startsWith(marker)))
      throw new SafeError('SSH_CONFIG_EXISTS', '同名配置不属于插件，拒绝覆盖。');
    const temp = `${configFile}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp,config,{flag:'wx',mode:0o600});
    try { await rename(temp,configFile); } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    return result;
  }
}
