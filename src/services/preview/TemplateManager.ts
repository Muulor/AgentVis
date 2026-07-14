/**
 * TemplateManager - 预览模板缓存管理器
 *
 * 管理 {appData}/preview-templates/ 目录下的模板缓存。
 * 每个模板只缓存 AgentVis 受控的 package.json 与 node_modules。运行时配置
 * 由 VitePreviewService 写入隔离 staging，避免执行 Agent 提供的构建配置。
 *
 * 职责：
 * 1. 持有各模板的配置定义（P0: vanilla，P1: react-tailwind）
 * 2. 检查模板 node_modules 是否已安装
 * 3. 首次使用或依赖漂移时写入受控 package.json 并执行 npm install
 * 4. 以 single-flight owner/joiner 语义共享并管理模板准备
 * 5. 提供模板路径和配置查询接口
 */

import { invoke } from '@tauri-apps/api/core';
import { getLogger } from '@services/logger';
import type { TemplateId, TemplateConfig, TemplateStatus } from './types';

const logger = getLogger('TemplateManager');
const INSTALL_MARKER_FILE = '.agentvis-install-complete';

/** A cancellable shell execution owned by the caller that started an actual template install. */
export interface TemplateInstallExecution {
  executionId: string;
  release: () => void;
}

/** Atomic single-flight result used by Preview to distinguish owners from joiners. */
export interface TemplatePreparation {
  readiness: Promise<string>;
  joinedExistingPreparation: boolean;
}

type AcquireTemplateInstallExecution = () => TemplateInstallExecution;

interface ActiveTemplatePreparation {
  readiness: Promise<string>;
  ownerKey: symbol;
}

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
      vite: '^6.2.0',
    },
    configFiles: {},
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
      'src/main.js': ['// Preview entry file', 'console.log("Preview loaded");'].join('\n'),
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
      react: '^18.3.1',
      'react-dom': '^18.3.1',
    },
    devDependencies: {
      vite: '^6.2.0',
      '@vitejs/plugin-react': '^4.3.4',
      tailwindcss: '^3.4.17',
      postcss: '^8.5.3',
      'postcss-import': '^16.1.0',
      autoprefixer: '^10.4.21',
    },
    configFiles: {},
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
      'src/index.css': ['@tailwind base;', '@tailwind components;', '@tailwind utilities;'].join(
        '\n'
      ),
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
      vue: '^3.5.13',
    },
    devDependencies: {
      vite: '^6.2.0',
      '@vitejs/plugin-vue': '^5.2.3',
      tailwindcss: '^3.4.17',
      postcss: '^8.5.3',
      'postcss-import': '^16.1.0',
      autoprefixer: '^10.4.21',
    },
    configFiles: {},
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
      'src/index.css': ['@tailwind base;', '@tailwind components;', '@tailwind utilities;'].join(
        '\n'
      ),
    },
  };
}

/** 所有模板配置注册表 */
const TEMPLATE_REGISTRY: Record<TemplateId, () => TemplateConfig> = {
  vanilla: getVanillaTemplate,
  'react-tailwind': getReactTailwindTemplate,
  // P2 阶段添加
  'vue-tailwind': getVueTailwindTemplate,
};

// ==================== TemplateManager 类 ====================

class TemplateManager {
  /** 模板缓存根目录（延迟初始化） */
  private templatesRoot: string | null = null;

  /** 同一模板只允许一个安装/修复流程，避免并发 npm 写入同一缓存目录。 */
  private readonly readinessPromises = new Map<TemplateId, ActiveTemplatePreparation>();

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

  /** Whether another caller currently owns this template's install/repair flow. */
  isTemplatePreparationInFlight(templateId: TemplateId): boolean {
    return this.readinessPromises.has(templateId);
  }

  /**
   * 检查模板是否已就绪（node_modules 已安装）
   */
  async checkTemplateStatus(templateId: TemplateId): Promise<TemplateStatus> {
    const templatePath = await this.getTemplatePath(templateId);
    const { join } = await import('@tauri-apps/api/path');
    const { exists } = await import('@tauri-apps/plugin-fs');

    const nodeModulesPath = await join(templatePath, 'node_modules');
    const markerPath = await join(templatePath, INSTALL_MARKER_FILE);
    const isInstalled = (await exists(nodeModulesPath)) && (await exists(markerPath));

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
   * @param acquireInstallExecution 仅由实际 install owner 延迟获取的可取消 execution
   * @returns 模板目录路径
   */
  async ensureTemplateReady(
    templateId: TemplateId,
    onProgress?: (message: string) => void,
    acquireInstallExecution?: AcquireTemplateInstallExecution
  ): Promise<string> {
    return this.beginTemplatePreparation(templateId, onProgress, acquireInstallExecution).readiness;
  }

  /**
   * Atomically join an existing preparation or become its owner.
   *
   * The install-execution factory belongs only to the owner and is invoked lazily, immediately
   * before npm starts. Joiners can therefore wait for a Shell warmup or another Preview without
   * registering or cancelling that shared owner's execution.
   */
  beginTemplatePreparation(
    templateId: TemplateId,
    onProgress?: (message: string) => void,
    acquireInstallExecution?: AcquireTemplateInstallExecution
  ): TemplatePreparation {
    const inFlight = this.readinessPromises.get(templateId);
    if (inFlight) {
      onProgress?.(`Waiting for the existing ${templateId} template installation...`);
      return { readiness: inFlight.readiness, joinedExistingPreparation: true };
    }

    const ownerKey = Symbol(templateId);
    const readiness = this.runOwnedTemplatePreparation(
      templateId,
      ownerKey,
      onProgress,
      acquireInstallExecution
    );
    this.readinessPromises.set(templateId, { readiness, ownerKey });
    return { readiness, joinedExistingPreparation: false };
  }

  private async runOwnedTemplatePreparation(
    templateId: TemplateId,
    ownerKey: symbol,
    onProgress?: (message: string) => void,
    acquireInstallExecution?: AcquireTemplateInstallExecution
  ): Promise<string> {
    try {
      return await this.ensureTemplateReadyInternal(
        templateId,
        onProgress,
        acquireInstallExecution
      );
    } finally {
      if (this.readinessPromises.get(templateId)?.ownerKey === ownerKey) {
        this.readinessPromises.delete(templateId);
      }
    }
  }

  private async ensureTemplateReadyInternal(
    templateId: TemplateId,
    onProgress?: (message: string) => void,
    acquireInstallExecution?: AcquireTemplateInstallExecution
  ): Promise<string> {
    const leaseToken = await invoke<string>('preview_acquire_template_lock', { templateId });
    let preparation: { value: string } | { error: unknown };
    try {
      preparation = {
        value: await this.ensureTemplateReadyWhileLocked(
          templateId,
          onProgress,
          acquireInstallExecution
        ),
      };
    } catch (error) {
      preparation = { error };
    }

    let releaseFailure: { error: unknown } | null = null;
    try {
      await invoke('preview_release_template_lock', { leaseToken });
    } catch (error) {
      releaseFailure = { error };
    }

    if ('error' in preparation) {
      if (releaseFailure) {
        logger.warn(
          '[TemplateManager] Failed to release template lease after preparation error:',
          releaseFailure.error
        );
      }
      throw preparation.error;
    }
    if (releaseFailure) throw releaseFailure.error;
    return preparation.value;
  }

  private async ensureTemplateReadyWhileLocked(
    templateId: TemplateId,
    onProgress?: (message: string) => void,
    acquireInstallExecution?: AcquireTemplateInstallExecution
  ): Promise<string> {
    const status = await this.checkTemplateStatus(templateId);
    const config = this.getTemplateConfig(templateId);
    const templatePath = status.path;

    if (status.isInstalled) {
      // package.json 和完成标记都必须与当前模板定义一致。标记内容同时充当
      // 最后一次成功提交的版本记录，避免崩溃窗口误认旧 node_modules。
      const driftDetected = await this.hasTemplateCacheDrift(templatePath, config);
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

    // 2. 在任何 manifest 变更前先失效完成标记。即使进程在下一步崩溃，
    // 下次也不会把旧 node_modules 与新 package.json 误判为同一提交。
    const { join } = await import('@tauri-apps/api/path');
    const { exists, remove } = await import('@tauri-apps/plugin-fs');
    const markerPath = await join(templatePath, INSTALL_MARKER_FILE);
    if (await exists(markerPath)) {
      await remove(markerPath);
    }

    // 3. 写入 package.json（始终覆写，确保最新依赖定义）
    const packageJson = this.buildPackageJson(config);
    await this.writeFile(templatePath, 'package.json', packageJson);
    logger.debug('[TemplateManager] 已写入 package.json');

    // 4. 执行 npm install（禁用依赖 lifecycle scripts）
    onProgress?.('Installing dependencies (npm install)...');
    const installExecution = acquireInstallExecution?.();
    try {
      await this.runNpmInstall(templatePath, installExecution?.executionId);
    } finally {
      installExecution?.release();
    }
    await this.writeFile(templatePath, INSTALL_MARKER_FILE, packageJson);
    logger.debug(`[TemplateManager] 模板 ${templateId} 依赖安装完成`);

    return templatePath;
  }

  // ==================== 私有方法 ====================

  /**
   * 检测 package.json 和完成标记是否与当前模板定义漂移。
   *
   * 两个文件必须同时匹配确定性的受控 manifest；任一缺失或不一致都说明
   * node_modules 没有对应到一个完整提交，需要重新安装。
   */
  private async hasTemplateCacheDrift(
    templatePath: string,
    config: TemplateConfig
  ): Promise<boolean> {
    try {
      const { join } = await import('@tauri-apps/api/path');
      const { readTextFile } = await import('@tauri-apps/plugin-fs');

      const pkgPath = await join(templatePath, 'package.json');
      const markerPath = await join(templatePath, INSTALL_MARKER_FILE);
      const [existingContent, committedContent] = await Promise.all([
        readTextFile(pkgPath),
        readTextFile(markerPath),
      ]);
      const expectedContent = this.buildPackageJson(config);

      // 简单字符串比较即可：buildPackageJson 输出是确定性的
      return (
        existingContent.trim() !== expectedContent.trim() ||
        committedContent.trim() !== expectedContent.trim()
      );
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
  private async runNpmInstall(templatePath: string, executionId?: string): Promise<void> {
    // 首次安装全量依赖（Vite + React + Tailwind 等）在慢速网络下可能超过 2 分钟，
    // 设置 300 秒宽限期避免误超时
    const NPM_INSTALL_TIMEOUT_SECS = 300;

    const result = await invoke<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>('shell_execute', {
      command: 'npm install --ignore-scripts --no-audit --no-fund --package-lock=false',
      workdir: templatePath,
      timeoutSecs: NPM_INSTALL_TIMEOUT_SECS,
      background: false,
      env: null,
      sandboxLevel: 'installer',
      subjectType: 'installer',
      subjectId: 'preview-template-install',
      executionId,
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
