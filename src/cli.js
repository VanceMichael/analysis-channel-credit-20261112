import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadDataset } from './dataset.js';
import { summarize } from './domain.js';
import { writeResult, writeText } from './output.js';
import { loadPolicy } from './policy.js';
import { attribute } from './attribution.js';
import { renderReport } from './report.js';

const COMMANDS = ['summary', 'inspect', 'attribution'];
const COMMON_OPTIONS = ['--input', '--out'];
const ATTRIBUTION_OPTIONS = ['--policy', '--window', '--bootstrap', '--seed', '--report'];

export function parseArguments(args) {
  const [command = 'summary', ...options] = args;
  if (!COMMANDS.includes(command)) throw new Error(`命令应为 ${COMMANDS.join('、')} 之一`);
  const result = { command, input: 'data/records.json' };

  if (command === 'attribution') {
    result.windows = [];
  }
  const allowed = command === 'attribution'
    ? [...COMMON_OPTIONS, ...ATTRIBUTION_OPTIONS]
    : COMMON_OPTIONS;

  for (let index = 0; index < options.length; index += 2) {
    const name = options[index];
    const value = options[index + 1];
    if (!allowed.includes(name) || !value || value.startsWith('--')) {
      throw new Error(`参数应为 ${allowed.join('、')} 加取值的成对形式`);
    }
    if (name === '--window') {
      result.windows.push(Number(value));
      continue;
    }
    const key = name.slice(2);
    if (result[key] !== undefined && name !== '--input') throw new Error('参数不可重复');
    result[key] = value;
  }

  if (command === 'attribution') {
    for (const window of result.windows) {
      if (!Number.isSafeInteger(window) || window <= 0) throw new Error('--window 必须为正整数分钟');
    }
    if (result.bootstrap !== undefined && (!Number.isSafeInteger(Number(result.bootstrap)) || Number(result.bootstrap) <= 0)) {
      throw new Error('--bootstrap 必须为正整数');
    }
    if (result.seed !== undefined && !Number.isSafeInteger(Number(result.seed))) {
      throw new Error('--seed 必须为安全整数');
    }
  }
  return result;
}

export async function main(args) {
  const options = parseArguments(args);
  const dataset = await loadDataset(options.input);

  if (options.command === 'inspect') {
    const document = {
      records: dataset.records.length,
      fingerprint: dataset.fingerprint,
      fields: dataset.records.length ? Object.keys(dataset.records[0]).sort() : []
    };
    if (options.out) await writeResult(options.out, document);
    return document;
  }

  if (options.command === 'summary') {
    const result = summarize(dataset.records);
    const document = { ...result, inputFingerprint: dataset.fingerprint };
    if (options.out) await writeResult(options.out, document);
    return document;
  }

  const { policy, fingerprint: policyFingerprint } = await loadPolicy(options.policy ?? 'data/policy.json', {
    silenceWindows: options.windows.length ? options.windows : undefined,
    bootstrapIterations: options.bootstrap !== undefined ? Number(options.bootstrap) : undefined,
    seed: options.seed !== undefined ? Number(options.seed) : undefined
  });
  const archive = attribute(dataset.records, policy, {
    windows: options.windows.length ? options.windows : undefined,
    iterations: options.bootstrap !== undefined ? Number(options.bootstrap) : undefined,
    seed: options.seed !== undefined ? Number(options.seed) : undefined
  });
  const document = {
    ...archive,
    inputFingerprint: dataset.fingerprint,
    policyFingerprint
  };
  if (options.out) await writeResult(options.out, document);
  if (options.report) {
    const report = renderReport(archive, {
      generatedAt: new Date().toISOString(),
      inputFingerprint: dataset.fingerprint,
      policyFingerprint
    });
    await writeText(options.report, report);
  }
  return document;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result => {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }).catch(error => {
    process.stderr.write(`处理失败：${error.message}\n`);
    process.exitCode = 1;
  });
}
