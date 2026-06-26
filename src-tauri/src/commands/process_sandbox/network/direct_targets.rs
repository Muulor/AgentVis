//! 非 HTTP(S) direct-audit 协议目标解析与授权目标回填。

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::PathBuf;

use super::super::types::{
    normalize_direct_target_host, NetworkDirectAllowance, NetworkDirectTarget,
};
use super::powershell::detect_powershell_direct_targets;
use super::scan::{
    command_token_name, extract_first_script_path, resolve_script_candidates, split_command_tokens,
};

pub(crate) fn detect_network_direct_targets(
    command: &str,
    workdir: Option<&str>,
) -> Vec<NetworkDirectTarget> {
    let mut targets = detect_email_helper_direct_targets(command, workdir);
    if targets.is_empty() {
        targets.extend(detect_powershell_direct_targets(command));
    }
    if targets.is_empty() {
        if let Some(target) = detect_non_http_command_direct_target(command) {
            targets.push(target);
        }
    }
    dedupe_network_direct_targets(targets)
}

pub(crate) fn required_network_direct_protocols(
    command: &str,
    workdir: Option<&str>,
) -> Vec<String> {
    let protocols = email_helper_required_protocols(command, workdir)
        .into_iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    protocols
}

pub(crate) fn direct_targets_from_allowances_for_protocols(
    protocols: &[String],
    allowances: &[NetworkDirectAllowance],
) -> Vec<NetworkDirectTarget> {
    let mut targets = Vec::new();
    for protocol in protocols {
        let Some(target) = allowances
            .iter()
            .find(|allowance| allowance.protocol.eq_ignore_ascii_case(protocol))
            .and_then(|allowance| {
                NetworkDirectTarget::new(
                    allowance.protocol.clone(),
                    allowance.host.clone(),
                    allowance.port,
                )
            })
        else {
            return Vec::new();
        };
        targets.push(target);
    }
    dedupe_network_direct_targets(targets)
}

pub(crate) fn is_metadata_direct_target(target: &NetworkDirectTarget) -> bool {
    let host = target.host.trim_end_matches('.').to_ascii_lowercase();
    if matches!(
        host.as_str(),
        "metadata"
            | "metadata.google.internal"
            | "metadata.azure.internal"
            | "metadata.aliyuncs.com"
    ) {
        return true;
    }

    host.parse::<IpAddr>().map(is_metadata_ip).unwrap_or(false)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NetworkDirectTargetRiskInfo {
    pub risk: &'static str,
    pub resolved_ip_samples: Vec<String>,
    pub reason: &'static str,
}

impl NetworkDirectTargetRiskInfo {
    fn new(
        risk: &'static str,
        resolved_ip_samples: Vec<String>,
        reason: &'static str,
    ) -> Self {
        Self {
            risk,
            resolved_ip_samples,
            reason,
        }
    }

    pub(crate) fn audit_detail(&self) -> String {
        let ips = if self.resolved_ip_samples.is_empty() {
            "none".to_string()
        } else {
            self.resolved_ip_samples.join(",")
        };
        format!("resolvedRisk={}; reason={}; ips={}", self.risk, self.reason, ips)
    }
}

pub(crate) async fn resolve_network_direct_target_risk(
    target: &NetworkDirectTarget,
) -> NetworkDirectTargetRiskInfo {
    let host = target.host.trim_end_matches('.').to_ascii_lowercase();
    if matches!(
        host.as_str(),
        "metadata"
            | "metadata.google.internal"
            | "metadata.azure.internal"
            | "metadata.aliyuncs.com"
    ) {
        return NetworkDirectTargetRiskInfo::new("metadata", Vec::new(), "metadataHostname");
    }
    if host == "localhost" || host.ends_with(".localhost") {
        return NetworkDirectTargetRiskInfo::new("private", Vec::new(), "localhostHostname");
    }

    let mapped_host = host.strip_prefix("::ffff:").unwrap_or(&host);
    if let Ok(ip) = mapped_host.parse::<IpAddr>() {
        return classify_direct_target_ip_samples(&[ip], false);
    }

    if let Some(ip) = encoded_hostname_ip(&host) {
        return classify_encoded_hostname_ip(ip);
    }

    let lookup_result = tokio::net::lookup_host((host.as_str(), target.port)).await;
    match lookup_result {
        Ok(addresses) => {
            let mut all_ips = Vec::<IpAddr>::new();
            for address in addresses {
                let ip = address.ip();
                if !all_ips.contains(&ip) {
                    all_ips.push(ip);
                }
            }
            if all_ips.is_empty() {
                NetworkDirectTargetRiskInfo::new("unknown", Vec::new(), "dnsReturnedNoAddress")
            } else {
                classify_direct_target_ip_samples(&all_ips, true)
            }
        }
        Err(error) => NetworkDirectTargetRiskInfo::new(
            "unknown",
            Vec::new(),
            if error.kind() == std::io::ErrorKind::NotFound {
                "dnsNotFound"
            } else {
                "dnsResolutionFailed"
            },
        ),
    }
}

pub(crate) fn encoded_hostname_target_risk(host: &str) -> Option<NetworkDirectTargetRiskInfo> {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    encoded_hostname_ip(&host).map(classify_encoded_hostname_ip)
}

fn classify_direct_target_ip_samples(
    ips: &[IpAddr],
    from_dns: bool,
) -> NetworkDirectTargetRiskInfo {
    let samples = ips
        .iter()
        .take(3)
        .map(ToString::to_string)
        .collect::<Vec<_>>();

    if ips.iter().any(|ip| is_metadata_ip(*ip)) {
        return NetworkDirectTargetRiskInfo::new(
            "metadata",
            samples,
            if from_dns {
                "dnsResolvedMetadataIp"
            } else {
                "literalMetadataIp"
            },
        );
    }

    if ips.iter().any(|ip| is_private_or_local_ip(*ip)) {
        return NetworkDirectTargetRiskInfo::new(
            "private",
            samples,
            if from_dns {
                "dnsResolvedPrivateOrLocalIp"
            } else {
                "literalPrivateOrLocalIp"
            },
        );
    }

    if ips.iter().any(|ip| is_benchmark_or_proxy_mapped_ip(*ip)) {
        return NetworkDirectTargetRiskInfo::new(
            "public",
            samples,
            if from_dns {
                "dnsResolvedBenchmarkOrProxyIp"
            } else {
                "literalBenchmarkOrProxyIp"
            },
        );
    }

    NetworkDirectTargetRiskInfo::new(
        "public",
        samples,
        if from_dns {
            "dnsResolvedPublicIp"
        } else {
            "literalPublicIp"
        },
    )
}

fn classify_encoded_hostname_ip(ip: IpAddr) -> NetworkDirectTargetRiskInfo {
    let samples = vec![ip.to_string()];
    if is_metadata_ip(ip) {
        return NetworkDirectTargetRiskInfo::new("metadata", samples, "hostnameEncodedMetadataIp");
    }
    if is_private_or_local_ip(ip) {
        return NetworkDirectTargetRiskInfo::new(
            "private",
            samples,
            "hostnameEncodedPrivateOrLocalIp",
        );
    }
    if is_benchmark_or_proxy_mapped_ip(ip) {
        return NetworkDirectTargetRiskInfo::new(
            "public",
            samples,
            "hostnameEncodedBenchmarkOrProxyIp",
        );
    }
    NetworkDirectTargetRiskInfo::new("public", samples, "hostnameEncodedPublicIp")
}

fn encoded_hostname_ip(host: &str) -> Option<IpAddr> {
    encoded_hostname_ipv4(host).map(IpAddr::V4)
}

fn encoded_hostname_ipv4(host: &str) -> Option<Ipv4Addr> {
    let encoded_suffixes = [".sslip.io", ".nip.io", ".xip.io"];
    let prefix = encoded_suffixes
        .iter()
        .find_map(|suffix| host.strip_suffix(suffix))?;
    let labels = prefix
        .split('.')
        .filter(|label| !label.is_empty())
        .collect::<Vec<_>>();

    if let Some(last_label) = labels.last() {
        if let Some(ip) = parse_ipv4_parts(&last_label.split('-').collect::<Vec<_>>()) {
            return Some(ip);
        }
    }

    if labels.len() < 4 {
        return None;
    }
    parse_ipv4_parts(&labels[labels.len() - 4..])
}

fn parse_ipv4_parts(parts: &[&str]) -> Option<Ipv4Addr> {
    let [a, b, c, d] = parts else {
        return None;
    };
    Some(Ipv4Addr::new(
        parse_ipv4_octet(a)?,
        parse_ipv4_octet(b)?,
        parse_ipv4_octet(c)?,
        parse_ipv4_octet(d)?,
    ))
}

fn parse_ipv4_octet(value: &str) -> Option<u8> {
    if value.is_empty() || !value.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    value.parse::<u8>().ok()
}

fn is_metadata_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip == Ipv4Addr::new(169, 254, 169, 254)
                || ip == Ipv4Addr::new(169, 254, 170, 2)
                || ip == Ipv4Addr::new(100, 100, 100, 200)
        }
        IpAddr::V6(_) => false,
    }
}

fn is_private_or_local_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_private_or_local_ipv4(ip),
        IpAddr::V6(ip) => is_private_or_local_ipv6(ip),
    }
}

fn is_private_or_local_ipv4(ip: Ipv4Addr) -> bool {
    ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip.octets()[0] == 0
        || ip.octets()[0] >= 224
        || is_cgnat_ipv4(ip)
}

fn is_cgnat_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    octets[0] == 100 && (64..=127).contains(&octets[1])
}

fn is_benchmark_or_proxy_mapped_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let octets = ip.octets();
            octets[0] == 198 && (18..=19).contains(&octets[1])
        }
        IpAddr::V6(_) => false,
    }
}

fn is_private_or_local_ipv6(ip: Ipv6Addr) -> bool {
    let first_segment = ip.segments()[0];
    ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_multicast()
        || (first_segment & 0xfe00) == 0xfc00
        || (first_segment & 0xffc0) == 0xfe80
}

pub(super) fn dedupe_network_direct_targets(
    targets: Vec<NetworkDirectTarget>,
) -> Vec<NetworkDirectTarget> {
    let mut deduped: Vec<NetworkDirectTarget> = Vec::new();
    for target in targets {
        if !deduped.iter().any(|existing| existing == &target) {
            deduped.push(target);
        }
    }
    deduped
}

pub(crate) fn is_known_local_network_metadata_action(command: &str, workdir: Option<&str>) -> bool {
    if is_email_helper_command(command) {
        return matches!(
            command_option_value(command, "--action").as_deref(),
            Some("setup_account" | "network_targets")
        );
    }

    matches!(
        command_option_value(command, "--action").as_deref(),
        Some("network_targets")
    ) && external_skill_entrypoint_declares_legacy_non_http(command, workdir)
}

fn is_email_helper_command(command: &str) -> bool {
    extract_first_script_path(command).is_some_and(|script| {
        script
            .replace('\\', "/")
            .to_ascii_lowercase()
            .ends_with("email_helper.py")
    })
}

fn external_skill_root_from_normalized_path(path: &str) -> Option<PathBuf> {
    let lower = path.to_ascii_lowercase();
    for marker in ["/skills/external/packages/", "/skills-bundle/"] {
        let Some(marker_index) = lower.find(marker) else {
            continue;
        };
        let skill_start = marker_index + marker.len();
        let rest = &path[skill_start..];
        let skill_end = rest.find('/').unwrap_or(rest.len());
        if skill_end == 0 {
            continue;
        }
        return Some(PathBuf::from(&path[..skill_start + skill_end]));
    }

    None
}

fn normalize_skill_entry_path(entry: &str) -> String {
    entry
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .replace('\\', "/")
        .trim_start_matches("./")
        .replace("//", "/")
        .to_ascii_lowercase()
}

fn frontmatter_network_value_is_legacy_non_http(value: &str) -> bool {
    let value = value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .to_ascii_lowercase();
    matches!(
        value.as_str(),
        "legacynonhttp" | "legacy-non-http" | "legacy_non_http"
    )
}

fn skill_frontmatter_entry_declares_legacy_non_http(content: &str, entry: &str) -> bool {
    let normalized = content.replace("\r\n", "\n");
    let mut lines = normalized.lines();
    if !matches!(lines.next().map(str::trim), Some("---")) {
        return false;
    }

    let requested_entry = normalize_skill_entry_path(entry);
    let mut in_entrypoints = false;
    for line in lines {
        let indent = line.len() - line.trim_start().len();
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }
        let Some((key, value)) = trimmed.split_once(':') else {
            continue;
        };
        let key = key.trim();
        if in_entrypoints && indent > 0 {
            let normalized_key = normalize_skill_entry_path(key);
            if requested_entry == normalized_key
                && frontmatter_network_value_is_legacy_non_http(value)
            {
                return true;
            }
            continue;
        }
        in_entrypoints = false;
        if matches!(
            key,
            "agentvisNetworkEntrypoints" | "agentvis_network_entrypoints"
        ) && value.trim().is_empty()
        {
            in_entrypoints = true;
        }
    }

    false
}

fn external_skill_entrypoint_declares_legacy_non_http(
    command: &str,
    workdir: Option<&str>,
) -> bool {
    let Some(script_path) = extract_first_script_path(command) else {
        return false;
    };

    for candidate in resolve_script_candidates(&script_path, workdir) {
        let candidate_normalized = candidate.to_string_lossy().replace('\\', "/");
        let Some(root) = external_skill_root_from_normalized_path(&candidate_normalized) else {
            continue;
        };
        let root_normalized = root.to_string_lossy().replace('\\', "/");
        let entry = candidate_normalized
            .strip_prefix(root_normalized.trim_end_matches('/'))
            .map(|value| value.trim_start_matches('/'))
            .filter(|value| !value.is_empty());
        let Some(entry) = entry else {
            continue;
        };
        if std::fs::read_to_string(root.join("SKILL.md"))
            .map(|content| skill_frontmatter_entry_declares_legacy_non_http(&content, entry))
            .unwrap_or(false)
        {
            return true;
        }
    }

    false
}

fn email_helper_required_protocols(command: &str, _workdir: Option<&str>) -> Vec<&'static str> {
    if !is_email_helper_command(command) {
        return Vec::new();
    }
    match command_option_value(command, "--action").as_deref() {
        Some("send_email") => vec!["smtp"],
        Some("reply_email") => vec!["imap", "smtp"],
        Some(
            "list_emails" | "read_email" | "search_emails" | "mark_read" | "mark_unread"
            | "delete_email" | "list_folders" | "save_attachment",
        ) => vec!["imap"],
        _ => Vec::new(),
    }
}

fn detect_email_helper_direct_targets(
    command: &str,
    workdir: Option<&str>,
) -> Vec<NetworkDirectTarget> {
    let protocols = email_helper_required_protocols(command, workdir);
    if protocols.is_empty() {
        return Vec::new();
    }

    let mut targets = Vec::new();
    let imap_host = command_option_value(command, "--imap-host")
        .or_else(|| command_option_value(command, "--imap_host"));
    let imap_port = command_option_value(command, "--imap-port")
        .or_else(|| command_option_value(command, "--imap_port"))
        .and_then(|port| port.parse::<u16>().ok())
        .unwrap_or(993);
    let smtp_host = command_option_value(command, "--smtp-host")
        .or_else(|| command_option_value(command, "--smtp_host"));
    let smtp_port = command_option_value(command, "--smtp-port")
        .or_else(|| command_option_value(command, "--smtp_port"))
        .and_then(|port| port.parse::<u16>().ok())
        .unwrap_or(587);

    if protocols.contains(&"imap") {
        if let Some(host) = imap_host {
            if let Some(target) = NetworkDirectTarget::new("imap", host, imap_port) {
                targets.push(target);
            }
        }
    }
    if protocols.contains(&"smtp") {
        if let Some(host) = smtp_host {
            if let Some(target) = NetworkDirectTarget::new("smtp", host, smtp_port) {
                targets.push(target);
            }
        }
    }

    targets
}

fn command_option_value(command: &str, option: &str) -> Option<String> {
    let tokens = split_command_tokens(command);
    let aliases = [option.to_string(), option.replace('-', "_")];
    for (index, token) in tokens.iter().enumerate() {
        let token = token.trim_matches('"').trim_matches('\'');
        for alias in &aliases {
            if token == alias {
                return tokens
                    .get(index + 1)
                    .map(|value| value.trim_matches('"').trim_matches('\'').to_string());
            }
            let prefix = format!("{alias}=");
            if let Some(value) = token.strip_prefix(&prefix) {
                return Some(value.trim_matches('"').trim_matches('\'').to_string());
            }
        }
    }
    None
}

pub(super) fn detect_non_http_command_direct_target(command: &str) -> Option<NetworkDirectTarget> {
    let tokens = split_command_tokens(command);
    let command_name = tokens.first().map(|token| command_token_name(token))?;
    match command_name.as_str() {
        "ssh" | "scp" | "sftp" => {
            let port = if command_name == "ssh" {
                command_option_value(command, "-p").or_else(|| command_option_value(command, "-P"))
            } else {
                command_option_value(command, "-P")
            }
            .and_then(|port| port.parse::<u16>().ok())
            .unwrap_or(22);
            let host = if command_name == "scp" {
                scp_command_host(&tokens)?
            } else {
                ssh_like_command_host(&tokens)?
            };
            NetworkDirectTarget::new("ssh", host, port)
        }
        "ftp" => {
            let host = tokens
                .iter()
                .skip(1)
                .filter(|token| !token.starts_with('-'))
                .find_map(|token| normalize_direct_target_host(token))?;
            NetworkDirectTarget::new("ftp", host, 21)
        }
        "telnet" => telnet_command_direct_target(&tokens),
        "nc" | "ncat" | "netcat" => netcat_command_direct_target(&tokens),
        "psql" => postgres_command_direct_target(command, &tokens),
        "mysql" | "mariadb" => mysql_command_direct_target(command, &tokens),
        "redis-cli" => redis_command_direct_target(command, &tokens),
        "mongosh" | "mongo" => mongo_command_direct_target(command, &tokens),
        "sqlcmd" => sqlcmd_command_direct_target(command),
        _ => None,
    }
}

fn positional_tokens_after_options<'a>(
    tokens: &'a [String],
    options_with_values: &[&str],
) -> Vec<&'a str> {
    let mut values = Vec::new();
    let mut skip_next = false;

    for token in tokens.iter().skip(1) {
        let trimmed = token.trim_matches('"').trim_matches('\'');
        if skip_next {
            skip_next = false;
            continue;
        }
        if options_with_values.contains(&trimmed) {
            skip_next = true;
            continue;
        }
        if trimmed.starts_with('-') {
            continue;
        }
        values.push(trimmed);
    }

    values
}

fn target_from_host_port(
    protocol: &str,
    host: Option<String>,
    port: Option<u16>,
    default_port: u16,
) -> Option<NetworkDirectTarget> {
    NetworkDirectTarget::new(protocol, host?, port.unwrap_or(default_port))
}

fn parse_u16_option(command: &str, options: &[&str]) -> Option<u16> {
    options
        .iter()
        .find_map(|option| command_option_value(command, option))
        .and_then(|port| port.parse::<u16>().ok())
}

fn command_option_any(command: &str, options: &[&str]) -> Option<String> {
    options
        .iter()
        .find_map(|option| command_option_value(command, option))
}

fn parse_host_port_authority(authority: &str, default_port: u16) -> Option<(String, u16)> {
    let authority = authority
        .rsplit_once('@')
        .map(|(_, host)| host)
        .unwrap_or(authority)
        .trim();
    if authority.is_empty() {
        return None;
    }

    if let Some(rest) = authority.strip_prefix('[') {
        let (host, remainder) = rest.split_once(']')?;
        let port = remainder
            .strip_prefix(':')
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(default_port);
        return Some((host.to_string(), port));
    }

    if let Some((host, maybe_port)) = authority.rsplit_once(':') {
        if let Ok(port) = maybe_port.parse::<u16>() {
            return Some((host.to_string(), port));
        }
    }

    Some((authority.to_string(), default_port))
}

fn direct_target_from_url_token(
    token: &str,
    schemes: &[&str],
    protocol: &str,
    default_port: u16,
) -> Option<NetworkDirectTarget> {
    let trimmed = token.trim_matches('"').trim_matches('\'');
    let lower = trimmed.to_ascii_lowercase();
    if !schemes
        .iter()
        .any(|scheme| lower.starts_with(&format!("{scheme}://")))
    {
        return None;
    }

    let (_, after_scheme) = trimmed.split_once("://")?;
    let authority = after_scheme
        .split('/')
        .next()
        .unwrap_or(after_scheme)
        .split('?')
        .next()
        .unwrap_or(after_scheme)
        .split('#')
        .next()
        .unwrap_or(after_scheme);
    let (host, port) = parse_host_port_authority(authority, default_port)?;
    NetworkDirectTarget::new(protocol, host, port)
}

fn first_url_target(
    tokens: &[String],
    schemes: &[&str],
    protocol: &str,
    default_port: u16,
) -> Option<NetworkDirectTarget> {
    tokens
        .iter()
        .skip(1)
        .find_map(|token| direct_target_from_url_token(token, schemes, protocol, default_port))
}

fn telnet_command_direct_target(tokens: &[String]) -> Option<NetworkDirectTarget> {
    let positionals = positional_tokens_after_options(tokens, &["-b", "-l"]);
    let host = positionals
        .first()
        .and_then(|token| normalize_direct_target_host(token))?;
    let port = positionals
        .get(1)
        .and_then(|token| token.parse::<u16>().ok())
        .unwrap_or(23);
    NetworkDirectTarget::new("telnet", host, port)
}

fn netcat_command_direct_target(tokens: &[String]) -> Option<NetworkDirectTarget> {
    let protocol = if tokens.iter().skip(1).any(|token| {
        let trimmed = token.trim_matches('"').trim_matches('\'');
        trimmed == "-u"
            || (trimmed.starts_with('-') && !trimmed.starts_with("--") && trimmed.contains('u'))
    }) {
        "udp"
    } else {
        "tcp"
    };
    let positionals = positional_tokens_after_options(
        tokens,
        &[
            "-e",
            "-G",
            "-g",
            "-i",
            "-p",
            "-s",
            "-T",
            "-V",
            "-w",
            "-X",
            "-x",
            "--proxy",
            "--source",
            "--source-port",
        ],
    );
    let host = positionals
        .first()
        .and_then(|token| normalize_direct_target_host(token))?;
    let port = positionals
        .get(1)
        .and_then(|token| token.parse::<u16>().ok())?;
    NetworkDirectTarget::new(protocol, host, port)
}

fn postgres_command_direct_target(command: &str, tokens: &[String]) -> Option<NetworkDirectTarget> {
    first_url_target(tokens, &["postgres", "postgresql"], "postgres", 5432).or_else(|| {
        target_from_host_port(
            "postgres",
            command_option_any(command, &["--host", "-h"]),
            parse_u16_option(command, &["--port", "-p"]),
            5432,
        )
    })
}

fn mysql_command_direct_target(command: &str, tokens: &[String]) -> Option<NetworkDirectTarget> {
    first_url_target(tokens, &["mysql", "mariadb"], "mysql", 3306).or_else(|| {
        target_from_host_port(
            "mysql",
            command_option_any(command, &["--host", "-h"]),
            parse_u16_option(command, &["--port", "-P"]),
            3306,
        )
    })
}

fn redis_command_direct_target(command: &str, tokens: &[String]) -> Option<NetworkDirectTarget> {
    first_url_target(tokens, &["redis", "rediss"], "redis", 6379).or_else(|| {
        target_from_host_port(
            "redis",
            command_option_any(command, &["--host", "-h"]),
            parse_u16_option(command, &["--port", "-p"]),
            6379,
        )
    })
}

fn mongo_command_direct_target(command: &str, tokens: &[String]) -> Option<NetworkDirectTarget> {
    first_url_target(tokens, &["mongodb", "mongodb+srv"], "mongodb", 27017).or_else(|| {
        let host_option = command_option_any(command, &["--host"]);
        let (host, port) = match host_option.as_deref() {
            Some(value) => parse_host_port_authority(value, 27017)
                .map(|(host, port)| (Some(host), Some(port)))
                .unwrap_or((host_option.clone(), None)),
            None => (None, None),
        };
        target_from_host_port(
            "mongodb",
            host,
            parse_u16_option(command, &["--port"]).or(port),
            27017,
        )
    })
}

fn sqlcmd_command_direct_target(command: &str) -> Option<NetworkDirectTarget> {
    let server = command_option_any(command, &["-S", "--server"])?;
    let server = server
        .trim()
        .strip_prefix("tcp:")
        .unwrap_or(server.trim())
        .to_string();
    let (host, port) = if let Some((host, port)) = server.rsplit_once(',') {
        (host.to_string(), port.parse::<u16>().ok())
    } else if let Some((host, port)) = parse_host_port_authority(&server, 1433) {
        (host, Some(port))
    } else {
        (server, None)
    };
    NetworkDirectTarget::new("mssql", host, port.unwrap_or(1433))
}

fn scp_command_host(tokens: &[String]) -> Option<String> {
    let mut skip_next = false;
    for token in tokens.iter().skip(1) {
        let trimmed = token.trim_matches('"').trim_matches('\'');
        if skip_next {
            skip_next = false;
            continue;
        }
        if matches!(
            trimmed,
            "-P" | "-i" | "-F" | "-J" | "-l" | "-o" | "-S" | "-c"
        ) {
            skip_next = true;
            continue;
        }
        if trimmed.starts_with('-') {
            continue;
        }
        if let Some(host) = scp_remote_target_host(trimmed) {
            return Some(host);
        }
    }
    ssh_like_command_host(tokens)
}

fn scp_remote_target_host(token: &str) -> Option<String> {
    let token = token.trim_matches('"').trim_matches('\'');
    let host_part = token
        .rsplit_once('@')
        .map(|(_, host)| host)
        .unwrap_or(token);
    if !host_part.contains(':') || looks_like_windows_drive_path(host_part) {
        return None;
    }
    let host = host_part.split_once(':').map(|(host, _)| host)?;
    normalize_direct_target_host(host)
}

fn looks_like_windows_drive_path(token: &str) -> bool {
    let bytes = token.as_bytes();
    bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic()
}

fn ssh_like_command_host(tokens: &[String]) -> Option<String> {
    let mut skip_next = false;
    for token in tokens.iter().skip(1) {
        let trimmed = token.trim_matches('"').trim_matches('\'');
        if skip_next {
            skip_next = false;
            continue;
        }
        if matches!(
            trimmed,
            "-p" | "-P" | "-i" | "-F" | "-J" | "-l" | "-o" | "-b" | "-c" | "-m" | "-S" | "-W"
        ) {
            skip_next = true;
            continue;
        }
        if trimmed.starts_with('-') {
            continue;
        }
        if let Some(host) = ssh_like_target_host(trimmed) {
            return Some(host);
        }
    }
    None
}

fn ssh_like_target_host(token: &str) -> Option<String> {
    let token = token.trim_matches('"').trim_matches('\'');
    let host_part = token
        .rsplit_once('@')
        .map(|(_, host)| host)
        .unwrap_or(token);
    let host_part = host_part
        .rsplit_once(':')
        .map(|(host, maybe_port)| {
            if maybe_port.parse::<u16>().is_ok() {
                host
            } else {
                host_part
            }
        })
        .unwrap_or(host_part);
    normalize_direct_target_host(host_part)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowance(protocol: &str, host: &str, port: u16) -> NetworkDirectAllowance {
        NetworkDirectAllowance {
            id: format!("{protocol}-{host}-{port}"),
            subject_type: "command".to_string(),
            subject_id: None,
            protocol: protocol.to_string(),
            host: host.to_string(),
            port,
            scope: "once".to_string(),
            expires_at: None,
            created_at: 1,
            reason: "test".to_string(),
        }
    }

    #[test]
    fn extracts_common_direct_protocol_targets() {
        let cases = [
            (
                "scp -P 2200 ./a.txt user@ssh.example.com:/tmp/a.txt",
                "ssh",
                "ssh.example.com",
                2200,
            ),
            (
                "nc -vz raw.example.com 9000",
                "tcp",
                "raw.example.com",
                9000,
            ),
            (
                "telnet telnet.example.com 2323",
                "telnet",
                "telnet.example.com",
                2323,
            ),
            (
                "psql postgresql://user:pass@db.example.com:5433/app",
                "postgres",
                "db.example.com",
                5433,
            ),
            (
                "mysql --host mysql.example.com --port 3307",
                "mysql",
                "mysql.example.com",
                3307,
            ),
            (
                "redis-cli -h cache.example.com -p 6380",
                "redis",
                "cache.example.com",
                6380,
            ),
            (
                "mongosh mongodb://mongo.example.com:27018/app",
                "mongodb",
                "mongo.example.com",
                27018,
            ),
            (
                "sqlcmd -S tcp:mssql.example.com,14330",
                "mssql",
                "mssql.example.com",
                14330,
            ),
        ];

        for (command, protocol, host, port) in cases {
            let targets = detect_network_direct_targets(command, None);
            assert_eq!(targets.len(), 1, "command: {command}");
            assert_eq!(targets[0].protocol, protocol, "command: {command}");
            assert_eq!(targets[0].host, host, "command: {command}");
            assert_eq!(targets[0].port, port, "command: {command}");
        }
    }

    #[test]
    fn allowance_targets_require_all_requested_protocols() {
        let protocols = vec!["imap".to_string(), "smtp".to_string()];

        assert!(direct_targets_from_allowances_for_protocols(
            &protocols,
            &[allowance("imap", "imap.example.com", 993)]
        )
        .is_empty());

        let targets = direct_targets_from_allowances_for_protocols(
            &protocols,
            &[
                allowance("imap", "imap.example.com", 993),
                allowance("smtp", "smtp.example.com", 587),
            ],
        );

        assert_eq!(targets.len(), 2);
        assert_eq!(targets[0].protocol, "imap");
        assert_eq!(targets[0].host, "imap.example.com");
        assert_eq!(targets[0].port, 993);
        assert_eq!(targets[1].protocol, "smtp");
        assert_eq!(targets[1].host, "smtp.example.com");
        assert_eq!(targets[1].port, 587);
    }

    #[tokio::test]
    async fn resolved_risk_classifies_literal_direct_targets() {
        let public = NetworkDirectTarget::new("ssh", "8.8.8.8", 22).unwrap();
        assert_eq!(resolve_network_direct_target_risk(&public).await.risk, "public");

        let private = NetworkDirectTarget::new("ssh", "127.0.0.1", 22).unwrap();
        assert_eq!(
            resolve_network_direct_target_risk(&private).await.risk,
            "private"
        );

        let metadata = NetworkDirectTarget::new("ssh", "169.254.169.254", 22).unwrap();
        assert_eq!(
            resolve_network_direct_target_risk(&metadata).await.risk,
            "metadata"
        );
    }

    #[tokio::test]
    async fn resolved_risk_uses_encoded_hostname_ip_before_dns() {
        let private = NetworkDirectTarget::new("postgres", "127.0.0.1.sslip.io", 5432).unwrap();
        let private_risk = resolve_network_direct_target_risk(&private).await;
        assert_eq!(private_risk.risk, "private");
        assert_eq!(
            private_risk.resolved_ip_samples,
            vec!["127.0.0.1".to_string()]
        );
        assert_eq!(private_risk.reason, "hostnameEncodedPrivateOrLocalIp");

        let metadata =
            NetworkDirectTarget::new("tcp", "169-254-169-254.sslip.io", 80).unwrap();
        let metadata_risk = resolve_network_direct_target_risk(&metadata).await;
        assert_eq!(metadata_risk.risk, "metadata");
        assert_eq!(
            metadata_risk.resolved_ip_samples,
            vec!["169.254.169.254".to_string()]
        );
        assert_eq!(metadata_risk.reason, "hostnameEncodedMetadataIp");

        let prefixed = NetworkDirectTarget::new("ssh", "db.10.0.0.4.nip.io", 22).unwrap();
        let prefixed_risk = resolve_network_direct_target_risk(&prefixed).await;
        assert_eq!(prefixed_risk.risk, "private");
        assert_eq!(
            prefixed_risk.resolved_ip_samples,
            vec!["10.0.0.4".to_string()]
        );
    }

    #[test]
    fn resolved_risk_classifies_dns_ip_samples_without_lookup() {
        let metadata = classify_direct_target_ip_samples(
            &[IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254))],
            true,
        );
        assert_eq!(metadata.risk, "metadata");
        assert_eq!(metadata.reason, "dnsResolvedMetadataIp");

        let private = classify_direct_target_ip_samples(
            &[
                IpAddr::V4(Ipv4Addr::new(10, 0, 0, 4)),
                IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8)),
            ],
            true,
        );
        assert_eq!(private.risk, "private");
        assert_eq!(private.reason, "dnsResolvedPrivateOrLocalIp");

        let proxy_mapped =
            classify_direct_target_ip_samples(&[IpAddr::V4(Ipv4Addr::new(198, 18, 0, 35))], true);
        assert_eq!(proxy_mapped.risk, "public");
        assert_eq!(proxy_mapped.reason, "dnsResolvedBenchmarkOrProxyIp");
    }
}
