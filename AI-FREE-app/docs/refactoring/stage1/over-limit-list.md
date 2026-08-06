# 超限存量清单（阶段 1 渐进门禁）

生成：`node scripts/check-guardrails.js --update`（2026-07-19）。
最终结构债务已清零；后续任何超限都会直接超过零基线并阻塞门禁。

当前基线：eslint errors=0，>500 行文件=0，>80 行函数=0 处，复杂度>15=0 处，tsc checkJs errors=0

## 超过 500 行的自有源码文件
