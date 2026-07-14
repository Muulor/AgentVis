//! Native, bounded Project Preview source staging.
//!
//! Source trees are constrained to the app-owned deliverables directory. Directory traversal,
//! text reads, and asset copies use no-follow handles plus identity rechecks so untrusted project
//! paths cannot redirect Preview into a symlink, junction, reparse point, or out-of-root target.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{File, Metadata, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use tauri::Manager;

use crate::error::{AppError, CommandResult};

use super::shell::validate_owned_preview_workspace_for_staging;

const HARD_MAX_DEPTH: u32 = 24;
const HARD_MAX_ENTRIES: u32 = 10_000;
const HARD_MAX_FILES: u32 = 1_000;
const HARD_MAX_SOURCE_FILE_BYTES: u64 = 4 * 1024 * 1024;
const HARD_MAX_SOURCE_TOTAL_BYTES: u64 = 32 * 1024 * 1024;
const HARD_MAX_TEXT_BYTES: u64 = 4 * 1024 * 1024;
const HARD_MAX_ASSET_FILE_BYTES: u64 = 64 * 1024 * 1024;
const HARD_MAX_ASSET_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
const MAX_FILTER_ITEMS: usize = 128;
const PREVIEW_WORKSPACE_RESERVED_DIRECTORY: &str = ".agentvis";

const BUILTIN_SKIP_DIRECTORIES: &[&str] = &[
    ".agentvis",
    ".agentvis-importing",
    ".git",
    "agent-log",
    "build",
    "dist",
    "node_modules",
    "vite_preview",
];

const BUILTIN_SKIP_ASSET_FILES: &[&str] = &[
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "tsconfig.json",
    "jsconfig.json",
];

const BUILTIN_SKIP_ROOT_SOURCE_FILES: &[&str] =
    &["package.json", "package-lock.json", "npm-shrinkwrap.json"];

fn staging_error(kind: &str, detail: impl AsRef<str>) -> String {
    format!("PREVIEW_STAGING_{kind}:{}", detail.as_ref())
}

fn unsafe_path(detail: impl AsRef<str>) -> String {
    staging_error("UNSAFE", detail)
}

fn budget_error(detail: impl AsRef<str>) -> String {
    staging_error("BUDGET", detail)
}

fn not_found(detail: impl AsRef<str>) -> String {
    staging_error("NOT_FOUND", detail)
}

fn io_error(detail: impl AsRef<str>) -> String {
    staging_error("IO", detail)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTraversalLimits {
    pub max_depth: u32,
    pub max_entries: u32,
    pub max_files: u32,
    pub max_file_bytes: u64,
    pub max_total_bytes: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewListSourceTreeRequest {
    pub root: String,
    #[serde(default)]
    pub current_relative: String,
    pub max_depth: u32,
    pub max_entries: u32,
    pub max_files: u32,
    pub max_file_bytes: u64,
    pub max_total_bytes: u64,
    #[serde(default)]
    pub extensions: Vec<String>,
    #[serde(default)]
    pub skip_directories: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSourceEntry {
    pub path: String,
    pub source_path: String,
    pub size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewListSourceTreeResult {
    pub project_root: String,
    pub project_root_relative: String,
    pub source_prefix: String,
    pub has_package_json: bool,
    pub entries: Vec<PreviewSourceEntry>,
    pub scanned_entries: u32,
    pub total_bytes: u64,
    pub skipped_links: u32,
    pub omitted_environment_files: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewReadTextFileRequest {
    pub root: String,
    pub relative_path: String,
    pub max_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewReadTextFileResult {
    pub path: String,
    pub content: String,
    pub size: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCopyAssetsRequest {
    pub source_root: String,
    pub workspace: String,
    pub run_id: String,
    pub owner_token: String,
    #[serde(default)]
    pub destination_prefix: String,
    pub limits: PreviewTraversalLimits,
    #[serde(default)]
    pub extensions: Vec<String>,
    #[serde(default)]
    pub skip_directories: Vec<String>,
    #[serde(default)]
    pub skip_files: Vec<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCopyAssetsResult {
    pub copied_files: u32,
    pub copied_bytes: u64,
    pub scanned_entries: u32,
    pub skipped_links: u32,
    pub skipped_existing: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    scope: u64,
    file: u64,
}

#[cfg(target_os = "windows")]
fn file_identity(file: &File) -> Result<FileIdentity, String> {
    use std::mem::MaybeUninit;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let mut info = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
    let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, info.as_mut_ptr()) };
    if ok == 0 {
        return Err(io_error(format!(
            "file-identity:{}",
            std::io::Error::last_os_error()
        )));
    }
    let info = unsafe { info.assume_init() };
    Ok(FileIdentity {
        scope: u64::from(info.dwVolumeSerialNumber),
        file: (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
    })
}

#[cfg(target_os = "windows")]
fn file_link_count(file: &File) -> Result<u64, String> {
    use std::mem::MaybeUninit;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let mut info = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
    let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, info.as_mut_ptr()) };
    if ok == 0 {
        return Err(io_error(format!(
            "file-link-count:{}",
            std::io::Error::last_os_error()
        )));
    }
    Ok(u64::from(unsafe { info.assume_init() }.nNumberOfLinks))
}

#[cfg(unix)]
fn file_link_count(file: &File) -> Result<u64, String> {
    use std::os::unix::fs::MetadataExt;
    file.metadata()
        .map(|metadata| metadata.nlink())
        .map_err(|error| io_error(format!("file-link-count:{error}")))
}

#[cfg(not(any(target_os = "windows", unix)))]
fn file_link_count(_file: &File) -> Result<u64, String> {
    Ok(1)
}

#[cfg(unix)]
fn file_identity(file: &File) -> Result<FileIdentity, String> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file
        .metadata()
        .map_err(|error| io_error(format!("file-fstat:{error}")))?;
    Ok(FileIdentity {
        scope: metadata.dev(),
        file: metadata.ino(),
    })
}

#[cfg(not(any(target_os = "windows", unix)))]
fn file_identity(file: &File) -> Result<FileIdentity, String> {
    let metadata = file
        .metadata()
        .map_err(|error| io_error(format!("file-fstat:{error}")))?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or_default();
    Ok(FileIdentity {
        scope: metadata.len(),
        file: modified,
    })
}

fn metadata_is_reparse(metadata: &Metadata) -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x0000_0400 != 0
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = metadata;
        false
    }
}

fn metadata_is_link(metadata: &Metadata) -> bool {
    metadata.file_type().is_symlink() || metadata_is_reparse(metadata)
}

fn configure_no_follow(options: &mut OpenOptions, directory: bool) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        const FILE_SHARE_READ: u32 = 0x0000_0001;
        const FILE_SHARE_WRITE: u32 = 0x0000_0002;
        let flags = FILE_FLAG_OPEN_REPARSE_POINT
            | if directory {
                FILE_FLAG_BACKUP_SEMANTICS
            } else {
                0
            };
        options
            .custom_flags(flags)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let flags =
            libc::O_NOFOLLOW | libc::O_CLOEXEC | if directory { 0 } else { libc::O_NONBLOCK };
        options.custom_flags(flags);
    }
    #[cfg(not(any(target_os = "windows", unix)))]
    {
        let _ = (options, directory);
    }
}

fn open_directory_no_follow(path: &Path) -> Result<File, String> {
    let before = std::fs::symlink_metadata(path)
        .map_err(|error| io_error(format!("directory-metadata:{}:{error}", path.display())))?;
    if !before.is_dir() || metadata_is_link(&before) {
        return Err(unsafe_path(format!("directory-link:{}", path.display())));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    configure_no_follow(&mut options, true);
    let file = options
        .open(path)
        .map_err(|error| io_error(format!("directory-open:{}:{error}", path.display())))?;
    let opened = file
        .metadata()
        .map_err(|error| io_error(format!("directory-fstat:{}:{error}", path.display())))?;
    if !opened.is_dir() || metadata_is_reparse(&opened) {
        return Err(unsafe_path(format!("directory-handle:{}", path.display())));
    }
    Ok(file)
}

fn open_regular_file_no_follow(path: &Path) -> Result<(File, Metadata, FileIdentity), String> {
    open_regular_file_no_follow_with_hard_link_scope(path, None)
}

fn open_regular_file_no_follow_with_hard_link_scope(
    path: &Path,
    hard_link_scope: Option<&Path>,
) -> Result<(File, Metadata, FileIdentity), String> {
    let before = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(not_found(path.display().to_string()));
        }
        Err(error) => {
            return Err(io_error(format!(
                "file-metadata:{}:{error}",
                path.display()
            )))
        }
    };
    if !before.is_file() || metadata_is_link(&before) {
        return Err(unsafe_path(format!("file-link:{}", path.display())));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    configure_no_follow(&mut options, false);
    let file = options
        .open(path)
        .map_err(|error| io_error(format!("file-open:{}:{error}", path.display())))?;
    let metadata = file
        .metadata()
        .map_err(|error| io_error(format!("file-fstat:{}:{error}", path.display())))?;
    if !metadata.is_file() || metadata_is_reparse(&metadata) {
        return Err(unsafe_path(format!("file-handle:{}", path.display())));
    }
    let link_count = file_link_count(&file)?;
    if link_count != 1 {
        let Some(scope) = hard_link_scope else {
            return Err(unsafe_path(format!("file-hard-link:{}", path.display())));
        };
        verify_contained_source_hard_links(&file, path, scope, link_count)?;
    }
    let identity = file_identity(&file)?;
    Ok((file, metadata, identity))
}

#[cfg(target_os = "windows")]
fn handle_resolved_path(file: &File, _path_hint: &Path) -> Result<PathBuf, String> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;

    let handle = file.as_raw_handle() as _;
    let required = unsafe { GetFinalPathNameByHandleW(handle, std::ptr::null_mut(), 0, 0) };
    if required == 0 {
        return Err(io_error(format!(
            "handle-final-path-size:{}",
            std::io::Error::last_os_error()
        )));
    }
    let mut buffer = vec![0_u16; required as usize + 1];
    let length =
        unsafe { GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), buffer.len() as u32, 0) };
    if length == 0 || length as usize >= buffer.len() {
        return Err(io_error(format!(
            "handle-final-path:{}",
            std::io::Error::last_os_error()
        )));
    }
    buffer.truncate(length as usize);
    Ok(PathBuf::from(std::ffi::OsString::from_wide(&buffer)))
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn handle_resolved_path(file: &File, _path_hint: &Path) -> Result<PathBuf, String> {
    use std::os::fd::AsRawFd;

    let resolved = std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))
        .map_err(|error| io_error(format!("handle-final-path:{error}")))?;
    if !resolved.is_absolute() || resolved.to_string_lossy().ends_with(" (deleted)") {
        return Err(unsafe_path("handle-final-path-unusable"));
    }
    Ok(resolved)
}

#[cfg(target_os = "macos")]
fn handle_resolved_path(file: &File, _path_hint: &Path) -> Result<PathBuf, String> {
    use std::ffi::{c_char, c_int, CStr, OsString};
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStringExt;

    const F_GETPATH: c_int = 50;
    const MAX_PATH_BYTES: usize = 1024;
    unsafe extern "C" {
        fn fcntl(fd: c_int, command: c_int, ...) -> c_int;
    }

    let mut buffer = [0 as c_char; MAX_PATH_BYTES];
    let result = unsafe { fcntl(file.as_raw_fd(), F_GETPATH, buffer.as_mut_ptr()) };
    if result == -1 {
        return Err(io_error(format!(
            "handle-final-path:{}",
            std::io::Error::last_os_error()
        )));
    }
    let bytes = unsafe { CStr::from_ptr(buffer.as_ptr()) }
        .to_bytes()
        .to_vec();
    let resolved = PathBuf::from(OsString::from_vec(bytes));
    if !resolved.is_absolute() {
        return Err(unsafe_path("handle-final-path-unusable"));
    }
    Ok(resolved)
}

#[cfg(all(
    unix,
    not(any(target_os = "linux", target_os = "android", target_os = "macos"))
))]
fn handle_resolved_path(file: &File, path_hint: &Path) -> Result<PathBuf, String> {
    // Other Unix targets do not expose one portable fd-to-path API. Fall back to a canonical
    // path plus an identity-matched no-follow reopen; if either side races, fail closed.
    let resolved = std::fs::canonicalize(path_hint)
        .map_err(|error| io_error(format!("handle-final-path-fallback:{error}")))?;
    let metadata = file
        .metadata()
        .map_err(|error| io_error(format!("handle-final-path-fstat:{error}")))?;
    let reopened = if metadata.is_dir() {
        open_directory_no_follow(&resolved)?
    } else if metadata.is_file() {
        open_regular_file_no_follow(&resolved)?.0
    } else {
        return Err(unsafe_path("handle-final-path-file-type"));
    };
    if file_identity(&reopened)? != file_identity(file)? {
        return Err(unsafe_path("handle-final-path-identity-changed"));
    }
    Ok(resolved)
}

#[cfg(not(any(target_os = "windows", unix)))]
fn handle_resolved_path(file: &File, path_hint: &Path) -> Result<PathBuf, String> {
    let resolved = std::fs::canonicalize(path_hint)
        .map_err(|error| io_error(format!("handle-final-path-fallback:{error}")))?;
    let reopened = OpenOptions::new()
        .read(true)
        .open(&resolved)
        .map_err(|error| io_error(format!("handle-final-path-open:{error}")))?;
    if file_identity(&reopened)? != file_identity(file)? {
        return Err(unsafe_path("handle-final-path-identity-changed"));
    }
    Ok(resolved)
}

#[cfg(target_os = "windows")]
fn path_is_within(candidate: &Path, root: &Path) -> bool {
    fn components(path: &Path) -> Vec<String> {
        let mut value = path.to_string_lossy().replace('/', "\\");
        if let Some(stripped) = value.strip_prefix(r"\\?\UNC\") {
            value = format!(r"\\{stripped}");
        } else if let Some(stripped) = value.strip_prefix(r"\\?\") {
            value = stripped.to_string();
        }
        value
            .split('\\')
            .filter(|component| !component.is_empty())
            .map(str::to_ascii_lowercase)
            .collect()
    }

    let candidate = components(candidate);
    let root = components(root);
    !root.is_empty()
        && candidate.len() >= root.len()
        && candidate
            .iter()
            .zip(root.iter())
            .all(|(left, right)| left == right)
}

#[cfg(target_os = "windows")]
fn verify_contained_source_hard_links(
    file: &File,
    path_hint: &Path,
    allowed_root: &Path,
    expected_count: u64,
) -> Result<(), String> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows_sys::Win32::Foundation::{ERROR_HANDLE_EOF, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        FindClose, FindFirstFileNameW, FindNextFileNameW, GetVolumePathNameW,
    };

    const MAX_HARD_LINK_PATH_CHARS: usize = 32_768;

    struct FindNameHandle(windows_sys::Win32::Foundation::HANDLE);

    impl Drop for FindNameHandle {
        fn drop(&mut self) {
            unsafe {
                FindClose(self.0);
            }
        }
    }

    let encoded_path = path_hint
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut volume_buffer = vec![0_u16; MAX_HARD_LINK_PATH_CHARS];
    let volume_ok = unsafe {
        GetVolumePathNameW(
            encoded_path.as_ptr(),
            volume_buffer.as_mut_ptr(),
            volume_buffer.len() as u32,
        )
    };
    if volume_ok == 0 {
        return Err(io_error(format!(
            "hard-link-volume:{}:{}",
            path_hint.display(),
            std::io::Error::last_os_error()
        )));
    }
    let volume_length = volume_buffer
        .iter()
        .position(|value| *value == 0)
        .ok_or_else(|| unsafe_path("hard-link-volume-length"))?;
    let volume_root = PathBuf::from(std::ffi::OsString::from_wide(
        &volume_buffer[..volume_length],
    ));

    let mut name_buffer = vec![0_u16; MAX_HARD_LINK_PATH_CHARS];
    let mut name_length = name_buffer.len() as u32;
    let find_handle = unsafe {
        FindFirstFileNameW(
            encoded_path.as_ptr(),
            0,
            &mut name_length,
            name_buffer.as_mut_ptr(),
        )
    };
    if find_handle == INVALID_HANDLE_VALUE {
        return Err(io_error(format!(
            "hard-link-first:{}:{}",
            path_hint.display(),
            std::io::Error::last_os_error()
        )));
    }
    let find_handle = FindNameHandle(find_handle);
    let expected_identity = file_identity(file)?;
    let mut verified_names = HashSet::new();

    loop {
        let used =
            usize::try_from(name_length).map_err(|_| unsafe_path("hard-link-name-length"))?;
        if used == 0 || used >= name_buffer.len() {
            return Err(unsafe_path("hard-link-name-length"));
        }
        let link_name = std::ffi::OsString::from_wide(&name_buffer[..used]);
        let link_name = link_name.to_string_lossy();
        let relative_name = link_name.trim_matches('\0').trim_start_matches(['\\', '/']);
        if relative_name.is_empty() {
            return Err(unsafe_path("hard-link-name-empty"));
        }
        let candidate = volume_root.join(relative_name);
        let canonical_candidate = std::fs::canonicalize(&candidate).map_err(|error| {
            unsafe_path(format!(
                "hard-link-canonical:{}:{error}",
                candidate.display()
            ))
        })?;
        if !path_is_within(&canonical_candidate, allowed_root) {
            return Err(unsafe_path(format!(
                "file-hard-link-outside-workspace:{}",
                path_hint.display()
            )));
        }
        let metadata = std::fs::symlink_metadata(&candidate).map_err(|error| {
            unsafe_path(format!(
                "hard-link-metadata:{}:{error}",
                candidate.display()
            ))
        })?;
        if !metadata.is_file() || metadata_is_link(&metadata) {
            return Err(unsafe_path(format!(
                "hard-link-entry:{}",
                candidate.display()
            )));
        }
        let mut options = OpenOptions::new();
        options.read(true);
        configure_no_follow(&mut options, false);
        let alternate = options.open(&candidate).map_err(|error| {
            unsafe_path(format!("hard-link-open:{}:{error}", candidate.display()))
        })?;
        if file_identity(&alternate)? != expected_identity {
            return Err(unsafe_path(format!(
                "hard-link-identity:{}",
                candidate.display()
            )));
        }
        let normalized = canonical_candidate
            .to_string_lossy()
            .replace('/', "\\")
            .to_ascii_lowercase();
        if !verified_names.insert(normalized) {
            return Err(unsafe_path("hard-link-name-duplicate"));
        }

        name_length = name_buffer.len() as u32;
        let next =
            unsafe { FindNextFileNameW(find_handle.0, &mut name_length, name_buffer.as_mut_ptr()) };
        if next != 0 {
            continue;
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(ERROR_HANDLE_EOF as i32) {
            break;
        }
        return Err(io_error(format!(
            "hard-link-next:{}:{error}",
            path_hint.display()
        )));
    }

    drop(find_handle);
    if u64::try_from(verified_names.len()).ok() != Some(expected_count) {
        return Err(unsafe_path(format!(
            "hard-link-count-changed:{}",
            path_hint.display()
        )));
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn verify_contained_source_hard_links(
    _file: &File,
    path_hint: &Path,
    _allowed_root: &Path,
    _expected_count: u64,
) -> Result<(), String> {
    Err(unsafe_path(format!(
        "file-hard-link:{}",
        path_hint.display()
    )))
}

#[cfg(not(target_os = "windows"))]
fn path_is_within(candidate: &Path, root: &Path) -> bool {
    candidate.starts_with(root)
}

#[derive(Debug)]
struct HandleContainment {
    root: PathBuf,
}

impl HandleContainment {
    fn from_handle(file: &File, path_hint: &Path, label: &str) -> Result<Self, String> {
        let root = handle_resolved_path(file, path_hint)?;
        if !root.is_absolute() {
            return Err(unsafe_path(format!("{label}-root-not-absolute")));
        }
        Ok(Self { root })
    }

    fn verify(&self, file: &File, path_hint: &Path, label: &str) -> Result<(), String> {
        let resolved = handle_resolved_path(file, path_hint)?;
        if !path_is_within(&resolved, &self.root) {
            return Err(unsafe_path(format!("{label}-outside-root")));
        }
        Ok(())
    }
}

fn verify_contained_file_path_identity(
    path: &Path,
    expected: FileIdentity,
    containment: &HandleContainment,
    label: &str,
) -> Result<(), String> {
    let (reopened, _, identity) = open_regular_file_no_follow(path)?;
    containment.verify(&reopened, path, label)?;
    if identity != expected {
        return Err(unsafe_path(format!(
            "file-identity-changed:{}",
            path.display()
        )));
    }
    Ok(())
}

fn verify_contained_source_file_path_identity(
    path: &Path,
    expected: FileIdentity,
    containment: &HandleContainment,
    hard_link_scope: Option<&Path>,
    label: &str,
) -> Result<(), String> {
    let (reopened, _, identity) =
        open_regular_file_no_follow_with_hard_link_scope(path, hard_link_scope)?;
    containment.verify(&reopened, path, label)?;
    if identity != expected {
        return Err(unsafe_path(format!(
            "file-identity-changed:{}",
            path.display()
        )));
    }
    Ok(())
}

struct DirectoryGuard {
    path: PathBuf,
    identity: FileIdentity,
    handle: File,
}

impl DirectoryGuard {
    fn open(path: &Path) -> Result<Self, String> {
        let handle = open_directory_no_follow(path)?;
        Self::from_handle(path, handle)
    }

    fn from_handle(path: &Path, handle: File) -> Result<Self, String> {
        let metadata = handle
            .metadata()
            .map_err(|error| io_error(format!("directory-fstat:{}:{error}", path.display())))?;
        if !metadata.is_dir() || metadata_is_reparse(&metadata) {
            return Err(unsafe_path(format!("directory-handle:{}", path.display())));
        }
        let identity = file_identity(&handle)?;
        Ok(Self {
            path: path.to_path_buf(),
            identity,
            handle,
        })
    }

    fn reopen_verified_identity(&self) -> Result<File, String> {
        let reopened = open_directory_no_follow(&self.path)?;
        let identity = file_identity(&reopened)?;
        if identity != self.identity {
            return Err(unsafe_path(format!(
                "directory-identity-changed:{}",
                self.path.display()
            )));
        }
        Ok(reopened)
    }

    fn verify_contained(&self, containment: &HandleContainment, label: &str) -> Result<(), String> {
        containment.verify(&self.handle, &self.path, label)?;
        let reopened = self.reopen_verified_identity()?;
        containment.verify(&reopened, &self.path, label)
    }
}

struct SourceRootGuard {
    root: PathBuf,
    guard: DirectoryGuard,
    deliverables_guard: DirectoryGuard,
    ancestor_guards: Vec<DirectoryGuard>,
    deliverables_containment: HandleContainment,
    containment: HandleContainment,
    hard_link_scope: Option<PathBuf>,
}

impl SourceRootGuard {
    fn verify(&self) -> Result<(), String> {
        self.deliverables_guard
            .verify_contained(&self.deliverables_containment, "deliverables")?;
        for guard in &self.ancestor_guards {
            guard.verify_contained(&self.deliverables_containment, "source-ancestor")?;
        }
        self.guard
            .verify_contained(&self.deliverables_containment, "source-root")?;
        self.guard
            .verify_contained(&self.containment, "source-root")
    }

    fn verify_handle(&self, file: &File, path_hint: &Path, label: &str) -> Result<(), String> {
        self.deliverables_containment
            .verify(file, path_hint, label)?;
        self.containment.verify(file, path_hint, label)
    }

    fn verify_directory(&self, guard: &DirectoryGuard, label: &str) -> Result<(), String> {
        guard.verify_contained(&self.deliverables_containment, label)?;
        guard.verify_contained(&self.containment, label)
    }
}

fn resolve_source_root(
    app_data_dir: &Path,
    requested: &Path,
) -> Result<Option<SourceRootGuard>, String> {
    if !requested.is_absolute() {
        return Err(unsafe_path("source-root-not-absolute"));
    }
    match std::fs::symlink_metadata(requested) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error(format!("source-root-metadata:{error}"))),
        Ok(_) => {}
    }
    let deliverables = app_data_dir.join("deliverables");
    let deliverables_guard = DirectoryGuard::open(&deliverables)?;
    let deliverables_containment = HandleContainment::from_handle(
        &deliverables_guard.handle,
        &deliverables_guard.path,
        "deliverables",
    )?;
    deliverables_guard.verify_contained(&deliverables_containment, "deliverables")?;
    let canonical_deliverables = std::fs::canonicalize(&deliverables)
        .map_err(|error| io_error(format!("deliverables-canonical:{error}")))?;
    let canonical_root = std::fs::canonicalize(requested)
        .map_err(|error| io_error(format!("source-root-canonical:{error}")))?;
    let relative = canonical_root
        .strip_prefix(&canonical_deliverables)
        .map_err(|_| unsafe_path("source-root-outside-deliverables"))?;
    let relative_components = relative
        .components()
        .filter_map(|component| match component {
            Component::Normal(segment) => Some(segment.to_os_string()),
            _ => None,
        })
        .collect::<Vec<_>>();
    let hard_link_scope = if relative_components.len() >= 2 {
        let workspace_root = canonical_deliverables
            .join(&relative_components[0])
            .join(&relative_components[1]);
        Some(
            std::fs::canonicalize(&workspace_root)
                .map_err(|error| io_error(format!("workspace-root-canonical:{error}")))?,
        )
    } else {
        None
    };

    let mut current = canonical_deliverables.clone();
    let mut ancestor_guards = Vec::new();
    for component in relative.components() {
        let Component::Normal(segment) = component else {
            return Err(unsafe_path("source-root-component"));
        };
        current.push(segment);
        let component_guard = DirectoryGuard::open(&current)?;
        component_guard.verify_contained(&deliverables_containment, "source-ancestor")?;
        ancestor_guards.push(component_guard);
    }
    let guard = DirectoryGuard::open(&canonical_root)?;
    guard.verify_contained(&deliverables_containment, "source-root")?;
    let containment = HandleContainment::from_handle(&guard.handle, &guard.path, "source-root")?;
    guard.verify_contained(&containment, "source-root")?;
    Ok(Some(SourceRootGuard {
        root: canonical_root,
        guard,
        deliverables_guard,
        ancestor_guards,
        deliverables_containment,
        containment,
        hard_link_scope,
    }))
}

fn is_reserved_windows_name(component: &str) -> bool {
    let stem = component
        .split('.')
        .next()
        .unwrap_or(component)
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0')
}

fn normalize_relative_path(
    value: &str,
    allow_empty: bool,
) -> Result<(String, Vec<String>), String> {
    if value.contains('\0')
        || value.starts_with('/')
        || value.starts_with('\\')
        || (value.len() >= 2 && value.as_bytes()[1] == b':')
        || Path::new(value).is_absolute()
    {
        return Err(unsafe_path("relative-path-absolute"));
    }
    let mut segments = Vec::new();
    for segment in value.split(['/', '\\']) {
        if segment.is_empty() {
            continue;
        }
        if segment == "."
            || segment == ".."
            || segment.ends_with('.')
            || segment.ends_with(' ')
            || segment.chars().any(|character| {
                character.is_control()
                    || matches!(character, ':' | '*' | '?' | '"' | '<' | '>' | '|')
            })
            || is_reserved_windows_name(segment)
        {
            return Err(unsafe_path(format!("relative-path-component:{segment}")));
        }
        segments.push(segment.to_string());
    }
    if segments.is_empty() && !allow_empty {
        return Err(unsafe_path("relative-path-empty"));
    }
    Ok((segments.join("/"), segments))
}

fn join_segments(root: &Path, segments: &[String]) -> PathBuf {
    let mut path = root.to_path_buf();
    for segment in segments {
        path.push(segment);
    }
    path
}

fn validate_directory_chain(
    source: &SourceRootGuard,
    segments: &[String],
) -> Result<PathBuf, String> {
    let mut current = source.root.clone();
    for segment in segments {
        current.push(segment);
        let guard = DirectoryGuard::open(&current)?;
        source.verify_directory(&guard, "source-directory")?;
    }
    Ok(current)
}

fn validate_limits(limits: &PreviewTraversalLimits, asset_mode: bool) -> Result<(), String> {
    let max_file = if asset_mode {
        HARD_MAX_ASSET_FILE_BYTES
    } else {
        HARD_MAX_SOURCE_FILE_BYTES
    };
    let max_total = if asset_mode {
        HARD_MAX_ASSET_TOTAL_BYTES
    } else {
        HARD_MAX_SOURCE_TOTAL_BYTES
    };
    if limits.max_depth == 0 || limits.max_depth > HARD_MAX_DEPTH {
        return Err(budget_error("max-depth"));
    }
    if limits.max_entries == 0 || limits.max_entries > HARD_MAX_ENTRIES {
        return Err(budget_error("max-entries"));
    }
    if limits.max_files == 0 || limits.max_files > HARD_MAX_FILES {
        return Err(budget_error("max-files"));
    }
    if limits.max_file_bytes == 0 || limits.max_file_bytes > max_file {
        return Err(budget_error("max-file-bytes"));
    }
    if limits.max_total_bytes == 0 || limits.max_total_bytes > max_total {
        return Err(budget_error("max-total-bytes"));
    }
    Ok(())
}

fn normalize_extensions(values: &[String]) -> Result<HashSet<String>, String> {
    if values.is_empty() || values.len() > MAX_FILTER_ITEMS {
        return Err(unsafe_path("extensions"));
    }
    let mut extensions = HashSet::new();
    for value in values {
        let extension = value.trim().trim_start_matches('.').to_ascii_lowercase();
        if extension.is_empty()
            || extension.len() > 16
            || !extension
                .chars()
                .all(|character| character.is_ascii_alphanumeric())
        {
            return Err(unsafe_path(format!("extension:{value}")));
        }
        extensions.insert(extension);
    }
    Ok(extensions)
}

fn normalize_skip_directories(values: &[String]) -> Result<HashSet<String>, String> {
    if values.len() > MAX_FILTER_ITEMS {
        return Err(unsafe_path("skip-directories"));
    }
    let mut directories = BUILTIN_SKIP_DIRECTORIES
        .iter()
        .map(|value| value.to_string())
        .collect::<HashSet<_>>();
    for value in values {
        let (_, segments) = normalize_relative_path(value, false)?;
        if segments.len() != 1 {
            return Err(unsafe_path(format!("skip-directory:{value}")));
        }
        directories.insert(segments[0].to_ascii_lowercase());
    }
    Ok(directories)
}

fn normalize_skip_files(values: &[String]) -> Result<HashSet<String>, String> {
    if values.len() > MAX_FILTER_ITEMS {
        return Err(unsafe_path("skip-files"));
    }
    let mut files = BUILTIN_SKIP_ASSET_FILES
        .iter()
        .map(|value| value.to_ascii_lowercase())
        .collect::<HashSet<_>>();
    for value in values {
        let (_, segments) = normalize_relative_path(value, false)?;
        if segments.len() != 1 {
            return Err(unsafe_path(format!("skip-file:{value}")));
        }
        files.insert(segments[0].to_ascii_lowercase());
    }
    Ok(files)
}

fn file_extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
}

#[derive(Default)]
struct WalkStats {
    scanned_entries: u32,
    files: u32,
    total_bytes: u64,
    skipped_links: u32,
    omitted_environment_files: u32,
}

fn is_environment_file_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == ".env" || lower.starts_with(".env.")
}

struct SourceWalker {
    limits: PreviewTraversalLimits,
    extensions: HashSet<String>,
    skip_directories: HashSet<String>,
    skip_files: HashSet<String>,
    skip_root_files: HashSet<String>,
    skip_hidden_files: bool,
    allow_workspace_asset_hard_links: bool,
    stats: WalkStats,
}

impl SourceWalker {
    fn walk<F>(
        &mut self,
        source: &SourceRootGuard,
        root: &Path,
        prefix: &str,
        callback: &mut F,
    ) -> Result<(), String>
    where
        F: FnMut(&str, &Path, &mut File, u64) -> Result<(), String>,
    {
        self.walk_directory(source, root, prefix, 0, callback)
    }

    fn walk_directory<F>(
        &mut self,
        source: &SourceRootGuard,
        directory: &Path,
        relative_prefix: &str,
        depth: u32,
        callback: &mut F,
    ) -> Result<(), String>
    where
        F: FnMut(&str, &Path, &mut File, u64) -> Result<(), String>,
    {
        let guard = DirectoryGuard::open(directory)?;
        source.verify_directory(&guard, "source-directory")?;
        let entries = std::fs::read_dir(directory)
            .map_err(|error| io_error(format!("read-directory:{}:{error}", directory.display())))?;
        for entry in entries {
            self.stats.scanned_entries = self.stats.scanned_entries.saturating_add(1);
            if self.stats.scanned_entries > self.limits.max_entries {
                return Err(budget_error("scanned-entry-count"));
            }
            let entry = entry.map_err(|error| io_error(format!("directory-entry:{error}")))?;
            let name = entry
                .file_name()
                .to_str()
                .ok_or_else(|| unsafe_path("non-unicode-entry"))?
                .to_string();
            let path = entry.path();
            let metadata = std::fs::symlink_metadata(&path)
                .map_err(|error| io_error(format!("entry-metadata:{}:{error}", path.display())))?;
            if metadata_is_link(&metadata) {
                self.stats.skipped_links = self.stats.skipped_links.saturating_add(1);
                continue;
            }
            if metadata.is_dir() {
                let lower = name.to_ascii_lowercase();
                if name.starts_with('.') || self.skip_directories.contains(&lower) {
                    continue;
                }
                if depth >= self.limits.max_depth {
                    return Err(budget_error("directory-depth"));
                }
                let next_prefix = format!("{relative_prefix}{name}/");
                self.walk_directory(source, &path, &next_prefix, depth + 1, callback)?;
                continue;
            }
            if metadata.is_file() && is_environment_file_name(&name) {
                self.stats.omitted_environment_files =
                    self.stats.omitted_environment_files.saturating_add(1);
            }
            if !metadata.is_file()
                || self.skip_files.contains(&name.to_ascii_lowercase())
                || (relative_prefix.is_empty()
                    && self.skip_root_files.contains(&name.to_ascii_lowercase()))
                || (self.skip_hidden_files && name.starts_with('.'))
            {
                continue;
            }
            let Some(extension) = file_extension(&path) else {
                continue;
            };
            if !self.extensions.contains(&extension) {
                continue;
            }

            let hard_link_scope = self
                .allow_workspace_asset_hard_links
                .then_some(source.hard_link_scope.as_deref())
                .flatten();
            let (mut file, file_metadata, identity) =
                open_regular_file_no_follow_with_hard_link_scope(&path, hard_link_scope)?;
            source.verify_handle(&file, &path, "source-file")?;
            let size = file_metadata.len();
            if size > self.limits.max_file_bytes {
                return Err(budget_error(format!("file:{relative_prefix}{name}")));
            }
            self.stats.files = self.stats.files.saturating_add(1);
            if self.stats.files > self.limits.max_files {
                return Err(budget_error("file-count"));
            }
            self.stats.total_bytes = self
                .stats
                .total_bytes
                .checked_add(size)
                .ok_or_else(|| budget_error("total-overflow"))?;
            if self.stats.total_bytes > self.limits.max_total_bytes {
                return Err(budget_error("source-total"));
            }
            let relative = format!("{relative_prefix}{name}");
            callback(&relative, &path, &mut file, size)?;
            let after = file
                .metadata()
                .map_err(|error| io_error(format!("source-fstat-after:{error}")))?;
            if after.len() != size || file_identity(&file)? != identity {
                return Err(unsafe_path(format!("source-changed:{relative}")));
            }
            source.verify_handle(&file, &path, "source-file")?;
            verify_contained_source_file_path_identity(
                &path,
                identity,
                &source.containment,
                hard_link_scope,
                "source-file",
            )?;
        }
        source.verify_directory(&guard, "source-directory")
    }
}

fn source_limits_from_list(request: &PreviewListSourceTreeRequest) -> PreviewTraversalLimits {
    PreviewTraversalLimits {
        max_depth: request.max_depth,
        max_entries: request.max_entries,
        max_files: request.max_files,
        max_file_bytes: request.max_file_bytes,
        max_total_bytes: request.max_total_bytes,
    }
}

fn package_json_exists(source: &SourceRootGuard, directory: &Path) -> Result<bool, String> {
    let path = directory.join("package.json");
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(io_error(format!("package-json-metadata:{error}"))),
        Ok(metadata) => {
            if !metadata.is_file() || metadata_is_link(&metadata) {
                return Err(unsafe_path("package-json-link"));
            }
            let (file, _, identity) = open_regular_file_no_follow(&path)?;
            source.verify_handle(&file, &path, "package-json")?;
            drop(file);
            verify_contained_file_path_identity(
                &path,
                identity,
                &source.containment,
                "package-json",
            )?;
            Ok(true)
        }
    }
}

fn display_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(target_os = "windows")]
    {
        if let Some(stripped) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{stripped}");
        }
        if let Some(stripped) = value.strip_prefix(r"\\?\") {
            return stripped.to_string();
        }
    }
    value.into_owned()
}

fn list_source_tree_at(
    app_data_dir: &Path,
    request: PreviewListSourceTreeRequest,
) -> Result<PreviewListSourceTreeResult, String> {
    let limits = source_limits_from_list(&request);
    validate_limits(&limits, false)?;
    let extensions = normalize_extensions(&request.extensions)?;
    let skip_directories = normalize_skip_directories(&request.skip_directories)?;
    let source = resolve_source_root(app_data_dir, Path::new(&request.root))?
        .ok_or_else(|| not_found("source-root"))?;
    let (current_relative, mut current_segments) =
        normalize_relative_path(&request.current_relative, true)?;
    let current_directory = validate_directory_chain(&source, &current_segments)?;

    let mut project_segments = current_segments.clone();
    let (project_directory, has_package_json) = loop {
        let candidate = join_segments(&source.root, &project_segments);
        if package_json_exists(&source, &candidate)? {
            break (candidate, true);
        }
        if project_segments.is_empty() {
            break (current_directory.clone(), false);
        }
        project_segments.pop();
    };
    if !has_package_json {
        current_segments = normalize_relative_path(&current_relative, true)?.1;
        project_segments = current_segments;
    }
    let project_root_relative = project_segments.join("/");
    let source_prefix = if !has_package_json
        && !project_root_relative.is_empty()
        && project_segments
            .last()
            .is_some_and(|segment| segment.eq_ignore_ascii_case("src"))
    {
        "src/".to_string()
    } else {
        String::new()
    };

    let mut entries = Vec::new();
    let mut source_paths = HashSet::new();
    let mut logical_paths = HashSet::new();
    let mut walker = SourceWalker {
        limits,
        extensions,
        skip_directories,
        skip_files: HashSet::new(),
        skip_root_files: BUILTIN_SKIP_ROOT_SOURCE_FILES
            .iter()
            .map(|value| (*value).to_string())
            .collect(),
        skip_hidden_files: false,
        allow_workspace_asset_hard_links: false,
        stats: WalkStats::default(),
    };
    walker.walk(
        &source,
        &project_directory,
        "",
        &mut |relative, _, _, size| {
            let (source_path, _) = normalize_relative_path(relative, false)?;
            if source_path != relative || !source_paths.insert(source_path.clone()) {
                return Err(unsafe_path(format!("source-path:{relative}")));
            }
            let logical_candidate = format!("{source_prefix}{source_path}");
            let (logical_path, _) = normalize_relative_path(&logical_candidate, false)?;
            if logical_path != logical_candidate || !logical_paths.insert(logical_path.clone()) {
                return Err(unsafe_path(format!("logical-path:{logical_candidate}")));
            }
            entries.push(PreviewSourceEntry {
                path: logical_path,
                source_path,
                size,
            });
            Ok(())
        },
    )?;
    source.verify()?;
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(PreviewListSourceTreeResult {
        project_root: display_path(&project_directory),
        project_root_relative,
        source_prefix,
        has_package_json,
        entries,
        scanned_entries: walker.stats.scanned_entries,
        total_bytes: walker.stats.total_bytes,
        skipped_links: walker.stats.skipped_links,
        omitted_environment_files: walker.stats.omitted_environment_files,
    })
}

fn read_text_file_at(
    app_data_dir: &Path,
    request: PreviewReadTextFileRequest,
) -> Result<PreviewReadTextFileResult, String> {
    if request.max_bytes == 0 || request.max_bytes > HARD_MAX_TEXT_BYTES {
        return Err(budget_error("text-max-bytes"));
    }
    let source = resolve_source_root(app_data_dir, Path::new(&request.root))?
        .ok_or_else(|| not_found("source-root"))?;
    let (normalized, segments) = normalize_relative_path(&request.relative_path, false)?;
    if segments.len() > 1 {
        validate_directory_chain(&source, &segments[..segments.len() - 1])?;
    }
    let path = join_segments(&source.root, &segments);
    let (mut file, metadata, identity) = open_regular_file_no_follow(&path)?;
    source.verify_handle(&file, &path, "text-file")?;
    if metadata.len() > request.max_bytes {
        return Err(budget_error(format!("text-file:{normalized}")));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    std::io::Read::by_ref(&mut file)
        .take(request.max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| io_error(format!("text-read:{error}")))?;
    if bytes.len() as u64 > request.max_bytes {
        return Err(budget_error(format!("text-file:{normalized}")));
    }
    let after = file
        .metadata()
        .map_err(|error| io_error(format!("text-fstat-after:{error}")))?;
    if after.len() != metadata.len() || file_identity(&file)? != identity {
        return Err(unsafe_path(format!("text-file-changed:{normalized}")));
    }
    source.verify_handle(&file, &path, "text-file")?;
    verify_contained_file_path_identity(&path, identity, &source.containment, "text-file")?;
    source.verify()?;
    let content = String::from_utf8(bytes)
        .map_err(|error| io_error(format!("text-invalid-utf8:{normalized}:{error}")))?;
    Ok(PreviewReadTextFileResult {
        path: normalized,
        size: content.len() as u64,
        content,
    })
}

#[derive(Debug)]
enum DestinationTarget {
    Existing,
    Created { file: File, identity: FileIdentity },
}

fn validate_destination_target_handle(
    file: &File,
    path_hint: &Path,
    containment: &HandleContainment,
) -> Result<FileIdentity, String> {
    let metadata = file
        .metadata()
        .map_err(|error| io_error(format!("target-fstat:{}:{error}", path_hint.display())))?;
    if !metadata.is_file() || metadata_is_reparse(&metadata) {
        return Err(unsafe_path(format!(
            "target-handle:{}",
            path_hint.display()
        )));
    }
    if file_link_count(file)? != 1 {
        return Err(unsafe_path(format!(
            "target-hard-link:{}",
            path_hint.display()
        )));
    }
    containment.verify(file, path_hint, "asset-target")?;
    file_identity(file)
}

#[cfg(unix)]
fn unix_name(value: &str, label: &str) -> Result<std::ffi::CString, String> {
    std::ffi::CString::new(value.as_bytes()).map_err(|_| unsafe_path(format!("{label}-nul")))
}

#[cfg(unix)]
fn unix_openat(
    parent: &File,
    name: &std::ffi::CStr,
    flags: libc::c_int,
    mode: libc::mode_t,
) -> Result<File, std::io::Error> {
    use std::os::fd::{AsRawFd, FromRawFd};

    let descriptor = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags, mode) };
    if descriptor < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(descriptor) })
}

#[cfg(unix)]
fn unix_open_error_is_unsafe(error: &std::io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(code) if code == libc::ELOOP || code == libc::ENOTDIR || code == libc::EISDIR
    )
}

#[cfg(unix)]
fn unix_open_or_create_directory_at(
    parent: &File,
    name: &str,
    path_hint: &Path,
    containment: &HandleContainment,
) -> Result<DirectoryGuard, String> {
    use std::os::fd::AsRawFd;

    let name = unix_name(name, "target-directory")?;
    let created = unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) };
    if created != 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::EEXIST) {
            return Err(io_error(format!(
                "target-directory-create:{}:{error}",
                path_hint.display()
            )));
        }
    }

    let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    let handle = unix_openat(parent, &name, flags, 0).map_err(|error| {
        if unix_open_error_is_unsafe(&error) {
            unsafe_path(format!("target-directory-link:{}", path_hint.display()))
        } else {
            io_error(format!(
                "target-directory-open:{}:{error}",
                path_hint.display()
            ))
        }
    })?;
    let guard = DirectoryGuard::from_handle(path_hint, handle)?;
    containment.verify(&guard.handle, path_hint, "target-directory")?;
    Ok(guard)
}

#[cfg(unix)]
fn open_destination_target(
    parent: &File,
    target_name: &str,
    target_path: &Path,
    containment: &HandleContainment,
) -> Result<DestinationTarget, String> {
    let target_name = unix_name(target_name, "asset-target")?;
    let create_flags =
        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    let existing_flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK;

    for _ in 0..4 {
        match unix_openat(parent, &target_name, create_flags, 0o600) {
            Ok(file) => {
                let identity = validate_destination_target_handle(&file, target_path, containment)?;
                return Ok(DestinationTarget::Created { file, identity });
            }
            Err(error) if error.raw_os_error() == Some(libc::EEXIST) => {
                match unix_openat(parent, &target_name, existing_flags, 0) {
                    Ok(file) => {
                        validate_destination_target_handle(&file, target_path, containment)?;
                        return Ok(DestinationTarget::Existing);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) if unix_open_error_is_unsafe(&error) => {
                        return Err(unsafe_path(format!(
                            "target-existing-unsafe:{}",
                            target_path.display()
                        )));
                    }
                    Err(error) => {
                        return Err(io_error(format!(
                            "target-existing-open:{}:{error}",
                            target_path.display()
                        )));
                    }
                }
            }
            Err(error) if unix_open_error_is_unsafe(&error) => {
                return Err(unsafe_path(format!(
                    "target-create-unsafe:{}",
                    target_path.display()
                )));
            }
            Err(error) => {
                return Err(io_error(format!(
                    "target-create:{}:{error}",
                    target_path.display()
                )));
            }
        }
    }
    Err(unsafe_path(format!(
        "target-entry-raced:{}",
        target_path.display()
    )))
}

#[cfg(not(unix))]
fn open_destination_target(
    _parent: &File,
    _target_name: &str,
    target_path: &Path,
    containment: &HandleContainment,
) -> Result<DestinationTarget, String> {
    for _ in 0..4 {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        configure_no_follow(&mut options, false);
        match options.open(target_path) {
            Ok(file) => {
                let identity = validate_destination_target_handle(&file, target_path, containment)?;
                return Ok(DestinationTarget::Created { file, identity });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                match open_regular_file_no_follow(target_path) {
                    Ok((file, _, _)) => {
                        validate_destination_target_handle(&file, target_path, containment)?;
                        return Ok(DestinationTarget::Existing);
                    }
                    Err(error) if error.starts_with("PREVIEW_STAGING_NOT_FOUND:") => continue,
                    Err(error) => return Err(error),
                }
            }
            Err(error) => {
                return Err(io_error(format!(
                    "target-create:{}:{error}",
                    target_path.display()
                )));
            }
        }
    }
    Err(unsafe_path(format!(
        "target-entry-raced:{}",
        target_path.display()
    )))
}

#[cfg(unix)]
fn verify_destination_target_identity(
    parent: &File,
    target_name: &str,
    target_path: &Path,
    expected: FileIdentity,
    containment: &HandleContainment,
) -> Result<(), String> {
    let target_name = unix_name(target_name, "asset-target")?;
    let flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK;
    let reopened = unix_openat(parent, &target_name, flags, 0).map_err(|error| {
        if unix_open_error_is_unsafe(&error) {
            unsafe_path(format!("target-existing-unsafe:{}", target_path.display()))
        } else {
            io_error(format!("target-reopen:{}:{error}", target_path.display()))
        }
    })?;
    let identity = validate_destination_target_handle(&reopened, target_path, containment)?;
    if identity != expected {
        return Err(unsafe_path(format!(
            "target-identity-changed:{}",
            target_path.display()
        )));
    }
    Ok(())
}

#[cfg(not(unix))]
fn verify_destination_target_identity(
    _parent: &File,
    _target_name: &str,
    target_path: &Path,
    expected: FileIdentity,
    containment: &HandleContainment,
) -> Result<(), String> {
    verify_contained_file_path_identity(target_path, expected, containment, "asset-target")
}

fn ensure_destination_parent(
    workspace: &Path,
    workspace_guard: &DirectoryGuard,
    containment: &HandleContainment,
    relative: &str,
) -> Result<(PathBuf, String, Vec<DirectoryGuard>), String> {
    let (_, segments) = normalize_relative_path(relative, false)?;
    let target_name = segments
        .last()
        .cloned()
        .ok_or_else(|| unsafe_path("target-name"))?;

    #[cfg(unix)]
    {
        containment.verify(&workspace_guard.handle, workspace, "target-workspace")?;
        let mut current = workspace.to_path_buf();
        let mut parent_guards: Vec<DirectoryGuard> = Vec::new();
        for segment in &segments[..segments.len() - 1] {
            let (parent, parent_path) = if let Some(parent) = parent_guards.last() {
                (&parent.handle, parent.path.as_path())
            } else {
                (&workspace_guard.handle, workspace)
            };
            containment.verify(parent, parent_path, "target-directory")?;
            current.push(segment);
            let guard = unix_open_or_create_directory_at(parent, segment, &current, containment)?;
            parent_guards.push(guard);
        }
        Ok((
            join_segments(workspace, &segments),
            target_name,
            parent_guards,
        ))
    }

    #[cfg(not(unix))]
    {
        workspace_guard.verify_contained(containment, "target-workspace")?;
        let mut current = workspace.to_path_buf();
        let mut parent_guards: Vec<DirectoryGuard> = Vec::new();
        for segment in &segments[..segments.len() - 1] {
            if let Some(parent) = parent_guards.last() {
                parent.verify_contained(containment, "target-directory")?;
            } else {
                workspace_guard.verify_contained(containment, "target-workspace")?;
            }
            current.push(segment);
            match std::fs::symlink_metadata(&current) {
                Ok(metadata) => {
                    if !metadata.is_dir() || metadata_is_link(&metadata) {
                        return Err(unsafe_path(format!(
                            "target-directory-link:{}",
                            current.display()
                        )));
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    std::fs::create_dir(&current).map_err(|error| {
                        io_error(format!(
                            "target-directory-create:{}:{error}",
                            current.display()
                        ))
                    })?;
                }
                Err(error) => {
                    return Err(io_error(format!(
                        "target-directory-metadata:{}:{error}",
                        current.display()
                    )));
                }
            }
            let guard = DirectoryGuard::open(&current)?;
            guard.verify_contained(containment, "target-directory")?;
            parent_guards.push(guard);
        }
        Ok((
            join_segments(workspace, &segments),
            target_name,
            parent_guards,
        ))
    }
}

fn copy_source_handle(
    source: &mut File,
    expected_size: u64,
    target_path: &Path,
    containment: &HandleContainment,
    parent: &File,
    target_name: &str,
    mut target: File,
    target_identity: FileIdentity,
) -> Result<(), String> {
    let result = (|| {
        containment.verify(&target, target_path, "asset-target")?;
        let mut copied = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = source
                .read(&mut buffer)
                .map_err(|error| io_error(format!("asset-read:{error}")))?;
            if read == 0 {
                break;
            }
            copied = copied
                .checked_add(read as u64)
                .ok_or_else(|| budget_error("asset-copy-overflow"))?;
            if copied > expected_size {
                return Err(unsafe_path("asset-grew-during-copy"));
            }
            target
                .write_all(&buffer[..read])
                .map_err(|error| io_error(format!("asset-write:{error}")))?;
        }
        if copied != expected_size {
            return Err(unsafe_path("asset-size-changed-during-copy"));
        }
        target
            .sync_all()
            .map_err(|error| io_error(format!("asset-flush:{error}")))?;
        let target_metadata = target
            .metadata()
            .map_err(|error| io_error(format!("asset-target-fstat:{error}")))?;
        if target_metadata.len() != expected_size
            || file_identity(&target)? != target_identity
            || file_link_count(&target)? != 1
        {
            return Err(unsafe_path("asset-target-changed"));
        }
        containment.verify(&target, target_path, "asset-target")?;
        verify_destination_target_identity(
            parent,
            target_name,
            target_path,
            target_identity,
            containment,
        )
    })();
    // Never clean up a failed target by path: an ancestor could be swapped after the final
    // containment check. The owned workspace lifecycle removes any partial file as a whole.
    drop(target);
    result
}

fn copy_assets_at(
    app_data_dir: &Path,
    app_cache_dir: &Path,
    request: PreviewCopyAssetsRequest,
) -> Result<PreviewCopyAssetsResult, String> {
    validate_limits(&request.limits, true)?;
    let extensions = normalize_extensions(&request.extensions)?;
    let skip_directories = normalize_skip_directories(&request.skip_directories)?;
    let skip_files = normalize_skip_files(&request.skip_files)?;
    let (destination_prefix, destination_segments) =
        normalize_relative_path(&request.destination_prefix, true)?;
    if destination_segments
        .first()
        .is_some_and(|segment| segment.eq_ignore_ascii_case(PREVIEW_WORKSPACE_RESERVED_DIRECTORY))
    {
        return Err(unsafe_path("destination-prefix-reserved"));
    }
    let destination_prefix = if destination_prefix.is_empty() {
        String::new()
    } else {
        format!("{destination_prefix}/")
    };
    let workspace = PathBuf::from(&request.workspace);
    validate_owned_preview_workspace_for_staging(
        app_cache_dir,
        &workspace,
        &request.run_id,
        &request.owner_token,
    )
    .map_err(unsafe_path)?;
    let workspace_guard = DirectoryGuard::open(&workspace)?;
    let workspace_containment = HandleContainment::from_handle(
        &workspace_guard.handle,
        &workspace_guard.path,
        "target-workspace",
    )?;
    workspace_guard.verify_contained(&workspace_containment, "target-workspace")?;
    let source = match resolve_source_root(app_data_dir, Path::new(&request.source_root))? {
        Some(source) => source,
        None => {
            workspace_guard.verify_contained(&workspace_containment, "target-workspace")?;
            validate_owned_preview_workspace_for_staging(
                app_cache_dir,
                &workspace,
                &request.run_id,
                &request.owner_token,
            )
            .map_err(unsafe_path)?;
            return Ok(PreviewCopyAssetsResult::default());
        }
    };

    let mut result = PreviewCopyAssetsResult::default();
    let mut walker = SourceWalker {
        limits: request.limits,
        extensions,
        skip_directories,
        skip_files,
        skip_root_files: HashSet::new(),
        skip_hidden_files: true,
        allow_workspace_asset_hard_links: true,
        stats: WalkStats::default(),
    };
    walker.walk(
        &source,
        &source.root,
        "",
        &mut |relative, _, source_file, size| {
            let target_relative = format!("{destination_prefix}{relative}");
            let (target_path, target_name, target_parent_guards) = ensure_destination_parent(
                &workspace,
                &workspace_guard,
                &workspace_containment,
                &target_relative,
            )?;
            let target_parent = target_parent_guards
                .last()
                .map(|guard| &guard.handle)
                .unwrap_or(&workspace_guard.handle);
            match open_destination_target(
                target_parent,
                &target_name,
                &target_path,
                &workspace_containment,
            )? {
                DestinationTarget::Existing => {
                    result.skipped_existing = result.skipped_existing.saturating_add(1);
                    return Ok(());
                }
                DestinationTarget::Created { file, identity } => {
                    copy_source_handle(
                        source_file,
                        size,
                        &target_path,
                        &workspace_containment,
                        target_parent,
                        &target_name,
                        file,
                        identity,
                    )?;
                }
            }
            result.copied_files = result.copied_files.saturating_add(1);
            result.copied_bytes = result
                .copied_bytes
                .checked_add(size)
                .ok_or_else(|| budget_error("copied-total-overflow"))?;
            Ok(())
        },
    )?;
    source.verify()?;
    workspace_guard.verify_contained(&workspace_containment, "target-workspace")?;
    validate_owned_preview_workspace_for_staging(
        app_cache_dir,
        &workspace,
        &request.run_id,
        &request.owner_token,
    )
    .map_err(unsafe_path)?;
    result.scanned_entries = walker.stats.scanned_entries;
    result.skipped_links = walker.stats.skipped_links;
    Ok(result)
}

#[tauri::command]
pub async fn preview_list_source_tree(
    app_handle: tauri::AppHandle,
    request: PreviewListSourceTreeRequest,
) -> CommandResult<PreviewListSourceTreeResult> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|error| AppError::Generic(io_error(format!("app-data:{error}"))))?;
    tokio::task::spawn_blocking(move || list_source_tree_at(&app_data_dir, request))
        .await
        .map_err(|error| AppError::Generic(io_error(format!("list-task:{error}"))))?
        .map_err(AppError::Generic)
}

#[tauri::command]
pub async fn preview_read_text_file(
    app_handle: tauri::AppHandle,
    request: PreviewReadTextFileRequest,
) -> CommandResult<PreviewReadTextFileResult> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|error| AppError::Generic(io_error(format!("app-data:{error}"))))?;
    tokio::task::spawn_blocking(move || read_text_file_at(&app_data_dir, request))
        .await
        .map_err(|error| AppError::Generic(io_error(format!("read-task:{error}"))))?
        .map_err(AppError::Generic)
}

#[tauri::command]
pub async fn preview_copy_assets(
    app_handle: tauri::AppHandle,
    request: PreviewCopyAssetsRequest,
) -> CommandResult<PreviewCopyAssetsResult> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|error| AppError::Generic(io_error(format!("app-data:{error}"))))?;
    let app_cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|error| AppError::Generic(io_error(format!("app-cache:{error}"))))?;
    tokio::task::spawn_blocking(move || copy_assets_at(&app_data_dir, &app_cache_dir, request))
        .await
        .map_err(|error| AppError::Generic(io_error(format!("copy-task:{error}"))))?
        .map_err(AppError::Generic)
}

#[cfg(test)]
mod tests {
    use super::super::shell::{
        cleanup_preview_workspace_at_cache, create_preview_workspace_at_cache,
        PreviewWorkspaceCreateResult,
    };
    use super::*;

    fn test_root() -> PathBuf {
        std::env::temp_dir().join(format!("agentvis-preview-staging-{}", uuid::Uuid::new_v4()))
    }

    fn source_request(root: &Path) -> PreviewListSourceTreeRequest {
        PreviewListSourceTreeRequest {
            root: root.to_string_lossy().into_owned(),
            current_relative: "app/src".to_string(),
            max_depth: 8,
            max_entries: 100,
            max_files: 20,
            max_file_bytes: 1024,
            max_total_bytes: 4096,
            extensions: vec!["ts".to_string(), "json".to_string()],
            skip_directories: Vec::new(),
        }
    }

    fn asset_copy_request(
        source_root: &Path,
        created: &PreviewWorkspaceCreateResult,
    ) -> PreviewCopyAssetsRequest {
        PreviewCopyAssetsRequest {
            source_root: source_root.to_string_lossy().into_owned(),
            workspace: created.workspace.clone(),
            run_id: created.run_id.clone(),
            owner_token: created.owner_token.clone(),
            destination_prefix: "src".to_string(),
            limits: PreviewTraversalLimits {
                max_depth: 8,
                max_entries: 100,
                max_files: 20,
                max_file_bytes: 1024,
                max_total_bytes: 4096,
            },
            extensions: vec!["png".to_string(), "json".to_string()],
            skip_directories: Vec::new(),
            skip_files: vec!["PrIvAtE.JsOn".to_string()],
        }
    }

    #[test]
    fn list_and_read_are_root_relative_and_bounded() {
        let base = test_root();
        let app_data = base.join("app-data");
        let deliverable = app_data.join("deliverables").join("hub").join("agent");
        std::fs::create_dir_all(deliverable.join("app").join("src")).expect("create source tree");
        std::fs::write(deliverable.join("app").join("package.json"), "{}")
            .expect("write package manifest");
        std::fs::write(deliverable.join("app").join("tsconfig.json"), "{}")
            .expect("write TypeScript config");
        std::fs::write(deliverable.join("app").join(".env.local"), "SECRET=test")
            .expect("write omitted environment fixture");
        std::fs::write(
            deliverable.join("app").join("src").join("main.ts"),
            "export {};",
        )
        .expect("write source file");

        let result = list_source_tree_at(&app_data, source_request(&deliverable))
            .expect("list safe source tree");
        assert_eq!(result.project_root_relative, "app");
        assert!(result.has_package_json);
        assert_eq!(result.omitted_environment_files, 1);
        assert_eq!(result.entries.len(), 2);
        assert!(result
            .entries
            .iter()
            .any(|entry| entry.path == "src/main.ts"));
        assert!(result
            .entries
            .iter()
            .any(|entry| entry.path == "tsconfig.json"));
        assert!(!result
            .entries
            .iter()
            .any(|entry| entry.path == "package.json"));

        let text = read_text_file_at(
            &app_data,
            PreviewReadTextFileRequest {
                root: result.project_root,
                relative_path: "src/main.ts".to_string(),
                max_bytes: 1024,
            },
        )
        .expect("read safe source handle");
        assert_eq!(text.content, "export {};");
        assert!(read_text_file_at(
            &app_data,
            PreviewReadTextFileRequest {
                root: deliverable.to_string_lossy().into_owned(),
                relative_path: "../secret.txt".to_string(),
                max_bytes: 1024,
            },
        )
        .expect_err("parent traversal must be rejected")
        .starts_with("PREVIEW_STAGING_UNSAFE:"));
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn no_package_src_entries_keep_logical_and_physical_paths_distinct() {
        let base = test_root();
        let app_data = base.join("app-data");
        let deliverable = app_data.join("deliverables").join("agent");
        let source = deliverable.join("app").join("src");
        std::fs::create_dir_all(&source).expect("create source tree");
        std::fs::write(source.join("main.ts"), "export {};").expect("write source fixture");

        let result = list_source_tree_at(&app_data, source_request(&deliverable))
            .expect("list source tree without package manifest");
        assert!(!result.has_package_json);
        assert_eq!(result.source_prefix, "src/");
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].path, "src/main.ts");
        assert_eq!(result.entries[0].source_path, "main.ts");

        let text = read_text_file_at(
            &app_data,
            PreviewReadTextFileRequest {
                root: result.project_root,
                relative_path: result.entries[0].source_path.clone(),
                max_bytes: 1024,
            },
        )
        .expect("read physical source path returned by listing");
        assert_eq!(text.path, "main.ts");
        assert_eq!(text.content, "export {};");
        let _ = std::fs::remove_dir_all(base);
    }

    #[cfg(unix)]
    #[test]
    fn source_listing_rejects_nonportable_entry_names() {
        let base = test_root();
        let app_data = base.join("app-data");
        let deliverable = app_data.join("deliverables").join("agent");
        let source = deliverable.join("app").join("src");
        std::fs::create_dir_all(&source).expect("create source tree");
        std::fs::write(source.join("bad:name.ts"), "secret").expect("write invalid fixture");

        let error = list_source_tree_at(&app_data, source_request(&deliverable))
            .expect_err("nonportable source name must be rejected natively");
        assert!(error.starts_with("PREVIEW_STAGING_UNSAFE:relative-path-component:"));
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn source_entry_budget_stops_streaming_enumeration() {
        let base = test_root();
        let app_data = base.join("app-data");
        let deliverable = app_data.join("deliverables").join("agent");
        std::fs::create_dir_all(deliverable.join("app").join("src")).expect("create source tree");
        for index in 0..4 {
            std::fs::write(
                deliverable
                    .join("app")
                    .join("src")
                    .join(format!("{index}.ts")),
                "x",
            )
            .expect("write source fixture");
        }
        let mut request = source_request(&deliverable);
        request.max_entries = 2;
        let error = list_source_tree_at(&app_data, request).expect_err("entry budget");
        assert!(error.starts_with("PREVIEW_STAGING_BUDGET:scanned-entry-count"));
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn copy_assets_enforces_owner_prefix_skip_budget_and_missing_source_contracts() {
        let base = test_root();
        let app_data = base.join("app-data");
        let app_cache = base.join("app-cache");
        let source = app_data
            .join("deliverables")
            .join("agent")
            .join("app")
            .join("src");
        std::fs::create_dir_all(source.join("nested")).expect("create asset source tree");
        std::fs::write(source.join("image.png"), b"PNG").expect("write image fixture");
        std::fs::write(source.join("nested").join("data.json"), b"{}")
            .expect("write nested asset fixture");
        std::fs::write(source.join("PACKAGE.JSON"), b"{}").expect("write package fixture");
        std::fs::write(source.join("PACKAGE-LOCK.JSON"), b"{}")
            .expect("write package lock fixture");
        std::fs::write(source.join("TsConfig.JSON"), b"{}").expect("write tsconfig fixture");
        std::fs::write(source.join("private.JSON"), b"{}").expect("write caller-skipped fixture");
        std::fs::write(source.join(".secret.json"), b"{}").expect("write hidden fixture");

        let run_id = format!("project-preview-{}", uuid::Uuid::new_v4());
        let created = create_preview_workspace_at_cache(&app_cache, &run_id)
            .expect("create owned preview workspace");
        let workspace = PathBuf::from(&created.workspace);

        let mut wrong_owner = asset_copy_request(&source, &created);
        wrong_owner.owner_token = uuid::Uuid::new_v4().to_string();
        let error = copy_assets_at(&app_data, &app_cache, wrong_owner)
            .expect_err("wrong workspace owner must be rejected");
        assert!(error.starts_with("PREVIEW_STAGING_UNSAFE:"));

        let mut invalid_budget = asset_copy_request(&source, &created);
        invalid_budget.limits.max_files = 0;
        let error = copy_assets_at(&app_data, &app_cache, invalid_budget)
            .expect_err("zero asset budget must be rejected");
        assert!(error.starts_with("PREVIEW_STAGING_BUDGET:max-files"));

        let result = copy_assets_at(&app_data, &app_cache, asset_copy_request(&source, &created))
            .expect("copy bounded assets into owned workspace");
        assert_eq!(result.copied_files, 2);
        assert_eq!(result.copied_bytes, 5);
        assert_eq!(
            std::fs::read(workspace.join("src").join("image.png")).unwrap(),
            b"PNG"
        );
        assert_eq!(
            std::fs::read(workspace.join("src").join("nested").join("data.json")).unwrap(),
            b"{}"
        );
        assert!(!workspace.join("image.png").exists());
        for skipped in [
            "PACKAGE.JSON",
            "PACKAGE-LOCK.JSON",
            "TsConfig.JSON",
            "private.JSON",
            ".secret.json",
        ] {
            assert!(
                !workspace.join("src").join(skipped).exists(),
                "copied {skipped}"
            );
        }

        let missing_source = source.with_file_name("missing-source");
        let missing = copy_assets_at(
            &app_data,
            &app_cache,
            asset_copy_request(&missing_source, &created),
        )
        .expect("missing asset source is an empty copy");
        assert_eq!(missing.copied_files, 0);
        assert_eq!(missing.copied_bytes, 0);
        assert_eq!(missing.scanned_entries, 0);
        assert_eq!(missing.skipped_links, 0);
        assert_eq!(missing.skipped_existing, 0);

        let cleanup = cleanup_preview_workspace_at_cache(
            &app_cache,
            &workspace,
            &created.run_id,
            &created.owner_token,
            None,
        )
        .expect("cleanup owned preview workspace");
        assert_eq!(cleanup.status, "removed");
        assert!(!workspace.exists());
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn handle_containment_accepts_descendants_and_rejects_siblings() {
        let base = test_root();
        let root = base.join("root");
        let outside = base.join("outside");
        std::fs::create_dir_all(&root).expect("create containment root");
        std::fs::create_dir_all(&outside).expect("create outside directory");
        let inside_path = root.join("inside.txt");
        let outside_path = outside.join("outside.txt");
        std::fs::write(&inside_path, "inside").expect("write inside fixture");
        std::fs::write(&outside_path, "outside").expect("write outside fixture");

        let root_guard = DirectoryGuard::open(&root).expect("open containment root");
        let containment =
            HandleContainment::from_handle(&root_guard.handle, &root_guard.path, "test-root")
                .expect("resolve containment root handle");
        let (inside, _, _) =
            open_regular_file_no_follow(&inside_path).expect("open inside fixture");
        containment
            .verify(&inside, &inside_path, "inside")
            .expect("inside handle remains contained");
        let (outside, _, _) =
            open_regular_file_no_follow(&outside_path).expect("open outside fixture");
        let error = containment
            .verify(&outside, &outside_path, "outside")
            .expect_err("sibling handle must not be contained");
        assert!(error.starts_with("PREVIEW_STAGING_UNSAFE:outside-outside-root"));

        drop(outside);
        drop(inside);
        drop(root_guard);
        let _ = std::fs::remove_dir_all(base);
    }

    #[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
    #[test]
    fn unix_dirfd_target_stays_bound_when_lexical_parent_is_replaced() {
        let base = test_root();
        let workspace = base.join("workspace");
        let lexical_parent = workspace.join("assets");
        let held_parent = workspace.join("assets-held");
        std::fs::create_dir_all(&lexical_parent).expect("create target parent");
        let source_path = base.join("source.bin");
        std::fs::write(&source_path, b"fixture").expect("write source fixture");

        let workspace_guard = DirectoryGuard::open(&workspace).expect("open workspace guard");
        let containment = HandleContainment::from_handle(
            &workspace_guard.handle,
            &workspace_guard.path,
            "test-workspace",
        )
        .expect("resolve workspace containment");
        let (target_path, target_name, parent_guards) = ensure_destination_parent(
            &workspace,
            &workspace_guard,
            &containment,
            "assets/bound.bin",
        )
        .expect("hold destination parent dirfd");
        let parent = &parent_guards.last().expect("asset parent guard").handle;

        std::fs::rename(&lexical_parent, &held_parent).expect("rename held target parent");
        std::fs::create_dir(&lexical_parent).expect("create lexical replacement parent");

        let DestinationTarget::Created { file, identity } =
            open_destination_target(parent, &target_name, &target_path, &containment)
                .expect("create target relative to held dirfd")
        else {
            panic!("fresh dirfd target unexpectedly existed");
        };
        let mut source = File::open(&source_path).expect("open source fixture");
        copy_source_handle(
            &mut source,
            7,
            &target_path,
            &containment,
            parent,
            &target_name,
            file,
            identity,
        )
        .expect("copy remains bound to held parent");
        assert_eq!(
            std::fs::read(held_parent.join("bound.bin")).expect("read bound target"),
            b"fixture"
        );
        assert!(!lexical_parent.join("bound.bin").exists());
        assert!(matches!(
            open_destination_target(parent, &target_name, &target_path, &containment)
                .expect("inspect EEXIST relative to held parent"),
            DestinationTarget::Existing
        ));

        std::os::unix::fs::symlink(&source_path, held_parent.join("linked.bin"))
            .expect("create target symlink fixture");
        let error = open_destination_target(
            parent,
            "linked.bin",
            &lexical_parent.join("linked.bin"),
            &containment,
        )
        .expect_err("EEXIST symlink must be rejected without following");
        assert!(error.starts_with("PREVIEW_STAGING_UNSAFE:target-existing-unsafe:"));

        std::fs::hard_link(&source_path, held_parent.join("hard-linked.bin"))
            .expect("create target hardlink fixture");
        let error = open_destination_target(
            parent,
            "hard-linked.bin",
            &lexical_parent.join("hard-linked.bin"),
            &containment,
        )
        .expect_err("EEXIST hardlink must be rejected");
        assert!(error.starts_with("PREVIEW_STAGING_UNSAFE:target-hard-link:"));

        let failed_name = "failed.bin";
        let failed_path = lexical_parent.join(failed_name);
        let DestinationTarget::Created { file, identity } =
            open_destination_target(parent, failed_name, &failed_path, &containment)
                .expect("create failure target relative to held dirfd")
        else {
            panic!("fresh failure target unexpectedly existed");
        };
        let mut source = File::open(&source_path).expect("reopen source fixture");
        let error = copy_source_handle(
            &mut source,
            0,
            &failed_path,
            &containment,
            parent,
            failed_name,
            file,
            identity,
        )
        .expect_err("size mismatch must fail without path cleanup");
        assert!(error.starts_with("PREVIEW_STAGING_UNSAFE:asset-grew-during-copy"));
        assert_eq!(
            std::fs::metadata(held_parent.join(failed_name))
                .expect("partial target remains in held owned parent")
                .len(),
            0
        );
        assert!(!lexical_parent.join(failed_name).exists());

        drop(parent_guards);
        drop(workspace_guard);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn source_hard_link_to_outside_fixture_is_rejected() {
        let base = test_root();
        let app_data = base.join("app-data");
        let deliverable = app_data.join("deliverables").join("agent");
        let source = deliverable.join("app").join("src");
        std::fs::create_dir_all(&source).expect("create source tree");
        let outside = base.join("outside.ts");
        std::fs::write(&outside, "secret").expect("write outside fixture");
        std::fs::hard_link(&outside, source.join("leak.ts")).expect("create hard link fixture");

        let error = list_source_tree_at(&app_data, source_request(&deliverable))
            .expect_err("hard-linked source file must be rejected");
        assert!(error.starts_with("PREVIEW_STAGING_UNSAFE:file-hard-link:"));
        let _ = std::fs::remove_dir_all(base);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn asset_mode_allows_hard_links_contained_in_the_agent_workspace() {
        let base = test_root();
        let app_data = base.join("app-data");
        let agent_workspace = app_data.join("deliverables").join("hub").join("agent");
        let project = agent_workspace.join("project");
        std::fs::create_dir_all(&project).expect("create project tree");
        let shared_asset = agent_workspace.join("shared.jpeg");
        std::fs::write(&shared_asset, b"shared-image").expect("write shared asset");
        std::fs::hard_link(&shared_asset, project.join("hero.jpeg"))
            .expect("create workspace hard link");
        let source = resolve_source_root(&app_data, &project)
            .expect("resolve source root")
            .expect("source root exists");
        let mut walker = SourceWalker {
            limits: PreviewTraversalLimits {
                max_depth: 4,
                max_entries: 20,
                max_files: 10,
                max_file_bytes: 1024,
                max_total_bytes: 4096,
            },
            extensions: HashSet::from(["jpeg".to_string()]),
            skip_directories: HashSet::new(),
            skip_files: HashSet::new(),
            skip_root_files: HashSet::new(),
            skip_hidden_files: true,
            allow_workspace_asset_hard_links: true,
            stats: WalkStats::default(),
        };
        let mut entries = Vec::new();

        walker
            .walk(&source, &source.root, "", &mut |relative, _, _, _| {
                entries.push(relative.to_string());
                Ok(())
            })
            .expect("workspace-contained hard link should be readable for asset copy");

        assert_eq!(entries, vec!["hero.jpeg"]);
        drop(source);
        let _ = std::fs::remove_dir_all(base);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn asset_mode_rejects_a_hard_link_outside_the_agent_workspace() {
        let base = test_root();
        let app_data = base.join("app-data");
        let project = app_data
            .join("deliverables")
            .join("hub")
            .join("agent")
            .join("project");
        std::fs::create_dir_all(&project).expect("create project tree");
        let outside = base.join("outside.jpeg");
        std::fs::write(&outside, b"outside-image").expect("write outside asset");
        std::fs::hard_link(&outside, project.join("hero.jpeg")).expect("create outside hard link");
        let source = resolve_source_root(&app_data, &project)
            .expect("resolve source root")
            .expect("source root exists");
        let mut walker = SourceWalker {
            limits: PreviewTraversalLimits {
                max_depth: 4,
                max_entries: 20,
                max_files: 10,
                max_file_bytes: 1024,
                max_total_bytes: 4096,
            },
            extensions: HashSet::from(["jpeg".to_string()]),
            skip_directories: HashSet::new(),
            skip_files: HashSet::new(),
            skip_root_files: HashSet::new(),
            skip_hidden_files: true,
            allow_workspace_asset_hard_links: true,
            stats: WalkStats::default(),
        };

        let error = walker
            .walk(&source, &source.root, "", &mut |_, _, _, _| Ok(()))
            .expect_err("hard link outside the agent workspace must remain blocked");

        assert!(error.starts_with("PREVIEW_STAGING_UNSAFE:file-hard-link-outside-workspace:"));
        drop(source);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn asset_mode_skips_hidden_files_without_changing_source_mode() {
        let base = test_root();
        let app_data = base.join("app-data");
        let deliverable = app_data.join("deliverables").join("agent");
        std::fs::create_dir_all(&deliverable).expect("create source root");
        std::fs::write(deliverable.join("visible.json"), "{}").expect("write visible fixture");
        std::fs::write(deliverable.join(".secret.json"), "{}").expect("write hidden fixture");
        let source = resolve_source_root(&app_data, &deliverable)
            .expect("resolve source root")
            .expect("source root exists");

        let make_walker = |skip_hidden_files| SourceWalker {
            limits: PreviewTraversalLimits {
                max_depth: 4,
                max_entries: 20,
                max_files: 10,
                max_file_bytes: 1024,
                max_total_bytes: 4096,
            },
            extensions: HashSet::from(["json".to_string()]),
            skip_directories: HashSet::new(),
            skip_files: HashSet::new(),
            skip_root_files: HashSet::new(),
            skip_hidden_files,
            allow_workspace_asset_hard_links: false,
            stats: WalkStats::default(),
        };

        let mut asset_entries = Vec::new();
        let mut asset_walker = make_walker(true);
        asset_walker
            .walk(&source, &source.root, "", &mut |relative, _, _, _| {
                asset_entries.push(relative.to_string());
                Ok(())
            })
            .expect("walk asset-mode tree");
        assert_eq!(asset_entries, vec!["visible.json"]);

        let mut source_entries = Vec::new();
        let mut source_walker = make_walker(false);
        source_walker
            .walk(&source, &source.root, "", &mut |relative, _, _, _| {
                source_entries.push(relative.to_string());
                Ok(())
            })
            .expect("walk source-mode tree");
        source_entries.sort();
        assert_eq!(source_entries, vec![".secret.json", "visible.json"]);

        drop(source);
        let _ = std::fs::remove_dir_all(base);
    }

    #[cfg(any(target_os = "linux", target_os = "android"))]
    #[test]
    fn moved_open_handle_is_rejected_by_original_containment_root() {
        let base = test_root();
        let root = base.join("root");
        let moved = base.join("moved");
        std::fs::create_dir_all(&root).expect("create containment root");
        let file_path = root.join("file.txt");
        std::fs::write(&file_path, "fixture").expect("write fixture");
        let root_guard = DirectoryGuard::open(&root).expect("open root handle");
        let containment =
            HandleContainment::from_handle(&root_guard.handle, &root_guard.path, "test-root")
                .expect("resolve root handle");
        let (file, _, _) = open_regular_file_no_follow(&file_path).expect("open file handle");

        std::fs::rename(&root, &moved).expect("move open directory");
        let error = containment
            .verify(&file, &file_path, "moved-file")
            .expect_err("moved handle must leave its original root");
        assert!(error.starts_with("PREVIEW_STAGING_UNSAFE:moved-file-outside-root"));

        drop(file);
        drop(root_guard);
        let _ = std::fs::remove_dir_all(base);
    }

    #[cfg(unix)]
    #[test]
    fn unix_source_symlink_is_skipped_and_text_symlink_is_rejected() {
        use std::os::unix::fs::symlink;
        let base = test_root();
        let app_data = base.join("app-data");
        let deliverable = app_data.join("deliverables").join("agent");
        let outside = base.join("outside.ts");
        std::fs::create_dir_all(deliverable.join("app").join("src")).expect("create source tree");
        std::fs::write(&outside, "secret").expect("write outside fixture");
        symlink(
            &outside,
            deliverable.join("app").join("src").join("link.ts"),
        )
        .expect("create source symlink");
        let result =
            list_source_tree_at(&app_data, source_request(&deliverable)).expect("list skips link");
        assert_eq!(result.skipped_links, 1);
        let error = read_text_file_at(
            &app_data,
            PreviewReadTextFileRequest {
                root: deliverable.join("app").to_string_lossy().into_owned(),
                relative_path: "src/link.ts".to_string(),
                max_bytes: 1024,
            },
        )
        .expect_err("text symlink must be rejected");
        assert!(error.starts_with("PREVIEW_STAGING_UNSAFE:"));
        let _ = std::fs::remove_dir_all(base);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_source_junction_is_skipped_without_enumerating_target() {
        let base = test_root();
        let app_data = base.join("app-data");
        let deliverable = app_data.join("deliverables").join("agent");
        let source = deliverable.join("app").join("src");
        let outside = base.join("outside");
        std::fs::create_dir_all(&source).expect("create source tree");
        std::fs::create_dir_all(&outside).expect("create junction target");
        std::fs::write(outside.join("secret.ts"), "secret").expect("write outside fixture");
        let junction = source.join("linked");
        let output = std::process::Command::new("cmd")
            .args([
                "/C",
                "mklink",
                "/J",
                junction.to_string_lossy().as_ref(),
                outside.to_string_lossy().as_ref(),
            ])
            .output()
            .expect("create junction fixture");
        assert!(
            output.status.success(),
            "mklink failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let result = list_source_tree_at(&app_data, source_request(&deliverable))
            .expect("list skips junction");
        assert_eq!(result.skipped_links, 1);
        assert!(!result
            .entries
            .iter()
            .any(|entry| entry.path.contains("secret")));
        let _ = std::fs::remove_dir_all(base);
    }
}
