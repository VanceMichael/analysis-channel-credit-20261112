// 一阶 Markov 路径归因核心：路径构造、转移模型、吸收概率、移除效应与归一化。
// 所有计算仅使用路径频次（weight），每条边的频次只计数一次，不按触点重复相乘。

export const START = '##START##';   // 开始态（瞬态）
export const CONVERT = '##CONVERT##'; // 转化吸收态
export const NULL = '##NULL##';     // 流失吸收态（含超时未转化）
const RESERVED = new Set([START, CONVERT, NULL]);
const EPSILON = 1e-12;

export function assertChannelNames(records) {
  for (const record of records) {
    if (RESERVED.has(record.channel)) {
      throw new Error(`渠道名 ${record.channel} 与保留状态名冲突，请更换数据中的渠道标签`);
    }
    if (!(typeof record.weight === 'number' && Number.isFinite(record.weight) && record.weight > 0)) {
      throw new Error(`记录 ${record.id} 的 weight 必须为正数，零或负数不能作为路径频次`);
    }
  }
}

/**
 * 以 user、session 和最大静默间隔构造路径。
 * - 同一 user 内按 (session, minute, id) 稳定排序；
 * - session 变化，或同 session 内相邻触点间隔超过 silenceMinutes，都开启新路径；
 * - 被静默间隔切断的旧路径以 NULL（超时未转化）收尾；
 * - collapseConsecutive 为真时折叠连续同渠道，非连续回访保留；
 * - 路径频次取该路径记录的 weight，要求同一路径内 weight 一致；
 * - 路径结局由最后一条记录的 converted 决定：true -> CONVERT，否则 -> NULL。
 */
export function buildPaths(records, { silenceMinutes, collapseConsecutive }) {
  assertChannelNames(records);
  const byUser = new Map();
  for (const record of records) {
    if (!byUser.has(record.user)) byUser.set(record.user, []);
    byUser.get(record.user).push(record);
  }

  const paths = [];
  const warnings = [];
  for (const [user, members] of byUser) {
    const ordered = [...members].sort((left, right) => {
      if (left.session !== right.session) return left.session.localeCompare(right.session, 'en');
      if (left.minute !== right.minute) return left.minute - right.minute;
      return left.id.localeCompare(right.id, 'en');
    });

    let current = [];
    let previous;
    const flush = outcomeRecord => {
      if (current.length === 0) return;
      const frequency = current[0].weight;
      if (current.some(record => record.weight !== frequency)) {
        throw new Error(`user ${user} 的一条路径内 weight 不一致，无法确定路径频次`);
      }
      const channels = collapseConsecutive
        ? current.reduce((acc, record) => {
            if (acc.length === 0 || acc[acc.length - 1] !== record.channel) acc.push(record.channel);
            return acc;
          }, [])
        : current.map(record => record.channel);
      if (current.some((record, index) => index < current.length - 1 && record.converted)) {
        warnings.push(`user ${user} 的路径存在非末尾触点 converted=true，结局仍以最后一条记录为准`);
      }
      paths.push({
        user,
        channels,
        outcome: outcomeRecord.converted ? CONVERT : NULL,
        frequency
      });
      current = [];
    };

    for (const record of ordered) {
      if (previous !== undefined) {
        const newSession = record.session !== previous.session;
        const timedOut = record.minute - previous.minute > silenceMinutes;
        if (newSession || timedOut) flush(previous);
      }
      current.push(record);
      previous = record;
    }
    if (previous) flush(previous);
  }
  return { paths, warnings };
}

/** 相同渠道序列与相同结局的路径合并，频次相加；频次只在此处累计一次。 */
export function aggregatePathFrequencies(paths) {
  const table = new Map();
  for (const path of paths) {
    const key = `${path.channels.join('>')}|${path.outcome}`;
    const existing = table.get(key);
    if (existing) existing.frequency += path.frequency;
    else table.set(key, { channels: [...path.channels], outcome: path.outcome, frequency: path.frequency });
  }
  return [...table.values()].sort((left, right) => {
    const keyOf = path => `${path.channels.join('>')}|${path.outcome}`;
    return keyOf(left).localeCompare(keyOf(right), 'en');
  });
}

/**
 * 由路径频次构造一阶转移计数与行归一化转移矩阵。
 * 每条路径贡献 START -> 首渠道、渠道之间、末渠道 -> 吸收态的边，边计数加 path.frequency。
 */
export function buildTransitionModel(pathTable) {
  const channelSet = new Set();
  for (const path of pathTable) for (const channel of path.channels) channelSet.add(channel);
  const channels = [...channelSet].sort((left, right) => left.localeCompare(right, 'en'));
  const states = [START, ...channels];
  const destinations = [...states, CONVERT, NULL];

  const counts = new Map(states.map(state => [state, new Map()]));
  const addCount = (from, to, weight) => {
    counts.get(from).set(to, (counts.get(from).get(to) ?? 0) + weight);
  };

  for (const path of pathTable) {
    const sequence = [START, ...path.channels, path.outcome];
    for (let index = 0; index < sequence.length - 1; index += 1) {
      addCount(sequence[index], sequence[index + 1], path.frequency);
    }
  }

  const matrix = {};
  const rowCounts = {};
  for (const state of states) {
    const row = counts.get(state);
    const total = [...row.values()].reduce((sum, value) => sum + value, 0);
    rowCounts[state] = total;
    matrix[state] = {};
    for (const destination of destinations) {
      const value = row.get(destination) ?? 0;
      matrix[state][destination] = total === 0 ? 0 : value / total;
    }
  }
  return { channels, states, destinations, counts, rowCounts, matrix };
}

/** 解线性方程 (I - Q) x = r，部分主元高斯消元；矩阵奇异表示存在闭合非吸收子链。 */
export function solveAbsorption(Q, r) {
  const n = Q.length;
  const augmented = Q.map((row, index) => row.map((value, column) =>
    (index === column ? 1 : 0) - value).concat(r[index]));

  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < n; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) <= EPSILON) {
      throw new ClosedChainError('检测到闭合非吸收子链：I-Q 不可逆，吸收概率无定义，拒绝输出伪造的归因比例');
    }
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    for (let row = 0; row < n; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column] / augmented[column][column];
      for (let entry = column; entry <= n; entry += 1) {
        augmented[row][entry] -= factor * augmented[column][entry];
      }
    }
  }
  return augmented.map((row, index) => row[n] / augmented[index][index]);}

export class ClosedChainError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ClosedChainError';
  }
}

/** 从瞬态状态列表计算从 START 出发进入 CONVERT / NULL 的总体吸收概率。 */
export function absorptionProbabilities(model) {
  const { states, matrix } = model;
  const Q = states.map(from => states.map(to => matrix[from][to] ?? 0));
  const rConvert = states.map(state => matrix[state][CONVERT] ?? 0);
  const rNull = states.map(state => matrix[state][NULL] ?? 0);
  const convert = solveAbsorption(Q, rConvert);
  const churn = solveAbsorption(Q, rNull);
  const startIndex = states.indexOf(START);
  return {
    convert: convert[startIndex],
    churn: churn[startIndex],
    byState: Object.fromEntries(states.map((state, index) => [state, {
      convert: convert[index],
      churn: churn[index]
    }]))
  };
}

/**
 * drop-to-null 移除规则：
 * 移除渠道 removed 时，该渠道变为等价于流失（NULL）的吸收态——其全部出边（含自环）
 * 改道到 NULL；其他状态进入该渠道的概率质量同样改道到 NULL。
 * 其余状态的转移概率保持原值，不重新归一化（不跳过触点、不转嫁给其他渠道或转化态）。
 */
export function removalModel(model, removed) {
  const { states, matrix } = model;
  const redirected = {};
  const next = Object.fromEntries(states.map(state => [state, { ...matrix[state] }]));
  for (const state of states) {
    if (state === removed) continue;
    const incoming = matrix[state][removed] ?? 0;
    if (incoming > 0) {
      redirected[state] = incoming;
      next[state][removed] = 0;
      next[state][NULL] = (next[state][NULL] ?? 0) + incoming;
    }
  }
  // 被移除渠道自身成为流失吸收态：所有出边（含自环）归入 NULL，避免残留质量被困成非吸收死状态
  for (const destination of [...states, CONVERT, NULL]) {
    if (destination !== NULL) next[removed][destination] = 0;
  }
  next[removed][NULL] = 1;
  return { matrix: next, redirectedMass: redirected };
}

/** 归一化：保留负效应符号，不做任何钳制；总和不严格为正时拒绝给出比例。 */
export function normalizeEffects(effects, channels) {
  const total = channels.reduce((sum, channel) => sum + effects[channel], 0);
  if (!(total > EPSILON)) {
    return {
      totalEffect: total,
      contributions: null,
      reason: total === 0 || Math.abs(total) <= EPSILON
        ? 'all-zero-effects'
        : 'non-positive-effect-sum'
    };
  }
  return {
    totalEffect: total,
    contributions: Object.fromEntries(channels.map(channel => [channel, effects[channel] / total])),
    reason: null
  };
}

/** 单个静默窗口下的完整归因流水线。 */
export function runAttribution(records, config) {
  const { paths, warnings } = buildPaths(records, config);
  const pathTable = aggregatePathFrequencies(paths);
  const model = buildTransitionModel(pathTable);
  const baseline = absorptionProbabilities(model);

  const effects = {};
  const removals = {};
  for (const channel of model.channels) {
    const removed = removalModel(model, channel);
    const after = absorptionProbabilities({ ...model, matrix: removed.matrix });
    effects[channel] = baseline.convert - after.convert;
    removals[channel] = {
      absorptionAfterRemoval: after.convert,
      effect: effects[channel],
      redirectedToNull: removed.redirectedMass
    };
  }
  const normalized = normalizeEffects(effects, model.channels);

  return {
    config: {
      silenceMinutes: config.silenceMinutes,
      collapseConsecutive: config.collapseConsecutive,
      removalRule: config.removal
    },
    paths: pathTable,
    pathCount: pathTable.length,
    totalFrequency: pathTable.reduce((sum, path) => sum + path.frequency, 0),
    convertedFrequency: pathTable
      .filter(path => path.outcome === CONVERT).reduce((sum, path) => sum + path.frequency, 0),
    channels: model.channels,
    transitionMatrix: model.matrix,
    transitionCounts: Object.fromEntries(model.states.map(state =>
      [state, Object.fromEntries(model.counts.get(state))])),
    absorption: baseline,
    removalEffects: removals,
    normalization: normalized,
    warnings
  };
}
