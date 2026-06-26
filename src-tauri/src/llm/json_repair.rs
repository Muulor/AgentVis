//! JSON 修复模块
//!
//! 专门处理 LLM 返回的 tool_call args JSON 中的常见格式问题。
//! 移植自 TS 端 `JsonParser.ts` 的成熟修复策略。
//!
//! 问题背景：
//! LLM 流式返回的 tool_call 参数（尤其 file_write 的 content 字段含大量代码时），
//! 可能出现未转义引号、裸控制字符、非法反斜杠转义、流截断等问题，
//! 导致 serde_json 解析失败。本模块提供渐进式修复管线，尽可能抢救参数数据。

use crate::text_utils::safe_truncate;

/// 最大处理长度（防止超大 JSON 导致修复时间过长）
const MAX_REPAIR_LENGTH: usize = 500_000; // 500KB

// ============================================================================
// 公开 API
// ============================================================================

/// 渐进式修复 tool_call args JSON
///
/// 按策略优先级逐级尝试：
/// 1. sanitize（中文引号/全角/控制字符） → 尝试解析
/// 2. + fix_invalid_escapes（Windows 路径转义） → 尝试解析
/// 3. + normalize_line_breaks（裸换行） → 尝试解析
/// 4. + fix_nested_quotes（未转义内容引号） → 尝试解析
/// 5. aggressive_sanitize（空白压缩 + 补缺逗号） → 尝试解析
/// 6. repair_truncated_json（截断补全） → 尝试解析
///
/// 任一步骤成功即返回，全部失败返回 None
pub fn repair_tool_call_json(raw: &str) -> Option<serde_json::Value> {
    // 长度保护
    let input = if raw.len() > MAX_REPAIR_LENGTH {
        log::warn!(
            "[JsonRepair] ⚠️ JSON 超过最大修复长度 ({} > {}), 截断处理",
            raw.len(), MAX_REPAIR_LENGTH
        );
        safe_truncate(raw, MAX_REPAIR_LENGTH)
    } else {
        raw
    };

    // 策略 1: 基础清理（中文引号 + 全角符号 + 控制字符）
    let sanitized = sanitize_json(input);
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&sanitized) {
        log::trace!("[JsonRepair] 修复成功 (策略: sanitize)");
        return Some(v);
    }

    // 策略 2: + 修复非法转义字符（Windows 路径 \U \A \M \R 等）
    let escape_fixed = fix_invalid_escapes(&sanitized);
    if escape_fixed != sanitized {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&escape_fixed) {
            log::trace!("[JsonRepair] 修复成功 (策略: sanitize + fix_escapes)");
            return Some(v);
        }
    }

    // 策略 3: + 规范化字符串值内部的裸换行
    let line_fixed = normalize_line_breaks(&escape_fixed);
    if line_fixed != escape_fixed {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line_fixed) {
            log::trace!("[JsonRepair] 修复成功 (策略: sanitize + fix_escapes + normalize_breaks)");
            return Some(v);
        }
    }

    // 策略 4: + 修复字符串值内部的未转义引号
    let quote_fixed = fix_nested_quotes(&line_fixed);
    if quote_fixed != line_fixed {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&quote_fixed) {
            log::trace!("[JsonRepair] 修复成功 (策略: sanitize + fix_escapes + normalize + fix_quotes)");
            return Some(v);
        }
    }

    // 策略 5: 激进清理（空白压缩 + 补缺逗号）
    let aggressive = aggressive_sanitize(&quote_fixed);
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&aggressive) {
        log::trace!("[JsonRepair] 修复成功 (策略: aggressive_sanitize)");
        return Some(v);
    }

    // 策略 6: 截断修复（补全缺失的引号和括号）
    let repaired = repair_truncated_json(&quote_fixed);
    if repaired != quote_fixed {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&repaired) {
            log::trace!("[JsonRepair] 修复成功 (策略: repair_truncated)");
            return Some(v);
        }
    }

    // 策略 6b: 对激进清理结果也尝试截断修复
    let repaired_aggressive = repair_truncated_json(&aggressive);
    if repaired_aggressive != aggressive {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&repaired_aggressive) {
            log::trace!("[JsonRepair] 修复成功 (策略: aggressive + repair_truncated)");
            return Some(v);
        }
    }

    // 策略 7: Partial Extraction（最终保底）
    // 当所有修复策略都失败时，从损坏 JSON 中提取已完成的顶层键值对。
    // 典型场景：file_write 的 content 字段含大量代码导致 JSON 结构损坏，
    // 但 path/mode 等短参数在 content 之前已完整输出，可以被安全提取。
    // 这避免了回退为空对象 {} 导致所有参数全量丢失的问题。
    if let Some(partial) = extract_partial_fields(&sanitized) {
        log::warn!(
            "[JsonRepair] ⚠️ 修复降级: partial extraction 提取到 {} 个字段 (原始 {} bytes)",
            partial.as_object().map_or(0, |m| m.len()),
            raw.len()
        );
        return Some(partial);
    }

    None
}

// ============================================================================
// 内部修复管线
// ============================================================================

/// 基础 JSON 清理
///
/// 移植自 `JsonParser.ts::sanitizeJson`：
/// - 中文智能引号 → 英文引号（"" → ""）
/// - 全角冒号/逗号 → 半角
/// - 裸控制字符清理（保留 \t \n \r）
/// - 尾随逗号移除
fn sanitize_json(raw: &str) -> String {
    let mut result = String::with_capacity(raw.len());

    for ch in raw.chars() {
        match ch {
            // 中文智能双引号 → 英文双引号
            '\u{201C}' | '\u{201D}' => result.push('"'),
            // 中文智能单引号 → 英文单引号
            '\u{2018}' | '\u{2019}' => result.push('\''),
            // 全角冒号 → 半角
            '\u{FF1A}' => result.push(':'),
            // 全角逗号 → 半角
            '\u{FF0C}' => result.push(','),
            // 清理控制字符（保留 \t \n \r）
            c if c.is_control() && c != '\t' && c != '\n' && c != '\r' => {
                // 跳过裸控制字符
            }
            c => result.push(c),
        }
    }

    // 移除尾随逗号（对象和数组）
    // 使用简单替换：,} → } 和 ,] → ]
    // 注意：这里的简单替换可能影响字符串值中的 ,} 组合
    // 但对于 tool_call args 场景，误伤概率极低
    result = result.replace(",}", "}").replace(",]", "]");

    // 处理带空白的尾随逗号：, } → }
    // 使用 char 级别处理避免正则依赖
    remove_trailing_commas_with_whitespace(&result)
}

/// 移除带空白间隔的尾随逗号
///
/// 处理 `, }` / `,\n}` / `, ]` 等模式
fn remove_trailing_commas_with_whitespace(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut result = String::with_capacity(input.len());
    let mut i = 0;

    while i < chars.len() {
        if chars[i] == ',' {
            // 向前看：跳过逗号后的空白，检查下一个非空白字符
            let mut j = i + 1;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            if j < chars.len() && (chars[j] == '}' || chars[j] == ']') {
                // 是尾随逗号：跳过逗号，保留空白和闭合括号
                i += 1;
                continue;
            }
        }
        result.push(chars[i]);
        i += 1;
    }

    result
}

/// 修复 JSON 字符串值中的非法转义字符
///
/// 移植自 `JsonParser.ts::fixInvalidEscapes`：
/// JSON 规范只允许 \" \\ \/ \b \f \n \r \t \uXXXX
/// 但 LLM 输出的 Windows 路径常出现 \U \A \M \R 等非法转义
/// 策略：状态机遍历，仅在字符串值内部将非法 `\X` 修复为 `\\X`
fn fix_invalid_escapes(json: &str) -> String {
    let chars: Vec<char> = json.chars().collect();
    let mut result = String::with_capacity(json.len() + 64);
    let mut in_string = false;
    let mut i = 0;

    while i < chars.len() {
        let ch = chars[i];

        if !in_string {
            // 字符串外部：直接复制，只追踪引号边界
            if ch == '"' {
                in_string = true;
            }
            result.push(ch);
            i += 1;
            continue;
        }

        // 字符串内部
        if ch == '"' {
            // 字符串结束
            in_string = false;
            result.push(ch);
            i += 1;
            continue;
        }

        if ch == '\\' {
            if i + 1 >= chars.len() {
                // 末尾孤立反斜杠：转义它
                result.push_str("\\\\");
                i += 1;
                continue;
            }

            let next = chars[i + 1];
            if is_valid_json_escape(next) {
                // 合法转义：原样保留
                result.push(ch);
                result.push(next);
                i += 2;
            } else {
                // 非法转义（如 \U \A \M \R）：补一个反斜杠
                result.push_str("\\\\");
                i += 1;
                // 下一轮处理 next 字符本身
            }
            continue;
        }

        // 普通字符
        result.push(ch);
        i += 1;
    }

    result
}

/// 判断是否为合法的 JSON 转义字符
fn is_valid_json_escape(ch: char) -> bool {
    matches!(ch, '"' | '\\' | '/' | 'b' | 'f' | 'n' | 'r' | 't' | 'u')
}

/// 规范化字符串值内部的裸换行符
///
/// 移植自 `JsonParser.ts::normalizeLineBreaksInStrings`：
/// JSON 字符串值中的实际换行符（非 \n 转义序列）不合法，
/// 需要替换为 `\n` 转义序列
fn normalize_line_breaks(json: &str) -> String {
    let chars: Vec<char> = json.chars().collect();
    let mut result = String::with_capacity(json.len());
    let mut in_string = false;
    let mut escape_next = false;

    for i in 0..chars.len() {
        let ch = chars[i];

        if escape_next {
            result.push(ch);
            escape_next = false;
            continue;
        }

        if ch == '\\' {
            result.push(ch);
            escape_next = true;
            continue;
        }

        if ch == '"' {
            // 检查前面的连续反斜杠数量判断是否转义
            let backslash_count = count_preceding_backslashes(&chars, i);
            if backslash_count % 2 == 0 {
                in_string = !in_string;
            }
            result.push(ch);
            continue;
        }

        // 在字符串内部，将实际换行符转换为 \n 转义序列
        if in_string && (ch == '\n' || ch == '\r') {
            // 跳过 \r\n 中的 \r
            if ch == '\r' && i + 1 < chars.len() && chars[i + 1] == '\n' {
                continue;
            }
            result.push_str("\\n");
            continue;
        }

        result.push(ch);
    }

    result
}

/// 统计指定位置前面的连续反斜杠数量
fn count_preceding_backslashes(chars: &[char], pos: usize) -> usize {
    let mut count = 0;
    let mut j = pos;
    while j > 0 {
        j -= 1;
        if chars[j] == '\\' {
            count += 1;
        } else {
            break;
        }
    }
    count
}

/// 修复字符串值内部的未转义引号
///
/// 移植自 `JsonParser.ts::fixNestedQuotes`：
/// 启发式规则：
/// - `"` 后跟 `,` `}` `]` → 字符串值结束（高置信度）
/// - `"` 后跟 `:` → 需二级验证（`:` 后是否为合法 JSON 值开头）
/// - 否则 → 内容引号，添加转义 `\"`
fn fix_nested_quotes(json: &str) -> String {
    // 先尝试直接解析，成功就不需要修复
    if serde_json::from_str::<serde_json::Value>(json).is_ok() {
        return json.to_string();
    }

    let mut chars: Vec<String> = json.chars().map(|c| c.to_string()).collect();
    let len = chars.len();
    let mut in_string = false;

    let mut i = 0;
    while i < len {
        // 检查当前字符前面的连续反斜杠数量
        let backslash_count = {
            let mut count = 0;
            let mut j = i;
            while j > 0 {
                j -= 1;
                if chars[j] == "\\" {
                    count += 1;
                } else {
                    break;
                }
            }
            count
        };
        if backslash_count % 2 != 0 {
            i += 1;
            continue;
        }

        if chars[i] == "\"" {
            if !in_string {
                in_string = true;
            } else {
                // 检查这是否是字符串的结束
                let next_non_space = find_next_non_space_char(&chars, i + 1);

                match next_non_space {
                    Some(c) if c == ',' || c == '}' || c == ']' => {
                        // 高置信度：值结束
                        in_string = false;
                    }
                    Some(':') => {
                        // 冒号需要二级验证
                        let colon_idx = find_next_non_space_index(&chars, i + 1);
                        if let Some(ci) = colon_idx {
                            let after_colon = find_next_non_space_char(&chars, ci + 1);
                            let is_json_value_start = matches!(
                                after_colon,
                                Some('"') | Some('{') | Some('[') | Some('t') | Some('f') | Some('n')
                            ) || after_colon.map_or(false, |c| c.is_ascii_digit() || c == '-');

                            if is_json_value_start {
                                in_string = false; // 确认是 JSON 键结束
                            } else {
                                // 冒号后面不是 JSON 值 → 内容引号
                                chars[i] = "\\\"".to_string();
                            }
                        } else {
                            chars[i] = "\\\"".to_string();
                        }
                    }
                    Some(_) => {
                        // 其他情况：内容引号
                        chars[i] = "\\\"".to_string();
                    }
                    None => {
                        // 到达末尾：可能是结尾引号
                        in_string = false;
                    }
                }
            }
        }
        i += 1;
    }

    chars.join("")
}

/// 查找下一个非空白字符
fn find_next_non_space_char(chars: &[String], start: usize) -> Option<char> {
    for item in chars.iter().skip(start) {
        let ch = item.chars().next()?;
        if !ch.is_whitespace() {
            return Some(ch);
        }
    }
    None
}

/// 查找下一个非空白字符的索引
fn find_next_non_space_index(chars: &[String], start: usize) -> Option<usize> {
    for (idx, item) in chars.iter().enumerate().skip(start) {
        if let Some(ch) = item.chars().next() {
            if !ch.is_whitespace() {
                return Some(idx);
            }
        }
    }
    None
}

/// 激进的 JSON 清理
///
/// 移植自 `JsonParser.ts::aggressiveSanitize`：
/// 可能丢失一些信息，但提高解析成功率
fn aggressive_sanitize(json: &str) -> String {
    let mut result = json.to_string();

    // 1. 移除所有 \r
    result = result.replace('\r', "");

    // 2. 将换行替换为空格
    result = result.replace('\n', " ");

    // 3. 压缩连续空白为单个空格
    let mut prev_space = false;
    let mut compressed = String::with_capacity(result.len());
    for ch in result.chars() {
        if ch.is_whitespace() {
            if !prev_space {
                compressed.push(' ');
            }
            prev_space = true;
        } else {
            compressed.push(ch);
            prev_space = false;
        }
    }
    result = compressed;

    // 4. 修复缺失逗号：`" "` → `", "`（两个字符串之间缺逗号）
    // 简化版：检测 `" "` 模式（引号-空白-引号）
    result = fix_missing_commas_between_strings(&result);

    // 5. 再次清理尾随逗号
    result = result.replace(",}", "}").replace(",]", "]");

    result
}

/// 修复字符串值之间缺失的逗号
///
/// 检测 `"value" "key"` 模式，补全为 `"value", "key"`
fn fix_missing_commas_between_strings(json: &str) -> String {
    let chars: Vec<char> = json.chars().collect();
    let mut result = String::with_capacity(json.len() + 32);
    let mut in_string = false;
    let mut escape_next = false;
    let mut last_was_string_end = false;

    for (_i, &ch) in chars.iter().enumerate() {
        if escape_next {
            result.push(ch);
            escape_next = false;
            last_was_string_end = false;
            continue;
        }

        if ch == '\\' && in_string {
            result.push(ch);
            escape_next = true;
            continue;
        }

        if ch == '"' {
            if !in_string {
                // 字符串开始
                if last_was_string_end {
                    // 前一个字符串结束后直接开始新字符串：补逗号
                    // 但需排除空白已被消费的情况
                    let has_comma = result.trim_end().ends_with(',');
                    let has_colon = result.trim_end().ends_with(':');
                    if !has_comma && !has_colon {
                        // 在前面插入逗号
                        let trimmed_len = result.trim_end().len();
                        result.truncate(trimmed_len);
                        result.push_str(", ");
                    }
                }
                in_string = true;
                last_was_string_end = false;
            } else {
                // 字符串结束
                in_string = false;
                last_was_string_end = true;
            }
            result.push(ch);
            continue;
        }

        if !in_string && ch.is_whitespace() {
            result.push(ch);
            // 保持 last_was_string_end 状态
            continue;
        }

        if !in_string {
            last_was_string_end = false;
        }

        result.push(ch);
    }

    result
}

/// 修复截断的 JSON
///
/// 移植自 `JsonParser.ts::repairTruncatedJson`：
/// 当流式传输中断或 max_tokens 截断时，补全缺失的引号和括号。
/// 核心策略：
/// 1. 检测未闭合的字符串 → 回退到最后一个完整键值对
/// 2. 清理末尾不完整内容（悬空逗号/冒号）
/// 3. 补全括号
fn repair_truncated_json(json: &str) -> String {
    let mut result = json.to_string();

    // 第一遍扫描：如果字符串被截断，回退到最后一个完整的键值对
    let (_, _, first_in_string) = scan_json_state(&result);
    if first_in_string {
        result = truncate_to_last_complete_value(&result);
    }

    // 清理末尾不完整内容
    result = result.trim_end().to_string();

    // 移除悬空的分隔符
    while result.ends_with(',') || result.ends_with(':') {
        result.pop();
        result = result.trim_end().to_string();
    }

    // 移除未完成的键（如 ,"key ）
    if result.ends_with('"') {
        let before_last_quote = result[..result.len() - 1].rfind('"');
        if let Some(pos) = before_last_quote {
            let between = &result[pos + 1..result.len() - 1];
            // 如果两个引号之间没有冒号，说明是未完成的键
            if !between.contains(':') {
                let before = result[..pos].trim_end();
                if before.ends_with(',') {
                    result = before[..before.len() - 1].to_string();
                }
            }
        }
    }

    // 最终扫描：统计未闭合状态并补全
    let (brace_count, bracket_count, in_string) = scan_json_state(&result);

    if in_string {
        result.push('"');
    }

    // 补全括号（先 ]，再 }）
    for _ in 0..bracket_count {
        result.push(']');
    }
    for _ in 0..brace_count {
        result.push('}');
    }

    result
}

/// 扫描 JSON 状态：返回 (未闭合大括号数, 未闭合方括号数, 是否在字符串内)
fn scan_json_state(json: &str) -> (i32, i32, bool) {
    let mut brace_count: i32 = 0;
    let mut bracket_count: i32 = 0;
    let mut in_string = false;
    let mut escape_next = false;

    for ch in json.chars() {
        if escape_next {
            escape_next = false;
            continue;
        }
        if ch == '\\' {
            escape_next = true;
            continue;
        }
        if ch == '"' {
            in_string = !in_string;
            continue;
        }
        if !in_string {
            match ch {
                '{' => brace_count += 1,
                '}' => brace_count -= 1,
                '[' => bracket_count += 1,
                ']' => bracket_count -= 1,
                _ => {}
            }
        }
    }

    (brace_count, bracket_count, in_string)
}

/// 截断到最后一个完整的键值对
///
/// 当字符串值被截断时，回退到该值之前的完整内容
fn truncate_to_last_complete_value(json: &str) -> String {
    // 找到最后一个未闭合字符串的开始位置
    let mut string_start_idx: usize = 0;
    let mut in_string = false;
    let mut escape_next = false;

    for (i, ch) in json.char_indices() {
        if escape_next {
            escape_next = false;
            continue;
        }
        if ch == '\\' {
            escape_next = true;
            continue;
        }
        if ch == '"' {
            if !in_string {
                string_start_idx = i;
            }
            in_string = !in_string;
        }
    }

    // 找到这个字符串之前的逗号或冒号
    if string_start_idx > 0 {
        let before_string = &json[..string_start_idx];
        let last_comma = before_string.rfind(',');
        let last_colon = before_string.rfind(':');
        let last_bracket = before_string.rfind('[');

        let colon_pos = last_colon.unwrap_or(0);
        let comma_pos = last_comma.unwrap_or(0);

        if colon_pos > comma_pos && colon_pos > 0 {
            // 对象值被截断，回退到这个键之前
            let search_area = &json[..colon_pos];
            let prev_comma = search_area.rfind(',');
            let prev_brace = search_area.rfind('{');

            let prev_comma_pos = prev_comma.unwrap_or(0);
            let prev_brace_pos = prev_brace.unwrap_or(0);

            if prev_comma_pos > prev_brace_pos && prev_comma_pos > 0 {
                return json[..prev_comma_pos].to_string();
            } else if prev_brace.is_some() {
                return json[..prev_brace_pos + 1].to_string();
            }
        } else if let Some(bracket_pos) = last_bracket {
            if bracket_pos > comma_pos {
                // 数组第一个元素被截断
                return json[..bracket_pos + 1].to_string();
            }
        }

        if comma_pos > 0 {
            return json[..comma_pos].to_string();
        }
    }

    // 无法判断，简单闭合字符串
    format!("{}\"", json)
}

/// 从损坏的 JSON 中提取已完成的顶层键值对（策略 7: 最终保底）
///
/// 当所有修复策略都失败时，使用字符级状态机逐个提取已完成的顶层 KV 对。
/// 核心思想：LLM 通常按 { "key1": "val1", "key2": "val2", ... } 顺序输出，
/// 即使后面的值因未转义引号/控制字符损坏，前面已完成的 KV 对仍可被安全提取。
///
/// 提取规则：
/// - 仅处理顶层对象的键值对（不处理嵌套对象/数组内部）
/// - 使用状态机追踪：对象开始 → 键 → 冒号 → 值 → 逗号/结束
/// - 值的类型支持：字符串、数字、布尔、null、嵌套对象/数组
/// - 对每个提取到的 `"key": value` 片段，用 serde_json 独立验证
/// - 提取到 0 个字段时返回 None（不回退为空对象）
fn extract_partial_fields(json: &str) -> Option<serde_json::Value> {
    let chars: Vec<char> = json.chars().collect();
    let len = chars.len();
    let mut result = serde_json::Map::new();

    // 跳过前导空白，找到对象开始 '{'
    let mut pos = skip_whitespace(&chars, 0);
    if pos >= len || chars[pos] != '{' {
        return None;
    }
    pos += 1; // 跳过 '{'

    loop {
        pos = skip_whitespace(&chars, pos);
        if pos >= len {
            break;
        }

        // 检查对象结束
        if chars[pos] == '}' {
            break;
        }

        // 跳过逗号分隔符
        if chars[pos] == ',' {
            pos += 1;
            continue;
        }

        // 期望键：必须是双引号字符串
        if chars[pos] != '"' {
            break; // 不是合法的键开始，停止提取
        }

        // 提取键
        let key_result = extract_json_string(&chars, pos);
        let (key, key_end) = match key_result {
            Some(v) => v,
            None => break, // 键提取失败（截断）
        };
        pos = key_end;

        // 跳过冒号
        pos = skip_whitespace(&chars, pos);
        if pos >= len || chars[pos] != ':' {
            break;
        }
        pos += 1;

        // 提取值
        pos = skip_whitespace(&chars, pos);
        if pos >= len {
            break;
        }

        let value_result = extract_json_value(&chars, pos);
        match value_result {
            Some((value_str, value_end)) => {
                // 对提取到的值片段独立验证
                if let Ok(parsed_value) = serde_json::from_str::<serde_json::Value>(&value_str) {
                    result.insert(key, parsed_value);
                }
                pos = value_end;
            }
            None => {
                // 值提取失败（损坏/截断），停止——后续字段不可信
                break;
            }
        }
    }

    // 提取到 0 个字段时不返回空对象，由调用方决定后续策略
    if result.is_empty() {
        return None;
    }

    Some(serde_json::Value::Object(result))
}

/// 跳过空白字符，返回下一个非空白字符的位置
fn skip_whitespace(chars: &[char], start: usize) -> usize {
    let mut i = start;
    while i < chars.len() && chars[i].is_whitespace() {
        i += 1;
    }
    i
}

/// 从指定位置提取一个完整的 JSON 字符串值
///
/// 返回 (字符串内容不含引号, 结束位置即闭合引号之后)
fn extract_json_string(chars: &[char], start: usize) -> Option<(String, usize)> {
    if start >= chars.len() || chars[start] != '"' {
        return None;
    }

    let mut i = start + 1;
    let mut content = String::new();

    while i < chars.len() {
        if chars[i] == '\\' {
            // 转义字符：跳过两个字符
            if i + 1 < chars.len() {
                content.push(chars[i]);
                content.push(chars[i + 1]);
                i += 2;
            } else {
                return None; // 转义序列截断
            }
        } else if chars[i] == '"' {
            // 字符串结束
            return Some((content, i + 1));
        } else {
            content.push(chars[i]);
            i += 1;
        }
    }

    None // 字符串未闭合（截断）
}

/// 从指定位置提取一个完整的 JSON 值
///
/// 支持字符串、数字、布尔、null、嵌套对象、数组
/// 返回 (原始 JSON 文本, 结束位置)
fn extract_json_value(chars: &[char], start: usize) -> Option<(String, usize)> {
    if start >= chars.len() {
        return None;
    }

    match chars[start] {
        '"' => {
            // 字符串值：返回包含引号的完整字符串
            let mut i = start + 1;
            while i < chars.len() {
                if chars[i] == '\\' {
                    i += 2; // 跳过转义
                    continue;
                }
                if chars[i] == '"' {
                    let raw: String = chars[start..=i].iter().collect();
                    return Some((raw, i + 1));
                }
                i += 1;
            }
            None // 字符串未闭合
        }
        '{' | '[' => {
            // 嵌套对象或数组：使用括号匹配计数
            let open = chars[start];
            let close = if open == '{' { '}' } else { ']' };
            let mut depth = 1;
            let mut i = start + 1;
            let mut in_string = false;

            while i < chars.len() && depth > 0 {
                if in_string {
                    if chars[i] == '\\' {
                        i += 2;
                        continue;
                    }
                    if chars[i] == '"' {
                        in_string = false;
                    }
                } else {
                    if chars[i] == '"' {
                        in_string = true;
                    } else if chars[i] == open {
                        depth += 1;
                    } else if chars[i] == close {
                        depth -= 1;
                    }
                }
                i += 1;
            }

            if depth == 0 {
                let raw: String = chars[start..i].iter().collect();
                Some((raw, i))
            } else {
                None // 括号未配对（截断）
            }
        }
        't' | 'f' | 'n' => {
            // 布尔或 null 字面量
            let literals = [("true", 4), ("false", 5), ("null", 4)];
            for (lit, lit_len) in &literals {
                if start + lit_len <= chars.len() {
                    let candidate: String = chars[start..start + lit_len].iter().collect();
                    if candidate == *lit {
                        return Some((candidate, start + lit_len));
                    }
                }
            }
            None
        }
        c if c.is_ascii_digit() || c == '-' => {
            // 数字（整数或浮点）
            let mut i = start;
            if chars[i] == '-' {
                i += 1;
            }
            while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.' || chars[i] == 'e' || chars[i] == 'E' || chars[i] == '+' || chars[i] == '-') {
                // 防止连续多个点/e
                if i > start + 1 && (chars[i] == '-' || chars[i] == '+') && chars[i - 1] != 'e' && chars[i - 1] != 'E' {
                    break;
                }
                i += 1;
            }
            if i > start {
                let raw: String = chars[start..i].iter().collect();
                Some((raw, i))
            } else {
                None
            }
        }
        _ => None, // 未知值类型
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // ---- repair_tool_call_json 集成测试 ----

    #[test]
    fn test_normal_json() {
        let result = repair_tool_call_json(r#"{"path": "test.txt", "content": "hello"}"#);
        assert!(result.is_some());
        assert_eq!(result.unwrap()["path"], "test.txt");
    }

    #[test]
    fn test_empty_returns_none() {
        assert!(repair_tool_call_json("").is_none());
    }

    #[test]
    fn test_completely_broken() {
        assert!(repair_tool_call_json("not json at all {{{").is_none());
    }

    // ---- sanitize_json 测试 ----

    #[test]
    fn test_sanitize_chinese_quotes() {
        let raw = "\u{201C}path\u{201D}: \u{201C}test.txt\u{201D}";
        let result = sanitize_json(&format!("{{{}}}", raw));
        assert!(result.contains("\"path\""));
        assert!(result.contains("\"test.txt\""));
    }

    #[test]
    fn test_sanitize_fullwidth_symbols() {
        let raw = r#"{"path"："test.txt"，"content"："hello"}"#;
        let result = sanitize_json(raw);
        assert!(result.contains(":"));
        assert!(result.contains(","));
        assert!(!result.contains('\u{FF1A}')); // 全角冒号已替换
    }

    #[test]
    fn test_sanitize_control_chars() {
        let raw = "{\"path\": \"test\x01.txt\", \"content\": \"he\x02llo\"}";
        let result = sanitize_json(raw);
        assert!(!result.contains('\x01'));
        let parsed = serde_json::from_str::<serde_json::Value>(&result);
        assert!(parsed.is_ok());
    }

    #[test]
    fn test_sanitize_trailing_comma() {
        let raw = r#"{"path": "test.txt", "content": "hello",}"#;
        let result = sanitize_json(raw);
        let parsed = serde_json::from_str::<serde_json::Value>(&result);
        assert!(parsed.is_ok());
    }

    #[test]
    fn test_sanitize_trailing_comma_with_whitespace() {
        let raw = "{\n  \"path\": \"test.txt\",\n  \"content\": \"hello\",\n}";
        let result = sanitize_json(raw);
        let parsed = serde_json::from_str::<serde_json::Value>(&result);
        assert!(parsed.is_ok());
    }

    // ---- fix_invalid_escapes 测试 ----

    #[test]
    fn test_fix_windows_path_escapes() {
        // 模拟 LLM 输出 Windows 路径时的非法转义
        let raw = r#"{"path": "C:\Users\Admin\test.txt"}"#;
        let result = fix_invalid_escapes(raw);
        let parsed = serde_json::from_str::<serde_json::Value>(&result);
        assert!(parsed.is_ok());
        // 修复后路径中的 \U \A \t 应变为 \\U \\A \\t（合法转义保持）
    }

    #[test]
    fn test_fix_escapes_preserves_valid() {
        let raw = r#"{"content": "line1\nline2\tindented"}"#;
        let result = fix_invalid_escapes(raw);
        assert_eq!(result, raw); // 合法转义应不变
    }

    // ---- normalize_line_breaks 测试 ----

    #[test]
    fn test_normalize_raw_newlines_in_strings() {
        // 字符串值中含有实际换行符（非转义序列）
        let raw = "{\n\"content\": \"line1\nline2\"\n}";
        let result = normalize_line_breaks(raw);
        // 仅字符串值内的换行应被转义
        let parsed = serde_json::from_str::<serde_json::Value>(&result);
        assert!(parsed.is_ok());
    }

    // ---- fix_nested_quotes 测试 ----

    #[test]
    fn test_fix_nested_quotes_in_value() {
        // 值内有未转义引号
        let raw = r#"{"reason": "用户说"不要""}"#;
        let result = fix_nested_quotes(raw);
        let parsed = serde_json::from_str::<serde_json::Value>(&result);
        assert!(parsed.is_ok());
    }

    // ---- aggressive_sanitize 测试 ----

    #[test]
    fn test_aggressive_compress_whitespace() {
        let raw = r#"{"path":  "test.txt",    "content":  "hello"}"#;
        let result = aggressive_sanitize(raw);
        let parsed = serde_json::from_str::<serde_json::Value>(&result);
        assert!(parsed.is_ok());
    }

    // ---- repair_truncated_json 测试 ----

    #[test]
    fn test_repair_truncated_simple() {
        let raw = r#"{"path": "test.txt", "content": "hello world"#;
        let result = repair_truncated_json(raw);
        let parsed = serde_json::from_str::<serde_json::Value>(&result);
        assert!(parsed.is_ok());
    }

    #[test]
    fn test_repair_truncated_nested() {
        let raw = r#"{"path": "test.txt", "patches": [{"search": "foo", "replace": "bar"}"#;
        let result = repair_truncated_json(raw);
        let parsed = serde_json::from_str::<serde_json::Value>(&result);
        assert!(parsed.is_ok());
        let val = parsed.unwrap();
        assert_eq!(val["path"], "test.txt");
    }

    #[test]
    fn test_repair_truncated_with_dangling_comma() {
        let raw = r#"{"path": "test.txt","#;
        let result = repair_truncated_json(raw);
        let parsed = serde_json::from_str::<serde_json::Value>(&result);
        assert!(parsed.is_ok());
    }

    #[test]
    fn test_repair_truncated_mid_value() {
        // 值被截断在中间
        let raw = r#"{"path": "test.txt", "content": "function foo() { retur"#;
        let result = repair_tool_call_json(raw);
        assert!(result.is_some());
        let val = result.unwrap();
        assert_eq!(val["path"], "test.txt");
    }

    #[test]
    fn test_repair_truncated_with_unicode_before_cut() {
        let raw = r#"{"title": "像梦一样", "path": "test.txt", "content": "function foo() { retur"#;
        let result = repair_tool_call_json(raw);
        assert!(result.is_some());
        let val = result.unwrap();
        assert_eq!(val["title"], "像梦一样");
        assert_eq!(val["path"], "test.txt");
    }

    #[test]
    fn test_repair_length_guard_does_not_split_unicode_boundary() {
        let mut raw = "x".repeat(MAX_REPAIR_LENGTH - 2);
        raw.push('的');
        raw.push_str(" malformed");

        let _ = repair_tool_call_json(&raw);
    }

    // ---- 综合测试：模拟真实 file_write 场景 ----

    #[test]
    fn test_real_world_file_write_with_code() {
        // 模拟 file_write 的 content 含代码，且 JSON 有各种问题
        let raw = r#"{"path": "C:\Users\Admin\project\main.py", "content": "def hello():\n    print(\"world\")\n"}"#;
        let result = repair_tool_call_json(raw);
        assert!(result.is_some());
    }

    #[test]
    fn test_real_world_truncated_large_content() {
        // 模拟大文件内容被截断
        let mut raw = "{\"path\": \"test.py\", \"content\": \"# very long code\\n".to_string();
        for i in 0..100 {
            raw.push_str(&format!("line {} = data\\n", i));
        }
        // 不闭合引号和大括号，模拟截断
        let result = repair_tool_call_json(&raw);
        assert!(result.is_some());
        assert_eq!(result.unwrap()["path"], "test.py");
    }

    // ---- extract_partial_fields 测试 ----

    #[test]
    fn test_partial_extraction_broken_content_value() {
        // 核心场景：content 值中含未转义引号导致 JSON 整体损坏，
        // 但 path 在 content 之前已完整输出
        let raw = r#"{"path": "src/main.ts", "content": "const msg = "hello"; console.log(msg);"}"#;
        // serde_json 直接解析一定失败
        assert!(serde_json::from_str::<serde_json::Value>(raw).is_err());
        // partial extraction 应能提取 path
        let result = extract_partial_fields(raw);
        assert!(result.is_some());
        let val = result.unwrap();
        assert_eq!(val["path"], "src/main.ts");
    }

    #[test]
    fn test_partial_extraction_truncated_no_closing() {
        // content 被截断，无闭合引号和大括号
        let raw = r#"{"path": "app.py", "mode": "overwrite", "content": "def main():\n    print("hello"#;
        let result = extract_partial_fields(raw);
        assert!(result.is_some());
        let val = result.unwrap();
        assert_eq!(val["path"], "app.py");
        assert_eq!(val["mode"], "overwrite");
        // content 无法完整提取，不应存在
    }

    #[test]
    fn test_partial_extraction_number_and_bool_values() {
        // 混合类型值：数字、布尔、null
        let raw = r#"{"count": 42, "enabled": true, "label": null, "broken_field": "unclosed"#;
        let result = extract_partial_fields(raw);
        assert!(result.is_some());
        let val = result.unwrap();
        assert_eq!(val["count"], 42);
        assert_eq!(val["enabled"], true);
        assert!(val["label"].is_null());
        // broken_field 字符串未闭合，不应存在
        assert!(val.get("broken_field").is_none());
    }

    #[test]
    fn test_partial_extraction_nested_object_value() {
        // 嵌套对象值完整，但后面的字段损坏
        let raw = r#"{"metadata": {"lang": "ts"}, "path": "test.ts", "content": "let x = "broken"#;
        let result = extract_partial_fields(raw);
        assert!(result.is_some());
        let val = result.unwrap();
        assert_eq!(val["metadata"]["lang"], "ts");
        assert_eq!(val["path"], "test.ts");
    }

    #[test]
    fn test_partial_extraction_returns_none_for_empty() {
        // 完全无法提取任何字段时返回 None，而非空对象
        assert!(extract_partial_fields("").is_none());
        assert!(extract_partial_fields("not json").is_none());
        assert!(extract_partial_fields("{").is_none());
        assert!(extract_partial_fields("{}").is_none()); // 空对象无字段
    }

    #[test]
    fn test_partial_extraction_via_repair_pipeline() {
        // 通过 repair_tool_call_json 入口验证 partial extraction 被正确触发
        // 构造「所有前置策略都无法修复，但 partial extraction 能提取」的场景
        // 场景：content 含大量未转义引号，结构严重损坏
        let raw = r#"{"path": "/tmp/test.js", "content": "const a = "x"; const b = "y"; const c = "z";"}"#;
        let result = repair_tool_call_json(raw);
        assert!(result.is_some());
        assert_eq!(result.unwrap()["path"], "/tmp/test.js");
    }
}

// ============================================================================
// SSE 数据预清理（供供应商适配器 SSE 解析层调用）
// ============================================================================

/// 修复 SSE 事件 data 字段中的残缺 Unicode 转义序列
///
/// 第三方 API 的 JSON 编码器存在 bug，在长响应中偶尔
/// 生成 `\uXX`（仅 2–3 位十六进制）而非合法的 `\uXXXX`（4 位）。
/// serde_json 严格遵循 JSON 规范，遇到此类残缺转义直接报错，
/// 导致 AgentLoop 捕获到 "unexpected end of hex escape" 错误。
///
/// 使用完整状态机遍历 JSON 数据：
/// - `\uXXXX`（后续有 4 位十六进制）→ 原样保留（含后4位整体跳过）
/// - `\uXX` 残缺 → 将 `\u` 替换为 `\\u`，变为字面量字符串，serde_json 可正常解析
/// - `\"` 等合法转义 → 原样保留，且**不触发字符串结束**（正确推进状态机）
///
/// 先处理反斜杠分支（含 `\"` 的正确跳过），再处理字符串结束引号，消除误判。
pub fn sanitize_sse_data(data: &str) -> std::borrow::Cow<'_, str> {
    // 快速检查：如果不含 `\\u`，直接返回原始引用（零拷贝）
    if !data.contains("\\u") {
        return std::borrow::Cow::Borrowed(data);
    }

    let chars: Vec<char> = data.chars().collect();
    let mut result = String::with_capacity(data.len() + 16);
    let mut in_string = false;
    let mut i = 0;

    while i < chars.len() {
        let ch = chars[i];

        if !in_string {
            // 字符串外部：追踪引号边界（仅双引号开启字符串）
            if ch == '"' {
                in_string = true;
            }
            result.push(ch);
            i += 1;
            continue;
        }

        // ── 字符串内部 ──

        if ch == '\\' {
            if i + 1 >= chars.len() {
                // 末尾孤立反斜杠：转义
                result.push_str("\\\\");
                i += 1;
                continue;
            }

            let next = chars[i + 1];
            match next {
                // 合法转义序列：\" \\ \/ \b \f \n \r \t → 原样保留，正确推进状态机
                // 尤其 \" 不等于字符串结束
                '"' | '\\' | '/' | 'b' | 'f' | 'n' | 'r' | 't' => {
                    result.push(ch);
                    result.push(next);
                    i += 2;
                }
                // \uXXXX 转义：验证后4位是否全为十六进制
                'u' => {
                    let hex_start = i + 2;
                    let hex_end = hex_start + 4;
                    let has_valid_hex = hex_end <= chars.len()
                        && chars[hex_start..hex_end].iter().all(|c| c.is_ascii_hexdigit());

                    if has_valid_hex {
                        // 合法 \uXXXX：原样保留含后4位，跳过6个字符
                        result.push(ch);   // \
                        result.push(next); // u
                        for k in hex_start..hex_end {
                            result.push(chars[k]);
                        }
                        i = hex_end;
                    } else {
                        // 残缺 \uXX：将反斜杠转义为 \\，变成字面量 \u
                        // serde_json 解析 \\uXX 后得到字面量字符串 \uXX，不再报错
                        result.push_str("\\\\u");
                        i += 2; // 跳过 \ 和 u，下一轮继续处理后续字符
                    }
                }
                // 其他非法转义：转义反斜杠，下一轮处理 next 本身
                _ => {
                    result.push_str("\\\\");
                    i += 1;
                }
            }
            continue;
        }

        if ch == '"' {
            // 未转义的引号 = 字符串结束（转义引号已在上面的反斜杠分支处理）
            in_string = false;
            result.push(ch);
            i += 1;
            continue;
        }

        // 普通字符
        result.push(ch);
        i += 1;
    }

    std::borrow::Cow::Owned(result)
}
