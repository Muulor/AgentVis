import { getLogger } from '@services/logger';

const logger = getLogger('JsonParser');

/**
 * JsonParser - 统一的 JSON 解析工具模块
 * 
 * 专门处理 LLM 响应中常见的 JSON 格式问题：
 * - 中文引号转换
 * - 控制字符清理
 * - 嵌套字符串逃逸修复
 * - 尾随逗号移除
 * - Markdown 代码块提取
 */

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 解析结果
 */
export interface ParseResult<T> {
    success: boolean;
    data?: T;
    error?: string;
    /** 使用的解析策略 */
    strategy?: string;
    /** 
     * 解析质量等级
     * - perfect: 直接解析成功
     * - sanitized: 清理后解析成功
     * - aggressive: 激进清理后成功
     * - structural: 结构性小修复后成功
     * - repaired: 截断修复后成功
     */
    quality?: 'perfect' | 'sanitized' | 'aggressive' | 'structural' | 'repaired';
}

/**
 * 解析选项
 */
export interface ParseOptions {
    /** 是否启用详细日志 */
    verbose?: boolean;
    /** 日志前缀 */
    logPrefix?: string;
    /** 是否抑制警告日志，用于上层内部探测候选 JSON */
    suppressWarnings?: boolean;
}

// ============================================================================
// 常量
// ============================================================================

/** 最大 JSON 处理长度（防 DoS / 防卡死） */
const MAX_JSON_LENGTH = 500_000; // 500KB

/**
 * 展开嵌套公符的 fixNestedQuotes 初始快速检测阈值
 *
 * 超过此长度的 JSON 跳过 JSON.parse 预检，直接进行字符扫描修复。
 * 避免对 15KB+ 的超大字符串进行 O(n²) 级别的重复解析开销。
 */
const FIX_NESTED_QUOTES_FAST_CHECK_LIMIT = 50_000; // 50KB

// ============================================================================
// 核心方法
// ============================================================================

/**
 * 从 LLM 响应中提取 JSON 文本
 * 
 * 支持多种格式：
 * 1. 纯 JSON 响应（对象或数组）
 * 2. Markdown 代码块包裹（含未闭合的情况）
 * 3. 前缀文本 + JSON（如 "thought\n{...}"）
 * 4. 混合文本中的 JSON
 */
export function extractJsonFromText(text: string): string | null {
    const trimmed = text.trim();

    // 策略 1: 纯 JSON（以 { 或 [ 开头）
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        // 此时我们已知 trimmed 以 { 或 [ 开头，所以 [0] 不会是 undefined
        const startChar = trimmed[0] as '{' | '[';
        const closeChar = startChar === '{' ? '}' : ']';
        const endIndex = findMatchingChar(trimmed, 0, startChar, closeChar);
        if (endIndex !== -1) {
            return trimmed.substring(0, endIndex + 1);
        }
        // 如果没找到闭合括号，返回整个文本（让后续修复策略处理）
        return trimmed;
    }

    // 策略 2: Markdown 代码块（含未闭合的情况）
    // 匹配 ```json 或 ```
    const codeBlockStart = trimmed.match(/```(?:json)?\s*\n?/);
    if (codeBlockStart) {
        const startIdx = (codeBlockStart.index ?? 0) + codeBlockStart[0].length;
        const afterStart = trimmed.substring(startIdx);

        // 智能查找围栏闭合位置：
        // JSON 字符串值中可能包含 ``` （如 markdown 代码块），
        // 简单匹配第一个 ``` 会导致 JSON 被截断。
        // 因此逐个候选位置验证 JSON 结构完整性
        const jsonContent = findValidJsonInCodeBlock(afterStart);

        // 支持对象和数组两种开头
        if (jsonContent.startsWith('{') || jsonContent.startsWith('[')) {
            return jsonContent;
        }
    }

    // 策略 3: 跳过常见的前缀文本（thought, thinking, 思考 等）
    // 匹配：前缀词 + 可选冒号/空格 + 换行 + JSON
    const prefixPatterns = [
        /^(?:thought|thinking|思考|分析|推理)[\s:：]*\n+/i,
        /^(?:response|answer|回答|输出)[\s:：]*\n+/i,
        /^[^\n{[]*\n+(?=[{[])/,  // 任意单行前缀后跟换行和 { 或 [
    ];

    for (const pattern of prefixPatterns) {
        const match = trimmed.match(pattern);
        if (match) {
            const afterPrefix = trimmed.substring(match[0].length).trim();
            if (afterPrefix.startsWith('{') || afterPrefix.startsWith('[')) {
                // 此时我们已知 afterPrefix 以 { 或 [ 开头
                const startChar = afterPrefix[0] as '{' | '[';
                const closeChar = startChar === '{' ? '}' : ']';
                const endIndex = findMatchingChar(afterPrefix, 0, startChar, closeChar);
                if (endIndex !== -1) {
                    return afterPrefix.substring(0, endIndex + 1);
                }
                return afterPrefix;
            }
        }
    }

    // 策略 4: 混合文本中提取 JSON（查找第一个 { 或 [ 的位置）
    const firstBrace = trimmed.indexOf('{');
    const firstBracket = trimmed.indexOf('[');

    // 选择更早出现的那个
    let startIdx = -1;
    let openChar = '';
    let closeChar = '';

    if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
        startIdx = firstBrace;
        openChar = '{';
        closeChar = '}';
    } else if (firstBracket !== -1) {
        startIdx = firstBracket;
        openChar = '[';
        closeChar = ']';
    }

    if (startIdx !== -1) {
        const jsonPart = trimmed.substring(startIdx);
        const endIndex = findMatchingChar(jsonPart, 0, openChar, closeChar);
        if (endIndex !== -1) {
            return jsonPart.substring(0, endIndex + 1);
        }
        // 返回从起始字符开始的所有内容
        return jsonPart;
    }

    return null;
}

/**
 * 查找与起始位置的开括号匹配的闭括号
 * 
 * 支持 {} 和 [] 两种括号类型 * 
 * 考虑字符串内的括号和转义
 * 
 * @param text 文本
 * @param startIndex 开括号位置
 * @param openChar 开括号字符 ('{' 或 '[')
 * @param closeChar 闭括号字符 ('}' 或 ']')
 * @returns 匹配的闭括号索引，未找到返回 -1
 */
function findMatchingChar(text: string, startIndex: number, openChar: string, closeChar: string): number {
    if (text[startIndex] !== openChar) return -1;

    let depth = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = startIndex; i < text.length; i++) {
        const char = text[i];

        if (escapeNext) {
            escapeNext = false;
            continue;
        }

        if (char === '\\') {
            escapeNext = true;
            continue;
        }

        if (char === '"') {
            inString = !inString;
            continue;
        }

        if (!inString) {
            if (char === openChar) {
                depth++;
            } else if (char === closeChar) {
                depth--;
                if (depth === 0) {
                    return i;
                }
            }
        }
    }

    return -1; // 未找到匹配的闭括号
}

/**
 * 在 markdown 围栏内容中智能查找有效的 JSON
 *
 * 核心问题：LLM 输出的 JSON 字符串值中可能包含 ``` （如 markdown 代码块），
 * 简单匹配第一个 ``` 会导致 JSON 被截断（Unterminated string in JSON）。
 *
 * 策略（v2 - 逆向搜索 + JSON.parse 验证）：
 * 1. 收集所有 ``` 出现位置
 * 2. 从最后一个 ``` 开始向前逐个尝试（真正的围栏闭合通常是最后一个）
 * 3. 对每个候选截取文本做 sanitizeJson → JSON.parse 验证
 * 4. 第一个解析成功的即为正确围栏结束位置
 *
 * 相比 v1（findMatchingChar 括号配对验证）的优势：
 * - JSON.parse 是 JSON 格式的终极裁判，不会被字符串内的未转义换行/引号误导
 * - sanitizeJson 在 parse 前修复转义/换行等 LLM 常见问题
 * - 逆向搜索天然跳过字符串值内部的假围栏
 *
 * @param content - ``` 围栏开始标记之后的全部文本
 * @returns 提取到的 JSON 文本
 */
function findValidJsonInCodeBlock(content: string): string {
    // 1. 收集所有 ``` 出现位置
    const fencePositions: number[] = [];
    let searchFrom = 0;
    while (searchFrom < content.length) {
        const idx = content.indexOf('```', searchFrom);
        if (idx === -1) break;
        fencePositions.push(idx);
        searchFrom = idx + 3;
    }

    if (fencePositions.length === 0) {
        // 无围栏闭合，返回全部内容（让后续修复策略处理）
        return content.trim();
    }

    // 快速路径：围栏结束几乎总是最后一个 ``` —— 先单独验证，成功则直接返回，
    // 省去对内容中嵌套 ``` 的情况做完整逆向遍历的成本
    const lastFenceIdx = fencePositions[fencePositions.length - 1];
    if (lastFenceIdx === undefined) return content;
    const lastCandidate = content.substring(0, lastFenceIdx).trim();
    if (lastCandidate.startsWith('{') || lastCandidate.startsWith('[')) {
        try {
            const sanitized = sanitizeJson(lastCandidate);
            JSON.parse(sanitized);
            // 最后一个 ``` 就是真正的围栏结束，直接返回
            return lastCandidate;
        } catch {
            // 最后一个验证失败，说明内容里嵌套了 ```，需要逐个逆向遍历
        }
    }

    // 2. 从后向前逐个候选位置验证
    for (let i = fencePositions.length - 1; i >= 0; i--) {
        const fenceIdx = fencePositions[i];
        if (fenceIdx === undefined) continue;
        const candidate = content.substring(0, fenceIdx).trim();

        // 候选内容必须以 JSON 起始字符开头
        if (!candidate.startsWith('{') && !candidate.startsWith('[')) {
            continue;
        }

        // 尝试 sanitizeJson + JSON.parse 验证
        try {
            const sanitized = sanitizeJson(candidate);
            JSON.parse(sanitized);
            // 解析成功 → 这个 ``` 是真正的围栏结束
            return candidate;
        } catch {
            // 解析失败 → 这个 ``` 在 JSON 字符串值内部，试下一个候选
            continue;
        }
    }

    // 3. 所有候选位置均解析失败（常见于 JSON 缺少闭合括号的情况）
    // 此时应从最后一个围栏处截断，去掉 ``` 标记
    // 让后续的 repairTruncatedJson 策略补全缺失的括号
    const lastFence = fencePositions[fencePositions.length - 1];
    if (lastFence === undefined) return content;
    const fallback = content.substring(0, lastFence).trim();
    if (fallback.startsWith('{') || fallback.startsWith('[')) {
        return fallback;
    }

    return content.trim();
}

/**
 * 清理 JSON 字符串中的常见格式问题
 * 
 * 处理以下问题：
 * - 中文引号 → 英文引号
 * - 全角符号 → 半角符号
 * - 控制字符清理
 * - 尾随逗号移除
 * - 嵌套引号逃逸
 */
export function sanitizeJson(jsonStr: string): string {
    let result = jsonStr;

    // 1. 中文引号替换（全角 → 半角）
    // 使用 Unicode 码点明确指定智能引号
    result = result
        .replace(/[\u201C\u201D]/g, '"')  // 智能双引号 "" → "
        .replace(/[\u2018\u2019]/g, "'"); // 智能单引号 '' → '

    // 2. 全角冒号和逗号替换
    result = result
        .replace(/：/g, ':')
        .replace(/，/g, ',');

    // 3. 清理控制字符（保留换行和空格）
    // 移除 ASCII 0-31 中除了 \t \n \r 之外的字符
    // eslint-disable-next-line no-control-regex
    result = result.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

    // 4. 修复嵌套引号问题（字符串内部的未转义引号）
    // ⚠️ 必须在 fixInvalidEscapes / normalizeLineBreaks 之前执行！
    // 这两个函数依赖 inString 状态机追踪字符串边界，
    // 如果值中存在未转义双引号
    // 状态机会在该处失步 → 后续输出损坏 → 修复无效
    result = fixNestedQuotes(result);

    // 5. 修复非法 JSON 转义字符（如 Windows 路径中的 \U \A \M \R 等）
    // LLM 输出路径时反斜杠转义不一致，需要补全为双反斜杠
    result = fixInvalidEscapes(result);

    // 6. 处理字符串值内部的换行（转换为 \n）
    // 这需要更复杂的处理，因为需要区分 JSON 结构中的换行和字符串值中的换行
    result = normalizeLineBreaksInStrings(result);

    // 7. 移除尾随逗号
    result = result
        .replace(/,(\s*})/g, '$1')   // 对象尾随逗号
        .replace(/,(\s*\])/g, '$1'); // 数组尾随逗号

    return result;
}

/**
 * 修复 JSON 字符串值中的非法转义字符
 *
 * JSON 规范只允许：\" \\ \/ \b \f \n \r \t \uXXXX
 * 但 LLM 输出的 Windows 路径常出现 \U \A \M \R 等非法转义（漏了双反斜杠）
 * 例如: C:\Users\Admin → JSON 中应为 C:\\Users\\Admin，但 LLM 可能输出 C:\\Users\Admin
 *
 * 策略：使用状态机遍历，仅在 JSON 字符串值内部修复非法转义
 */
function fixInvalidEscapes(jsonStr: string): string {
    // JSON 合法的转义字符集
    const VALID_ESCAPE_CHARS = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);

    let result = '';
    let inString = false;
    let i = 0;

    while (i < jsonStr.length) {
        const char = jsonStr.charAt(i);

        if (!inString) {
            // 字符串外部：直接复制，只追踪引号边界
            if (char === '"') {
                inString = true;
            }
            result += char;
            i++;
            continue;
        }

        // 字符串内部
        if (char === '"') {
            // 字符串结束
            inString = false;
            result += char;
            i++;
            continue;
        }

        if (char === '\\') {
            const nextChar = jsonStr[i + 1];
            if (nextChar === undefined) {
                // 字符串末尾的孤立反斜杠，转义它
                result += '\\\\';
                i++;
                continue;
            }

            if (VALID_ESCAPE_CHARS.has(nextChar)) {
                // 合法转义：原样保留
                // 对于 \uXXXX，只验证 'u' 开头即可，无需检查后4位
                result += char + nextChar;
                i += 2;
            } else {
                // 非法转义（如 \U \A \M \R）：补一个反斜杠使其变为 \\
                // 然后下一轮循环会处理 nextChar 本身
                result += '\\\\';
                i++;
            }
            continue;
        }

        // 普通字符
        result += char;
        i++;
    }

    return result;
}

/**
 * 规范化字符串值内部的换行符
 */
function normalizeLineBreaksInStrings(jsonStr: string): string {
    // 使用状态机处理，区分在字符串内还是外
    let result = '';
    let inString = false;
    let escapeNext = false;

    for (let i = 0; i < jsonStr.length; i++) {
        const char = jsonStr[i] ?? '';

        if (escapeNext) {
            result += char;
            escapeNext = false;
            continue;
        }

        if (char === '\\') {
            result += char;
            escapeNext = true;
            continue;
        }

        // 检查引号前的连续反斜杠数量来判断是否转义
        // 偶数个 = 未转义，奇数个 = 已转义
        if (char === '"') {
            let backslashCount = 0;
            for (let j = i - 1; j >= 0; j--) {
                if (jsonStr[j] !== '\\') break;
                backslashCount++;
            }
            if (backslashCount % 2 === 0) {
                inString = !inString;
            }
            result += char;
            continue;
        }

        // 在字符串内部，将实际换行符转换为 \n 转义序列
        if (inString && (char === '\n' || char === '\r')) {
            // 跳过 \r\n 中的 \r
            if (char === '\r' && jsonStr[i + 1] === '\n') {
                continue;
            }
            result += '\\n';
            continue;
        }

        result += char;
    }

    return result;
}

/**
 * 修复字符串值内部的未转义引号
 *
 * 例如: {"reason": "用户说"不要""} → {"reason": "用户说\"不要\""}
 *
 * 启发式规则：
 * - `"` 后跟 `,` `}` `]` → 字符串值结束（高置信度）
 * - `"` 后跟 `:` → 需二级验证（`:` 后是否为合法 JSON 值开头）
 * - 否则 → 内容引号，转义为 \"
 */
function fixNestedQuotes(jsonStr: string): string {
    try {
        // 针对超大字符串跳过初始快速检测
        // 原因：对 15KB+ 输入先执行 JSON.parse 有可观性能开销，
        // 并且 fixNestedQuotes 内部就会被 sanitizeJson 邀 一次，
        // 这里的检测只是快速返回路径，大文本跳过即可。
        if (jsonStr.length <= FIX_NESTED_QUOTES_FAST_CHECK_LIMIT) {
            JSON.parse(jsonStr);
            return jsonStr;
        }
    } catch {
        // 解析失败，进行修复
    }

    // 使用更保守的方法：逐字符扫描，只在检测到问题时修复
    const chars = jsonStr.split('');
    let inString = false;
    let currentStringRole: 'objectValue' | 'other' = 'other';

    for (let i = 0; i < chars.length; i++) {
        const char = chars[i];

        // 检查当前字符前面的连续反斜杠数量
        // 偶数个反斜杠 = 反斜杠互相转义，当前字符未被转义
        // 奇数个反斜杠 = 当前字符被转义
        // 例如: \\" → 偶数(2)个 \ → " 未转义
        //       \" → 奇数(1)个 \ → " 已转义
        let backslashCount = 0;
        for (let j = i - 1; j >= 0; j--) {
            if (chars[j] !== '\\') break;
            backslashCount++;
        }
        if (backslashCount % 2 !== 0) {
            continue;
        }

        if (char === '"') {
            if (!inString) {
                inString = true;
                currentStringRole = findPreviousNonSpaceInText(jsonStr, i - 1) === ':'
                    ? 'objectValue'
                    : 'other';
            } else {
                // 检查这是否是字符串的结束
                const nextNonSpaceIndex = findNextNonSpaceIndex(chars, i + 1);
                const nextNonSpace = nextNonSpaceIndex === -1 ? null : chars[nextNonSpaceIndex] ?? null;

                if (
                    nextNonSpace === '"' &&
                    shouldEscapeQuoteBeforeAdjacentClosingQuote(chars, i, nextNonSpaceIndex, currentStringRole)
                ) {
                    chars[i] = '\\"';
                } else if (
                    (nextNonSpace === ',' && thisQuoteCanEndBeforeComma(chars, nextNonSpaceIndex, currentStringRole)) ||
                    nextNonSpace === '}' ||
                    nextNonSpace === ']'
                ) {
                    // 高置信度：值结束后直接跟分隔符或闭括号
                    inString = false;
                    currentStringRole = 'other';
                } else if (nextNonSpace === ':') {
                    // 冒号需要二级验证：JSON 键的冒号后面是合法值开头
                    // 而内容冒号（如 "标题": 内容）后面跟的是普通文本
                    const colonIdx = findNextNonSpaceIndex(chars, i + 1);
                    if (colonIdx !== -1) {
                        const afterColon = findNextNonSpace(chars, colonIdx + 1);
                        // 合法 JSON 值开头：" { [ 数字 t(rue) f(alse) n(ull)
                        const isJsonValueStart = afterColon !== null && (
                            afterColon === '"' ||
                            afterColon === '{' ||
                            afterColon === '[' ||
        /[0-9-]/.test(afterColon) ||
                            ['t', 'f', 'n'].includes(afterColon)
                        );
                        if (isJsonValueStart) {
                            inString = false; // 确认是 JSON 键结束
                            currentStringRole = 'other';
                        } else {
                            // 冒号后面不是 JSON 值 → 这是内容引号
                            chars[i] = '\\"';
                        }
                    } else {
                        chars[i] = '\\"';
                    }
                } else if (nextNonSpace && nextNonSpace !== '"') {
                    // 其他情况：这是内容引号，需要转义
                    chars[i] = '\\"';
                }
            }
        }
    }

    return chars.join('');
}

function shouldEscapeQuoteBeforeAdjacentClosingQuote(
    chars: string[],
    quoteIndex: number,
    adjacentQuoteIndex: number,
    currentStringRole: 'objectValue' | 'other'
): boolean {
    if (currentStringRole !== 'objectValue' || adjacentQuoteIndex <= quoteIndex) {
        return false;
    }

    let candidateClosingQuoteIndex = adjacentQuoteIndex;
    for (;;) {
        const afterCandidateIndex = findNextNonSpaceIndex(chars, candidateClosingQuoteIndex + 1);
        if (afterCandidateIndex === -1) {
            return false;
        }

        const afterCandidate = chars[afterCandidateIndex];
        if (afterCandidate === '"') {
            candidateClosingQuoteIndex = afterCandidateIndex;
            continue;
        }

        return canStringEndBeforeChar(chars, afterCandidateIndex, currentStringRole);
    }
}

function canStringEndBeforeChar(
    chars: string[],
    charIndex: number,
    currentStringRole: 'objectValue' | 'other'
): boolean {
    const char = chars[charIndex];
    if (char === ',') {
        return thisQuoteCanEndBeforeComma(chars, charIndex, currentStringRole);
    }

    return char === '}' || char === ']';
}

function thisQuoteCanEndBeforeComma(
    chars: string[],
    commaIndex: number,
    currentStringRole: 'objectValue' | 'other'
): boolean {
    if (currentStringRole === 'objectValue') {
        return isLikelyObjectPropertyCommaAfterString(chars, commaIndex);
    }

    return isLikelyStructuralCommaAfterString(chars, commaIndex);
}

/**
 * 查找下一个非空白字符
 */
function findNextNonSpace(chars: string[], startIndex: number): string | null {
    for (let i = startIndex; i < chars.length; i++) {
        const char = chars[i];
        if (char !== undefined && !/\s/.test(char)) {
            return char;
        }
    }
    return null;
}

function isLikelyStructuralCommaAfterString(chars: string[], commaIndex: number): boolean {
    const afterCommaIndex = findNextNonSpaceIndex(chars, commaIndex + 1);
    if (afterCommaIndex === -1) {
        return false;
    }

    const afterComma = chars[afterCommaIndex];
    if (afterComma === undefined) {
        return false;
    }

    return afterComma === '"' ||
        afterComma === '{' ||
        afterComma === '[' ||
        afterComma === '}' ||
        afterComma === ']' ||
        afterComma === '-' ||
        /[0-9tfn]/.test(afterComma);
}

function isLikelyObjectPropertyCommaAfterString(chars: string[], commaIndex: number): boolean {
    const afterCommaIndex = findNextNonSpaceIndex(chars, commaIndex + 1);
    if (afterCommaIndex === -1) {
        return false;
    }

    const afterComma = chars[afterCommaIndex];
    if (afterComma === '}' || afterComma === ']') {
        return true;
    }

    return afterComma === '"' && (
        isLikelyQuotedPropertyKey(chars, afterCommaIndex) ||
        isLikelyLineStartOrphanStringMember(chars, afterCommaIndex)
    );
}

function isLikelyQuotedPropertyKey(chars: string[], quoteIndex: number): boolean {
    const keyEnd = findUnescapedQuoteInCharsWithinLimit(chars, quoteIndex + 1, 80);
    if (keyEnd === -1) {
        return false;
    }

    const colonIndex = findNextNonSpaceIndex(chars, keyEnd + 1);
    return colonIndex !== -1 && chars[colonIndex] === ':';
}

function isLikelyLineStartOrphanStringMember(chars: string[], quoteIndex: number): boolean {
    if (!isAtLineStartAfterIndentInChars(chars, quoteIndex)) {
        return false;
    }

    const stringEnd = findUnescapedQuoteInCharsWithinLimit(chars, quoteIndex + 1, 200);
    if (stringEnd === -1) {
        return false;
    }

    const afterStringIndex = findNextNonSpaceIndex(chars, stringEnd + 1);
    if (afterStringIndex === -1) {
        return true;
    }

    const afterString = chars[afterStringIndex];
    return afterString === ',' || afterString === '}' || afterString === ']';
}

function isAtLineStartAfterIndentInChars(chars: string[], index: number): boolean {
    let linePrefixIndex = index - 1;
    while (linePrefixIndex >= 0 && (chars[linePrefixIndex] === ' ' || chars[linePrefixIndex] === '\t')) {
        linePrefixIndex--;
    }

    return linePrefixIndex < 0 || chars[linePrefixIndex] === '\n' || chars[linePrefixIndex] === '\r';
}

function findUnescapedQuoteInCharsWithinLimit(
    chars: string[],
    startIndex: number,
    maxLength: number
): number {
    const endIndex = Math.min(chars.length, startIndex + maxLength);
    for (let i = startIndex; i < endIndex; i++) {
        if (chars[i] === '"' && !isEscapedInChars(chars, i)) {
            return i;
        }
    }

    return -1;
}

function isEscapedInChars(chars: string[], index: number): boolean {
    let backslashCount = 0;
    for (let i = index - 1; i >= 0; i--) {
        if (chars[i] !== '\\') break;
        backslashCount++;
    }

    return backslashCount % 2 !== 0;
}

/**
 * 查找下一个非空白字符的索引
 */
function findNextNonSpaceIndex(chars: string[], startIndex: number): number {
    for (let i = startIndex; i < chars.length; i++) {
        const char = chars[i];
        if (char !== undefined && !/\s/.test(char)) {
            return i;
        }
    }
    return -1;
}

/**
 * 带降级策略的 JSON 解析
 * 
 * 解析策略顺序：
 * 1. 直接解析
 * 2. 提取 JSON 后解析
 * 3. 清理后解析
 * 4. 轻量结构修复后解析
 * 5. 激进清理后解析
 * 6. 截断补全后解析
 */
export function parseWithFallback<T>(
    text: string,
    options: ParseOptions = {}
): ParseResult<T> {
    const { verbose = false, logPrefix = '[JsonParser]', suppressWarnings = false } = options;

    const log = (message: string) => {
        if (verbose) {
            logger.trace(`${logPrefix} ${message}`);
        }
    };

    const repairSucceeded = (message: string) => {
        if (!suppressWarnings) {
            logger.debug(`${logPrefix} ${message}`);
        }
    };

    const warn = (message: string) => {
        if (suppressWarnings) {
            return;
        }
        logger.warn(`${logPrefix} ${message}`);
    };

    const parseDiagnostics: string[] = [];
    const noteParseFailure = (message: string) => {
        parseDiagnostics.push(message);
        log(message);
    };

    // 长度保护（防 DoS / 防卡死）
    let processedText = text;
    if (processedText.length > MAX_JSON_LENGTH) {
        warn(`JSON exceeded the maximum length limit (${MAX_JSON_LENGTH}) and was truncated`);
        processedText = processedText.slice(0, MAX_JSON_LENGTH);
    }

    // 策略 1: 直接解析（最理想情况）
    try {
        const trimmed = processedText.trim();
        // 支持对象和数组两种根节点
        if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
            (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
            const parsed = JSON.parse(trimmed) as T;
            log('Strategy 1 succeeded: direct parse');
            return { success: true, data: parsed, strategy: 'direct', quality: 'perfect' };
        }
    } catch {
        log('Strategy 1 failed: direct parse');
    }

    // 策略 2: 提取 JSON 后解析
    const extracted = extractJsonFromText(processedText);
    if (extracted) {
        try {
            const parsed = JSON.parse(extracted) as T;
            log('Strategy 2 succeeded: parse extracted JSON');
            return { success: true, data: parsed, strategy: 'extracted', quality: 'perfect' };
        } catch {
            log('Strategy 2 failed: parse extracted JSON');
        }

        // 策略 2b: 提取第一个完整 JSON root，丢弃末尾多余闭合符/围栏噪声
        const balancedRootPrefix = extractBalancedJsonRootPrefixWithIgnorableTail(extracted);
        if (balancedRootPrefix) {
            try {
                const parsed = JSON.parse(balancedRootPrefix) as T;
                log('Strategy 2b succeeded: parse balanced JSON root prefix');
                repairSucceeded('JSON repair succeeded: ignored trailing structural noise after the root value');
                return {
                    success: true,
                    data: parsed,
                    strategy: 'balanced-root-prefix',
                    quality: 'structural',
                };
            } catch {
                try {
                    const sanitizedBalancedRootPrefix = sanitizeJson(balancedRootPrefix);
                    const parsed = JSON.parse(sanitizedBalancedRootPrefix) as T;
                    log('Strategy 2b succeeded: parse sanitized balanced JSON root prefix');
                    repairSucceeded('JSON repair succeeded: ignored trailing structural noise after a sanitized root value');
                    return {
                        success: true,
                        data: parsed,
                        strategy: 'balanced-root-prefix',
                        quality: 'structural',
                    };
                } catch (error) {
                    noteParseFailure(`Strategy 2b failed after balanced root prefix repair: ${String(error)}`);
                }
            }
        }

        // 策略 3: 清理后解析
        const sanitized = sanitizeJson(extracted);
        try {
            const parsed = JSON.parse(sanitized) as T;
            log('Strategy 3 succeeded: parse sanitized JSON');
            return { success: true, data: parsed, strategy: 'sanitized', quality: 'sanitized' };
        } catch (error) {
            noteParseFailure(`Strategy 3 failed after sanitization: ${String(error)}`);
        }

        // 策略 4: 修复字符串值缺少收尾、下一行直接开始新属性的情况
        const propertyRepaired = repairMissingValueTerminatorBeforeProperty(extracted);
        if (propertyRepaired !== extracted) {
            try {
                const sanitizedPropertyRepair = sanitizeJson(propertyRepaired);
                const parsed = JSON.parse(sanitizedPropertyRepair) as T;
                log('Strategy 4 succeeded: repaired missing value terminator before property');
                repairSucceeded('JSON repair succeeded: repaired a missing value terminator before a following property key');
                return {
                    success: true,
                    data: parsed,
                    strategy: 'property-terminator-repair',
                    quality: 'structural',
                };
            } catch (error) {
                noteParseFailure(`Strategy 4 failed after repairing missing value terminator: ${String(error)}`);
            }
        }

        // 策略 4b: 修复常见的局部结构噪声
        const structuralRepairBase = propertyRepaired !== extracted ? propertyRepaired : extracted;
        const structurallyRepaired = repairCommonStructuralJsonIssues(structuralRepairBase);
        if (structurallyRepaired !== structuralRepairBase) {
            try {
                const sanitizedStructuralRepair = sanitizeJson(structurallyRepaired);
                const parsed = JSON.parse(sanitizedStructuralRepair) as T;
                log('Strategy 4b succeeded: repaired common structural JSON issues');
                repairSucceeded('JSON repair succeeded: repaired common LLM structural noise');
                return {
                    success: true,
                    data: parsed,
                    strategy: 'common-structural-repair',
                    quality: 'structural',
                };
            } catch (error) {
                noteParseFailure(`Strategy 4b failed after common structural repair: ${String(error)}`);
            }
        }

        // 策略 5: 尝试更激进的修复
        const aggressivelySanitized = aggressiveSanitize(extracted);
        try {
            const parsed = JSON.parse(aggressivelySanitized) as T;
            log('Strategy 5 succeeded: parse aggressively sanitized JSON');
            repairSucceeded('JSON repair succeeded with aggressive sanitization; result may be incomplete or semantically modified');
            return { success: true, data: parsed, strategy: 'aggressive', quality: 'aggressive' };
        } catch (error) {
            noteParseFailure(`Strategy 5 failed after aggressive sanitization: ${String(error)}`);
        }

        // 策略 6: 修复截断的 JSON（尝试补全缺失的引号和括号）
        const repaired = repairTruncatedJson(extracted);
        if (repaired !== extracted) {
            try {
                const parsed = JSON.parse(repaired) as T;
                log('Strategy 6 succeeded: repaired truncated JSON');
                repairSucceeded('JSON repair succeeded after truncated input repair; some fields may be incomplete');
                return { success: true, data: parsed, strategy: 'repaired', quality: 'repaired' };
            } catch (error) {
                noteParseFailure(`Strategy 6 failed after repairing truncated JSON: ${String(error)}`);
            }
        }
    }

    // 所有策略失败
    warn('All parse strategies failed');
    if (parseDiagnostics.length > 0) {
        warn(`Parse diagnostics: ${parseDiagnostics.join(' | ')}`);
    }
    warn(`Original text (length ${text.length}, first 3000 chars): ${text.substring(0, 3000)}`);
    if (text.length > 3000) {
        warn(`Original text (last 1200 chars): ${text.substring(text.length - 1200)}`);
    }

    return {
        success: false,
        error: 'Could not parse valid JSON from response',
    };
}

function extractBalancedJsonRootPrefixWithIgnorableTail(jsonStr: string): string | null {
    const trimmed = jsonStr.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        return null;
    }

    const openChar = trimmed[0] as '{' | '[';
    const closeChar = openChar === '{' ? '}' : ']';
    const endIndex = findMatchingChar(trimmed, 0, openChar, closeChar);
    if (endIndex === -1 || endIndex === trimmed.length - 1) {
        return null;
    }

    const tail = trimmed.slice(endIndex + 1);
    if (!isIgnorableJsonRootTail(tail)) {
        return null;
    }

    return trimmed.slice(0, endIndex + 1);
}

function isIgnorableJsonRootTail(tail: string): boolean {
    const trimmedTail = tail.trim();
    if (trimmedTail.length === 0) {
        return false;
    }

    return /^[\s}\]`]+$/.test(tail);
}

/**
 * 激进的 JSON 清理
 * 
 * 用于最后的尝试，可能会丢失一些信息但能提高解析成功率
 */
function aggressiveSanitize(jsonStr: string): string {
    let result = sanitizeJson(jsonStr);

    // 1. 移除所有 \r
    result = result.replace(/\r/g, '');

    // 2. 将连续空白压缩为单个空格（但保留结构性换行）
    result = result.replace(/[^\S\n]+/g, ' ');

    // 3. 移除字符串外的换行
    // 简化处理：将换行替换为空格（可能影响格式但不影响解析）
    result = result.replace(/\n/g, ' ');

    // 4. 压缩多余空格
    result = result.replace(/\s+/g, ' ');

    // 5. 修复常见的 LLM 输出问题：在值后面少了逗号
    // 例如: {"a": "1" "b": "2"} → {"a": "1", "b": "2"}
    result = result.replace(/"\s+"/g, '", "');

    // 6. 再次清理尾随逗号
    result = result
        .replace(/,\s*}/g, '}')
        .replace(/,\s*\]/g, ']');

    return result;
}

/**
 * 修复字符串值缺少结束引号/逗号，后续直接出现结构分隔符的情况。
 *
 * 典型 LLM 输出：
 * {
 *   "task": "write a long prompt
 *   "tools": ["generate_image"]
 * }
 *
 * 此策略只在 parseWithFallback 的普通 sanitize 已失败后运行，并且只识别
 * “字符串值内部 + 行首缩进 + 属性/闭合结构”的形态。
 * 这样能覆盖 MB 决策里长 task 字段漏收尾的问题，同时避免改动正常 JSON。
 */
function repairMissingValueTerminatorBeforeProperty(jsonStr: string): string {
    let result = '';
    let inString = false;
    let escapeNext = false;
    let currentStringRole: 'key' | 'objectValue' | 'other' = 'other';

    for (let i = 0; i < jsonStr.length; i++) {
        const char = jsonStr[i] ?? '';

        if (escapeNext) {
            result += char;
            escapeNext = false;
            continue;
        }

        if (inString) {
            if (char === '\\') {
                result += char;
                escapeNext = true;
                continue;
            }

            if (
                currentStringRole === 'objectValue' &&
                char === ',' &&
                isLikelyStructuralCommaBeforePropertyOrClose(jsonStr, i)
            ) {
                result = `${ensureSafeTrailingBackslashes(result)}"`;
                inString = false;
                currentStringRole = 'other';
                result += char;
                continue;
            }

            if (
                currentStringRole === 'objectValue' &&
                (char === '}' || char === ']') &&
                isLikelyContainerCloseAtLineStart(jsonStr, i)
            ) {
                result = closeStringValueBeforeCurrentLine(result);
                inString = false;
                currentStringRole = 'other';
                result += char;
                continue;
            }

            if (
                char === '"' &&
                currentStringRole === 'objectValue' &&
                isLikelyPropertyKeyAtLineStart(jsonStr, i)
            ) {
                result = closeStringValueBeforeCurrentLine(result);
                result += char;
                currentStringRole = 'key';
                continue;
            }

            if (char === '"') {
                inString = false;
                currentStringRole = 'other';
                result += char;
                continue;
            }

            result += char;
            continue;
        }

        if (char === '"') {
            inString = true;
            currentStringRole = findPreviousNonSpaceInText(jsonStr, i - 1) === ':'
                ? 'objectValue'
                : 'key';
        }

        result += char;
    }

    return result;
}

function repairCommonStructuralJsonIssues(jsonStr: string): string {
    let result = repairDuplicatedKeyValuePrefix(jsonStr);
    result = removeOrphanStringObjectMembers(result);
    return result;
}

function repairDuplicatedKeyValuePrefix(jsonStr: string): string {
    return jsonStr.replace(
        /(^|(?:[,{]|\[)\s*)"([A-Za-z_$][A-Za-z0-9_$-]*)"\s*:\s*"\2"\s*:\s*/g,
        '$1"$2": '
    );
}

function removeOrphanStringObjectMembers(jsonStr: string): string {
    interface ObjectFrame { type: 'object'; state: 'keyOrEnd' | 'colon' | 'value' | 'commaOrEnd' }
    interface ArrayFrame { type: 'array'; state: 'valueOrEnd' | 'commaOrEnd' }
    type Frame = ObjectFrame | ArrayFrame;

    const stack: Frame[] = [];
    const rangesToRemove: Array<[number, number]> = [];

    const markParentValueComplete = () => {
        const parent = stack[stack.length - 1];
        if (!parent) {
            return;
        }

        if (parent.type === 'object' && parent.state === 'value') {
            parent.state = 'commaOrEnd';
        } else if (parent.type === 'array' && parent.state === 'valueOrEnd') {
            parent.state = 'commaOrEnd';
        }
    };

    for (let i = 0; i < jsonStr.length;) {
        const char = jsonStr[i] ?? '';

        if (/\s/.test(char)) {
            i++;
            continue;
        }

        if (char === '"') {
            const stringEnd = findUnescapedQuote(jsonStr, i + 1);
            if (stringEnd === -1) {
                break;
            }

            const top = stack[stack.length - 1];
            if (top?.type === 'object' && top.state === 'keyOrEnd') {
                const afterString = skipWhitespace(jsonStr, stringEnd + 1);
                if (jsonStr[afterString] === ':') {
                    top.state = 'colon';
                } else if (isLikelyTrailingOrphanStringMember(jsonStr, stringEnd + 1)) {
                    rangesToRemove.push([i, findOrphanStringRemovalEnd(jsonStr, stringEnd + 1)]);
                } else {
                    top.state = 'commaOrEnd';
                }
            } else if (top?.type === 'object' && top.state === 'value') {
                top.state = 'commaOrEnd';
            } else if (top?.type === 'array' && top.state === 'valueOrEnd') {
                top.state = 'commaOrEnd';
            }

            i = stringEnd + 1;
            continue;
        }

        if (char === '{') {
            stack.push({ type: 'object', state: 'keyOrEnd' });
            i++;
            continue;
        }

        if (char === '[') {
            stack.push({ type: 'array', state: 'valueOrEnd' });
            i++;
            continue;
        }

        if (char === '}' || char === ']') {
            stack.pop();
            markParentValueComplete();
            i++;
            continue;
        }

        const top = stack[stack.length - 1];
        if (char === ':' && top?.type === 'object' && top.state === 'colon') {
            top.state = 'value';
            i++;
            continue;
        }

        if (char === ',') {
            if (top?.type === 'object') {
                top.state = 'keyOrEnd';
            } else if (top?.type === 'array') {
                top.state = 'valueOrEnd';
            }
            i++;
            continue;
        }

        if (top?.type === 'object' && top.state === 'value') {
            top.state = 'commaOrEnd';
        } else if (top?.type === 'array' && top.state === 'valueOrEnd') {
            top.state = 'commaOrEnd';
        }
        i++;
    }

    if (rangesToRemove.length === 0) {
        return jsonStr;
    }

    let result = '';
    let lastIndex = 0;
    for (const [start, end] of rangesToRemove) {
        result += jsonStr.slice(lastIndex, start);
        lastIndex = end;
    }
    result += jsonStr.slice(lastIndex);
    return result;
}

function closeStringValueBeforeCurrentLine(current: string): string {
    const trailingLineWhitespace = current.match(/(\r?\n[ \t]*)$/);

    if (trailingLineWhitespace?.[1]) {
        const whitespace = trailingLineWhitespace[1];
        const prefix = current.slice(0, -whitespace.length);
        return `${ensureSafeTrailingBackslashes(prefix)}",${whitespace}`;
    }

    return `${ensureSafeTrailingBackslashes(current)}", `;
}

function ensureSafeTrailingBackslashes(text: string): string {
    let backslashCount = 0;
    for (let i = text.length - 1; i >= 0; i--) {
        if (text[i] !== '\\') break;
        backslashCount++;
    }

    return backslashCount % 2 === 0 ? text : `${text}\\`;
}

function isLikelyStructuralCommaBeforePropertyOrClose(text: string, commaIndex: number): boolean {
    if (text[commaIndex] !== ',') {
        return false;
    }

    const nextIndex = skipWhitespace(text, commaIndex + 1);
    const nextChar = text[nextIndex];

    if (nextChar === '"' && isLikelyPropertyKeyAtLineStart(text, nextIndex)) {
        return true;
    }

    return nextChar === '}' || nextChar === ']';
}

function isLikelyContainerCloseAtLineStart(text: string, index: number): boolean {
    const char = text[index];
    if ((char !== '}' && char !== ']') || !isAtLineStartAfterIndent(text, index)) {
        return false;
    }

    const nextIndex = skipHorizontalWhitespace(text, index + 1);
    const nextChar = text[nextIndex];

    return nextChar === undefined ||
        nextChar === ',' ||
        nextChar === '}' ||
        nextChar === ']' ||
        nextChar === '\n' ||
        nextChar === '\r';
}

function isLikelyPropertyKeyAtLineStart(text: string, quoteIndex: number): boolean {
    if (text[quoteIndex] !== '"' || isEscapedAt(text, quoteIndex)) {
        return false;
    }

    if (!isAtLineStartAfterIndent(text, quoteIndex)) {
        return false;
    }

    const keyEnd = findUnescapedQuoteWithinLimit(text, quoteIndex + 1, 80);
    if (keyEnd === -1) {
        return false;
    }

    const key = text.slice(quoteIndex + 1, keyEnd);
    if (!/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(key)) {
        return false;
    }

    const colonIndex = skipHorizontalWhitespace(text, keyEnd + 1);
    if (text[colonIndex] !== ':') {
        return false;
    }

    const valueIndex = skipWhitespace(text, colonIndex + 1);
    const valueStart = text[valueIndex];

    return valueStart !== undefined && (
        valueStart === '"' ||
        valueStart === '{' ||
        valueStart === '[' ||
        valueStart === '-' ||
        /[0-9tfn]/.test(valueStart)
    );
}

function isAtLineStartAfterIndent(text: string, index: number): boolean {
    let linePrefixIdx = index - 1;
    while (linePrefixIdx >= 0 && (text[linePrefixIdx] === ' ' || text[linePrefixIdx] === '\t')) {
        linePrefixIdx--;
    }

    return linePrefixIdx < 0 || text[linePrefixIdx] === '\n' || text[linePrefixIdx] === '\r';
}

function findUnescapedQuote(text: string, startIndex: number): number {
    for (let i = startIndex; i < text.length; i++) {
        if (text[i] === '"' && !isEscapedAt(text, i)) {
            return i;
        }
    }

    return -1;
}

function findOrphanStringRemovalEnd(text: string, afterStringIndex: number): number {
    const nextIndex = skipWhitespace(text, afterStringIndex);
    return text[nextIndex] === ',' ? nextIndex + 1 : afterStringIndex;
}

function isLikelyTrailingOrphanStringMember(text: string, afterStringIndex: number): boolean {
    const nextIndex = skipWhitespace(text, afterStringIndex);
    const nextChar = text[nextIndex];

    if (nextChar === undefined || nextChar === '}' || nextChar === ']') {
        return true;
    }

    if (nextChar !== ',') {
        return false;
    }

    const afterCommaIndex = skipWhitespace(text, nextIndex + 1);
    const afterCommaChar = text[afterCommaIndex];
    return afterCommaChar === undefined || afterCommaChar === '}' || afterCommaChar === ']';
}

function findUnescapedQuoteWithinLimit(text: string, startIndex: number, maxLength: number): number {
    const maxIndex = Math.min(text.length, startIndex + maxLength);

    for (let i = startIndex; i < maxIndex; i++) {
        const char = text[i];
        if (char === '\n' || char === '\r') {
            return -1;
        }
        if (char === '"' && !isEscapedAt(text, i)) {
            return i;
        }
    }

    return -1;
}

function isEscapedAt(text: string, index: number): boolean {
    let backslashCount = 0;
    for (let i = index - 1; i >= 0; i--) {
        if (text[i] !== '\\') break;
        backslashCount++;
    }

    return backslashCount % 2 !== 0;
}

function skipHorizontalWhitespace(text: string, startIndex: number): number {
    let i = startIndex;
    while (i < text.length && (text[i] === ' ' || text[i] === '\t')) {
        i++;
    }
    return i;
}

function skipWhitespace(text: string, startIndex: number): number {
    let i = startIndex;
    while (i < text.length && /\s/.test(text[i] ?? '')) {
        i++;
    }
    return i;
}

function findPreviousNonSpaceInText(text: string, startIndex: number): string | null {
    for (let i = startIndex; i >= 0; i--) {
        const char = text[i];
        if (char !== undefined && !/\s/.test(char)) {
            return char;
        }
    }
    return null;
}

/**
 * 修复截断的 JSON
 * 
 * 当 LLM 响应因 max_tokens 限制被截断时，尝试补全缺失的引号和括号
 * 
 * 核心策略：
 * 1. 检测未闭合的字符串并处理
 * 2. 找到最后一个完整的键值对
 * 3. 补全必要的结束标记
 */
function repairTruncatedJson(jsonStr: string): string {
    let result = sanitizeJson(jsonStr);

    // 第一遍扫描：检测状态
    let braceCount = 0;
    let bracketCount = 0;
    let inString = false;
    let escapeNext = false;

    for (const char of result) {

        if (escapeNext) {
            escapeNext = false;
            continue;
        }

        if (char === '\\') {
            escapeNext = true;
            continue;
        }

        if (char === '"') {
            inString = !inString;
            continue;
        }

        if (!inString) {
            if (char === '{') braceCount++;
            else if (char === '}') braceCount--;
            else if (char === '[') bracketCount++;
            else if (char === ']') bracketCount--;
        }
    }

    // 如果仍在字符串内，说明字符串被截断
    if (inString) {
        // 策略：查找字符串开始的引号，判断是数组元素还是对象值
        // 然后只截断当前这个值，保留之前完成的内容

        // 找到截断字符串的开始位置
        let stringStartIdx = -1;
        let tempInString = false;
        for (let i = 0; i < result.length; i++) {
            const char = result[i];
            if (char === '\\' && i + 1 < result.length) {
                i++; // 跳过转义字符
                continue;
            }
            if (char === '"') {
                if (!tempInString) {
                    stringStartIdx = i;
                }
                tempInString = !tempInString;
            }
        }

        // 找到这个字符串之前的逗号或冒号
        if (stringStartIdx > 0) {
            const beforeString = result.substring(0, stringStartIdx);
            const lastComma = beforeString.lastIndexOf(',');
            const lastColon = beforeString.lastIndexOf(':');
            const lastBracket = beforeString.lastIndexOf('[');

            if (lastColon > lastComma && lastColon > 0) {
                // 这是一个对象键的值被截断，回退到这个键之前的逗号
                const searchArea = beforeString.substring(0, lastColon);
                const prevComma = searchArea.lastIndexOf(',');
                const prevBrace = searchArea.lastIndexOf('{');

                if (prevComma > prevBrace && prevComma > 0) {
                    // 回退到前一个完整键值对
                    result = result.substring(0, prevComma);
                } else if (prevBrace >= 0) {
                    // 回退到对象开始（这是第一个键值对）
                    result = result.substring(0, prevBrace + 1);
                }
            } else if (lastBracket > lastComma && lastBracket > 0) {
                // 这是数组的第一个元素被截断
                result = result.substring(0, lastBracket + 1);
            } else if (lastComma > 0) {
                // 这是数组的后续元素被截断，保留到逗号之前
                result = result.substring(0, lastComma);
            } else {
                // 无法判断，简单闭合字符串
                result += '"';
            }
        } else {
            // 找不到字符串起始，简单闭合
            result += '"';
        }
    }

    // 清理末尾的不完整内容
    result = result
        .replace(/,\s*$/, '')     // 移除悬空逗号
        .replace(/:\s*$/, '')     // 移除悬空冒号
        .replace(/"\s*:\s*$/, '') // 移除未赋值的键
        .replace(/,\s*"\s*$/, '') // 移除未完成的新键
        .trim();

    // 第二遍扫描：重新统计括号
    braceCount = 0;
    bracketCount = 0;
    inString = false;
    escapeNext = false;

    for (const char of result) {
        if (escapeNext) { escapeNext = false; continue; }
        if (char === '\\') { escapeNext = true; continue; }
        if (char === '"') { inString = !inString; continue; }
        if (!inString) {
            if (char === '{') braceCount++;
            else if (char === '}') braceCount--;
            else if (char === '[') bracketCount++;
            else if (char === ']') bracketCount--;
        }
    }

    // 如果仍在字符串内，强制闭合
    if (inString) {
        result += '"';
    }

    // 补全括号（按正确顺序：先 ]，再 }）
    for (let i = 0; i < bracketCount; i++) {
        result += ']';
    }
    for (let i = 0; i < braceCount; i++) {
        result += '}';
    }

    return result;
}

// ============================================================================
// 便捷方法
// ============================================================================

/**
 * 解析 LLM 响应为指定类型（简化版）
 * 
 * 失败时返回 null
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function tryParse<T>(text: string, logPrefix?: string): T | null {
    const result = parseWithFallback<T>(text, { logPrefix });
    return result.success ? result.data ?? null : null;
}

/**
 * 解析 LLM 响应为指定类型（带默认值版）
 * 
 * 失败时返回默认值
 */
export function parseOrDefault<T>(text: string, defaultValue: T, logPrefix?: string): T {
    const result = parseWithFallback<T>(text, { logPrefix });
    return result.success && result.data !== undefined ? result.data : defaultValue;
}
