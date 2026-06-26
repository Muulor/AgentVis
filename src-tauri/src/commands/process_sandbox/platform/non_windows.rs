//! 非 Windows 平台进程沙箱后端 stub，保持跨平台编译边界稳定。
use super::super::{ProcessSandboxProfile, RestrictedTokenProbeResult};
use tokio::process::Child;

#[derive(Debug, Default)]
pub struct ProcessSandboxGuard;

impl ProcessSandboxGuard {
    pub fn attach_child(
        _child: &Child,
        _command_label: &str,
        _profile: ProcessSandboxProfile,
    ) -> Result<Self, String> {
        Ok(Self)
    }

    pub fn terminate(&self, _exit_code: u32) -> Result<(), String> {
        Ok(())
    }
}

pub fn run_restricted_token_probe(
    _command: &str,
    _timeout_ms: u32,
) -> Result<RestrictedTokenProbeResult, String> {
    Err("restricted token probe is only available on Windows".to_string())
}
