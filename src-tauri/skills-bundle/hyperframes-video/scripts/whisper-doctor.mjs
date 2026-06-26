#!/usr/bin/env node
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { whisperModelFilename, whisperModelStatus } from "./whisper-model-info.mjs";
import {
  defaultWhisperBinaryPath,
  defaultWhisperBuildDir,
  defaultWhisperModelDir,
  envWithToolPaths,
  findExecutable,
  whisperBinaryCandidates,
} from "./whisper-paths.mjs";

const isWin = process.platform === "win32";
const args = process.argv.slice(2);
const modelScopeRepo = "iceCream2025/whisper.cpp";

function usage(exitCode = 0) {
  console.log(`Diagnose local whisper.cpp support for HyperFrames

Usage:
  whisper-doctor.mjs [--model small-q8_0] [--json] [--no-smoke-test]

Exit code is 0 only when local transcription can run without starting a build.
`);
  process.exit(exitCode);
}

function takeFlag(name, fallback = undefined) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  args.splice(index, value && !value.startsWith("--") ? 2 : 1);
  return value && !value.startsWith("--") ? value : fallback;
}

function hasFlag(name) {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function run(bin, binArgs, options = {}) {
  const command = isWin && bin.endsWith(".cmd") ? process.env.ComSpec || "cmd.exe" : bin;
  const commandArgs = command === bin ? binArgs : ["/d", "/s", "/c", bin, ...binArgs];
  return spawnSync(command, commandArgs, {
    cwd: options.cwd || process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    shell: false,
    env: envWithToolPaths(options.env || {}),
  });
}

function whichBinary(name) {
  return findExecutable(name);
}

function toolInfo(name) {
  const path = whichBinary(name);
  if (!path) return { ok: false, path: null };
  const version = run(path, ["--version"]);
  const output = `${version.stdout || ""}${version.stderr || ""}`.trim().split(/\r?\n/)[0] || null;
  return { ok: true, path, version: output };
}

function testWhisperCandidate(candidate, source) {
  if (!candidate || (candidate.includes("\\") || candidate.includes("/")) && !existsSync(candidate)) {
    return null;
  }
  const result = run(candidate, ["--help"]);
  if (!result.error && result.status === 0) {
    return { ok: true, path: candidate, source };
  }
  return {
    ok: false,
    path: candidate,
    source,
    error: result.error ? result.error.message : String(result.stderr || result.stdout || "").trim().slice(0, 240),
  };
}

function makeSilenceWav(file, seconds = 0.3, sampleRate = 16000) {
  const samples = Math.max(1, Math.round(seconds * sampleRate));
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  writeFileSync(file, buffer);
}

function formatExit(result) {
  if (result.error) return result.error.message;
  if (result.signal) return `signal ${result.signal}`;
  if (typeof result.status === "number") return `exit ${result.status}`;
  return "process failed";
}

function smokeTestWhisper(whisper, modelPath) {
  if (!whisper.ok || !modelPath) return null;
  const tempDir = mkdtempSync(join(tmpdir(), "hf-whisper-smoke-"));
  try {
    const wav = join(tempDir, "silence.wav");
    const outputBase = join(tempDir, "smoke");
    makeSilenceWav(wav);
    const result = run(whisper.path, [
      "-m",
      modelPath,
      "-f",
      wav,
      "-otxt",
      "-of",
      outputBase,
      "-t",
      "1",
      "--no-prints",
    ]);
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    if (!result.error && result.status === 0) {
      return { ok: true };
    }
    return {
      ok: false,
      exit: formatExit(result),
      output: output.slice(0, 800),
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function findWhisper() {
  const attempts = [];
  const configured = process.env.HYPERFRAMES_WHISPER_PATH;
  if (configured) attempts.push(testWhisperCandidate(resolve(configured), "env"));

  const built = defaultWhisperBinaryPath();
  if (built) attempts.push(testWhisperCandidate(built, "hyperframes-video-build"));

  for (const candidate of whisperBinaryCandidates()) {
    attempts.push(testWhisperCandidate(candidate, "hyperframes-video-build"));
  }

  for (const name of ["whisper-cli", "whisper"]) {
    const path = whichBinary(name);
    if (path) attempts.push(testWhisperCandidate(path, "system"));
  }

  const cleaned = attempts.filter(Boolean);
  return cleaned.find((attempt) => attempt.ok) || {
    ok: false,
    path: null,
    source: null,
    attempts: cleaned,
  };
}

function findVsWhere() {
  if (!isWin) return null;
  const fromPath = findExecutable("vswhere.exe");
  if (fromPath) return fromPath;
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  if (!programFilesX86) return null;
  const candidate = join(programFilesX86, "Microsoft Visual Studio", "Installer", "vswhere.exe");
  return existsSync(candidate) ? candidate : null;
}

function modelStatus(model, modelDir) {
  const status = whisperModelStatus(model, modelDir);
  return {
    ...status,
    model,
    dir: modelDir,
    url: modelUrl(model),
    modelScopeUrl: modelScopeUrl(model),
    filename: whisperModelFilename(model),
  };
}

function modelUrl(model) {
  return `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin`;
}

function modelScopeUrl(model) {
  return `https://modelscope.cn/api/v1/models/${modelScopeRepo}/resolve/master/ggml-${model}.bin`;
}

if (hasFlag("-h") || hasFlag("--help")) usage(0);

const emitJson = hasFlag("--json");
const smokeTest = !hasFlag("--no-smoke-test");
const model = takeFlag("--model", "small-q8_0");
const modelDir = resolve(takeFlag("--model-dir", takeFlag("--dir", defaultWhisperModelDir())));
const buildDir = resolve(takeFlag("--build-dir", defaultWhisperBuildDir()));

const whisper = findWhisper();
const models = modelStatus(model, modelDir);
const ffmpeg = toolInfo(isWin ? "ffmpeg.exe" : "ffmpeg");
const tools = {
  git: toolInfo(isWin ? "git.exe" : "git"),
  cmake: toolInfo(isWin ? "cmake.exe" : "cmake"),
  cl: toolInfo(isWin ? "cl.exe" : "cl"),
  gcc: toolInfo(isWin ? "gcc.exe" : "gcc"),
  clang: toolInfo(isWin ? "clang.exe" : "clang"),
  vswhere: { ok: Boolean(findVsWhere()), path: findVsWhere() },
};
const compilerLikely =
  tools.cl.ok || tools.gcc.ok || tools.clang.ok || (isWin && Boolean(tools.vswhere.path));
const canBuild = tools.git.ok && tools.cmake.ok && compilerLikely;

const issues = [];
const warnings = [];
const recommendedCommands = [];
const hfDownloadCommand =
  `node scripts/hf-workflow.mjs whisper-models --model ${model} --dir ${modelDir} --skip-modelscope`;
const modelScopeDownloadCommand =
  `node scripts/hf-workflow.mjs whisper-models --model ${model} --dir ${modelDir} --skip-hf`;
const buildCommand =
  `node scripts/hf-workflow.mjs whisper-bootstrap --model ${model} --model-dir ${modelDir} --build-dir ${buildDir} --skip-model`;
const cleanBuildCommand =
  `node scripts/hf-workflow.mjs whisper-bootstrap --model ${model} --model-dir ${modelDir} --build-dir ${buildDir} --skip-model --clean`;

if (!whisper.ok) {
  issues.push({
    code: "whisper_cli_missing",
    message: "whisper-cli was not found. HyperFrames cannot transcribe until whisper.cpp is installed or built.",
  });
}

if (!models.ok) {
  const reason =
    models.reason === "too_small"
      ? ` It is ${models.size} bytes, expected at least ${models.expectedMinBytes} bytes.`
      : models.reason === "git_lfs_pointer"
        ? " The file is a Git LFS pointer, not the real model binary."
        : "";
  issues.push({
    code: "model_missing",
    message: `${whisperModelFilename(model)} is missing or incomplete under ${modelDir}.${reason}`,
    manualDownloadUrl: models.url,
    manualDownloadUrls: [models.url, models.modelScopeUrl],
    manualModelScopeUrl: models.modelScopeUrl,
    manualDownloadPath: models.path,
    agentSafeDownloadCommands: [hfDownloadCommand, modelScopeDownloadCommand],
  });
  recommendedCommands.push(hfDownloadCommand, modelScopeDownloadCommand);
}

const runtime = smokeTest && whisper.ok && models.ok ? smokeTestWhisper(whisper, models.path) : null;
if (runtime && !runtime.ok) {
  issues.push({
    code: "whisper_runtime_failed",
    message:
      "whisper-cli starts, but crashes or fails when loading the selected model for a minimal transcription smoke test. This often happens when a whisper.cpp build cache was copied from another machine, the model file is corrupt/partial, or native runtime dependencies do not match this host.",
    exit: runtime.exit,
    output: runtime.output,
  });
  if (canBuild) recommendedCommands.push(cleanBuildCommand);
}

if (!whisper.ok && canBuild) recommendedCommands.push(buildCommand);

if (!ffmpeg.ok) {
  issues.push({
    code: "ffmpeg_missing",
    message: "ffmpeg is required for most audio/video transcription inputs.",
  });
}

if (!whisper.ok && !canBuild) {
  const missing = [];
  if (!tools.git.ok) missing.push("git");
  if (!tools.cmake.ok) missing.push("cmake");
  if (!compilerLikely) missing.push(isWin ? "C/C++ compiler (Visual Studio Build Tools, clang, or gcc)" : "C/C++ compiler");
  warnings.push({
    code: "build_tools_missing",
    message: `Cannot auto-build whisper.cpp because these build tools are missing or not discoverable: ${missing.join(", ")}.`,
  });
  if (!models.ok) {
    warnings.push({
      code: "model_download_deferred",
      message: "The Whisper model can be downloaded with whisper-models after a whisper-cli binary or build toolchain is available.",
    });
  }
}

const result = {
  ok: issues.length === 0,
  whisper,
  models,
  ffmpeg,
  tools,
  canBuild,
  buildDir,
  smokeTest: runtime,
  issues,
  warnings,
  nextCommand: recommendedCommands[0] || null,
  recommendedCommands: [...new Set(recommendedCommands)],
};

if (emitJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`Whisper doctor: ${result.ok ? "ready" : "not ready"}`);
  console.log(`whisper-cli: ${result.whisper.ok ? `${result.whisper.path} (${result.whisper.source})` : "missing"}`);
  console.log(`model: ${result.models.ok ? result.models.path : `missing ${result.models.path}`}`);
  if (result.models.ok && result.smokeTest) {
    console.log(`runtime smoke test: ${result.smokeTest.ok ? "passed" : `failed (${result.smokeTest.exit})`}`);
  } else if (result.models.ok && !smokeTest) {
    console.log("runtime smoke test: skipped");
  }
  console.log(`ffmpeg: ${result.ffmpeg.ok ? result.ffmpeg.path : "missing"}`);
  console.log(`can build whisper.cpp: ${result.canBuild ? "yes" : "no"}`);
  if (result.issues.length) {
    console.log("Issues:");
    for (const issue of result.issues) console.log(`- ${issue.code}: ${issue.message}`);
  }
  if (result.warnings.length) {
    console.log("Warnings:");
    for (const warning of result.warnings) console.log(`- ${warning.code}: ${warning.message}`);
  }
  if (result.recommendedCommands.length > 1) {
    console.log("Recommended commands:");
    for (const command of result.recommendedCommands) console.log(`  ${command}`);
  } else if (result.nextCommand) {
    console.log(`Next command: ${result.nextCommand}`);
  }
}

process.exit(result.ok ? 0 : 1);
