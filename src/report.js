// 将 attribution 机器档案渲染为预算会可读的中文 Markdown 说明。
// 数字仅做展示层四舍五入，机器档案保留完整精度。

import { CONVERT, NULL, START } from './markov.js';

const stateName = state => {
  if (state === START) return '开始';
  if (state === CONVERT) return '转化';
  if (state === NULL) return '流失';
  return state;
};

const percent = value => (value === null || value === undefined ? '不适用' : `${(value * 100).toFixed(2)}%`);
const decimal = (value, digits = 4) => (value === null || value === undefined ? '不适用' : value.toFixed(digits));

const outcomeName = outcome => (outcome === CONVERT ? '转化' : '流失（含超时）');

export function renderReport(archive, { generatedAt, inputFingerprint, policyFingerprint }) {
  const lines = [];
  const { primary, policy, bootstrap, windowComparison } = archive;

  lines.push('# Markov 路径归因说明（预算讨论稿）');
  lines.push('');
  lines.push(`- 生成时间：${generatedAt}`);
  lines.push(`- 输入数据指纹：${inputFingerprint}`);
  lines.push(`- 策略配置指纹：${policyFingerprint}`);
  lines.push(`- 口径声明：${archive.scopeNotice}`);
  lines.push('');

  lines.push('## 一、建模规则');
  lines.push('');
  lines.push(`1. 路径以 user、session 和最大静默间隔构造：同一 user 按 session 与时间排序，session 变化或相邻触点间隔超过 **${policy.primaryWindow} 分钟** 即切断为新路径，被切断的旧路径计入流失终态。`);
  lines.push(`2. 连续同渠道${policy.collapseConsecutive ? '**折叠为一个触点**' : '**不折叠**'}；非连续的同渠道回访一律保留。转化与未转化路径都进入模型。`);
  lines.push('3. 频次权重表示相同路径出现次数，只在路径层累计一次，不会重复乘到每条边上。');
  lines.push('4. 模型为带开始态、转化吸收态、流失吸收态的一阶转移模型；转移矩阵按行归一化。');
  lines.push(`5. 移除规则（${policy.removalRule}）：${policy.removalRuleDefinition}`);
  lines.push('6. 负效应、全部效应为零、闭合非吸收子链均如实标注，不钳制、不平摊、不伪造合理比例。');
  lines.push('');

  lines.push('## 二、路径频次（主窗口）');
  lines.push('');
  lines.push(`- 去重后路径数：${primary.pathCount}；路径频次合计：${primary.totalFrequency}；其中转化路径频次：${primary.convertedFrequency}。`);
  lines.push('');
  lines.push('| 路径（渠道序列） | 结局 | 频次 |');
  lines.push('| --- | --- | --- |');
  for (const path of primary.paths) {
    const sequence = path.channels.length ? path.channels.join(' → ') : '（空路径）';
    lines.push(`| ${sequence} | ${outcomeName(path.outcome)} | ${decimal(path.frequency, 0)} |`);
  }
  lines.push('');
  if (primary.warnings.length) {
    lines.push('数据告警：');
    for (const warning of primary.warnings) lines.push(`- ${warning}`);
    lines.push('');
  }

  lines.push('## 三、一阶转移矩阵（行归一化，主窗口）');
  lines.push('');
  const stateOrder = [START, ...primary.channels];
  const destinationOrder = [...stateOrder, CONVERT, NULL];
  lines.push(`| 来源 \\ 去向 | ${destinationOrder.map(stateName).join(' | ')} |`);
  lines.push(`| --- | ${destinationOrder.map(() => '---').join(' | ')} |`);
  for (const state of stateOrder) {
    const row = primary.transitionMatrix[state];
    const cells = destinationOrder.map(destination => percent(row[destination]));
    lines.push(`| ${stateName(state)} | ${cells.join(' | ')} |`);
  }
  lines.push('');

  lines.push('## 四、总体吸收概率');
  lines.push('');
  lines.push(`- 从开始态出发，最终被**转化**吸收的概率：${percent(primary.absorption.convert)}`);
  lines.push(`- 从开始态出发，最终被**流失**吸收的概率：${percent(primary.absorption.churn)}`);
  lines.push(`- 两者之和：${percent(primary.absorption.convert + primary.absorption.churn)}（应为 100%）。`);
  lines.push('');

  lines.push('## 五、移除效应与归一贡献');
  lines.push('');
  lines.push('移除效应 = 基线转化吸收概率 − 移除该渠道后的转化吸收概率。下列“转入流失的概率质量”即移除时按规则改道到流失态的质量，未做任何跳过触点处理。');
  lines.push('');
  if (primary.normalization.contributions) {
    lines.push('| 渠道 | 移除后转化吸收概率 | 移除效应 | 归一化贡献 | 移除时转入流失的质量（按来源状态） |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const channel of primary.channels) {
      const removal = primary.removalEffects[channel];
      const redirected = Object.entries(removal.redirectedToNull)
        .map(([state, value]) => `${stateName(state)}→${stateName(channel)}：${decimal(value)}`).join('；') || '无进入质量';
      lines.push(`| ${channel} | ${percent(removal.absorptionAfterRemoval)} | ${decimal(removal.effect)} | ${percent(primary.normalization.contributions[channel])} | ${redirected} |`);
    }
    lines.push('');
    lines.push(`归一化贡献合计：${percent(primary.channels.reduce((sum, channel) =>
      sum + primary.normalization.contributions[channel], 0))}；效应总和：${decimal(primary.normalization.totalEffect)}。`);
    const negatives = primary.channels.filter(channel => primary.removalEffects[channel].effect < 0);
    if (negatives.length) {
      lines.push('');
      lines.push(`**注意：存在负效应渠道（${negatives.join('、')}），系统保留负号未做钳制，预算讨论时应解释其含义而非改成零或正数。**`);
    }
  } else {
    lines.push(`**本配置无法给出归一化贡献，原因代码：${primary.normalization.reason}。各渠道原始移除效应如下，未被硬改成合理比例：**`);
    lines.push('');
    lines.push('| 渠道 | 移除效应 | 移除时转入流失的质量（按来源状态） |');
    lines.push('| --- | --- | --- |');
    for (const channel of primary.channels) {
      const removal = primary.removalEffects[channel];
      const redirected = Object.entries(removal.redirectedToNull)
        .map(([state, value]) => `${stateName(state)}→${stateName(channel)}：${decimal(value)}`).join('；') || '无进入质量';
      lines.push(`| ${channel} | ${decimal(removal.effect)} | ${redirected} |`);
    }
  }
  lines.push('');

  lines.push('## 六、贡献稳定区间（按 user 整组重抽）');
  lines.push('');
  lines.push(`重抽单位为**整个 user**（该用户全部路径一起抽中或排除），不拆分路径、不独立抽样边。共 ${bootstrap.iterations} 次，有效 ${bootstrap.validIterations} 次，种子 ${bootstrap.seed}。`);
  if (bootstrap.failedIterations.length) {
    lines.push(`其中 ${bootstrap.failedIterations.length} 次因闭合非吸收子链无定义而剔除，未用伪造值填补。`);
  }
  lines.push('');
  lines.push('| 渠道 | 贡献 P5 | 贡献中位数 | 贡献 P95 | 效应 P5 | 效应 P95 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const channel of primary.channels) {
    const entry = bootstrap.channels[channel];
    const share = entry.share;
    lines.push(`| ${channel} | ${share ? percent(share.p5) : '不适用'} | ${share ? percent(share.median) : '不适用'} | ${share ? percent(share.p95) : '不适用'} | ${decimal(entry.effect.p5)} | ${decimal(entry.effect.p95)} |`);
  }
  lines.push('');

  lines.push('## 七、不同静默窗口对比');
  lines.push('');
  lines.push(`对比窗口（分钟）：${windowComparison.windows.join('、')}。每个窗口都重新切分路径并重建模型，不复用旧矩阵。`);
  lines.push('');
  lines.push('| 渠道 | 各窗口归一化贡献 | 最大变化（窗口对） | 变化幅度 |');
  lines.push('| --- | --- | --- | --- |');
  for (const entry of windowComparison.channels) {
    const shares = windowComparison.windows.map(silence =>
      `${silence} 分钟：${percent(entry.shareByWindow[String(silence)])}`).join('；');
    const change = entry.maxChange
      ? `${entry.maxChange.fromWindow}→${entry.maxChange.toWindow}（${entry.maxChange.delta >= 0 ? '+' : ''}${decimal(entry.maxChange.delta)}）`
      : '不适用';
    const magnitude = entry.maxChange ? decimal(entry.maxChange.absolute) : '不适用';
    lines.push(`| ${entry.channel} | ${shares} | ${change} | ${magnitude} |`);
  }
  lines.push('');
  if (windowComparison.ranking.length && windowComparison.ranking[0].maxChange.absolute > 0) {
    const top = windowComparison.ranking[0];
    lines.push(`**归因变化最大的渠道：${top.channel}，在 ${top.maxChange.fromWindow} 分钟与 ${top.maxChange.toWindow} 分钟窗口之间贡献变化 ${decimal(top.maxChange.delta)}（绝对幅度 ${decimal(top.maxChange.absolute)}）。**`);
  } else {
    lines.push('**各静默窗口下归一化贡献完全一致，没有渠道发生归因变化；若需观察窗口敏感性，请加入会触发路径切断的更短窗口。**');
  }
  lines.push('');
  return lines.join('\n');
}
