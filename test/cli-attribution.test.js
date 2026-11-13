import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArguments } from '../src/cli.js';
import { renderReport } from '../src/report.js';
import { attribute } from '../src/attribution.js';

const run = args => spawnSync(process.execPath, ['src/cli.js', ...args], { encoding: 'utf8' });

async function stageDataset(folder, fixtureName) {
  const fixture = JSON.parse(await readFile(`test/fixtures/${fixtureName}.json`, 'utf8'));
  const path = join(folder, `${fixtureName}.json`);
  await writeFile(path, JSON.stringify({ version: 1, records: fixture.records }));
  return path;
}

test('attribution 命令生成机器档案与中文报告，退出码为零', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'attribution-cli-'));
  try {
    const input = await stageDataset(folder, 'handcalc');
    const archivePath = join(folder, 'attribution.json');
    const reportPath = join(folder, 'attribution.md');
    const result = run([
      'attribution',
      '--input', input,
      '--policy', 'data/policy.json',
      '--window', '15', '--window', '30',
      '--bootstrap', '40', '--seed', '81',
      '--out', archivePath,
      '--report', reportPath
    ]);
    assert.equal(result.status, 0, result.stderr);
    const archive = JSON.parse(await readFile(archivePath, 'utf8'));
    assert.equal(archive.method, 'first-order-markov-removal-attribution');
    assert.ok(archive.inputFingerprint);
    assert.ok(archive.policyFingerprint);
    assert.deepEqual(archive.policy.silenceWindows, [15, 30]);
    assert.equal(archive.policy.bootstrapIterations, 40);
    assert.ok(archive.primary.paths.length >= 3);
    assert.ok(archive.primary.transitionMatrix);
    assert.ok(archive.primary.removalEffects.A);
    assert.ok(archive.primary.normalization.contributions);

    const report = await readFile(reportPath, 'utf8');
    for (const heading of ['Markov 路径归因说明', '建模规则', '路径频次', '一阶转移矩阵', '总体吸收概率', '移除效应与归一贡献', '稳定区间', '静默窗口对比']) {
      assert.ok(report.includes(heading), `报告缺少章节：${heading}`);
    }
    assert.ok(report.includes('不代表因果投放效果'));
    assert.ok(report.includes('drop-to-null'));

    // stdout 与落盘档案一致
    assert.deepEqual(JSON.parse(result.stdout), archive);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('报告对全未转化配置明确说明无法归一，不伪造比例', async () => {
  const fixture = JSON.parse(await readFile('test/fixtures/unconverted-only.json', 'utf8'));
  const archive = attribute(fixture.records, {
    silenceMinutes: 30,
    silenceWindows: [30],
    collapseConsecutive: true,
    removal: 'drop-to-null',
    bootstrapIterations: 20,
    seed: 81
  });
  const report = renderReport(archive, {
    generatedAt: '2026-01-01T00:00:00.000Z',
    inputFingerprint: 'fp',
    policyFingerprint: 'pp'
  });
  assert.ok(report.includes('all-zero-effects'));
  assert.ok(report.includes('无法给出归一化贡献'));
});

test('旧 summary 与 inspect 口径保持不变，不被归因结果污染', () => {
  const summary = run(['summary']);
  assert.equal(summary.status, 0);
  const parsed = JSON.parse(summary.stdout);
  assert.equal(parsed.groupBy, 'channel');
  assert.equal(parsed.groups.length, 3);
  assert.ok(!('removalEffects' in parsed));
  assert.ok(!('transitionMatrix' in parsed));

  const inspect = run(['inspect']);
  assert.equal(inspect.status, 0);
  assert.equal(JSON.parse(inspect.stdout).records, 96);
});

test('参数解析覆盖 attribution 选项并拒绝非法输入', () => {
  const parsed = parseArguments([
    'attribution', '--window', '15', '--window', '60', '--bootstrap', '50', '--seed', '81'
  ]);
  assert.equal(parsed.command, 'attribution');
  assert.deepEqual(parsed.windows, [15, 60]);
  assert.equal(parsed.bootstrap, '50');

  assert.throws(() => parseArguments(['attribution', '--window', '0']), /正整数/);
  assert.throws(() => parseArguments(['attribution', '--bootstrap', 'x']), /正整数/);
  assert.throws(() => parseArguments(['attribution', '--unknown', '1']), /参数/);
  assert.throws(() => parseArguments(['attribution', '--out']), /参数/);
  assert.throws(() => parseArguments(['delete']), /命令/);
  assert.equal(parseArguments([]).command, 'summary');
});

test('错误参数与缺失策略文件让命令非零退出', () => {
  assert.equal(run(['attribution', '--policy', 'data/missing.json']).status, 1);
  assert.equal(run(['attribution', '--window', '-3']).status, 1);
});

test('报告写入为纯文本 Markdown 而非 JSON 字符串', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'report-'));
  try {
    const input = await stageDataset(folder, 'direct-only');
    const reportPath = join(folder, 'report.md');
    const result = run([
      'attribution', '--input', input,
      '--bootstrap', '10', '--report', reportPath
    ]);
    assert.equal(result.status, 0, result.stderr);
    const text = await readFile(reportPath, 'utf8');
    assert.ok(text.startsWith('# Markov 路径归因说明'));
    assert.throws(() => JSON.parse(text));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('策略文件版本字段缺失等坏数据被拒绝', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'bad-policy-'));
  try {
    const policyPath = join(folder, 'policy.json');
    await writeFile(policyPath, JSON.stringify({ silenceMinutes: 30 }));
    const result = run(['attribution', '--policy', policyPath]);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.length > 0);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
