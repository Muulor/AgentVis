import { useRef, useEffect, useState, type MutableRefObject } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { TopBar } from './TopBar';
import { LeftPanel } from './LeftPanel';
import { CenterPanel } from './CenterPanel';
import { RightPanel } from './RightPanel';
import { StatusBar } from './StatusBar';
import { ResizeHandle } from '@components/ui/ResizeHandle';
import { RuntimeOnboardingBanner } from '@components/onboarding/RuntimeOnboardingBanner';
import { useToast } from '@components/ui/Toast';
import { useUIStore } from '@stores/uiStore';
import { cx } from '@utils/classNames';
import { useI18n } from '@/i18n';
import styles from './Shell.module.css';

const COLLAPSED_LEFT_PANEL_WIDTH = 76;

/**
 * Node.js 模板预热安装
 *
 * 在内嵌 Node.js 解压完成后 fire-and-forget 调用，
 * 预先安装 vanilla 模板的 node_modules，
 * 使首次 Vite 预览启动时无需再等待 npm install。
 *
 * @param showSuccessToast 是否在安装成功后弹出完成 Toast（首次解压时为 true，重试时为 false）
 * 失败时无论如何都显示 error Toast。
 */
async function warmupNodeTemplate(
    toastRef: MutableRefObject<(data: { type: 'success' | 'error' | 'warning' | 'info'; title: string; description?: string; duration?: number }) => void>,
    tRef: MutableRefObject<ReturnType<typeof useI18n>['t']>,
    showSuccessToast: boolean,
): Promise<void> {
    try {
        const { templateManager } = await import('@services/preview/TemplateManager');
        await templateManager.ensureTemplateReady('vanilla');
        console.info('[Shell] Node.js vanilla 模板预热安装完成');
        if (showSuccessToast) {
            toastRef.current({
                type: 'success',
                title: tRef.current('layout.viteReadyTitle'),
                description: tRef.current('layout.viteReadyDescription'),
                duration: 5000,
            });
        }
    } catch (err) {
        // 预热失败时告知用户，首次使用 Vite 预览时 TemplateManager 会自动重试
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[Shell] Node.js 模板预热安装失败:', msg);
        toastRef.current({
            type: 'error',
            title: tRef.current('layout.viteInstallFailed'),
            description: msg.slice(0, 120),
            duration: 10000,
        });
    }
}

/**
 * Shell 主布局容器
 *
 * 实现三栏布局，包含顶部标签栏、左栏导航、中栏对话区、右栏文件区和底部状态栏
 */
export function Shell() {
    const { toast } = useToast();
    const { t } = useI18n();
    const leftPanelWidth = useUIStore((state) => state.leftPanelWidth);
    const rightPanelWidth = useUIStore((state) => state.rightPanelWidth);
    const isLeftPanelCollapsed = useUIStore((state) => state.isLeftPanelCollapsed);
    const isRightPanelVisible = useUIStore((state) => state.isRightPanelVisible);
    const isResizing = useUIStore((state) => state.isResizing);
    const setLeftPanelWidth = useUIStore((state) => state.setLeftPanelWidth);
    const setRightPanelWidth = useUIStore((state) => state.setRightPanelWidth);
    const setIsResizing = useUIStore((state) => state.setIsResizing);

    // 容器宽度，用于计算右栏最大宽度
    const mainRef = useRef<HTMLElement>(null);
    const [containerWidth, setContainerWidth] = useState(0);

    // 使用 ref 跟踪拖拽起始宽度，避免闭包捕获旧值
    const leftStartWidth = useRef(leftPanelWidth);
    const rightStartWidth = useRef(rightPanelWidth);
    const accumulatedDelta = useRef(0);

    // 稳定化 toast 引用，避免 warmupNodeTemplate 闭包捕获初始渲染时的旧值
    const toastRef = useRef(toast);
    const tRef = useRef(t);
    useEffect(() => {
        toastRef.current = toast;
    }, [toast]);
    useEffect(() => {
        tRef.current = t;
    }, [t]);

    useEffect(() => {
        const handleImageGenerationError = (event: Event) => {
            const detail = (event as CustomEvent<{ message?: string }>).detail;
            const message = detail.message ?? tRef.current('layout.imageGenerationFailed');
            toastRef.current({
                type: 'error',
                title: tRef.current('layout.imageGenerationFailed'),
                description: message.slice(0, 180),
                duration: 10000,
            });
        };

        window.addEventListener('agentvis:image-generation-error', handleImageGenerationError);
        return () => window.removeEventListener('agentvis:image-generation-error', handleImageGenerationError);
    }, []);

    // Node.js 环境自动解压（首次安装后）
    // 由于 zip 内含 1000+ 文件（含 npm 模块），解压需 30-60 秒，须给用户明确反馈
    // 放在 Shell 中是因为 ToastProvider 在 App 外层，无法在 App() 内调用 useToast
    useEffect(() => {
        const timer = setTimeout(() => {
            void (async () => {
            try {
                const result = await invoke<{ bin_dir: string; node_exe: string; just_extracted: boolean }>(
                    'prepare_embedded_node'
                );
                if (result.just_extracted) {
                    console.info('[Shell] 内嵌 Node.js 解压完成:', result.bin_dir);
                    // 解压完成，但 npm 模板依赖仍需安装，先给出过渡提示
                    toastRef.current({
                        type: 'info',
                        title: tRef.current('layout.nodeExtractedTitle'),
                        description: tRef.current('layout.nodeExtractedDescription'),
                        duration: 5000,
                    });
                }
                // 每次启动都尝试确保模板就绪（ensureTemplateReady 内部幂等：
                // 若 node_modules 已存在则立即返回，无副作用）。
                // 此设计支持上次安装失败后的自动重试——
                // 即使 zip 已解压（just_extracted=false），npm install 也可以重新执行。
                void warmupNodeTemplate(toastRef, tRef, result.just_extracted);
            } catch (err: unknown) {
                // 开发模式下 zip 不存在，静默跳过；Release 模式下报错需可见
                const msg = typeof err === 'string' ? err : (err instanceof Error ? err.message : String(err));
                if (msg.includes('only included in release builds') || msg.includes('not found')) {
                    // 开发模式：zip 未打包，正常情况
                    console.debug('[Shell] prepare_embedded_node 跳过（开发模式）');
                } else {
                    console.error('[Shell] prepare_embedded_node 失败:', err);
                    toastRef.current({
                        type: 'error',
                        title: tRef.current('layout.nodeInitFailed'),
                        description: msg.slice(0, 100),
                        duration: 8000,
                    });
                }
            }
            })();
        }, 800);
        return () => clearTimeout(timer);
    }, []);

    // 监听容器宽度变化
    useEffect(() => {
        const updateWidth = () => {
            if (mainRef.current) {
                setContainerWidth(mainRef.current.offsetWidth);
            }
        };
        updateWidth();
        window.addEventListener('resize', updateWidth);
        return () => window.removeEventListener('resize', updateWidth);
    }, []);

    // 计算右栏最大宽度：容器宽度 - 左栏宽度 - 最小中栏宽度(400px) - 拖拽手柄(8px)
    const actualLeftWidth = isLeftPanelCollapsed ? COLLAPSED_LEFT_PANEL_WIDTH : leftPanelWidth;
    const rightPanelMaxWidth = Math.max(200, containerWidth - actualLeftWidth - 400 - 8);

    // 当窗口缩小导致右栏超出最大宽度时，自动调整右栏宽度
    useEffect(() => {
        if (containerWidth > 0 && isRightPanelVisible && rightPanelWidth > rightPanelMaxWidth) {
            setRightPanelWidth(rightPanelMaxWidth);
        }
    }, [containerWidth, rightPanelMaxWidth, rightPanelWidth, isRightPanelVisible, setRightPanelWidth]);

    // 处理左栏宽度调整 - 使用累积 delta
    const handleLeftResize = (delta: number) => {
        accumulatedDelta.current += delta;
        const newWidth = Math.max(160, Math.min(400, leftStartWidth.current + accumulatedDelta.current));
        setLeftPanelWidth(newWidth);
    };

    // 处理右栏宽度调整 - 右栏向左拖拽时 delta 为负，宽度应该增加
    const handleRightResize = (delta: number) => {
        accumulatedDelta.current += delta;
        // 使用动态计算的最大宽度
        const newWidth = Math.max(200, Math.min(rightPanelMaxWidth, rightStartWidth.current - accumulatedDelta.current));
        setRightPanelWidth(newWidth);
    };

    // 拖拽开始时记录初始宽度并重置累积值
    const handleLeftResizeStart = () => {
        leftStartWidth.current = leftPanelWidth;
        accumulatedDelta.current = 0;
        setIsResizing(true);
    };

    const handleRightResizeStart = () => {
        rightStartWidth.current = rightPanelWidth;
        accumulatedDelta.current = 0;
        setIsResizing(true);
    };

    // 拖拽结束时恢复过渡效果
    const handleResizeEnd = () => {
        setIsResizing(false);
    };

    const actualRightWidth = isRightPanelVisible ? rightPanelWidth : 0;

    // 拖拽时添加 resizing 类禁用过渡效果
    const leftPanelClass = cx(styles.leftPanel, isResizing && styles.resizing);
    const rightPanelClass = cx(styles.rightPanel, isResizing && styles.resizing);

    return (
        <div className={styles.shell}>
            {/* 顶部标签栏 */}
            <TopBar />

            {/* Runtime 环境安装引导横幅（首次启动时显示） */}
            <RuntimeOnboardingBanner />


            {/* 主内容区 */}
            <main ref={mainRef} className={styles.main}>
                {/* 左栏 */}
                <aside
                    className={leftPanelClass}
                    data-collapsed={isLeftPanelCollapsed}
                    style={{ width: actualLeftWidth }}
                >
                    <LeftPanel />
                </aside>

                {/* 左栏拖拽手柄 */}
                {!isLeftPanelCollapsed && (
                    <ResizeHandle
                        direction="horizontal"
                        onResize={handleLeftResize}
                        onResizeStart={handleLeftResizeStart}
                        onResizeEnd={handleResizeEnd}
                        className={styles.leftResizeHandle}
                    />
                )}

                {/* 中栏 */}
                <section className={styles.centerPanel}>
                    <CenterPanel />
                </section>

                {/* 右栏拖拽手柄 */}
                {isRightPanelVisible && (
                    <ResizeHandle
                        direction="horizontal"
                        onResize={handleRightResize}
                        onResizeStart={handleRightResizeStart}
                        onResizeEnd={handleResizeEnd}
                        className={styles.rightResizeHandle}
                    />
                )}

                {/* 右栏 */}
                {isRightPanelVisible && (
                    <aside
                        className={rightPanelClass}
                        style={{ width: actualRightWidth }}
                    >
                        <RightPanel />
                    </aside>
                )}
            </main>

            {/* 底部状态栏 */}
            <StatusBar />
        </div>
    );
}

