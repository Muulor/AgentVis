#!/usr/bin/env node
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  DEFAULT_PROGRESS_INTERVAL_MS,
  downloadFile,
  parsePositiveMilliseconds,
} from "./download-file.mjs";
import { defaultMossModelDir } from "./moss-paths.mjs";

const isWin = process.platform === "win32";
const args = process.argv.slice(2);

const repos = [
  {
    label: "tts",
    dirName: "MOSS-TTS-Nano-100M-ONNX",
    hfRepo: "OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX",
    modelScopeRepo: "openmoss/MOSS-TTS-Nano-100M-ONNX",
    allowPatterns: ["*.onnx", "*.data", "*.json", "tokenizer.model"],
    required: [
      "browser_poc_manifest.json",
      "tts_browser_onnx_meta.json",
      "tokenizer.model",
      "moss_tts_prefill.onnx",
      "moss_tts_decode_step.onnx",
      "moss_tts_global_shared.data",
      "moss_tts_local_shared.data",
    ],
  },
  {
    label: "codec",
    dirName: "MOSS-Audio-Tokenizer-Nano-ONNX",
    hfRepo: "OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX",
    modelScopeRepo: "openmoss/MOSS-Audio-Tokenizer-Nano-ONNX",
    allowPatterns: ["*.onnx", "*.data", "*.json", "README.md"],
    required: [
      "codec_browser_onnx_meta.json",
      "moss_audio_tokenizer_encode.onnx",
      "moss_audio_tokenizer_encode.data",
      "moss_audio_tokenizer_decode_step.onnx",
      "moss_audio_tokenizer_decode_shared.data",
      "moss_audio_tokenizer_decode_full.onnx",
    ],
  },
];

function usage(exitCode = 0) {
  console.log(`Prepare MOSS-TTS-Nano ONNX model assets

Usage:
  moss-models.mjs ensure [--dir <model-parent-dir>] [options]

Options:
  --python <cmd>       Python with huggingface_hub installed (default: python)
  --skip-hf           Do not try Hugging Face first
  --skip-modelscope   Do not fall back to ModelScope direct downloads
  --timeout-ms <ms>    Optional script-level network timeout for each file
  --progress-interval-ms <ms>
                       Optional download heartbeat interval (default: 30000;
                       first progress line appears after about 15000 ms)

The target directory is the parent passed later to:
  moss-tts-nano generate --backend onnx --onnx-model-dir <model-parent-dir>
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
  });
  if (options.capture && !options.silent) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  return result;
}

function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function isComplete(repo, parentDir) {
  const dir = join(parentDir, repo.dirName);
  return repo.required.every((name) => fileReady(join(dir, name)));
}

function fileReady(file) {
  if (!existsSync(file) || statSync(file).size <= 0) return false;
  const buffer = Buffer.alloc(160);
  let fd = null;
  try {
    fd = openSync(file, "r");
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytesRead).toString("utf8");
    return !head.includes("version https://git-lfs.github.com/spec/v1");
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function missingFiles(repo, targetDir) {
  return repo.required.filter((name) => !fileReady(join(targetDir, name)));
}

function hfRepoUrl(repo) {
  return `https://huggingface.co/${repo.hfRepo}`;
}

function modelScopeRepoUrl(repo) {
  return `https://modelscope.cn/models/${repo.modelScopeRepo}`;
}

function modelScopeFileUrl(repo, file) {
  const encoded = file.split("/").map(encodeURIComponent).join("/");
  return `https://modelscope.cn/api/v1/models/${repo.modelScopeRepo}/resolve/master/${encoded}`;
}

function manualDownloadLines(repo, targetDir) {
  const lines = [
    "Observation: moss_model_download_failed",
    `${repo.dirName}: required ONNX model files could not be downloaded automatically.`,
    "Manual download:",
    `  Hugging Face repo: ${hfRepoUrl(repo)}`,
    `  ModelScope repo: ${modelScopeRepoUrl(repo)}`,
    `  Target directory: ${targetDir}`,
    "  Required files:",
  ];
  for (const file of missingFiles(repo, targetDir)) {
    lines.push(`    ${file}`);
  }
  return lines;
}

function printManualDownload(repo, targetDir) {
  for (const line of manualDownloadLines(repo, targetDir)) console.error(line);
}

function pythonDownload(repo, targetDir, pythonBin) {
  ensureDir(dirname(targetDir));
  const code = `
from huggingface_hub import snapshot_download
snapshot_download(
    repo_id=${JSON.stringify(repo.hfRepo)},
    local_dir=${JSON.stringify(targetDir)},
    local_dir_use_symlinks=False,
    allow_patterns=${JSON.stringify(repo.allowPatterns)},
)
`;
  return run(pythonBin, ["-c", code], { allowFailure: true });
}

async function modelScopeDownload(repo, targetDir, timeoutMs, progressIntervalMs) {
  ensureDir(targetDir);
  const failures = [];
  for (const file of repo.required) {
    const target = join(targetDir, file);
    if (fileReady(target)) continue;
    const url = modelScopeFileUrl(repo, file);
    console.error(`${repo.dirName}: downloading ${file} from ModelScope`);
    console.error(url);
    try {
      await downloadFile(url, target, {
        allowedStatusCodes: [200, 206],
        progressIntervalMs,
        progressLabel: `${repo.dirName}/${file}`,
        timeoutMs,
        userAgent: "hyperframes-video-moss-models",
      });
      if (!fileReady(target)) failures.push(`${file}: downloaded file is empty or a git-lfs pointer`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${file}: ${message}`);
      console.error(`${repo.dirName}: ModelScope file download failed: ${message}`);
    }
  }
  return failures;
}

if (hasFlag("-h") || hasFlag("--help")) usage(0);
const cmd = args.shift();
if (cmd !== "ensure") usage(1);

const modelDir = resolve(takeFlag("--dir", takeFlag("--model-dir", defaultMossModelDir())));
const pythonBin = takeFlag("--python", process.env.PYTHON || "python");
const skipHf = hasFlag("--skip-hf");
const skipModelScope = hasFlag("--skip-modelscope");
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

ensureDir(modelDir);

for (const repo of repos) {
  const targetDir = join(modelDir, repo.dirName);
  if (isComplete(repo, modelDir)) {
    console.error(`${repo.dirName}: already complete`);
    continue;
  }

  let ok = false;
  if (!skipHf) {
    console.error(`${repo.dirName}: downloading from Hugging Face`);
    const result = pythonDownload(repo, targetDir, pythonBin);
    ok = !result.error && result.status === 0 && isComplete(repo, modelDir);
    if (!ok) console.error(`${repo.dirName}: Hugging Face download incomplete; trying fallback`);
  }

  if (!ok && !skipModelScope) {
    console.error(`${repo.dirName}: downloading from ModelScope`);
    const failures = await modelScopeDownload(repo, targetDir, timeoutMs, progressIntervalMs);
    ok = failures.length === 0 && isComplete(repo, modelDir);
    if (!ok && failures.length) {
      console.error(`${repo.dirName}: ModelScope failures:`);
      for (const failure of failures) console.error(`- ${failure}`);
    }
  }

  if (!ok) {
    const missing = missingFiles(repo, targetDir);
    console.error(`${repo.dirName}: missing required file(s): ${missing.join(", ")}`);
    printManualDownload(repo, targetDir);
    process.exit(1);
  }

  console.error(`${repo.dirName}: ready`);
}

console.log(`MOSS ONNX model dir ready: ${modelDir}`);
console.log(`Use with: --onnx-model-dir ${modelDir}`);
