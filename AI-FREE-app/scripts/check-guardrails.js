#!/usr/bin/env node
// 阶段 1 渐进式门禁：ESLint 尺寸/复杂度/正确性 + tsc checkJs 错误计数，
// 与提交在库的基线（scripts/guardrail-baseline.json）对比：
//   - 任一计数超过基线 → 退出码 1（新增代码扩大了超限范围）
//   - 计数下降 → 提示用 --update 收紧基线
//   - --update：把当前计数写入基线，并重新生成超限存量清单
//     docs/refactoring/stage1/over-limit-list.md
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const baselinePath = path.join(__dirname, 'guardrail-baseline.json');
const overLimitDocPath = path.join(root, 'docs', 'refactoring', 'stage1', 'over-limit-list.md');
const updateMode = process.argv.includes('--update');
const eslintCli = path.resolve(path.dirname(require.resolve('eslint')), '..', 'bin', 'eslint.js');
const tscCli = path.resolve(path.dirname(require.resolve('typescript')), '..', 'bin', 'tsc');

function runEslint() {
  let raw;
  try {
    raw = execFileSync(process.execPath, [eslintCli, '.', '--format', 'json'], {
      cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    // eslint 有 error 级问题时退出码非 0，但 stdout 仍是完整 JSON
    raw = error.stdout;
    if (!raw) throw error;
  }
  const results = JSON.parse(raw);
  const counts = { eslintErrors: 0, maxLines: 0, maxLinesPerFunction: 0, complexity: 0 };
  const overLimitFiles = new Map();
  for (const file of results) {
    for (const msg of file.messages) {
      if (msg.severity === 2) counts.eslintErrors += 1;
      else if (msg.ruleId === 'max-lines') {
        counts.maxLines += 1;
        overLimitFiles.set(path.relative(root, file.filePath).replace(/\\/g, '/'), msg.message);
      } else if (msg.ruleId === 'max-lines-per-function') counts.maxLinesPerFunction += 1;
      else if (msg.ruleId === 'complexity') counts.complexity += 1;
    }
  }
  return { counts, overLimitFiles };
}

function runTsc() {
  try {
    execFileSync(process.execPath, [tscCli, '--noEmit', '--pretty', 'false'], {
      cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    return 0;
  } catch (error) {
    const out = String(error.stdout || '');
    return out.split(/\r?\n/).filter((line) => /error TS\d+:/.test(line)).length;
  }
}

function main() {
  const { counts, overLimitFiles } = runEslint();
  counts.tscErrors = runTsc();

  if (updateMode) {
    fs.writeFileSync(baselinePath, JSON.stringify(counts, null, 2) + '\n');
    const lines = [
      '# 超限存量清单（阶段 1 渐进门禁）',
      '',
      `生成：\`node scripts/check-guardrails.js --update\`（${new Date().toISOString().slice(0, 10)}）。`,
      counts.maxLines === 0 && counts.maxLinesPerFunction === 0 && counts.complexity === 0
        ? '最终结构债务已清零；后续任何超限都会直接超过零基线并阻塞门禁。'
        : '存量不阻塞提交，但新增代码不得让任何计数超过基线；每整改一个文件后重新 --update 收紧基线。',
      '',
      `当前基线：eslint errors=${counts.eslintErrors}，>500 行文件=${counts.maxLines}，>80 行函数=${counts.maxLinesPerFunction} 处，复杂度>15=${counts.complexity} 处，tsc checkJs errors=${counts.tscErrors}`,
      '',
      '## 超过 500 行的自有源码文件',
      '',
      ...[...overLimitFiles.entries()].sort().map(([file, msg]) => `- \`${file}\` — ${msg}`),
    ];
    fs.mkdirSync(path.dirname(overLimitDocPath), { recursive: true });
    fs.writeFileSync(overLimitDocPath, lines.join('\n'));
    console.log('[guardrails] 基线已更新:', JSON.stringify(counts));
    return;
  }

  if (!fs.existsSync(baselinePath)) {
    console.error('[guardrails] 缺少基线文件，先运行: node scripts/check-guardrails.js --update');
    process.exit(1);
  }
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const regressions = [];
  const improvements = [];
  for (const key of Object.keys(counts)) {
    const base = baseline[key] ?? 0;
    if (counts[key] > base) regressions.push(`${key}: ${base} → ${counts[key]}`);
    else if (counts[key] < base) improvements.push(`${key}: ${base} → ${counts[key]}`);
  }
  if (regressions.length) {
    console.error('[guardrails] 失败——以下计数超过基线（新增代码扩大了超限范围）:');
    for (const r of regressions) console.error('  ' + r);
    process.exit(1);
  }
  if (improvements.length) {
    console.log('[guardrails] 通过。计数已下降，建议收紧基线（--update）:', improvements.join('; '));
  } else {
    console.log('[guardrails] 通过。', JSON.stringify(counts));
  }
}

main();
