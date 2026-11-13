# channel-credit

weight 表示会话路径频次，minute 是会话内分钟。

项目目前提供本地记录校验、输入指纹和按 `channel` 的原始核算，并新增一套可解释的一阶 Markov 路径归因（`attribution`），用于预算讨论，不作为因果投放效果依据。分析人员可以保留完整输入并复查每次导出的 JSON；原始数据不被命令改写，旧的触达核算 `summary` 口径保持不变、不被归因结果替换。业务配置位于 `data/policy.json`，字段约定在 `docs/data.md`。

## 运行

使用 Node.js 22 LTS（>=22.22.1 且 <23）和 npm，无第三方运行依赖。
`.nvmrc` 选择 22 主版本，清单与锁文件记录相同的兼容范围；Dockerfile 仍固定基础镜像摘要，容器构建可精确复现。

```sh
npm ci --ignore-scripts --no-audit --no-fund --offline
npm run build
npm test
npm run summary
node src/cli.js inspect --input data/records.json
node src/cli.js summary --input data/records.json --out var/summary.json
node src/cli.js attribution \
  --input data/records.json --policy data/policy.json \
  --window 15 --window 30 --window 60 \
  --bootstrap 200 --seed 81 \
  --out var/attribution.json --report var/attribution.md
npm run demo
```

`attribution` 一次运行同时生成机器档案（JSON）和预算会可读的中文 Markdown 说明。档案包含路径频次、转移计数与行归一化矩阵、总体吸收概率、各渠道移除效应与归一贡献、按 user 整组重抽的稳定区间，以及多静默窗口的归因变化排名。移除规则为 `drop-to-null`：进入被移除渠道的概率质量全部改道到流失吸收态，不跳过触点、不重新归一化。负效应、全零效应和闭合非吸收子链都会如实标注，不会被硬改成合理比例。

`npm run demo` 在本地打印输入、现有核算、配置及归因结果，并生成 `var/summary.json`、`var/attribution.json` 与 `var/attribution.md`，不访问网络、不等待真实业务时间，通常几秒内完成。输出目录可删除后重新运行，测试只使用临时目录。

## 容器

```sh
docker build -t channel-credit:local .
docker run --rm --network none channel-credit:local
```

Dockerfile 固定 Node.js 基础镜像摘要，构建时执行语法检查和测试。镜像构建完成后演示无需联网；可覆盖命令运行 `npm test`。构建不需要真实账号、邮件服务、数据库或线上数据。

## 目录

- `src/dataset.js`：记录校验、规范序列化和数据指纹。
- `src/domain.js`：当前业务分组核算（触达口径，不产出归因）。
- `src/policy.js`：归因策略加载与严格校验。
- `src/markov.js`：路径构造、一阶转移模型、吸收概率、移除效应与归一化。
- `src/resample.js`：按 user 整组重抽的确定性 bootstrap 与分位数。
- `src/attribution.js`：多窗口归因编排与跨窗口变化排名。
- `src/report.js`：预算会中文 Markdown 说明渲染。
- `src/cli.js`：本地读取、检查和导出入口（summary / inspect / attribution）。
- `src/output.js`：以临时文件写入后替换完整 JSON 或纯文本。
- `test/`：输入约束、领域核对、Markov 手算、bootstrap、窗口对比、命令与输出回归。
- `data/`：合成记录、独立核对值及本地业务配置。
