import { useEffect, useCallback, useRef, useState } from 'react';
import { Shell } from '@components/layout/Shell';
import { ToastProvider } from '@components/ui/Toast';
import { TooltipProvider } from '@components/ui/Tooltip';
import { ImageLightbox } from '@components/chat/ImageLightbox';
import { ConfirmDialog } from '@components/ui/ConfirmDialog';
import { NetworkDirectAuthorizationDialog } from '@components/security/NetworkDirectAuthorizationDialog';
import { NetworkUploadAuthorizationDialog } from '@components/security/NetworkUploadAuthorizationDialog';
import { useTheme } from '@hooks/useTheme';
import { useDataLoader } from '@hooks/useDataLoader';
import {
  useAttachmentViewerStore,
  selectLightboxImage,
  selectLightboxImages,
  selectLightboxIndex,
} from '@stores/attachmentViewerStore';
import { useChatStore } from '@stores/chatStore';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { startScheduler, stopScheduler } from '@services/cron';
import { getLogger } from '@services/logger';
import { closeWindowWithPreviewCleanup } from '@services/preview/windowCloseLifecycle';
import { usePreviewStore } from '@stores/previewStore';
import { useUpdateStore } from '@stores/updateStore';
import { useI18n } from '@/i18n';
import type { AttachmentInfo } from '@/types/message';

const logger = getLogger('App');
const RELOAD_SHORTCUT_TEST_STORAGE_KEY = 'agentvis:allowReloadShortcutTest';

function isTruthyFeatureFlag(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function isReloadShortcutTestEnabled(): boolean {
  if (isTruthyFeatureFlag(import.meta.env.VITE_AGENTVIS_ALLOW_RELOAD_SHORTCUT_TEST)) {
    return true;
  }

  try {
    const stored = window.localStorage.getItem(RELOAD_SHORTCUT_TEST_STORAGE_KEY);
    return isTruthyFeatureFlag(stored ?? undefined);
  } catch {
    return false;
  }
}

/**
 * AgentVis 应用根组件
 * 负责初始化主题、加载持久化数据和渲染布局骨架
 */
function App() {
  const { t } = useI18n();

  // 初始化主题
  useTheme();

  // 加载持久化数据（Hub 和 Agent）
  useDataLoader();

  // 加载用户自定义模型配置（fire-and-forget，失败不阻塞启动）
  useEffect(() => {
    import('@/config/modelRegistry')
      .then(({ loadUserModels }) => {
        return loadUserModels();
      })
      .catch((err: unknown) => {
        logger.warn('[App] 加载用户模型配置失败:', err);
      });
  }, []);

  // 首次安装后自动部署内置 skill 包（从安装包 resource_dir/skills-bundle/ → AppData）
  // 幂等：packages 目录非空时 Rust 端直接返回，无额外开销
  // 仅在 Release 安装包中有效（开发模式下 skills-bundle 不存在，Rust 端会静默跳过）
  useEffect(() => {
    const bootstrapSkills = async () => {
      try {
        const result = await invoke<{
          deployed: boolean;
          packages_dir: string;
          skill_count: number;
        }>('bootstrap_skills_if_needed');
        if (result.deployed) {
          logger.trace(
            `[App] 内置 skill 包已部署: ${result.skill_count} 个 → ${result.packages_dir}`
          );
        }
      } catch (err) {
        // 开发模式或 Tauri unavailable 时静默忽略
        logger.trace('[App] bootstrap_skills_if_needed 跳过（开发模式）:', err);
      }
    };

    const timer = setTimeout(() => {
      void bootstrapSkills();
    }, 500);
    return () => clearTimeout(timer);
  }, []);

  // 预加载外部技能扫描（启动时提前注册到 SkillLoader + RuntimeStore）
  // bootstrapExternalSkills 有 Promise 锁保证幂等，后续 AgentLoop 调用时直接复用已完成的 Promise
  useEffect(() => {
    const timer = setTimeout(() => {
      import('@services/planning/skills/external/ExternalSkillBootstrap')
        .then(({ bootstrapExternalSkills }) => bootstrapExternalSkills())
        .catch((err: unknown) => {
          logger.warn('[App] 外部技能预加载失败:', err);
        });
    }, 2000);
    return () => clearTimeout(timer);
  }, []);

  // 初始化定时任务调度器
  useEffect(() => {
    // 延迟启动调度器，确保数据库和基础设施已就绪
    const timer = setTimeout(() => {
      void startScheduler();
    }, 3000);

    return () => {
      clearTimeout(timer);
      stopScheduler();
    };
  }, []);

  // 启动后自动进行轻量版本检测，只更新本地状态不打断用户
  useEffect(() => {
    const timer = setTimeout(() => {
      void useUpdateStore.getState().autoCheckIfNeeded();
    }, 15_000);

    return () => clearTimeout(timer);
  }, []);

  // IM 通道自动连接（多 Bot 版本）：
  // 遍历所有启用的 BotConfig，为每个 Bot 独立建立连接
  useEffect(() => {
    // 延迟 4 秒确保 Store rehydrate 和基础设施就绪
    const autoConnectImChannels = async () => {
      try {
        const { useImChannelStore } = await import('@stores/imChannelStore');
        const { autoConnect, botConfigs } = useImChannelStore.getState();

        // 自动连接未启用 或 没有任何 Bot 配置时跳过
        if (!autoConnect || botConfigs.length === 0) {
          // 封岗提示：旧用户可能还没有完成迁移（defaultAgentId 非空但 botConfigs 为空）
          const { defaultAgentId } = useImChannelStore.getState() as {
            defaultAgentId: string | null;
          };
          if (autoConnect && botConfigs.length === 0 && defaultAgentId) {
            logger.warn(
              '[App] IM 自动连接跳过：检测到旧版 IM 配置，请打开 [设置 > IM 通道] 完成迁移后重启应用。'
            );
          }
          return;
        }

        // 注册平台适配器（幂等，多次调用安全）
        const { registerPlatform, createChannelForBot, getChannelByBotId, destroyChannelByBotId } =
          await import('@services/im-channel/ImChannelFactory');
        const { FeishuChannel } = await import('@services/im-channel/platforms/FeishuChannel');
        const { SlackChannel } = await import('@services/im-channel/platforms/SlackChannel');
        const { initializeImTaskBridge } = await import('@services/im-channel/ImTaskBridge');

        registerPlatform(
          'feishu',
          (config) =>
            new FeishuChannel(config as import('@services/im-channel/types').FeishuChannelConfig)
        );
        registerPlatform(
          'slack',
          (config) =>
            new SlackChannel(config as import('@services/im-channel/types').SlackChannelConfig)
        );

        // 对每个已启用的 Bot 独立连接
        const enabledBots = botConfigs.filter((c) => c.enabled);
        for (const botConfig of enabledBots) {
          // 跳过已连接的 Bot（防止重复连接）
          const existing = getChannelByBotId(botConfig.botId);
          if (existing) continue;

          try {
            // 读取 per-bot 凭据
            const creds = await invoke<{
              appId: string;
              appSecret: string;
              botToken?: string;
              appToken?: string;
            }>('im_get_bot_credentials', { platform: botConfig.platform, botId: botConfig.botId });
            if (botConfig.platform === 'slack') {
              if (!creds.botToken || !creds.appToken) continue;
            } else if (!creds.appId || !creds.appSecret) {
              continue;
            }

            const { setBotConnected, setBotConnectionError, setBotConnecting } =
              useImChannelStore.getState();

            setBotConnecting(botConfig.botId, true);

            // 销毁旧连接（若有）
            if (getChannelByBotId(botConfig.botId)) {
              await destroyChannelByBotId(botConfig.botId);
            }

            // 创建新 Channel
            const channel =
              botConfig.platform === 'slack'
                ? createChannelForBot(botConfig.botId, {
                    platform: 'slack',
                    botToken: creds.botToken ?? '',
                    appToken: creds.appToken ?? '',
                    defaultAgentId: botConfig.agentId ?? undefined,
                  } as import('@services/im-channel/types').SlackChannelConfig)
                : createChannelForBot(botConfig.botId, {
                    platform: 'feishu',
                    appId: creds.appId,
                    appSecret: creds.appSecret,
                    defaultAgentId: botConfig.agentId ?? undefined,
                  } as import('@services/im-channel/types').FeishuChannelConfig);

            channel.onConnectionChange((connected, error) => {
              setBotConnected(botConfig.botId, connected);
              if (error) setBotConnectionError(botConfig.botId, error);
            });

            await channel.connect();
            // 注册任务桥接（携带 botId）
            initializeImTaskBridge(botConfig.botId, channel);
            setBotConnected(botConfig.botId, true);

            logger.trace(`[App] IM Bot 自动连接成功: ${botConfig.displayName}`);
          } catch (botError) {
            // 单个 Bot 连接失败不影响其他 Bot
            logger.warn(`[App] Bot ${botConfig.displayName} 自动连接失败:`, botError);
          }
        }
      } catch (autoConnectError) {
        // 自动连接逻辑整体失败不阻塞应用启动
        logger.warn('[App] IM 自动连接失败:', autoConnectError);
      }
    };

    const timer = setTimeout(() => {
      void autoConnectImChannels();
    }, 4000);

    return () => clearTimeout(timer);
  }, []);

  // 附件查看器状态
  const lightboxImage = useAttachmentViewerStore(selectLightboxImage);
  const lightboxImages = useAttachmentViewerStore(selectLightboxImages);
  const lightboxIndex = useAttachmentViewerStore(selectLightboxIndex);
  const { closeImageLightbox, goToPrevImage, goToNextImage } = useAttachmentViewerStore();

  // ==================== 窗口关闭确认 ====================
  // 仅在 renderer listener 存活时阻止默认关闭，再由前端检测是否有 Agent 任务。
  // 若 React 根树崩溃并卸载 listener，Tauri 会恢复原生默认关闭，避免窗口锁死。
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const closeInProgressRef = useRef(false);

  const destroyWindowAfterPreviewCleanup = useCallback(async () => {
    await closeWindowWithPreviewCleanup({
      guard: closeInProgressRef,
      invalidatePreviewRequest: () => usePreviewStore.getState().invalidateProjectRequest(),
      cleanupPreview: () =>
        import('@services/preview').then(({ vitePreviewService }) =>
          vitePreviewService.stopProject()
        ),
      destroyWindow: () => getCurrentWindow().destroy(),
      onCleanupTimeout: () => {
        logger.warn('[App] Project Preview cleanup timed out during window close');
      },
      onCleanupError: (error) => {
        logger.warn('[App] Project Preview cleanup failed during window close:', error);
      },
      onDestroyError: (error) => {
        logger.warn('[App] Window destruction failed; close can be retried:', error);
      },
    });
  }, []);

  useEffect(() => {
    const unlisten = getCurrentWindow().onCloseRequested((event) => {
      event.preventDefault();

      // 检测是否有 Agent 任务正在执行（Chat 和 Planning 模式共用 sendingContexts）
      const { sendingContexts } = useChatStore.getState();
      const hasActiveTask = sendingContexts.size > 0;

      if (hasActiveTask) {
        // 有任务进行中，弹出确认弹窗让用户决定
        setShowCloseConfirm(true);
      } else {
        // 无任务，直接销毁窗口（destroy 绕过 CloseRequested 拦截，避免死循环）
        void destroyWindowAfterPreviewCleanup();
      }
    });

    return () => {
      void unlisten
        .then((fn) => fn())
        .catch((err: unknown) => {
          logger.warn('[App] close-requested listener cleanup failed:', err);
        });
    };
  }, [destroyWindowAfterPreviewCleanup]);

  /** 用户确认退出：销毁窗口（绕过 CloseRequested 拦截） */
  const handleConfirmClose = useCallback(() => {
    setShowCloseConfirm(false);
    void destroyWindowAfterPreviewCleanup();
  }, [destroyWindowAfterPreviewCleanup]);

  /** 用户取消退出：关闭弹窗，继续等待任务完成 */
  const handleCancelClose = useCallback(() => {
    setShowCloseConfirm(false);
  }, []);

  // 禁用浏览器默认右键菜单（保留应用自定义右键菜单）
  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      // 检查是否有自定义右键菜单的容器（data-custom-context-menu 属性）
      // 如果有，则允许事件继续传播到自定义菜单处理器
      const target = e.target as HTMLElement;
      const hasCustomMenu = target.closest('[data-custom-context-menu]');

      if (!hasCustomMenu) {
        e.preventDefault();
      }
    };

    document.addEventListener('contextmenu', handleContextMenu);
    return () => document.removeEventListener('contextmenu', handleContextMenu);
  }, []);

  // 禁用浏览器级刷新快捷键（F5 / Ctrl+R / Ctrl+Shift+R / Ctrl+F5）
  //
  // 在 Tauri 打包后的 WebView2 环境中，这些按键会触发整页重载（类似 location.reload()），
  // 导致所有 Zustand 内存状态（对话消息、Planning 进度、FSM 可视化等）全部丢失。
  // 手工验证 checkpoint 恢复链路时，可通过隐藏测试开关临时放行刷新快捷键。
  // 使用 capture:true 在事件到达 DOM 树之前拦截，防止 WebView 原生处理刷新。
  useEffect(() => {
    const handleRefreshKey = (e: KeyboardEvent) => {
      const isRefreshShortcut =
        e.key === 'F5' ||
        (e.ctrlKey && (e.key === 'r' || e.key === 'R')) ||
        (e.ctrlKey && e.key === 'F5');

      if (isRefreshShortcut) {
        if (isReloadShortcutTestEnabled()) {
          return;
        }

        e.preventDefault();
        e.stopPropagation();
      }
    };

    // capture: true 确保在所有子组件的 keydown 处理之前拦截
    window.addEventListener('keydown', handleRefreshKey, { capture: true });
    return () => window.removeEventListener('keydown', handleRefreshKey, { capture: true });
  }, []);

  // 获取图片源：优先使用 base64，否则转换本地路径
  const getImageSrc = useCallback((image: AttachmentInfo | null) => {
    if (!image) return '';
    if (image.base64Data) {
      // base64 数据需要添加 data URL 前缀
      const mimeType = `image/${image.fileExtension === 'jpg' ? 'jpeg' : image.fileExtension}`;
      return `data:${mimeType};base64,${image.base64Data}`;
    }
    // 使用 Tauri 的 convertFileSrc 转换本地文件路径
    return convertFileSrc(image.localPath);
  }, []);

  // 判断是否有上一张/下一张
  const hasPrev = lightboxIndex > 0;
  const hasNext = lightboxIndex < lightboxImages.length - 1;

  return (
    <TooltipProvider>
      <ToastProvider>
        <Shell />
        <NetworkDirectAuthorizationDialog />
        <NetworkUploadAuthorizationDialog />
        {/* 窗口关闭确认弹窗（Agent 任务进行中时） */}
        <ConfirmDialog
          open={showCloseConfirm}
          onClose={handleCancelClose}
          onConfirm={handleConfirmClose}
          title={t('app.closeConfirm.title')}
          description={t('app.closeConfirm.description')}
          confirmText={t('app.closeConfirm.confirm')}
          cancelText={t('app.closeConfirm.cancel')}
          variant="warning"
        />
        {/* 图片 Lightbox 模态框（全局层级） */}
        {lightboxImage && (
          <ImageLightbox
            src={getImageSrc(lightboxImage)}
            fileName={lightboxImage.fileName}
            onClose={closeImageLightbox}
            hasPrev={hasPrev}
            hasNext={hasNext}
            onPrev={goToPrevImage}
            onNext={goToNextImage}
            currentIndex={lightboxIndex}
            totalCount={lightboxImages.length}
          />
        )}
      </ToastProvider>
    </TooltipProvider>
  );
}

export default App;
