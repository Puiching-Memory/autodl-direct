import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { pathToFileURL } from 'node:url';
import { createTools, errorResult, toolResult } from './tools.mjs';

export { AutoDLClient, requestJson, redact, SafeError, ENDPOINTS, loadToken } from './api.mjs';
export { createTools, errorResult } from './tools.mjs';

export function buildServer(client, env) {
  const server = new McpServer({ name: 'autodl-direct', version: '0.1.2' }, {
    instructions: '本地自建工具直接访问 AutoDL 官方 API，仅支持 Pro 实例。先检查配置与实例。变更默认预览；用户已有授权可覆盖真实执行，无须重复索取同一授权。API 接受请求不等于操作完成，必须查询状态。工具不会自动关机；长任务使用系统 SSH 后台运行并按约定收尾。凭据不应出现在聊天或日志。'
  });
  for (const tool of createTools(client, env)) {
    server.registerTool(tool.name, { title: tool.title, description: tool.description,
      inputSchema: tool.schema, annotations: tool.annotations }, async input => {
      try { return toolResult(await tool.run(input)); }
      catch (error) { return errorResult(error); }
    });
  }
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await buildServer().connect(new StdioServerTransport()); }
  catch { process.stderr.write('AutoDL Direct 启动失败。请检查 Node.js 版本与插件文件。\n'); process.exitCode = 1; }
}
