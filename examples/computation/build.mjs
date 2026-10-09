import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const sample = async name => [name, await readFile(resolve(here, name), 'utf8')];
const presets = [
  { title: '算术、寄存器与限幅', path: 'signal_example', signal: 'out', files: [await sample('arithmetic.v')] },
  { title: '双向端口与 VHDL（精简示例）', path: 'temp_top', signal: 'dq_in_1', files: [await sample('dq-top.v'), await sample('dq-driver.vhd')] },
];
// 显式传入真实文件时仅只读快照；真实工程文本只进入 .tmp 生成页，不进入仓库样例。
const supplied = process.argv.slice(2);
if (supplied.length) {
  const files = [];
  for (const name of supplied) {
    const file = resolve(name), bytes = await readFile(file);
    let text;
    if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder('utf-16le').decode(bytes);
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder('utf-16be').decode(bytes);
    else { try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { text = new TextDecoder('gbk').decode(bytes); } }
    files.push([file.replaceAll('\\', '/'), text]);
  }
  presets.push({ title: 'DS18B20 真实源码快照', path: 'temp_top', signal: 'dq_in_1', files });
}
const result = await build({ entryPoints: [resolve(here, 'index.ts')], bundle: true, write: false, format: 'iife', target: 'es2022', define: { PRESETS: JSON.stringify(presets) } });
const theme = (await readFile(resolve(root, 'src/style.css'), 'utf8')).match(/:root(?:\[data-theme="(?:dark|light)"\])?\s*\{[^}]+\}/g).join('\n');
const css = theme + '\n' + await readFile(resolve(here, 'preview.css'), 'utf8');
const html = `<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RTL Viewer · 信号运算过程</title><style>${css}</style></head><body><div id="app"></div><script>${result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
const out = resolve(root, '.tmp/computation-preview');
await mkdir(out, { recursive: true });
await writeFile(resolve(out, 'index.html'), html);
console.log(`${resolve(out, 'index.html')} (${Buffer.byteLength(html)} bytes; ${presets.map(p => p.title).join(', ')})`);
