/**
 * TemplateManager - 预览模板缓存管理器
 *
 * 管理 {appData}/preview-templates/ 目录下的模板缓存。
 * 每个模板包含 package.json 和关联的配置文件，node_modules 在首次使用时
 * 通过 npm install 安装一次，后续所有 Agent 项目通过 junction 共享。
 *
 * 职责：
 * 1. 持有各模板的配置定义（P0: vanilla，P1: react-tailwind）
 * 2. 检查模板 node_modules 是否已安装
 * 3. 首次使用时写入配置文件并执行 npm install
 * 4. 提供模板路径和配置查询接口
 */

import { invoke } from '@tauri-apps/api/core';
import { getLogger } from '@services/logger';
import type { TemplateId, TemplateConfig, TemplateStatus } from './types';

const logger = getLogger('TemplateManager');

// ==================== 模板定义 ====================

/**
 * 获取 vanilla 模板配置
 *
 * 最简模板：仅 Vite，支持纯 HTML/CSS/JS 多文件项目。
 * P0 阶段首先实现此模板验证端到端流程。
 */
function getVanillaTemplate(): TemplateConfig {
    return {
        id: 'vanilla',
        displayName: 'Vanilla (HTML/CSS/JS)',
        dependencies: {},
        devDependencies: {
            'vite': '^6.2.0',
        },
        configFiles: {
            'vite.config.js': [
                'import { defineConfig } from "vite";',
                '',
                'export default defineConfig({',
                '  server: {',
                '    hmr: true,',
                '    // Agent-generated CSS may reference parent-directory assets via url("../image.jpg").',
                '    // Disable Vite fs strict mode so files outside the project root can be served.',
                '    fs: { strict: false },',
                '  },',
                '});',
            ].join('\n'),
        },
        entryFiles: {
            'index.html': [
                '<!DOCTYPE html>',
                '<html lang="en">',
                '<head>',
                '  <meta charset="UTF-8" />',
                '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
                '  <title>Preview</title>',
                '</head>',
                '<body>',
                '  <div id="app"></div>',
                '  <script type="module" src="/src/main.js"></script>',
                '</body>',
                '</html>',
            ].join('\n'),
            'src/main.js': [
                '// Preview entry file',
                'console.log("Preview loaded");',
            ].join('\n'),
        },
    };
}

/**
 * React + Tailwind v3 template
 *
 * LLM (GPT/Claude/Gemini) generate Tailwind v3 syntax (@tailwind directives + @apply).
 * Use classic PostCSS + tailwindcss setup for maximum compatibility.
 */
function getReactTailwindTemplate(): TemplateConfig {
    return {
        id: 'react-tailwind',
        displayName: 'React + Tailwind',
        dependencies: {
            'react': '^18.3.1',
            'react-dom': '^18.3.1',
        },
        devDependencies: {
            'vite': '^6.2.0',
            '@vitejs/plugin-react': '^4.3.4',
            'tailwindcss': '^3.4.17',
            'postcss': '^8.5.3',
            'postcss-import': '^16.1.0',
            'autoprefixer': '^10.4.21',
        },
        configFiles: {
            'vite.config.js': [
                'import { defineConfig } from "vite";',
                'import react from "@vitejs/plugin-react";',
                '',
                'export default defineConfig({',
                '  plugins: [react()],',
                '  server: {',
                '    hmr: true,',
                '    fs: { strict: false },',
                '  },',
                '});',
            ].join('\n'),
            'tailwind.config.js': [
                '/** @type {import("tailwindcss").Config} */',
                'export default {',
                '  content: [',
                '    "./index.html",',
                '    "./src/**/*.{js,ts,jsx,tsx}",',
                '  ],',
                '  theme: {',
                '    extend: {},',
                '  },',
                '  plugins: [],',
                '};',
            ].join('\n'),
            'postcss.config.js': [
                '// postcss-import must run before tailwindcss, otherwise @tailwind directives may be parsed as CSS imports',
                'export default {',
                '  plugins: {',
                '    "postcss-import": {},',
                '    tailwindcss: {},',
                '    autoprefixer: {},',
                '  },',
                '};',
            ].join('\n'),
        },
        entryFiles: {
            'index.html': [
                '<!DOCTYPE html>',
                '<html lang="en">',
                '<head>',
                '  <meta charset="UTF-8" />',
                '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
                '  <title>Preview</title>',
                '</head>',
                '<body>',
                '  <div id="root"></div>',
                '  <script type="module" src="/src/main.jsx"></script>',
                '</body>',
                '</html>',
            ].join('\n'),
            'src/main.jsx': [
                'import React from "react";',
                'import ReactDOM from "react-dom/client";',
                'import App from "./App";',
                'import "./index.css";',
                '',
                'ReactDOM.createRoot(document.getElementById("root")).render(',
                '  <React.StrictMode>',
                '    <App />',
                '  </React.StrictMode>',
                ');',
            ].join('\n'),
            'src/App.jsx': [
                'export default function App() {',
                '  return (',
                '    <div className="min-h-screen flex items-center justify-center bg-gray-100">',
                '      <h1 className="text-3xl font-bold text-blue-600">Hello Preview</h1>',
                '    </div>',
                '  );',
                '}',
            ].join('\n'),
            'src/index.css': [
                '@tailwind base;',
                '@tailwind components;',
                '@tailwind utilities;',
            ].join('\n'),
        },
    };
}

/**
 * Vue 3 + Tailwind v3 template
 *
 * Vue SFC (.vue) + Tailwind CSS v3 + PostCSS + @vitejs/plugin-vue。
 * LLM 生成的 Vue 代码通常使用 Composition API + <script setup> 语法。
 */
function getVueTailwindTemplate(): TemplateConfig {
    return {
        id: 'vue-tailwind',
        displayName: 'Vue + Tailwind',
        dependencies: {
            'vue': '^3.5.13',
        },
        devDependencies: {
            'vite': '^6.2.0',
            '@vitejs/plugin-vue': '^5.2.3',
            'tailwindcss': '^3.4.17',
            'postcss': '^8.5.3',
            'postcss-import': '^16.1.0',
            'autoprefixer': '^10.4.21',
        },
        configFiles: {
            'vite.config.js': [
                'import { defineConfig } from "vite";',
                'import vue from "@vitejs/plugin-vue";',
                '',
                'export default defineConfig({',
                '  plugins: [vue()],',
                '  server: {',
                '    hmr: true,',
                '    fs: { strict: false },',
                '  },',
                '});',
            ].join('\n'),
            'tailwind.config.js': [
                '/** @type {import("tailwindcss").Config} */',
                'export default {',
                '  content: [',
                '    "./index.html",',
                '    "./src/**/*.{vue,js,ts,jsx,tsx}",',
                '  ],',
                '  theme: {',
                '    extend: {},',
                '  },',
                '  plugins: [],',
                '};',
            ].join('\n'),
            'postcss.config.js': [
                '// postcss-import must run before tailwindcss, otherwise @tailwind directives may be parsed as CSS imports',
                'export default {',
                '  plugins: {',
                '    "postcss-import": {},',
                '    tailwindcss: {},',
                '    autoprefixer: {},',
                '  },',
                '};',
            ].join('\n'),
        },
        entryFiles: {
            'index.html': [
                '<!DOCTYPE html>',
                '<html lang="en">',
                '<head>',
                '  <meta charset="UTF-8" />',
                '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
                '  <title>Preview</title>',
                '</head>',
                '<body>',
                '  <div id="app"></div>',
                '  <script type="module" src="/src/main.js"></script>',
                '</body>',
                '</html>',
            ].join('\n'),
            'src/main.js': [
                'import { createApp } from "vue";',
                'import App from "./App.vue";',
                'import "./index.css";',
                '',
                'createApp(App).mount("#app");',
            ].join('\n'),
            'src/App.vue': [
                '<script setup>',
                '// App component',
                '</script>',
                '',
                '<template>',
                '  <div class="min-h-screen flex items-center justify-center bg-gray-100">',
                '    <h1 class="text-3xl font-bold text-green-600">Hello Vue Preview</h1>',
                '  </div>',
                '</template>',
            ].join('\n'),
            'src/index.css': [
                '@tailwind base;',
                '@tailwind components;',
                '@tailwind utilities;',
            ].join('\n'),
        },
    };
}

/** 所有模板配置注册表 */
const TEMPLATE_REGISTRY: Record<TemplateId, () => TemplateConfig> = {
    'vanilla': getVanillaTemplate,
    'react-tailwind': getReactTailwindTemplate,
    // P2 阶段添加
    'vue-tailwind': getVueTailwindTemplate,
};

// ==================== TemplateManager 类 ====================

class TemplateManager {
    /** 模板缓存根目录（延迟初始化） */
    private templatesRoot: string | null = null;

    /**
     * 获取模板缓存根目录
     *
     * 路径：{appData}/preview-templates/
     * 延迟初始化，首次调用时解析 appDataDir
     */
    private async getTemplatesRoot(): Promise<string> {
        if (this.templatesRoot) {
            return this.templatesRoot;
        }

        const { appDataDir, join } = await import('@tauri-apps/api/path');
        const appData = await appDataDir();
        this.templatesRoot = await join(appData, 'preview-templates');

        return this.templatesRoot;
    }

    /**
     * 获取指定模板的缓存目录路径
     */
    async getTemplatePath(templateId: TemplateId): Promise<string> {
        const root = await this.getTemplatesRoot();
        const { join } = await import('@tauri-apps/api/path');
        return join(root, templateId);
    }

    /**
     * 获取模板配置
     *
     * @throws 当模板 ID 未注册时抛出异常
     */
    getTemplateConfig(templateId: TemplateId): TemplateConfig {
        const registry: Partial<Record<TemplateId, () => TemplateConfig>> = TEMPLATE_REGISTRY;
        const factory = registry[templateId];
        if (!factory) {
            throw new Error(`[TemplateManager] Unknown template: ${templateId}`);
        }
        return factory();
    }

    /**
     * 检查模板是否已就绪（node_modules 已安装）
     */
    async checkTemplateStatus(templateId: TemplateId): Promise<TemplateStatus> {
        const templatePath = await this.getTemplatePath(templateId);
        const { join } = await import('@tauri-apps/api/path');
        const { exists } = await import('@tauri-apps/plugin-fs');

        const nodeModulesPath = await join(templatePath, 'node_modules');
        const isInstalled = await exists(nodeModulesPath);

        return {
            id: templateId,
            isInstalled,
            path: templatePath,
        };
    }

    /**
     * 确保模板就绪
     *
     * 如果 node_modules 已存在则直接返回。
     * 否则：写入 package.json → 执行 npm install → 标记完成。
     *
     * @param templateId 模板 ID
     * @param onProgress 进度回调（用于 UI 反馈）
     * @returns 模板目录路径
     */
    async ensureTemplateReady(
        templateId: TemplateId,
        onProgress?: (message: string) => void,
    ): Promise<string> {
        const status = await this.checkTemplateStatus(templateId);
        const config = this.getTemplateConfig(templateId);
        const templatePath = status.path;

        if (status.isInstalled) {
            // 检测 package.json 是否与当前模板定义一致
            // 不一致时（如 Tailwind v4→v3 升级）自动覆写并重新安装
            const driftDetected = await this.hasPackageJsonDrift(templatePath, config);
            if (!driftDetected) {
                logger.debug(`[TemplateManager] 模板 ${templateId} 已就绪`);
                return templatePath;
            }

            logger.warn(`[TemplateManager] 模板 ${templateId} 依赖漂移，重新安装...`);
            onProgress?.(`Template update detected. Reinstalling ${templateId}...`);
        } else {
            logger.debug(`[TemplateManager] 模板 ${templateId} 首次使用，开始安装...`);
            onProgress?.(`Initializing ${templateId} template...`);
        }

        // 1. 创建模板目录
        await this.ensureDir(templatePath);

        // 2. 写入 package.json（始终覆写，确保最新依赖定义）
        const packageJson = this.buildPackageJson(config);
        await this.writeFile(templatePath, 'package.json', packageJson);
        logger.debug('[TemplateManager] 已写入 package.json');

        // 3. 写入配置文件（始终覆写，确保配置一致性）
        for (const [fileName, content] of Object.entries(config.configFiles)) {
            await this.writeFile(templatePath, fileName, content);
            logger.debug(`[TemplateManager] 已写入配置文件: ${fileName}`);
        }

        // 4. 执行 npm install
        onProgress?.('Installing dependencies (npm install)...');
        await this.runNpmInstall(templatePath);
        logger.debug(`[TemplateManager] 模板 ${templateId} 依赖安装完成`);

        return templatePath;
    }

    // ==================== 私有方法 ====================

    /**
     * 检测 package.json 是否与当前模板定义漂移
     *
     * 比较磁盘上已安装模板的 package.json 与内存中的模板配置。
     * 用于处理模板版本升级（如 Tailwind v4→v3）时自动重新安装。
     */
    private async hasPackageJsonDrift(templatePath: string, config: TemplateConfig): Promise<boolean> {
        try {
            const { join } = await import('@tauri-apps/api/path');
            const { readTextFile } = await import('@tauri-apps/plugin-fs');

            const pkgPath = await join(templatePath, 'package.json');
            const existingContent = await readTextFile(pkgPath);
            const expectedContent = this.buildPackageJson(config);

            // 简单字符串比较即可：buildPackageJson 输出是确定性的
            return existingContent.trim() !== expectedContent.trim();
        } catch {
            // 读取失败（文件不存在等）视为需要重新安装
            return true;
        }
    }

    /** 构建 package.json 内容 */
    private buildPackageJson(config: TemplateConfig): string {
        const pkg = {
            name: `preview-template-${config.id}`,
            version: '1.0.0',
            private: true,
            type: 'module',
            dependencies: config.dependencies,
            devDependencies: config.devDependencies,
        };
        return JSON.stringify(pkg, null, 2);
    }

    /** 确保目录存在（递归创建） */
    private async ensureDir(dirPath: string): Promise<void> {
        const { mkdir, exists } = await import('@tauri-apps/plugin-fs');
        const dirExists = await exists(dirPath);
        if (!dirExists) {
            await mkdir(dirPath, { recursive: true });
        }
    }

    /** 写入文件到指定目录 */
    private async writeFile(dir: string, fileName: string, content: string): Promise<void> {
        const { join } = await import('@tauri-apps/api/path');
        const filePath = await join(dir, fileName);

        // 如果文件名包含子目录（如 "src/main.js"），确保父目录存在
        if (fileName.includes('/')) {
            const parentDir = fileName.split('/').slice(0, -1).join('/');
            const parentPath = await join(dir, parentDir);
            await this.ensureDir(parentPath);
        }

        const { writeTextFile } = await import('@tauri-apps/plugin-fs');
        await writeTextFile(filePath, content);
    }

    /**
     * 在模板目录执行 npm install
     *
     * 使用 shell_execute 同步执行，等待安装完成。
     * 超时设置为 120 秒，覆盖首次安装的网络延迟。
     */
    private async runNpmInstall(templatePath: string): Promise<void> {
        // 首次安装全量依赖（Vite + React + Tailwind 等）在慢速网络下可能超过 2 分钟，
        // 设置 300 秒宽限期避免误超时
        const NPM_INSTALL_TIMEOUT_SECS = 300;

        const result = await invoke<{
            exitCode: number;
            stdout: string;
            stderr: string;
        }>('shell_execute', {
            command: 'npm install',
            workdir: templatePath,
            timeoutSecs: NPM_INSTALL_TIMEOUT_SECS,
            background: false,
            env: null,
            sandboxLevel: 'installer',
            subjectType: 'installer',
            subjectId: 'preview-template-install',
        });

        if (result.exitCode !== 0) {
            const errorDetail = result.stderr || result.stdout || 'Unknown error';
            throw new Error(
                `[TemplateManager] npm install failed (exit ${result.exitCode}): ${errorDetail}`
            );
        }

        logger.debug('[TemplateManager] npm install 成功:', result.stdout.slice(0, 200));
    }
}

/** TemplateManager 单例 */
export const templateManager = new TemplateManager();
