#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { defaultMossModelDir } from "./moss-paths.mjs";

const isWin = process.platform === "win32";
const args = process.argv.slice(2);

const repos = [
  {
    dirName: "MOSS-TTS-Nano-100M-ONNX",
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
    dirName: "MOSS-Audio-Tokenizer-Nano-ONNX",
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
  console.log(`Diagnose MOSS-TTS-Nano ONNX dependencies for HyperFrames

Usage:
  moss-doctor.mjs [options]

Options:
  --python <cmd>       Python environment to inspect (default: python)
  --moss-bin <cmd>     MOSS CLI to test (default: auto)
  --model-dir <dir>    Parent model dir containing both ONNX repos (default: shared user cache)
  --json               Emit machine-readable JSON only

Exit code is 0 only when the MOSS ONNX path is ready for generated narration.
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
  });
}

function jsonFromPython(pythonBin) {
  const code = `
import importlib.util, json, sys
mods = ["numpy", "sentencepiece", "onnxruntime", "huggingface_hub", "soundfile", "moss_tts_nano", "onnx_tts_runtime", "torch", "torchaudio"]
found = {name: (importlib.util.find_spec(name) is not None) for name in mods}
spec = importlib.util.find_spec("onnx_tts_runtime")
print(json.dumps({
  "executable": sys.executable,
  "version": sys.version,
  "version_info": list(sys.version_info[:3]),
  "modules": found,
  "onnx_tts_runtime": spec.origin if spec and spec.origin else None,
}, ensure_ascii=False))
`;
  const result = run(pythonBin, ["-c", code]);
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      error: result.error ? result.error.message : String(result.stderr || result.stdout || "").trim(),
    };
  }
  try {
    return { ok: true, ...JSON.parse(result.stdout) };
  } catch (error) {
    return { ok: false, error: `Could not parse Python probe output: ${error.message}` };
  }
}

function candidateMossBins(pythonInfo, explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.MOSS_TTS_NANO_BIN) candidates.push(process.env.MOSS_TTS_NANO_BIN);
  if (process.env.VIRTUAL_ENV) {
    if (isWin) {
      candidates.push(join(process.env.VIRTUAL_ENV, "Scripts", "moss-tts-nano.exe"));
      candidates.push(join(process.env.VIRTUAL_ENV, "Scripts", "Scripts", "moss-tts-nano.exe"));
    } else {
      candidates.push(join(process.env.VIRTUAL_ENV, "bin", "moss-tts-nano"));
    }
  }
  if (pythonInfo?.executable) {
    const pyDir = dirname(pythonInfo.executable);
    if (isWin) {
      const scriptsDir = pyDir.toLowerCase().endsWith("\\scripts") ? pyDir : join(pyDir, "Scripts");
      candidates.push(join(scriptsDir, "moss-tts-nano.exe"));
      candidates.push(join(scriptsDir, "Scripts", "moss-tts-nano.exe"));
      if (existsSync(scriptsDir)) {
        for (const name of readdirSync(scriptsDir)) {
          if (name.toLowerCase().startsWith("moss-tts-nano")) candidates.push(join(scriptsDir, name));
        }
      }
    } else {
      candidates.push(pyDir.endsWith("/bin") ? join(pyDir, "moss-tts-nano") : "moss-tts-nano");
    }
  }
  candidates.push("moss-tts-nano");
  return [...new Set(candidates.filter(Boolean))];
}

function testMossBin(candidates) {
  const attempts = [];
  for (const candidate of candidates) {
    const result = run(candidate, ["--help"]);
    attempts.push({
      candidate,
      status: result.status,
      error: result.error ? result.error.message : null,
      stderr: String(result.stderr || "").trim().slice(0, 300),
    });
    if (!result.error && result.status === 0) {
      return { ok: true, bin: candidate, attempts };
    }
  }
  return { ok: false, bin: null, attempts };
}

function checkModels(modelDir) {
  const missing = [];
  for (const repo of repos) {
    for (const name of repo.required) {
      const file = join(modelDir, repo.dirName, name);
      if (!existsSync(file) || statSync(file).size <= 0) {
        missing.push(join(repo.dirName, name).replace(/\\/g, "/"));
      }
    }
  }
  return { ok: missing.length === 0, dir: modelDir, missing };
}

function patchStatus(runtimePath) {
  if (!runtimePath || !existsSync(runtimePath)) return { ok: false, status: "missing" };
  const source = readFileSync(runtimePath, "utf8");
  if (
    source.includes("torch-free reference audio loader patch") ||
    source.includes("torch-free reference audio loader patch")
  ) {
    return { ok: true, status: "torchfree-patched" };
  }
  if (!source.includes("import torchaudio") && !source.includes("import torch")) {
    return { ok: true, status: "already-torchfree-or-upstream-fixed" };
  }
  return { ok: false, status: "imports-torch-torchaudio" };
}

if (hasFlag("-h") || hasFlag("--help")) usage(0);

const emitJson = hasFlag("--json");
const pythonBin = takeFlag("--python", process.env.PYTHON || "python");
const explicitMossBin = takeFlag("--moss-bin");
const modelDir = resolve(takeFlag("--model-dir", defaultMossModelDir()));

const python = jsonFromPython(pythonBin);
const mossCli = python.ok ? testMossBin(candidateMossBins(python, explicitMossBin)) : { ok: false, bin: null, attempts: [] };
const models = checkModels(modelDir);
const patch = python.ok ? patchStatus(python.onnx_tts_runtime) : { ok: false, status: "python-probe-failed" };
const issues = [];
const warnings = [];
const recommendedCommands = [];
const bootstrapCommand =
  `node scripts/hf-workflow.mjs moss-bootstrap --in-place --python ${pythonBin} --source-dir ./.moss/MOSS-TTS-Nano --models-dir ${modelDir} --skip-models`;
const hfModelsCommand =
  `node scripts/hf-workflow.mjs moss-models --dir ${modelDir} --python ${pythonBin} --skip-modelscope`;
const modelScopeModelsCommand =
  `node scripts/hf-workflow.mjs moss-models --dir ${modelDir} --python ${pythonBin} --skip-hf`;

if (!python.ok) {
  issues.push({ code: "python_unusable", message: python.error || "Python probe failed" });
}
if (python.ok) {
  const [major, minor] = python.version_info;
  if (major !== 3 || minor < 10 || minor > 12) {
    warnings.push({
      code: "python_version_untested",
      message: `Python 3.10-3.12 is the most tested lightweight ONNX path; detected ${major}.${minor}. Continue if dependencies install and doctor passes.`,
    });
  }
  for (const mod of ["numpy", "sentencepiece", "onnxruntime", "huggingface_hub", "soundfile"]) {
    if (!python.modules[mod]) {
      issues.push({ code: `missing_${mod}`, message: `Python module missing: ${mod}` });
    }
  }
  if (!python.modules.moss_tts_nano || !python.modules.onnx_tts_runtime) {
    issues.push({
      code: "moss_package_missing",
      message: "MOSS-TTS-Nano is not installed in this Python environment.",
    });
  }
}
if (!mossCli.ok) {
  issues.push({ code: "moss_cli_missing", message: "moss-tts-nano CLI was not found or did not run." });
}
if (!models.ok) {
  issues.push({
    code: "models_missing",
    message: `MOSS ONNX model files are missing under ${modelDir}.`,
    missing: models.missing.slice(0, 8),
    agentSafeDownloadCommands: [hfModelsCommand, modelScopeModelsCommand],
    manualModelScopeRepos: [
      "https://modelscope.cn/models/openmoss/MOSS-TTS-Nano-100M-ONNX",
      "https://modelscope.cn/models/openmoss/MOSS-Audio-Tokenizer-Nano-ONNX",
    ],
  });
  recommendedCommands.push(hfModelsCommand, modelScopeModelsCommand);
}
if (python.ok && python.modules.onnx_tts_runtime && !patch.ok) {
  issues.push({
    code: "torchfree_patch_missing",
    message: "ONNX runtime still imports torch/torchaudio; built-in voices may work only if shimmed, and prompt-speech cloning may fail.",
  });
  recommendedCommands.push(`node scripts/hf-workflow.mjs moss-patch-torchfree --python ${pythonBin}`);
}

if (issues.some((issue) => issue.code.startsWith("missing_") || issue.code === "moss_package_missing" || issue.code === "moss_cli_missing")) {
  recommendedCommands.unshift(bootstrapCommand);
}

const result = {
  ok: issues.length === 0,
  python: {
    requested: pythonBin,
    ok: python.ok,
    executable: python.executable || null,
    version: python.version || null,
    modules: python.modules || {},
    onnx_tts_runtime: python.onnx_tts_runtime || null,
  },
  mossCli,
  models,
  torchFreePatch: patch,
  capabilities: {
    builtInVoice: Boolean(python.ok && mossCli.ok && models.ok),
    promptSpeech: Boolean(python.ok && mossCli.ok && models.ok && python.modules?.soundfile && patch.ok),
  },
  issues,
  warnings,
  nextCommand: recommendedCommands[0] || null,
  recommendedCommands: [...new Set(recommendedCommands)],
};

if (emitJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`MOSS doctor: ${result.ok ? "ready" : "not ready"}`);
  if (result.python.executable) console.log(`Python: ${result.python.executable}`);
  console.log(`MOSS CLI: ${result.mossCli.ok ? result.mossCli.bin : "missing"}`);
  console.log(`Models: ${result.models.ok ? "complete" : `missing (${result.models.missing.length})`}`);
  console.log(`Torch-free patch: ${result.torchFreePatch.status}`);
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
