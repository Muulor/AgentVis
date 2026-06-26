#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const isWin = process.platform === "win32";
const args = process.argv.slice(2);
const marker = "torch-free reference audio loader patch";
const markerNeedle = "torch-free reference audio loader patch";

function usage(exitCode = 0) {
  console.log(`Patch MOSS-TTS-Nano ONNX runtime to avoid torch/torchaudio during inference

Usage:
  moss-patch-onnx-torchfree.mjs [options]

Options:
  --python <cmd>       Python used to locate the installed onnx_tts_runtime.py
  --file <path>        Patch this onnx_tts_runtime.py directly
  --dry-run           Print the target and whether patching is needed

After patching, install soundfile in the same Python environment:
  python -m pip install soundfile
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

function run(bin, binArgs) {
  const command = isWin && bin.endsWith(".cmd") ? process.env.ComSpec || "cmd.exe" : bin;
  const commandArgs = command === bin ? binArgs : ["/d", "/s", "/c", bin, ...binArgs];
  return spawnSync(command, commandArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    shell: false,
  });
}

function locateRuntime(pythonBin) {
  const code = [
    "import importlib.util",
    "spec = importlib.util.find_spec('onnx_tts_runtime')",
    "print(spec.origin if spec and spec.origin else '')",
  ].join("; ");
  const result = run(pythonBin, ["-c", code]);
  if (result.error) throw new Error(result.error.message);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "failed to locate onnx_tts_runtime");
  const file = String(result.stdout || "").trim();
  if (!file) throw new Error("onnx_tts_runtime.py was not found in that Python environment");
  return file;
}

if (hasFlag("-h") || hasFlag("--help")) usage(0);

const dryRun = hasFlag("--dry-run");
const pythonBin = takeFlag("--python", process.env.PYTHON || "python");
const explicitTargetFile = takeFlag("--file");
const targetFile = resolve(explicitTargetFile || locateRuntime(pythonBin));

if (!existsSync(targetFile)) {
  console.error(`File not found: ${targetFile}`);
  process.exit(1);
}

let source = readFileSync(targetFile, "utf8");
const usesCRLF = source.includes("\r\n");
let normalizedSource = source.replace(/\r\n/g, "\n");

if (normalizedSource.includes(marker) || normalizedSource.includes(markerNeedle)) {
  console.log(`Already patched: ${targetFile}`);
  process.exit(0);
}

const importBlock = "import torch\nimport torchaudio\n";
if (!normalizedSource.includes(importBlock)) {
  console.error("Expected torch/torchaudio import block was not found; refusing to patch unknown layout.");
  process.exit(1);
}

const oldFunction = `    def _load_reference_audio(self, reference_audio_path: str | Path) -> np.ndarray:
        waveform, sample_rate = torchaudio.load(str(Path(reference_audio_path).expanduser().resolve()))
        waveform = waveform.to(torch.float32)
        target_sample_rate = int(self.codec_meta["codec_config"]["sample_rate"])
        target_channels = int(self.codec_meta["codec_config"]["channels"])
        if sample_rate != target_sample_rate:
            waveform = torchaudio.functional.resample(waveform, sample_rate, target_sample_rate)
        current_channels = int(waveform.shape[0])
        if current_channels == target_channels:
            pass
        elif current_channels == 1 and target_channels > 1:
            waveform = waveform.repeat(target_channels, 1)
        elif current_channels > 1 and target_channels == 1:
            waveform = waveform.mean(dim=0, keepdim=True)
        else:
            raise ValueError(f"Unsupported reference audio channel conversion: {current_channels} -> {target_channels}")
        return waveform.unsqueeze(0).detach().cpu().numpy().astype(np.float32, copy=False)
`;

const newFunction = `    def _load_reference_audio(self, reference_audio_path: str | Path) -> np.ndarray:
        # ${marker}: keep ONNX inference independent from torch/torchaudio.
        try:
            import soundfile as sf
        except ModuleNotFoundError as exc:
            raise RuntimeError("soundfile is required for torch-free ONNX reference audio loading. Install it with \`pip install soundfile\`.") from exc

        audio_path = Path(reference_audio_path).expanduser().resolve()
        samples, sample_rate = sf.read(str(audio_path), dtype="float32", always_2d=True)
        if samples.size == 0:
            raise ValueError(f"Reference audio is empty: {audio_path}")
        waveform = np.asarray(samples, dtype=np.float32).T
        target_sample_rate = int(self.codec_meta["codec_config"]["sample_rate"])
        target_channels = int(self.codec_meta["codec_config"]["channels"])
        if int(sample_rate) != target_sample_rate:
            target_length = max(1, int(round(waveform.shape[1] * target_sample_rate / int(sample_rate))))
            source_x = np.linspace(0.0, 1.0, num=waveform.shape[1], endpoint=False, dtype=np.float64)
            target_x = np.linspace(0.0, 1.0, num=target_length, endpoint=False, dtype=np.float64)
            waveform = np.vstack([
                np.interp(target_x, source_x, channel).astype(np.float32)
                for channel in waveform
            ])
        current_channels = int(waveform.shape[0])
        if current_channels == target_channels:
            pass
        elif current_channels == 1 and target_channels > 1:
            waveform = np.repeat(waveform, target_channels, axis=0)
        elif current_channels > 1 and target_channels == 1:
            waveform = waveform.mean(axis=0, keepdims=True)
        else:
            raise ValueError(f"Unsupported reference audio channel conversion: {current_channels} -> {target_channels}")
        return waveform[np.newaxis, :, :].astype(np.float32, copy=False)
`;

if (!normalizedSource.includes(oldFunction)) {
  console.error("Expected _load_reference_audio implementation was not found; refusing to patch unknown layout.");
  process.exit(1);
}

if (dryRun) {
  console.log(`Patch needed: ${targetFile}`);
  process.exit(0);
}

normalizedSource = normalizedSource.replace(importBlock, "# torch/torchaudio intentionally avoided for ONNX inference.\n");
normalizedSource = normalizedSource.replace(oldFunction, newFunction);
source = usesCRLF ? normalizedSource.replace(/\n/g, "\r\n") : normalizedSource;
writeFileSync(targetFile, source, "utf8");
console.log(`Patched: ${targetFile}`);
