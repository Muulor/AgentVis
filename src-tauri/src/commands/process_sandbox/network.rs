//! 进程沙箱网络扫描 facade，负责稳定主模块和网络子模块之间的导出边界。

mod direct_targets;
mod powershell;
mod scan;

pub(crate) use direct_targets::{
    detect_network_direct_targets, direct_targets_from_allowances_for_protocols,
    encoded_hostname_target_risk,
    is_known_local_network_metadata_action, is_metadata_direct_target,
    required_network_direct_protocols, resolve_network_direct_target_risk,
    NetworkDirectTargetRiskInfo,
};
pub(crate) use scan::{
    agent_browser_runtime_script_hint, command_token_name, detect_network_command, detect_network_intent,
    detect_network_proxy_bypass_signal, detect_network_remote_destructive_signal,
    detect_network_script, detect_network_sensitive_egress_signal, extract_first_script_path,
    detect_network_upload_risk_signal, resolve_script_candidates, split_command_tokens,
    validate_no_network_command,
    validate_no_network_script,
};
