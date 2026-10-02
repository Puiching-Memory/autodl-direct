import { build } from 'esbuild';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '..');
await mkdir(path.join(root, 'dist'), { recursive: true });
const result = await build({ entryPoints: [path.join(root, 'src/server.mjs')],
  absWorkingDir: root,
  outfile: path.join(root, 'dist/server.mjs'), bundle: true, platform: 'node', format: 'esm',
  target: 'node22', nodePaths: [path.join(directory, 'node_modules')],
  metafile: true, legalComments: 'eof', minify: false });
await writeFile(path.join(root, 'dist/build-inputs.json'), JSON.stringify({
  builder: 'esbuild 0.25.12', entrypoint: 'src/server.mjs',
  packages: ['@modelcontextprotocol/server@2.2.0', '@modelcontextprotocol/core@2.2.0', 'zod@4.6.5'],
  inputs: Object.keys(result.metafile.inputs).map(x => x.replaceAll('\\', '/').replace(/^.*node_modules\//, 'node_modules/'))
}, null, 2) + '\n');
const licenseFiles = [
  ['@modelcontextprotocol/server', 'node_modules/@modelcontextprotocol/server/LICENSE'],
  ['@modelcontextprotocol/core', 'node_modules/@modelcontextprotocol/core/LICENSE'],
  ['zod', 'node_modules/zod/LICENSE']
];
let notices = 'AutoDL Direct bundles the following protocol/schema libraries.\nAutoDL-specific application code is in src/. These libraries implement MCP and input validation.\n\n';
for (const [name, filename] of licenseFiles) {
  let license;
  try { license = await readFile(path.join(directory, filename), 'utf8'); }
  catch { license = await readFile(path.join(directory, filename.replace('/LICENSE', '/LICENSE.md')), 'utf8'); }
  notices += `${name}\n${license}\n\n`;
}
await writeFile(path.join(root, 'THIRD_PARTY_NOTICES.txt'), notices);
await writeFile(path.join(root, 'dependency-lock.json'), await readFile(path.join(directory, 'package-lock.json')));
for (const filename of await readdir(path.join(root, 'scripts'))) {
  if (!filename.endsWith('.ps1')) continue;
  const file = path.join(root, 'scripts', filename);
  const text = (await readFile(file, 'utf8')).replace(/^\uFEFF/, '');
  await writeFile(file, '\uFEFF' + text);
}
console.log(JSON.stringify({ built: 'dist/server.mjs', bytes: (await readFile(path.join(root, 'dist/server.mjs'))).length }));
