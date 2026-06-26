//! PowerShell payload 中的直连网络目标解析。

use super::super::NetworkDirectTarget;
use super::direct_targets::{dedupe_network_direct_targets, detect_non_http_command_direct_target};
use super::scan::{command_token_name, powershell_command_payload, split_command_tokens};

pub(crate) fn detect_powershell_direct_targets(command: &str) -> Vec<NetworkDirectTarget> {
    let Some(payload) = powershell_command_payload(command) else {
        return Vec::new();
    };

    let mut targets = Vec::new();
    if let Some(target) = powershell_test_netconnection_target(&payload) {
        targets.push(target);
    }
    targets.extend(powershell_tcpclient_call_targets(&payload));
    if let Some(target) = detect_non_http_command_direct_target(&payload) {
        targets.push(target);
    }
    dedupe_network_direct_targets(targets)
}

fn powershell_test_netconnection_target(payload: &str) -> Option<NetworkDirectTarget> {
    let tokens = split_command_tokens(payload);
    for (index, token) in tokens.iter().enumerate() {
        let command_name = powershell_command_token_name(token);
        if !matches!(command_name.as_str(), "test-netconnection" | "tnc") {
            continue;
        }

        let host = powershell_option_value(&tokens, index, &["-computername", "-cn"])
            .or_else(|| powershell_first_positional_after(&tokens, index));
        let port = powershell_u16_option_value(&tokens, index, &["-port"])?;
        return NetworkDirectTarget::new("tcp", host?, port);
    }
    None
}

fn powershell_tcpclient_call_targets(payload: &str) -> Vec<NetworkDirectTarget> {
    let lower = payload.to_ascii_lowercase();
    if !lower.contains("tcpclient") && !lower.contains("system.net.sockets") {
        return Vec::new();
    }

    let mut targets = Vec::new();
    for marker in [".connect(", "::new(", "tcpclient("] {
        let mut search_from = 0;
        while let Some(relative_index) = lower[search_from..].find(marker) {
            let index = search_from + relative_index;
            search_from = index + marker.len();
            if matches!(marker, "::new(" | "tcpclient(")
                && !nearby_powershell_type_contains(&lower, index, "tcpclient")
            {
                continue;
            }

            let open_paren = index + marker.len() - 1;
            let Some(args) = extract_parenthesized_arguments(payload, open_paren) else {
                continue;
            };
            let parts = split_top_level_arguments(&args);
            let Some(host) = parts
                .first()
                .and_then(|value| clean_powershell_literal(value))
            else {
                continue;
            };
            let Some(port) = parts
                .get(1)
                .and_then(|value| clean_powershell_literal(value))
                .and_then(|value| value.parse::<u16>().ok())
            else {
                continue;
            };
            if let Some(target) = NetworkDirectTarget::new("tcp", host, port) {
                targets.push(target);
            }
        }
    }

    dedupe_network_direct_targets(targets)
}

pub(super) fn powershell_command_token_name(token: &str) -> String {
    command_token_name(trim_powershell_token(token))
}

fn trim_powershell_token(token: &str) -> &str {
    token
        .trim()
        .trim_matches(|ch| matches!(ch, '"' | '\'' | '`' | ';' | ',' | '(' | ')' | '{' | '}'))
}

fn powershell_option_value(
    tokens: &[String],
    command_index: usize,
    options: &[&str],
) -> Option<String> {
    let mut index = command_index + 1;
    while index < tokens.len() {
        let token = trim_powershell_token(&tokens[index]);
        if token == "|" || token == "&" {
            break;
        }
        let lower = token.to_ascii_lowercase();
        if matches!(
            powershell_command_token_name(token).as_str(),
            "test-netconnection" | "tnc"
        ) && index != command_index
        {
            break;
        }

        for option in options {
            if lower == *option {
                return tokens
                    .get(index + 1)
                    .and_then(|value| clean_powershell_literal(value));
            }
            for separator in [":", "="] {
                let prefix = format!("{option}{separator}");
                if let Some(value) = lower.strip_prefix(&prefix) {
                    if let Some(original_value) = token.get(prefix.len()..) {
                        return clean_powershell_literal(original_value);
                    }
                    return clean_powershell_literal(value);
                }
            }
        }

        index += 1;
    }

    None
}

fn powershell_u16_option_value(
    tokens: &[String],
    command_index: usize,
    options: &[&str],
) -> Option<u16> {
    powershell_option_value(tokens, command_index, options)
        .and_then(|value| value.parse::<u16>().ok())
}

fn powershell_first_positional_after(tokens: &[String], command_index: usize) -> Option<String> {
    let mut skip_next = false;
    for token in tokens.iter().skip(command_index + 1) {
        let trimmed = trim_powershell_token(token);
        if trimmed == "|" || trimmed == "&" {
            break;
        }
        if skip_next {
            skip_next = false;
            continue;
        }
        let lower = trimmed.to_ascii_lowercase();
        if matches!(lower.as_str(), "-port" | "-computername" | "-cn") {
            skip_next = true;
            continue;
        }
        if lower.starts_with("-port:") || lower.starts_with("-port=") {
            continue;
        }
        if lower.starts_with("-computername:")
            || lower.starts_with("-computername=")
            || lower.starts_with("-cn:")
            || lower.starts_with("-cn=")
        {
            continue;
        }
        if lower.starts_with('-') {
            continue;
        }
        return clean_powershell_literal(trimmed);
    }
    None
}

fn clean_powershell_literal(value: &str) -> Option<String> {
    let value = trim_powershell_token(value);
    if value.is_empty()
        || value.starts_with('$')
        || value.starts_with('@')
        || value.eq_ignore_ascii_case("$null")
    {
        return None;
    }
    Some(value.to_string())
}

fn nearby_powershell_type_contains(lower: &str, index: usize, needle: &str) -> bool {
    let start = index.saturating_sub(96);
    lower[start..index].contains(needle)
}

fn extract_parenthesized_arguments(payload: &str, open_paren_index: usize) -> Option<String> {
    if payload.as_bytes().get(open_paren_index).copied() != Some(b'(') {
        return None;
    }

    let mut depth = 0usize;
    let mut quote: Option<char> = None;
    let mut start = None;
    for (offset, ch) in payload[open_paren_index..].char_indices() {
        let absolute_index = open_paren_index + offset;
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => continue,
            None if ch == '\'' || ch == '"' => quote = Some(ch),
            None if ch == '(' => {
                depth += 1;
                if start.is_none() {
                    start = Some(absolute_index + ch.len_utf8());
                }
            }
            None if ch == ')' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    let start = start?;
                    return Some(payload[start..absolute_index].to_string());
                }
            }
            None => {}
        }
    }

    None
}

fn split_top_level_arguments(arguments: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut depth = 0usize;

    for ch in arguments.chars() {
        match quote {
            Some(q) if ch == q => {
                quote = None;
                current.push(ch);
            }
            Some(_) => current.push(ch),
            None if ch == '\'' || ch == '"' => {
                quote = Some(ch);
                current.push(ch);
            }
            None if matches!(ch, '(' | '[' | '{') => {
                depth += 1;
                current.push(ch);
            }
            None if matches!(ch, ')' | ']' | '}') => {
                depth = depth.saturating_sub(1);
                current.push(ch);
            }
            None if ch == ',' && depth == 0 => {
                parts.push(current.trim().to_string());
                current.clear();
            }
            None => current.push(ch),
        }
    }
    if !current.trim().is_empty() {
        parts.push(current.trim().to_string());
    }

    parts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_test_netconnection_targets() {
        let cases = [
            (
                r#"powershell -NoProfile -Command "Test-NetConnection -ComputerName 127.0.0.1 -Port 5432""#,
                "127.0.0.1",
                5432,
            ),
            (
                r#"pwsh -NoProfile -Command "tnc imap.gmail.com -Port 993""#,
                "imap.gmail.com",
                993,
            ),
            (
                r#"powershell -NoProfile -Command "Test-NetConnection -ComputerName:169.254.169.254 -Port:80""#,
                "169.254.169.254",
                80,
            ),
        ];

        for (command, host, port) in cases {
            let targets = detect_powershell_direct_targets(command);
            assert_eq!(targets.len(), 1, "command: {command}");
            assert_eq!(targets[0].protocol, "tcp", "command: {command}");
            assert_eq!(targets[0].host, host, "command: {command}");
            assert_eq!(targets[0].port, port, "command: {command}");
        }
    }

    #[test]
    fn extracts_tcpclient_targets() {
        let command = r#"powershell -NoProfile -Command "$tcp = New-Object Net.Sockets.TcpClient; $tcp.Connect('example.com',80)""#;

        let targets = detect_powershell_direct_targets(command);

        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].protocol, "tcp");
        assert_eq!(targets[0].host, "example.com");
        assert_eq!(targets[0].port, 80);
    }
}
