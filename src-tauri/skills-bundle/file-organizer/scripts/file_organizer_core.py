"""Core module for the file-organizer Script Skill.

The skill is intentionally plan-first. File moves are high-impact side effects,
so callers must choose action=apply before files are changed.
"""

from __future__ import annotations

import fnmatch
import json
import os
import shutil
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Extension -> category folder name.
EXTENSION_CATEGORY_MAP: dict[str, str] = {
    # Images
    ".jpg": "Images", ".jpeg": "Images", ".png": "Images", ".gif": "Images",
    ".bmp": "Images", ".svg": "Images", ".webp": "Images", ".ico": "Images",
    ".tiff": "Images", ".tif": "Images", ".raw": "Images", ".psd": "Images",
    ".ai": "Images", ".heic": "Images",".heic": "Images", ".avif": "Images",
    ".jfif": "Images", ".pjpeg": "Images", ".pjp": "Images", ".jpe": "Images",
    ".svgz": "Images", ".eps": "Images", ".dng": "Images", ".cr2": "Images",
    ".cr3": "Images", ".nef": "Images", ".nrw": "Images", ".arw": "Images",
    ".srf": "Images", ".sr2": "Images", ".orf": "Images", ".rw2": "Images",
    ".raf": "Images", ".pef": "Images", ".srw": "Images", ".x3f": "Images",
    ".sketch": "Images", ".fig": "Images", ".xd": "Images",
    # Documents
    ".pdf": "Documents", ".doc": "Documents", ".docx": "Documents",
    ".xls": "Documents", ".xlsx": "Documents", ".ppt": "Documents",
    ".pptx": "Documents", ".txt": "Documents", ".md": "Documents",
    ".csv": "Documents", ".rtf": "Documents", ".odt": "Documents",
    ".ods": "Documents", ".odp": "Documents", ".epub": "Documents",
    ".mobi": "Documents", ".docm": "Documents", ".dot": "Documents",
    ".dotx": "Documents", ".xlsm": "Documents", ".xlsb": "Documents",
    ".xlt": "Documents", ".xltx": "Documents", ".pptm": "Documents",
    ".pps": "Documents", ".ppsx": "Documents", ".pot": "Documents",
    ".potx": "Documents", ".pages": "Documents", ".numbers": "Documents",
    ".key": "Documents", ".tex": "Documents", ".bib": "Documents",
    ".log": "Documents", ".tsv": "Documents", ".djvu": "Documents",
    ".azw": "Documents", ".azw3": "Documents", ".fb2": "Documents",
    ".chm": "Documents", ".eml": "Documents", ".msg": "Documents",
    ".one": "Documents",
    # Videos
    ".mp4": "Videos", ".avi": "Videos", ".mkv": "Videos", ".mov": "Videos",
    ".wmv": "Videos", ".flv": "Videos", ".webm": "Videos", ".m4v": "Videos",
    ".3gp": "Videos", ".mpg": "Videos", ".mpeg": "Videos", ".mpe": "Videos",
    ".m2v": "Videos", ".mts": "Videos", ".m2ts": "Videos",
    ".ogv": "Videos", ".asf": "Videos", ".rm": "Videos", ".rmvb": "Videos",
    ".vob": "Videos", ".divx": "Videos", ".f4v": "Videos",
    # Audio
    ".mp3": "Audio", ".wav": "Audio", ".flac": "Audio", ".aac": "Audio",
    ".ogg": "Audio", ".wma": "Audio", ".m4a": "Audio", ".opus": "Audio",
    ".aif": "Audio", ".aiff": "Audio", ".alac": "Audio", ".mid": "Audio",
    ".midi": "Audio", ".amr": "Audio", ".ape": "Audio", ".caf": "Audio",
    ".mka": "Audio", ".ra": "Audio", ".dsf": "Audio", ".dff": "Audio",
    # Archives
    ".zip": "Archives", ".rar": "Archives", ".7z": "Archives",
    ".tar": "Archives", ".gz": "Archives", ".bz2": "Archives",
    ".xz": "Archives", ".iso": "Archives", ".tgz": "Archives",
    ".tbz": "Archives", ".tbz2": "Archives", ".txz": "Archives",
    ".lz": "Archives", ".lzma": "Archives", ".zst": "Archives",
    ".z": "Archives", ".cab": "Archives", ".jar": "Archives",
    ".war": "Archives", ".ear": "Archives", ".whl": "Archives",
    ".egg": "Archives",
    # Code
    ".py": "Code", ".js": "Code", ".jsx": "Code", ".ts": "Code",
    ".tsx": "Code", ".html": "Code", ".css": "Code", ".scss": "Code",
    ".json": "Code", ".xml": "Code", ".yaml": "Code", ".yml": "Code",
    ".java": "Code", ".c": "Code", ".cpp": "Code", ".h": "Code",
    ".hpp": "Code", ".rs": "Code", ".go": "Code", ".rb": "Code",
    ".php": "Code", ".sh": "Code", ".bat": "Code", ".ps1": "Code",
    ".sql": "Code", ".toml": "Code", ".ini": "Code", ".cfg": "Code",
    ".lock": "Code", ".mjs": "Code", ".cjs": "Code", ".vue": "Code",
    ".svelte": "Code", ".astro": "Code", ".less": "Code", ".sass": "Code",
    ".styl": "Code", ".cs": "Code", ".csx": "Code", ".swift": "Code",
    ".kt": "Code", ".kts": "Code", ".scala": "Code", ".lua": "Code",
    ".pl": "Code", ".pm": "Code", ".r": "Code", ".jl": "Code",
    ".dart": "Code", ".ex": "Code", ".exs": "Code", ".erl": "Code",
    ".hrl": "Code", ".clj": "Code", ".cljs": "Code", ".fs": "Code",
    ".fsx": "Code", ".vb": "Code", ".groovy": "Code", ".gradle": "Code",
    ".cmake": "Code", ".mk": "Code", ".make": "Code", ".proto": "Code",
    ".graphql": "Code", ".gql": "Code", ".tf": "Code",
    ".tfvars": "Code", ".hcl": "Code", ".properties": "Code",
    ".conf": "Code", ".env": "Code", ".ipynb": "Code", ".mdx": "Code",
    ".sol": "Code", ".zig": "Code", ".nim": "Code", ".v": "Code",
    ".sv": "Code",
    # Fonts
    ".ttf": "Fonts", ".otf": "Fonts", ".woff": "Fonts", ".woff2": "Fonts",
    ".eot": "Fonts", ".fon": "Fonts", ".fnt": "Fonts",
    ".ttc": "Fonts", ".dfont": "Fonts", ".pfa": "Fonts", ".pfb": "Fonts",
    # Installers
    ".exe": "Installers", ".msi": "Installers", ".msix": "Installers",
    ".appx": "Installers", ".appxbundle": "Installers",
    ".appinstaller": "Installers", ".dmg": "Installers",
    ".pkg": "Installers", ".deb": "Installers", ".rpm": "Installers",
    ".apk": "Installers", ".xapk": "Installers", ".ipa": "Installers",
    # Data
    ".db": "Data", ".sqlite": "Data", ".sqlite3": "Data",
    ".parquet": "Data", ".avro": "Data", ".orc": "Data",
    ".feather": "Data", ".arrow": "Data", ".h5": "Data",
    ".hdf5": "Data", ".npy": "Data", ".npz": "Data",
    ".pkl": "Data", ".pickle": "Data", ".sav": "Data",
    ".dta": "Data", ".rds": "Data", ".sas7bdat": "Data",
    ".jsonl": "Data", ".ndjson": "Data",
}

COMPOUND_EXTENSION_MAP: dict[str, str] = {
    ".tar.gz": "Archives",
    ".tar.bz2": "Archives",
    ".tar.xz": "Archives",
    ".tar.zst": "Archives",
    ".tar.lz": "Archives",
    ".tar.lzma": "Archives",
    ".tar.z": "Archives",
}

CATEGORY_FOLDERS: list[str] = [
    "Images", "Documents", "Videos", "Audio",
    "Archives", "Code", "Fonts", "Installers", "Data", "Others",
]

DEFAULT_EXCLUDED_DIRS: set[str] = {
    ".git", ".hg", ".svn", ".cache", ".next", ".nuxt", ".turbo",
    "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
    "node_modules", "bower_components", "vendor",
    ".venv", "venv", "env",
    "dist", "build", "out", "target", "coverage",
}

DEFAULT_PREVIEW_LIMIT = 200
DEFAULT_MAX_APPLY_FILES = 2000
SEMANTIC_ORGANIZATION_HINT = (
    "This result is based on file extensions and category folders; file contents were not read. If the user needs to undo file organization or wants semantic organization, offer to inspect selected files and build a finer-grained content-based classification plan before making further moves. Submit this hint to Next-step suggestions."
)
UNDO_MANIFEST_PATTERNS = [
    "file-organizer-undo-manifest-*.json",
    ".file-organizer-undo-manifest-*.json",
    ".file-organizer-undo-*.json",
]


class UserCorrectableError(RuntimeError):
    """Raised when the issue can be explained to the user for a later retry."""


@dataclass
class PlannedMove:
    source: str
    destination: str
    category: str
    reason: str
    conflict_resolution: str | None = None


@dataclass
class OrganizeReport:
    target_path: str
    action: str
    recursive: bool
    include_hidden: bool
    layout: str
    total_files_found: int
    total_planned: int
    total_moved: int
    total_failed: int
    by_category: dict[str, int] = field(default_factory=dict)
    planned_moves: list[PlannedMove] = field(default_factory=list)
    failures: list[dict[str, str]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    undo_manifest_path: str | None = None
    excluded_directories: int = 0
    cleaned_empty_directories: list[str] = field(default_factory=list)
    preview_limit: int = DEFAULT_PREVIEW_LIMIT


def normalize_action(action: str | None) -> str:
    """Normalize action aliases."""
    raw = (action or "").strip().lower()

    aliases = {
        "": "plan",
        "plan": "plan",
        "preview": "plan",
        "dry-run": "plan",
        "dryrun": "plan",
        "apply": "apply",
        "run": "apply",
        "move": "apply",
        "organize": "apply",
        "undo": "undo",
        "restore": "undo",
        "rollback": "undo",
    }
    normalized = aliases.get(raw)
    if normalized is None:
        raise UserCorrectableError(
            "Invalid action. Use action=plan, action=apply, or action=undo."
        )
    return normalized


def normalize_layout(layout: str | None, recursive: bool) -> str:
    """Return flat or preserveTree layout."""
    raw = (layout or "").strip().lower()
    if not raw:
        return "preserveTree" if recursive else "flat"

    if raw in {"flat", "flatten"}:
        return "flat"
    if raw in {"preserve", "preservetree", "preserve-tree", "tree"}:
        return "preserveTree"
    raise UserCorrectableError(
        "Invalid layout. Use layout=flat or layout=preserveTree."
    )


def parse_excludes(value: str | None) -> list[str]:
    """Parse comma or semicolon separated exclude names/globs."""
    if not value:
        return []
    pieces = value.replace(";", ",").split(",")
    return [piece.strip() for piece in pieces if piece.strip()]


def path_key(path: Path) -> str:
    """Return a collision key that follows platform path casing rules."""
    return os.path.normcase(os.path.abspath(str(path)))


def is_under_root(path: Path, root: Path) -> bool:
    """Return whether path is inside root, excluding root itself."""
    try:
        resolved_path = path.resolve()
        resolved_root = root.resolve()
        return resolved_path != resolved_root and resolved_path.is_relative_to(resolved_root)
    except (OSError, ValueError):
        return False


def file_category(path: Path) -> tuple[str, str]:
    """Return category and human-readable classification reason."""
    lower_name = path.name.lower()
    for compound_ext, category in COMPOUND_EXTENSION_MAP.items():
        if lower_name.endswith(compound_ext):
            return category, f"extension {compound_ext}"

    ext = path.suffix.lower()
    if ext:
        return EXTENSION_CATEGORY_MAP.get(ext, "Others"), f"extension {ext}"
    return "Others", "no extension"


def matches_exclude(path: Path, root: Path, patterns: list[str]) -> bool:
    """Match exclude patterns against name and root-relative path."""
    if not patterns:
        return False

    name = path.name
    try:
        rel = path.relative_to(root).as_posix()
    except ValueError:
        rel = name

    for pattern in patterns:
        if fnmatch.fnmatch(name, pattern) or fnmatch.fnmatch(rel, pattern):
            return True
    return False


def should_skip_dir(
    root: Path,
    current_dir: Path,
    dir_name: str,
    include_hidden: bool,
    extra_excludes: list[str],
) -> bool:
    """Decide whether a directory should be skipped during scanning."""
    lower_name = dir_name.lower()
    candidate = current_dir / dir_name

    if current_dir == root and lower_name in {c.lower() for c in CATEGORY_FOLDERS}:
        return True
    if lower_name in DEFAULT_EXCLUDED_DIRS:
        return True
    if not include_hidden and dir_name.startswith("."):
        return True
    return matches_exclude(candidate, root, extra_excludes)


def scan_files(
    root: Path,
    recursive: bool,
    include_hidden: bool,
    extra_excludes: list[str],
) -> tuple[list[Path], int]:
    """Scan target directory, skipping generated category and project folders."""
    files: list[Path] = []
    excluded_directories = 0

    for current, dir_names, file_names in os.walk(root):
        current_dir = Path(current)

        kept_dirs: list[str] = []
        for dir_name in dir_names:
            if should_skip_dir(root, current_dir, dir_name, include_hidden, extra_excludes):
                excluded_directories += 1
                continue
            kept_dirs.append(dir_name)
        dir_names[:] = kept_dirs if recursive else []

        for file_name in file_names:
            file_path = current_dir / file_name
            if not include_hidden and file_name.startswith("."):
                continue
            if matches_exclude(file_path, root, extra_excludes):
                continue
            if file_path.is_file():
                files.append(file_path)

        if not recursive:
            break

    files.sort(key=lambda item: item.as_posix().lower())
    return files, excluded_directories


def resolve_conflict(dest: Path, occupied_destinations: set[str]) -> tuple[Path, str | None]:
    """Resolve filename conflicts by appending a numeric suffix."""
    if not dest.exists() and path_key(dest) not in occupied_destinations:
        return dest, None

    stem = dest.stem
    suffix = dest.suffix
    parent = dest.parent
    counter = 1
    while True:
        candidate = parent / f"{stem} ({counter}){suffix}"
        if not candidate.exists() and path_key(candidate) not in occupied_destinations:
            return candidate, f"renamed to avoid conflict with {dest.name}"
        counter += 1


def destination_for_file(root: Path, file_path: Path, category: str, layout: str) -> Path:
    """Return target destination for one file."""
    dest_dir = root / category
    if layout == "preserveTree":
        rel_parent = file_path.parent.relative_to(root)
        if rel_parent != Path("."):
            dest_dir = dest_dir / rel_parent
    return dest_dir / file_path.name


def build_move_plan(root: Path, files: list[Path], layout: str) -> list[PlannedMove]:
    """Build an exact move plan, including destination conflict resolution."""
    occupied_destinations: set[str] = set()
    planned_moves: list[PlannedMove] = []

    for file_path in files:
        category, reason = file_category(file_path)
        destination = destination_for_file(root, file_path, category, layout)
        destination, conflict_resolution = resolve_conflict(destination, occupied_destinations)
        occupied_destinations.add(path_key(destination))

        planned_moves.append(
            PlannedMove(
                source=str(file_path),
                destination=str(destination),
                category=category,
                reason=reason,
                conflict_resolution=conflict_resolution,
            )
        )

    return planned_moves


def planned_move_to_dict(move: PlannedMove) -> dict[str, str]:
    """Serialize a planned move."""
    payload = {
        "source": move.source,
        "destination": move.destination,
        "category": move.category,
        "reason": move.reason,
    }
    if move.conflict_resolution:
        payload["conflictResolution"] = move.conflict_resolution
    return payload


def is_high_risk_target(root: Path) -> str | None:
    """Return a warning/error message when applying to a risky root."""
    root_str = str(root)
    if root.anchor and root_str.rstrip("\\/") == root.anchor.rstrip("\\/"):
        return "Refusing to apply to a drive or filesystem root."

    lowered = root_str.lower()
    protected_fragments = [
        "\\windows",
        "\\program files",
        "\\program files (x86)",
        "/bin",
        "/boot",
        "/etc",
        "/lib",
        "/opt",
        "/sbin",
        "/usr",
    ]
    if any(fragment in lowered for fragment in protected_fragments):
        return "Refusing to apply to an operating-system or application directory."

    return None


def default_manifest_path(root: Path) -> Path:
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return root / f"file-organizer-undo-manifest-{timestamp}.json"


def normalize_manifest_path(manifest_path: str | None, root: Path) -> Path:
    if manifest_path:
        path = Path(manifest_path).expanduser()
        if not path.is_absolute():
            path = root / path
        return path.resolve()
    return default_manifest_path(root).resolve()


def missing_directory_chain(root: Path, directory: Path) -> list[Path]:
    """Return missing directories from deepest to shallowest before mkdir."""
    missing: list[Path] = []
    cursor = directory.resolve()
    resolved_root = root.resolve()

    while cursor != resolved_root and is_under_root(cursor, resolved_root) and not cursor.exists():
        missing.append(cursor)
        cursor = cursor.parent

    return missing


def find_latest_undo_manifest(root: Path) -> Path | None:
    """Find the newest undo manifest in the target directory.

    Keep compatibility with the older hidden filename
    .file-organizer-undo-YYYYMMDD-HHMMSS.json.
    """
    candidates: dict[str, Path] = {}
    for pattern in UNDO_MANIFEST_PATTERNS:
        for path in root.glob(pattern):
            if path.is_file():
                candidates[path_key(path)] = path.resolve()

    if not candidates:
        return None

    return max(
        candidates.values(),
        key=lambda path: (
            path.stat().st_mtime,
            path.name,
        ),
    )


def write_undo_manifest(
    manifest_path: Path,
    target_path: Path,
    moves: list[PlannedMove],
    created_directories: list[Path],
) -> None:
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": 1,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "target": str(target_path),
        "moves": [planned_move_to_dict(move) for move in moves],
        "createdDirectories": [str(path) for path in created_directories],
    }
    manifest_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def apply_move_plan(
    root: Path,
    planned_moves: list[PlannedMove],
    manifest_path: Path,
) -> tuple[int, list[dict[str, str]], list[PlannedMove], list[str]]:
    """Apply a move plan and write an undo manifest for successful moves."""
    failures: list[dict[str, str]] = []
    successful_moves: list[PlannedMove] = []
    warnings: list[str] = []
    occupied_destinations: set[str] = set()
    created_directories: dict[str, Path] = {}

    for move in planned_moves:
        source = Path(move.source)
        destination = Path(move.destination)
        final_destination, late_conflict = resolve_conflict(
            destination,
            occupied_destinations,
        )
        if late_conflict:
            move.destination = str(final_destination)
            move.conflict_resolution = late_conflict

        candidate_created_dirs = missing_directory_chain(root, final_destination.parent)
        try:
            final_destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(source), str(final_destination))
            occupied_destinations.add(path_key(final_destination))
            successful_moves.append(move)
            for directory in candidate_created_dirs:
                created_directories[path_key(directory)] = directory
        except OSError as exc:
            failures.append({"file": str(source), "error": str(exc)})
            cleanup_empty_directories(candidate_created_dirs, root)

    if successful_moves:
        try:
            write_undo_manifest(
                manifest_path,
                root,
                successful_moves,
                list(created_directories.values()),
            )
        except OSError as exc:
            warnings.append(
                f"Files were moved, but the undo manifest could not be written: {exc}"
            )

    return len(successful_moves), failures, successful_moves, warnings


def cleanup_empty_directories(directories: list[Path], root: Path) -> list[str]:
    """Remove empty directories under root, deepest first."""
    unique_dirs: dict[str, Path] = {}
    for directory in directories:
        if is_under_root(directory, root):
            unique_dirs[path_key(directory)] = directory.resolve()

    removed: list[str] = []
    sorted_dirs = sorted(
        unique_dirs.values(),
        key=lambda directory: len(directory.parts),
        reverse=True,
    )
    for directory in sorted_dirs:
        try:
            directory.rmdir()
            removed.append(str(directory))
        except FileNotFoundError:
            continue
        except OSError:
            continue
    return removed


def cleanup_dirs_from_manifest(payload: dict[str, Any], root: Path) -> list[str]:
    """Clean empty category directories after undo.

    New manifests record exact directories created by apply. Legacy manifests did
    not, so fall back to destination ancestors inside touched category folders.
    """
    raw_created_dirs = payload.get("createdDirectories")
    if isinstance(raw_created_dirs, list):
        return cleanup_empty_directories(
            [Path(str(path)) for path in raw_created_dirs],
            root,
        )

    cleanup_candidates: dict[str, Path] = {}
    category_names = set(CATEGORY_FOLDERS)
    for move in payload.get("moves", []):
        if not isinstance(move, dict):
            continue
        category = str(move.get("category", ""))
        if category not in category_names:
            continue

        category_root = root / category
        destination = Path(str(move.get("destination", "")))
        directory = destination.parent

        while is_under_root(directory, root):
            try:
                directory.resolve().relative_to(category_root.resolve())
            except (OSError, ValueError):
                break
            cleanup_candidates[path_key(directory)] = directory.resolve()
            if directory.resolve() == category_root.resolve():
                break
            directory = directory.parent

    return cleanup_empty_directories(list(cleanup_candidates.values()), root)


def load_manifest(manifest_path: Path) -> dict[str, Any]:
    if not manifest_path.exists():
        raise UserCorrectableError(f"Undo manifest does not exist: {manifest_path}")
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as exc:
        raise UserCorrectableError(f"Undo manifest is not valid JSON: {exc}") from exc

    if payload.get("version") != 1 or not isinstance(payload.get("moves"), list):
        raise UserCorrectableError("Undo manifest is not a supported file-organizer manifest.")
    return payload


def undo_from_manifest(root: Path, manifest_path: Path, preview_limit: int) -> OrganizeReport:
    """Move files from their organized destinations back to original paths."""
    payload = load_manifest(manifest_path)
    failures: list[dict[str, str]] = []
    restored_moves: list[PlannedMove] = []

    for move in reversed(payload["moves"]):
        source = Path(str(move.get("source", "")))
        destination = Path(str(move.get("destination", "")))

        if not destination.exists():
            failures.append({
                "file": str(destination),
                "error": "organized file is missing",
            })
            continue
        if source.exists():
            failures.append({
                "file": str(source),
                "error": "original path already exists; refusing to overwrite",
            })
            continue

        try:
            source.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(destination), str(source))
            restored_moves.append(
                PlannedMove(
                    source=str(destination),
                    destination=str(source),
                    category=str(move.get("category", "Others")),
                    reason="undo manifest",
                )
            )
        except OSError as exc:
            failures.append({"file": str(destination), "error": str(exc)})

    by_category: dict[str, int] = defaultdict(int)
    for move in restored_moves:
        by_category[move.category] += 1
    cleaned_empty_directories = cleanup_dirs_from_manifest(payload, root)

    return OrganizeReport(
        target_path=str(root),
        action="undo",
        recursive=True,
        include_hidden=True,
        layout="preserveTree",
        total_files_found=len(payload["moves"]),
        total_planned=len(payload["moves"]),
        total_moved=len(restored_moves),
        total_failed=len(failures),
        by_category=dict(by_category),
        planned_moves=restored_moves,
        failures=failures,
        undo_manifest_path=str(manifest_path),
        cleaned_empty_directories=cleaned_empty_directories,
        preview_limit=preview_limit,
    )


def format_report(report: OrganizeReport) -> str:
    """Format the report as a concise human-readable summary."""
    lines: list[str] = []
    lines.append(f"=== File Organizer {report.action.upper()} ===")
    lines.append(f"Target: {report.target_path}")
    lines.append(f"Recursive: {report.recursive}")
    lines.append(f"Layout: {report.layout}")
    lines.append(f"Files found: {report.total_files_found}")
    lines.append(f"Moves planned: {report.total_planned}")
    lines.append(f"Files moved: {report.total_moved}")
    lines.append(f"Files failed: {report.total_failed}")

    if report.excluded_directories:
        lines.append(f"Excluded directories: {report.excluded_directories}")
    if report.undo_manifest_path:
        lines.append(f"Undo manifest: {report.undo_manifest_path}")
    if report.cleaned_empty_directories:
        lines.append(f"Cleaned empty directories: {len(report.cleaned_empty_directories)}")

    if report.by_category:
        lines.append("")
        lines.append("By category:")
        for category in CATEGORY_FOLDERS:
            count = report.by_category.get(category, 0)
            if count > 0:
                lines.append(f"  {category}: {count}")

    if report.warnings:
        lines.append("")
        lines.append("Warnings:")
        for warning in report.warnings:
            lines.append(f"  {warning}")

    if report.failures:
        lines.append("")
        lines.append("Failures:")
        for failure in report.failures[:20]:
            lines.append(f"  {failure['file']}: {failure['error']}")
        if len(report.failures) > 20:
            lines.append(f"  ... {len(report.failures) - 20} more failures")

    if report.total_planned > report.preview_limit:
        lines.append("")
        lines.append(
            f"Planned move preview truncated to {report.preview_limit} items."
        )

    agent_hint = semantic_organization_hint(report)
    if agent_hint:
        lines.append("")
        lines.append(f"Agent hint: {agent_hint}")

    return "\n".join(lines)


def semantic_organization_hint(report: OrganizeReport) -> str | None:
    """Return an agent-facing reminder for successful type-based organization."""
    if report.action not in {"plan", "apply"}:
        return None
    if report.total_failed > 0 or report.total_planned == 0:
        return None
    return SEMANTIC_ORGANIZATION_HINT


def report_to_dict(report: OrganizeReport) -> dict[str, Any]:
    preview_moves = report.planned_moves[:report.preview_limit]
    agent_hint = semantic_organization_hint(report)
    return {
        "target": report.target_path,
        "action": report.action,
        "recursive": report.recursive,
        "includeHidden": report.include_hidden,
        "layout": report.layout,
        "filesFound": report.total_files_found,
        "movesPlanned": report.total_planned,
        "filesMoved": report.total_moved,
        "filesFailed": report.total_failed,
        "excludedDirectories": report.excluded_directories,
        "byCategory": dict(report.by_category),
        "plannedMoves": [planned_move_to_dict(move) for move in preview_moves],
        "plannedMovesTruncated": report.total_planned > report.preview_limit,
        "failures": report.failures,
        "warnings": report.warnings,
        "undoManifest": report.undo_manifest_path,
        "cleanedEmptyDirectories": report.cleaned_empty_directories,
        **({"agentNextStepHint": agent_hint} if agent_hint else {}),
        "summary": format_report(report),
    }


def organize_directory(
    target_path: str,
    *,
    action: str = "plan",
    recursive: bool = False,
    include_hidden: bool = False,
    layout: str | None = None,
    exclude: str | None = None,
    manifest_path: str | None = None,
    max_files: int = DEFAULT_MAX_APPLY_FILES,
    preview_limit: int = DEFAULT_PREVIEW_LIMIT,
    allow_large: bool = False,
) -> OrganizeReport:
    """Scan, plan, apply, or undo file organization."""
    action = normalize_action(action)
    root = Path(target_path).expanduser().resolve()
    preview_limit = max(0, int(preview_limit))

    if not root.exists():
        raise UserCorrectableError(f"Target path does not exist: {target_path}")
    if not root.is_dir():
        raise UserCorrectableError(f"Target path is not a directory: {target_path}")

    if action == "undo":
        auto_selected_manifest = False
        if manifest_path:
            manifest = normalize_manifest_path(manifest_path, root)
        else:
            manifest = find_latest_undo_manifest(root)
            auto_selected_manifest = True
            if manifest is None:
                raise UserCorrectableError(
                    "action=undo could not find an undo manifest. "
                    "Pass manifestPath or place a file-organizer-undo-manifest-*.json "
                    "or .file-organizer-undo-*.json file in the target directory."
                )
        report = undo_from_manifest(root, manifest, preview_limit)
        if auto_selected_manifest:
            report.warnings.append(f"Auto-selected latest undo manifest: {manifest}")
        return report

    layout = normalize_layout(layout, recursive)
    extra_excludes = parse_excludes(exclude)
    files, excluded_directories = scan_files(
        root,
        recursive=recursive,
        include_hidden=include_hidden,
        extra_excludes=extra_excludes,
    )
    planned_moves = build_move_plan(root, files, layout)
    total_planned = len(planned_moves)

    by_category: dict[str, int] = defaultdict(int)
    for move in planned_moves:
        by_category[move.category] += 1

    warnings: list[str] = []
    risk = is_high_risk_target(root)
    if risk:
        if action == "apply":
            raise UserCorrectableError(risk)
        warnings.append(risk)

    if action == "apply" and max_files > 0 and total_planned > max_files and not allow_large:
        raise UserCorrectableError(
            f"Refusing to apply {total_planned} moves because maxFiles={max_files}. "
            "Run action=plan first, narrow the target, raise maxFiles, or pass allowLarge=true."
        )

    total_moved = 0
    failures: list[dict[str, str]] = []
    undo_path: str | None = None
    successful_moves: list[PlannedMove] = []

    if action == "apply":
        manifest = normalize_manifest_path(manifest_path, root)
        total_moved, failures, successful_moves, apply_warnings = apply_move_plan(
            root,
            planned_moves,
            manifest,
        )
        warnings.extend(apply_warnings)
        if successful_moves:
            undo_path = str(manifest)
        planned_moves = successful_moves or planned_moves

    return OrganizeReport(
        target_path=str(root),
        action=action,
        recursive=recursive,
        include_hidden=include_hidden,
        layout=layout,
        total_files_found=len(files),
        total_planned=total_planned,
        total_moved=total_moved,
        total_failed=len(failures),
        by_category=dict(by_category),
        planned_moves=planned_moves,
        failures=failures,
        warnings=warnings,
        undo_manifest_path=undo_path,
        excluded_directories=excluded_directories,
        preview_limit=preview_limit,
    )


def run(
    *,
    path: str,
    action: str = "plan",
    recursive: bool = False,
    include_hidden: bool = False,
    layout: str | None = None,
    exclude: str | None = None,
    manifest_path: str | None = None,
    max_files: int = DEFAULT_MAX_APPLY_FILES,
    preview_limit: int = DEFAULT_PREVIEW_LIMIT,
    allow_large: bool = False,
) -> dict[str, Any]:
    """Entry point called by the thin script entrypoint."""
    report = organize_directory(
        target_path=path,
        action=action,
        recursive=recursive,
        include_hidden=include_hidden,
        layout=layout,
        exclude=exclude,
        manifest_path=manifest_path,
        max_files=max_files,
        preview_limit=preview_limit,
        allow_large=allow_large,
    )
    return report_to_dict(report)
