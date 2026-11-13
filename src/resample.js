// 按 user 整组重抽的 bootstrap：一个用户的全部路径作为一个抽样单位，
// 绝不把每条边或每条路径独立抽样。重抽后完整重建路径与模型。

import { ClosedChainError, runAttribution } from './markov.js';

export function mulberry32(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 最近秩分位数（nearest-rank），区间随重抽样本完全确定。 */
export function quantile(sortedValues, probability) {
  if (sortedValues.length === 0) return null;
  const rank = Math.max(1, Math.ceil(probability * sortedValues.length));
  return sortedValues[rank - 1];
}

function summarizeSamples(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = quantile(sorted, 0.5);
  return {
    p5: quantile(sorted, 0.05),
    median: middle,
    p95: quantile(sorted, 0.95),
    samples: sorted.length
  };
}

export function userBootstrap(records, config, { iterations, seed }) {
  const groups = new Map();
  for (const record of records) {
    if (!groups.has(record.user)) groups.set(record.user, []);
    groups.get(record.user).push(record);
  }
  const users = [...groups.keys()].sort((left, right) => left.localeCompare(right, 'en'));
  const random = mulberry32(seed);

  const effectSamples = new Map();
  const shareSamples = new Map();
  const absorptionSamples = [];
  let validIterations = 0;
  const failedIterations = [];

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const resampled = [];
    for (let draw = 0; draw < users.length; draw += 1) {
      const user = users[Math.floor(random() * users.length)];
      resampled.push(...groups.get(user));
    }
    try {
      const result = runAttribution(resampled, config);
      validIterations += 1;
      absorptionSamples.push(result.absorption.convert);
      for (const channel of result.channels) {
        if (!effectSamples.has(channel)) {
          effectSamples.set(channel, []);
          shareSamples.set(channel, []);
        }
        effectSamples.get(channel).push(result.removalEffects[channel].effect);
        if (result.normalization.contributions) {
          shareSamples.get(channel).push(result.normalization.contributions[channel]);
        }
      }
    } catch (error) {
      if (error instanceof ClosedChainError) {
        failedIterations.push({ iteration, reason: 'closed-non-absorbing-subchain' });
      } else {
        throw error;
      }
    }
  }

  const channels = [...effectSamples.keys()].sort((left, right) => left.localeCompare(right, 'en'));
  return {
    method: 'user-level-whole-path-resample',
    unit: 'user',
    iterations,
    validIterations,
    failedIterations,
    seed,
    absorption: summarizeSamples(absorptionSamples),
    channels: Object.fromEntries(channels.map(channel => [channel, {
      effect: summarizeSamples(effectSamples.get(channel)),
      share: shareSamples.get(channel).length ? summarizeSamples(shareSamples.get(channel)) : null
    }]))
  };
}
