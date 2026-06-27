# QA And CLI

Use this for environment checks, gates, preview, render, transcription, and troubleshooting. Raw commands are shown so the bundled helper is optional.

## Requirements

- Node.js 22 or newer for current HyperFrames CLI.
- FFmpeg/ffprobe for media and render workflows.
- A working headless browser; `hf-workflow.mjs doctor` checks this without requiring Docker.
- MOSS-TTS-Nano CLI for generated narration: `moss-tts-nano generate --backend onnx`.
- Python with the `SKILL.md` dependency block installed for lightweight MOSS ONNX. Fixed 3.13/3.14 runtimes can be used if dependency installation and `moss-doctor` pass.
- whisper.cpp support for `hyperframes transcribe` only if word-level timing JSON, ASR captions from existing audio, or karaoke-style subtitles are required. It supports CPU inference with ggml Whisper models and does not require PyTorch/Torch or a GPU. It does not require cmake when `whisper-cli`/`whisper` is already installed or cached; building from source requires git, cmake, and a C/C++ compiler. Generated MOSS narration can use its source script for normal subtitles.
- Docker is optional and only matters when the user explicitly requests `hyperframes render --docker`; do not block CPU MOSS narration or normal local renders on Docker.
- If the helper doctor reports "Chrome Headless Shell is required", run  `npx hyperframes browser ensure`, then rerun doctor.

## Helper Script

```bash
node <skill>/scripts/hf-workflow.mjs doctor
node <skill>/scripts/hf-workflow.mjs visual-guard ./project
node <skill>/scripts/hf-workflow.mjs check ./project
node <skill>/scripts/hf-workflow.mjs check ./project --layout
node <skill>/scripts/hf-workflow.mjs layout-guard ./project --samples 18
node <skill>/scripts/hf-workflow.mjs moss-doctor --json --python python
node <skill>/scripts/hf-workflow.mjs moss-bootstrap --in-place --python python --source-dir ./.moss/MOSS-TTS-Nano --skip-models
node <skill>/scripts/hf-workflow.mjs moss-models --skip-modelscope
node <skill>/scripts/hf-workflow.mjs moss-models --skip-hf
node <skill>/scripts/hf-workflow.mjs moss-patch-torchfree --python python
node <skill>/scripts/hf-workflow.mjs whisper-doctor --model small-q8_0 --json
node <skill>/scripts/hf-workflow.mjs whisper-models --model small-q8_0 --skip-modelscope
node <skill>/scripts/hf-workflow.mjs whisper-models --model small-q8_0 --skip-hf
node <skill>/scripts/hf-workflow.mjs whisper-bootstrap --model small-q8_0 --skip-model
node <skill>/scripts/hf-workflow.mjs moss-audio ./project --language zh
node <skill>/scripts/hf-workflow.mjs moss-captions ./project
node <skill>/scripts/hf-workflow.mjs moss-audio ./project --language zh --word-timings
node <skill>/scripts/hf-workflow.mjs snapshot ./project --frames 9
node <skill>/scripts/hf-workflow.mjs render ./project --quality draft --output renders/draft.mp4
node <skill>/scripts/hf-workflow.mjs render ./project --quality high --output renders/final.mp4
node <skill>/scripts/hf-workflow.mjs burn-subtitles ./input.mp4 --srt ./transcript.srt --out ./captioned.mp4
node <skill>/scripts/hf-workflow.mjs transcribe ./audio.wav --dir ./project --model small-q8_0 --language zh
node <skill>/scripts/hf-workflow.mjs transcribe ./audio.mp3 --dir ./project --model small.en-q8_0
```

The helper defaults to multilingual `small-q8_0` because it is safer for Chinese, mixed-language, or unknown-language audio and is smaller than full-precision `small` with usually similar ASR quality. Use `small.en-q8_0` only for English-only speech. Use full-precision `small` only when the user explicitly wants the larger model. Whisper model files are shared in this skill's app cache, so the first download can be reused by later agents and projects:

- Windows: `%LOCALAPPDATA%\hyperframes-video\whisper`
- macOS: `~/Library/Caches/hyperframes-video/whisper`
- Linux: `${XDG_CACHE_HOME:-~/.cache}/hyperframes-video/whisper`

Override with `HYPERFRAMES_WHISPER_MODELS_DIR=<dir>` only when needed. Raw HyperFrames also works with its built-in default cache, but this helper sets the env var so MOSS and Whisper assets live under the same `hyperframes-video` namespace.

Whisper readiness flow:

1. Run `node <skill>/scripts/hf-workflow.mjs whisper-doctor --model small-q8_0 --json`. When the model exists, doctor also runs a tiny local transcription smoke test so copied or broken native binaries fail before the real task starts.
2. If `ok:false`, run `recommendedCommands` in order. Do not manually probe `git`, `cmake`, `gcc`, or random package managers.
3. For a missing model, the first command is a Hugging Face-only attempt. If that command fails or the agent's outer exec times out, run the next ModelScope-only command directly. Let the agent/runtime choose command timeouts; pass `--timeout-ms <ms>` only when a specific script-level download timeout is needed.
4. Build with `whisper-bootstrap --skip-model` only after the model file exists, so bootstrap does not start another long download. If doctor reports `whisper_runtime_failed` or a copied binary crashes with `STATUS_ACCESS_VIOLATION`, use the recommended clean rebuild command, or run `whisper-bootstrap --skip-model --clean` on that host.
5. If there is no build command and the issue is `build_tools_missing`, report that the host needs either a working `whisper-cli`/`whisper` binary or git + cmake + a C/C++ compiler.

The helper's `transcribe` command runs this doctor gate before calling raw HyperFrames, so missing cmake/compiler fails early with a clear next step instead of entering an uncontrolled build attempt.
On Windows, `whisper-doctor` checks PATH plus common install locations such as `C:\Program Files\CMake\bin`, Visual Studio CMake/MSVC folders, and WinGet package directories. A tool marked installed by the app can still be missing from PATH; trust the doctor JSON over ad hoc `where cmake` probes.
The model cache is portable, but the `whisper.cpp` build cache is host-specific. Do not treat `%LOCALAPPDATA%\hyperframes-video\whisper.cpp` copied from another machine as a reliable install; native CPU/CUDA/MSVC assumptions can differ. Copy `%LOCALAPPDATA%\hyperframes-video\whisper` if needed, then rebuild `whisper.cpp` on the target machine.
`whisper-bootstrap` downloads the selected ggml model and compiles `whisper.cpp` when build tools are discoverable. It does not silently install system tools such as CMake or Visual Studio Build Tools; those remain external host setup.

HyperFrames downloads ggml model files from Hugging Face first. The `whisper-models` helper can fall back to the ModelScope mirror if Hugging Face fails inside the same process:

```text
https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-<model>.bin
https://modelscope.cn/api/v1/models/iceCream2025/whisper.cpp/resolve/master/ggml-<model>.bin
```

Examples: `ggml-small-q8_0.bin`, `ggml-small.en-q8_0.bin`, `ggml-small.bin`, `ggml-medium.bin`.

For agent runtimes with short outer exec timeouts, do not rely on one long in-process fallback command. Use this two-step download flow and let the agent/runtime choose command timeouts:

```bash
node <skill>/scripts/hf-workflow.mjs whisper-models --model small-q8_0 --skip-modelscope
node <skill>/scripts/hf-workflow.mjs whisper-models --model small-q8_0 --skip-hf
```

If the first command is killed by the outer exec timeout, the second command is still valid; `whisper-models` removes stale `.part` files before retrying. If all automatic sources fail, it prints an observation block with exact manual URLs and target path. The agent should stop retry loops and report those lines to the user. For the default Chinese-capable model on Windows, the manual fallback is:

During long direct downloads, `whisper-models` prints sparse `Progress:` heartbeats: first after about 15 seconds, then about every 30 seconds. If an outer exec timeout kills the command, inspect the last `Progress:` line to see whether bytes were still increasing before deciding to retry with a longer exec timeout or switch to the next mirror.

```text
Hugging Face URL: https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q8_0.bin
ModelScope URL: https://modelscope.cn/api/v1/models/iceCream2025/whisper.cpp/resolve/master/ggml-small-q8_0.bin
Save as: %LOCALAPPDATA%\hyperframes-video\whisper\ggml-small-q8_0.bin
```

After the user places the file, rerun `whisper-doctor --model small-q8_0 --json`.

MOSS readiness flow:

1. Run `node <skill>/scripts/hf-workflow.mjs moss-doctor --json --python python`.
2. If `ok:false`, run `recommendedCommands` in order. Do not try `npx`, full PyTorch installs, or random package managers.
3. For a fresh runtime, bootstrap should use `--skip-models` so package installation and model download are separate recoverable steps.
4. If bootstrap reports `Observation: moss_source_dir_invalid`, the managed `.moss/MOSS-TTS-Nano` directory will be repaired automatically. For an external `--source-dir`, provide a clean MOSS checkout. Do not create `pyproject.toml` manually or install `transformers`.
5. For missing models, the first command is Hugging Face-only: `moss-models --skip-modelscope`. If that command fails or the agent's outer exec times out, run the next ModelScope-only command: `moss-models --skip-hf`.
6. During long direct downloads, `moss-models` prints sparse `Progress:` heartbeats: first after about 15 seconds, then about every 30 seconds. If an outer exec timeout kills the command, inspect the last `Progress:` line to see whether bytes were still increasing before retrying or reporting the manual download observation.

The MOSS ModelScope mirrors are:

```text
https://modelscope.cn/models/openmoss/MOSS-TTS-Nano-100M-ONNX
https://modelscope.cn/models/openmoss/MOSS-Audio-Tokenizer-Nano-ONNX
```

For Chinese audio, specify the language when known:

```bash
npx hyperframes transcribe audio.wav -d . --json --model small-q8_0 --language zh
```

## Raw CLI Loop

```bash
npx hyperframes lint --json
npx hyperframes validate --json
npx hyperframes inspect --json
npx hyperframes snapshot --frames 9
npx hyperframes render --quality draft --output renders/draft.mp4
npx hyperframes render --quality high --output renders/final.mp4
```

Use `--json` for agent/CI calls except `render`, `preview`, and `play`. Render success must be verified by checking that the output file exists and is non-empty.
If using the official raw `npx hyperframes doctor --json`, ignore the `Docker` and `Docker running` rows unless the render command will use `--docker`; the bundled helper filters them by default.
Run `visual-guard` before raw CLI gates when using this skill; it catches static HTML patterns that can pass syntax checks but render as background plus audio.

HyperFrames render captures video frames through a browser before encoding. A long 30fps video can therefore create one temporary screenshot per output frame, for example about 14,400 frames for an 8-minute render. The official renderer removes its `work-*` directory after a normal successful run, but an outer agent exec timeout can kill the process before cleanup. This helper stages render output under the shared cache `%LOCALAPPDATA%\hyperframes-video\render-work` on Windows, or the platform cache equivalent, then copies the final file back to the requested output path.

For existing-video plain subtitles, avoid HyperFrames render entirely. Use FFmpeg subtitle burn-in through the helper:

```bash
node <skill>/scripts/hf-workflow.mjs burn-subtitles ./input.mp4 --srt ./transcript.srt --out ./captioned.mp4
```

Use HyperFrames render for animated captions, karaoke word effects, embedded/cinematic captions, designed cards, or graphic overlays where browser composition is actually needed.

## Layout Guard

Run the lightweight browser geometry gate for videos where visual overlap is likely:

```bash
node <skill>/scripts/hf-workflow.mjs layout-guard ./project --samples 18
# or include it after lint/validate/inspect
node <skill>/scripts/hf-workflow.mjs check ./project --layout
```

Use it for narrated/user-facing videos, captions, dense diagrams, large type, rotated cards, catalog blocks, sub-compositions, or any project that previously rendered blank/overlapped/out-of-frame frames. It opens `index.html` in Chrome/Headless Shell, seeks sampled timeline times, and reports:

- `off_canvas`: important text/media leaves the canvas.
- `blank_or_background_only`: a sampled frame has only background/decorative content.
- `caption_collision`: a caption overlaps another foreground element.
- warnings for foreground overlap or elements entering the bottom caption safe band.

If the command exits unavailable, run `npx hyperframes browser ensure` or set `HYPERFRAMES_CHROME_PATH`, then rerun. Do not treat an unavailable layout guard as a pass when the video has captions, catalog blocks, or a final render request.

## Preview

Preview is useful after the static gates pass. Do not open a preview mid-build for workflows that will continue editing files.

```bash
npx hyperframes preview
# or a lightweight player:
npx hyperframes play
```

Report the URL and keep the server running only if the user asked for live preview.

## Snapshot Smoke Tests

Use snapshots when a full render is slow or sub-compositions/transitions are involved:

```bash
npx hyperframes snapshot --frames 9
npx hyperframes snapshot --at 1.5,4.0,7.5
```

Look for blank frames, missing styles, top-left tiny text, clipped text, missing hero elements, black tails, or wrong aspect ratio. For normal deliverables, scale snapshot count to the video: at least 2-3 frames per scene, or about one frame every 4-6 seconds for longer videos. Inspect the contact sheet cell by cell instead of glancing at the whole sheet.

For mounted catalog blocks, sub-compositions, WebGL/DOM-capture effects, or any case where snapshots and rendered MP4 disagree, render a draft and extract/check the same timestamp from the MP4. Snapshot success alone is not enough for these high-risk cases.

## Existing Video Prep

```bash
ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height,r_frame_rate \
  -show_entries format=duration -of json input.mp4 > metadata.json

ffmpeg -y -i input.mp4 -vn -acodec libmp3lame -q:a 2 audio.mp3

npx hyperframes transcribe audio.mp3 -d . --json --model small-q8_0 --language zh
```

Use `--model small.en-q8_0` only for English-only speech. For Chinese, mixed-language, or uncertain speech, keep multilingual `small-q8_0`; add `--language zh` when the audio is known Chinese.

Expected transcript shape for current overlay workflows is usually a flat word array:

```json
[{ "text": "Hello", "start": 0.12, "end": 0.38 }]
```

Correct text, punctuation, names, and technical terms, but preserve timestamps.

## Common Failures

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Sub-agent loops through `where`, `npx`, and random pip installs for MOSS | Dependency path is underspecified | Run `moss-doctor --json`; execute its `recommendedCommands`; prefer `moss-bootstrap --skip-models` before model downloads |
| MOSS CLI is in `Scripts/Scripts` or another non-standard venv path | Embedded Python installed the console script outside PATH | Rerun with the current scripts; `moss-audio` auto-detects `VIRTUAL_ENV`, Python `Scripts/`, and Windows `Scripts/Scripts/`. Pass `--moss-bin <path>` only if auto-detection fails |
| `Observation: moss_source_dir_invalid` during bootstrap | `.moss/MOSS-TTS-Nano` is a partial checkout, wrong repo, or stale interrupted download | Let bootstrap repair the managed source dir, or pass a clean external MOSS checkout. Do not create `pyproject.toml` manually or install `transformers` |
| Only background and narration render | Scene roots are hidden, often `.scene { opacity: 0 }`, while only child elements are animated | Remove scene-root `opacity:0`, animate children with `gsap.from()`, then run `visual-guard` and snapshots |
| Snapshot shows a catalog block but rendered MP4 is blank at that timestamp | A mounted `data-composition-src` file is a standalone HTML page instead of a `<template>` sub-composition, or host/inner/timeline ids do not match | Convert the block to template sub-composition form, make ids match, rerun `visual-guard`, then render and extract the MP4 frame at the same timestamp |
| Google Fonts warnings | Composition loads fonts from `fonts.googleapis.com`/`fonts.gstatic.com`, so headless render depends on network and fallback metrics | Remove remote font imports. Use system stacks or bundle local `assets/fonts/*.woff2` with `@font-face` |
| `font_family_without_font_face` mentions `var(--font-body)` or a Chinese system font | Lint cannot resolve CSS font variables and may not auto-resolve named Chinese system fonts | Use direct generic stacks such as `"Segoe UI", sans-serif`; define local `@font-face` only for bundled fonts |
| Validate logs `Invalid property force3D` or `autoRound` | Those properties were put in `gsap.defaults()` | Remove them from global defaults; stabilize text by avoiding continuous scale/rotation on live text |
| All black | Runtime not loaded, wrong composition id, timeline not registered | Check script order and `window.__timelines` key |
| Scene visible for whole video | Timed element lacks `class="clip"` | Add `clip` class |
| Tiny unstyled content in corner | Sub-composition styles/scripts outside `template` | Move style/script into template |
| Missing sub-comp scene | Host id, inner id, and timeline key mismatch | Make all three identical |
| WebGL catalog block fails with `Illegal invocation` | DOM-to-canvas/WebGL capture can break when adapted as a mounted sub-composition | Snapshot and validate early; hand-author a CSS/GSAP equivalent or inline the effect in the host if it validates there |
| Text clipped despite no lint issue | Root or content container not actually sized | Add explicit width/height to root and ancestors |
| Black tail after existing footage | Composition/card duration exceeds media duration | Clamp to ffprobe duration |
| MOSS audio exists but `wordsPath` is empty | Word timings were not requested or transcription failed | Use narrator scripts for normal subtitles; check `audio_meta.transcription_errors` and install whisper.cpp only for word-level timing |
| MOSS model download from Hugging Face times out | Hugging Face access is slow or the agent's outer exec killed the process before fallback | Run `moss-models --skip-hf` to use ModelScope-only direct downloads. If both sources fail, report the `Observation: moss_model_download_failed` block |
| Whisper model download times out or fails | Network/proxy/Hugging Face/ModelScope access problem | If the Hugging Face command timed out, run the ModelScope-only command with `--skip-hf`. If both sources fail, stop retrying and report the `Observation: whisper_model_download_failed` block with the printed target path |
| Whisper doctor passes `--help` but real transcription crashes, or `STATUS_ACCESS_VIOLATION` appears | The native `whisper.cpp` binary is not reliable on this host, often because a build cache was copied from another machine, native GPU/CPU/runtime assumptions differ, or the model file is partial/corrupt | Run `whisper-doctor --json`; if it reports `whisper_runtime_failed`, run its clean rebuild command. If the model is reported incomplete, rerun `whisper-models` or manually replace the printed model path |
| Existing-video plain subtitles create a huge `work-*` folder with `captured-frames` | The agent used HyperFrames render instead of FFmpeg subtitle burn-in; long renders produce one temporary frame per output frame | Use `burn-subtitles` for plain captions. If a previous render was killed by an outer timeout, the leftover `work-*` directory can be deleted after confirming no render process is still running |
| Generated narration has no subtitles | The script-derived caption step was skipped | Run `moss-captions`, then add timed caption clips from `captions.json` |
| Chinese subtitles show single characters or broken words | Caption text was split with too small a chunk size or an older hard-slice caption file | Rerun `moss-captions` with the current script; use `--max-chars 20 --min-chars 4` or larger for a calmer rhythm |
| First syllable clipped or scene changes feel breathless | Voice clips are too tightly padded for the renderer/player | Rerun `moss-audio` with `--pad-start-ms 300 --pad-end-ms 500`, then rebuild scene starts from `audio_meta.json` |
| Text/cards/captions overlap or important content leaves frame | Static lint cannot see animated browser geometry at sampled times | Run `layout-guard`; fix `off_canvas` and `caption_collision`, then resnapshot |
| Layout guard unavailable | Chrome/Headless Shell cannot be found | Run `npx hyperframes browser ensure` or set `HYPERFRAMES_CHROME_PATH`, then rerun |
| Render succeeded but no output | Wrong output path or render failure not caught | Check file exists and size > 0 |

## Completion Gate

For a normal deliverable, complete only after:

1. `lint` passes.
2. `validate` passes or warnings are explained.
3. `inspect` passes or intentional overflows are justified.
4. `layout-guard` passes for user-facing videos with captions, dense layouts, catalog blocks, or sub-compositions.
5. Snapshots or preview were checked when visual risk is high.
6. Rendered output exists and has plausible size if an MP4 was requested.
