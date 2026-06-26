#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { defaultWhisperEnv } from "./whisper-paths.mjs";

const isWin = process.platform === "win32";
const npx = isWin ? "npx.cmd" : "npx";
const ffmpeg = isWin ? "ffmpeg.exe" : "ffmpeg";
const ffprobe = isWin ? "ffprobe.exe" : "ffprobe";

const args = process.argv.slice(2);
const cmd = args.shift();
const scriptDir = dirname(fileURLToPath(import.meta.url));

function usage(exitCode = 0) {
  console.log(`HyperFrames workflow helper

Usage:
  hf-workflow.mjs doctor
  hf-workflow.mjs init <project> [--example <name>] [--tailwind]
  hf-workflow.mjs visual-guard [project-or-html]
  hf-workflow.mjs layout-guard [project-or-html] [--samples N | --at t1,t2] [--json]
  hf-workflow.mjs check [project] [--no-inspect] [--layout]
  hf-workflow.mjs moss-doctor [--python python] [--model-dir <dir>] [--json]
  hf-workflow.mjs moss-bootstrap --in-place --python python [--models-dir <dir>] [--skip-models|--skip-hf|--skip-modelscope] [--model-progress-interval-ms <ms>]
  hf-workflow.mjs moss-models [--dir <model-parent-dir>] [--python python] [--skip-hf|--skip-modelscope] [--progress-interval-ms <ms>]
  hf-workflow.mjs moss-patch-torchfree [--python python]
  hf-workflow.mjs whisper-doctor [--model small-q8_0] [--json] [--no-smoke-test]
  hf-workflow.mjs whisper-bootstrap [--model small-q8_0] [--model-timeout-ms <ms>] [--model-progress-interval-ms <ms>] [--skip-hf|--skip-modelscope]
  hf-workflow.mjs whisper-models [--model small-q8_0] [--timeout-ms <ms>] [--progress-interval-ms <ms>] [--skip-hf|--skip-modelscope]
  hf-workflow.mjs moss-audio [project] [--prompt-speech audio.wav] [--language zh]
  hf-workflow.mjs moss-captions [project] [--max-chars 20] [--min-chars 4] [--caption-gap-s 0.01]
  hf-workflow.mjs snapshot [project] [--frames N | --at t1,t2]
  hf-workflow.mjs render [project] [--quality draft|standard|high] [--output path] [--strict]
  hf-workflow.mjs burn-subtitles <video> --srt subtitles.srt --out captioned.mp4 [--fonts-dir <dir>]
  hf-workflow.mjs preview [project]
  hf-workflow.mjs play [project]
  hf-workflow.mjs transcribe <audio> --dir <out-dir> [--model small-q8_0] [--language zh]
  hf-workflow.mjs media-info <video> --out <metadata.json>
  hf-workflow.mjs extract-audio <video> --out <audio.mp3>
`);
  process.exit(exitCode);
}

function takeFlag(name, fallback = undefined) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function hasFlag(name) {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function run(bin, binArgs, options = {}) {
  const label = [bin, ...binArgs].join(" ");
  if (options.silent !== true) console.error(`\n$ ${label}`);
  const command = isWin && bin.endsWith(".cmd") ? process.env.ComSpec || "cmd.exe" : bin;
  const commandArgs = command === bin ? binArgs : ["/d", "/s", "/c", bin, ...binArgs];
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd || process.cwd(),
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    shell: false,
    env: { ...process.env, ...(options.env || {}) },
  });

  if (options.capture) {
    if (options.silent !== true) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
  }

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0 && options.allowFailure !== true) {
    process.exit(result.status || 1);
  }
  return result;
}

function hf(hfArgs, options = {}) {
  return run(npx, ["hyperframes", ...hfArgs], {
    ...options,
    env: {
      ...defaultWhisperEnv(),
      ...(options.env || {}),
    },
  });
}

function parseJsonFromMixedOutput(output) {
  const first = output.indexOf("{");
  const last = output.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  try {
    return JSON.parse(output.slice(first, last + 1));
  } catch {
    return null;
  }
}

function ensureParent(filePath) {
  const parent = dirname(resolve(filePath));
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
}

function defaultRenderWorkRoot() {
  const configured = process.env.HYPERFRAMES_VIDEO_RENDER_WORK_DIR;
  if (configured) return resolve(configured);

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return join(localAppData, "hyperframes-video", "render-work");
  }

  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Caches", "hyperframes-video", "render-work");
  }

  const cacheHome = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(cacheHome, "hyperframes-video", "render-work");
}

function ffmpegFilterPath(filePath) {
  return resolve(filePath)
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

function targetProject(defaultValue = ".") {
  const first = args[0] && !args[0].startsWith("--") ? args.shift() : defaultValue;
  return first;
}

if (!cmd || cmd === "-h" || cmd === "--help") usage();

switch (cmd) {
  case "doctor": {
    const result = hf(["doctor", "--json"], { capture: true, silent: true, allowFailure: true });
    const parsed = parseJsonFromMixedOutput(result.stdout);
    if (!parsed) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.status !== 0) process.exit(result.status || 1);
      break;
    }

    const optionalCheckNames = new Set(["Docker", "Docker running"]);
    if (!Array.isArray(parsed.checks)) {
      console.log(JSON.stringify(parsed, null, 2));
      if (parsed.ok === false) process.exit(1);
      break;
    }

    const checks = parsed.checks.filter((check) => !optionalCheckNames.has(check.name));
    const filtered = {
      ...parsed,
      ok: checks.every((check) => check.ok),
      checks,
    };
    console.log(JSON.stringify(filtered, null, 2));
    if (!filtered.ok) process.exit(1);
    break;
  }

  case "init": {
    const project = args.shift();
    if (!project) usage(1);
    const example = takeFlag("--example");
    const initArgs = ["init", project, "--non-interactive"];
    if (example) initArgs.push("--example", example);
    if (hasFlag("--tailwind")) initArgs.push("--tailwind");
    hf(initArgs);
    break;
  }

  case "check": {
    const project = targetProject(".");
    const inspect = !hasFlag("--no-inspect");
    const layout = hasFlag("--layout");
    const guardScript = resolve(scriptDir, "html-visual-guard.mjs");
    run(process.execPath, [guardScript, project]);
    hf(["lint", "--json"], { cwd: project });
    hf(["validate", "--json"], { cwd: project });
    if (inspect) hf(["inspect", "--json"], { cwd: project });
    if (layout) {
      const layoutScript = resolve(scriptDir, "layout-guard.mjs");
      run(process.execPath, [layoutScript, project]);
    }
    break;
  }

  case "visual-guard": {
    const target = targetProject(".");
    const script = resolve(scriptDir, "html-visual-guard.mjs");
    run(process.execPath, [script, target, ...args]);
    break;
  }

  case "layout-guard": {
    const target = targetProject(".");
    const script = resolve(scriptDir, "layout-guard.mjs");
    run(process.execPath, [script, target, ...args]);
    break;
  }

  case "moss-audio": {
    const project = targetProject(".");
    const script = resolve(scriptDir, "moss-audio.mjs");
    run(process.execPath, [script, project, ...args]);
    break;
  }

  case "moss-captions": {
    const project = targetProject(".");
    const script = resolve(scriptDir, "moss-captions.mjs");
    run(process.execPath, [script, project, ...args]);
    break;
  }

  case "moss-doctor": {
    const script = resolve(scriptDir, "moss-doctor.mjs");
    run(process.execPath, [script, ...args]);
    break;
  }

  case "moss-bootstrap": {
    const script = resolve(scriptDir, "moss-bootstrap.mjs");
    run(process.execPath, [script, ...args]);
    break;
  }

  case "moss-models": {
    const script = resolve(scriptDir, "moss-models.mjs");
    run(process.execPath, [script, "ensure", ...args]);
    break;
  }

  case "moss-patch-torchfree": {
    const script = resolve(scriptDir, "moss-patch-onnx-torchfree.mjs");
    run(process.execPath, [script, ...args]);
    break;
  }

  case "whisper-doctor": {
    const script = resolve(scriptDir, "whisper-doctor.mjs");
    run(process.execPath, [script, ...args]);
    break;
  }

  case "whisper-bootstrap": {
    const script = resolve(scriptDir, "whisper-bootstrap.mjs");
    run(process.execPath, [script, ...args]);
    break;
  }

  case "whisper-models": {
    const script = resolve(scriptDir, "whisper-models.mjs");
    run(process.execPath, [script, "ensure", ...args]);
    break;
  }

  case "snapshot": {
    const project = targetProject(".");
    const frames = takeFlag("--frames");
    const at = takeFlag("--at");
    const snapArgs = ["snapshot"];
    if (at) snapArgs.push("--at", at);
    else snapArgs.push("--frames", frames || "9");
    hf(snapArgs, { cwd: project });
    break;
  }

  case "render": {
    const project = targetProject(".");
    const quality = takeFlag("--quality", "draft");
    const output = takeFlag("--output", quality === "high" ? "renders/final.mp4" : "renders/draft.mp4");
    const strict = hasFlag("--strict");
    const outputPath = resolve(project, output);
    ensureParent(outputPath);

    const renderWorkRoot = defaultRenderWorkRoot();
    mkdirSync(renderWorkRoot, { recursive: true });
    const renderRunDir = mkdtempSync(join(renderWorkRoot, "render-"));
    const stagedOutput = join(renderRunDir, basename(outputPath));

    const renderArgs = ["render", "--quality", quality, "--output", stagedOutput];
    if (strict) renderArgs.push("--strict");
    const result = hf(renderArgs, { cwd: project, allowFailure: true });
    if (result.status !== 0) {
      console.error(`Render failed. Temporary render work is under ${renderRunDir}`);
      process.exit(result.status || 1);
    }
    if (!existsSync(stagedOutput) || statSync(stagedOutput).size <= 0) {
      console.error(`Render produced no output at ${stagedOutput}`);
      process.exit(1);
    }
    copyFileSync(stagedOutput, outputPath);
    rmSync(renderRunDir, { recursive: true, force: true });
    console.error(`Verified render: ${outputPath} (${statSync(outputPath).size} bytes)`);
    break;
  }

  case "burn-subtitles": {
    const video = args.shift();
    const srt = takeFlag("--srt");
    const out = takeFlag("--out", "captioned.mp4");
    const preset = takeFlag("--preset", "medium");
    const crf = takeFlag("--crf", "18");
    const fontsDir = takeFlag(
      "--fonts-dir",
      process.platform === "win32" && existsSync("C:\\Windows\\Fonts") ? "C:\\Windows\\Fonts" : undefined,
    );
    if (!video || !srt) usage(1);
    const outputPath = resolve(out);
    ensureParent(outputPath);
    let filter = `subtitles='${ffmpegFilterPath(srt)}'`;
    if (fontsDir) filter += `:fontsdir='${ffmpegFilterPath(fontsDir)}'`;
    run(ffmpeg, [
      "-y",
      "-i",
      video,
      "-vf",
      filter,
      "-c:v",
      "libx264",
      "-preset",
      preset,
      "-crf",
      crf,
      "-c:a",
      "copy",
      outputPath,
    ]);
    if (!existsSync(outputPath) || statSync(outputPath).size <= 0) {
      console.error(`Subtitle burn produced no output at ${outputPath}`);
      process.exit(1);
    }
    console.error(`Verified captioned video: ${outputPath} (${statSync(outputPath).size} bytes)`);
    break;
  }

  case "preview":
  case "play": {
    const project = targetProject(".");
    hf([cmd], { cwd: project });
    break;
  }

  case "transcribe": {
    const audio = args.shift();
    if (!audio) usage(1);
    const dir = takeFlag("--dir", ".");
    const model = takeFlag("--model", "small-q8_0");
    const language = takeFlag("--language");
    const skipWhisperDoctor = hasFlag("--skip-whisper-doctor");
    if (!skipWhisperDoctor) {
      const doctorScript = resolve(scriptDir, "whisper-doctor.mjs");
      const doctorResult = run(process.execPath, [doctorScript, "--model", model, "--json"], {
        capture: true,
        silent: true,
        allowFailure: true,
      });
      const doctor = parseJsonFromMixedOutput(doctorResult.stdout);
      if (!doctor?.ok) {
        const absolutizeWorkflowCommand = (command) =>
          command.replace("node scripts/hf-workflow.mjs", `node "${resolve(scriptDir, "hf-workflow.mjs")}"`);
        const recommendedCommands = Array.isArray(doctor?.recommendedCommands)
          ? doctor.recommendedCommands.map(absolutizeWorkflowCommand)
          : [];
        const nextCommand = doctor?.nextCommand ? absolutizeWorkflowCommand(doctor.nextCommand) : null;
        console.error("Whisper is not ready for local transcription.");
        if (doctor?.issues?.length) {
          for (const issue of doctor.issues) console.error(`- ${issue.code}: ${issue.message}`);
        }
        if (doctor?.warnings?.length) {
          for (const warning of doctor.warnings) console.error(`- ${warning.code}: ${warning.message}`);
        }
        if (recommendedCommands.length) {
          console.error("Recommended commands:");
          for (const command of recommendedCommands) console.error(`  ${command}`);
        } else if (nextCommand) {
          console.error(`Next command: ${nextCommand}`);
        }
        process.exit(1);
      }
    }
    const transcribeArgs = ["transcribe", audio, "-d", dir, "--json", "--model", model];
    if (language) transcribeArgs.push("--language", language);
    hf(transcribeArgs);
    break;
  }

  case "media-info": {
    const video = args.shift();
    const out = takeFlag("--out", "metadata.json");
    if (!video) usage(1);
    ensureParent(out);
    const result = run(
      ffprobe,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,r_frame_rate",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        video,
      ],
      { capture: true },
    );
    const fs = await import("node:fs");
    fs.writeFileSync(out, result.stdout);
    console.error(`Wrote ${resolve(out)}`);
    break;
  }

  case "extract-audio": {
    const video = args.shift();
    const out = takeFlag("--out", "audio.mp3");
    if (!video) usage(1);
    ensureParent(out);
    run(ffmpeg, ["-y", "-i", video, "-vn", "-acodec", "libmp3lame", "-q:a", "2", out]);
    break;
  }

  default:
    usage(1);
}
