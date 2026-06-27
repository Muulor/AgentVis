# MOSS-TTS-Nano Audio

Use this reference when a HyperFrames video needs generated narration, especially Chinese narration or user-reference voice cloning.

## Source Facts

- MOSS-TTS-Nano is a local multilingual TTS model with about 0.1B parameters.
- The recommended lightweight path is ONNX CPU: `--backend onnx`.
- `moss-tts-nano generate` supports `--prompt-speech <audio>` for voice cloning.
- `--text-file` is supported for long-form text.
- The CLI supports `--output <wav>`; default output is otherwise `generated_audio/moss_tts_nano_output.wav`.
- ONNX supports built-in voices via `--voice`; default is `Junhao`(Male voice) or `Yuewen`(Female Voice) in the MOSS CLI. Use this when the user did not supply reference audio.
- The ONNX release is intended to be torch-free for inference and supports reference audio voice cloning. Some Python package builds may still import `torch`/`torchaudio`; test the installed CLI before promising clone support in a minimal dependency environment.
- Generated MOSS narration already has authoritative text in `narrator_scripts.json`; do not ASR it merely to get subtitles.
- MOSS output has no HyperFrames-compatible word timestamps. Run `hyperframes transcribe` only when word-synced captions, karaoke-style  subtitles, or word-triggered graphics need precise timing.
- HyperFrames transcription uses local `whisper.cpp` with ggml Whisper models, supports CPU inference, and does not require PyTorch/Torch or a GPU. Use multilingual `small-q8_0` plus `--language zh` for Chinese word timings. This workflow stores Whisper model files in the same app-cache namespace as MOSS, for example `%LOCALAPPDATA%\hyperframes-video\whisper` on Windows. Run `hf-workflow.mjs whisper-doctor --model small-q8_0 --json` before requesting word timings on a new host.
- For ordinary subtitles on generated narration, create script-derived captions from `narrator_scripts.json` and `audio_meta.json`; ASR is unnecessary.

Primary sources:

- https://github.com/OpenMOSS/MOSS-TTS-Nano
- https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Nano-100M
- https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX
- https://modelscope.cn/models/openmoss/MOSS-TTS-Nano-100M-ONNX
- https://modelscope.cn/models/openmoss/MOSS-Audio-Tokenizer-Nano-ONNX

## Provider Policy

For this skill, do not use HeyGen, ElevenLabs, or Kokoro for new generated narration unless the user explicitly asks for them. Use MOSS-TTS-Nano instead.

Use this choice ladder:

1. If the user supplied reference speech, use it with `--prompt-speech`.
2. If no reference speech is supplied, use ONNX built-in voice `Junhao`(Male voice) or `Yuewen`(Female Voice) unless the user selects another MOSS voice preset.
3. If the user supplied already-recorded narration, skip TTS and transcribe only when captions or word timings are requested.

Voice cloning safety: use only reference audio the user owns or has permission to use. Do not imply the workflow can clone a third-party voice without consent.

## Model Asset Policy

Do not download or bundle model weights into this skill's `assets/` folder.

Reasons:

- Skill assets should stay small, reviewable, and portable.
- Model weights change independently from the workflow.
- Some environments need a different cache, mirror, or preseeded model path.
- Redistributing model files inside a skill makes license and update management harder.

Preferred behavior:

- Use the skill's shared user cache by default. On Windows this is `%LOCALAPPDATA%\hyperframes-video\moss-onnx`; on macOS it is `~/Library/Caches/hyperframes-video/moss-onnx`; on Linux it is `${XDG_CACHE_HOME:-~/.cache}/hyperframes-video/moss-onnx`.
- Override the shared cache with `HYPERFRAMES_VIDEO_MOSS_MODELS_DIR=<dir>` or `--onnx-model-dir <dir>` only when the user needs a controlled cache location.
- If the default Hugging Face download path is unreliable, preseed the shared cache with `moss-models`. For agent-safe retries, run Hugging Face-only first with `--skip-modelscope`; if that fails or an outer exec timeout kills it, run ModelScope-only with `--skip-hf`. Direct downloads print sparse `Progress:` heartbeats, first after about 15 seconds and then about every 30 seconds, so agents can inspect the last heartbeat after an outer timeout without filling normal command results with progress spam.

## Narrator Scripts

Create `narrator_scripts.json` in the HyperFrames project before generating audio. Keep scripts short because real TTS duration becomes the timing truth. For Chinese narration, prefer short sentences and enumeration marks such as `、`; avoid long comma chains. MOSS can insert long pauses around repeated commas and may hit `--max-new-frames`, creating a much longer scene than intended.

```json
{
  "project": "Example explainer",
  "language": "zh",
  "scenes": [
    {
      "sceneNumber": 1,
      "sceneName": "Hook",
      "estimatedDuration": "6s",
      "script": "一句短解说，先给观众一个清晰问题。"
    }
  ]
}
```

Accepted scene text fields are `script`, `narration`, `text`, or `voiceover`; prefer `script` for compatibility with official HyperFrames workflows.

## Generate Audio

## Dependency Setup

In managed agent apps, the `## Dependencies` block in `SKILL.md` is the static-install surface. It installs ONNX runtime dependencies only. The MOSS source tree is intentionally not listed as a normal pip dependency because a plain `pip install git+...` pulls the full PyTorch stack.

Before generated narration, run:

```bash
node <skill>/scripts/hf-workflow.mjs moss-doctor --json \
  --python python
```

If it returns `ok:false`, run its `recommendedCommands` in order. For a fresh machine, the usual managed-runtime bootstrap command is:

```bash
node <skill>/scripts/hf-workflow.mjs moss-bootstrap \
  --in-place \
  --python python \
  --source-dir ./.moss/MOSS-TTS-Nano \
  --skip-models
```

This uses the current Python runtime, installs MOSS from source with `--no-deps`, and applies the torch-free ONNX reference-audio patch. Add `--skip-deps` if the host app already installed the `## Dependencies` block and disallows runtime pip installs. Preload the two ONNX model repos separately so download retries can switch mirrors cleanly:

```bash
node <skill>/scripts/hf-workflow.mjs moss-models --skip-modelscope
node <skill>/scripts/hf-workflow.mjs moss-models --skip-hf
```

Dependency rules:

- For fixed Python 3.13/3.14 runtimes, continue if the dependency block installs and `moss-doctor` passes.
- Do not use `pip install git+https://github.com/OpenMOSS/MOSS-TTS-Nano.git` for this workflow; it tries to install the full PyTorch dependency set.
- If `moss-bootstrap` reports `Observation: moss_source_dir_invalid`, the MOSS source checkout is incomplete or from the wrong repo. Let bootstrap repair the managed `.moss/MOSS-TTS-Nano` directory, or provide a clean checkout. Do not create `pyproject.toml` manually and do not install `transformers`.
- Do not try `npx moss-tts-nano`; MOSS-TTS-Nano is a Python CLI, not an npm CLI.
- `moss-audio` auto-detects the CLI from `--moss-bin`, `MOSS_TTS_NANO_BIN`, `VIRTUAL_ENV`, the current Python Scripts directory, and the Windows embedded-runtime fallback `Scripts/Scripts/moss-tts-nano.exe`. Pass `--moss-bin <path>` only if all auto-detection fails.
- If models were intentionally bootstrapped somewhere else, pass `--onnx-model-dir <models-dir>` to `moss-audio`.

Default local Chinese narration with the built-in MOSS voice:

```bash
node <skill>/scripts/moss-audio.mjs ./my-video --language zh
```

Voice clone from a user-provided reference audio:

```bash
python -m pip install soundfile
node <skill>/scripts/moss-patch-onnx-torchfree.mjs --python python

node <skill>/scripts/moss-audio.mjs ./my-video \
  --prompt-speech ./reference-voice.wav \
  --language zh
```

The helper copies the reference audio into `assets/voice/prompt/` before running MOSS so scene output cleanup never mutates the user's source file.

The torch-free patch is an environment patch, not a fork bundled into this skill. It locates the installed `onnx_tts_runtime.py`, removes the top-level `torch`/`torchaudio` imports, and replaces only the reference-audio loader with `soundfile` + `numpy`. Use it when ONNX built-in voices work but `--prompt-speech` fails because `torchaudio` is missing.

Same command through the workflow helper:

```bash
node <skill>/scripts/hf-workflow.mjs moss-audio ./my-video \
  --prompt-speech ./reference-voice.wav \
  --language zh
```

When the user asks for subtitles/captions with generated narration, immediately generate script-derived caption timing:

```bash
node <skill>/scripts/hf-workflow.mjs moss-captions ./my-video
```

This writes `captions.json`. For Chinese videos, the default preferred chunk size is 20 characters, with punctuation-aware splitting and short-orphan merging so words such as "测试" or "技术" are not split into separate captions. It also shortens adjacent caption ends by `--caption-gap-s 0.01` by default to avoid same-track floating-point overlap when building HyperFrames clips. Override with `--max-chars 14` for faster subtitle rhythm, `--max-chars 22 --min-chars 4` for calmer subtitles, or `--hard-max-chars <n>` when a strict visual line-length limit is needed.

Optional controlled ONNX model directory:

```bash
node <skill>/scripts/moss-models.mjs ensure --dir D:/hf-model-cache/moss-onnx

node <skill>/scripts/moss-audio.mjs ./my-video \
  --onnx-model-dir D:/hf-model-cache/moss-onnx \
  --language zh
```

The model helper tries Hugging Face first, then falls back to ModelScope direct file downloads for any incomplete ONNX repo. The shared cache or directory passed with `--onnx-model-dir` is the parent folder containing both `MOSS-TTS-Nano-100M-ONNX/` and `MOSS-Audio-Tokenizer-Nano-ONNX/`.

For agent runtimes with short outer exec timeouts, use two explicit commands rather than relying on one long in-process fallback command:

```bash
node <skill>/scripts/moss-models.mjs ensure --dir D:/hf-model-cache/moss-onnx --skip-modelscope
node <skill>/scripts/moss-models.mjs ensure --dir D:/hf-model-cache/moss-onnx --skip-hf
```

If either command is killed by the outer exec timeout, inspect the last `Progress:` line. Increasing byte counts mean the download was moving and the next attempt can use a longer exec timeout; no progress or repeated failures should be reported with the printed `Observation: moss_model_download_failed` block.

The ModelScope direct mirrors are:

```text
https://modelscope.cn/models/openmoss/MOSS-TTS-Nano-100M-ONNX
https://modelscope.cn/models/openmoss/MOSS-Audio-Tokenizer-Nano-ONNX
```

By default, `moss-audio.mjs` adds 240 ms of leading silence and 360 ms of tail silence to each scene voice file. This prevents first-syllable clipping and gives hard scene cuts a clear audible pause. Override with `--pad-start-ms 0 --pad-end-ms 0` only when the composition already handles audio pre-roll and scene gaps. If the first syllable still sounds clipped, raise `--pad-start-ms` to 300-400. If scene changes still feel rushed, raise `--pad-end-ms` to 450-600 or insert a small visual timeline gap.

## Outputs

The helper writes:

- `assets/voice/scene_<N>.wav`
- `assets/voice/scene_<N>_words.json` when `--word-timings` transcription succeeds
- `assets/voice/scripts/scene_<N>.txt`
- `audio_meta.json`
- `captions.json` after running `moss-captions`

`audio_meta.json` is compatible with the official duration truth ladder: `audio_meta.scenes[sceneId].voiceDuration` overrides estimated scene duration. The measured duration includes any configured audio padding.

## Composition Use

Use the generated voice file as a direct child of the composition root:

```html
<audio
  id="voice-scene-1"
  class="clip"
  src="assets/voice/scene_1.wav"
  data-start="0"
  data-duration="6.32"
  data-track-index="10"
></audio>
```

For normal subtitles, use `captions.json` as the caption timing source. Author each item as a timed caption clip with `class="clip"`, `data-start`, `data-duration`, and a high `data-track-index`. Reserve a bottom safe band and keep captions above any UI, lower-third, or CTA.

Minimal caption HTML pattern:

```html
<div
  id="scene-1-caption-1"
  class="clip caption"
  data-start="0.24"
  data-duration="1.82"
  data-track-index="20"
>
  这是一条从旁白脚本直接生成的字幕。
</div>
```

Recommended caption CSS:

```css
.caption {
  position: absolute;
  left: 50%;
  bottom: 56px;
  transform: translateX(-50%);
  max-width: min(84%, 1180px);
  padding: 10px 18px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.62);
  color: white;
  font-size: 34px;
  line-height: 1.35;
  text-align: center;
  text-wrap: balance;
  text-shadow: 0 2px 8px rgba(0, 0, 0, 0.65);
}
```

For normal subtitles, never run ASR just to recover the text. Use `narrator_scripts.json` as the source text and `audio_meta.json` as scene timing truth. The `moss-captions` helper combines both into `captions.json`.

For word-synced captions or word-triggered graphics, run `moss-audio.mjs --word-timings` and read each `scene_<N>_words.json`. Keep any transcription corrections text-only; preserve timestamps.

When building scene starts from `audio_meta.json`, insert a tiny timeline gap such as 0.01 s between adjacent clips to avoid floating-point overlap warnings in HyperFrames lint. When authoring captions from `captions.json`, compute `data-duration` from each caption's `end - start`; the helper already applies the default caption gap.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Agent is unsure how to install MOSS | Run `scripts/hf-workflow.mjs moss-doctor --json` and follow `recommendedCommands`; do not probe npm or install full PyTorch |
| `moss-tts-nano` not found | Run `moss-doctor --json`. `moss-audio` searches PATH, `MOSS_TTS_NANO_BIN`, `VIRTUAL_ENV`, Python `Scripts/`, and Windows `Scripts/Scripts/`; if all fail, pass `--moss-bin <path>` |
| CLI installed in `Scripts/Scripts` on Windows | This is a non-standard embedded Python layout. Current `moss-audio` and `moss-doctor` auto-detect it; no manual `dir /s` probe is needed |
| `Observation: moss_source_dir_invalid` | The source dir is a partial checkout, wrong repo, or stale interrupted download. Let `moss-bootstrap` repair the managed `.moss/MOSS-TTS-Nano` directory, or provide a clean MOSS checkout. Do not create `pyproject.toml` manually or install `transformers` |
| Full `pip install git+...` fails on torch | Stop that path. Use `scripts/hf-workflow.mjs moss-bootstrap --in-place --python python --source-dir ./.moss/MOSS-TTS-Nano`; model weights go to the shared user cache by default |
| Python 3.13/3.14 package resolution fails | The fixed runtime lacks a required wheel such as `onnxruntime`; the skill cannot repair that except by using a compatible runtime |
| First run is slow | Model weights are downloading or ONNX runtime is initializing |
| Hugging Face model download fails or stalls | Run `scripts/moss-models.mjs ensure --skip-hf` to use ModelScope-only direct downloads. Use `HYPERFRAMES_VIDEO_MOSS_MODELS_DIR` or `--dir` only for a custom cache |
| Chinese transcript is wrong or translated | Use `--language zh --whisper-model small-q8_0` or a larger multilingual Whisper model; never use `small.en-q8_0` for Chinese |
| `whisper-cpp not found` during transcription | Audio generation still succeeded, but word timings were skipped. For normal subtitles, use the script text directly. For word-level timing, run `scripts/hf-workflow.mjs whisper-doctor --model small-q8_0 --json` and follow `nextCommand` |
| `wordsPath` is empty | Normal unless `--word-timings` was requested. Use scene scripts for standard captions |
| User requested subtitles but none appear | Run `scripts/hf-workflow.mjs moss-captions <project>`, then add timed caption clips from `captions.json` to the composition |
| Chinese captions contain one-character clips or broken words | Rerun `moss-captions`; current splitting uses punctuation and merges short orphan chunks. If a manually overridden value caused this, use `--max-chars 20 --min-chars 4` or larger |
| Chinese scene audio is far longer than the script estimate | The script may contain a long comma chain or MOSS may have reached `--max-new-frames`. Rewrite as shorter sentences, replace comma lists with `、`, then rerun `moss-audio`; inspect `audio_meta.duration_warnings` |
| First syllable sounds clipped | Keep the default `--pad-start-ms 240`; raise it to 300-400 ms if the player or encoder still cuts the attack |
| Scene-to-scene narration feels rushed | Keep the default `--pad-end-ms 360`; raise it to 450-600 ms or insert a 0.15-0.25s visual gap before the next scene |
| `--prompt-speech` needs `torchaudio` in a minimal ONNX setup | Install `soundfile`, then run `scripts/moss-patch-onnx-torchfree.mjs --python <python>` to replace only the ONNX reference-audio loader |
| Voice clone ignored | Confirm `--prompt-speech` points to an existing WAV/MP3 and the backend is `onnx` |
| Scene audio is cut short | Raise `--max-new-frames`; then rerun audio and rebuild scene timings from `audio_meta.json` |
