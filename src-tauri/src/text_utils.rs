//! UTF-8 文本处理工具。

/// 安全截断 UTF-8 字符串到不超过 max_bytes 的字符边界。
pub(crate) fn safe_truncate(s: &str, max_bytes: usize) -> &str {
    if max_bytes >= s.len() {
        return s;
    }

    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_truncate_keeps_ascii_unchanged_within_limit() {
        assert_eq!(safe_truncate("hello", 10), "hello");
        assert_eq!(safe_truncate("hello", 3), "hel");
    }

    #[test]
    fn safe_truncate_moves_back_to_utf8_boundary() {
        let mut text = "x".repeat(198);
        text.push('的');
        text.push_str("abc");

        assert_eq!(safe_truncate(&text, 200), "x".repeat(198));
    }
}
