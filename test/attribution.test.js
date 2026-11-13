import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mulberry32, quantile, userBootstrap } from '../src/resample.js';
import { attribute, compareWindows } from '../src/attribution.js';
import { validatePolicy, loadPolicy, REMOVAL_RULES } from '../src/policy.js';
import { runAttribution } from '../src/markov.js';

const loadFixture = async name =>
  JSON.parse(await readFile(new URL(`fixtures/${name}.json`, import.meta.url), 'utf8'));

const config = { silenceMinutes: 30, collapseConsecutive: true, removal: 'drop-to-null' };

test('确定性种子让 bootstrap 结果可复现，且按整个 user 重抽', async () => {
  const fixture = await loadFixture('handcalc');
  const first = userBootstrap(fixture.records, config, { iterations: 50, seed: 81 });
  const second = userBootstrap(fixture.records, config, { iterations: 50, seed: 81 });
  assert.deepEqual(first, second);
  assert.equal(first.method, 'user-level-whole-path-resample');
  assert.equal(first.unit, 'user');
  assert.equal(first.iterations, 50);
  assert.equal(first.validIterations, 50);
  assert.deepEqual(first.failedIterations, []);

  const otherSeed = userBootstrap(fixture.records, config, { iterations: 50, seed: 7 });
  assert.notDeepEqual(otherSeed.channels, first.channels);

  // 每个渠道的区间结构完整且 P5 <= 中位数 <= P95
  for (const channel of ['A', 'B', 'C']) {
    const share = first.channels[channel].share;
    assert.ok(share.p5 <= share.median + 1e-12);
    assert.ok(share.median <= share.p95 + 1e-12);
  }
});

test('同分布均匀数据下 bootstrap 中位数贴近点估计', async () => {
  const fixture = await loadFixture('direct-only');
  const result = userBootstrap(fixture.records, config, { iterations: 200, seed: 81 });
  assert.ok(Math.abs(result.channels.D.share.median - 1) < 1e-12);
  assert.ok(Math.abs(result.channels.D.effect.median - 0.5) < 1e-12);
});

test('全未转化数据的 bootstrap 不伪造贡献区间，只保留效应区间', async () => {
  const fixture = await loadFixture('unconverted-only');
  const result = userBootstrap(fixture.records, config, { iterations: 40, seed: 81 });
  for (const channel of ['A', 'B', 'C']) {
    assert.equal(result.channels[channel].share, null);
    assert.ok(Math.abs(result.channels[channel].effect.median) < 1e-12);
  }
});

test('PRNG 与分位数辅助函数行为确定', () => {
  const make = () => mulberry32(81);
  const first = [make(), make(), make()].map(random => random());
  const second = [make(), make(), make()].map(random => random());
  assert.deepEqual(first, second);
  assert.ok(first.every(value => value > 0 && value < 1));
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(quantile(values, 0.05), 1);
  assert.equal(quantile(values, 0.5), 5);
  assert.equal(quantile(values, 0.95), 10);
  assert.equal(quantile([], 0.5), null);
});

test('多窗口分别重新建模，并列出归因变化最大的渠道', async () => {
  const fixture = await loadFixture('silence-split');
  const policy = {
    silenceMinutes: 30,
    silenceWindows: [15, 30],
    collapseConsecutive: true,
    removal: 'drop-to-null',
    bootstrapIterations: 30,
    seed: 81
  };
  const archive = attribute(fixture.records, policy, { windows: [15, 30], iterations: 30, seed: 81 });

  assert.deepEqual(archive.windowComparison.windows, [15, 30]);
  const at15 = archive.windows.find(result => result.config.silenceMinutes === 15);
  const at30 = archive.windows.find(result => result.config.silenceMinutes === 30);
  assert.equal(at15.pathCount, 2);
  assert.equal(at30.pathCount, 1);
  // 窗口 15 时 A 只出现在流失路径（贡献 0），窗口 30 时 A 进入转化路径，变化幅度最大
  assert.equal(archive.windowComparison.ranking[0].channel, 'A');
  assert.equal(archive.windowComparison.ranking[0].maxChange.fromWindow, 15);
  assert.equal(archive.windowComparison.ranking[0].maxChange.toWindow, 30);
  assert.ok(Math.abs(archive.windowComparison.ranking[0].maxChange.absolute) > 0);

  // 排名按绝对变化降序
  const changes = archive.windowComparison.ranking.map(entry => entry.maxChange.absolute);
  assert.deepEqual(changes, [...changes].sort((left, right) => right - left));
});

test('compareWindows 对没有有效贡献的配置返回空排名', () => {
  const empty = compareWindows([]);
  assert.deepEqual(empty.ranking, []);
});

test('策略文件被严格校验，未知移除规则直接拒绝', () => {
  const valid = {
    silenceMinutes: 30,
    silenceWindows: [15, 30],
    collapseConsecutive: true,
    removal: 'drop-to-null',
    bootstrapIterations: 100,
    seed: 81
  };
  assert.strictEqual(validatePolicy(valid), valid);
  assert.ok(REMOVAL_RULES['drop-to-null'].includes('流失'));

  for (const patch of [
    { silenceMinutes: 0 },
    { silenceWindows: [] },
    { silenceWindows: [10, 10] },
    { collapseConsecutive: 'yes' },
    { removal: 'skip-touch' },
    { bootstrapIterations: -1 },
    { seed: 1.5 }
  ]) {
    assert.throws(() => validatePolicy({ ...valid, ...patch }), /配置|合法/);
  }
  assert.throws(() => validatePolicy(null), /配置对象/);
});

test('loadPolicy 合并 CLI 覆盖项并产出指纹', async () => {
  const loaded = await loadPolicy('data/policy.json', { bootstrapIterations: 11, seed: 9 });
  assert.equal(loaded.policy.bootstrapIterations, 11);
  assert.equal(loaded.policy.seed, 9);
  assert.equal(typeof loaded.fingerprint, 'string');
  assert.equal(loaded.policy.removal, 'drop-to-null');
});

test('归因档案在同一配置下同时包含路径频次、转移矩阵、移除效应和归一贡献', async () => {
  const fixture = await loadFixture('handcalc');
  const archive = attribute(fixture.records, {
    silenceMinutes: 30,
    silenceWindows: [30],
    collapseConsecutive: true,
    removal: 'drop-to-null',
    bootstrapIterations: 20,
    seed: 81
  });
  assert.ok(Array.isArray(archive.primary.paths));
  assert.ok(archive.primary.transitionMatrix);
  assert.ok(archive.primary.removalEffects.A);
  assert.ok(archive.primary.normalization.contributions.A !== undefined);
  assert.equal(archive.scopeNotice.includes('不代表因果'), true);
  // 主窗口结果与直接运行流水线一致
  const direct = runAttribution(fixture.records, config);
  assert.equal(archive.primary.absorption.convert, direct.absorption.convert);
});
