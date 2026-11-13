import { readFile } from 'node:fs/promises';
import { fingerprint } from './dataset.js';

export const REMOVAL_RULES = {
  'drop-to-null': '移除渠道后，所有进入该渠道的概率质量直接计入流失（NULL）吸收态；不跳过该触点，也不把质量重新分配给其他渠道或转化态。'
};

const mustBe = (value, predicate, label) => {
  if (!predicate(value)) throw new Error(`${label} 配置值不合法`);
};

export function validatePolicy(policy) {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('策略文件必须是配置对象');
  }
  mustBe(policy.silenceMinutes, value => Number.isSafeInteger(value) && value > 0, 'silenceMinutes');
  mustBe(policy.collapseConsecutive, value => typeof value === 'boolean', 'collapseConsecutive');
  mustBe(policy.removal, value => typeof value === 'string' && Object.hasOwn(REMOVAL_RULES, value), 'removal');
  mustBe(policy.bootstrapIterations, value => Number.isSafeInteger(value) && value > 0, 'bootstrapIterations');
  mustBe(policy.seed, value => Number.isSafeInteger(value), 'seed');
  const windows = policy.silenceWindows;
  mustBe(windows, value => Array.isArray(value)
    && value.length > 0 && new Set(value).size === value.length
    && value.every(item => Number.isSafeInteger(item) && item > 0), 'silenceWindows');
  return policy;
}

export async function loadPolicy(path, overrides = {}) {
  const document = JSON.parse(await readFile(path, 'utf8'));
  const merged = {
    silenceWindows: [document.silenceMinutes],
    ...document,
    ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined))
  };
  validatePolicy(merged);
  return { policy: merged, fingerprint: fingerprint(merged) };
}
