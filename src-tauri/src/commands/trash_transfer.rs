//! TrashBin 可恢复文件传输组件。
//!
//! 该模块只处理同卷 no-replace rename、跨卷复制/校验、短生命周期源端 claim，
//! 以及恢复时的目标卷 staging。命令识别、授权判断和 manifest 状态机仍由
//! `trash_bin` 模块负责。

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Component, Path, PathBuf};

const CANDIDATE_NAME: &str = "candidate";
const CLAIM_PREFIX: &str = ".agentvis-trash-claim-";
const RESTORE_PREFIX: &str = ".agentvis-trash-restore-";
const RESTORE_MARKER_NAME: &str = ".agentvis-restore-owner";
const RESTORE_PAYLOAD_NAME: &str = "payload";
const COPY_BUFFER_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DirectMoveOutcome {
    Renamed,
    CrossVolume,
}

#[derive(Debug)]
pub(crate) enum TransferError {
    Io {
        operation: &'static str,
        source: io::Error,
    },
    Collision(&'static str),
    Unsupported(&'static str),
    Verification(&'static str),
}

impl TransferError {
    fn io(operation: &'static str, source: io::Error) -> Self {
        Self::Io { operation, source }
    }

    pub(crate) fn is_destination_collision(&self) -> bool {
        matches!(self, Self::Collision(_))
    }
}

impl fmt::Display for TransferError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io { operation, source } => write!(formatter, "{operation}: {source}"),
            Self::Collision(reason) => {
                write!(formatter, "transfer destination collision: {reason}")
            }
            Self::Unsupported(reason) => write!(formatter, "unsupported transfer object: {reason}"),
            Self::Verification(reason) => {
                write!(formatter, "transfer verification failed: {reason}")
            }
        }
    }
}

impl std::error::Error for TransferError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::Collision(_) | Self::Unsupported(_) | Self::Verification(_) => None,
        }
    }
}

pub(crate) fn try_direct_move(
    source: &Path,
    destination: &Path,
) -> Result<DirectMoveOutcome, TransferError> {
    match rename_no_replace(source, destination) {
        Ok(()) => Ok(DirectMoveOutcome::Renamed),
        Err(error) if is_cross_volume_error(&error) => Ok(DirectMoveOutcome::CrossVolume),
        Err(error) => Err(TransferError::io("no-replace rename failed", error)),
    }
}

pub(crate) fn candidate_path(payload: &Path) -> Result<PathBuf, TransferError> {
    let parent = payload
        .parent()
        .ok_or(TransferError::Unsupported("payload has no storage parent"))?;
    Ok(parent.join(CANDIDATE_NAME))
}

pub(crate) fn claim_path(source: &Path, storage_id: &str) -> Result<PathBuf, TransferError> {
    validate_storage_id(storage_id)?;
    let parent = source.parent().ok_or(TransferError::Unsupported(
        "source has no parent for a sibling claim",
    ))?;
    Ok(parent.join(format!("{CLAIM_PREFIX}{storage_id}")))
}

pub(crate) fn is_internal_transfer_path(path: &Path) -> bool {
    path.components().any(|component| {
        let Component::Normal(name) = component else {
            return false;
        };
        has_reserved_prefix(name, CLAIM_PREFIX) || has_reserved_prefix(name, RESTORE_PREFIX)
    })
}

fn is_internal_transfer_name(name: &OsStr) -> bool {
    has_reserved_prefix(name, CLAIM_PREFIX) || has_reserved_prefix(name, RESTORE_PREFIX)
}

fn has_reserved_prefix(name: &OsStr, prefix: &str) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    let Some(candidate) = name.get(..prefix.len()) else {
        return false;
    };
    #[cfg(windows)]
    return candidate.eq_ignore_ascii_case(prefix);
    #[cfg(not(windows))]
    return candidate == prefix;
}

pub(crate) fn copy_source_to_candidate(
    source: &Path,
    payload: &Path,
) -> Result<PathBuf, TransferError> {
    let candidate = candidate_path(payload)?;
    copy_item_verified_to_new(source, &candidate)?;
    Ok(candidate)
}

pub(crate) fn refresh_candidate_from_source(
    source: &Path,
    candidate: &Path,
) -> Result<(), TransferError> {
    remove_candidate_if_present(candidate)?;
    copy_item_verified_to_new(source, candidate)
}

pub(crate) fn items_match(left: &Path, right: &Path) -> Result<bool, TransferError> {
    compare_items(left, right)
}

pub(crate) fn claim_source(source: &Path, storage_id: &str) -> Result<PathBuf, TransferError> {
    let claim = claim_path(source, storage_id)?;
    rename_no_replace(source, &claim)
        .map_err(|error| TransferError::io("source claim rename failed", error))?;
    set_hidden_best_effort(&claim);
    sync_parent_best_effort(&claim);
    Ok(claim)
}

pub(crate) fn publish_candidate(candidate: &Path, payload: &Path) -> Result<(), TransferError> {
    rename_no_replace(candidate, payload)
        .map_err(|error| TransferError::io("candidate publish rename failed", error))?;
    sync_parent(payload).map_err(|error| TransferError::io("payload parent sync failed", error))
}

pub(crate) fn verify_claim_payload(claim: &Path, payload: &Path) -> Result<(), TransferError> {
    if !items_match(claim, payload)? {
        return Err(TransferError::Verification(
            "claim changed after the payload was published",
        ));
    }
    Ok(())
}

/// Continue cleanup only after the manifest has durably recorded that the final payload was
/// verified. A directory claim may already be partially removed after a crash, so this step is
/// intentionally idempotent and does not require the remaining claim to equal the full payload.
pub(crate) fn finish_verified_claim_cleanup(claim: &Path) -> Result<(), TransferError> {
    remove_claim(claim)
}

fn remove_claim(claim: &Path) -> Result<(), TransferError> {
    if !is_claim_path(claim) {
        return Err(TransferError::Unsupported(
            "refused to remove a path without the TrashBin claim prefix",
        ));
    }
    remove_item_no_follow(claim)?;
    sync_parent_best_effort(claim);
    Ok(())
}

pub(crate) fn remove_candidate_if_present(candidate: &Path) -> Result<(), TransferError> {
    if candidate.file_name() != Some(OsStr::new(CANDIDATE_NAME)) {
        return Err(TransferError::Unsupported(
            "refused to remove a non-candidate path",
        ));
    }
    match fs::symlink_metadata(candidate) {
        Ok(_) => remove_item_no_follow(candidate),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(TransferError::io("candidate inspection failed", error)),
    }
}

pub(crate) fn restore_staging_path(
    destination: &Path,
    restore_id: &str,
) -> Result<PathBuf, TransferError> {
    validate_storage_id(restore_id)?;
    let destination_parent = destination.parent().ok_or(TransferError::Unsupported(
        "restore destination has no parent",
    ))?;
    Ok(destination_parent.join(format!("{RESTORE_PREFIX}{restore_id}")))
}

pub(crate) fn commit_restore(
    source: &Path,
    destination: &Path,
    restore_id: &str,
    owner_token: &str,
) -> Result<(), TransferError> {
    commit_restore_inner(source, destination, restore_id, owner_token, false)
}

fn commit_restore_inner(
    source: &Path,
    destination: &Path,
    restore_id: &str,
    owner_token: &str,
    force_copy: bool,
) -> Result<(), TransferError> {
    validate_storage_id(owner_token)?;
    let destination_parent = destination.parent().ok_or(TransferError::Unsupported(
        "restore destination has no parent",
    ))?;
    fs::create_dir_all(destination_parent)
        .map_err(|error| TransferError::io("restore parent creation failed", error))?;

    if !force_copy {
        match try_direct_move(source, destination)? {
            DirectMoveOutcome::Renamed => return Ok(()),
            DirectMoveOutcome::CrossVolume => {}
        }
    }

    let wrapper = create_restore_staging(destination, restore_id, owner_token)?;
    let staged = wrapper.join(RESTORE_PAYLOAD_NAME);

    if let Err(error) = copy_item_verified_to_new(source, &staged) {
        let _ = discard_restore_staging(destination, restore_id, owner_token);
        return Err(error);
    }
    if let Err(error) = rename_no_replace(&staged, destination) {
        let _ = discard_restore_staging(destination, restore_id, owner_token);
        return Err(TransferError::io("restore commit rename failed", error));
    }
    sync_parent_best_effort(destination);
    Ok(())
}

/// 验证已提交目标与中央 payload 一致。同卷 rename 后中央 payload 已不存在，目标存在
/// 即表示命名空间提交完成。
pub(crate) fn verify_restore_commit(
    source: &Path,
    destination: &Path,
) -> Result<(), TransferError> {
    match fs::symlink_metadata(source) {
        Ok(_) => {
            if !items_match(source, destination)? {
                return Err(TransferError::Verification(
                    "restored destination differs from the central payload",
                ));
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::symlink_metadata(destination).map_err(|error| {
                TransferError::io("restored destination inspection failed", error)
            })?;
        }
        Err(error) => return Err(TransferError::io("restore source inspection failed", error)),
    }
    Ok(())
}

/// 完成已经验证且持久化为 Committed 的恢复事务。
///
/// `Committed` 本身是目标曾与完整中央 payload 一致的持久化证据；清理可能分多次完成，
/// 因此这里不能再要求一个已经部分清理的 payload 与目标重新完全匹配。
pub(crate) fn finish_committed_restore(
    source: &Path,
    destination: &Path,
    restore_id: &str,
    owner_token: &str,
) -> Result<(), TransferError> {
    let source_exists = path_exists(source)?;
    discard_restore_staging_inner(destination, restore_id, owner_token, source_exists)?;
    if source_exists {
        match fs::symlink_metadata(source) {
            Ok(_) => {
                remove_item_no_follow(source)?;
                sync_parent_best_effort(source);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(TransferError::io("restore source inspection failed", error));
            }
        }
    }
    Ok(())
}

pub(crate) fn discard_restore_staging(
    destination: &Path,
    restore_id: &str,
    owner_token: &str,
) -> Result<(), TransferError> {
    discard_restore_staging_inner(destination, restore_id, owner_token, false)
}

fn discard_restore_staging_inner(
    destination: &Path,
    restore_id: &str,
    owner_token: &str,
    allow_committed_empty_residue: bool,
) -> Result<(), TransferError> {
    let wrapper = restore_staging_path(destination, restore_id)?;
    match restore_staging_is_owned(destination, restore_id, owner_token)? {
        true => {
            remove_owned_restore_staging(&wrapper, owner_token)?;
            sync_parent_best_effort(&wrapper);
            Ok(())
        }
        false if !path_exists(&wrapper)? => Ok(()),
        false if allow_committed_empty_residue => {
            remove_empty_restore_staging_residue(&wrapper)?;
            sync_parent_best_effort(&wrapper);
            Ok(())
        }
        false => Err(TransferError::Verification(
            "restore staging ownership marker is missing or differs",
        )),
    }
}

fn remove_owned_restore_staging(wrapper: &Path, owner_token: &str) -> Result<(), TransferError> {
    let marker = wrapper.join(RESTORE_MARKER_NAME);
    for entry in fs::read_dir(wrapper)
        .map_err(|error| TransferError::io("restore staging enumeration failed", error))?
    {
        let entry = entry
            .map_err(|error| TransferError::io("restore staging entry inspection failed", error))?;
        if entry.file_name() == OsStr::new(RESTORE_MARKER_NAME) {
            continue;
        }
        remove_item_no_follow(&entry.path())?;
    }

    // Keep the ownership proof until every other child is gone. If payload cleanup is interrupted,
    // the next reconciliation pass can still prove ownership and continue safely.
    verify_restore_owner_marker(wrapper, owner_token)?;
    let marker_metadata = fs::symlink_metadata(&marker)
        .map_err(|error| TransferError::io("restore owner marker inspection failed", error))?;
    make_removable(&marker, &marker_metadata);
    fs::remove_file(&marker)
        .map_err(|error| TransferError::io("restore owner marker cleanup failed", error))?;

    let wrapper_metadata = inspect_supported_directory(wrapper)?;
    make_removable(wrapper, &wrapper_metadata);
    fs::remove_dir(wrapper)
        .map_err(|error| TransferError::io("restore staging directory cleanup failed", error))
}

fn remove_empty_restore_staging_residue(wrapper: &Path) -> Result<(), TransferError> {
    let metadata = fs::symlink_metadata(wrapper)
        .map_err(|error| TransferError::io("restore staging residue inspection failed", error))?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata_is_reparse_point(&metadata)
    {
        return Err(TransferError::Verification(
            "markerless restore staging residue is not an ordinary directory",
        ));
    }

    let mut entries = fs::read_dir(wrapper)
        .map_err(|error| TransferError::io("restore staging residue enumeration failed", error))?;
    match entries.next() {
        Some(Ok(_)) => {
            return Err(TransferError::Verification(
                "markerless restore staging residue is not empty",
            ));
        }
        Some(Err(error)) => {
            return Err(TransferError::io(
                "restore staging residue entry inspection failed",
                error,
            ));
        }
        None => {}
    }
    drop(entries);

    make_removable(wrapper, &metadata);
    fs::remove_dir(wrapper)
        .map_err(|error| TransferError::io("empty restore staging residue cleanup failed", error))
}

pub(crate) fn restore_staging_is_owned(
    destination: &Path,
    restore_id: &str,
    owner_token: &str,
) -> Result<bool, TransferError> {
    validate_storage_id(owner_token)?;
    let wrapper = restore_staging_path(destination, restore_id)?;
    let metadata = match fs::symlink_metadata(&wrapper) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(TransferError::io(
                "restore staging inspection failed",
                error,
            ));
        }
    };
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata_is_reparse_point(&metadata)
    {
        return Ok(false);
    }

    let marker = wrapper.join(RESTORE_MARKER_NAME);
    match fs::symlink_metadata(&marker) {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(TransferError::io(
                "restore owner marker inspection failed",
                error,
            ));
        }
    }
    match verify_restore_owner_marker(&wrapper, owner_token) {
        Ok(()) => Ok(true),
        Err(TransferError::Verification(_) | TransferError::Unsupported(_)) => Ok(false),
        Err(error) => Err(error),
    }
}

fn path_exists(path: &Path) -> Result<bool, TransferError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(TransferError::io(
            "filesystem object inspection failed",
            error,
        )),
    }
}

fn create_restore_staging(
    destination: &Path,
    restore_id: &str,
    owner_token: &str,
) -> Result<PathBuf, TransferError> {
    let wrapper = restore_staging_path(destination, restore_id)?;
    match fs::create_dir(&wrapper) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            return Err(TransferError::Collision(
                "restore staging directory already exists",
            ));
        }
        Err(error) => {
            return Err(TransferError::io(
                "restore staging directory creation failed",
                error,
            ));
        }
    }

    let marker = wrapper.join(RESTORE_MARKER_NAME);
    let marker_result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&marker)
            .map_err(|error| TransferError::io("restore owner marker creation failed", error))?;
        file.write_all(owner_token.as_bytes())
            .map_err(|error| TransferError::io("restore owner marker write failed", error))?;
        file.sync_all()
            .map_err(|error| TransferError::io("restore owner marker sync failed", error))?;
        sync_directory(&wrapper)
            .map_err(|error| TransferError::io("restore staging directory sync failed", error))?;
        Ok(())
    })();
    if let Err(error) = marker_result {
        let _ = fs::remove_file(&marker);
        let _ = fs::remove_dir(&wrapper);
        return Err(error);
    }
    set_hidden_best_effort(&wrapper);
    Ok(wrapper)
}

fn verify_restore_owner_marker(wrapper: &Path, owner_token: &str) -> Result<(), TransferError> {
    let marker = wrapper.join(RESTORE_MARKER_NAME);
    let (file, metadata) =
        open_regular_file_no_follow(&marker, "restore owner marker open failed")?;
    if metadata.len() != owner_token.len() as u64 {
        return Err(TransferError::Verification(
            "restore staging owner marker length differs",
        ));
    }
    let mut content = String::new();
    file.take(128)
        .read_to_string(&mut content)
        .map_err(|error| TransferError::io("restore owner marker read failed", error))?;
    if content != owner_token {
        return Err(TransferError::Verification(
            "restore staging owner marker differs",
        ));
    }
    Ok(())
}

fn validate_storage_id(storage_id: &str) -> Result<(), TransferError> {
    let parsed = uuid::Uuid::parse_str(storage_id)
        .map_err(|_| TransferError::Unsupported("invalid storage identifier"))?;
    if parsed.to_string() != storage_id {
        return Err(TransferError::Unsupported(
            "non-canonical storage identifier",
        ));
    }
    Ok(())
}

fn is_claim_path(path: &Path) -> bool {
    path.file_name()
        .and_then(OsStr::to_str)
        .is_some_and(|name| {
            name.strip_prefix(CLAIM_PREFIX)
                .is_some_and(|id| validate_storage_id(id).is_ok())
        })
}

fn copy_item_verified_to_new(source: &Path, destination: &Path) -> Result<(), TransferError> {
    match fs::symlink_metadata(destination) {
        Ok(_) => {
            return Err(TransferError::Collision("copy destination already exists"));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(TransferError::io(
                "copy destination inspection failed",
                error,
            ));
        }
    }

    let mut destination_owned = false;
    if let Err(error) = copy_item_to_new(source, destination, &mut destination_owned) {
        if destination_owned {
            let _ = remove_item_no_follow(destination);
        } else if matches!(
            &error,
            TransferError::Io { source, .. } if source.kind() == io::ErrorKind::AlreadyExists
        ) {
            return Err(TransferError::Collision(
                "copy destination appeared before ownership was established",
            ));
        }
        return Err(error);
    }

    match compare_items(source, destination) {
        Ok(true) => Ok(()),
        Ok(false) => {
            let _ = remove_item_no_follow(destination);
            Err(TransferError::Verification("source and copied tree differ"))
        }
        Err(error) => {
            let _ = remove_item_no_follow(destination);
            Err(error)
        }
    }
}

fn copy_item_to_new(
    source: &Path,
    destination: &Path,
    destination_owned: &mut bool,
) -> Result<(), TransferError> {
    let metadata = inspect_supported_item(source)?;
    if metadata.is_file() {
        return copy_file_to_new(source, destination, destination_owned);
    }
    if !metadata.is_dir() {
        return Err(TransferError::Unsupported(
            "only regular files and directories are supported",
        ));
    }

    fs::create_dir(destination)
        .map_err(|error| TransferError::io("destination directory creation failed", error))?;
    *destination_owned = true;
    let mut pending = vec![(source.to_path_buf(), destination.to_path_buf())];
    let mut directory_permissions = vec![(destination.to_path_buf(), metadata.permissions())];

    while let Some((source_dir, destination_dir)) = pending.pop() {
        inspect_supported_directory(&source_dir)?;
        let entries = fs::read_dir(&source_dir)
            .map_err(|error| TransferError::io("source directory enumeration failed", error))?;
        for entry in entries {
            let entry =
                entry.map_err(|error| TransferError::io("source directory entry failed", error))?;
            let source_child = entry.path();
            if is_internal_transfer_name(&entry.file_name()) {
                return Err(TransferError::Unsupported(
                    "a reserved TrashBin transaction path is inside the source tree",
                ));
            }
            let destination_child = destination_dir.join(entry.file_name());
            let child_metadata = inspect_supported_item(&source_child)?;
            if child_metadata.is_file() {
                copy_file_to_new(&source_child, &destination_child, destination_owned)?;
            } else if child_metadata.is_dir() {
                fs::create_dir(&destination_child).map_err(|error| {
                    TransferError::io("destination directory creation failed", error)
                })?;
                directory_permissions
                    .push((destination_child.clone(), child_metadata.permissions()));
                pending.push((source_child, destination_child));
            } else {
                return Err(TransferError::Unsupported(
                    "a special filesystem object is inside the source tree",
                ));
            }
        }
        inspect_supported_directory(&source_dir)?;
    }

    for (directory, permissions) in directory_permissions.into_iter().rev() {
        fs::set_permissions(&directory, permissions)
            .map_err(|error| TransferError::io("directory permission copy failed", error))?;
        sync_directory(&directory)
            .map_err(|error| TransferError::io("destination directory sync failed", error))?;
    }
    Ok(())
}

fn copy_file_to_new(
    source: &Path,
    destination: &Path,
    destination_owned: &mut bool,
) -> Result<(), TransferError> {
    let (source_file, source_metadata) =
        open_regular_file_no_follow(source, "source file open failed")?;
    let destination_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| TransferError::io("destination file creation failed", error))?;
    *destination_owned = true;
    let mut reader = BufReader::with_capacity(COPY_BUFFER_BYTES, source_file);
    let mut writer = BufWriter::with_capacity(COPY_BUFFER_BYTES, destination_file);
    io::copy(&mut reader, &mut writer)
        .map_err(|error| TransferError::io("file content copy failed", error))?;
    writer
        .flush()
        .map_err(|error| TransferError::io("copied file flush failed", error))?;
    writer
        .get_ref()
        .sync_all()
        .map_err(|error| TransferError::io("copied file sync failed", error))?;
    fs::set_permissions(destination, source_metadata.permissions())
        .map_err(|error| TransferError::io("file permission copy failed", error))?;
    Ok(())
}

fn compare_items(left: &Path, right: &Path) -> Result<bool, TransferError> {
    let left_metadata = inspect_supported_item(left)?;
    let right_metadata = inspect_supported_item(right)?;
    if left_metadata.is_file() != right_metadata.is_file()
        || left_metadata.is_dir() != right_metadata.is_dir()
    {
        return Ok(false);
    }
    if left_metadata.is_file() {
        return compare_files(left, right);
    }

    let mut pending = vec![(left.to_path_buf(), right.to_path_buf())];
    while let Some((left_dir, right_dir)) = pending.pop() {
        let left_entries = directory_entries(&left_dir)?;
        let right_entries = directory_entries(&right_dir)?;
        if left_entries.keys().ne(right_entries.keys()) {
            return Ok(false);
        }
        for (name, left_path) in left_entries {
            let Some(right_path) = right_entries.get(&name) else {
                return Ok(false);
            };
            let left_child = inspect_supported_item(&left_path)?;
            let right_child = inspect_supported_item(right_path)?;
            if left_child.is_file() != right_child.is_file()
                || left_child.is_dir() != right_child.is_dir()
            {
                return Ok(false);
            }
            if left_child.is_file() {
                if !compare_files(&left_path, right_path)? {
                    return Ok(false);
                }
            } else if left_child.is_dir() {
                pending.push((left_path, right_path.clone()));
            } else {
                return Err(TransferError::Unsupported(
                    "a special filesystem object is inside a compared tree",
                ));
            }
        }
    }
    Ok(true)
}

fn directory_entries(directory: &Path) -> Result<BTreeMap<OsString, PathBuf>, TransferError> {
    inspect_supported_directory(directory)?;
    let mut entries = BTreeMap::new();
    for entry in fs::read_dir(directory)
        .map_err(|error| TransferError::io("directory comparison enumeration failed", error))?
    {
        let entry =
            entry.map_err(|error| TransferError::io("directory comparison entry failed", error))?;
        let path = entry.path();
        if is_internal_transfer_name(&entry.file_name()) {
            return Err(TransferError::Unsupported(
                "a reserved TrashBin transaction path is inside a compared tree",
            ));
        }
        entries.insert(entry.file_name(), path);
    }
    inspect_supported_directory(directory)?;
    Ok(entries)
}

fn compare_files(left: &Path, right: &Path) -> Result<bool, TransferError> {
    let (left_file, left_metadata) = open_regular_file_no_follow(left, "left file open failed")?;
    let (right_file, right_metadata) =
        open_regular_file_no_follow(right, "right file open failed")?;
    if left_metadata.len() != right_metadata.len() {
        return Ok(false);
    }
    let mut left_file = BufReader::with_capacity(COPY_BUFFER_BYTES, left_file);
    let mut right_file = BufReader::with_capacity(COPY_BUFFER_BYTES, right_file);
    let mut left_buffer = vec![0_u8; COPY_BUFFER_BYTES];
    let mut right_buffer = vec![0_u8; COPY_BUFFER_BYTES];
    loop {
        let left_read = left_file
            .read(&mut left_buffer)
            .map_err(|error| TransferError::io("left file comparison read failed", error))?;
        let right_read = right_file
            .read(&mut right_buffer)
            .map_err(|error| TransferError::io("right file comparison read failed", error))?;
        if left_read != right_read || left_buffer[..left_read] != right_buffer[..right_read] {
            return Ok(false);
        }
        if left_read == 0 {
            return Ok(true);
        }
    }
}

fn open_regular_file_no_follow(
    path: &Path,
    operation: &'static str,
) -> Result<(File, Metadata), TransferError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_FLAG_SEQUENTIAL_SCAN, FILE_SHARE_READ,
            FILE_SHARE_WRITE,
        };

        options
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;

        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let file = options
        .open(path)
        .map_err(|error| TransferError::io(operation, error))?;
    let metadata = file
        .metadata()
        .map_err(|error| TransferError::io("opened file inspection failed", error))?;
    if metadata.file_type().is_symlink() || metadata_is_reparse_point(&metadata) {
        return Err(TransferError::Unsupported(
            "refused to open a symbolic link or reparse point as a regular file",
        ));
    }
    if !metadata.is_file() {
        return Err(TransferError::Unsupported(
            "opened filesystem object is not a regular file",
        ));
    }
    Ok((file, metadata))
}

fn inspect_supported_item(path: &Path) -> Result<Metadata, TransferError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| TransferError::io("filesystem object inspection failed", error))?;
    if metadata.file_type().is_symlink() || metadata_is_reparse_point(&metadata) {
        return Err(TransferError::Unsupported(
            "symbolic links, junctions, and reparse points are not copied across volumes",
        ));
    }
    if !metadata.is_file() && !metadata.is_dir() {
        return Err(TransferError::Unsupported(
            "only regular files and directories are copied across volumes",
        ));
    }
    Ok(metadata)
}

fn inspect_supported_directory(path: &Path) -> Result<Metadata, TransferError> {
    let metadata = inspect_supported_item(path)?;
    if !metadata.is_dir() {
        return Err(TransferError::Unsupported(
            "filesystem object changed while a directory was being enumerated",
        ));
    }
    Ok(metadata)
}

fn remove_item_no_follow(path: &Path) -> Result<(), TransferError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(TransferError::io("cleanup inspection failed", error)),
    };
    if metadata.file_type().is_symlink() || metadata_is_reparse_point(&metadata) {
        return Err(TransferError::Unsupported(
            "refused to recursively clean a link or reparse point",
        ));
    }
    if metadata.is_file() {
        make_removable(path, &metadata);
        return fs::remove_file(path)
            .map_err(|error| TransferError::io("file cleanup failed", error));
    }
    if !metadata.is_dir() {
        return Err(TransferError::Unsupported(
            "refused to clean a special filesystem object",
        ));
    }

    let mut pending = vec![(path.to_path_buf(), false)];
    while let Some((current, visited)) = pending.pop() {
        let current_metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(TransferError::io("tree cleanup inspection failed", error)),
        };
        if current_metadata.file_type().is_symlink() || metadata_is_reparse_point(&current_metadata)
        {
            return Err(TransferError::Unsupported(
                "refused to follow a link or reparse point during cleanup",
            ));
        }
        if current_metadata.is_file() {
            make_removable(&current, &current_metadata);
            fs::remove_file(&current)
                .map_err(|error| TransferError::io("tree file cleanup failed", error))?;
            continue;
        }
        if !current_metadata.is_dir() {
            return Err(TransferError::Unsupported(
                "refused to clean a special object inside a tree",
            ));
        }
        if visited {
            make_removable(&current, &current_metadata);
            fs::remove_dir(&current)
                .map_err(|error| TransferError::io("tree directory cleanup failed", error))?;
            continue;
        }
        make_removable(&current, &current_metadata);
        pending.push((current.clone(), true));
        for entry in fs::read_dir(&current)
            .map_err(|error| TransferError::io("tree cleanup enumeration failed", error))?
        {
            let entry =
                entry.map_err(|error| TransferError::io("tree cleanup entry failed", error))?;
            pending.push((entry.path(), false));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn metadata_is_reparse_point(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn metadata_is_reparse_point(_metadata: &Metadata) -> bool {
    false
}

#[cfg(windows)]
fn make_removable(path: &Path, metadata: &Metadata) {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::{SetFileAttributesW, FILE_ATTRIBUTE_READONLY};

    let attributes = metadata.file_attributes();
    if attributes & FILE_ATTRIBUTE_READONLY == 0 {
        return;
    }
    let wide = path_to_wide(path);
    unsafe {
        SetFileAttributesW(wide.as_ptr(), attributes & !FILE_ATTRIBUTE_READONLY);
    }
}

#[cfg(unix)]
fn make_removable(path: &Path, metadata: &Metadata) {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = metadata.permissions();
    let mode = permissions.mode();
    if mode & 0o700 != 0o700 {
        permissions.set_mode(mode | 0o700);
        let _ = fs::set_permissions(path, permissions);
    }
}

#[cfg(not(any(windows, unix)))]
fn make_removable(_path: &Path, _metadata: &Metadata) {}

#[cfg(windows)]
fn set_hidden_best_effort(path: &Path) {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::{SetFileAttributesW, FILE_ATTRIBUTE_HIDDEN};

    let Ok(metadata) = fs::symlink_metadata(path) else {
        return;
    };
    let wide = path_to_wide(path);
    unsafe {
        SetFileAttributesW(
            wide.as_ptr(),
            metadata.file_attributes() | FILE_ATTRIBUTE_HIDDEN,
        );
    }
}

#[cfg(not(windows))]
fn set_hidden_best_effort(_path: &Path) {}

#[cfg(windows)]
fn sync_parent(_path: &Path) -> io::Result<()> {
    // MOVEFILE_WRITE_THROUGH provides the durability barrier for namespace commits on Windows.
    Ok(())
}

#[cfg(not(windows))]
fn sync_parent(path: &Path) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or(io::Error::from(io::ErrorKind::InvalidInput))?;
    File::open(parent)?.sync_all()
}

fn sync_parent_best_effort(path: &Path) {
    let _ = sync_parent(path);
}

#[cfg(windows)]
fn sync_directory(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(not(windows))]
fn sync_directory(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

fn is_cross_volume_error(error: &io::Error) -> bool {
    if error.kind() == io::ErrorKind::CrossesDevices {
        return true;
    }
    #[cfg(windows)]
    if error.raw_os_error() == Some(17) {
        return true;
    }
    #[cfg(unix)]
    if error.raw_os_error() == Some(libc::EXDEV) {
        return true;
    }
    false
}

#[cfg(windows)]
fn path_to_wide(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

#[cfg(windows)]
fn rename_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};

    let source = path_to_wide(source);
    let destination = path_to_wide(destination);
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn rename_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    let destination = CString::new(destination.as_os_str().as_bytes())
        .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn rename_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    let destination = CString::new(destination.as_os_str().as_bytes())
        .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    let result =
        unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) };
    if result == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(any(
    target_os = "windows",
    target_os = "linux",
    target_os = "android",
    target_os = "macos"
)))]
fn rename_no_replace(_source: &Path, _destination: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "atomic no-replace rename is unavailable on this platform",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "agentvis_trash_transfer_{name}_{}",
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn copies_and_verifies_nested_tree() {
        let root = test_root("nested");
        let source = root.join("source");
        let payload = root.join("storage").join("payload");
        fs::create_dir_all(source.join("empty")).unwrap();
        fs::create_dir_all(payload.parent().unwrap()).unwrap();
        fs::write(source.join("hello.txt"), b"hello").unwrap();
        fs::write(source.join("unicode-测试.txt"), b"world").unwrap();

        let candidate = copy_source_to_candidate(&source, &payload).unwrap();
        assert!(items_match(&source, &candidate).unwrap());
        fs::write(candidate.join("hello.txt"), b"changed").unwrap();
        assert!(!items_match(&source, &candidate).unwrap());
        refresh_candidate_from_source(&source, &candidate).unwrap();
        assert!(items_match(&source, &candidate).unwrap());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn claim_is_deterministic_and_no_replace() {
        let root = test_root("claim");
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.txt");
        fs::write(&source, b"source").unwrap();
        let storage_id = uuid::Uuid::new_v4().to_string();
        let expected = claim_path(&source, &storage_id).unwrap();

        let claim = claim_source(&source, &storage_id).unwrap();
        assert_eq!(claim, expected);
        assert!(!source.exists());
        assert!(claim.exists());

        fs::write(&source, b"replacement").unwrap();
        assert!(claim_source(&source, &storage_id).is_err());
        assert!(source.exists());
        assert_eq!(fs::read(&claim).unwrap(), b"source");

        let payload = root.join("payload");
        fs::write(&payload, b"different").unwrap();
        assert!(verify_claim_payload(&claim, &payload).is_err());
        assert!(claim.exists());
        fs::write(&payload, b"source").unwrap();
        verify_claim_payload(&claim, &payload).unwrap();
        finish_verified_claim_cleanup(&claim).unwrap();
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn forced_copy_restore_commits_without_overwriting() {
        let root = test_root("restore");
        let source = root.join("central").join("payload");
        let destination = root.join("other-volume").join("restored.txt");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::write(&source, b"recoverable").unwrap();
        let restore_id = uuid::Uuid::new_v4().to_string();
        let owner_token = uuid::Uuid::new_v4().to_string();

        commit_restore_inner(&source, &destination, &restore_id, &owner_token, true).unwrap();
        assert!(source.exists());
        assert_eq!(fs::read(&destination).unwrap(), b"recoverable");
        verify_restore_commit(&source, &destination).unwrap();
        finish_committed_restore(&source, &destination, &restore_id, &owner_token).unwrap();
        assert!(!source.exists());

        let second_source = root.join("central").join("payload-2");
        fs::write(&second_source, b"do not overwrite").unwrap();
        let second_restore_id = uuid::Uuid::new_v4().to_string();
        let second_owner_token = uuid::Uuid::new_v4().to_string();
        assert!(commit_restore_inner(
            &second_source,
            &destination,
            &second_restore_id,
            &second_owner_token,
            true
        )
        .is_err());
        assert!(second_source.exists());
        assert_eq!(fs::read(&destination).unwrap(), b"recoverable");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn restore_staging_requires_matching_owner_marker() {
        let root = test_root("restore-owner");
        let source = root.join("central").join("payload");
        let destination = root.join("work").join("restored.txt");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::write(&source, b"recoverable").unwrap();
        let restore_id = uuid::Uuid::new_v4().to_string();
        let owner_token = uuid::Uuid::new_v4().to_string();
        let collision = restore_staging_path(&destination, &restore_id).unwrap();
        fs::create_dir(&collision).unwrap();
        fs::write(collision.join("user.txt"), b"do not delete").unwrap();

        let error = commit_restore_inner(&source, &destination, &restore_id, &owner_token, true)
            .unwrap_err();
        assert!(error.is_destination_collision());
        assert_eq!(
            fs::read(collision.join("user.txt")).unwrap(),
            b"do not delete"
        );
        assert!(!restore_staging_is_owned(&destination, &restore_id, &owner_token).unwrap());
        assert!(discard_restore_staging(&destination, &restore_id, &owner_token).is_err());
        assert_eq!(
            fs::read(collision.join("user.txt")).unwrap(),
            b"do not delete"
        );

        let _ = fs::remove_dir_all(&collision);
        let owned = create_restore_staging(&destination, &restore_id, &owner_token).unwrap();
        fs::write(owned.join(RESTORE_PAYLOAD_NAME), b"partial").unwrap();
        assert!(restore_staging_is_owned(&destination, &restore_id, &owner_token).unwrap());
        discard_restore_staging(&destination, &restore_id, &owner_token).unwrap();
        assert!(!owned.exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn committed_restore_removes_only_an_empty_markerless_wrapper_residue() {
        let root = test_root("restore-empty-residue");
        let source = root.join("central").join("payload");
        let destination = root.join("work").join("restored.txt");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::write(&source, b"recoverable").unwrap();
        fs::write(&destination, b"recoverable").unwrap();
        let restore_id = uuid::Uuid::new_v4().to_string();
        let owner_token = uuid::Uuid::new_v4().to_string();
        let wrapper = create_restore_staging(&destination, &restore_id, &owner_token).unwrap();
        fs::remove_file(wrapper.join(RESTORE_MARKER_NAME)).unwrap();

        assert!(discard_restore_staging(&destination, &restore_id, &owner_token).is_err());
        assert!(wrapper.exists());

        finish_committed_restore(&source, &destination, &restore_id, &owner_token).unwrap();
        assert!(!wrapper.exists());
        assert!(!source.exists());
        assert_eq!(fs::read(&destination).unwrap(), b"recoverable");

        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn owned_restore_cleanup_keeps_marker_when_payload_is_temporarily_locked() {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};

        let root = test_root("restore-locked-payload");
        let destination = root.join("work").join("restored.txt");
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        let restore_id = uuid::Uuid::new_v4().to_string();
        let owner_token = uuid::Uuid::new_v4().to_string();
        let wrapper = create_restore_staging(&destination, &restore_id, &owner_token).unwrap();
        let staged = wrapper.join(RESTORE_PAYLOAD_NAME);
        fs::create_dir(&staged).unwrap();
        let locked_file = staged.join("locked.txt");
        fs::write(&locked_file, b"locked").unwrap();
        let held = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(&locked_file)
            .unwrap();

        assert!(discard_restore_staging(&destination, &restore_id, &owner_token).is_err());
        assert_eq!(
            fs::read(wrapper.join(RESTORE_MARKER_NAME)).unwrap(),
            owner_token.as_bytes()
        );

        drop(held);
        discard_restore_staging(&destination, &restore_id, &owner_token).unwrap();
        assert!(!wrapper.exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn same_volume_restore_commit_verification_accepts_a_symlink_item() {
        use std::os::unix::fs::symlink;

        let root = test_root("restore-symlink");
        fs::create_dir_all(&root).unwrap();
        let missing_source = root.join("central-payload");
        let destination = root.join("restored-link");
        let target = root.join("target.txt");
        fs::write(&target, b"target").unwrap();
        symlink(&target, &destination).unwrap();

        verify_restore_commit(&missing_source, &destination).unwrap();

        let _ = fs::remove_file(&destination);
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn cross_volume_copy_rejects_symlinks_without_following() {
        use std::os::unix::fs::symlink;

        let root = test_root("symlink");
        let source = root.join("source");
        let outside = root.join("outside.txt");
        let payload = root.join("storage").join("payload");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(payload.parent().unwrap()).unwrap();
        fs::write(&outside, b"outside").unwrap();
        symlink(&outside, source.join("link")).unwrap();

        assert!(copy_source_to_candidate(&source, &payload).is_err());
        assert_eq!(fs::read(&outside).unwrap(), b"outside");
        assert!(source.exists());

        let _ = fs::remove_dir_all(&root);
    }
}
