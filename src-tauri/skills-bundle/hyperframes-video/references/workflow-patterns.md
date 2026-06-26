# Workflow Patterns

Use this file after choosing a route in `SKILL.md`. It defines a compact HyperFrames video workflow for agents. Prefer concrete project progress over loading more documentation.

## Table Of Contents

- Shared setup
- Complex project upgrade path
- Product promo
- Website video
- Faceless explainer
- Motion graphic
- Graphic overlays
- Captions
- PR or changelog video
- Remotion port
- General/freeform

## Shared Setup

1. Create a work directory under the user's workspace, usually `videos/<project-name>/`.
2. Keep source assets in `assets/` or `public/`.
3. Keep final or preview renders in `renders/`.
4. Keep intermediate notes small: `scene-plan.md`, `storyboard.json`, `metadata.json`, or `transcript.json` only when useful.
5. Do not generate footage HyperFrames cannot capture. HyperFrames can compose  HTML, screenshots, audio, and existing media; it is not an NLE, camera recorder, or avatar generator.

## Complex Project Upgrade Path

Keep the lightweight path for one-scene, short, or low-risk projects. When a narrated video has many scenes, captions, BGM, video assets, or several sub-compositions, add a central production ledger before building.

Recommended ledger fields:

1. `scene_id`, `start_s`, `duration_s`, `layout_archetype`, `voicePath`, `captionState`, `transition`, `assetCandidates`, and `composition_file`.
2. Canvas width/height, caption safe band, and total duration.
3. A film-level direction block: palette, type, motion rules, negative list, and final CTA.
4. Verification status per scene: lint, validate, inspect, layout-guard, snapshot, and any manual contact-sheet notes.

Important safeguards:

- Treat measured `audio_meta.json` voice durations as timing truth, then derive scene starts from the ledger.
- Use a modular host for projects over about 60 seconds, over 8 scenes, or with several catalog blocks/assets/caption layers. Keep `index.html` as the top-level timeline and mount section files from `compositions/`.
- Split by natural story sections, not arbitrary minute marks. Aim for about 30-75 seconds per sub-composition; a simple 65-second piece can stay single-file, while a dense 40-second piece may deserve modules.
- Multiple HTML files render as one video when the top-level `index.html` mounts them with `data-composition-src`. Render the host, not each section file separately.
- Keep each sub-composition's internal timing local, starting near 0. The host slot provides the global `data-start` and `data-duration`.
- Keep scene roots visible by default. Do not use `.scene { opacity: 0 }`; animate child elements and let HyperFrames clip timing handle scene visibility.
- Vary `layout_archetype` across adjacent scenes. The selected frame system supplies style tokens, not a fixed layout sequence.
- Keep media as host-root clips in `index.html`. If a scene declares footage, mount or hoist the real `<video>` at the host root and animate a poster/wrapper from the scene timeline.
- For captions, reserve a keep-out band and verify foreground elements do not collide with it.
- For dense layouts, run `visual-guard`, `check --layout`, then snapshots at scene midpoints and seams. Fix blank frames, clipped text, black tails, caption collisions, and unreadable overlap before rendering.
- For long or user-facing deliverables, stay in this workflow but raise the discipline: keep the ledger current, run snapshots at every scene midpoint, and do not render until lint, validate, inspect, layout-guard, and visual smoke checks are clean.

## Product Promo

Use for a product/company/app/SaaS being marketed, launched, or promoted.

Minimum flow:

1. Gather brand source: URL/screenshots/brand guide/script/brief.
2. Decide script mode: verbatim user script or rewritten scene copy.
3. Extract visual identity: colors, typography, UI surfaces, icons, product terms, proof points.
4. Create a 5-10 scene arc: hook, problem, product reveal, feature proof, differentiator, CTA.
5. Build product-forward visuals. Use real screenshots when supplied or captured; otherwise create text/shape/UI-inspired scenes.
6. Validate and render.

Ask one question only when it is unclear whether the user wants to promote the product or neutrally explain the underlying topic.

## Website Video

Use when the video is "of/from a website" rather than selling a product.

Minimum flow:

1. Capture or inspect the URL. If browser/capture tooling is unavailable, use user-provided screenshots or static page assets.
2. Pull the site identity: homepage sections, dominant colors, headings, imagery, interactions, and CTAs.
3. Create a site tour/showcase arc: identity, key sections, visual details, navigation, final URL/brand frame.
4. Avoid inventing claims that are not visible on the site.
5. Validate with snapshots because screenshot scaling and text overflow are the common failure points.

## Faceless Explainer

Use for a concept/topic/article/notes explanation with no product to promote.

Minimum flow:

1. Summarize the source into 4-8 beats.
2. Pick a visual metaphor and style. "Pin-and-paper" is a good default for explainers; keep the visuals concrete, not just abstract gradient slides.
3. Create scenes with typography, diagrams, data-viz, labeled objects, or process flows.
4. If narration/TTS is in scope, read `moss-tts-audio.md`, write short spoken lines first, generate MOSS audio, and time visuals to measured voice duration. If the user asked for subtitles, generate script-derived captions with `moss-captions` and add a visible caption layer. If not, make on-screen text carry the explanation.
5. Keep scenes short and readable; split dense paragraphs.

## Motion Graphic

Use for a short, unnarrated, design-led piece where the motion is the message.

Common outputs: logo sting, lower-third, kinetic title, stat/count-up, chart hit, animated quote/headline/tweet, motion poster, single page-highlight.

Minimum flow:

1. Keep it one scene or a few quick beats, usually under 10 seconds.
2. Use the single-file template unless a transparent overlay or host media is required.
3. Build one polished hero frame, then add motion. Do not expand into a full explainer unless asked.

## Graphic Overlays

Use when existing footage plays in full and agent adds designed cards on top of it: titles, lower-thirds, callouts, quotes, side panels, picture-in-picture, or data cards. Do not re-time, recolor, cut, reframe, or alter the underlying clip.

Minimum flow:

1. Extract metadata with `ffprobe`: width, height, duration, fps.
2. Extract audio with `ffmpeg`.
3. Transcribe audio with `npx hyperframes transcribe ... --json`.
4. Correct obvious transcript errors while preserving word timestamps.
5. Draft `storyboard.json` with `schemaVersion: 3`: card id, intent, start/end, `zone`, accent, content hints, optional transition. Use `card.zone` for placement; do not invent a separate `card.layout` field.
6. Author card HTML/CSS/GSAP and an assembled `index.html` that mounts the video plus timed overlay clips.
7. Clamp all card end times and root duration to media duration to avoid black tails.
8. Validate and render.

Useful card zones: `fullscreen`, `lower-third`, `side-panel`, `video-overlay`, and `whiteboard-area`.

## Captions

Use when the user wants spoken words as readable subtitles/captions, not designed info cards.

Plain captions/subtitles are in scope for this lightweight workflow. Cinematic or embedded captions behind a person are advanced: do them only when local matting, safe-zone preview, and composited-frame QA are available. If those tools are not available, state the limitation and offer plain readable captions instead.

Generated narration captions minimum flow:

1. Do not transcribe generated MOSS narration to recover text.
2. Generate audio from `narrator_scripts.json`.
3. Run `scripts/hf-workflow.mjs moss-captions <project>` to create `captions.json`.
4. Author a bottom-safe timed caption layer from `captions.json`; each caption is a HyperFrames `clip`.
5. Validate contrast, text fit, and collision with scene graphics.

Existing video captions minimum flow:

1. Extract audio and transcribe.
2. Correct transcript text while preserving timing.
3. For plain readable burned-in subtitles, use `hf-workflow.mjs burn-subtitles <video> --srt transcript.srt --out captioned.mp4`. Do not create a HyperFrames project or run `render` for this case; long videos would be captured frame-by-frame and can create thousands of temporary screenshots.
4. Use a HyperFrames project only when the user asks for animated captions, karaoke effects, embedded/cinematic captions, designed overlays, or other visual graphics beyond plain subtitle burn-in.
5. Validate contrast and keep captions away from important subject areas when possible.

Embedded/cinematic captions advanced flow:

1. Probe the video before authoring. Refuse or ask for a trimmed clip when there are multiple speakers, hard cuts, no clear single subject, existing burned-in captions, near-silent audio, unusable transcript, or fast handheld motion that will break the matte.
2. Generate foreground/background matte frames with `hyperframes remove-background` or another local matte preparation step.
3. Read safe-zone data before placing text. Ordinary transcript text should remain a readable rail; only a few peak words or phrases should be embedded behind the subject.
4. Preview composited frames before rendering. Check washout, text-on-text, reading order, hero presence, face coverage, and timing.
5. Do not grade, recolor, re-time, reframe, or reorder the footage. Captions are the only intended addition.

## PR Or Changelog Video

Use for GitHub PRs, diffs, release notes, or code-change explainers.

Minimum flow:

1. Read PR metadata, title, description, commits, changed files, and diff.
2. Identify the viewer: developer changelog, product release, or internal review.
3. Create a concise arc: problem, changed areas, before/after, user impact, test/rollout note.
4. Use code snippets, file-tree graphics, diff highlights, and system diagrams.
5. Do not overclaim behavior not proven by the diff or tests.

## Remotion Port

Use only when the user explicitly asks to port/convert/migrate an existing Remotion composition to HyperFrames.

Minimum flow:

1. Read the Remotion source and rendered expectations if available.
2. Map Remotion scenes/components to HyperFrames clips or sub-compositions.
3. Replace React-time logic with deterministic HTML/CSS/JS and a seekable timeline.
4. Compare snapshots or renders against the original if available.

## General/Freeform

Use for longer pieces, loops, custom reels, edits to existing HyperFrames projects, or anything that does not match a specialized route.

Minimum flow:

1. Build exactly what was asked.
2. If open-ended, ask for audience/platform/priority only when needed.
3. Establish visual identity and a one-sentence concept angle.
4. Plan structure, timing, transitions, and assets.
5. Build layout first, animate second, validate third.
