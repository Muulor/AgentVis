/**
 * ContractValidator - Execution Contract 验证器
 *
 * 验证 Script 模式 Skill 的 Execution Contract 完整性和合法性。
 * 同时负责验证运行时工具调用参数是否符合 Contract 约束。
 *
 * 设计理念：
 * - Contract 缺失或不完整 → 拒绝以 Script 模式加载
 * - 运行时参数不合规 → 拒绝执行并返回详细错误
 * - 所有验证结果使用 Result 模式，不抛异常
 */

import type {
    BrokerCredentialRef,
    ExecutionContract,
    ExternalSkillFrontmatter,
    ContractArg,
} from './types';
import {
    DEFAULT_TIMEOUT_SECONDS,
    DEFAULT_MAX_OUTPUT_BYTES,
    SUPPORTED_RUNTIMES,
    NATIVE_SKILL_NAMES,
} from './types';

const SUPPORTED_NETWORK_MODES = ['direct', 'brokerOnly'];
const SUPPORTED_CREDENTIAL_MODES = ['brokerAuth'];
const SUPPORTED_FILESYSTEM_ACCESS = ['readOnly', 'readWrite'];
const DEFAULT_MAX_TIMEOUT_SECONDS = 300;
const LONG_RUNNING_MAX_TIMEOUT_SECONDS = 1800;

// ==================== 验证结果类型 ====================

/**
 * 验证结果（Result 模式）
 */
export type ValidationResult =
    | { valid: true; contract: ExecutionContract }
    | { valid: false; errors: string[] };

/**
 * 参数验证结果
 */
export type ArgValidationResult =
    | { valid: true }
    | { valid: false; errors: string[] };

// ==================== ContractValidator 实现 ====================

/**
 * 从 SKILL.md frontmatter 解析并验证 Execution Contract
 *
 * 对于 frontmatter.execution 中缺省的字段，使用默认值填充。
 * 对于必须字段（runtime, entry），缺失则验证失败。
 *
 * @param frontmatter SKILL.md 解析后的 frontmatter
 * @returns 验证结果，包含完整的 ExecutionContract 或错误列表
 */
export function validateContract(
    frontmatter: ExternalSkillFrontmatter
): ValidationResult {
    const errors: string[] = [];
    const exec = frontmatter.execution;

    // 必须有 execution 字段
    if (!exec) {
        return {
            valid: false,
            errors: ['Missing execution field; Script-mode Skill must declare an Execution Contract'],
        };
    }

    // 验证 runtime（必须）
    if (!exec.runtime) {
        errors.push('Missing execution.runtime field');
    } else if (!SUPPORTED_RUNTIMES.includes(exec.runtime)) {
        errors.push(
            `Unsupported runtime: "${exec.runtime}". Supported values: ${SUPPORTED_RUNTIMES.join(', ')}`
        );
    }

    // 验证 entry（必须）
    if (!exec.entry) {
        errors.push('Missing execution.entry field (entry script path)');
    } else if (typeof exec.entry !== 'string' || exec.entry.trim().length === 0) {
        errors.push('execution.entry must be a non-empty string');
    }

    // 验证 permissions（可选）
    const rawPermissions = exec.permissions as unknown;
    let longRunning = false;
    if (rawPermissions !== undefined) {
        if (
            typeof rawPermissions !== 'object' ||
            rawPermissions === null ||
            Array.isArray(rawPermissions)
        ) {
            errors.push('execution.permissions must be an object');
        } else {
            const networkPermission = (rawPermissions as Record<string, unknown>).network;
            if (
                networkPermission !== undefined &&
                typeof networkPermission !== 'boolean'
            ) {
                errors.push('execution.permissions.network must be a boolean');
            }
            const networkMode = (rawPermissions as Record<string, unknown>).networkMode;
            if (
                networkMode !== undefined &&
                (typeof networkMode !== 'string' || !SUPPORTED_NETWORK_MODES.includes(networkMode))
            ) {
                errors.push('execution.permissions.networkMode must be direct or brokerOnly');
            }
            if (networkPermission === false && networkMode === 'brokerOnly') {
                errors.push('execution.permissions.network=false conflicts with networkMode=brokerOnly');
            }
            const filesystemPermission = (rawPermissions as Record<string, unknown>).filesystem;
            if (filesystemPermission !== undefined) {
                if (!Array.isArray(filesystemPermission)) {
                    errors.push('execution.permissions.filesystem must be an array');
                } else {
                    errors.push(...validateFilesystemGrants(filesystemPermission, exec.argsSchema));
                }
            }
            const longRunningPermission = (rawPermissions as Record<string, unknown>).longRunning;
            if (
                longRunningPermission !== undefined &&
                typeof longRunningPermission !== 'boolean'
            ) {
                errors.push('execution.permissions.longRunning must be a boolean');
            }
            longRunning = longRunningPermission === true;
            const desktopLaunchPermission = (rawPermissions as Record<string, unknown>).desktopLaunch;
            if (
                desktopLaunchPermission !== undefined &&
                typeof desktopLaunchPermission !== 'boolean'
            ) {
                errors.push('execution.permissions.desktopLaunch must be a boolean');
            }
            const desktopControlPermission = (rawPermissions as Record<string, unknown>).desktopControl;
            if (
                desktopControlPermission !== undefined &&
                typeof desktopControlPermission !== 'boolean'
            ) {
                errors.push('execution.permissions.desktopControl must be a boolean');
            }
        }
    }

    // 验证 timeout（可选，有默认值）
    if (exec.timeout !== undefined) {
        const maxTimeout = longRunning
            ? LONG_RUNNING_MAX_TIMEOUT_SECONDS
            : DEFAULT_MAX_TIMEOUT_SECONDS;
        if (typeof exec.timeout !== 'number' || exec.timeout <= 0) {
            errors.push('execution.timeout must be a positive number');
        } else if (exec.timeout > maxTimeout) {
            errors.push(`execution.timeout cannot exceed ${maxTimeout} seconds`);
        }
    }

    // 验证 maxOutput（可选，有默认值）
    if (exec.maxOutput !== undefined) {
        if (typeof exec.maxOutput !== 'number' || exec.maxOutput <= 0) {
            errors.push('execution.maxOutput must be a positive number');
        } else if (exec.maxOutput > 10 * 1024 * 1024) {
            // 上限 10MB，防止内存溢出
            errors.push('execution.maxOutput cannot exceed 10MB');
        }
    }

    // 验证 argsSchema（可选）
    if (exec.argsSchema) {
        if (!Array.isArray(exec.argsSchema)) {
            errors.push('execution.argsSchema must be an array');
        } else {
            const argErrors = validateArgsSchema(exec.argsSchema);
            errors.push(...argErrors);
        }
    }

    if (exec.credentials !== undefined) {
        if (!Array.isArray(exec.credentials)) {
            errors.push('execution.credentials must be an array');
        } else {
            errors.push(...validateBrokerCredentials(exec.credentials));
        }

        const networkMode = rawPermissions && typeof rawPermissions === 'object' && !Array.isArray(rawPermissions)
            ? (rawPermissions as Record<string, unknown>).networkMode
            : undefined;
        if (networkMode !== 'brokerOnly') {
            errors.push('execution.credentials requires execution.permissions.networkMode=brokerOnly');
        }
    }

    if (errors.length > 0) {
        return { valid: false, errors };
    }

    const runtime = exec.runtime;
    const entry = exec.entry;
    if (!runtime || !entry) {
        return { valid: false, errors: ['execution.runtime and execution.entry are required'] };
    }

    // 构造完整 Contract（填充默认值）
    const contract: ExecutionContract = {
        runtime,
        entry,
        timeout: exec.timeout ?? DEFAULT_TIMEOUT_SECONDS,
        maxOutput: exec.maxOutput ?? DEFAULT_MAX_OUTPUT_BYTES,
        argsSchema: exec.argsSchema ?? [],
        env: exec.env,
        credentials: exec.credentials,
        permissions: exec.permissions,
    };

    return { valid: true, contract };
}

/**
 * 验证运行时工具调用参数是否符合 Contract
 *
 * @param args LLM 传入的工具参数
 * @param contract 已验证的 Execution Contract
 * @returns 参数验证结果
 */
export function validateArgs(
    args: Record<string, unknown>,
    contract: ExecutionContract
): ArgValidationResult {
    const errors: string[] = [];

    // 检查必填参数
    for (const argDef of contract.argsSchema) {
        if (argDef.required && !(argDef.name in args)) {
            errors.push(`Missing required argument: ${argDef.name}`);
        }
    }

    // 检查参数类型
    const validArgNames = new Set(contract.argsSchema.map(a => a.name));
    for (const [key, value] of Object.entries(args)) {
        // 跳过未知参数（宽容策略，仅警告不阻断）
        if (!validArgNames.has(key)) {
            continue;
        }

        const argDef = contract.argsSchema.find(a => a.name === key);
        if (!argDef) continue;

        // 类型检查
        const actualType = typeof value;
        if (argDef.type === 'string' && actualType !== 'string') {
            errors.push(`Argument ${key} has invalid type: expected string, got ${actualType}`);
        } else if (argDef.type === 'number' && actualType !== 'number') {
            errors.push(`Argument ${key} has invalid type: expected number, got ${actualType}`);
        } else if (argDef.type === 'boolean' && actualType !== 'boolean') {
            errors.push(`Argument ${key} has invalid type: expected boolean, got ${actualType}`);
        }
    }

    if (errors.length > 0) {
        return { valid: false, errors };
    }

    return { valid: true };
}

/**
 * 验证技能名称是否与 Native Skill 冲突
 *
 * @param name 技能名称
 * @returns 是否冲突
 */
export function isNativeSkillConflict(name: string): boolean {
    return NATIVE_SKILL_NAMES.includes(name);
}

/**
 * 验证技能名称格式合法性
 *
 * 规则：小写字母、数字、连字符，不能以连字符开头或结尾
 *
 * @param name 技能名称
 * @returns 是否合法
 */
export function isValidSkillName(name: string): boolean {
    return /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(name) || /^[a-z0-9]$/.test(name);
}

// ==================== 内部辅助函数 ====================

/**
 * 验证 argsSchema 数组中每个参数定义的合法性
 */
function validateArgsSchema(argsSchema: unknown[]): string[] {
    const errors: string[] = [];
    const seenNames = new Set<string>();
    const validArgTypes = ['string', 'number', 'boolean'];

    for (let i = 0; i < argsSchema.length; i++) {
        const rawArg = argsSchema[i];
        const prefix = `argsSchema[${i}]`;

        if (!rawArg || typeof rawArg !== 'object') {
            errors.push(`${prefix}: must be an object`);
            continue;
        }
        const arg = rawArg as Partial<ContractArg>;

        if (!arg.name || typeof arg.name !== 'string') {
            errors.push(`${prefix}: missing name or name is not a string`);
        } else if (seenNames.has(arg.name)) {
            errors.push(`${prefix}: duplicate name "${arg.name}"`);
        } else {
            seenNames.add(arg.name);
        }

        if (!arg.type || !validArgTypes.includes(arg.type)) {
            errors.push(
                        `${prefix}: type must be one of ${validArgTypes.join(' | ')}, got "${arg.type ?? 'undefined'}"`
            );
        }

        if (typeof arg.required !== 'boolean') {
            errors.push(`${prefix}: required must be boolean`);
        }

        if (!arg.description || typeof arg.description !== 'string') {
            errors.push(`${prefix}: missing description or description is not a string`);
        }
    }

    return errors;
}

function validateFilesystemGrants(
    grants: unknown[],
    argsSchema: unknown
): string[] {
    const errors: string[] = [];
    const stringArgs = new Set<string>();
    if (Array.isArray(argsSchema)) {
        for (const arg of argsSchema) {
            if (!arg || typeof arg !== 'object') continue;
            const typedArg = arg as Partial<ContractArg>;
            if (typedArg.type === 'string' && typeof typedArg.name === 'string') {
                stringArgs.add(typedArg.name);
            }
        }
    }

    grants.forEach((rawGrant, index) => {
        const prefix = `permissions.filesystem[${index}]`;
        if (!rawGrant || typeof rawGrant !== 'object' || Array.isArray(rawGrant)) {
            errors.push(`${prefix}: must be an object`);
            return;
        }

        const grant = rawGrant as Record<string, unknown>;
        const fromArg = grant.fromArg;
        if (typeof fromArg !== 'string' || fromArg.trim().length === 0) {
            errors.push(`${prefix}.fromArg must be a non-empty string`);
        } else if (!stringArgs.has(fromArg)) {
            errors.push(`${prefix}.fromArg must reference a string argsSchema field`);
        }

        const access = grant.access;
        if (
            typeof access !== 'string' ||
            !SUPPORTED_FILESYSTEM_ACCESS.includes(access)
        ) {
            errors.push(`${prefix}.access must be readOnly or readWrite`);
        }
    });

    return errors;
}

function validateBrokerCredentials(credentials: unknown[]): string[] {
    const errors: string[] = [];
    const seenIds = new Set<string>();

    for (let i = 0; i < credentials.length; i++) {
        const rawCredential = credentials[i];
        const prefix = `execution.credentials[${i}]`;
        if (!rawCredential || typeof rawCredential !== 'object' || Array.isArray(rawCredential)) {
            errors.push(`${prefix}: must be an object`);
            continue;
        }

        const credential = rawCredential as Partial<BrokerCredentialRef>;
        if (!credential.id || typeof credential.id !== 'string' || !isSafeCredentialIdentifier(credential.id)) {
            errors.push(`${prefix}: id must contain only letters, numbers, dots, underscores, or hyphens`);
        } else if (seenIds.has(credential.id)) {
            errors.push(`${prefix}: duplicate id "${credential.id}"`);
        } else {
            seenIds.add(credential.id);
        }

        if (!credential.provider || typeof credential.provider !== 'string' || !isSafeCredentialIdentifier(credential.provider)) {
            errors.push(`${prefix}: provider must contain only letters, numbers, dots, underscores, or hyphens`);
        }

        if (!credential.mode || typeof credential.mode !== 'string' || !SUPPORTED_CREDENTIAL_MODES.includes(credential.mode)) {
            errors.push(`${prefix}: mode must be brokerAuth`);
        }

        if (!Array.isArray(credential.hosts) || credential.hosts.length === 0) {
            errors.push(`${prefix}: hosts must be a non-empty array`);
        } else {
            for (const host of credential.hosts) {
                if (typeof host !== 'string' || !isExactPublicHost(host)) {
                    errors.push(`${prefix}: hosts must be exact host names without scheme, port, wildcard, or path`);
                    break;
                }
            }
        }

        if (!credential.headerName || typeof credential.headerName !== 'string' || !isSafeHeaderName(credential.headerName)) {
            errors.push(`${prefix}: headerName must be a safe HTTP header name`);
        }

        if (typeof credential.headerValuePrefix !== 'string' || hasHeaderControlChars(credential.headerValuePrefix)) {
            errors.push(`${prefix}: headerValuePrefix must be a string without CR/LF characters`);
        }

        if (typeof credential.required !== 'boolean') {
            errors.push(`${prefix}: required must be boolean`);
        }
    }

    return errors;
}

function isSafeCredentialIdentifier(value: string): boolean {
    return /^[a-zA-Z0-9._-]+$/.test(value);
}

function isExactPublicHost(value: string): boolean {
    return /^[a-zA-Z0-9.-]+$/.test(value) &&
        !value.includes('..') &&
        !value.startsWith('.') &&
        !value.endsWith('.') &&
        !value.includes('*') &&
        !value.includes(':') &&
        !value.includes('/') &&
        value.toLowerCase() !== 'localhost';
}

function isSafeHeaderName(value: string): boolean {
    const lowerName = value.toLowerCase();
    return /^[!#$%&'*+\-.^_`|~0-9a-zA-Z]+$/.test(value) &&
        ![
            'host',
            'connection',
            'content-length',
            'proxy-authorization',
            'proxy-authenticate',
            'te',
            'trailer',
            'transfer-encoding',
            'upgrade',
        ].includes(lowerName);
}

function hasHeaderControlChars(value: string): boolean {
    return /[\r\n]/.test(value);
}
