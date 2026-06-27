#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { defaultMossModelDir } from "./moss-paths.mjs";

const isWin = process.platform === "win32";
const args = process.argv.slice(2);
const scriptDir = dirname(fileURLToPath(import.meta.url));

function usage(exitCode = 0) {
  console.log(`Bootstrap a lightweight MOSS-TTS-Nano ONNX environment

Usage:
  moss-bootstrap.mjs --in-place --python <cmd> [options]
  moss-bootstrap.mjs --venv <dir> [options]

Options:
  --python <cmd>        Base Python for venv creation (default: python)
  --in-place           Use the existing Python runtime instead of creating a venv
  --source-dir <dir>    Existing MOSS-TTS-Nano checkout/source tree
  --models-dir <dir>    ONNX model parent dir (default: shared user cache)
  --skip-deps          Do not install Python dependencies; use preinstalled runtime deps
  --skip-models         Do not download/validate model weights
  --skip-hf             When downloading models, skip Hugging Face
  --skip-modelscope     When downloading models, skip ModelScope
  --model-timeout-ms <ms> Optional script-level timeout for each model file
  --model-progress-interval-ms <ms>
                       Optional model download heartbeat interval
  --skip-patch          Do not apply torch-free ONNX reference-audio patch
  --dry-run             Print planned commands without executing

This installs the MOSS package with --no-deps and only the ONNX inference
dependencies used by this skill. Do not use pip install git+... for this path.
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
  const label = [bin, ...binArgs].join(" ");
  if (options.dryRun) {
    console.log(`[dry-run] ${label}`);
    return { status: 0, stdout: "", stderr: "" };
  }
  console.error(`\n$ ${label}`);
  const command = isWin && bin.endsWith(".cmd") ? process.env.ComSpec || "cmd.exe" : bin;
  const commandArgs = command === bin ? binArgs : ["/d", "/s", "/c", bin, ...binArgs];
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd || process.cwd(),
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    shell: false,
  });
  if (options.capture) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  if (result.error || result.status !== 0) {
    const message = result.error ? result.error.message : `exit ${result.status}`;
    throw new Error(`${label} failed: ${message}`);
  }
  return result;
}

function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function samePath(left, right) {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return isWin ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase() : resolvedLeft === resolvedRight;
}

function isFile(path) {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path) {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function mossSourceStatus(sourceDir) {
  if (!existsSync(sourceDir)) return { ok: false, missing: ["source directory"], exists: false };

  const missing = [];
  if (!isFile(join(sourceDir, "pyproject.toml")) && !isFile(join(sourceDir, "setup.py"))) {
    missing.push("pyproject.toml or setup.py");
  }
  if (!isDir(join(sourceDir, "moss_tts_nano"))) missing.push("moss_tts_nano/");
  if (!isFile(join(sourceDir, "onnx_tts_runtime.py"))) missing.push("onnx_tts_runtime.py");

  return { ok: missing.length === 0, missing, exists: true };
}

function venvPython(venvDir) {
  return isWin ? join(venvDir, "Scripts", "python.exe") : join(venvDir, "bin", "python");
}

function mossBinForPython(pythonBin) {
  const pyDir = dirname(resolve(pythonBin));
  if (isWin) {
    const scriptsDir = pyDir.toLowerCase().endsWith("\\scripts") ? pyDir : join(pyDir, "Scripts");
    const expected = join(scriptsDir, "moss-tts-nano.exe");
    if (existsSync(expected)) return expected;

    const nested = join(scriptsDir, "Scripts", "moss-tts-nano.exe");
    if (existsSync(nested)) {
      try {
        copyFileSync(nested, expected);
        return expected;
      } catch {
        return nested;
      }
    }

    if (existsSync(scriptsDir)) {
      const candidate = readdirSync(scriptsDir).find((name) =>
        name.toLowerCase().startsWith("moss-tts-nano"),
      );
      if (candidate) return join(scriptsDir, candidate);
    }
    return expected;
  }
  return pyDir.endsWith("/bin") ? join(pyDir, "moss-tts-nano") : "moss-tts-nano";
}

function downloadSourceZip(pythonBin, sourceDir, options) {
  const parent = dirname(sourceDir);
  ensureDir(parent);
  const code = `
import shutil, urllib.request, zipfile
from pathlib import Path
target = Path(${JSON.stringify(sourceDir)})
tmp = target.with_suffix(".zip")
url = "https://codeload.github.com/OpenMOSS/MOSS-TTS-Nano/zip/refs/heads/main"
if target.exists():
    raise SystemExit(0)
urllib.request.urlretrieve(url, tmp)
extract_dir = target.parent / "_moss_tts_nano_extract"
if extract_dir.exists():
    shutil.rmtree(extract_dir)
with zipfile.ZipFile(tmp) as zf:
    zf.extractall(extract_dir)
inner = next(extract_dir.iterdir())
shutil.move(str(inner), str(target))
shutil.rmtree(extract_dir)
tmp.unlink(missing_ok=True)
`;
  run(pythonBin, ["-c", code], options);
}

function cloneOrDownloadSource(pythonBin, sourceDir, options) {
  if (options.dryRun) {
    console.log(`[dry-run] git clone --depth 1 https://github.com/OpenMOSS/MOSS-TTS-Nano.git ${sourceDir}`);
    return;
  }

  const clone = spawnSync("git", ["clone", "--depth", "1", "https://github.com/OpenMOSS/MOSS-TTS-Nano.git", sourceDir], {
    stdio: "inherit",
    encoding: "utf8",
    shell: false,
  });
  if (clone.error || clone.status !== 0) {
    rmSync(sourceDir, { recursive: true, force: true });
    downloadSourceZip(pythonBin, sourceDir, options);
  }
}

function printInvalidSourceObservation(sourceDir, status, managedSourceDir, defaultSourceDir) {
  console.error("Observation: moss_source_dir_invalid");
  console.error(`Source dir: ${sourceDir}`);
  console.error(`Missing: ${status.missing.join(", ")}`);
  if (managedSourceDir) {
    console.error("Repair: removing the managed source dir and fetching a clean MOSS-TTS-Nano checkout.");
  } else {
    console.error(`Next step: use a valid MOSS-TTS-Nano checkout or the managed source dir: ${defaultSourceDir}`);
  }
  console.error("Do not create pyproject.toml manually or install transformers for this ONNX CPU workflow.");
}

function ensureMossSourceDir(pythonBin, sourceDir, defaultSourceDir, options) {
  const managedSourceDir = samePath(sourceDir, defaultSourceDir);
  if (!existsSync(sourceDir)) {
    cloneOrDownloadSource(pythonBin, sourceDir, options);
  } else {
    const status = mossSourceStatus(sourceDir);
    if (!status.ok) {
      printInvalidSourceObservation(sourceDir, status, managedSourceDir, defaultSourceDir);
      if (!managedSourceDir) {
        throw new Error(`Invalid MOSS source directory: ${sourceDir}`);
      }
      if (options.dryRun) {
        console.log(`[dry-run] Remove invalid managed source dir: ${sourceDir}`);
      } else {
        rmSync(sourceDir, { recursive: true, force: true });
      }
      cloneOrDownloadSource(pythonBin, sourceDir, options);
    }
  }

  if (!options.dryRun) {
    const status = mossSourceStatus(sourceDir);
    if (!status.ok) {
      printInvalidSourceObservation(sourceDir, status, managedSourceDir, defaultSourceDir);
      throw new Error(`MOSS source directory is still invalid after bootstrap fetch: ${sourceDir}`);
    }
  }
}

if (hasFlag("-h") || hasFlag("--help")) usage(0);

const dryRun = hasFlag("--dry-run");
const basePython = takeFlag("--python", process.env.PYTHON || "python");
const inPlace = hasFlag("--in-place");
const venvFlag = takeFlag("--venv");
if (!inPlace && !venvFlag) usage(1);
const venvDir = venvFlag ? resolve(venvFlag) : null;
const runtimeRoot = inPlace ? process.cwd() : dirname(venvDir);
const defaultSourceDir = resolve(join(runtimeRoot, ".moss", "MOSS-TTS-Nano"));
const sourceDir = resolve(takeFlag("--source-dir", defaultSourceDir));
const modelsDir = resolve(takeFlag("--models-dir", defaultMossModelDir()));
const skipDeps = hasFlag("--skip-deps");
const skipModels = hasFlag("--skip-models");
const skipHf = hasFlag("--skip-hf");
const skipModelScope = hasFlag("--skip-modelscope");
let modelTimeoutMs = takeFlag("--model-timeout-ms");
if (!modelTimeoutMs) modelTimeoutMs = takeFlag("--timeout-ms");
let modelProgressIntervalMs = takeFlag("--model-progress-interval-ms");
if (!modelProgressIntervalMs) modelProgressIntervalMs = takeFlag("--progress-interval-ms");
const skipPatch = hasFlag("--skip-patch");
const options = { dryRun };

try {
  if (!inPlace && !existsSync(venvPython(venvDir))) {
    ensureDir(dirname(venvDir));
    run(basePython, ["-m", "venv", venvDir], options);
  }

  const py = inPlace ? basePython : venvPython(venvDir);
  if (!skipDeps) {
    run(py, ["-m", "pip", "install", "--upgrade", "pip"], options);
    run(
      py,
      [
        "-m",
        "pip",
        "install",
        "numpy",
        "sentencepiece",
        "onnxruntime",
        "huggingface_hub",
        "soundfile",
      ],
      options,
    );
  }

  ensureMossSourceDir(py, sourceDir, defaultSourceDir, options);

  run(py, ["-m", "pip", "install", "--no-deps", "-e", sourceDir], options);

  if (!skipPatch) {
    run(process.execPath, [join(scriptDir, "moss-patch-onnx-torchfree.mjs"), "--python", py], options);
  }

  if (!skipModels) {
    const modelArgs = [join(scriptDir, "moss-models.mjs"), "ensure", "--dir", modelsDir, "--python", py];
    if (skipHf) modelArgs.push("--skip-hf");
    if (skipModelScope) modelArgs.push("--skip-modelscope");
    if (modelTimeoutMs) modelArgs.push("--timeout-ms", modelTimeoutMs);
    if (modelProgressIntervalMs) modelArgs.push("--progress-interval-ms", modelProgressIntervalMs);
    run(process.execPath, modelArgs, options);
  }

  if (!dryRun) {
    run(
      process.execPath,
      [
        join(scriptDir, "moss-doctor.mjs"),
        "--python",
        py,
        "--moss-bin",
        mossBinForPython(py),
        "--model-dir",
        modelsDir,
      ],
      { capture: true },
    );
  }

  const summary = {
    ok: true,
    python: py,
    mossBin: mossBinForPython(py),
    sourceDir,
    modelsDir,
    nextMossAudioFlags: `--moss-bin ${mossBinForPython(py)} --onnx-model-dir ${modelsDir}`,
  };
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(error.message);
  console.error("Next step: run moss-doctor with --json, then execute its nextCommand.");
  process.exit(1);
}
