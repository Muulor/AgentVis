import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function defaultWhisperModelDir() {
  const configured = process.env.HYPERFRAMES_WHISPER_MODELS_DIR;
  if (configured) return resolve(configured);

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return join(localAppData, "hyperframes-video", "whisper");
  }

  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Caches", "hyperframes-video", "whisper");
  }

  const cacheHome = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(cacheHome, "hyperframes-video", "whisper");
}

export function defaultWhisperBuildDir() {
  const configured = process.env.HYPERFRAMES_VIDEO_WHISPER_BUILD_DIR;
  if (configured) return resolve(configured);

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return join(localAppData, "hyperframes-video", "whisper.cpp");
  }

  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Caches", "hyperframes-video", "whisper.cpp");
  }

  const cacheHome = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(cacheHome, "hyperframes-video", "whisper.cpp");
}

export function whisperBinaryCandidates(buildDir = defaultWhisperBuildDir()) {
  const exe = process.platform === "win32" ? ".exe" : "";
  return [
    join(buildDir, "build", "bin", `whisper-cli${exe}`),
    join(buildDir, "build", "bin", "Release", `whisper-cli${exe}`),
    join(buildDir, "build", "bin", "Debug", `whisper-cli${exe}`),
    join(buildDir, "build", `whisper-cli${exe}`),
    join(buildDir, "build", "Release", `whisper-cli${exe}`),
    join(buildDir, `whisper-cli${exe}`),
    join(buildDir, "main.exe"),
  ];
}

export function defaultWhisperBinaryPath() {
  const configured = process.env.HYPERFRAMES_WHISPER_PATH;
  if (configured && existsSync(configured)) return resolve(configured);
  return whisperBinaryCandidates().find((candidate) => existsSync(candidate)) || null;
}

export function defaultWhisperEnv() {
  const env = {
    HYPERFRAMES_WHISPER_MODELS_DIR: defaultWhisperModelDir(),
  };
  const binary = defaultWhisperBinaryPath();
  if (binary && !process.env.HYPERFRAMES_WHISPER_PATH) {
    env.HYPERFRAMES_WHISPER_PATH = binary;
  }
  return env;
}

function pathEntries() {
  return String(process.env.PATH || process.env.Path || "")
    .split(process.platform === "win32" ? ";" : ":")
    .filter(Boolean);
}

function findUnder(root, filename, maxDepth = 7, limit = 20) {
  const found = [];
  const needle = filename.toLowerCase();

  function visit(dir, depth) {
    if (found.length >= limit || depth < 0 || !existsSync(dir)) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === needle) {
        found.push(full);
        if (found.length >= limit) return;
      }
    }

    for (const entry of entries) {
      if (found.length >= limit) return;
      if (!entry.isDirectory()) continue;
      if (["node_modules", ".git", "Installer"].includes(entry.name)) continue;
      visit(join(dir, entry.name), depth - 1);
    }
  }

  visit(root, maxDepth);
  return found;
}

function windowsToolCandidates(name) {
  if (process.platform !== "win32") return [];
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const filename = name.toLowerCase().endsWith(".exe") ? name : `${name}.exe`;
  const candidates = [];

  if (filename === "cmake.exe") {
    candidates.push(
      join(programFiles, "CMake", "bin", "cmake.exe"),
      join(programFilesX86, "CMake", "bin", "cmake.exe"),
    );
    candidates.push(...findUnder(join(programFiles, "Microsoft Visual Studio"), "cmake.exe", 7, 8));
    candidates.push(...findUnder(join(programFilesX86, "Microsoft Visual Studio"), "cmake.exe", 7, 8));
    candidates.push(...findUnder(join(localAppData, "Microsoft", "WinGet", "Packages"), "cmake.exe", 5, 8));
  }

  if (filename === "git.exe") {
    candidates.push(
      join(programFiles, "Git", "cmd", "git.exe"),
      join(programFiles, "Git", "bin", "git.exe"),
      join(programFilesX86, "Git", "cmd", "git.exe"),
      join(programFilesX86, "Git", "bin", "git.exe"),
    );
    candidates.push(...findUnder(join(localAppData, "Microsoft", "WinGet", "Packages"), "git.exe", 5, 8));
  }

  if (filename === "cl.exe") {
    candidates.push(...findUnder(join(programFiles, "Microsoft Visual Studio"), "cl.exe", 9, 12));
    candidates.push(...findUnder(join(programFilesX86, "Microsoft Visual Studio"), "cl.exe", 9, 12));
  }

  if (filename === "clang.exe") {
    candidates.push(join(programFiles, "LLVM", "bin", "clang.exe"));
    candidates.push(...findUnder(join(programFiles, "Microsoft Visual Studio"), "clang.exe", 9, 12));
    candidates.push(...findUnder(join(programFilesX86, "Microsoft Visual Studio"), "clang.exe", 9, 12));
  }

  if (filename === "gcc.exe") {
    candidates.push(
      "C:\\msys64\\mingw64\\bin\\gcc.exe",
      "C:\\msys64\\ucrt64\\bin\\gcc.exe",
      "C:\\mingw64\\bin\\gcc.exe",
    );
  }

  if (filename === "ffmpeg.exe") {
    candidates.push(...findUnder(join(localAppData, "Microsoft", "WinGet", "Packages"), "ffmpeg.exe", 6, 8));
  }

  return candidates;
}

function resolvePathExecutable(name) {
  const filename =
    process.platform === "win32" && !name.toLowerCase().endsWith(".exe") ? `${name}.exe` : name;
  for (const dir of pathEntries()) {
    const candidate = join(dir, filename);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function findExecutable(name) {
  if (name.includes("/") || name.includes("\\")) return existsSync(name) ? resolve(name) : null;
  const fromPath = resolvePathExecutable(name);
  if (fromPath) return fromPath;
  return windowsToolCandidates(name).find((candidate) => existsSync(candidate)) || null;
}

export function envWithToolPaths(extraEnv = {}) {
  const dirs = [];
  for (const name of ["cmake.exe", "git.exe", "cl.exe", "clang.exe", "gcc.exe", "ffmpeg.exe"]) {
    const executable = findExecutable(name);
    if (executable) dirs.push(dirname(executable));
  }
  const delimiter = process.platform === "win32" ? ";" : ":";
  const currentPath = process.env.PATH || process.env.Path || "";
  return {
    ...process.env,
    PATH: [...new Set(dirs), currentPath].filter(Boolean).join(delimiter),
    Path: [...new Set(dirs), currentPath].filter(Boolean).join(delimiter),
    ...extraEnv,
  };
}
