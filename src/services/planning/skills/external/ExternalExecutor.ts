/**
 * ExternalExecutor - 外部脚本执行器
 *
 * 封装 Shell 调用，负责构造命令、执行脚本、超时控制和输出截取。
 * 仅服务于 Script 模式 Skill 的一次性执行。
 *
 * 设计理念：
 * - 通过 Tauri shell_execute 后端命令执行（与 ExecTool 共享后端）
 * - 严格遵守 ExecutionContract 的超时和输出限制
 * - 参数通过 CLI --name value 格式传递，不使用 stdin
 * - 执行失败不重试，直接返回错误结果
 *
 * 依赖注入：
 * - shellExecute 函数可注入，便于测试时 mock
 */

import { invoke } from '@tauri-apps/api/core';
import { translate } from '@/i18n';
import { getLogger } from '@services/logger';
import {
  activeNetworkDirectAllowancesForSubject,
  requestNetworkDirectAuthorization,
} from '@stores/networkDirectAuthorizationStore';
import { requestNetworkUploadAuthorization } from '@stores/networkUploadAuthorizationStore';
import { redactSensitiveObservation } from '../shared/observationRedaction';
import type {
  BrokerCredentialRef,
  ExecutionContract,
  ScriptExecutionResult,
  SkillAgentVisNetworkEntrypointMode,
} from './types';
import type {
  NetworkDirectAllowance,
  NetworkDirectAuthorizationGrant,
  NetworkDirectTarget,
} from '@/types/networkDirectAuthorization';
import type { NetworkRiskAuthorizationKind } from '@/types/networkUploadAuthorization';

const logger = getLogger('ExternalExecutor');

const NETWORK_RISK_CONFIRMATION_REASON_CODES = new Set([
  'network_upload_confirmation_required',
  'network_sensitive_egress_confirmation_required',
  'network_remote_destructive_confirmation_required',
]);

interface ShellFilesystemGrant {
  path: string;
  access: 'readOnly' | 'readWrite';
}

function networkRiskKindFromReasonCode(reasonCode: string): NetworkRiskAuthorizationKind {
  if (reasonCode === 'network_sensitive_egress_confirmation_required') {
    return 'sensitiveEgress';
  }
  if (reasonCode === 'network_remote_destructive_confirmation_required') {
    return 'remoteDestructive';
  }
  return 'fileUpload';
}

function networkRiskConfirmationFlags(reasonCode: string): Partial<Parameters<ShellExecuteFn>[0]> {
  if (reasonCode === 'network_sensitive_egress_confirmation_required') {
    return { networkSensitiveEgressConfirmed: true };
  }
  if (reasonCode === 'network_remote_destructive_confirmation_required') {
    return { networkRemoteDestructiveConfirmed: true };
  }
  return { networkUploadConfirmed: true };
}

// ==================== Shell 执行接口 ====================

/**
 * Shell 执行函数签名
 *
 * 与 Tauri invoke('shell_execute', ...) 对齐。
 * 通过依赖注入实现可测试性，生产环境注入真实 Tauri invoke。
 */
export type ShellExecuteFn = (params: {
  command: string;
  workdir: string;
  timeout: number;
  background: boolean;
  env?: Record<string, string>;
  sandboxLevel?: 'standard' | 'externalSkill' | 'installer' | 'preview' | 'restricted';
  sandboxNetwork?: 'inherit' | 'audit' | 'blocked';
  sandboxMode?: 'LocalAudit' | 'OfflineIsolated' | 'ControlledNetwork';
  processLifecycle?: 'managed' | 'detachedLaunch' | 'backgroundManaged';
  networkScope?: 'inherit' | 'blocked' | 'lan' | 'internetAudit';
  subjectType?: 'command' | 'skill' | 'preview' | 'installer';
  subjectId?: string;
  networkDirectAllowances?: NetworkDirectAllowance[];
  networkDirectTargets?: NetworkDirectTarget[];
  networkUploadConfirmed?: boolean;
  networkSensitiveEgressConfirmed?: boolean;
  networkRemoteDestructiveConfirmed?: boolean;
  networkBrokerCredentials?: BrokerCredentialRef[];
  appContainerFilesystemGrants?: ShellFilesystemGrant[];
  executionId?: string;
}) => Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  terminated?: boolean;
  durationMs?: number;
  timeoutSecs?: number;
}>;

interface ExternalExecutionOptions {
  sandboxMode?: 'LocalAudit' | 'OfflineIsolated' | 'ControlledNetwork';
  networkFallback?: 'brokerProxyPreferred';
  networkEntrypointMode?: SkillAgentVisNetworkEntrypointMode;
  enableNetworkDirectAuthorization?: boolean;
  workdir?: string;
  signal?: AbortSignal;
}

interface NetworkDirectTargetInspection {
  targets: NetworkDirectTarget[];
  requiredProtocols: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createShellExecutionId(subjectId: string | undefined): string {
  const suffix =
    (subjectId ?? 'skill')
      .replace(/[^a-z0-9_-]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'skill';
  return `external-skill-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function splitCommandTokens(command: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|“([^”]*)”|‘([^’]*)’|(\S+)/g;
  for (const match of command.matchAll(pattern)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? '');
  }
  return tokens.filter(Boolean);
}

function shellQuoteArg(value: string): string {
  if (!value || /[\s"&|<>^]/.test(value)) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}

function commandOptionValue(tokens: string[], option: string): string | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === option) {
      return tokens[index + 1];
    }
    const prefix = `${option}=`;
    if (token?.startsWith(prefix)) {
      return token.slice(prefix.length);
    }
  }
  return undefined;
}

function buildEmailHelperNetworkTargetsCommand(command: string): string | null {
  const tokens = splitCommandTokens(command);
  const scriptIndex = tokens.findIndex(
    (token) =>
      token.replace(/\\/g, '/').toLowerCase().endsWith('/email_helper.py') ||
      token.toLowerCase() === 'email_helper.py'
  );
  if (scriptIndex < 0) return null;

  const action = commandOptionValue(tokens, '--action');
  if (action === 'network_targets' || action === 'setup_account') return null;

  const account = commandOptionValue(tokens, '--account') ?? 'default';
  const prefix = tokens
    .slice(0, scriptIndex + 1)
    .map(shellQuoteArg)
    .join(' ');
  return `${prefix} --action network_targets --account ${shellQuoteArg(account)}`;
}

function buildGenericNetworkTargetsCommand(command: string): string | null {
  const tokens = splitCommandTokens(command);
  const scriptIndex = tokens.findIndex((token) =>
    /\.(py|js|mjs|cjs|sh|ps1)$/i.test(token.replace(/\\/g, '/'))
  );
  if (scriptIndex < 0) return null;

  const action = commandOptionValue(tokens, '--action');
  if (action === 'network_targets' || action === 'setup_account') return null;

  const preservedOptions = [
    '--account',
    '--profile',
    '--target',
    '--host',
    '--port',
    '--protocol',
    '--url',
    '--dsn',
  ].flatMap((option) => {
    const value = commandOptionValue(tokens, option);
    return value ? [`${option} ${shellQuoteArg(value)}`] : [];
  });
  const prefix = tokens
    .slice(0, scriptIndex + 1)
    .map(shellQuoteArg)
    .join(' ');
  return [`${prefix} --action network_targets`, ...preservedOptions].join(' ');
}

function buildNetworkTargetsCommand(
  command: string,
  allowGenericLegacyEntrypoint: boolean
): string | null {
  return (
    buildEmailHelperNetworkTargetsCommand(command) ??
    (allowGenericLegacyEntrypoint ? buildGenericNetworkTargetsCommand(command) : null)
  );
}

function normalizeNetworkDirectTarget(value: unknown): NetworkDirectTarget | null {
  if (!isRecord(value)) return null;
  const protocol = typeof value.protocol === 'string' ? value.protocol.trim().toLowerCase() : '';
  const host = typeof value.host === 'string' ? value.host.trim().toLowerCase() : '';
  const port =
    typeof value.port === 'number'
      ? value.port
      : typeof value.port === 'string'
        ? Number.parseInt(value.port, 10)
        : NaN;
  if (!protocol || !host || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return null;
  }
  const resolvedRisk =
    typeof value.resolvedRisk === 'string' &&
    ['public', 'private', 'metadata', 'unknown'].includes(value.resolvedRisk)
      ? (value.resolvedRisk as NetworkDirectTarget['resolvedRisk'])
      : undefined;
  const resolvedIpSamples = Array.isArray(value.resolvedIpSamples)
    ? value.resolvedIpSamples.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
  const resolvedRiskReason =
    typeof value.resolvedRiskReason === 'string' ? value.resolvedRiskReason : undefined;
  return {
    protocol,
    host,
    port,
    ...(resolvedRisk ? { resolvedRisk } : {}),
    ...(resolvedIpSamples ? { resolvedIpSamples } : {}),
    ...(resolvedRiskReason ? { resolvedRiskReason } : {}),
  };
}

function parseNetworkTargetsOutput(output: string): NetworkDirectTarget[] {
  const trimmed = output.trim();
  if (!trimmed) return [];

  const candidates = [
    trimmed,
    ...trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('{') || line.startsWith('[')),
  ];

  const targets: NetworkDirectTarget[] = [];
  for (const candidate of candidates) {
    try {
      const entry = JSON.parse(candidate) as unknown;
      const rawTargets = Array.isArray(entry)
        ? entry
        : isRecord(entry) && Array.isArray(entry.targets)
          ? entry.targets
          : [];
      for (const rawTarget of rawTargets) {
        const target = normalizeNetworkDirectTarget(rawTarget);
        if (
          target &&
          !targets.some(
            (existing) =>
              existing.protocol === target.protocol &&
              existing.host === target.host &&
              existing.port === target.port
          )
        ) {
          targets.push(target);
        }
      }
    } catch {
      // Ignore non-JSON progress lines emitted by helper scripts.
    }
  }
  return targets;
}

function networkDirectTargetsFromAllowances(
  allowances: NetworkDirectAllowance[]
): NetworkDirectTarget[] {
  return allowances.map((allowance) => ({
    protocol: allowance.protocol,
    host: allowance.host,
    port: allowance.port,
  }));
}

// ==================== ExternalExecutor 实现 ====================

async function annotateNetworkDirectTargetRisks(
  targets: NetworkDirectTarget[]
): Promise<NetworkDirectTarget[]> {
  if (targets.length === 0) return targets;
  try {
    return await invoke<NetworkDirectTarget[]>('sandbox_network_direct_target_risks', { targets });
  } catch (error) {
    logger.warn('[ExternalExecutor] network direct target risk resolution failed:', error);
    return targets;
  }
}

export class ExternalExecutor {
  private readonly shellExecute: ShellExecuteFn;
  private readonly isWindows: boolean;

  /**
   * @param shellExecute Shell 执行函数（依赖注入）
   * @param isWindows 是否 Windows 环境（依赖注入，用于解释器路径和参数转义策略）
   */
  constructor(shellExecute: ShellExecuteFn, isWindows?: boolean) {
    this.shellExecute = shellExecute;
    // 依赖注入操作系统标志，默认通过 userAgent 判断
    this.isWindows =
      isWindows ?? (typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent));
  }

  /**
   * 执行 Script 模式 Skill
   *
   * 根据 ExecutionContract 构造完整命令行，通过 Shell 执行，
   * 并截取输出到 maxOutput 字节限制内。
   *
   * @param contract 已验证的 Execution Contract
   * @param args LLM 传入的工具参数（已通过 ContractValidator.validateArgs 验证）
   * @param packagePath 技能包绝对路径
   * @param venvPath Python venv 的绝对路径（仅 python runtime 需要）
   * @returns 脚本执行结果
   */
  async execute(
    contract: ExecutionContract,
    args: Record<string, unknown>,
    packagePath: string,
    venvPath?: string,
    options: ExternalExecutionOptions = {}
  ): Promise<ScriptExecutionResult> {
    const startTime = Date.now();
    const cancelledResult = (): ScriptExecutionResult => ({
      exitCode: -1,
      stdout: '',
      stderr: translate('tools.common.toolExecutionCancelled'),
      durationMs: Date.now() - startTime,
      timedOut: false,
    });

    try {
      if (options.signal?.aborted) {
        return cancelledResult();
      }

      if (
        this.requiresDesktopCapability(contract) &&
        options.sandboxMode &&
        options.sandboxMode !== 'LocalAudit'
      ) {
        return {
          exitCode: -1,
          stdout: '',
          stderr: translate('tools.external.desktopCapabilityBlocked'),
          durationMs: Date.now() - startTime,
          timedOut: false,
        };
      }

      // 构造完整命令
      const command = this.buildCommand(contract, args, packagePath, venvPath);
      const env = this.resolveExecutionEnv(contract, options);
      const executionWorkdir = options.workdir ?? packagePath;
      if (options.workdir) {
        env.AGENTVIS_WORKDIR = options.workdir;
        env.AGENTVIS_DELIVERABLE_DIR = options.workdir;
        env.AGENTVIS_SKILL_PACKAGE_DIR = packagePath;
      }
      const sandboxOptions = this.resolveSandboxOptions(options.sandboxMode, contract);
      const processLifecycle = this.resolveProcessLifecycle(contract);
      const subjectId = this.deriveSubjectId(packagePath);
      const executionId = options.signal ? createShellExecutionId(subjectId) : undefined;
      const appContainerFilesystemGrants = this.resolveAppContainerFilesystemGrants(contract, args);
      const shellParams: Parameters<ShellExecuteFn>[0] = {
        command,
        workdir: executionWorkdir,
        timeout: contract.timeout,
        background: false,
        ...(executionId ? { executionId } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
        sandboxLevel: 'externalSkill',
        sandboxNetwork: this.resolveSandboxNetwork(contract),
        ...sandboxOptions,
        processLifecycle,
        subjectType: 'skill',
        subjectId,
        ...(contract.credentials?.length ? { networkBrokerCredentials: contract.credentials } : {}),
        ...(appContainerFilesystemGrants.length > 0 ? { appContainerFilesystemGrants } : {}),
      };

      logger.trace('[ExternalExecutor] Script Skill shell execution prepared', {
        subjectId,
        runtime: contract.runtime,
        entry: contract.entry,
        packagePath,
        sandboxMode: shellParams.sandboxMode,
        sandboxLevel: shellParams.sandboxLevel,
        sandboxNetwork: shellParams.sandboxNetwork,
        networkScope: shellParams.networkScope,
        processLifecycle,
        brokerOnly: this.isBrokerOnlyNetwork(contract),
        credentialRefs: contract.credentials?.map((credential) => credential.id).sort() ?? [],
        filesystemGrantArgs:
          contract.permissions?.filesystem?.map((grant) => grant.fromArg).sort() ?? [],
        envKeys: Object.keys(env).sort(),
        argKeys: Object.keys(args).sort(),
        hasVenv: Boolean(venvPath),
      });

      // 通过 Shell 执行；必要时走非 HTTP(S) direct-audit 授权后重试一次。
      const cancelShellExecution = (): void => {
        if (!executionId) return;
        invoke('shell_cancel', { executionId }).catch((cancelError: unknown) => {
          logger.warn('[ExternalExecutor] cancel shell execution failed:', cancelError);
        });
      };
      options.signal?.addEventListener('abort', cancelShellExecution, { once: true });

      let result: Awaited<ReturnType<ShellExecuteFn>>;
      try {
        result = await this.executeWithNetworkDirectAuthorization(
          shellParams,
          command,
          executionWorkdir,
          contract.timeout,
          options
        );
      } finally {
        options.signal?.removeEventListener('abort', cancelShellExecution);
      }

      if (options.signal?.aborted) {
        return cancelledResult();
      }

      const durationMs = Date.now() - startTime;

      // 截取输出（控制在 maxOutput 字节限制内）
      const stdout = this.truncateOutput(
        redactSensitiveObservation(result.stdout),
        contract.maxOutput
      );
      const stderr = this.truncateOutput(
        redactSensitiveObservation(result.stderr),
        contract.maxOutput
      );

      logger.trace('[ExternalExecutor] Script Skill shell execution completed', {
        subjectId,
        entry: contract.entry,
        exitCode: result.exitCode,
        durationMs,
        stdoutChars: stdout.length,
        stderrChars: stderr.length,
      });

      return {
        exitCode: result.exitCode,
        stdout,
        stderr,
        durationMs,
        timedOut: result.timedOut ?? false,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const rawErrorMessage = error instanceof Error ? error.message : String(error);
      const errorMessage = redactSensitiveObservation(rawErrorMessage);

      // 检测超时错误（Tauri 后端在超时时可能抛出特定错误）
      const isTimeout = errorMessage.includes('timeout') || errorMessage.includes('timed out');

      logger.debug('[ExternalExecutor] Script Skill shell execution failed', {
        runtime: contract.runtime,
        entry: contract.entry,
        packagePath,
        sandboxMode: options.sandboxMode ?? 'LocalAudit',
        durationMs,
        timedOut: isTimeout,
        error: errorMessage,
      });

      return {
        exitCode: -1,
        stdout: '',
        stderr: isTimeout
          ? `Execution timed out (${contract.timeout}s): ${errorMessage}`
          : this.formatExecutionError(errorMessage),
        durationMs,
        timedOut: isTimeout,
      };
    }
  }

  /**
   * 构造完整命令行
   *
   * 根据 runtime 类型和 venv 路径构造可执行命令。
   * 参数按 --name value 格式追加（布尔参数仅追加 --name）。
   */
  buildCommand(
    contract: ExecutionContract,
    args: Record<string, unknown>,
    packagePath: string,
    venvPath?: string
  ): string {
    // 入口脚本的完整路径（相对于技能包目录）
    const entryPath = `${packagePath}/${contract.entry}`.replace(/\\/g, '/');

    // 根据 runtime 确定解释器
    const interpreter = this.resolveInterpreter(contract.runtime, venvPath);

    // 构建基础命令
    let command = `${interpreter} "${entryPath}"`;

    // 追加参数
    for (const [name, value] of Object.entries(args)) {
      // 仅传递 Contract 中声明的参数
      const argDef = contract.argsSchema.find((a) => a.name === name);
      if (!argDef) continue;

      if (argDef.type === 'boolean') {
        // 布尔参数：true 时追加 --name，false 时不追加
        if (value === true) {
          command += ` --${name}`;
        }
      } else {
        // 字符串/数字参数：--name "value"
        const escapedValue = this.escapeShellArg(String(value));
        command += ` --${name} ${escapedValue}`;
      }
    }

    return command;
  }

  private async executeWithNetworkDirectAuthorization(
    shellParams: Parameters<ShellExecuteFn>[0],
    command: string,
    workdir: string,
    timeout: number,
    options: ExternalExecutionOptions
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const subjectId = shellParams.subjectId;
    const sessionAllowances = options.enableNetworkDirectAuthorization
      ? activeNetworkDirectAllowancesForSubject('skill', subjectId)
      : [];
    const firstAttemptParams =
      sessionAllowances.length > 0
        ? {
            ...shellParams,
            networkDirectAllowances: sessionAllowances,
            networkDirectTargets: networkDirectTargetsFromAllowances(sessionAllowances),
          }
        : shellParams;

    try {
      return await this.shellExecute(firstAttemptParams);
    } catch (error) {
      const errorMessage = redactSensitiveObservation(
        error instanceof Error ? error.message : String(error)
      );
      const reasonCode = this.extractSandboxReasonCode(errorMessage);
      if (reasonCode && NETWORK_RISK_CONFIRMATION_REASON_CODES.has(reasonCode)) {
        const confirmed = await requestNetworkUploadAuthorization({
          command,
          workdir,
          subjectType: 'skill',
          subjectId,
          reasonCode,
          reason: errorMessage,
          riskKind: networkRiskKindFromReasonCode(reasonCode),
        });
        if (!confirmed) {
          throw error;
        }
        return this.shellExecute({
          ...firstAttemptParams,
          ...networkRiskConfirmationFlags(reasonCode),
        });
      }
      if (!options.enableNetworkDirectAuthorization) {
        throw error;
      }
      const retryGrant = await this.requestNetworkDirectAllowances(
        command,
        workdir,
        timeout,
        shellParams,
        errorMessage,
        options.networkEntrypointMode
      );
      if (!retryGrant?.allowances.length) {
        throw error;
      }

      const mergedAllowances = [...sessionAllowances, ...retryGrant.allowances];
      return this.shellExecute({
        ...shellParams,
        networkDirectAllowances: mergedAllowances,
        networkDirectTargets: retryGrant.targets,
      });
    }
  }

  private async requestNetworkDirectAllowances(
    command: string,
    workdir: string,
    timeout: number,
    shellParams: Parameters<ShellExecuteFn>[0],
    errorMessage: string,
    networkEntrypointMode?: SkillAgentVisNetworkEntrypointMode
  ): Promise<NetworkDirectAuthorizationGrant | null> {
    if (this.extractSandboxReasonCode(errorMessage) !== 'proxy_bypass_signal_blocked') {
      return null;
    }

    const targets = await this.resolveNetworkDirectTargetsForAuthorization(
      command,
      workdir,
      timeout,
      shellParams,
      networkEntrypointMode
    );
    if (targets.length === 0) {
      return null;
    }

    const allowances = await requestNetworkDirectAuthorization({
      command,
      workdir,
      subjectType: 'skill',
      subjectId: shellParams.subjectId,
      targets,
      reasonCode: 'proxy_bypass_signal_blocked',
      reason: errorMessage,
    });
    return allowances ? { allowances, targets } : null;
  }

  private async resolveNetworkDirectTargetsForAuthorization(
    command: string,
    workdir: string,
    timeout: number,
    shellParams: Parameters<ShellExecuteFn>[0],
    networkEntrypointMode?: SkillAgentVisNetworkEntrypointMode
  ): Promise<NetworkDirectTarget[]> {
    let inspection: NetworkDirectTargetInspection;
    try {
      inspection = await invoke<NetworkDirectTargetInspection>('sandbox_network_direct_targets', {
        command,
        workdir,
      });
    } catch (error) {
      logger.warn('[ExternalExecutor] network direct target inspection failed:', error);
      return [];
    }

    if (inspection.targets.length > 0) {
      return inspection.targets;
    }

    const allowGenericLegacyEntrypoint = networkEntrypointMode === 'legacyNonHttp';
    if (inspection.requiredProtocols.length === 0 && !allowGenericLegacyEntrypoint) {
      return [];
    }

    const preflightCommand = buildNetworkTargetsCommand(command, allowGenericLegacyEntrypoint);
    if (!preflightCommand) {
      return [];
    }

    const preflightBase = { ...shellParams };
    delete preflightBase.networkDirectAllowances;
    delete preflightBase.networkDirectTargets;

    const preflightResult = await this.shellExecute({
      ...preflightBase,
      command: preflightCommand,
      workdir,
      timeout: Math.min(timeout, 30),
      background: false,
      processLifecycle: 'managed',
    });
    if (preflightResult.exitCode !== 0) {
      logger.warn('[ExternalExecutor] network direct preflight failed:', preflightResult.stderr);
      return [];
    }

    return annotateNetworkDirectTargetRisks(parseNetworkTargetsOutput(preflightResult.stdout));
  }

  /**
   * 根据 runtime 类型解析解释器路径
   *
   * Python runtime 优先使用 venv 中的 python，
   * 找不到时回退到系统 python。
   */
  private resolveInterpreter(runtime: string, venvPath?: string): string {
    switch (runtime) {
      case 'python': {
        if (venvPath) {
          // Windows venv 的 python 在 Scripts/ 目录
          // Unix venv 的 python 在 bin/ 目录
          const pythonBin = this.isWindows
            ? `"${venvPath}/Scripts/python.exe"`
            : `"${venvPath}/bin/python"`;
          return pythonBin;
        }
        return 'python';
      }
      case 'bash':
        return 'bash';
      case 'node':
        return 'node';
      default:
        return runtime;
    }
  }

  /**
   * 转义 Shell 参数值
   *
   * Windows: 使用双引号包裹，额外转义 $、反引号等危险字符
   * Unix: 使用单引号包裹（单引号内所有字符为字面量，仅需处理单引号本身）
   */
  private escapeShellArg(value: string): string {
    if (this.isWindows) {
      // Windows CMD / PowerShell：双引号包裹，转义所有危险字符
      const escaped = value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/`/g, '\\`')
        .replace(/\$/g, '\\$');
      return `"${escaped}"`;
    }
    // Unix (bash/sh/zsh)：单引号内所有字符为字面量
    // 唯一需处理的是单引号本身：' → '\'' (结束单引号 + 转义单引号 + 开始新单引号)
    const escaped = value.replace(/'/g, "'\\''");
    return `'${escaped}'`;
  }

  /**
   * 截取输出到指定字节限制
   *
   * 超出限制时在末尾追加截断提示
   */
  private truncateOutput(output: string, maxBytes: number): string {
    if (maxBytes <= 0) {
      return '';
    }

    const encoder = new TextEncoder();
    if (encoder.encode(output).length <= maxBytes) {
      return output;
    }

    const marker = '\n\n... [output truncated] ...';
    const markerBytes = encoder.encode(marker).length;
    if (markerBytes >= maxBytes) {
      return this.truncateUtf8(marker, maxBytes, encoder);
    }

    const truncated = this.truncateUtf8(output, maxBytes - markerBytes, encoder);
    return truncated + marker;
  }

  private resolveSandboxNetwork(contract: ExecutionContract): 'inherit' | 'audit' | 'blocked' {
    if (this.isBrokerOnlyNetwork(contract)) {
      return 'blocked';
    }
    if (contract.permissions?.network === true) {
      return 'inherit';
    }
    if (contract.permissions?.network === false) {
      return 'blocked';
    }
    return 'audit';
  }

  private isBrokerOnlyNetwork(contract: ExecutionContract): boolean {
    return contract.permissions?.networkMode === 'brokerOnly';
  }

  private resolveExecutionEnv(
    contract: ExecutionContract,
    options: ExternalExecutionOptions = {}
  ): Record<string, string> {
    const env: Record<string, string> = {};
    if (this.isBrokerOnlyNetwork(contract)) {
      return this.resolveBrokerOnlyExecutionEnv();
    }

    if (options.networkFallback === 'brokerProxyPreferred') {
      env.AGENTVIS_NETWORK_EGRESS_GUARD_FALLBACK = 'brokerProxyPreferred';
    }

    return env;
  }

  private resolveBrokerOnlyExecutionEnv(): Record<string, string> {
    return {
      AGENTVIS_BROKER_MODE: 'explicit',
      AGENTVIS_NETWORK_BROKER_MODE: 'required',
      AGENTVIS_NETWORK_DIRECT_ACCESS: 'blocked',
    };
  }

  private requiresDesktopCapability(contract: ExecutionContract): boolean {
    return (
      contract.permissions?.desktopLaunch === true || contract.permissions?.desktopControl === true
    );
  }

  private resolveProcessLifecycle(contract: ExecutionContract): 'managed' | 'detachedLaunch' {
    return this.requiresDesktopCapability(contract) ? 'detachedLaunch' : 'managed';
  }

  private resolveAppContainerFilesystemGrants(
    contract: ExecutionContract,
    args: Record<string, unknown>
  ): ShellFilesystemGrant[] {
    const grants = contract.permissions?.filesystem ?? [];
    const result: ShellFilesystemGrant[] = [];

    for (const grant of grants) {
      const value = args[grant.fromArg];
      if (typeof value !== 'string' || value.trim().length === 0) {
        continue;
      }
      result.push({
        path: value,
        access: grant.access,
      });
    }

    return result;
  }

  private resolveSandboxOptions(
    sandboxMode: ExternalExecutionOptions['sandboxMode'],
    contract: ExecutionContract
  ): Pick<
    Parameters<ShellExecuteFn>[0],
    'sandboxMode' | 'sandboxLevel' | 'sandboxNetwork' | 'networkScope'
  > {
    switch (sandboxMode ?? 'LocalAudit') {
      case 'OfflineIsolated':
        return {
          sandboxMode: 'OfflineIsolated',
          sandboxLevel: 'restricted',
          sandboxNetwork: 'blocked',
          networkScope: 'blocked',
        };
      case 'ControlledNetwork':
        // 默认受控联网使用本机文件空间 + broker-preferred audit；
        // blocked / brokerOnly 仍由后端保留 AppContainer deny-all 的硬隔离路径。
        return {
          sandboxMode: 'ControlledNetwork',
          sandboxLevel: 'restricted',
          sandboxNetwork: this.resolveSandboxNetwork(contract) === 'blocked' ? 'blocked' : 'audit',
          networkScope:
            this.resolveSandboxNetwork(contract) === 'blocked' ? 'blocked' : 'internetAudit',
        };
      case 'LocalAudit':
      default:
        return {
          sandboxMode: 'LocalAudit',
          sandboxLevel: 'externalSkill',
          sandboxNetwork: this.resolveSandboxNetwork(contract),
          networkScope:
            this.resolveSandboxNetwork(contract) === 'blocked' ? 'blocked' : 'internetAudit',
        };
    }
  }

  private deriveSubjectId(packagePath: string): string {
    const normalized = packagePath.replace(/\\/g, '/').replace(/\/+$/, '');
    return normalized.split('/').pop() ?? 'external-skill';
  }

  private formatExecutionError(errorMessage: string): string {
    if (
      errorMessage.includes('Sandbox block') ||
      errorMessage.includes('sandbox block') ||
      errorMessage.includes('沙箱')
    ) {
      const reasonCode = this.extractSandboxReasonCode(errorMessage);
      let formatted: string;
      if (reasonCode === 'proxy_bypass_signal_blocked') {
        formatted = translate('tools.sandboxGuard.proxyBypassSignalBlocked', {
          error: errorMessage,
        });
      } else if (reasonCode === 'broker_proxy_required_unavailable') {
        formatted = translate('tools.sandboxGuard.brokerProxyRequiredUnavailable', {
          error: errorMessage,
        });
      } else if (reasonCode === 'network_upload_confirmation_required') {
        formatted = translate('tools.sandboxGuard.networkUploadConfirmationRequired', {
          error: errorMessage,
        });
      } else if (reasonCode === 'network_sensitive_egress_confirmation_required') {
        formatted = translate('tools.sandboxGuard.networkSensitiveEgressConfirmationRequired', {
          error: errorMessage,
        });
      } else if (reasonCode === 'network_remote_destructive_confirmation_required') {
        formatted = translate('tools.sandboxGuard.networkRemoteDestructiveConfirmationRequired', {
          error: errorMessage,
        });
      } else if (reasonCode === 'network_direct_metadata_target_blocked') {
        formatted = translate('tools.sandboxGuard.networkDirectMetadataBlocked', {
          error: errorMessage,
        });
      } else if (reasonCode === 'network_direct_private_session_scope_blocked') {
        formatted = translate('tools.sandboxGuard.networkDirectPrivateSessionBlocked', {
          error: errorMessage,
        });
      } else {
        formatted = translate('tools.external.sandboxBlocked', { error: errorMessage });
      }
      return `${formatted}\n\n${translate('tools.external.scriptSandboxHint')}`;
    }
    return `Execution failed: ${errorMessage}`;
  }

  private extractSandboxReasonCode(errorMessage: string): string | undefined {
    return errorMessage.match(/Sandbox block \[([\w-]+)\]/)?.[1];
  }

  private truncateUtf8(input: string, maxBytes: number, encoder: TextEncoder): string {
    let usedBytes = 0;
    let endIndex = 0;

    for (const char of input) {
      const charBytes = encoder.encode(char).length;
      if (usedBytes + charBytes > maxBytes) {
        break;
      }
      usedBytes += charBytes;
      endIndex += char.length;
    }

    return input.slice(0, endIndex);
  }
}
