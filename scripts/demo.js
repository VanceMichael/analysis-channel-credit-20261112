import { main } from '../src/cli.js';
import { readFile } from 'node:fs/promises';

const started = performance.now();
console.log('读取本地演练记录并核对输入指纹');
console.log(JSON.stringify(await main(['inspect']), null, 2));
console.log('现有领域核算（触达口径，保持不变，不产出归因结果）');
console.log(JSON.stringify(await main(['summary', '--out', 'var/summary.json']), null, 2));
console.log('业务配置');
console.log(JSON.stringify(JSON.parse(await readFile('data/policy.json', 'utf8')), null, 2));
console.log('Markov 路径归因（描述性预算口径，含机器档案与中文报告）');
console.log(JSON.stringify(await main([
  'attribution',
  '--out', 'var/attribution.json',
  '--report', 'var/attribution.md'
]), null, 2));
console.log(`完成，用时 ${Math.ceil(performance.now() - started)} 毫秒`);
