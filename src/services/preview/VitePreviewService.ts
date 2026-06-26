/**
 * VitePreviewService - Vite Dev Server 生命周期管理
 *
 * 核心编排服务，负责：
 * 1. 在 Agent 工作区初始化项目目录（junction + 配置文件 + 源文件）
 * 2. 启动 Vite Dev Server 后台进程
 * 3. 监听 stdout 提取预览 URL
 * 4. 停止进程和清理资源
 *
 * 状态机：idle → installing → starting → running → idle
 *                               ↓ error
 *
 * 设计决策：
 * - 使用现有 shell_execute(background=true) 启动 Vite 进程，复用后端 PID 注册表
 * - node_modules 通过 Windows junction（mklink /J）指向模板缓存，无需管理员权限
 * - 配置文件直接复制（体积小，Agent 可能需要定制）
 */

import { invoke } from '@tauri-apps/api/core';
import { getLogger } from '@services/logger';
import { templateManager } from './TemplateManager';
import { portAllocator } from './PortAllocator';
import type { TemplateId, TemplateConfig, ProjectFile, ViteServerState } from './types';

const logger = getLogger('VitePreviewService');

/** 启动 Vite 后等待 URL 的最长时间（毫秒） */
const VITE_START_TIMEOUT_MS = 30_000;
/** 轮询 stdout 的间隔（毫秒） */
const POLL_INTERVAL_MS = 500;
/** Node.js 最低版本要求 */
const MIN_NODE_MAJOR_VERSION = 18;

// ==================== CSS 兼容性处理 ====================

/**
 * 将 Tailwind v4 语法降级为 v3
 *
 * LLM 可能生成 Tailwind v4 语法的 CSS，但模板环境是 v3。
 * v4 语法特征：
 *   - `@import "tailwindcss"` → v3: `@tailwind base; @tailwind components; @tailwind utilities;`
 *   - `@theme { ... }` → v3: 转换为 CSS 变量声明（`:root { ... }`）
 *   - `@import "tailwindcss/theme"` 等子包引用也需处理
 *
 * 这里采用安全的正则替换，保留原始 CSS 中非 Tailwind 的部分。
 */
function sanitizeCssForTailwindV3(css: string): string {
    let result = css;

    // 1. `@import "tailwindcss"` 或 `@import 'tailwindcss'`
    //    → 替换为 v3 的三个 @tailwind 指令
    result = result.replace(
        /^@import\s+["']tailwindcss["']\s*;?\s*$/gm,
        '@tailwind base;\n@tailwind components;\n@tailwind utilities;',
    );

    // 2. `@import "tailwindcss/theme"` 等子包 → 移除（v3 不支持）
    result = result.replace(
        /^@import\s+["']tailwindcss\/[^"']+["']\s*;?\s*$/gm,
        '/* [auto-removed] tailwindcss sub-import not supported in v3 */',
    );

    // 3. `@theme { --color-primary: #xxx; ... }` → `:root { ... }`
    //    保留内部的 CSS 变量声明
    result = result.replace(
        /@theme\s*\{([^}]*)\}/gs,
        ':root {$1}',
    );

    return result;
}

// ==================== VitePreviewService ====================

class VitePreviewService {
    /** 当前服务器状态 */
    private state: ViteServerState = {
        status: 'idle',
        url: null,
        pid: null,
        projectDir: null,
        templateId: null,
        error: null,
    };

    /** 当前已分配的端口（独立于 url 状态，确保 cleanup 时能释放） */
    private allocatedPort: number | null = null;

    /** 每次 startProject 递增，用于检测启动流程是否被抢占 */
    private startGeneration = 0;

    /** 是否已执行过首次初始化（注册 cleanup + 扫描孤儿进程） */
    private initialized = false;

    /** 获取当前状态快照 */
    getState(): Readonly<ViteServerState> {
        return { ...this.state };
    }

    /**
     * 启动项目预览
     *
     * 完整流程：
     * 1. 确保模板 node_modules 已安装（首次使用会触发 npm install）
     * 2. 在 Agent 工作区创建项目目录
     * 3. 创建 node_modules junction 指向模板缓存（或在有额外依赖时独立安装）
     * 4. 复制配置文件和入口文件（自适应 Agent 已有的入口文件）
     * 5. 写入 Agent 生成的源文件
     * 6. 分配端口 → 启动 Vite Dev Server
     * 7. 轮询 stdout 提取 URL
     *
     * @param deliverableDir Agent 工作区路径（deliverables/<hub>/<agent>/）
     * @param projectName 项目名称（作为子目录名）
     * @param templateId 使用的模板
     * @param files Agent 生成的源文件列表
     * @param projectPackageJson 项目原始 package.json 内容（可选，用于合并第三方依赖）
     * @returns 预览 URL
     */
    async startProject(
        deliverableDir: string,
        projectName: string,
        templateId: TemplateId,
        files: ProjectFile[],
        projectPackageJson?: string,
    ): Promise<string> {
        // 防止重复启动
        if (this.state.status === 'running' || this.state.status === 'starting') {
            logger.warn('[VitePreviewService] 已有预览在运行，先停止');
            await this.stopProject();
        }

        // 竞态防护：每次 startProject 递增 generation，
        // 如果在等待 async 操作期间被新的 startProject 或 stopProject 抢占，
        // generation 已改变 → 中止当前流程，防止孤儿进程。
        const currentGeneration = ++this.startGeneration;

        // 延迟初始化：首次调用 startProject 时才注册窗口关闭清理和扫描孤儿进程，
        // 避免未使用预览功能时在应用启动时产生不必要的开销
        if (!this.initialized) {
            this.initialized = true;
            this.registerCleanupOnClose();
            this.cleanupOrphanedProcesses().catch((err: unknown) => {
                logger.warn('[VitePreviewService] 启动时孤儿进程清理失败:', err);
            });
        }

        try {
            // ====== 阶段 0: 环境检查 ======
            await this.checkNodeEnvironment();
            this.assertNotPreempted(currentGeneration);

            // ====== 阶段 1: 安装模板依赖 ======
            this.updateState({ status: 'installing', templateId, error: null });

            const templatePath = await templateManager.ensureTemplateReady(
                templateId,
                (message) => logger.trace(`[VitePreviewService] 模板进度: ${message}`),
            );
            logger.trace('[VitePreviewService] 模板就绪:', templatePath);
            this.assertNotPreempted(currentGeneration);

            // ====== 阶段 2: 初始化项目目录 ======
            this.updateState({ status: 'starting' });

            const { join } = await import('@tauri-apps/api/path');
            const projectDir = await join(deliverableDir, projectName);
            this.updateState({ projectDir });

            await this.initProjectDirectory(projectDir, templatePath, templateId, files, deliverableDir, projectPackageJson);
            logger.trace('[VitePreviewService] 项目目录初始化完成:', projectDir);
            this.assertNotPreempted(currentGeneration);

            // ====== 阶段 3: 启动 Vite Dev Server ======
            const port = await portAllocator.allocate();
            this.allocatedPort = port;
            logger.trace(`[VitePreviewService] 分配端口: ${port}`);

            const pid = await this.startViteProcess(projectDir, port);
            this.updateState({ pid });
            logger.trace(`[VitePreviewService] Vite 进程已启动, PID: ${pid}`);

            // ====== 阶段 4: 等待 URL 就绪 ======
            const url = `http://localhost:${port}`;

            // 轮询等待 Vite 就绪（检测端口是否可连接）
            await this.waitForViteReady(url);
            this.assertNotPreempted(currentGeneration);

            this.updateState({ status: 'running', url });
            logger.trace(`[VitePreviewService] ✅ 预览就绪: ${url}`);

            return url;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error('[VitePreviewService] 启动失败:', errorMessage);
            this.updateState({ status: 'error', error: errorMessage });

            // 清理可能已分配的资源
            await this.cleanup();
            throw error;
        }
    }

    /**
     * 停止项目预览
     *
     * kill Vite 进程，释放端口，但保留项目文件（它们是交付物）。
     */
    async stopProject(): Promise<void> {
        // 递增 generation，使正在进行的 startProject 检测到抢占并自行中止
        this.startGeneration++;
        await this.cleanup();
        this.updateState({
            status: 'idle',
            url: null,
            pid: null,
            projectDir: null,
            templateId: null,
            error: null,
        });
        logger.trace('[VitePreviewService] 预览已停止');
    }

    // ==================== 私有方法 ====================

    /**
     * 初始化项目目录
     *
     * 在 Agent 工作区创建项目结构并链接模板依赖。
     * 智能处理入口文件冲突和第三方依赖缺失：
     * - 当 Agent 已生成入口文件（main.tsx 等）时，跳过模板脚手架入口，
     *   并动态生成 index.html 指向正确的入口扩展名
     * - 当项目 package.json 包含额外依赖时，合并后独立 npm install，
     *   而非使用 junction 共享（因为模板缓存不含这些依赖）
     */
    private async initProjectDirectory(
        projectDir: string,
        templatePath: string,
        templateId: TemplateId,
        files: ProjectFile[],
        deliverableDir: string,
        projectPackageJson?: string,
    ): Promise<void> {
        const { join } = await import('@tauri-apps/api/path');
        const { mkdir, exists, writeTextFile } = await import('@tauri-apps/plugin-fs');

        // 1. 创建项目目录和 src 子目录
        const srcDir = await join(projectDir, 'src');
        if (!(await exists(projectDir))) {
            await mkdir(projectDir, { recursive: true });
        }
        if (!(await exists(srcDir))) {
            await mkdir(srcDir, { recursive: true });
        }

        // 2. 解析项目的额外依赖，决定 node_modules 策略
        const config = templateManager.getTemplateConfig(templateId);
        const extraDeps = this.extractExtraDependencies(projectPackageJson, config);
        const hasExtraDeps = Object.keys(extraDeps.dependencies).length > 0
            || Object.keys(extraDeps.devDependencies).length > 0;

        // 3. node_modules 策略
        const nodeModulesLink = await join(projectDir, 'node_modules');
        const nodeModulesTarget = await join(templatePath, 'node_modules');

        if (hasExtraDeps) {
            // 有额外依赖 → 独立安装（不使用 junction）
            // 如果旧 node_modules 是 junction，需要先删掉；
            // 如果是真实目录（上次独立安装遗留），保留让 npm install 增量更新
            if (await exists(nodeModulesLink)) {
                // rmdir（无 /S）只能删除空目录或 junction，对非空真实目录会静默失败
                // 这正好满足我们的需求：删 junction、保留真实
                await invoke<string>('shell_execute', {
                    command: `cmd /c "rmdir "${nodeModulesLink}""`,
                    workdir: null,
                    timeoutSecs: 10,
                    background: false,
                    env: null,
                    sandboxLevel: 'preview',
                    subjectType: 'preview',
                    subjectId: 'vite-preview-node-modules',
                }).catch(() => {
                    // rmdir 失败说明是非空真实目录，保留即可
                    logger.trace('[VitePreviewService] node_modules 是真实目录，保留供 npm install 增量更新');
                });
            }

            // 写入合并后的 package.json 并执行 npm install
            const mergedPkg = this.buildMergedPackageJson(config, extraDeps);
            const packageJsonPath = await join(projectDir, 'package.json');
            await writeTextFile(packageJsonPath, mergedPkg);
            logger.trace('[VitePreviewService] 检测到额外依赖，执行独立 npm install');

            await this.runProjectNpmInstall(projectDir);
        } else {
            // 无额外依赖 → junction 共享模板 node_modules（零成本）
            // 始终重建：templateId 可能在预览之间切换（React↔Vue），
            // 旧 junction 指向错误模板的 node_modules 会导致缺少插件
            if (await exists(nodeModulesLink)) {
                // 先尝试 rmdir（删 junction 或空目录）
                // 如果失败（上次独立安装留下的真实目录），用 rmdir /S /Q 彻底删除
                const rmResult = await invoke<{
                    exitCode: number; stdout: string; stderr: string;
                }>('shell_execute', {
                    command: `cmd /c "rmdir "${nodeModulesLink}""`,
                    workdir: null,
                    timeoutSecs: 10,
                    background: false,
                    env: null,
                    sandboxLevel: 'preview',
                    subjectType: 'preview',
                    subjectId: 'vite-preview-node-modules',
                });
                if (rmResult.exitCode !== 0) {
                    // 非空真实目录，使用 /S /Q 强制删除
                    logger.trace('[VitePreviewService] 清理上次独立安装的 node_modules');
                    await invoke<string>('shell_execute', {
                        command: `cmd /c "rmdir /S /Q "${nodeModulesLink}""`,
                        workdir: null,
                        timeoutSecs: 30,
                        background: false,
                        env: null,
                        sandboxLevel: 'preview',
                        subjectType: 'preview',
                        subjectId: 'vite-preview-node-modules',
                    });
                }
            }
            await this.createJunction(nodeModulesTarget, nodeModulesLink);
            logger.trace(`[VitePreviewService] node_modules junction 已指向: ${templatePath}`);

            // 复制模板 package.json（让 Vite 能找到正确的依赖解析路径）
            const packageJsonPath = await join(projectDir, 'package.json');
            const templatePkgPath = await join(templatePath, 'package.json');
            const { readTextFile } = await import('@tauri-apps/plugin-fs');
            const pkgContent = await readTextFile(templatePkgPath);
            await writeTextFile(packageJsonPath, pkgContent);
        }

        // 4. 智能写入配置文件
        // 如果 Agent 文件中包含同根名的配置（如 vite.config.ts 对应模板的 vite.config.js），
        // 则跳过模板版本，使用 Agent 自己的配置（可能包含自定义 alias、插件等）
        const agentFileBasenames = new Set(
            files.map(f => {
                const parts = f.path.split('/');
                return parts[parts.length - 1];
            })
        );
        // 提取文件名的根名（不含扩展名），用于跨扩展名匹配
        // 例如 'vite.config' 匹配 vite.config.js 和 vite.config.ts
        const agentConfigRoots = new Set(
            files
                .filter(f => !f.path.includes('/'))
                .map(f => f.path.replace(/\.[^.]+$/, ''))
        );

        for (const [fileName, content] of Object.entries(config.configFiles)) {
            const configRoot = fileName.replace(/\.[^.]+$/, '');
            // 如果 Agent 提供了同名文件或同根名不同扩展名的文件，跳过模板版本
            if (agentFileBasenames.has(fileName) || agentConfigRoots.has(configRoot)) {
                logger.trace(`[VitePreviewService] 跳过模板配置 ${fileName}，使用 Agent 自己的版本`);
                continue;
            }
            const filePath = await join(projectDir, fileName);
            await writeTextFile(filePath, content);
        }

        // 5. 智能写入入口文件
        // 检测 Agent 是否已提供入口文件，避免模板脚手架覆盖 Agent 的入口
        const agentEntryFile = this.detectAgentEntryFile(files);
        const agentHasIndexHtml = files.some(f => f.path === 'index.html');

        if (agentEntryFile) {
            // Agent 已提供入口文件 → 跳过模板入口，动态生成适配的 index.html
            if (!agentHasIndexHtml) {
                const indexHtml = this.generateIndexHtml(agentEntryFile, templateId);
                const indexPath = await join(projectDir, 'index.html');
                await writeTextFile(indexPath, indexHtml);
                logger.trace(`[VitePreviewService] 已生成适配 index.html，入口: ${agentEntryFile}`);
            }
            // 跳过所有模板 entryFiles 的写入
        } else {
            // Agent 未提供入口文件 → 使用模板脚手架（原有行为）
            for (const [relativePath, content] of Object.entries(config.entryFiles)) {
                const filePath = await join(projectDir, relativePath);
                await this.ensureParentDirs(projectDir, relativePath);
                await writeTextFile(filePath, content);
            }
        }

        // 6. 写入 Agent 生成的源文件（始终覆盖，这是最新内容）
        for (const file of files) {
            const filePath = await join(projectDir, file.path);
            await this.ensureParentDirs(projectDir, file.path);

            // CSS 文件自动降级：LLM 可能生成 Tailwind v4 语法，
            // 但模板环境是 v3，需要转换语法避免 postcss-import 解析错误
            const content = file.path.endsWith('.css')
                ? sanitizeCssForTailwindV3(file.content)
                : file.content;

            await writeTextFile(filePath, content);
            logger.trace(`[VitePreviewService] 已写入源文件: ${file.path}`);
        }

        // 7. 链接静态资源目录（图片、字体等）
        // Vite 将 public/ 中的文件作为静态资源直接 serve，
        // src/assets/ 中的文件通过构建管道处理。
        // 创建 junction 指向原项目的这些目录，避免复制大量二进制文件。
        await this.linkAssetDirectories(projectDir, deliverableDir);
    }

    /**
     * 链接静态资源目录（图片、字体等）
     *
     * 两阶段处理：
     * 1. 已知约定目录（public/、assets/、src/assets/）：按固定映射创建 junction
     * 2. 自动扫描：遍历 deliverableDir 根目录下所有子目录，
     *    对尚未在 vite_preview 中存在的目录自动创建 junction。
     *    这样可以处理 scripts/、styles/、images/、img/ 等非标准目录名。
     *
     * 使用 junction 而非复制，避免拷贝大量图片/字体二进制文件。
     */
    private async linkAssetDirectories(
        projectDir: string,
        deliverableDir: string,
    ): Promise<void> {
        const { join } = await import('@tauri-apps/api/path');
        const { exists, readDir } = await import('@tauri-apps/plugin-fs');

        // 阶段 1：硬编码已知约定目录（保持向后兼容）
        // [原项目相对路径, 预览项目相对路径]
        const KNOWN_ASSET_DIRS: [string, string][] = [
            ['public', 'public'],
            ['src/assets', 'src/assets'],
            ['assets', 'assets'],
        ];

        for (const [srcRelative, destRelative] of KNOWN_ASSET_DIRS) {
            const sourceDir = await join(deliverableDir, srcRelative);
            const targetLink = await join(projectDir, destRelative);

            // 原项目中该目录必须存在
            if (!(await exists(sourceDir))) continue;
            // 预览项目中该路径不应已被源文件步骤创建（避免冲突）
            if (await exists(targetLink)) continue;

            try {
                // 确保父目录存在（如 src/assets 需要 src/ 目录）
                await this.ensureParentDirs(projectDir, destRelative + '/placeholder');
                await this.createJunction(sourceDir, targetLink);
                logger.trace(`[VitePreviewService] 已链接资源目录: ${destRelative} → ${sourceDir}`);
            } catch (linkError) {
                // 链接失败不阻塞预览，仅资源 404
                logger.warn(`[VitePreviewService] 链接资源目录失败 ${destRelative}:`, linkError);
            }
        }

        // 阶段 2：自动扫描 deliverableDir 根目录，补充链接所有未覆盖的子目录和散图片文件
        // • 子目录：scripts/、styles/、images/ 等非标准目录 → junction
        // • 根目录散图片/字体：hero-portrait.jpg 等无法纳入子目录的文件 → hardlink
        //   (Windows hardlink 在同 NTFS 卷内零拷贝，不占额外磁盘空间)
        const SKIP_DIRS = new Set(['vite_preview', 'node_modules', '.git', 'dist', 'build']);
        const BINARY_ASSET_EXTENSIONS = new Set([
            'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif',
            'woff', 'woff2', 'ttf', 'otf', 'eot',
            'mp4', 'webm', 'ogg', 'mp3', 'wav',
        ]);

        try {
            const rootEntries = await readDir(deliverableDir);
            for (const entry of rootEntries) {
                if (entry.isDirectory) {
                    // 子目录：跳过保留目录，其余全部 junction
                    if (SKIP_DIRS.has(entry.name)) continue;

                    const sourceDir = await join(deliverableDir, entry.name);
                    const targetLink = await join(projectDir, entry.name);

                    // 如果 vite_preview 中已经存在该路径，跳过
                    if (await exists(targetLink)) continue;

                    try {
                        await this.createJunction(sourceDir, targetLink);
                        logger.trace(`[VitePreviewService] 自动链接目录: ${entry.name} → ${sourceDir}`);
                    } catch (linkError) {
                        logger.warn(`[VitePreviewService] 自动链接目录失败 ${entry.name}:`, linkError);
                    }
                } else {
                    // 根目录散文件：只处理图片/字体/媒体等二进制资源
                    const ext = entry.name.split('.').pop()?.toLowerCase() ?? '';
                    if (!BINARY_ASSET_EXTENSIONS.has(ext)) continue;

                    const sourcePath = await join(deliverableDir, entry.name);
                    const targetPath = await join(projectDir, entry.name);

                    if (await exists(targetPath)) continue;

                    try {
                        // mklink（无 /D /J）创建文件 hardlink，失败时回退到 junction（不支持跨卷 hardlink）
                        await invoke<{ exitCode: number; stdout: string; stderr: string }>('shell_execute', {
                            command: `cmd /c "mklink /H "${targetPath}" "${sourcePath}""`,
                            workdir: null,
                            timeoutSecs: 5,
                            background: false,
                            env: null,
                            sandboxLevel: 'preview',
                            subjectType: 'preview',
                            subjectId: 'vite-preview-assets',
                        });
                        logger.trace(`[VitePreviewService] 已 hardlink 散图片: ${entry.name}`);
                    } catch (linkError) {
                        logger.warn(`[VitePreviewService] 散图片 hardlink 失败 ${entry.name}:`, linkError);
                    }
                }
            }
        } catch (scanError) {
            // 扫描失败不阻塞预览
            logger.warn('[VitePreviewService] 扫描 deliverableDir 根目录失败:', scanError);
        }

        // 阶段 3：扫描父目录中的散图片/字体文件
        // Agent 生成的 CSS 经常通过 url('../image.jpeg') 引用存放在 Agent 工作区根目录的图片。
        // Vite dev server 无法 serve 项目根目录（vite_preview/）之上的文件，
        // 因此需要将父目录中的二进制资源 hardlink 到 vite_preview/ 的上一级相对位置。
        // 由于 vite_preview 已经在 deliverableDir 下，../image.jpeg 从 vite_preview
        // 角度看实际指向 deliverableDir/image.jpeg（已在阶段 2 处理），
        // 但当 deliverableDir 本身就是子项目（如 dare-lipstick/）时，
        // ../image.jpeg 指向 Agent 工作区根目录。
        await this.linkParentDirectoryAssets(projectDir, deliverableDir, BINARY_ASSET_EXTENSIONS);
    }

    /**
     * 扫描 deliverableDir 的父目录，将散图片/字体 hardlink 到 vite_preview 项目中
     *
     * 解决 CSS 中 url('../image.jpeg') 引用父目录资源的问题：
     * - deliverableDir = .../Kira/dare-lipstick/（子项目目录）
     * - CSS 中 url('../lipstick-hero-image.jpeg') 指向 .../Kira/lipstick-hero-image.jpeg
     * - Vite 项目在 dare-lipstick/vite_preview/，CSS 被复制进去后
     *   ../image.jpeg 从 vite_preview/ 角度指向 dare-lipstick/（deliverableDir 自身）
     *
     * 因此需要将父目录的散图片 hardlink 到 deliverableDir 根目录（即 vite_preview 的父级），
     * 同时也 hardlink 到 vite_preview/ 内部，确保两种解析路径都能命中。
     */
    private async linkParentDirectoryAssets(
        projectDir: string,
        deliverableDir: string,
        binaryExtensions: Set<string>,
    ): Promise<void> {
        const { dirname, join } = await import('@tauri-apps/api/path');
        const { exists, readDir } = await import('@tauri-apps/plugin-fs');

        let parentDir: string;
        try {
            parentDir = await dirname(deliverableDir);
        } catch {
            return; // 无法获取父目录，跳过
        }

        // 安全检查：如果 deliverableDir 已经是 Agent 工作区根目录（没有父级可扫描），跳过
        if (parentDir === deliverableDir || !parentDir) return;

        try {
            const parentEntries = await readDir(parentDir);
            for (const entry of parentEntries) {
                // 只处理散文件（非目录），且扩展名为二进制资源
                if (entry.isDirectory) continue;
                const ext = entry.name.split('.').pop()?.toLowerCase() ?? '';
                if (!binaryExtensions.has(ext)) continue;

                const sourcePath = await join(parentDir, entry.name);

                // 策略 1：hardlink 到 vite_preview/ 内部
                // 当 CSS 被内联到 vite_preview/ 的 HTML 中时，
                // ../file.jpg 从 vite_preview/ 角度指向 deliverableDir/file.jpg
                // 但 vite 实际 serve 的根目录是 vite_preview/，所以也需要在 vite_preview/ 内部放一份
                const targetInProject = await join(projectDir, entry.name);
                if (!(await exists(targetInProject))) {
                    try {
                        await invoke<{ exitCode: number; stdout: string; stderr: string }>('shell_execute', {
                            command: `cmd /c "mklink /H "${targetInProject}" "${sourcePath}""`,
                            workdir: null,
                            timeoutSecs: 5,
                            background: false,
                            env: null,
                            sandboxLevel: 'preview',
                            subjectType: 'preview',
                            subjectId: 'vite-preview-assets',
                        });
                        logger.trace(`[VitePreviewService] 已 hardlink 父目录图片到项目: ${entry.name}`);
                    } catch (linkError) {
                        logger.warn(`[VitePreviewService] 父目录图片 hardlink 到项目失败 ${entry.name}:`, linkError);
                    }
                }

                // 策略 2：hardlink 到 deliverableDir 根目录
                // 当 Vite dev server 访问 ../file.jpg 时，
                // 从 vite_preview/ 向上走一级到 deliverableDir/，
                // 如果 deliverableDir/ 下有该文件则 Vite 可以 serve
                const targetInDeliverable = await join(deliverableDir, entry.name);
                if (!(await exists(targetInDeliverable))) {
                    try {
                        await invoke<{ exitCode: number; stdout: string; stderr: string }>('shell_execute', {
                            command: `cmd /c "mklink /H "${targetInDeliverable}" "${sourcePath}""`,
                            workdir: null,
                            timeoutSecs: 5,
                            background: false,
                            env: null,
                            sandboxLevel: 'preview',
                            subjectType: 'preview',
                            subjectId: 'vite-preview-assets',
                        });
                        logger.trace(`[VitePreviewService] 已 hardlink 父目录图片到交付物: ${entry.name}`);
                    } catch (linkError) {
                        logger.warn(`[VitePreviewService] 父目录图片 hardlink 到交付物失败 ${entry.name}:`, linkError);
                    }
                }
            }
        } catch (scanError) {
            // 扫描父目录失败不阻塞预览
            logger.warn('[VitePreviewService] 扫描父目录散图片失败:', scanError);
        }
    }

    // ==================== 入口文件与依赖处理 ====================

    /** 已知的入口文件路径（按优先级排序） */
    private static readonly ENTRY_FILE_CANDIDATES = [
        'src/main.tsx',
        'src/main.jsx',
        'src/main.ts',
        'src/main.js',
    ] as const;

    /**
     * 检测 Agent 文件列表中是否已包含入口文件
     *
     * 遍历已知入口文件路径，返回第一个匹配项。
     * 返回 null 表示 Agent 未提供入口文件，应使用模板脚手架。
     */
    private detectAgentEntryFile(files: ProjectFile[]): string | null {
        const filePaths = new Set(files.map(f => f.path));
        for (const candidate of VitePreviewService.ENTRY_FILE_CANDIDATES) {
            if (filePaths.has(candidate)) {
                return candidate;
            }
        }
        return null;
    }

    /**
     * 动态生成 index.html，将 <script> 指向 Agent 实际的入口文件
     *
     * 解决入口扩展名不匹配问题：模板默认 main.jsx，但 Agent 可能使用 main.tsx。
     * Vite 在 .jsx 文件中不自动解析 .tsx 模块，导致白屏。
     */
    private generateIndexHtml(entryFilePath: string, templateId: TemplateId): string {
        // 根据模板类型决定挂载点 ID
        const rootId = templateId === 'vue-tailwind' ? 'app' : 'root';

        return [
            '<!DOCTYPE html>',
            '<html lang="en">',
            '<head>',
            '  <meta charset="UTF-8" />',
            '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
            '  <title>Preview</title>',
            '</head>',
            '<body>',
            `  <div id="${rootId}"></div>`,
            `  <script type="module" src="/${entryFilePath}"></script>`,
            '</body>',
            '</html>',
        ].join('\n');
    }

    /**
     * 从项目 package.json 中提取模板未包含的额外依赖
     *
     * 对比项目依赖与模板依赖，返回模板中不存在的包。
     * 这些包需要在项目目录中独立安装。
     */
    private extractExtraDependencies(
        projectPackageJson: string | undefined,
        templateConfig: TemplateConfig,
    ): { dependencies: Record<string, string>; devDependencies: Record<string, string> } {
        const emptyResult = { dependencies: {}, devDependencies: {} };
        if (!projectPackageJson) return emptyResult;

        try {
            const pkg = JSON.parse(projectPackageJson) as {
                dependencies?: Record<string, string>;
                devDependencies?: Record<string, string>;
            };

            // 模板已有的所有包名（合并 dependencies + devDependencies）
            const templatePackages = new Set([
                ...Object.keys(templateConfig.dependencies),
                ...Object.keys(templateConfig.devDependencies),
            ]);

            const extraDeps: Record<string, string> = {};
            const extraDevDeps: Record<string, string> = {};

            // 检测项目 dependencies 中模板未包含的包
            if (pkg.dependencies) {
                for (const [name, version] of Object.entries(pkg.dependencies)) {
                    if (!templatePackages.has(name)) {
                        extraDeps[name] = version;
                    }
                }
            }

            // 检测项目 devDependencies 中模板未包含的包
            // 排除构建工具类（vite, typescript 等），这些由模板管理
            const BUILD_TOOL_PACKAGES = new Set([
                'vite', 'typescript', '@vitejs/plugin-react', '@vitejs/plugin-vue',
                'tailwindcss', 'postcss', 'autoprefixer', 'postcss-import',
                '@types/react', '@types/react-dom',
            ]);

            if (pkg.devDependencies) {
                for (const [name, version] of Object.entries(pkg.devDependencies)) {
                    if (!templatePackages.has(name) && !BUILD_TOOL_PACKAGES.has(name)) {
                        extraDevDeps[name] = version;
                    }
                }
            }

            if (Object.keys(extraDeps).length > 0 || Object.keys(extraDevDeps).length > 0) {
                logger.trace('[VitePreviewService] 检测到额外依赖:', {
                    dependencies: extraDeps,
                    devDependencies: extraDevDeps,
                });
            }

            return { dependencies: extraDeps, devDependencies: extraDevDeps };
        } catch (parseError) {
            logger.warn('[VitePreviewService] 解析项目 package.json 失败:', parseError);
            return emptyResult;
        }
    }

    /**
     * 构建合并后的 package.json
     *
     * 将模板基础依赖与项目额外依赖合并为一个完整的 package.json。
     */
    private buildMergedPackageJson(
        templateConfig: TemplateConfig,
        extraDeps: { dependencies: Record<string, string>; devDependencies: Record<string, string> },
    ): string {
        const pkg = {
            name: `preview-${templateConfig.id}`,
            version: '1.0.0',
            private: true,
            type: 'module',
            dependencies: {
                ...templateConfig.dependencies,
                ...extraDeps.dependencies,
            },
            devDependencies: {
                ...templateConfig.devDependencies,
                ...extraDeps.devDependencies,
            },
        };
        return JSON.stringify(pkg, null, 2);
    }

    /**
     * 在项目目录执行 npm install
     *
     * 用于有额外依赖时的独立安装场景。
     * 与 TemplateManager.runNpmInstall 类似但作用于项目目录。
     */
    private async runProjectNpmInstall(projectDir: string): Promise<void> {
        const NPM_INSTALL_TIMEOUT_SECS = 300;

        const result = await invoke<{
            exitCode: number;
            stdout: string;
            stderr: string;
        }>('shell_execute', {
            command: 'npm install',
            workdir: projectDir,
            timeoutSecs: NPM_INSTALL_TIMEOUT_SECS,
            background: false,
            env: null,
            sandboxLevel: 'installer',
            subjectType: 'installer',
            subjectId: 'vite-preview-project-install',
        });

        if (result.exitCode !== 0) {
            const errorDetail = result.stderr || result.stdout || 'Unknown error';
            throw new Error(
                `[VitePreviewService] Project npm install failed (exit ${result.exitCode}): ${errorDetail}`
            );
        }

        logger.trace('[VitePreviewService] 项目 npm install 成功:', result.stdout.slice(0, 200));
    }

    // ==================== 进程管理 ====================

    /**
     * 创建 Windows junction（mklink /J）
     *
     * junction 不需要管理员权限，对 Vite 完全透明。
     * 在 Unix 系统上会降级为 symlink。
     */
    private async createJunction(target: string, link: string): Promise<void> {
        // Windows：使用 cmd /c mklink /J
        // mklink /J 创建目录联接点，不需要管理员权限
        const command = `cmd /c mklink /J "${link}" "${target}"`;

        const result = await invoke<{
            exitCode: number;
            stdout: string;
            stderr: string;
        }>('shell_execute', {
            command,
            workdir: null,
            timeoutSecs: 10,
            background: false,
            env: null,
            sandboxLevel: 'preview',
            subjectType: 'preview',
            subjectId: 'vite-preview-junction',
        });

        if (result.exitCode !== 0) {
            throw new Error(
                `[VitePreviewService] Failed to create junction: ${result.stderr || result.stdout}`
            );
        }
    }

    /**
     * 启动 Vite Dev Server 后台进程
     *
     * 使用 npx vite 启动，配置：
     * --port: 指定端口
     * --strictPort: 端口占用时直接报错（不自动递增）
     * --host 127.0.0.1: 仅本地回环，安全隔离
     *
     * @returns 进程 PID
     */
    private async startViteProcess(projectDir: string, port: number): Promise<number> {
        const command = `npx vite --port ${port} --strictPort --host 127.0.0.1`;

        const result = await invoke<{
            exitCode: number;
            stdout: string;
            stderr: string;
            pid?: number;
        }>('shell_execute', {
            command,
            workdir: projectDir,
            timeoutSecs: null,  // 后台进程不设超时
            background: true,   // 后台运行，返回 PID
            env: null,
            sandboxLevel: 'preview',
            processLifecycle: 'backgroundManaged',
            subjectType: 'preview',
            subjectId: 'vite-dev-server',
        });

        // 后台模式下 shell_execute 返回 PID
        if (result.pid === undefined) {
            throw new Error(
                `[VitePreviewService] Failed to start Vite process; no PID was returned: ${result.stderr || result.stdout}`
            );
        }

        return result.pid;
    }

    /**
     * 等待 Vite Dev Server 就绪
     *
     * 通过轮询 HTTP 请求检测服务是否已启动。
     * Vite 启动通常在 1-3 秒内完成。
     *
     * 同时检测进程是否仍存活，如果 Vite 进程崩溃退出，
     * 立即报错而不是空等 30 秒超时。
     */
    private async waitForViteReady(url: string): Promise<void> {
        const startTime = Date.now();

        while (Date.now() - startTime < VITE_START_TIMEOUT_MS) {
            // 检测进程是否仍存活：如果 pid 已被清理或进程崩溃，快速失败
            if (this.state.pid === null) {
                throw new Error(
                    '[VitePreviewService] Vite process exited before startup completed'
                );
            }

            try {
                // 尝试发起一个简单的 fetch 请求检测服务是否就绪
                const response = await fetch(url, {
                    method: 'HEAD',
                    signal: AbortSignal.timeout(2000),
                });
                if (response.ok || response.status === 404) {
                    // 有响应即表示 Vite 已启动（404 表示 index.html 可能不存在但服务已运行）
                    logger.trace(`[VitePreviewService] Vite 服务已就绪，耗时: ${Date.now() - startTime}ms`);
                    return;
                }
            } catch {
                // 连接失败，继续等待
            }

            await this.sleep(POLL_INTERVAL_MS);
        }

        throw new Error(
            `[VitePreviewService] Vite startup timed out after ${VITE_START_TIMEOUT_MS / 1000} seconds. Check the Node.js environment.`
        );
    }

    /** 清理资源（终止进程 + 释放端口） */
    private async cleanup(): Promise<void> {
        // 终止 Vite 进程
        if (this.state.pid !== null) {
            try {
                await invoke<string>('shell_kill', { pid: this.state.pid });
                logger.trace(`[VitePreviewService] 已终止 Vite 进程 PID: ${this.state.pid}`);
            } catch (error) {
                // 进程可能已经退出，忽略错误
                logger.warn('[VitePreviewService] 终止进程时出错（可能已退出）:', error);
            }
        }

        // 释放端口：使用独立追踪的 allocatedPort，不依赖 url 状态
        // 修复：之前依赖 this.state.url 提取端口号，但在 Vite 启动失败时
        // url 尚未设置（仍为 null），导致端口永远不会被释放
        if (this.allocatedPort !== null) {
            portAllocator.release(this.allocatedPort);
            logger.trace(`[VitePreviewService] 已释放端口: ${this.allocatedPort}`);
            this.allocatedPort = null;
        }
    }

    /**
     * 将服务层状态同步到 previewStore
     *
     * 使用延迟 import 避免与 previewStore 之间的循环依赖。
     * 如果 previewStore 尚未加载（应用初始化早期），静默忽略。
     */
    private syncToStore(state: ViteServerState): void {
        import('@stores/previewStore').then(({ usePreviewStore }) => {
            const store = usePreviewStore.getState();
            // 仅在 project 模式下同步，避免干扰 HTML 预览
            if (store.previewMode !== 'project') return;

            if (state.status === 'error') {
                store.setProjectStatus('error', state.error ?? undefined);
            } else {
                store.setProjectStatus(state.status);
            }
            if (state.status === 'running' && state.url && state.templateId) {
                store.setProjectUrl(state.url, state.templateId);
            }
        }).catch(() => {
            // previewStore 尚未加载（应用启动早期），忽略
        });
    }

    /** 更新状态并自动同步到 previewStore */
    private updateState(partial: Partial<ViteServerState>): void {
        this.state = { ...this.state, ...partial };
        this.syncToStore(this.state);
    }

    /** Promise 版 sleep */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 检查 startProject 流程是否被抢占
     *
     * 在每个 async 阶段之后调用，如果 generation 已变化
     * （被新的 startProject 或 stopProject 递增），抛出取消错误。
     */
    private assertNotPreempted(expectedGeneration: number): void {
        if (this.startGeneration !== expectedGeneration) {
            throw new Error('[VitePreviewService] Preview startup was cancelled because a newer start/stop request was detected');
        }
    }

    /**
     * 确保相对路径的父目录存在
     *
     * 使用 mkdir(recursive: true) 一次性创建，
     * 替代之前逐级检查的冗余模式。
     */
    private async ensureParentDirs(basePath: string, relativePath: string): Promise<void> {
        if (!relativePath.includes('/')) return;
        const { join } = await import('@tauri-apps/api/path');
        const { mkdir } = await import('@tauri-apps/plugin-fs');
        const parentParts = relativePath.split('/').slice(0, -1);
        const parentDir = await join(basePath, ...parentParts);
        await mkdir(parentDir, { recursive: true });
    }

    /**
     * 注册窗口关闭时的清理逻辑
     *
     * 确保关闭应用时 Vite 进程被终止，避免孤儿 node 进程。
     */
    registerCleanupOnClose(): void {
        window.addEventListener('beforeunload', () => {
            if (this.state.pid) {
                // beforeunload 中只能做同步操作，使用 fire-and-forget
                this.cleanup().catch(() => {
                    // 忽略关闭时的清理错误
                });
            }
        });
        logger.trace('[VitePreviewService] 已注册窗口关闭清理');
    }

    /**
     * 检测 Node.js 环境
     *
     * 验证 node 命令可用且版本 ≥ 18。
     * 若不可用或版本过低，抛出可读的错误信息。
     */
    private async checkNodeEnvironment(): Promise<void> {
        try {
            // 使用 command 字符串格式，匹配 Rust 端 shell_execute 签名
            // shell_execute 参数: (command, workdir, timeout_secs, background, env)
            // 返回: ShellExecResult { exitCode, stdout, stderr, pid? }
            const result = await invoke<{
                exitCode: number;
                stdout: string;
                stderr: string;
            }>('shell_execute', {
                command: 'node --version',
                workdir: null,
                timeoutSecs: 10,
                background: false,
                env: null,
                sandboxLevel: 'preview',
                subjectType: 'preview',
                subjectId: 'vite-preview-node-check',
            });

            if (result.exitCode !== 0) {
                throw new Error(
                    `node --version failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`
                );
            }

            // 输出格式为 "v20.18.0\n"，提取主版本号
            const versionMatch = result.stdout.trim().match(/^v(\d+)/);
            if (!versionMatch?.[1]) {
                throw new Error(`Unable to parse Node.js version: ${result.stdout.trim()}`);
            }

            const majorVersion = parseInt(versionMatch[1], 10);
            if (majorVersion < MIN_NODE_MAJOR_VERSION) {
                throw new Error(
                    `Node.js version is too old: v${majorVersion} (requires v${MIN_NODE_MAJOR_VERSION} or newer). ` +
                    `Please upgrade Node.js: https://nodejs.org/`
                );
            }

            logger.trace(`[VitePreviewService] Node.js 环境检测通过: ${result.stdout.trim()}`);
        } catch (error) {
            // 区分「node 未安装」和「版本过低」
            const message = error instanceof Error ? error.message : String(error);
            if (
                message.includes('version is too old') ||
                message.includes('Unable to parse') ||
                message.includes('node --version failed')
            ) {
                throw error;
            }
            // node 命令不存在或执行失败
            throw new Error(
                'Node.js was not detected. Project preview requires Node.js v18 or newer.\n' +
                'Install it from: https://nodejs.org/'
            );
        }
    }

    /**
     * 清理指定端口范围内的孤儿进程
     *
     * 应用启动时调用，扫描 preview 端口范围（3100-3199），
     * 通过 HTTP 探测发现残留的 Vite 进程，使用 netstat + taskkill 终止。
     */
    async cleanupOrphanedProcesses(): Promise<void> {
        const startPort = 3100;
        const endPort = 3110; // 只扫描前 10 个端口，避免启动延迟

        for (let port = startPort; port <= endPort; port++) {
            try {
                const response = await fetch(`http://localhost:${port}`, {
                    method: 'HEAD',
                    signal: AbortSignal.timeout(500),
                });

                if (response.ok || response.status === 404) {
                    // 发现残留进程，尝试通过 netstat 找到 PID 并 kill
                    logger.warn(`[VitePreviewService] 发现端口 ${port} 上的残留进程，尝试清理...`);
                    try {
                        // 使用 command 字符串格式，匹配 Rust 端 shell_execute 签名
                        const netstatResult = await invoke<{
                            exitCode: number;
                            stdout: string;
                            stderr: string;
                        }>('shell_execute', {
            command: `cmd /c "for /f "tokens=5" %a in ('netstat -ano ^| findstr :${port} ^| findstr LISTENING') do @echo %a"`,
                            workdir: null,
                            timeoutSecs: 10,
                            background: false,
                            env: null,
                            sandboxLevel: 'preview',
                            subjectType: 'preview',
                            subjectId: 'vite-preview-orphan-cleanup',
                        });

                        const pids = netstatResult.stdout.trim().split('\n')
                            .map(s => parseInt(s.trim(), 10))
                            .filter(n => !isNaN(n) && n > 0);

                        for (const pid of new Set(pids)) {
                            try {
                                await invoke<{
                                    exitCode: number;
                                    stdout: string;
                                    stderr: string;
                                }>('shell_execute', {
                                    command: `taskkill /F /T /PID ${pid}`,
                                    workdir: null,
                                    timeoutSecs: 10,
                                    background: false,
                                    env: null,
                                    sandboxLevel: 'preview',
                                    subjectType: 'preview',
                                    subjectId: 'vite-preview-orphan-cleanup',
                                });
                                logger.trace(`[VitePreviewService] 已清理孤儿进程 PID: ${pid} (端口 ${port})`);
                            } catch {
                                // taskkill 可能失败（进程已退出），忽略
                            }
                        }
                    } catch {
                        // netstat 解析失败，忽略
                    }
                }
            } catch {
                // fetch 超时/连接失败 → 该端口无进程，跳过
            }
        }

        logger.trace('[VitePreviewService] 孤儿进程扫描完成');
    }
}

/** VitePreviewService 单例 */
export const vitePreviewService = new VitePreviewService();
