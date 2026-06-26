/**
 * ExecSafetyPolicy - Exec 命令安全策略
 *
 * 定义安全命令白名单和绝对禁止命令黑名单，用于 SubAgentRunner 的命令级 Checkpoint 分流：
 * - 命中黑名单 → 绝对禁止，不进入 Checkpoint
 * - 匹配白名单 → 安全，跳过 Checkpoint
 * - 不匹配 → 高风险，触发 Checkpoint 回报 MasterBrain
 *
 * TS/Rust 双层差异说明：
 * - TS 层（本文件）使用正则 \b 词边界做精确匹配（第一道防线，快速反馈）
 * - Rust 层 (command_validator.rs) 使用 contains() 子串匹配（最后一道防线，宁误报不漏检）
 * - 两层覆盖范围基本一致，ACL 组合阻断（icacls/cacls/Set-Acl）双层均实现
 */

import { translate, type TranslationKey } from '@/i18n';

// ═══════════════════════════════════════════════════════════════
// 安全命令白名单
// ═══════════════════════════════════════════════════════════════

/**
 * 安全命令正则模式
 *
 * 每个正则匹配命令字符串的开头（trimmed），
 * 只有完整匹配子命令才放行，避免前缀误匹配
 */
export const SAFE_EXEC_PATTERNS: ReadonlyArray<RegExp> = [
    // ── Git 只读操作 ──
    /^git\s+(status|log|diff|branch|show|remote|tag|stash\s+list)(\s|$)/,

    // ── 文件系统浏览 & 目录导航（只读） ──
    /^(cd|ls|dir|find|grep|rg|cat|head|tail|wc|tree|pwd|echo|type|where|which)(\s|$)/,

    // ── Node.js 构建 & 测试 ──
    /^npm\s+run\s+(build|test|lint|check|format|dev|preview|typecheck)(\s|$)/,
    /^npx\s+(vitest|tsc|eslint|prettier|jest|agent-browser)(\s|$)/,
    /^agent-browser(\s|$)/,          // agent-browser CLI（技能包常用工具）
    /^(pnpm|yarn)\s+run\s+(build|test|lint|check|format)(\s|$)/,

    // ── Rust 构建 & 测试 ──
    /^cargo\s+(build|check|test|clippy|fmt|doc)(\s|$)/,
    /^rustc\s+--version(\s|$)/,

    // ── Go 构建 & 测试 ──
    /^go\s+(build|test|vet|fmt|doc|generate|env|version|list|mod\s+(tidy|verify|graph|download))(\s|$)/,

    // ── 脚本执行（用户委托的常见模式） ──
    // 真正危险的命令（diskpart/bcdedit/reg 等）已被 BLOCKED_EXEC_PATTERNS 双层拦截，
    // 脚本执行是用户任务的核心操作（如技能包 bat/py 脚本），无需 Checkpoint 阻拦
    /^python3?\s+/,                  // python script.py, python -m module, python3 xxx
    /^node\s+/,                      // node script.js
    /^cmd\s+\/c\s+/i,               // cmd /c script.bat（技能包常用模式）
    /^powershell\s+(-[Cc]ommand\s+|-[Ff]ile\s+)?/,  // powershell -Command / -File
    /^(bash|sh|zsh)\s+/,            // bash script.sh

    // ── Python 只读 ──
    /^pip\s+(list|show|freeze)(\s|$)/,

    // ── 文件操作（非删除类） ──
    // mkdir/move/copy 是日常操作；rm/del/rmdir 仍触发 Checkpoint
    /^(mkdir|md)(\s|$)/,
    /^(move|ren|rename)(\s|$)/i,
    /^(copy|cp|xcopy|robocopy)(\s|$)/i,

    // ── 版本 & 信息查询 ──
    /^(node|npm|cargo|go|python|pip|git|rustc|tsc)\s+(-v|--version|-V)(\s|$)/,
    /^npm\s+(outdated|ls|list|view)(\s|$)/,

    // ── 进程查看（只读） ──
    /^(tasklist|ps|tasklist\.exe)(\s|$)/,

    // ── 网络诊断（只读） ──
    /^(ping|netstat|ipconfig|ifconfig|nslookup|tracert|traceroute)(\s|$)/,

    // ── 目录导航辅助（只读） ──
    /^(realpath|basename|dirname|stat|file)(\s|$)/,
];

const WINDOWS_PATH_ARGUMENT = String.raw`(?:"[^"]+"|'[^']+'|[^\s()&|<>]+)`;
const WINDOWS_ECHO_ACTION = String.raw`(?:echo\b[^&|<>]*|\(\s*echo\b[^&|<>]*\s*\))`;
const WINDOWS_TYPE_ACTION = String.raw`(?:type\s+${WINDOWS_PATH_ARGUMENT}|\(\s*type\s+${WINDOWS_PATH_ARGUMENT}\s*\))`;
const WINDOWS_MKDIR_ACTION = String.raw`(?:(?:mkdir|md)\s+${WINDOWS_PATH_ARGUMENT}|\(\s*(?:mkdir|md)\s+${WINDOWS_PATH_ARGUMENT}\s*\))`;

/**
 * Windows cmd 条件检查白名单
 *
 */
const SAFE_WINDOWS_CONDITIONAL_PATTERNS: ReadonlyArray<RegExp> = [
    new RegExp(
        String.raw`^if\s+(?:not\s+)?exist\s+${WINDOWS_PATH_ARGUMENT}\s+${WINDOWS_ECHO_ACTION}(?:\s+else\s+${WINDOWS_ECHO_ACTION})?\s*$`,
        'i'
    ),
    new RegExp(
        String.raw`^if\s+exist\s+${WINDOWS_PATH_ARGUMENT}\s+${WINDOWS_TYPE_ACTION}\s*$`,
        'i'
    ),
    new RegExp(
        String.raw`^if\s+not\s+exist\s+${WINDOWS_PATH_ARGUMENT}\s+${WINDOWS_MKDIR_ACTION}\s*$`,
        'i'
    ),
];

function isSafeWindowsConditional(command: string): boolean {
    if (/[&|<>]/.test(command)) {
        return false;
    }

    return SAFE_WINDOWS_CONDITIONAL_PATTERNS.some(pattern => pattern.test(command));
}

/**
 * 判断 exec 命令是否安全
 *
 * 命令经过 trim 后与白名单逐一匹配，
 * 任何一个模式匹配则视为安全
 *
 * @param command - 待检查的 shell 命令
 * @returns true 表示安全（跳过 Checkpoint），false 表示需要 Checkpoint
 */
export function isExecCommandSafe(command: string): boolean {
    const trimmed = command.trim();

    // 空命令视为不安全，触发 Checkpoint
    if (!trimmed) {
        return false;
    }

    return SAFE_EXEC_PATTERNS.some(pattern => pattern.test(trimmed)) ||
        isSafeWindowsConditional(trimmed);
}

// ═══════════════════════════════════════════════════════════════
// 绝对禁止命令黑名单
// ═══════════════════════════════════════════════════════════════

/**
 * 命令阻断结果
 */
export interface BlockedResult {
    blocked: boolean;
    reason: string;
}

/**
 * 绝对禁止命令正则模式
 *
 * 与 Rust 后端的 command_validator.rs 对应，在 TS 层提前拦截。
 * 命中任何一个模式即直接拒绝执行，不进入 Checkpoint 也不调用 shell_execute。
 *
 * 设计决策：
 * - Rust 层是最后一道防线（不可绕过）
 * - TS 层是快速反馈层（减少无谓调用，更快返回错误信息）
 */
const BLOCKED_EXEC_PATTERNS: ReadonlyArray<{ pattern: RegExp; reasonKey: TranslationKey }> = [
    // 磁盘/分区操作 — 致命
    { pattern: /\bdiskpart\b/i, reasonKey: 'tools.execSafety.diskpart' },
    { pattern: /\bformat\s+[a-zA-Z]:/i, reasonKey: 'tools.execSafety.formatDisk' },
    // 启动配置 — 致命
    { pattern: /\bbcdedit\b/i, reasonKey: 'tools.execSafety.bcdedit' },
    // 磁盘覆写 — 不可逆数据销毁
    { pattern: /\bcipher\s+\/w/i, reasonKey: 'tools.execSafety.cipherW' },
    // 文件所有权 — 可突破 TrustedInstaller 保护
    { pattern: /\btakeown\b/i, reasonKey: 'tools.execSafety.takeown' },
    // 系统文件检查 — 需管理员权限
    { pattern: /\bsfc\s+\//i, reasonKey: 'tools.execSafety.sfc' },
    // 用户账户管理
    { pattern: /\bnet\s+user\b/i, reasonKey: 'tools.execSafety.netUser' },
    // 服务管理
    { pattern: /\bnet\s+(stop|start)\b/i, reasonKey: 'tools.execSafety.netService' },
    { pattern: /\bsc\s+delete\b/i, reasonKey: 'tools.execSafety.scDelete' },
    // wmic 写入操作 — 只读查询放行，写入/修改阻断
    { pattern: /\bwmic\b.*\b(delete|create|\bset\b|\bcall\b)/i, reasonKey: 'tools.execSafety.wmicWrite' },
    // 注册表删除
    { pattern: /\breg\s+delete\b/i, reasonKey: 'tools.execSafety.regDelete' },
    // Base64 编码命令 — 无法审查内容，>90% 恶意
    { pattern: /-encodedcommand\b/i, reasonKey: 'tools.execSafety.encodedCommand' },
    // 使用 \b 词边界代替尾随空格，避免命令末尾 -enc 的漏检
    { pattern: /\s-enc\b/i, reasonKey: 'tools.execSafety.encShort' },
    // 系统级环境变量修改
    { pattern: /\bsetx\b.*\/m\b/i, reasonKey: 'tools.execSafety.setxSystem' },
    // PowerShell .NET API 修改系统/用户级环境变量 — 绕过 setx 的主要方式
    { pattern: /\[(?:System\.)?Environment\]::SetEnvironmentVariable/i, reasonKey: 'tools.execSafety.envSet' },
    // 通过注册表路径直接修改系统级环境变量（Set-ItemProperty / New-ItemProperty 等）
    { pattern: /session\s*manager\\environment/i, reasonKey: 'tools.execSafety.registryEnv' },
    // 注册表系统级修改
    { pattern: /\breg\s+add\s+hklm\b/i, reasonKey: 'tools.execSafety.regAddHklm' },
    // ── ACL 权限修改 + 系统目录 组合阻断 ──
    // icacls/cacls + 修改参数 + System32/Windows 路径
    { pattern: /\b[ic]*acls\b.*(\/grant|\/deny|\/remove|\/setowner|\/reset|\/inheritance:[re]).*\b(system32|windows|syswow64)\b/i, reasonKey: 'tools.execSafety.aclSystem' },
    { pattern: /\b[ic]*acls\b.*\b(system32|windows|syswow64)\b.*(\/grant|\/deny|\/remove|\/setowner|\/reset|\/inheritance:[re])/i, reasonKey: 'tools.execSafety.aclSystem' },
    // cacls 特有参数（/G grant, /R revoke, /P replace, /D deny）
    { pattern: /\bcacls\b.*\b(system32|windows|syswow64)\b.*\/[grpd]\s/i, reasonKey: 'tools.execSafety.caclsSystem' },
    { pattern: /\bcacls\b.*\/[grpd]\s.*\b(system32|windows|syswow64)\b/i, reasonKey: 'tools.execSafety.caclsSystem' },
    // PowerShell Set-Acl + 系统路径
    { pattern: /\bset-acl\b.*\b(system32|windows|syswow64)\b/i, reasonKey: 'tools.execSafety.setAclSystem' },
    { pattern: /\bset-acl\b.*\b(\$env:systemroot|\$env:windir)\b/i, reasonKey: 'tools.execSafety.setAclSystem' },
];

/**
 * 判断 exec 命令是否被绝对禁止
 *
 * 在 isExecCommandSafe 之前调用。命中黑名单的命令直接拒绝，
 * 不进入 Checkpoint 流程，也不调用 Rust 后端 shell_execute。
 *
 * @param command - 待检查的 shell 命令
 * @returns { blocked, reason } — blocked=true 表示命令被禁止
 */
export function isExecCommandBlocked(command: string): BlockedResult {
    const trimmed = command.trim();

    if (!trimmed) {
        return { blocked: false, reason: '' };
    }

    for (const { pattern, reasonKey } of BLOCKED_EXEC_PATTERNS) {
        if (pattern.test(trimmed)) {
            return {
                blocked: true,
                reason: translate('tools.execSafety.blockedPrefix', {
                    reason: translate(reasonKey),
                }),
            };
        }
    }

    return { blocked: false, reason: '' };
}
