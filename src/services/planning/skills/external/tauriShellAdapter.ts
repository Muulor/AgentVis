/**
 * tauriShellAdapter - Tauri Shell 执行适配器
 *
 * 将 Tauri IPC 的 shell_execute 命令适配为 ShellExecuteFn 类型。
 * 消除多处内联适配器的重复代码。
 *
 * 使用场景：
 * - RuntimeOnboardingBanner（UI 层触发 RuntimeManager）
 * - 其他需要直接创建 RuntimeManager 的场景
 *
 * 设计说明：
 * - 使用动态 import 加载 @tauri-apps/api/core，避免 SSR / 测试环境报错
 * - 参数映射：ShellExecuteFn.timeout → shell_execute.timeoutSecs
 */

import type { ShellExecuteFn } from './ExternalExecutor';

type ShellExecuteParams = Parameters<ShellExecuteFn>[0];

export type ShellExecuteDefaults = Partial<
    Pick<
        ShellExecuteParams,
        | 'sandboxLevel'
        | 'sandboxNetwork'
        | 'sandboxMode'
        | 'processLifecycle'
        | 'networkScope'
        | 'subjectType'
        | 'subjectId'
    >
>;

/**
 * 创建基于 Tauri IPC 的 Shell 执行函数
 *
 * 将 ShellExecuteFn 的参数格式适配为 Tauri 后端 shell_execute 命令的参数格式。
 * 动态 import @tauri-apps/api/core 确保在非 Tauri 环境下不报错。
 *
 * @returns ShellExecuteFn 的 Tauri IPC 实现
 */
export async function createTauriShellExecute(
    defaults: ShellExecuteDefaults = {}
): Promise<ShellExecuteFn> {
    const { invoke } = await import('@tauri-apps/api/core');

    return async (params) => {
        return invoke<Awaited<ReturnType<ShellExecuteFn>>>(
            'shell_execute',
            {
                command: params.command,
                workdir: params.workdir,
                timeoutSecs: params.timeout,
                background: params.background,
                executionId: params.executionId,
                env: params.env,
                sandboxLevel: params.sandboxLevel ?? defaults.sandboxLevel,
                sandboxNetwork: params.sandboxNetwork ?? defaults.sandboxNetwork,
                sandboxMode: params.sandboxMode ?? defaults.sandboxMode,
                processLifecycle: params.processLifecycle ?? defaults.processLifecycle,
                networkScope: params.networkScope ?? defaults.networkScope,
                subjectType: params.subjectType ?? defaults.subjectType,
                subjectId: params.subjectId ?? defaults.subjectId,
                networkDirectAllowances: params.networkDirectAllowances,
                networkDirectTargets: params.networkDirectTargets,
                networkUploadConfirmed: params.networkUploadConfirmed,
                networkSensitiveEgressConfirmed: params.networkSensitiveEgressConfirmed,
                networkRemoteDestructiveConfirmed: params.networkRemoteDestructiveConfirmed,
                networkBrokerCredentials: params.networkBrokerCredentials,
                appContainerFilesystemGrants: params.appContainerFilesystemGrants,
            }
        );
    };
}
