import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],

  // 强制预构建飞书 SDK：其 ESM 产物内嵌了 CJS require() 调用（protobufjs 生成代码），
  // 需要 esbuild 在预构建阶段将其转为纯 ESM，否则打包后 require is not defined
  optimizeDeps: {
    include: ['@larksuiteoapi/node-sdk'],
  },

  // 路径别名配置（与 tsconfig.json 保持一致）
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
      // Node.js 内置模块 polyfill（飞书 SDK 依赖 querystring 和 ws）
      querystring: path.resolve(__dirname, './src/shims/querystring.ts'),
      ws: path.resolve(__dirname, './src/shims/ws.ts'),
    },
  },

  // 防止 Vite 清除 Rust 日志
  clearScreen: false,

  // Tauri 开发服务器配置
  server: {
    host: '127.0.0.1', // 显式绑定到 IPv4，确保 Tauri 可连接
    port: 1420,
    strictPort: true,
    watch: {
      // 告诉 Vite 忽略监视 src-tauri
      ignored: ['**/src-tauri/**'],
    },
  },

  // 构建配置
  build: {
    // Tauri 在 Windows 上使用 Chromium，在 macOS 和 Linux 上使用 WebKit
    target: process.env.TAURI_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    // 调试时不压缩
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    // 调试时生成 sourcemap
    sourcemap: !!process.env.TAURI_DEBUG,
    // 对混用 CJS+ESM 的模块执行 CommonJS 转换
    // 飞书 SDK 的 es/index.js 使用了 ESM export 但内嵌了 require()（protobuf 生成代码）
    // transformMixedEsModules 让 @rollup/plugin-commonjs 处理这类混合模块，消除裸 require()
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },
});
