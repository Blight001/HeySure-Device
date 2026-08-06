// 阶段 1 工程护栏（渐进式门禁）：
// - 尺寸/复杂度规则设为 warn，由 scripts/check-guardrails.js 与基线对比，
//   存量不阻塞、新增超限即失败（方案 §5 阶段1：新增代码不得扩大超限范围）。
// - 正确性规则设为 error（当前代码已通过）。
// - 第三方扩展资产（remove_watermark/transform 等）明确排除，禁止格式化或整改。
'use strict';

const sizeGates = {
  'max-lines': ['warn', { max: 500, skipBlankLines: true, skipComments: true }],
  'max-lines-per-function': ['warn', { max: 80, skipBlankLines: true, skipComments: true }],
  complexity: ['warn', { max: 15 }],
};

const correctness = {
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-unreachable': 'error',
  'no-compare-neg-zero': 'error',
  'no-cond-assign': ['error', 'except-parens'],
  'no-const-assign': 'error',
  'no-dupe-else-if': 'error',
  'no-duplicate-case': 'error',
  'no-self-assign': 'error',
  'no-sparse-arrays': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
};

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'appbuild/**',
      '.generated/**',
      'resources/**',
      'native/**',
      'core/**',
      // 第三方扩展资产：禁止 lint/格式化/结构调整（方案 §2）
      'src/assets/extensions/remove_watermark/**',
      'src/assets/extensions/transform/**',
      'src/assets/extensions/**/vendor/**',
    ],
  },
  {
   files: ['src/app/main/**/*.js', 'scripts/**/*.js', 'test/**/*.js', 'src/app/shared/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
    },
    rules: { ...correctness, ...sizeGates, 'no-undef': 'off' },
  },
  {
    // 生产代码使用尺寸门禁；验收测试可按场景保留较长的夹具与断言序列。
    files: ['test/**/*.js'],
    rules: {
      'max-lines': 'off',
      'max-lines-per-function': 'off',
      complexity: 'off',
    },
  },
  {
    // composition root 与装配模块是声明式接线：函数行数由依赖数量决定而非
    // 逻辑复杂度，豁免 max-lines-per-function；文件总行数与复杂度门禁仍生效。
    files: ['src/app/main/bootstrap.js', 'src/app/main/composition/**/*.js'],
    rules: { 'max-lines-per-function': 'off' },
  },
  {
    // 渲染层/侧边栏/扩展：浏览器脚本，禁止 Node require（依赖边界初版）
    files: ['src/app/renderer/**/*.js', 'src/app/sidebar/**/*.js', 'src/app/views/**/*.js', 'src/assets/extensions/browser_automation/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
    },
    rules: {
      ...correctness,
      ...sizeGates,
      'no-undef': 'off',
      'no-restricted-globals': ['error', { name: 'require', message: '渲染层不得使用 Node require，依赖走 preload 契约。' }],
    },
  },
  {
    // browser_automation 的 popup 模块是 ES modules
    files: ['src/assets/extensions/browser_automation/popup/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      ...correctness,
      ...sizeGates,
      'no-undef': 'off',
      'no-restricted-globals': ['error', { name: 'require', message: '渲染层不得使用 Node require，依赖走 preload 契约。' }],
    },
  },
];
