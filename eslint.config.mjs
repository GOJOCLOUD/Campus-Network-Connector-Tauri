import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // 构建产物、研究脚本、算法侧源码都不参与 lint
  globalIgnores([
    'dist',
    'dist-core',
    'release',
    'release-core',
    'vendor',
    'tools',
    'packages',
    'apps',
    'tests',
    'node_modules',
    'mac-coregraphics',
    'downloads',
    'build',
  ]),
  {
    // 前端（React / Vite）
    files: ['src/**/*.{js,jsx}'],
    ignores: ['src/features/**/*.js'],
    plugins: { react },
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      // 组件名在 JSX 里使用（<motion.div />）时，核心规则认不出来，
      // 需要 react/jsx-uses-vars 才算"被使用"
      'react/jsx-uses-vars': 'error',
      // 挂载时拉一次数据 + 定时轮询的标准写法。refreshFeatures 是 async,
      // 里面的 setState 都发生在 await 之后(不是同步调用),规则看不穿 async 边界 → 误报。
      'react-hooks/set-state-in-effect': 'warn',
      'no-unused-vars': [
        'error',
        {
          varsIgnorePattern: '^[A-Z_]',
          caughtErrorsIgnorePattern: '^_',
          argsIgnorePattern: '^_',
        },
      ],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // 主进程 / 功能模块（CommonJS，Node 环境）
    files: ['src/features/**/*.js', 'main.js', 'preload.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.node },
      sourceType: 'commonjs',
    },
    rules: {
      'no-unused-vars': [
        'error',
        {
          varsIgnorePattern: '^[A-Z_]',
          caughtErrorsIgnorePattern: '^_',
          argsIgnorePattern: '^_',
        },
      ],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
])
