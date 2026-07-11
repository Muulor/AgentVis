import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  // 路径别名配置（与 vite.config.ts 保持一致）
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@components': path.resolve(__dirname, './src/components'),
      '@stores': path.resolve(__dirname, './src/stores'),
      '@services': path.resolve(__dirname, './src/services'),
      '@types': path.resolve(__dirname, './src/types'),
      '@hooks': path.resolve(__dirname, './src/hooks'),
      '@utils': path.resolve(__dirname, './src/utils'),
      '@styles': path.resolve(__dirname, './src/styles'),
    },
  },

  test: {
    // 测试文件匹配模式
    include: ['src/**/*.{test,spec}.{js,ts,tsx}'],

    // 排除目录
    exclude: ['node_modules', 'dist', 'src-tauri'],

    // 测试环境
    environment: 'node',

    // 覆盖率配置
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/services/planning/**/*.ts'],
      exclude: ['**/__tests__/**', '**/*.test.ts', '**/index.ts'],
    },

    // 全局 API（describe, it, expect 等）
    globals: true,
  },
});
