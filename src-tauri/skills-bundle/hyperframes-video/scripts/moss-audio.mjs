#!/usr/bin/env node
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { defaultMossModelDir } from "./moss-paths.mjs";
import { defaultWhisperEnv } from "./whisper-paths.mjs";

const isWin = process.platform === "win32";
const ffmpeg = isWin ? "ffmpeg.exe" : "ffmpeg";
const ffprobe = isWin ? "ffprobe.exe" : "ffprobe";
const helperDir = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const initialCwd = process.cwd();

function usage(exitCode = 0) {
  console.log(`MOSS-TTS-Nano audio helper for HyperFrames

Usage:
  moss-audio.mjs [project] [options]

Required input:
  project/narrator_scripts.json with scenes[].script

Options:
  --hyperframes <dir>          Project dir; defaults to positional project or .
  --narrator-scripts <file>    Defaults to <project>/narrator_scripts.json
  --out <file>                 Defaults to <project>/audio_meta.json
  --prompt-speech <audio>      User reference audio for MOSS voice cloning
  --voice <name>               ONNX built-in voice when no prompt speech is set (default: Junhao)
  --backend <onnx|pytorch>     MOSS backend (default: onnx)
  --execution-provider <cpu|cuda>  ONNX execution provider (default: cpu)
  --onnx-model-dir <dir>       ONNX model directory (default: shared user cache)
  --moss-bin <cmd>             MOSS CLI command (default: moss-tts-nano)
  --language <code>            Language hint for optional word timings (default: zh)
  --whisper-model <model>      Whisper model for word timings (default: small-q8_0)
  --cpu-threads <n>            ONNX CPU threads (default: 4)
  --sample-mode <mode>         ONNX sample mode (default: fixed)
  --max-new-frames <n>         MOSS max new frames (default: 375)
  --pad-start-ms <n>           Silence before each scene voice file (default: 240)
  --pad-end-ms <n>             Silence after each scene voice file (default: 360)
  --seed <n>                   Optional deterministic MOSS seed
  --wetext                     Enable MOSS WeTextProcessing normalization
  --word-timings               Run HyperFrames transcription for word-level timings
  --transcribe                 Alias for --word-timings
  --no-transcribe              Compatibility flag; word timings are already off by default
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
  if (!options.quiet) console.error(`\n$ ${label}`);
  const command = isWin && bin.endsWith(".cmd") ? process.env.ComSpec || "cmd.exe" : bin;
  const commandArgs = command === bin ? binArgs : ["/d", "/s", "/c", bin, ...binArgs];
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd || process.cwd(),
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    shell: false,
    env: { ...process.env, ...(options.env || {}) },
  });

  if (options.capture && !options.silent) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }

  if (result.error) {
    if (options.allowFailure) return result;
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0 && options.allowFailure !== true) {
    process.exit(result.status || 1);
  }
  return result;
}

function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function relProject(project, path) {
  return relative(project, path).replace(/\\/g, "/");
}

function resolveMaybe(path) {
  if (!path) return null;
  if (!path.includes("/") && !path.includes("\\")) return path;
  return isAbsolute(path) ? path : resolve(initialCwd, path);
}

function addMossBinForPython(candidates, pythonExe) {
  if (!pythonExe) return;
  const pyDir = dirname(resolve(pythonExe));
  if (isWin) {
    const scriptsDir = pyDir.toLowerCase().endsWith("\\scripts") ? pyDir : join(pyDir, "Scripts");
    candidates.push(join(scriptsDir, "moss-tts-nano.exe"));
    candidates.push(join(scriptsDir, "Scripts", "moss-tts-nano.exe"));
    if (existsSync(scriptsDir)) {
      for (const name of readdirSync(scriptsDir)) {
        if (name.toLowerCase().startsWith("moss-tts-nano")) candidates.push(join(scriptsDir, name));
      }
    }
    return;
  }
  candidates.push(pyDir.endsWith("/bin") ? join(pyDir, "moss-tts-nano") : "moss-tts-nano");
}

function pythonExecutable(pythonBin) {
  if (!pythonBin) return null;
  const result = spawnSync(pythonBin, ["-c", "import sys; print(sys.executable)"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    shell: false,
  });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || "").trim() || null;
}

function candidateMossBins(explicit) {
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

  addMossBinForPython(candidates, pythonExecutable(process.env.PYTHON));
  addMossBinForPython(candidates, pythonExecutable("python"));
  candidates.push("moss-tts-nano");

  return [...new Set(candidates.map(resolveMaybe).filter(Boolean))];
}

function resolveMossBin(explicit) {
  const attempts = [];
  for (const candidate of candidateMossBins(explicit)) {
    const result = run(candidate, ["--help"], {
      capture: true,
      silent: true,
      quiet: true,
      allowFailure: true,
    });
    attempts.push(candidate);
    if (!result.error && result.status === 0) return candidate;
  }

  if (explicit) return resolveMaybe(explicit);
  console.error("moss-tts-nano CLI was not found in PATH, VIRTUAL_ENV, or the current Python Scripts directory.");
  console.error("Tried:");
  for (const attempt of attempts) console.error(`- ${attempt}`);
  console.error("Hint: pass --moss-bin <path> or set MOSS_TTS_NANO_BIN.");
  process.exit(1);
}

function stripCaptionTags(text) {
  return String(text || "").replace(/<\/?(em|brand|emph|cta)\b[^>]*>/gi, "");
}

function estimatedDurationSeconds(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return null;
  const match = normalized.match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
}

function sceneIdFor(scene, index) {
  const number = scene.sceneNumber ?? index + 1;
  const raw = scene.sceneId || `scene_${number}`;
  return String(raw).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function sceneNumberFor(scene, index) {
  const parsed = Number(scene.sceneNumber);
  return Number.isFinite(parsed) ? parsed : index + 1;
}

function ffprobeDuration(path) {
  const result = run(
    ffprobe,
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
    { capture: true, silent: true, quiet: true, allowFailure: true },
  );
  if (result.status === 0) return Number.parseFloat(String(result.stdout || "").trim());
  return wavDuration(path);
}

function wavDuration(path) {
  try {
    const buffer = readFileSync(path);
    if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
      return NaN;
    }
    let offset = 12;
    let byteRate = 0;
    let dataSize = 0;
    while (offset + 8 <= buffer.length) {
      const id = buffer.toString("ascii", offset, offset + 4);
      const size = buffer.readUInt32LE(offset + 4);
      const start = offset + 8;
      if (id === "fmt ") byteRate = buffer.readUInt32LE(start + 8);
      if (id === "data") {
        dataSize = size;
        break;
      }
      offset = start + size + (size % 2);
    }
    return byteRate > 0 && dataSize > 0 ? dataSize / byteRate : NaN;
  } catch {
    return NaN;
  }
}

if (hasFlag("--help") || hasFlag("-h")) usage(0);

const positionalProject = args[0] && !args[0].startsWith("--") ? args.shift() : null;
const hyperframesDir = resolve(takeFlag("--hyperframes", positionalProject || "."));
const narratorPath = resolve(
  takeFlag("--narrator-scripts", join(hyperframesDir, "narrator_scripts.json")),
);
const outPath = resolve(takeFlag("--out", join(hyperframesDir, "audio_meta.json")));
const promptSpeech = takeFlag("--prompt-speech");
const promptSpeechAbs = promptSpeech ? resolve(promptSpeech) : null;
const voice = takeFlag("--voice", "Junhao");
const backend = takeFlag("--backend", "onnx");
const executionProvider = takeFlag("--execution-provider", "cpu");
const onnxModelDir = takeFlag("--onnx-model-dir", defaultMossModelDir());
const mossBin = resolveMossBin(takeFlag("--moss-bin"));
const language = takeFlag("--language", "zh");
const whisperModel = takeFlag("--whisper-model", language === "en" ? "small.en-q8_0" : "small-q8_0");
const cpuThreads = takeFlag("--cpu-threads", "4");
const sampleMode = takeFlag("--sample-mode", "fixed");
const maxNewFrames = takeFlag("--max-new-frames", "375");
const padStartMs = Number(takeFlag("--pad-start-ms", "240"));
const padEndMs = Number(takeFlag("--pad-end-ms", "360"));
const seed = takeFlag("--seed");
const wetext = hasFlag("--wetext");
const shouldTranscribe = (hasFlag("--word-timings") || hasFlag("--transcribe")) && !hasFlag("--no-transcribe");

if (!existsSync(hyperframesDir)) {
  console.error(`Project directory not found: ${hyperframesDir}`);
  process.exit(1);
}
if (!existsSync(narratorPath)) {
  console.error(`narrator_scripts.json not found: ${narratorPath}`);
  process.exit(1);
}
if (promptSpeechAbs && !existsSync(promptSpeechAbs)) {
  console.error(`Prompt speech not found: ${promptSpeechAbs}`);
  process.exit(1);
}
if (!["onnx", "pytorch"].includes(backend)) {
  console.error(`Invalid --backend "${backend}" (expected onnx or pytorch)`);
  process.exit(1);
}
if (!Number.isFinite(padStartMs) || padStartMs < 0 || !Number.isFinite(padEndMs) || padEndMs < 0) {
  console.error("--pad-start-ms and --pad-end-ms must be non-negative numbers.");
  process.exit(1);
}
if (backend !== "onnx" && !promptSpeechAbs) {
  console.error("The pytorch backend needs --prompt-speech. Use --backend onnx for built-in voices.");
  process.exit(1);
}

const narrator = readJson(narratorPath);
const scenes = (narrator.scenes || []).map((scene, index) => ({
  sceneId: sceneIdFor(scene, index),
  sceneNumber: sceneNumberFor(scene, index),
  estimatedDuration: estimatedDurationSeconds(scene.estimatedDuration ?? scene.duration ?? scene.duration_s),
  script: stripCaptionTags(scene.script || scene.narration || scene.text || scene.voiceover || ""),
}));

if (!scenes.length) {
  console.error("narrator_scripts.json has no scenes.");
  process.exit(1);
}
for (const scene of scenes) {
  if (!scene.script.trim()) {
    console.error(`${scene.sceneId}: empty script.`);
    process.exit(1);
  }
}

const voiceDir = join(hyperframesDir, "assets", "voice");
const scriptDir = join(voiceDir, "scripts");
ensureDir(voiceDir);
ensureDir(scriptDir);
ensureDir(dirname(outPath));

let promptSpeechForRun = promptSpeechAbs;
if (promptSpeechAbs) {
  const promptDir = join(voiceDir, "prompt");
  ensureDir(promptDir);
  const cachedPrompt = join(promptDir, basename(promptSpeechAbs));
  if (resolve(promptSpeechAbs) !== resolve(cachedPrompt)) {
    copyFileSync(promptSpeechAbs, cachedPrompt);
  }
  promptSpeechForRun = cachedPrompt;
}

function mossArgsFor(scene, txtPath, rawOutPath) {
  const cmdArgs = [
    "generate",
    "--backend",
    backend,
    "--text-file",
    txtPath,
    "--output",
    rawOutPath,
    "--max-new-frames",
    maxNewFrames,
  ];

  if (backend === "onnx") {
    cmdArgs.push("--execution-provider", executionProvider);
    cmdArgs.push("--cpu-threads", cpuThreads);
    cmdArgs.push("--sample-mode", sampleMode);
    if (onnxModelDir) cmdArgs.push("--onnx-model-dir", resolve(onnxModelDir));
    if (!promptSpeechAbs) cmdArgs.push("--voice", voice);
  }

  if (promptSpeechForRun) cmdArgs.push("--prompt-speech", promptSpeechForRun);
  if (seed) cmdArgs.push("--seed", seed);
  if (wetext) cmdArgs.push("--enable-wetext-processing");
  return cmdArgs;
}

function normalizeAudio(rawPath, finalPath) {
  const filters = [];
  if (padStartMs > 0) filters.push(`adelay=${Math.round(padStartMs)}:all=1`);
  if (padEndMs > 0) filters.push(`apad=pad_dur=${(padEndMs / 1000).toFixed(3)}`);
  const filterArgs = filters.length ? ["-af", filters.join(",")] : [];
  const result = run(
    ffmpeg,
    [
      "-y",
      "-i",
      rawPath,
      ...filterArgs,
      "-ar",
      "48000",
      "-ac",
      "2",
      "-c:a",
      "pcm_s16le",
      finalPath,
    ],
    { allowFailure: true },
  );
  if (result.error || result.status !== 0 || !existsSync(finalPath)) {
    copyFileSync(rawPath, finalPath);
    console.error("ffmpeg normalization failed; kept the MOSS WAV output as-is.");
  }
}

function transcribeScene(scene, wavAbs, wordsAbs) {
  const tmp = mkdtempSync(join(tmpdir(), `hf-moss-trans-${scene.sceneId}-`));
  try {
    const transcribeArgs = [
      join(helperDir, "hf-workflow.mjs"),
      "transcribe",
      wavAbs,
      "--dir",
      tmp,
      "--json",
      "--model",
      whisperModel,
    ];
    if (language) transcribeArgs.push("--language", language);
    const result = run(process.execPath, transcribeArgs, {
      cwd: hyperframesDir,
      allowFailure: true,
      capture: true,
      env: defaultWhisperEnv(),
    });
    const transcript = join(tmp, "transcript.json");
    if (result.status === 0 && existsSync(transcript) && statSync(transcript).size > 2) {
      copyFileSync(transcript, wordsAbs);
      return { ok: true, error: null };
    }
    const output = `${result.stdout || ""}\n${result.stderr || ""}`
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const usefulLine =
      output.find((line) => /not found|error|failed|install/i.test(line)) ||
      output[output.length - 1] ||
      `hyperframes transcribe exited with status ${result.status ?? "unknown"}`;
    return { ok: false, error: usefulLine.slice(0, 280) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function synthesizeScene(scene) {
  const txtPath = join(scriptDir, `${scene.sceneId}.txt`);
  const rawPath = join(voiceDir, `${scene.sceneId}.moss.wav`);
  const wavPath = join(voiceDir, `${scene.sceneId}.wav`);
  const wordsPath = join(voiceDir, `${scene.sceneId}_words.json`);
  writeFileSync(txtPath, `${scene.script.trim()}\n`, "utf8");
  rmSync(rawPath, { force: true });
  rmSync(wavPath, { force: true });
  rmSync(wordsPath, { force: true });

  const tts = run(mossBin, mossArgsFor(scene, txtPath, rawPath), {
    cwd: hyperframesDir,
    allowFailure: true,
  });
  if (tts.error) {
    console.error(
      `MOSS CLI failed for ${scene.sceneId}: ${tts.error.message}. Install MOSS-TTS-Nano or pass --moss-bin <path>.`,
    );
    console.error(
      "Hint: run `node <skill>/scripts/hf-workflow.mjs moss-doctor --json` and follow `recommendedCommands`, or run `moss-bootstrap --skip-models` for a fresh lightweight ONNX setup before model download.",
    );
  }
  if (tts.error || tts.status !== 0 || !existsSync(rawPath) || statSync(rawPath).size === 0) {
    return { ok: false, sceneId: scene.sceneId, reason: "moss_tts_failed" };
  }

  normalizeAudio(rawPath, wavPath);
  rmSync(rawPath, { force: true });
  const duration = ffprobeDuration(wavPath);
  if (!Number.isFinite(duration) || duration <= 0) {
    return { ok: false, sceneId: scene.sceneId, reason: "invalid_audio_duration" };
  }

  let transcription = { ok: false, error: null };
  if (shouldTranscribe) {
    transcription = transcribeScene(scene, wavPath, wordsPath);
  }

  return {
    ok: true,
    sceneId: scene.sceneId,
    sceneNumber: scene.sceneNumber,
    voicePath: relProject(hyperframesDir, wavPath),
    voiceDuration: Number(duration.toFixed(3)),
    wordsPath: transcription.ok ? relProject(hyperframesDir, wordsPath) : "",
    wordsError: shouldTranscribe && !transcription.ok ? transcription.error : null,
    scriptPath: relProject(hyperframesDir, txtPath),
  };
}

console.log(
  `MOSS audio: backend=${backend} provider=${executionProvider} voice=${
    promptSpeechAbs ? `prompt:${basename(promptSpeechAbs)}` : voice
  } language=${language}`,
);

const scenesMap = {};
const failedScenes = [];
const transcriptionErrors = [];
const durationWarnings = [];
let totalDuration = 0;

for (const scene of scenes) {
  const result = synthesizeScene(scene);
  if (!result.ok) {
    failedScenes.push({ sceneId: scene.sceneId, reason: result.reason });
    continue;
  }
  const sceneMeta = {
    voicePath: result.voicePath,
    voiceDuration: result.voiceDuration,
    wordsPath: result.wordsPath,
    scriptPath: result.scriptPath,
  };
  if (result.wordsError) {
    sceneMeta.wordsError = result.wordsError;
    transcriptionErrors.push({ sceneId: result.sceneId, reason: result.wordsError });
  }
  if (Number.isFinite(scene.estimatedDuration) && result.voiceDuration > Math.max(scene.estimatedDuration * 2, scene.estimatedDuration + 8)) {
    const warning = {
      sceneId: result.sceneId,
      estimatedDuration: scene.estimatedDuration,
      voiceDuration: result.voiceDuration,
      reason: "voice_duration_exceeds_estimate",
      hint: "Shorten the narration, reduce comma-heavy Chinese phrasing, split into shorter sentences, or increase --max-new-frames only if the long duration is intentional.",
    };
    durationWarnings.push(warning);
    console.warn(
      `Warning: ${result.sceneId} voiceDuration ${result.voiceDuration}s exceeds estimatedDuration ${scene.estimatedDuration}s. Check comma-heavy Chinese narration or --max-new-frames.`,
    );
  }
  scenesMap[result.sceneId] = sceneMeta;
  totalDuration += result.voiceDuration;
}

const audioMeta = {
  tts_provider: "moss-tts-nano",
  voice_id: promptSpeechAbs ? `prompt-speech:${basename(promptSpeechAbs)}` : voice,
  tts_backend: backend,
  execution_provider: backend === "onnx" ? executionProvider : null,
  prompt_speech: promptSpeechAbs,
  prompt_speech_cached: promptSpeechForRun ? relProject(hyperframesDir, promptSpeechForRun) : null,
  moss_model_assets_in_skill: false,
  moss_onnx_model_dir: onnxModelDir ? resolve(onnxModelDir) : null,
  moss_cli: mossBin,
  audio_pad_start_ms: padStartMs,
  audio_pad_end_ms: padEndMs,
  bgm_provider: null,
  bgm_enabled: false,
  bgm_path: null,
  bgm_pending: false,
  bgm_log: null,
  bgm_pid: null,
  bgm_mode: null,
  bgm_target_duration_s: null,
  bgm_seed_duration_s: null,
  bgm_loop_count: null,
  language,
  whisper_model: shouldTranscribe ? whisperModel : null,
  total_duration_s: Number(totalDuration.toFixed(3)),
  failed_scenes: failedScenes,
  duration_warnings: durationWarnings,
  transcription_errors: transcriptionErrors,
  scenes: scenesMap,
};

writeFileSync(outPath, `${JSON.stringify(audioMeta, null, 2)}\n`, "utf8");

if (!Object.keys(scenesMap).length) {
  console.error(`No scenes were voiced. Wrote ${outPath}`);
  process.exit(1);
}

console.log(`Wrote ${outPath}`);
console.log(`Scenes voiced: ${Object.keys(scenesMap).length}/${scenes.length}`);
console.log(`Total voice duration: ${audioMeta.total_duration_s}s`);
if (failedScenes.length) {
  console.log(`Failed scenes: ${failedScenes.map((s) => `${s.sceneId}:${s.reason}`).join(", ")}`);
}
if (durationWarnings.length) {
  console.log(`Duration warnings: ${durationWarnings.length} scene(s); inspect audio_meta.duration_warnings.`);
}
if (transcriptionErrors.length) {
  console.log(`Transcription skipped/failed for ${transcriptionErrors.length} scene(s).`);
}
