import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  START, CONVERT, NULL,
  buildPaths, aggregatePathFrequencies, buildTransitionModel,
  absorptionProbabilities, removalModel, normalizeEffects, runAttribution, ClosedChainError
} from '../src/markov.js';

const loadFixture = async name =>
  JSON.parse(await readFile(new URL(`fixtures/${name}.json`, import.meta.url), 'utf8'));

const baseConfig = { silenceMinutes: 30, collapseConsecutive: true, removal: 'drop-to-null' };
const closeEnough = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12,
  `${actual} 与 ${expected} 偏差过大`);

test('三渠道例子的吸收概率、移除效应和归一贡献与手算分数一致', async () => {
  const fixture = await loadFixture('handcalc');
  const result = runAttribution(fixture.records, baseConfig);

  closeEnough(result.absorption.convert, 0.55);
  closeEnough(result.absorption.churn, 0.45);
  closeEnough(result.absorption.convert + result.absorption.churn, 1);

  closeEnough(result.removalEffects.A.effect, 0.3);
  closeEnough(result.removalEffects.B.effect, 0.25);
  closeEnough(result.removalEffects.C.effect, 0.3);

  closeEnough(result.normalization.contributions.A, 6 / 17);
  closeEnough(result.normalization.contributions.B, 5 / 17);
  closeEnough(result.normalization.contributions.C, 6 / 17);
  closeEnough(Object.values(result.normalization.contributions).reduce((a, b) => a + b, 0), 1);
  assert.equal(result.normalization.reason, null);
});

test('drop-to-null 移除时进入被移除渠道的质量改道流失，且不跳过触点、不重归一化', async () => {
  const fixture = await loadFixture('handcalc');
  const { paths } = buildPaths(fixture.records, baseConfig);
  const model = buildTransitionModel(aggregatePathFrequencies(paths));

  const removedA = removalModel(model, 'A');
  // START -> A 的质量 1/2 改道到 NULL；START 行其余概率保持原值，行和不再等于 1
  closeEnough(removedA.matrix[START][NULL], 1 / 2);
  closeEnough(removedA.matrix[START].A, 0);
  closeEnough(removedA.matrix[START].B, 1 / 2);
  closeEnough(removedA.redirectedMass[START], 1 / 2);
  // A 被移除后等价于流失吸收态，不会被困成非吸收死状态
  closeEnough(removedA.matrix.A[NULL], 1);
  assert.equal(removedA.matrix.A.C, 0);
  // 未涉及渠道的行完全不变
  assert.deepEqual(removedA.matrix.B, model.matrix.B);
});

test('连续同渠道折叠，非连续回访保留', async () => {
  const fixture = await loadFixture('repeat-touch');
  const { paths } = buildPaths(fixture.records, baseConfig);
  assert.deepEqual(paths.map(path => path.channels), [['A', 'B'], ['A', 'B', 'A']]);

  const result = runAttribution(fixture.records, baseConfig);
  closeEnough(result.absorption.convert, 1);
  closeEnough(result.removalEffects.A.effect, 1);
  closeEnough(result.removalEffects.B.effect, 2 / 3);
  closeEnough(result.normalization.contributions.A, 3 / 5);
  closeEnough(result.normalization.contributions.B, 2 / 5);

  // 关闭折叠后 A,A 保留为两个连续触点
  const expanded = buildPaths(fixture.records, { ...baseConfig, collapseConsecutive: false });
  assert.deepEqual(expanded.paths.map(path => path.channels), [['A', 'A', 'B'], ['A', 'B', 'A']]);
});

test('仅直接访问仍建模为开始-渠道-吸收态', async () => {
  const fixture = await loadFixture('direct-only');
  const result = runAttribution(fixture.records, baseConfig);
  assert.deepEqual(result.channels, ['D']);
  closeEnough(result.absorption.convert, 0.5);
  closeEnough(result.removalEffects.D.effect, 0.5);
  closeEnough(result.normalization.contributions.D, 1);
});

test('只有未转化记录时效应全零，拒绝输出伪造的归一比例', async () => {
  const fixture = await loadFixture('unconverted-only');
  const result = runAttribution(fixture.records, baseConfig);
  closeEnough(result.absorption.convert, 0);
  closeEnough(result.absorption.churn, 1);
  for (const channel of result.channels) closeEnough(result.removalEffects[channel].effect, 0);
  assert.equal(result.normalization.contributions, null);
  assert.equal(result.normalization.reason, 'all-zero-effects');
});

test('频次只在路径层累计一次，不重复乘到每条边上', async () => {
  const records = [
    { id: 'x1', user: 'u1', session: 's1', minute: 0, channel: 'A', converted: false, weight: 4 },
    { id: 'x2', user: 'u1', session: 's1', minute: 5, channel: 'B', converted: true, weight: 4 }
  ];
  const { paths } = buildPaths(records, baseConfig);
  const table = aggregatePathFrequencies(paths);
  assert.equal(table.length, 1);
  assert.equal(table[0].frequency, 4);
  const model = buildTransitionModel(table);
  // 每条边的计数都是频次本身（4），而不是 4^2=16；行归一化后概率与频次无关
  assert.equal(model.counts.get(START).get('A'), 4);
  assert.equal(model.counts.get('A').get('B'), 4);
  assert.equal(model.counts.get('B').get(CONVERT), 4);
  closeEnough(model.matrix[START].A, 1);
  closeEnough(model.matrix.A.B, 1);
});

test('静默间隔超时切断路径，旧路径归入流失终态；新 session 同样切断', async () => {
  const fixture = await loadFixture('silence-split');
  const split = buildPaths(fixture.records, { ...baseConfig, silenceMinutes: 15 });
  assert.equal(split.paths.length, 2);
  assert.deepEqual(split.paths[0].channels, ['A']);
  assert.equal(split.paths[0].outcome, NULL);
  assert.deepEqual(split.paths[1].channels, ['B']);
  assert.equal(split.paths[1].outcome, CONVERT);

  const kept = buildPaths(fixture.records, { ...baseConfig, silenceMinutes: 30 });
  assert.equal(kept.paths.length, 1);
  assert.deepEqual(kept.paths[0].channels, ['A', 'B']);
  assert.equal(kept.paths[0].outcome, CONVERT);

  const crossSession = buildPaths([
    { id: 'c1', user: 'u1', session: 's1', minute: 0, channel: 'A', converted: false, weight: 1 },
    { id: 'c2', user: 'u1', session: 's2', minute: 1, channel: 'B', converted: true, weight: 1 }
  ], baseConfig);
  assert.equal(crossSession.paths.length, 2);
});

test('归一化不钳制负效应；非正总和时拒绝给比例', () => {
  const kept = normalizeEffects({ A: 0.6, B: -0.2 }, ['A', 'B']);
  closeEnough(kept.contributions.A, 1.5);
  closeEnough(kept.contributions.B, -0.5);
  closeEnough(Object.values(kept.contributions).reduce((a, b) => a + b, 0), 1);

  const zeros = normalizeEffects({ A: 0, B: 0 }, ['A', 'B']);
  assert.equal(zeros.contributions, null);
  assert.equal(zeros.reason, 'all-zero-effects');

  const negativeSum = normalizeEffects({ A: -0.4, B: 0.1 }, ['A', 'B']);
  assert.equal(negativeSum.contributions, null);
  assert.equal(negativeSum.reason, 'non-positive-effect-sum');
});

test('闭合非吸收子链被检测并拒绝，不硬改成合理比例', () => {
  // A、B 互相转移且没有任何吸收出边，构成闭合非吸收子链
  const paths = [{ channels: ['A', 'B'], outcome: CONVERT, frequency: 1 }];
  const model = buildTransitionModel(paths);
  // 手工破坏出边，制造闭合子链
  for (const state of ['A', 'B']) {
    for (const key of Object.keys(model.matrix[state])) model.matrix[state][key] = 0;
  }
  model.matrix.A.B = 1;
  model.matrix.B.A = 1;
  assert.throws(() => absorptionProbabilities(model), ClosedChainError);
});

test('drop-to-null 下移除效应恒非负：改道只指向流失，从不指向转化', async () => {
  const fixture = await loadFixture('handcalc');
  const result = runAttribution(fixture.records, baseConfig);
  for (const channel of result.channels) {
    assert.ok(result.removalEffects[channel].effect >= -1e-12,
      `${channel} 出现负移除效应，违反 drop-to-null 的质量守恒性质`);
    assert.ok(result.removalEffects[channel].absorptionAfterRemoval <= result.absorption.convert + 1e-12);
  }
});

test('空数据与非法权重被明确拒绝', () => {
  assert.equal(runAttribution([], baseConfig).pathCount, 0);
  assert.throws(() => runAttribution([
    { id: 'z1', user: 'u1', session: 's1', minute: 0, channel: 'A', converted: false, weight: 0 }
  ], baseConfig), /weight/);
  assert.throws(() => runAttribution([
    { id: 'z2', user: 'u1', session: 's1', minute: 0, channel: START, converted: false, weight: 1 }
  ], baseConfig), /保留状态/);
});
