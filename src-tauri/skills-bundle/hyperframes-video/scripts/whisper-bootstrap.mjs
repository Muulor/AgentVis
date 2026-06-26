#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
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
const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepo = "https://github.com/ggml-org/whisper.cpp.git";

function usage(exitCode = 0) {
  console.log(`Bootstrap local whisper.cpp for HyperFrames transcription

Usage:
  whisper-bootstrap.mjs [--model small-q8_0] [--model-dir <dir>] [--build-dir <dir>]
                        [--model-timeout-ms <ms>] [--model-progress-interval-ms <ms>]
                        [--skip-hf] [--skip-modelscope]

This downloads the ggml model and, only if no whisper-cli is available, clones
and builds whisper.cpp with git + cmake + a local C/C++ compiler.
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
  const label = [bin, ...binArgs].join(" ");
  if (!options.quiet) console.error(`\n$ ${label}`);
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd || process.cwd(),
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    shell: false,
    env: envWithToolPaths(options.env || {}),
  });
  return result;
}

function whichBinary(name) {
  return findExecutable(name);
}

function testBinary(candidate) {
  if (!candidate) return false;
  if ((candidate.includes("\\") || candidate.includes("/")) && !existsSync(candidate)) return false;
  const result = run(candidate, ["--help"], { capture: true, quiet: true });
  return !result.error && result.status === 0;
}

function findExistingWhisper() {
  const configured = defaultWhisperBinaryPath();
  if (configured && testBinary(configured)) return configured;
  for (const name of ["whisper-cli", "whisper"]) {
    const path = whichBinary(name);
    if (path && testBinary(path)) return path;
  }
  return null;
}

function ensureTool(name, installHint) {
  const path = whichBinary(name);
  if (path) return path;
  throw new Error(`${name} is required to build whisper.cpp. ${installHint}`);
}

function findBuiltBinary(buildDir) {
  return whisperBinaryCandidates(buildDir).find((candidate) => existsSync(candidate)) || null;
}

if (hasFlag("-h") || hasFlag("--help")) usage(0);

const model = takeFlag("--model", "small-q8_0");
const modelDir = resolve(takeFlag("--model-dir", takeFlag("--dir", defaultWhisperModelDir())));
const buildDir = resolve(takeFlag("--build-dir", defaultWhisperBuildDir()));
const buildPath = join(buildDir, "build");
const repo = takeFlag("--repo", defaultRepo);
const skipModel = hasFlag("--skip-model");
let modelTimeoutMs = takeFlag("--model-timeout-ms");
if (!modelTimeoutMs) modelTimeoutMs = takeFlag("--timeout-ms");
let modelProgressIntervalMs = takeFlag("--model-progress-interval-ms");
if (!modelProgressIntervalMs) modelProgressIntervalMs = takeFlag("--progress-interval-ms");
const skipHf = hasFlag("--skip-hf");
const skipModelScope = hasFlag("--skip-modelscope");
const clean = hasFlag("--clean");

if (clean && existsSync(buildDir)) {
  rmSync(buildDir, { recursive: true, force: true });
}

if (!skipModel) {
  const modelScript = resolve(scriptDir, "whisper-models.mjs");
  const modelArgs = [modelScript, "ensure", "--model", model, "--dir", modelDir];
  if (modelTimeoutMs) modelArgs.push("--timeout-ms", modelTimeoutMs);
  if (modelProgressIntervalMs) modelArgs.push("--progress-interval-ms", modelProgressIntervalMs);
  if (skipHf) modelArgs.push("--skip-hf");
  if (skipModelScope) modelArgs.push("--skip-modelscope");
  const modelResult = run(process.execPath, modelArgs);
  if (modelResult.error || modelResult.status !== 0) {
    process.exit(modelResult.status || 1);
  }
}

const existing = findExistingWhisper();
if (existing) {
  console.log(`whisper-cli ready: ${existing}`);
  console.log(`Whisper model dir: ${modelDir}`);
  process.exit(0);
}

let gitPath;
let cmakePath;
try {
  gitPath = ensureTool(isWin ? "git.exe" : "git", "Install Git or use an existing whisper-cli via HYPERFRAMES_WHISPER_PATH.");
  cmakePath = ensureTool(
    isWin ? "cmake.exe" : "cmake",
    "Install CMake or use an existing whisper-cli via HYPERFRAMES_WHISPER_PATH.",
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

if (!existsSync(buildDir)) {
  mkdirSync(dirname(buildDir), { recursive: true });
  const clone = run(gitPath, ["clone", "--depth", "1", repo, buildDir], {
    env: { GIT_TERMINAL_PROMPT: "0" },
  });
  if (clone.error || clone.status !== 0) process.exit(clone.status || 1);
}

const configure = run(cmakePath, ["-S", buildDir, "-B", buildPath, "-DCMAKE_BUILD_TYPE=Release"]);
if (configure.error || configure.status !== 0) {
  console.error(
    "CMake configure failed. Install a C/C++ compiler such as Visual Studio Build Tools, clang, or gcc, or set HYPERFRAMES_WHISPER_PATH to an existing whisper-cli.",
  );
  process.exit(configure.status || 1);
}

const build = run(cmakePath, ["--build", buildPath, "--config", "Release", "-j"]);
if (build.error || build.status !== 0) {
  console.error(
    "whisper.cpp build failed. Install a working C/C++ compiler toolchain, or set HYPERFRAMES_WHISPER_PATH to an existing whisper-cli.",
  );
  process.exit(build.status || 1);
}

const binary = findBuiltBinary(buildDir);
if (!binary || !testBinary(binary)) {
  console.error(`Build completed but whisper-cli was not found under ${buildDir}`);
  process.exit(1);
}

console.log(`whisper-cli ready: ${binary}`);
console.log(`Whisper model dir: ${modelDir}`);
console.log("This workflow helper will pass HYPERFRAMES_WHISPER_PATH automatically.");
