// attribution 编排：同一批数据在一个或多个静默窗口下分别完整重建模型，
// 主窗口附带按 user 整组重抽的稳定区间，并输出跨窗口归因变化排名。

import { runAttribution } from './markov.js';
import { userBootstrap } from './resample.js';
import { REMOVAL_RULES } from './policy.js';

const shareOf = (windowResult, channel) => (
  windowResult.normalization.contributions
    ? windowResult.normalization.contributions[channel] ?? null
    : null
);

export function compareWindows(windowResults) {
  const channels = [...new Set(windowResults.flatMap(result => result.channels))]
    .sort((left, right) => left.localeCompare(right, 'en'));
  const windows = windowResults.map(result => result.config.silenceMinutes);

  const perChannel = channels.map(channel => {
    const shareByWindow = Object.fromEntries(windows.map((silence, index) =>
      [String(silence), shareOf(windowResults[index], channel)]));
    let maxChange = null;
    for (let i = 0; i < windows.length; i += 1) {
      for (let j = i + 1; j < windows.length; j += 1) {
        const left = shareByWindow[String(windows[i])];
        const right = shareByWindow[String(windows[j])];
        if (left === null || right === null) continue;
        const delta = right - left;
        const absolute = Math.abs(delta);
        if (maxChange === null || absolute > maxChange.absolute) {
          maxChange = { fromWindow: windows[i], toWindow: windows[j], delta, absolute };
        }
      }
    }
    return { channel, shareByWindow, maxChange };
  });

  const ranking = [...perChannel]
    .filter(entry => entry.maxChange !== null)
    .sort((left, right) => right.maxChange.absolute - left.maxChange.absolute
      || left.channel.localeCompare(right.channel, 'en'));

  return { windows, channels: perChannel, ranking };}

export function attribute(records, policy, { windows, iterations, seed } = {}) {
  const silenceWindows = (windows ?? policy.silenceWindows)
    .map(value => Number(value))
    .sort((left, right) => left - right);
  const base = {
    collapseConsecutive: policy.collapseConsecutive,
    removal: policy.removal
  };
  const windowResults = silenceWindows.map(silenceMinutes =>
    runAttribution(records, { ...base, silenceMinutes }));

  const primaryWindow = silenceWindows.includes(policy.silenceMinutes)
    ? policy.silenceMinutes
    : silenceWindows[0];
  const primary = windowResults.find(result => result.config.silenceMinutes === primaryWindow);

  const bootstrap = userBootstrap(records, { ...base, silenceMinutes: primaryWindow }, {
    iterations: iterations ?? policy.bootstrapIterations,
    seed: seed ?? policy.seed
  });

  const comparison = compareWindows(windowResults);

  return {
    method: 'first-order-markov-removal-attribution',
    scopeNotice: '本结果是路径描述性归因，用于预算讨论，不代表因果投放效果。',
    policy: {
      primaryWindow,
      silenceWindows,
      collapseConsecutive: policy.collapseConsecutive,
      removalRule: policy.removal,
      removalRuleDefinition: REMOVAL_RULES[policy.removal],
      bootstrapIterations: bootstrap.iterations,
      bootstrapSeed: bootstrap.seed
    },
    primary,
    windows: windowResults,
    bootstrap,
    windowComparison: comparison
  };
}
