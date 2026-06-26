#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PROGRESS_INTERVAL_MS,
  downloadFile,
  parsePositiveMilliseconds,
} from "./download-file.mjs";
import { whisperModelPath, whisperModelStatus } from "./whisper-model-info.mjs";
import { defaultWhisperModelDir } from "./whisper-paths.mjs";

const args = process.argv.slice(2);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const modelScopeRepo = "iceCream2025/whisper.cpp";

function usage(exitCode = 0) {
  console.log(`Prepare ggml Whisper model assets

Usage:
  whisper-models.mjs ensure [--model small-q8_0] [--dir <model-dir>] [--timeout-ms <ms>]
                            [--skip-hf] [--skip-modelscope] [--progress-interval-ms <ms>]

The target directory contains files such as ggml-small-q8_0.bin and is passed to
HyperFrames through HYPERFRAMES_WHISPER_MODELS_DIR.

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

function modelUrl(model) {
  return `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin`;
}

function modelScopeUrl(model) {
  return `https://modelscope.cn/api/v1/models/${modelScopeRepo}/resolve/master/ggml-${model}.bin`;
}

function modelPath(model, modelDir) {
  return whisperModelPath(model, modelDir);
}

function manualDownloadLines(model, modelDir) {
  const target = modelPath(model, modelDir);
  return [
    "Observation: whisper_model_download_failed",
    "The ggml Whisper model could not be downloaded automatically. This is usually a network, proxy, mirror, or timeout issue.",
    "Manual download:",
    `  Hugging Face URL: ${modelUrl(model)}`,
    `  ModelScope URL: ${modelScopeUrl(model)}`,
    `  Save as: ${target}`,
    `  Directory: ${modelDir}`,
    `  Expected filename: ${basename(target)}`,
    "Do not download *.mlmodelc.zip for the default Windows/Linux CPU workflow; those are optional Apple Core ML encoder assets.",
    "After placing the file, rerun:",
    `  node "${join(scriptDir, "hf-workflow.mjs")}" whisper-doctor --model ${model} --json`,
  ];
}

function printManualDownload(model, modelDir) {
  for (const line of manualDownloadLines(model, modelDir)) console.error(line);
}

function modelReady(model, modelDir) {
  return whisperModelStatus(model, modelDir).ok;
}

function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

if (hasFlag("-h") || hasFlag("--help")) usage(0);
const cmd = args.shift();
if (cmd !== "ensure") usage(1);

const model = takeFlag("--model", "small-q8_0");
const modelDir = resolve(takeFlag("--dir", takeFlag("--model-dir", defaultWhisperModelDir())));
const timeoutValue = takeFlag("--timeout-ms");
const timeoutMs = timeoutValue ? Number(timeoutValue) : null;
if (timeoutValue && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
  console.error("--timeout-ms must be a positive number of milliseconds.");
  process.exit(1);
}
const progressValue = takeFlag("--progress-interval-ms", process.env.HYPERFRAMES_MODEL_PROGRESS_MS);
let progressIntervalMs = DEFAULT_PROGRESS_INTERVAL_MS;
if (progressValue) {
  try {
    progressIntervalMs = parsePositiveMilliseconds(progressValue, "--progress-interval-ms");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
const skipHf = hasFlag("--skip-hf");
const skipModelScope = hasFlag("--skip-modelscope");
const target = modelPath(model, modelDir);

ensureDir(modelDir);

if (modelReady(model, modelDir)) {
  console.log(`Whisper model ready: ${target}`);
  process.exit(0);
}

const sources = [
  !skipHf && { label: "Hugging Face", url: modelUrl(model) },
  !skipModelScope && { label: "ModelScope", url: modelScopeUrl(model) },
].filter(Boolean);

if (!sources.length) {
  console.error("No model download source enabled.");
  printManualDownload(model, modelDir);
  process.exit(1);
}

const failures = [];
for (const source of sources) {
  console.error(`Downloading ggml Whisper model ${model} from ${source.label}...`);
  console.error(source.url);
  try {
    await downloadFile(source.url, target, {
      allowedStatusCodes: [200, 206],
      progressIntervalMs,
      progressLabel: `ggml-${model}.bin`,
      timeoutMs,
      userAgent: "hyperframes-video-whisper-models",
    });
    if (modelReady(model, modelDir)) {
      console.log(`Whisper model ready: ${target}`);
      process.exit(0);
    }
    failures.push(`${source.label}: downloaded file was incomplete`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${source.label}: ${message}`);
    console.error(`${source.label} download failed: ${message}`);
  }
}

console.error("All configured Whisper model download sources failed:");
for (const failure of failures) console.error(`- ${failure}`);
printManualDownload(model, modelDir);
process.exit(1);
