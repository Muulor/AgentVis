---
name: hyperframes-video
description: Create, edit, validate, preview, narrate, and render HyperFrames video projects from briefs, URLs, topics, GitHub PRs, existing footage, or motion-graphic requests in one workflow. Use when a user asks to make a video, product promo, website video, faceless explainer, PR/changelog video, graphic overlays, captions, local MOSS-TTS-Nano voiceover, voice-cloned narration from a supplied reference audio, whisper-generated srt subtitles, a logo sting, a title card, or a HyperFrames HTML composition.
triggers: [hyperframes-video, hyperframes, making video, motion graphics, product promo, explainer video, 视频制作, 制作视频, 产品视频, 解说视频, 旁白视频, 添加字幕]
agentvisNetwork: brokerProxyPreferred
---

# HyperFrames Video

Use this as a single practical entry point for HyperFrames work. Keep the main thread focused: route once, load only the reference needed for that route, build the smallest useful project, then verify with CLI gates.

HyperFrames renders deterministic HTML compositions to video. Agent authors the HTML/CSS/JS and supporting assets; `npx hyperframes` validates, previews, and renders.

Narrated projects default to local MOSS-TTS-Nano audio. Use a user-supplied reference audio with MOSS `--prompt-speech` for voice cloning. If no reference audio is supplied, use the MOSS ONNX built-in voice preset instead.

## Dependencies

Runtimes may statically scan this block and install the Python packages before the skill runs. 
```bash
pip install sentencepiece huggingface_hub soundfile
pip install onnxruntime
ffmpeg --version
git --version
cmake --version
```
MOSS source installation is handled by `moss-bootstrap --in-place` so the full PyTorch dependency set is not pulled. `whisper-cli` is provided by whisper.cpp for local ASR; if it is not already installed, `whisper-bootstrap` can build it with git, cmake, and a C/C++ compiler.

## Operating Rule

Do not read every reference by default.

1. Classify the request with the route table below.
2. Read exactly the reference rows that match the route.
3. For any newly authored visual scene, choose one frame reference from `example/<frame>/FRAME.md` using the Frame Direction Library below, unless the user supplied another visual reference or explicitly asked for free creative exploration. Then read `references/font-assets.md` to choose a local/system font strategy, read `references/catalog-effects-guide.md`, and complete the catalog decision gate.
4. Use `assets/templates/single-file-gsap.html` for quick first drafts under about 60 seconds unless the project already exists or a modular/sub-composition layout is clearly needed.
5. Run the CLI gates before claiming completion.

## Route Table

| Request shape | Route | Read |
| --- | --- | --- |
| Short, unnarrated motion piece: logo sting, kinetic type, stat/chart hit, lower-third, title card | `motion-graphic` | `references/motion-and-design.md`, then `references/composition-contract.md` |
| Product/company/app/SaaS launch, promo, feature reveal, or marketing script | `product-promo` | `references/workflow-patterns.md`, then contract/design references |
| General website/site tour/portfolio/blog/landing-page showcase from a URL | `website-video` | `references/workflow-patterns.md`, then contract/design references |
| Concept/topic/article/notes explainer with no product being promoted | `faceless-explainer` | `references/workflow-patterns.md`, then contract/design references |
| Any fresh narrated video, Chinese explainer, local TTS request, or voice-cloned narration from uploaded/reference audio | `moss-narration` | `references/moss-tts-audio.md`, then workflow/contract/design references as needed |
| Fresh generated video that asks for narration plus subtitles/captions | `moss-narration-with-captions` | `references/moss-tts-audio.md`, then workflow/contract/design references as needed |
| Existing talking-head/interview/podcast footage plus plain readable subtitles/captions | `captions` | `references/workflow-patterns.md`, `references/qa-and-cli.md` |
| Existing talking-head footage plus cinematic/embedded/VFX captions behind the subject | `embedded-captions-advanced` | `references/workflow-patterns.md`, `references/qa-and-cli.md`; use the advanced matte path only when the needed local tools are available |
| Existing footage plus designed overlay cards, lower-thirds, callouts, quotes, PiP | `graphic-overlays` | `references/workflow-patterns.md`, `references/qa-and-cli.md`, then contract/design references |
| GitHub PR/code change/changelog video | `pr-video` | `references/workflow-patterns.md`, then contract/design references |
| Existing Remotion project explicitly being ported to HyperFrames | `remotion-port` | `references/workflow-patterns.md`, then contract reference |
| Anything longer than about 3 minutes, static loops, freeform reels, custom edits to an existing HyperFrames project | `general` | `references/workflow-patterns.md`, then the references needed by the edit |

If the route is still ambiguous, ask one short question about input type or intent. Do not block on aspect ratio or language: default to 16:9 and the user's language unless they specify a platform such as Shorts/Reels/TikTok.

In the route table, "contract/design references" means one selected `example/<frame>/FRAME.md`, `references/font-assets.md`, `references/catalog-effects-guide.md`, `references/motion-and-design.md`, and `references/composition-contract.md`. Load exactly one frame reference before visual authoring unless the user specifies another style source.

## Frame Direction Library

Use these downloaded frame systems as concrete visual anchors. Read only one selected `FRAME.md` before writing HTML; do not scan the whole example library during production. Frame docs specify palette, typography, motifs, density, and anti-patterns; they are not layout templates to copy scene by scene. Motion and scene-to-scene layout variety remain governed by `references/motion-and-design.md`.

| Theme or request | Good frame choices |
| --- | --- |
| Enterprise SaaS, product explainers, dashboards, restrained business | `blue-professional`, `cartesian`, `cobalt-grid` |
| AI, developer tools, data, technical reports, systems thinking | `cobalt-grid`, `blue-professional`, `blockframe`, `creative-mode` |
| PR/changelog, code education, debugging, internal engineering | `broadside`, `cobalt-grid`, `blockframe` |
| Editorial, culture, books, essays, thoughtful explainers | `biennale-yellow`, `cartesian`, `editorial-forest` |
| Bold social, creator, launch, high-energy promo | `creative-mode`, `blockframe`, `coral`, `bold-poster` |
| Friendly education, playful concept, youth/community tone | `capsule`, `daisy-days`, `blockframe` |
| Minimal premium, quiet luxury, museum/catalog tone | `cartesian`, `biennale-yellow`, `editorial-forest` |
| Industrial, urgent, manifesto, strong opinion | `broadside`, `coral`, `bold-poster` |

If no option clearly fits, pick the closest tone and adapt content within its tokens. If the user provides a brand guide, screenshot, website capture, or named visual style, use that as the stronger reference.

## Core Workflow

1. **Scope.** Identify subject, input assets, target duration, aspect ratio, and whether the output is a draft project, preview, or final MP4.
2. **Check environment.** Use `scripts/hf-workflow.mjs doctor`; it ignores Docker because Docker is only needed for explicit `--docker` renders, not normal local rendering or CPU MOSS narration. For narrated videos, also run `scripts/hf-workflow.mjs moss-doctor --json` before generating audio. If it returns `ok:false`, run its `recommendedCommands` in order instead of guessing install steps.
3. **Create or open a project.** For a fresh quick draft, copy the single-file template into a project directory as `index.html`. For projects over about 60 seconds, over 8 scenes, or with several catalog blocks/assets/caption layers, use a modular host: `index.html` mounts section files from `compositions/`.
4. **Choose frame direction, fonts, and catalog gate.** Select one frame system from the Frame Direction Library, read that `example/<frame>/FRAME.md`, and bind the video's palette, typography, motif, density, and anti-patterns to it. Use the frame as a style vocabulary, not a scene layout template. Read `references/font-assets.md`, check which local fonts are actually available under `assets/fonts/` or the project, and choose bundled fonts or a safe system fallback before writing CSS. Read `references/catalog-effects-guide.md`, write a compact catalog decision table, and install verified catalog blocks/components for specialty effects unless the table records a clear reason to hand-author.
5. **Plan scenes and file split.** Write a compact scene list: purpose, duration, key text, `layout_archetype`, visual motif, animation idea, required assets, catalog decision, transition, and `composition_file`. Vary layout archetypes across adjacent scenes; do not reuse a centered headline plus corner badge/poster as the default CTA or every section end. For long videos, split by natural sections, usually 30-75 seconds per sub-composition, not by arbitrary clock ticks.
6. **Install selected catalog items.** For each catalog decision marked add, run `npx hyperframes add <id> --dir <project> --no-clipboard`, inspect the installed file, mount it in `index.html`, and snapshot it before depending on it.
7. **Generate local narration when needed.** Read `references/moss-tts-audio.md`, write `narrator_scripts.json`, then run `scripts/moss-audio.mjs`. Use `assets/templates/narrator_scripts.moss.example.json` as the shape hint. Treat measured voice duration as the timing truth. Model weights default to a shared user cache, so different agents and projects reuse one download. If model downloads are unreliable or repeatability matters, run `scripts/hf-workflow.mjs moss-models --skip-modelscope` first; if that fails or an outer exec timeout kills it, run `scripts/hf-workflow.mjs moss-models --skip-hf` for ModelScope-only download. If MOSS is not installed in a managed runtime, run `scripts/hf-workflow.mjs moss-bootstrap --in-place --python python --source-dir ./.moss/MOSS-TTS-Nano --skip-models`, then seed models separately. If a minimal MOSS install imports `torch/torchaudio` only for ONNX reference audio, run `scripts/hf-workflow.mjs moss-patch-torchfree --python <python>` before using `--prompt-speech`.
8. **Generate script-derived captions when requested.** If the user asks for subtitles/captions, run `scripts/hf-workflow.mjs moss-captions <project>` after `moss-audio`. Use the resulting `captions.json` to author timed subtitle clips. Do not ASR generated MOSS narration just to recover text. If Chinese captions look too fragmented, rerun with a calmer rhythm such as `--max-chars 22 --min-chars 4`; avoid one-character or broken-word subtitle clips.
9. **Transcribe only when ASR is useful.** For existing footage/audio, already-recorded narration, karaoke captions, word-synced overlays, or MOSS word timings, run `scripts/hf-workflow.mjs whisper-doctor --model small-q8_0 --json` first. If it returns `ok:false`, run its `recommendedCommands` in order instead of probing random build tools. If a Hugging Face model-download exec times out or is killed, run the next ModelScope-only command directly. Then use local HyperFrames transcription backed by `whisper.cpp`. Prefer multilingual `small-q8_0` for Chinese, mixed, or unknown-language audio; use `small.en-q8_0` only for English-only speech.
10. **Use the lightweight subtitle path for plain captions.** For existing video plus normal readable burned-in subtitles, use `scripts/hf-workflow.mjs burn-subtitles <video> --srt transcript.srt --out captioned.mp4` after transcription. Do not build a HyperFrames overlay project or run `render` unless the user asks for animated, karaoke, cinematic, embedded, or designed overlay captions.
11. **Layout before animation.** Build the final visible frame of each scene in static HTML/CSS first. Then add entrance, hold, and transition motion.
12. **Keep render deterministic.** Bake researched data and assets into the project. No at-render-time network, clocks, random values, media playback calls, or async timeline construction.
13. **Validate.** Run `scripts/hf-workflow.mjs check <project>`; it runs the static visual guard before `lint`, `validate`, and `inspect`. Add `--layout` for narrated/user-facing videos, projects with captions, catalog blocks, sub-compositions, dense diagrams, or any render that previously showed blank/overlapping/out-of-frame content. Use `snapshot` when scenes, sub-compositions, catalog blocks, or transitions need visual smoke testing.
14. **Render only when requested or needed.** Use draft quality while iterating and high quality for the deliverable. Verify that the output file exists and has non-trivial size. The helper stages HyperFrames render temp files in the shared app cache, but plain existing-video subtitles should still use `burn-subtitles` to avoid frame-by-frame browser capture.

## Local Narration Policy

Use MOSS-TTS-Nano for new voiceover unless the user explicitly asks for another provider or supplies already-recorded narration.

- Prefer the MOSS ONNX backend on CPU: `--backend onnx --execution-provider cpu`.
- Managed Python 3.13/3.14 can be used if the dependency block installs and `moss-doctor` passes.
- Do not install MOSS for this workflow with `pip install git+...`; that pulls the full PyTorch dependency set and often fails. Use `moss-bootstrap --in-place`, or install the MOSS source with `pip install --no-deps -e <source-dir>` plus the ONNX dependencies.
- If `moss-bootstrap` reports `Observation: moss_source_dir_invalid` or `pip install -e <source-dir>` fails because packaging files are missing, treat the source checkout as corrupt. Do not create `pyproject.toml` manually and do not install `transformers`; rerun `moss-bootstrap` with the managed `.moss/MOSS-TTS-Nano` source dir or a clean MOSS checkout.
- If the user supplies reference audio, pass it as `--prompt-speech` for voice cloning. Do not ask the user to record inside the workflow.
- If no reference audio is supplied, use the built-in MOSS ONNX voice preset, default `Junhao`(Male voice) or `Yuewen`(Female Voice).
- Keep silence buffers around generated scene audio. The MOSS helper defaults to 240 ms before and 360 ms after each scene to avoid clipped first syllables and over-tight scene changes.
- Do not bundle MOSS model weights in this skill's `assets/`. Model weights default to a shared user cache: on Windows `%LOCALAPPDATA%\hyperframes-video\moss-onnx`; override with `HYPERFRAMES_VIDEO_MOSS_MODELS_DIR` or `--onnx-model-dir` only when needed.
- MOSS ONNX models use two repos: `MOSS-TTS-Nano-100M-ONNX` and `MOSS-Audio-Tokenizer-Nano-ONNX`. The helper tries Hugging Face first and supports ModelScope mirrors under `openmoss/`. Agent-safe setup uses two separate commands: `moss-models --skip-modelscope`, then `moss-models --skip-hf`. Long direct downloads print sparse `Progress:` heartbeats; after an outer exec timeout, inspect the last heartbeat before retrying or reporting manual download instructions.
- Do not transcribe generated MOSS narration merely to recover subtitle text. Use `narrator_scripts.json` as the authoritative caption text and `audio_meta.json` as the scene timing truth.
- When the user requests subtitles for generated narration, always create `captions.json` with `moss-captions` and add a visible timed caption layer in the composition. The helper uses script text, measured scene audio, punctuation-aware CJK splitting, and short-orphan merging; inspect `captions.json` for accidental 1-4 character fragments before rendering. Keep captions plain and readable unless the user asks for karaoke or VFX captions.
- Run HyperFrames transcription only for word-level timing, karaoke-style captions, word-synced graphics, or already-recorded narration. Use `moss-audio --word-timings` with a multilingual Whisper model and `--language zh` for Chinese when this precision is needed.

## Local ASR Policy

Use HyperFrames `transcribe` for existing recorded audio, imported footage, karaoke captions, word-synced graphics, or generated narration only when word timings are required.

- Prefer local `whisper.cpp` before remote ASR when word-level timestamps matter. It runs ggml Whisper models on CPU, does not require PyTorch/Torch or a GPU, and can use GPU acceleration only when the host has it.
- Use multilingual `small-q8_0` for Chinese, mixed-language, or unknown-language audio. Pass `--language zh` when Chinese is known. Use `small.en-q8_0` only for English-only audio. Use full-precision `small` only when the user explicitly wants the larger model.
- Whisper model files are shared in this skill's app cache: on Windows `%LOCALAPPDATA%\hyperframes-video\whisper`; on macOS `~/Library/Caches/hyperframes-video/whisper`; on Linux `${XDG_CACHE_HOME:-~/.cache}/hyperframes-video/whisper`. The first transcription may download `ggml-small-q8_0.bin`, and later agents/projects reuse it. Override with `HYPERFRAMES_WHISPER_MODELS_DIR` only when needed.
- HyperFrames downloads ggml Whisper models from Hugging Face. This workflow's `whisper-models` helper can fall back to the ModelScope mirror `iceCream2025/whisper.cpp` when Hugging Face fails inside the same process. Agent exec timeouts kill the process before in-process fallback can run, so agent-safe setup should try Hugging Face first and then a second ModelScope-only command: `whisper-models --skip-modelscope`, then `whisper-models --skip-hf`. Let the agent/runtime choose command timeouts; pass `--timeout-ms <ms>` only when a specific script-level download timeout is needed. Long downloads print sparse `Progress:` heartbeats so an agent can tell whether bytes are still moving after an outer timeout. It finds `whisper-cli`/`whisper` locally, or builds `ggml-org/whisper.cpp` when git, cmake, and a C/C++ compiler are available.
- Do not start transcription as the first readiness check. Run `whisper-doctor`; it verifies the model file and performs a tiny runtime smoke test when the model is present. If no `whisper-cli` exists and git/cmake/compiler are missing, stop and report that external setup is required. If build tools are available, run `whisper-bootstrap --skip-model` after the model file is ready; future agents reuse the built binary from the app cache.
- Keep `moss-captions` as the default for normal subtitles on generated MOSS narration; ASR the generated audio only for karaoke, word highlights, or word-triggered overlays.

## Non-Negotiable Composition Rules

Read `references/composition-contract.md` before authoring a non-trivial composition. These rules are repeated here because they cause silent failures:

- The standalone root is a sized element directly in `body`; do not wrap it in `template`.
- Every timed visual element has `class="clip"`, `data-start`, `data-duration`, and `data-track-index`.
- Do not set `.scene { opacity: 0 }` or inline `opacity:0` on scene roots. HyperFrames controls scene visibility; hidden scene parents cause background-plus-audio-only renders.
- Register one paused timeline at `window.__timelines["<composition-id>"]`; the key matches the root `data-composition-id`.
- Build timelines synchronously at page load. Do not use `async`, `setTimeout`, `Promise`, event handlers, `Date.now()`, `performance.now()`,`Math.random()`, or `repeat: -1` in render paths.
- Do not use Google Fonts or external CSS `@import`/`<link>` for render-time fonts. Use system font stacks or bundle local font files.
- Do not animate `display` or `visibility`; use opacity/transforms and the clip lifecycle.
- Put video/audio as direct children of the host root, not inside nested templates or wrappers. The framework owns media playback.
- For sub-compositions, the root must be inside `template`; host id, inner id, and timeline registry key must match exactly.
- Text must fit inside the canvas and its intended container. Prefer wrapping with max-width; avoid `<br>` in body copy.

## Design And Motion Defaults

Read one selected `example/<frame>/FRAME.md`, `references/font-assets.md`, `references/catalog-effects-guide.md`, and `references/motion-and-design.md` when creating visuals rather than only editing technical wiring.

- Use the selected frame system as the visual identity: palette, type scale, texture, motif, density, and hierarchy.
- Use the selected frame system for style tokens only. Do not copy its showcase layout literally unless that exact composition is the user's requested object. Story purpose determines layout.
- Treat reference-frame bleed/cropping as decorative only. Keep headlines, captions, data, diagrams, process nodes, and CTAs inside the canvas and caption safe zone at every sampled frame; run `inspect` after motion, not only static snapshots.
- Treat frame font names as visual intent. Use stable local/system fallbacks by default; bundle font files when a specific face is required. For Chinese or mixed Chinese/English videos, use `references/font-assets.md` to map the chosen frame to `Noto Sans SC`/`Noto Serif SC` or another bundled CJK font. Never use Google Fonts or remote font CSS at render time.
- Avoid generic flat centered stacks; video frames need foreground details, edge anchors, motion layers, and readable scale.
- Avoid repeating the same layout skeleton across scenes. In the scene plan, assign distinct `layout_archetype` values such as full-bleed title, split proof, process diagram, object constellation, card grid, timeline/path, quote pullout, UI/screenshot focus, or CTA lockup.
- Use 2-4 motion patterns per scene: entrance, counter/bar/path draw, slow zoom, float/pulse, highlight sweep, or character stagger.
- Keep critical text stable after entrance. Do not add continuous scale/rotation/subpixel yoyo to headlines, captions, or large stat numbers; animate accents, backgrounds, masks, charts, or containers instead.
- Use catalog blocks/components first for specialty effects: code/dev scenes, data/maps, device/UI showcases, social cards, VFX/3D, styled captions, and specialty transitions. Hand-author only when the effect is basic, the user asked for a tiny draft, the catalog item is unavailable, or validation shows the block is unsafe.
- Most scene changes are hard cuts. Reserve effect/shader transitions for 1-3 key moments.
- Do not add extra scenes or narration if the user asked for a small artifact such as a title card or lower-third.

## CLI Helpers

The bundled helper wraps common CLI gates without hiding the raw commands:

```bash
node <skill>/scripts/hf-workflow.mjs doctor
node <skill>/scripts/hf-workflow.mjs visual-guard ./my-video
node <skill>/scripts/hf-workflow.mjs check ./my-video
node <skill>/scripts/hf-workflow.mjs check ./my-video --layout
node <skill>/scripts/hf-workflow.mjs layout-guard ./my-video --samples 18
node <skill>/scripts/hf-workflow.mjs moss-doctor --json --python python
node <skill>/scripts/hf-workflow.mjs moss-bootstrap --in-place --python python --source-dir ./.moss/MOSS-TTS-Nano --skip-models
node <skill>/scripts/hf-workflow.mjs moss-models --skip-modelscope
node <skill>/scripts/hf-workflow.mjs moss-models --skip-hf
node <skill>/scripts/hf-workflow.mjs moss-patch-torchfree --python python
node <skill>/scripts/hf-workflow.mjs whisper-doctor --model small-q8_0 --json
node <skill>/scripts/hf-workflow.mjs whisper-models --model small-q8_0 --skip-modelscope
node <skill>/scripts/hf-workflow.mjs whisper-models --model small-q8_0 --skip-hf
node <skill>/scripts/hf-workflow.mjs whisper-bootstrap --model small-q8_0 --skip-model
node <skill>/scripts/hf-workflow.mjs moss-audio ./my-video --language zh
node <skill>/scripts/hf-workflow.mjs moss-captions ./my-video
node <skill>/scripts/hf-workflow.mjs snapshot ./my-video --frames 9
node <skill>/scripts/hf-workflow.mjs render ./my-video --quality high --output out.mp4
node <skill>/scripts/hf-workflow.mjs burn-subtitles ./input.mp4 --srt ./transcript.srt --out ./captioned.mp4
node <skill>/scripts/hf-workflow.mjs transcribe ./audio.wav --dir ./work --model small-q8_0 --language zh
node <skill>/scripts/hf-workflow.mjs transcribe ./audio.mp3 --dir ./work --model small.en-q8_0
```

Read `references/moss-tts-audio.md` for local narration. Read `references/qa-and-cli.md` for raw CLI equivalents, preview/render discipline, transcription, and troubleshooting.

## Deliverables

For project work, report:

- Project directory and main composition file.
- Route chosen and why.
- Scene count, aspect ratio, total duration, and notable assets.
- Gates run and their result.
- Rendered MP4 path and size/duration if rendered.
- Any limitations, skipped checks, or environment problems.

Do not start a long-running preview server unless the user asks for live preview or the local app instructions require a dev server for the requested deliverable.
