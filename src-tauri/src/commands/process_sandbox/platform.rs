//! 进程沙箱平台后端 facade，隔离平台实现并保持上层导出稳定。

#[cfg(not(target_os = "windows"))]
mod non_windows;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "windows")]
pub use self::windows::{
    prepare_appcontainer_filesystem_profile,
    prepare_appcontainer_filesystem_profile_with_capabilities, run_appcontainer_filesystem_probe,
    run_restricted_token_probe, spawn_appcontainer_filesystem_process,
    spawn_appcontainer_filesystem_process_with_capabilities, spawn_restricted_token_process,
    AppContainerChild, AppContainerChildControl, AppContainerFilesystemProfile,
    ProcessSandboxGuard,
};

#[cfg(not(target_os = "windows"))]
pub use self::non_windows::{run_restricted_token_probe, ProcessSandboxGuard};
