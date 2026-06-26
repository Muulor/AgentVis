//! Windows 平台进程沙箱后端，集中承载 Win32、Job Object、AppContainer 与 Restricted Token 调用。
use std::collections::BTreeMap;
use std::ffi::c_void;
use std::ffi::OsStr;
use std::mem::size_of;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::ptr::{null, null_mut};
use std::thread;

use super::super::{
    AppContainerFilesystemAccess, AppContainerFilesystemGrant, AppContainerFilesystemProfileResult,
    AppContainerNetworkCapability, ProcessSandboxProfile, RestrictedTokenProbeResult,
};
use tokio::process::Child;
use windows_sys::core::{HRESULT, PWSTR};
use windows_sys::Win32::Foundation::{
    CloseHandle, LocalFree, SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT, HLOCAL, NO_ERROR,
    WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::Authorization::{
    BuildTrusteeWithSidW, ConvertSidToStringSidW, GetNamedSecurityInfoW, SetEntriesInAclW,
    SetNamedSecurityInfoW, EXPLICIT_ACCESS_W, GRANT_ACCESS, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeleteAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
};
use windows_sys::Win32::Security::{
    CreateRestrictedToken, CreateWellKnownSid, FreeSid, WinCapabilityInternetClientSid,
    WinCapabilityPrivateNetworkClientServerSid, ACL, CONTAINER_INHERIT_ACE,
    DACL_SECURITY_INFORMATION, DISABLE_MAX_PRIVILEGE, LUA_TOKEN, OBJECT_INHERIT_ACE,
    PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, SECURITY_CAPABILITIES, SECURITY_MAX_SID_SIZE,
    SID_AND_ATTRIBUTES, TOKEN_ADJUST_DEFAULT, TOKEN_ADJUST_SESSIONID, TOKEN_ASSIGN_PRIMARY,
    TOKEN_DUPLICATE, TOKEN_QUERY, WELL_KNOWN_SID_TYPE,
};
use windows_sys::Win32::Storage::FileSystem::{
    ReadFile, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicUIRestrictions,
    JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
    JOBOBJECT_BASIC_UI_RESTRICTIONS, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION,
    JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_UILIMIT_DESKTOP,
    JOB_OBJECT_UILIMIT_DISPLAYSETTINGS, JOB_OBJECT_UILIMIT_EXITWINDOWS,
    JOB_OBJECT_UILIMIT_GLOBALATOMS, JOB_OBJECT_UILIMIT_HANDLES, JOB_OBJECT_UILIMIT_READCLIPBOARD,
    JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS, JOB_OBJECT_UILIMIT_WRITECLIPBOARD,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CreateProcessAsUserW, CreateProcessW, CreateProcessWithTokenW, DeleteProcThreadAttributeList,
    GetCurrentProcess, GetExitCodeProcess, InitializeProcThreadAttributeList, OpenProcessToken,
    ResumeThread, TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject,
    CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT,
    INFINITE, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION,
    PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, STARTF_USESTDHANDLES, STARTUPINFOEXW,
    STARTUPINFOW,
};

const RESTRICTED_ACTIVE_PROCESS_LIMIT: u32 = 16;
const RESTRICTED_JOB_MEMORY_LIMIT_BYTES: usize = 512 * 1024 * 1024;
const RESTRICTED_TOKEN_FLAGS: u32 = DISABLE_MAX_PRIVILEGE | LUA_TOKEN;
const RESTRICTED_TOKEN_FALLBACK_FLAGS: u32 = DISABLE_MAX_PRIVILEGE;
const TOKEN_CREATE_PROCESS_ACCESS: u32 = TOKEN_DUPLICATE
    | TOKEN_ASSIGN_PRIMARY
    | TOKEN_QUERY
    | TOKEN_ADJUST_DEFAULT
    | TOKEN_ADJUST_SESSIONID;

#[derive(Debug)]
struct OwnedWin32Handle {
    handle: HANDLE,
    name: &'static str,
}

unsafe impl Send for OwnedWin32Handle {}

impl OwnedWin32Handle {
    fn new(handle: HANDLE, name: &'static str) -> Result<Self, String> {
        if handle.is_null() {
            return Err(format!("{} returned a null handle", name));
        }
        Ok(Self { handle, name })
    }

    fn raw(&self) -> HANDLE {
        self.handle
    }
}

impl Drop for OwnedWin32Handle {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            let ok = unsafe { CloseHandle(self.handle) };
            if ok == 0 {
                log::debug!(
                    "[Sandbox] CloseHandle failed for {}: {}",
                    self.name,
                    std::io::Error::last_os_error()
                );
            }
            self.handle = null_mut();
        }
    }
}

fn last_os_error(label: &str) -> String {
    format!("{} failed: {}", label, std::io::Error::last_os_error())
}

fn wide_null(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(Some(0)).collect()
}

fn wide_null_os(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}

fn valid_environment_entry(key: &str, value: &str) -> bool {
    !key.is_empty() && !key.contains('=') && !key.contains('\0') && !value.contains('\0')
}

fn build_environment_block(overrides: &[(String, String)]) -> Vec<u16> {
    let mut entries: BTreeMap<String, (String, String)> = BTreeMap::new();

    for (key, value) in std::env::vars_os() {
        let key = key.to_string_lossy().to_string();
        let value = value.to_string_lossy().to_string();
        if valid_environment_entry(&key, &value) {
            entries.insert(key.to_ascii_uppercase(), (key, value));
        }
    }

    for (key, value) in overrides {
        if valid_environment_entry(key, value) {
            entries.insert(key.to_ascii_uppercase(), (key.clone(), value.clone()));
        }
    }

    let mut block = Vec::new();
    for (_, (key, value)) in entries {
        block.extend(OsStr::new(&format!("{}={}", key, value)).encode_wide());
        block.push(0);
    }
    block.push(0);
    block
}

#[derive(Debug)]
struct OwnedSid {
    sid: PSID,
    name: &'static str,
}

unsafe impl Send for OwnedSid {}

impl OwnedSid {
    fn new(sid: PSID, name: &'static str) -> Result<Self, String> {
        if sid.is_null() {
            return Err(format!("{} returned a null SID", name));
        }
        Ok(Self { sid, name })
    }

    fn raw(&self) -> PSID {
        self.sid
    }
}

impl Drop for OwnedSid {
    fn drop(&mut self) {
        if !self.sid.is_null() {
            let remaining = unsafe { FreeSid(self.sid) };
            if !remaining.is_null() {
                log::debug!(
                    "[Sandbox] FreeSid returned a non-null value for {}: {:?}",
                    self.name,
                    remaining
                );
            }
            self.sid = null_mut();
        }
    }
}

impl AppContainerNetworkCapability {
    fn well_known_sid_type(self) -> WELL_KNOWN_SID_TYPE {
        match self {
            AppContainerNetworkCapability::InternetClient => WinCapabilityInternetClientSid,
            AppContainerNetworkCapability::PrivateNetworkClientServer => {
                WinCapabilityPrivateNetworkClientServerSid
            }
        }
    }
}

struct AppContainerCapabilitySet {
    _sid_buffers: Vec<Vec<u8>>,
    attributes: Vec<SID_AND_ATTRIBUTES>,
}

impl AppContainerCapabilitySet {
    fn new(capabilities: &[AppContainerNetworkCapability]) -> Result<Self, String> {
        let mut sid_buffers = Vec::with_capacity(capabilities.len());

        for capability in capabilities {
            let mut buffer = vec![0u8; SECURITY_MAX_SID_SIZE as usize];
            let mut size = SECURITY_MAX_SID_SIZE;
            let ok = unsafe {
                CreateWellKnownSid(
                    capability.well_known_sid_type(),
                    null_mut(),
                    buffer.as_mut_ptr().cast(),
                    &mut size,
                )
            };
            if ok == 0 {
                return Err(last_os_error("CreateWellKnownSid"));
            }
            buffer.truncate(size as usize);
            sid_buffers.push(buffer);
        }

        let attributes = sid_buffers
            .iter_mut()
            .map(|buffer| SID_AND_ATTRIBUTES {
                Sid: buffer.as_mut_ptr().cast(),
                Attributes: 4,
            })
            .collect();

        Ok(Self {
            _sid_buffers: sid_buffers,
            attributes,
        })
    }

    fn as_mut_ptr(&mut self) -> *mut SID_AND_ATTRIBUTES {
        if self.attributes.is_empty() {
            null_mut()
        } else {
            self.attributes.as_mut_ptr()
        }
    }

    fn count(&self) -> u32 {
        self.attributes.len() as u32
    }
}

#[derive(Debug)]
struct AppContainerFilesystemGrantState {
    path: std::path::PathBuf,
    security_descriptor: PSECURITY_DESCRIPTOR,
    original_dacl: *mut ACL,
}

unsafe impl Send for AppContainerFilesystemGrantState {}

impl Drop for AppContainerFilesystemGrantState {
    fn drop(&mut self) {
        let path_wide = wide_null_os(self.path.as_os_str());
        let error = unsafe {
            SetNamedSecurityInfoW(
                path_wide.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                self.original_dacl,
                null(),
            )
        };
        if error != NO_ERROR {
            log::debug!(
                "[Sandbox] failed to restore AppContainer filesystem ACL for {}: {}",
                self.path.display(),
                format_win32_error("SetNamedSecurityInfoW", error)
            );
        }

        if !self.security_descriptor.is_null() {
            unsafe {
                LocalFree(self.security_descriptor as HLOCAL);
            }
            self.security_descriptor = null_mut();
            self.original_dacl = null_mut();
        }
    }
}

#[derive(Debug)]
pub struct AppContainerFilesystemProfile {
    profile_name: String,
    sid: OwnedSid,
    sid_string: String,
    created_profile: bool,
    network_capabilities: Vec<AppContainerNetworkCapability>,
    grants: Vec<AppContainerFilesystemGrantState>,
}

impl AppContainerFilesystemProfile {
    pub fn result(&self) -> AppContainerFilesystemProfileResult {
        AppContainerFilesystemProfileResult {
            profile_name: self.profile_name.clone(),
            sid_string: self.sid_string.clone(),
            created_profile: self.created_profile,
            granted_paths: self.grants.iter().map(|grant| grant.path.clone()).collect(),
        }
    }

    pub fn sid(&self) -> PSID {
        self.sid.raw()
    }

    pub fn network_capabilities(&self) -> &[AppContainerNetworkCapability] {
        &self.network_capabilities
    }
}

impl Drop for AppContainerFilesystemProfile {
    fn drop(&mut self) {
        self.grants.clear();

        if self.created_profile {
            let profile_name = wide_null(&self.profile_name);
            let hr = unsafe { DeleteAppContainerProfile(profile_name.as_ptr()) };
            if !hresult_succeeded(hr) {
                log::debug!(
                    "[Sandbox] failed to delete AppContainer profile {}: {}",
                    self.profile_name,
                    format_hresult("DeleteAppContainerProfile", hr)
                );
            }
        }
    }
}

fn hresult_succeeded(hr: HRESULT) -> bool {
    hr >= 0
}

fn format_hresult(label: &str, hr: HRESULT) -> String {
    format!("{} failed: HRESULT 0x{:08X}", label, hr as u32)
}

fn format_win32_error(label: &str, error: u32) -> String {
    format!(
        "{} failed: {} ({})",
        label,
        std::io::Error::from_raw_os_error(error as i32),
        error
    )
}

unsafe fn pwstr_to_string(value: PWSTR) -> String {
    if value.is_null() {
        return String::new();
    }

    let mut len = 0;
    while *value.add(len) != 0 {
        len += 1;
    }
    String::from_utf16_lossy(std::slice::from_raw_parts(value, len))
}

fn sid_to_string(sid: PSID) -> Result<String, String> {
    let mut string_sid: PWSTR = null_mut();
    let ok = unsafe { ConvertSidToStringSidW(sid, &mut string_sid) };
    if ok == 0 {
        return Err(last_os_error("ConvertSidToStringSidW"));
    }

    let sid = unsafe { pwstr_to_string(string_sid) };
    unsafe {
        LocalFree(string_sid as HLOCAL);
    }
    Ok(sid)
}

fn create_or_open_appcontainer_profile(
    profile_name: &str,
    network_capabilities: &[AppContainerNetworkCapability],
) -> Result<(OwnedSid, bool), String> {
    let name_wide = wide_null(profile_name);
    let display_name = wide_null("AgentVis Process Sandbox");
    let description = wide_null("AgentVis per-run AppContainer filesystem sandbox");
    let mut capability_set = AppContainerCapabilitySet::new(network_capabilities)?;
    let mut sid: PSID = null_mut();
    let create_hr = unsafe {
        CreateAppContainerProfile(
            name_wide.as_ptr(),
            display_name.as_ptr(),
            description.as_ptr(),
            capability_set.as_mut_ptr(),
            capability_set.count(),
            &mut sid,
        )
    };

    if hresult_succeeded(create_hr) {
        return Ok((OwnedSid::new(sid, "CreateAppContainerProfile")?, true));
    }

    let mut derived_sid: PSID = null_mut();
    let derive_hr =
        unsafe { DeriveAppContainerSidFromAppContainerName(name_wide.as_ptr(), &mut derived_sid) };
    if hresult_succeeded(derive_hr) {
        return Ok((
            OwnedSid::new(derived_sid, "DeriveAppContainerSidFromAppContainerName")?,
            false,
        ));
    }

    Err(format!(
        "{}; {}",
        format_hresult("CreateAppContainerProfile", create_hr),
        format_hresult("DeriveAppContainerSidFromAppContainerName", derive_hr)
    ))
}

fn appcontainer_access_mask(access: AppContainerFilesystemAccess) -> u32 {
    const DELETE_ACCESS: u32 = 0x0001_0000;

    match access {
        AppContainerFilesystemAccess::ReadExecute => FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
        AppContainerFilesystemAccess::ReadWrite => {
            FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE_ACCESS
        }
    }
}

fn apply_appcontainer_filesystem_grant(
    sid: PSID,
    grant: &AppContainerFilesystemGrant,
) -> Result<AppContainerFilesystemGrantState, String> {
    if !grant.path.exists() {
        return Err(format!(
            "AppContainer filesystem grant path does not exist: {}",
            grant.path.display()
        ));
    }

    let path_wide = wide_null_os(grant.path.as_os_str());
    let mut old_dacl: *mut ACL = null_mut();
    let mut security_descriptor: PSECURITY_DESCRIPTOR = null_mut();
    let error = unsafe {
        GetNamedSecurityInfoW(
            path_wide.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut old_dacl,
            null_mut(),
            &mut security_descriptor,
        )
    };
    if error != NO_ERROR {
        return Err(format_win32_error("GetNamedSecurityInfoW", error));
    }

    let mut explicit_access = EXPLICIT_ACCESS_W {
        grfAccessPermissions: appcontainer_access_mask(grant.access),
        grfAccessMode: GRANT_ACCESS,
        grfInheritance: OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
        ..Default::default()
    };
    unsafe {
        BuildTrusteeWithSidW(&mut explicit_access.Trustee, sid);
    }

    let mut new_dacl: *mut ACL = null_mut();
    let error = unsafe { SetEntriesInAclW(1, &explicit_access, old_dacl, &mut new_dacl) };
    if error != NO_ERROR {
        unsafe {
            LocalFree(security_descriptor as HLOCAL);
        }
        return Err(format_win32_error("SetEntriesInAclW", error));
    }

    let error = unsafe {
        SetNamedSecurityInfoW(
            path_wide.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            new_dacl,
            null(),
        )
    };
    unsafe {
        LocalFree(new_dacl as HLOCAL);
    }
    if error != NO_ERROR {
        unsafe {
            LocalFree(security_descriptor as HLOCAL);
        }
        return Err(format_win32_error("SetNamedSecurityInfoW", error));
    }

    Ok(AppContainerFilesystemGrantState {
        path: grant.path.clone(),
        security_descriptor,
        original_dacl: old_dacl,
    })
}

pub fn prepare_appcontainer_filesystem_profile(
    profile_name: &str,
    grants: &[AppContainerFilesystemGrant],
) -> Result<AppContainerFilesystemProfile, String> {
    prepare_appcontainer_filesystem_profile_with_capabilities(profile_name, grants, &[])
}

pub fn prepare_appcontainer_filesystem_profile_with_capabilities(
    profile_name: &str,
    grants: &[AppContainerFilesystemGrant],
    network_capabilities: &[AppContainerNetworkCapability],
) -> Result<AppContainerFilesystemProfile, String> {
    if profile_name.trim().is_empty() {
        return Err("AppContainer profile name cannot be empty".to_string());
    }
    for grant in grants {
        if !grant.path.exists() {
            return Err(format!(
                "AppContainer filesystem grant path does not exist: {}",
                grant.path.display()
            ));
        }
    }

    let (sid, created_profile) =
        create_or_open_appcontainer_profile(profile_name, network_capabilities)?;
    let mut profile = AppContainerFilesystemProfile {
        profile_name: profile_name.to_string(),
        sid,
        sid_string: String::new(),
        created_profile,
        network_capabilities: network_capabilities.to_vec(),
        grants: Vec::new(),
    };
    profile.sid_string = sid_to_string(profile.sid.raw())?;

    for grant in grants {
        profile.grants.push(apply_appcontainer_filesystem_grant(
            profile.sid.raw(),
            grant,
        )?);
    }

    Ok(profile)
}

#[derive(Debug)]
struct OwnedProcThreadAttributeList {
    list: LPPROC_THREAD_ATTRIBUTE_LIST,
    _buffer: Vec<usize>,
}

impl OwnedProcThreadAttributeList {
    fn new(attribute_count: u32) -> Result<Self, String> {
        let mut size = 0usize;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), attribute_count, 0, &mut size);
        }
        if size == 0 {
            return Err(last_os_error("InitializeProcThreadAttributeList(size)"));
        }

        let word_size = size_of::<usize>();
        let word_count = (size + word_size - 1) / word_size;
        let mut buffer = vec![0usize; word_count];
        let list = buffer.as_mut_ptr().cast();
        let ok = unsafe { InitializeProcThreadAttributeList(list, attribute_count, 0, &mut size) };
        if ok == 0 {
            return Err(last_os_error("InitializeProcThreadAttributeList"));
        }

        Ok(Self {
            list,
            _buffer: buffer,
        })
    }

    fn raw(&self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.list
    }

    fn set_security_capabilities(
        &self,
        capabilities: &mut SECURITY_CAPABILITIES,
    ) -> Result<(), String> {
        let ok = unsafe {
            UpdateProcThreadAttribute(
                self.raw(),
                0,
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
                capabilities as *mut SECURITY_CAPABILITIES as *const c_void,
                size_of::<SECURITY_CAPABILITIES>(),
                null_mut(),
                null(),
            )
        };
        if ok == 0 {
            return Err(last_os_error("UpdateProcThreadAttribute"));
        }
        Ok(())
    }
}

impl Drop for OwnedProcThreadAttributeList {
    fn drop(&mut self) {
        if !self.list.is_null() {
            unsafe {
                DeleteProcThreadAttributeList(self.list);
            }
            self.list = null_mut();
        }
    }
}

fn create_appcontainer_process(
    profile: &AppContainerFilesystemProfile,
    command: &str,
    current_dir: Option<&Path>,
    environment_block: Option<&[u16]>,
    stdout_write: HANDLE,
    stderr_write: HANDLE,
) -> Result<PROCESS_INFORMATION, String> {
    let attributes = OwnedProcThreadAttributeList::new(1)?;
    let mut capability_set = AppContainerCapabilitySet::new(profile.network_capabilities())?;
    let mut security_capabilities = SECURITY_CAPABILITIES {
        AppContainerSid: profile.sid(),
        Capabilities: capability_set.as_mut_ptr(),
        CapabilityCount: capability_set.count(),
        Reserved: 0,
    };
    attributes.set_security_capabilities(&mut security_capabilities)?;

    let mut startup_info = STARTUPINFOEXW::default();
    startup_info.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup_info.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup_info.StartupInfo.hStdOutput = stdout_write;
    startup_info.StartupInfo.hStdError = stderr_write;
    startup_info.StartupInfo.hStdInput = null_mut();
    startup_info.lpAttributeList = attributes.raw();

    let creation_flags = CREATE_NO_WINDOW
        | CREATE_UNICODE_ENVIRONMENT
        | CREATE_SUSPENDED
        | EXTENDED_STARTUPINFO_PRESENT;
    let current_dir_wide = current_dir.map(|path| wide_null_os(path.as_os_str()));
    let current_dir_ptr = current_dir_wide
        .as_ref()
        .map(|path| path.as_ptr())
        .unwrap_or_else(null);
    let environment_ptr = environment_block
        .map(|block| block.as_ptr().cast())
        .unwrap_or_else(null);
    let mut process_information = PROCESS_INFORMATION::default();
    let mut command_line = wide_null(command);
    let ok = unsafe {
        CreateProcessW(
            null(),
            command_line.as_mut_ptr(),
            null(),
            null(),
            1,
            creation_flags,
            environment_ptr,
            current_dir_ptr,
            &startup_info.StartupInfo,
            &mut process_information,
        )
    };
    if ok == 0 {
        return Err(last_os_error("CreateProcessW"));
    }

    Ok(process_information)
}

#[derive(Debug, Clone)]
pub struct AppContainerChildControl {
    process_handle: usize,
    job_handle: usize,
}

impl AppContainerChildControl {
    pub fn terminate(&self, exit_code: u32) -> Result<(), String> {
        let job_handle = self.job_handle as HANDLE;
        let process_handle = self.process_handle as HANDLE;

        let job_ok = unsafe { TerminateJobObject(job_handle, exit_code) };
        if job_ok == 0 {
            log::debug!(
                "[Sandbox] TerminateJobObject for AppContainer child returned: {}",
                std::io::Error::last_os_error()
            );
        }

        let process_ok = unsafe { TerminateProcess(process_handle, exit_code) };
        if process_ok == 0 && job_ok == 0 {
            return Err(last_os_error("TerminateProcess"));
        }

        Ok(())
    }
}

#[derive(Debug)]
pub struct AppContainerChild {
    process_handle: OwnedWin32Handle,
    stdout_read: Option<OwnedWin32Handle>,
    stderr_read: Option<OwnedWin32Handle>,
    job: WindowsJobObject,
    _profile: AppContainerFilesystemProfile,
}

impl AppContainerChild {
    pub fn control(&self) -> AppContainerChildControl {
        AppContainerChildControl {
            process_handle: self.process_handle.raw() as usize,
            job_handle: self.job.as_handle() as usize,
        }
    }

    pub fn terminate(&self, exit_code: u32) -> Result<(), String> {
        self.control().terminate(exit_code)
    }

    pub fn wait_with_output(self) -> Result<RestrictedTokenProbeResult, String> {
        self.wait_with_output_for(INFINITE, None)
    }

    fn wait_with_output_timeout(
        self,
        timeout_ms: u32,
    ) -> Result<RestrictedTokenProbeResult, String> {
        self.wait_with_output_for(timeout_ms, Some(timeout_ms))
    }

    fn wait_with_output_for(
        mut self,
        wait_ms: u32,
        timeout_label_ms: Option<u32>,
    ) -> Result<RestrictedTokenProbeResult, String> {
        let stdout_read = self
            .stdout_read
            .take()
            .ok_or_else(|| "AppContainer stdout pipe is unavailable".to_string())?;
        let stderr_read = self
            .stderr_read
            .take()
            .ok_or_else(|| "AppContainer stderr pipe is unavailable".to_string())?;

        let stdout_task = thread::spawn(move || read_pipe_to_string(stdout_read.raw()));
        let stderr_task = thread::spawn(move || read_pipe_to_string(stderr_read.raw()));

        let wait_result = unsafe { WaitForSingleObject(self.process_handle.raw(), wait_ms) };
        if wait_result == WAIT_TIMEOUT {
            let _ = self.terminate(1);
            let _ = unsafe { WaitForSingleObject(self.process_handle.raw(), 3000) };
            let _ = join_reader(stdout_task, "stdout");
            let _ = join_reader(stderr_task, "stderr");
            return Err(format!(
                "AppContainer probe timed out after {}ms",
                timeout_label_ms.unwrap_or(wait_ms)
            ));
        }
        if wait_result != WAIT_OBJECT_0 {
            let _ = self.terminate(1);
            let _ = join_reader(stdout_task, "stdout");
            let _ = join_reader(stderr_task, "stderr");
            return Err(format!(
                "WaitForSingleObject returned unexpected status {}",
                wait_result
            ));
        }

        let mut exit_code = 0u32;
        let ok = unsafe { GetExitCodeProcess(self.process_handle.raw(), &mut exit_code) };
        if ok == 0 {
            return Err(last_os_error("GetExitCodeProcess"));
        }

        let stdout = join_reader(stdout_task, "stdout")?;
        let stderr = join_reader(stderr_task, "stderr")?;
        Ok(RestrictedTokenProbeResult {
            exit_code: exit_code as i32,
            output: format!("{}{}", stdout, stderr),
            stdout,
            stderr,
        })
    }
}

pub fn spawn_appcontainer_filesystem_process(
    profile_name: &str,
    grants: &[AppContainerFilesystemGrant],
    command: &str,
    workdir: Option<&Path>,
    env_overrides: &[(String, String)],
) -> Result<AppContainerChild, String> {
    spawn_appcontainer_filesystem_process_with_capabilities(
        profile_name,
        grants,
        &[],
        command,
        workdir,
        env_overrides,
    )
}

pub fn spawn_appcontainer_filesystem_process_with_capabilities(
    profile_name: &str,
    grants: &[AppContainerFilesystemGrant],
    network_capabilities: &[AppContainerNetworkCapability],
    command: &str,
    workdir: Option<&Path>,
    env_overrides: &[(String, String)],
) -> Result<AppContainerChild, String> {
    let profile = prepare_appcontainer_filesystem_profile_with_capabilities(
        profile_name,
        grants,
        network_capabilities,
    )?;
    let environment_block = if env_overrides.is_empty() {
        None
    } else {
        Some(build_environment_block(env_overrides))
    };
    let (stdout_read, stdout_write) = create_inheritable_pipe()?;
    let (stderr_read, stderr_write) = create_inheritable_pipe()?;
    let process_information = create_appcontainer_process(
        &profile,
        command,
        workdir,
        environment_block.as_deref(),
        stdout_write.raw(),
        stderr_write.raw(),
    )?;

    let process_handle =
        OwnedWin32Handle::new(process_information.hProcess, "AppContainer process")?;
    let thread_handle =
        OwnedWin32Handle::new(process_information.hThread, "AppContainer process thread")?;
    let job = match WindowsJobObject::create(ProcessSandboxProfile::Restricted) {
        Ok(job) => job,
        Err(error) => {
            let _ = unsafe { TerminateProcess(process_handle.raw(), 1) };
            return Err(error);
        }
    };
    if let Err(error) = job.assign_process_handle(process_handle.raw()) {
        let _ = unsafe { TerminateProcess(process_handle.raw(), 1) };
        return Err(error);
    }

    let resume_result = unsafe { ResumeThread(thread_handle.raw()) };
    if resume_result == u32::MAX {
        let _ = job.terminate(1);
        return Err(last_os_error("ResumeThread"));
    }

    drop(thread_handle);
    drop(stdout_write);
    drop(stderr_write);

    Ok(AppContainerChild {
        process_handle,
        stdout_read: Some(stdout_read),
        stderr_read: Some(stderr_read),
        job,
        _profile: profile,
    })
}

pub fn run_appcontainer_filesystem_probe(
    profile_name: &str,
    grants: &[AppContainerFilesystemGrant],
    command: &str,
    workdir: Option<&Path>,
    timeout_ms: u32,
) -> Result<RestrictedTokenProbeResult, String> {
    spawn_appcontainer_filesystem_process(profile_name, grants, command, workdir, &[])?
        .wait_with_output_timeout(timeout_ms)
}

fn open_current_process_token() -> Result<OwnedWin32Handle, String> {
    let mut token: HANDLE = null_mut();
    let ok =
        unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_CREATE_PROCESS_ACCESS, &mut token) };
    if ok == 0 {
        return Err(last_os_error("OpenProcessToken"));
    }
    OwnedWin32Handle::new(token, "OpenProcessToken")
}

fn create_restricted_process_token() -> Result<OwnedWin32Handle, String> {
    let process_token = open_current_process_token()?;
    let mut first_error = None;

    for flags in [RESTRICTED_TOKEN_FLAGS, RESTRICTED_TOKEN_FALLBACK_FLAGS] {
        let mut restricted_token: HANDLE = null_mut();
        let ok = unsafe {
            CreateRestrictedToken(
                process_token.raw(),
                flags,
                0,
                null(),
                0,
                null(),
                0,
                null(),
                &mut restricted_token,
            )
        };

        if ok != 0 {
            return OwnedWin32Handle::new(restricted_token, "CreateRestrictedToken");
        }

        let error = last_os_error("CreateRestrictedToken");
        if first_error.is_none() {
            first_error = Some(error);
        } else {
            log::debug!("[Sandbox] CreateRestrictedToken fallback failed: {}", error);
        }
    }

    Err(first_error.unwrap_or_else(|| "CreateRestrictedToken failed".to_string()))
}

fn create_inheritable_pipe() -> Result<(OwnedWin32Handle, OwnedWin32Handle), String> {
    let mut security_attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    let mut read_handle: HANDLE = null_mut();
    let mut write_handle: HANDLE = null_mut();
    let ok = unsafe {
        CreatePipe(
            &mut read_handle,
            &mut write_handle,
            &mut security_attributes,
            0,
        )
    };
    if ok == 0 {
        return Err(last_os_error("CreatePipe"));
    }

    let read = OwnedWin32Handle::new(read_handle, "CreatePipe(read)")?;
    let write = OwnedWin32Handle::new(write_handle, "CreatePipe(write)")?;

    let ok = unsafe { SetHandleInformation(read.raw(), HANDLE_FLAG_INHERIT, 0) };
    if ok == 0 {
        return Err(last_os_error("SetHandleInformation"));
    }

    Ok((read, write))
}

fn read_pipe_to_string(read_handle: HANDLE) -> Result<String, String> {
    let mut output = Vec::new();
    let mut buffer = [0u8; 4096];

    loop {
        let mut bytes_read = 0u32;
        let ok = unsafe {
            ReadFile(
                read_handle,
                buffer.as_mut_ptr().cast(),
                buffer.len() as u32,
                &mut bytes_read,
                null_mut(),
            )
        };

        if ok == 0 || bytes_read == 0 {
            break;
        }

        output.extend_from_slice(&buffer[..bytes_read as usize]);
    }

    Ok(String::from_utf8_lossy(&output).into_owned())
}

fn create_restricted_process(
    restricted_token: &OwnedWin32Handle,
    command: &str,
    current_dir: Option<&Path>,
    environment_block: Option<&[u16]>,
    stdout_write: HANDLE,
    stderr_write: HANDLE,
) -> Result<PROCESS_INFORMATION, String> {
    let mut startup_info = STARTUPINFOW::default();
    startup_info.cb = size_of::<STARTUPINFOW>() as u32;
    startup_info.dwFlags = STARTF_USESTDHANDLES;
    startup_info.hStdOutput = stdout_write;
    startup_info.hStdError = stderr_write;
    startup_info.hStdInput = null_mut();

    let creation_flags = CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED;
    let current_dir_wide = current_dir.map(|path| wide_null_os(path.as_os_str()));
    let current_dir_ptr = current_dir_wide
        .as_ref()
        .map(|path| path.as_ptr())
        .unwrap_or_else(null);
    let environment_ptr = environment_block
        .map(|block| block.as_ptr().cast())
        .unwrap_or_else(null);
    let mut process_information = PROCESS_INFORMATION::default();
    let mut command_line = wide_null(command);
    let ok = unsafe {
        CreateProcessAsUserW(
            restricted_token.raw(),
            null(),
            command_line.as_mut_ptr(),
            null(),
            null(),
            1,
            creation_flags,
            environment_ptr,
            current_dir_ptr,
            &startup_info,
            &mut process_information,
        )
    };
    if ok != 0 {
        return Ok(process_information);
    }

    let as_user_error = last_os_error("CreateProcessAsUserW");
    let mut command_line = wide_null(command);
    let mut fallback_process_information = PROCESS_INFORMATION::default();
    let ok = unsafe {
        CreateProcessWithTokenW(
            restricted_token.raw(),
            0,
            null(),
            command_line.as_mut_ptr(),
            creation_flags,
            environment_ptr,
            current_dir_ptr,
            &startup_info,
            &mut fallback_process_information,
        )
    };
    if ok == 0 {
        return Err(format!(
            "{}; {}",
            as_user_error,
            last_os_error("CreateProcessWithTokenW")
        ));
    }

    Ok(fallback_process_information)
}

#[derive(Debug, Clone)]
pub struct RestrictedTokenChildControl {
    process_handle: usize,
    job_handle: usize,
}

impl RestrictedTokenChildControl {
    pub fn terminate(&self, exit_code: u32) -> Result<(), String> {
        let job_handle = self.job_handle as HANDLE;
        let process_handle = self.process_handle as HANDLE;

        let job_ok = unsafe { TerminateJobObject(job_handle, exit_code) };
        if job_ok == 0 {
            log::debug!(
                "[Sandbox] TerminateJobObject for restricted token child returned: {}",
                std::io::Error::last_os_error()
            );
        }

        let process_ok = unsafe { TerminateProcess(process_handle, exit_code) };
        if process_ok == 0 && job_ok == 0 {
            return Err(last_os_error("TerminateProcess"));
        }

        Ok(())
    }
}

#[derive(Debug)]
pub struct RestrictedTokenChild {
    process_handle: OwnedWin32Handle,
    stdout_read: Option<OwnedWin32Handle>,
    stderr_read: Option<OwnedWin32Handle>,
    job: WindowsJobObject,
}

impl RestrictedTokenChild {
    pub fn control(&self) -> RestrictedTokenChildControl {
        RestrictedTokenChildControl {
            process_handle: self.process_handle.raw() as usize,
            job_handle: self.job.as_handle() as usize,
        }
    }

    pub fn terminate(&self, exit_code: u32) -> Result<(), String> {
        self.control().terminate(exit_code)
    }

    pub fn wait_with_output(self) -> Result<RestrictedTokenProbeResult, String> {
        self.wait_with_output_for(INFINITE, None)
    }

    fn wait_with_output_timeout(
        self,
        timeout_ms: u32,
    ) -> Result<RestrictedTokenProbeResult, String> {
        self.wait_with_output_for(timeout_ms, Some(timeout_ms))
    }

    fn wait_with_output_for(
        mut self,
        wait_ms: u32,
        timeout_label_ms: Option<u32>,
    ) -> Result<RestrictedTokenProbeResult, String> {
        let stdout_read = self
            .stdout_read
            .take()
            .ok_or_else(|| "restricted stdout pipe is unavailable".to_string())?;
        let stderr_read = self
            .stderr_read
            .take()
            .ok_or_else(|| "restricted stderr pipe is unavailable".to_string())?;

        let stdout_task = thread::spawn(move || read_pipe_to_string(stdout_read.raw()));
        let stderr_task = thread::spawn(move || read_pipe_to_string(stderr_read.raw()));

        let wait_result = unsafe { WaitForSingleObject(self.process_handle.raw(), wait_ms) };
        if wait_result == WAIT_TIMEOUT {
            let _ = self.terminate(1);
            let _ = unsafe { WaitForSingleObject(self.process_handle.raw(), 3000) };
            let _ = join_reader(stdout_task, "stdout");
            let _ = join_reader(stderr_task, "stderr");
            return Err(format!(
                "restricted token probe timed out after {}ms",
                timeout_label_ms.unwrap_or(wait_ms)
            ));
        }
        if wait_result != WAIT_OBJECT_0 {
            let _ = self.terminate(1);
            let _ = join_reader(stdout_task, "stdout");
            let _ = join_reader(stderr_task, "stderr");
            return Err(format!(
                "WaitForSingleObject returned unexpected status {}",
                wait_result
            ));
        }

        let mut exit_code = 0u32;
        let ok = unsafe { GetExitCodeProcess(self.process_handle.raw(), &mut exit_code) };
        if ok == 0 {
            return Err(last_os_error("GetExitCodeProcess"));
        }

        let stdout = join_reader(stdout_task, "stdout")?;
        let stderr = join_reader(stderr_task, "stderr")?;
        Ok(RestrictedTokenProbeResult {
            exit_code: exit_code as i32,
            output: format!("{}{}", stdout, stderr),
            stdout,
            stderr,
        })
    }
}

fn join_reader(
    task: thread::JoinHandle<Result<String, String>>,
    label: &str,
) -> Result<String, String> {
    match task.join() {
        Ok(result) => result,
        Err(_) => Err(format!("restricted {} reader thread panicked", label)),
    }
}

pub fn spawn_restricted_token_process(
    command: &str,
    workdir: Option<&Path>,
    env_overrides: &[(String, String)],
) -> Result<RestrictedTokenChild, String> {
    let restricted_token = create_restricted_process_token()?;
    let environment_block = if env_overrides.is_empty() {
        None
    } else {
        Some(build_environment_block(env_overrides))
    };
    let (stdout_read, stdout_write) = create_inheritable_pipe()?;
    let (stderr_read, stderr_write) = create_inheritable_pipe()?;
    let process_information = create_restricted_process(
        &restricted_token,
        command,
        workdir,
        environment_block.as_deref(),
        stdout_write.raw(),
        stderr_write.raw(),
    )?;

    let process_handle = OwnedWin32Handle::new(process_information.hProcess, "restricted process")?;
    let thread_handle =
        OwnedWin32Handle::new(process_information.hThread, "restricted process thread")?;
    let job = match WindowsJobObject::create(ProcessSandboxProfile::Restricted) {
        Ok(job) => job,
        Err(error) => {
            let _ = unsafe { TerminateProcess(process_handle.raw(), 1) };
            return Err(error);
        }
    };
    if let Err(error) = job.assign_process_handle(process_handle.raw()) {
        let _ = unsafe { TerminateProcess(process_handle.raw(), 1) };
        return Err(error);
    }

    let resume_result = unsafe { ResumeThread(thread_handle.raw()) };
    if resume_result == u32::MAX {
        let _ = job.terminate(1);
        return Err(last_os_error("ResumeThread"));
    }

    drop(thread_handle);
    drop(stdout_write);
    drop(stderr_write);

    Ok(RestrictedTokenChild {
        process_handle,
        stdout_read: Some(stdout_read),
        stderr_read: Some(stderr_read),
        job,
    })
}

pub fn run_restricted_token_probe(
    command: &str,
    timeout_ms: u32,
) -> Result<RestrictedTokenProbeResult, String> {
    spawn_restricted_token_process(command, None, &[])?.wait_with_output_timeout(timeout_ms)
}

#[derive(Debug)]
struct WindowsJobObject {
    handle: usize,
}

impl WindowsJobObject {
    fn create(profile: ProcessSandboxProfile) -> Result<Self, String> {
        let handle = unsafe { CreateJobObjectW(null(), null()) };
        if handle.is_null() {
            return Err(format!(
                "CreateJobObjectW failed: {}",
                std::io::Error::last_os_error()
            ));
        }

        let job = Self {
            handle: handle as usize,
        };
        job.configure_limits(profile)?;
        Ok(job)
    }

    fn as_handle(&self) -> HANDLE {
        self.handle as HANDLE
    }

    fn configure_limits(&self, profile: ProcessSandboxProfile) -> Result<(), String> {
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if profile.is_restricted() {
            limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS
                | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
                | JOB_OBJECT_LIMIT_JOB_MEMORY;
            limits.BasicLimitInformation.ActiveProcessLimit = RESTRICTED_ACTIVE_PROCESS_LIMIT;
            limits.JobMemoryLimit = RESTRICTED_JOB_MEMORY_LIMIT_BYTES;
        }

        let ok = unsafe {
            SetInformationJobObject(
                self.as_handle(),
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };

        if ok == 0 {
            return Err(format!(
                "SetInformationJobObject failed: {}",
                std::io::Error::last_os_error()
            ));
        }

        if profile.is_restricted() {
            self.configure_ui_restrictions()?;
        }

        Ok(())
    }

    fn configure_ui_restrictions(&self) -> Result<(), String> {
        let restrictions = JOBOBJECT_BASIC_UI_RESTRICTIONS {
            UIRestrictionsClass: JOB_OBJECT_UILIMIT_HANDLES
                | JOB_OBJECT_UILIMIT_READCLIPBOARD
                | JOB_OBJECT_UILIMIT_WRITECLIPBOARD
                | JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS
                | JOB_OBJECT_UILIMIT_DISPLAYSETTINGS
                | JOB_OBJECT_UILIMIT_GLOBALATOMS
                | JOB_OBJECT_UILIMIT_DESKTOP
                | JOB_OBJECT_UILIMIT_EXITWINDOWS,
        };

        let ok = unsafe {
            SetInformationJobObject(
                self.as_handle(),
                JobObjectBasicUIRestrictions,
                &restrictions as *const _ as *const _,
                size_of::<JOBOBJECT_BASIC_UI_RESTRICTIONS>() as u32,
            )
        };

        if ok == 0 {
            return Err(format!(
                "SetInformationJobObject UI restrictions failed: {}",
                std::io::Error::last_os_error()
            ));
        }

        Ok(())
    }

    fn assign_child(&self, child: &Child) -> Result<(), String> {
        let Some(raw_handle) = child.raw_handle() else {
            return Err("child process handle is unavailable".to_string());
        };
        let process_handle = raw_handle as HANDLE;
        self.assign_process_handle(process_handle)
    }

    fn assign_process_handle(&self, process_handle: HANDLE) -> Result<(), String> {
        if process_handle.is_null() {
            return Err("child process handle is null".to_string());
        }
        let ok = unsafe { AssignProcessToJobObject(self.as_handle(), process_handle) };
        if ok == 0 {
            return Err(format!(
                "AssignProcessToJobObject failed: {}",
                std::io::Error::last_os_error()
            ));
        }

        Ok(())
    }

    fn terminate(&self, exit_code: u32) -> Result<(), String> {
        let ok = unsafe { TerminateJobObject(self.as_handle(), exit_code) };
        if ok == 0 {
            return Err(format!(
                "TerminateJobObject failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }
}

impl Drop for WindowsJobObject {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.as_handle()) };
    }
}

#[derive(Debug, Default)]
pub struct ProcessSandboxGuard {
    job: Option<WindowsJobObject>,
}

impl ProcessSandboxGuard {
    pub fn attach_child(
        child: &Child,
        command_label: &str,
        profile: ProcessSandboxProfile,
    ) -> Result<Self, String> {
        if !profile.uses_job_object() {
            log::debug!(
                "[Sandbox] detached launch skips Job Object lifecycle guard: {}",
                command_label
            );
            return Ok(Self { job: None });
        }

        match WindowsJobObject::create(profile).and_then(|job| {
            job.assign_child(child)?;
            Ok(job)
        }) {
            Ok(job) => {
                log::debug!(
                    "[Sandbox] Job Object 已挂载到进程(profile={:?}): {}",
                    profile,
                    command_label
                );
                Ok(Self { job: Some(job) })
            }
            Err(error) => {
                if profile.requires_job_object() {
                    return Err(format!(
                        "required Job Object attach failed for restricted execution: {}",
                        error
                    ));
                }
                log::warn!(
                    "[Sandbox] Job Object 挂载失败，命令将按原有执行路径继续: {} | {}",
                    command_label,
                    error
                );
                Ok(Self { job: None })
            }
        }
    }

    pub fn terminate(&self, exit_code: u32) -> Result<(), String> {
        if let Some(job) = &self.job {
            job.terminate(exit_code)?;
        }
        Ok(())
    }
}
