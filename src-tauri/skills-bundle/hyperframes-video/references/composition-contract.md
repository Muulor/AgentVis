# Composition Contract

Read this before writing or substantially editing HyperFrames HTML.

## Minimal Standalone Shape

Use a sized root directly in `body`; no `template` wrapper for top-level `index.html`.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/@hyperframes/core/dist/hyperframe.runtime.iife.js"></script>
  </head>
  <body style="margin:0;background:#101114;color:#f7f3ea;">
    <div
      id="main"
      data-composition-id="main"
      data-start="0"
      data-width="1920"
      data-height="1080"
      data-duration="6"
      style="position:relative;width:1920px;height:1080px;overflow:hidden;"
    >
      <section class="clip scene" data-start="0" data-duration="6" data-track-index="1">
        <div class="scene-content">
          <h1 id="title">HyperFrames</h1>
        </div>
      </section>
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      var tl = gsap.timeline({ paused: true });
      tl.from("#title", { y: 40, opacity: 0, duration: 0.6, ease: "power3.out" }, 0.2);
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
```

## Required Attributes

Root:

- `data-composition-id`: stable id, also the timeline registry key.
- `data-start`: must be `"0"` on the root element for playback to begin.
- `data-width`, `data-height`: render dimensions.
- `data-duration`: total duration in seconds.
- CSS: explicit `position`, `width`, `height`, and `overflow`.

Timed clips:

- `class="clip"` plus any custom class.
- `data-start`: absolute start seconds, or supported expression in existing projects.
- `data-duration`: clip duration in seconds.
- `data-track-index`: track used for visibility/layer timing. This is not CSS `z-index`.
- Scene roots must be visible by default. Do not set `.scene { opacity: 0 }` or inline `style="opacity:0"` on scene clips. Prefer animating child elements instead.

## Timeline Contract

- Use exactly one paused GSAP timeline per composition unless the project has a deliberate multi-runtime architecture.
- Register it synchronously:

```js
window.__timelines = window.__timelines || {};
window.__timelines["main"] = tl;
```

- The registry key must equal the root `data-composition-id`.
- `data-duration` defines render length, not GSAP timeline length.
- For sub-compositions, do not manually add child timelines to the host timeline. HyperFrames drives them.
- Avoid repeated `scale`, `rotation`, or subpixel yoyo on live text; keep key text static after entrance and animate accents or backgrounds for hold motion. Do not put `force3D` or `autoRound` in `gsap.defaults()`; HyperFrames validation can report those as invalid GSAP properties.

## Determinism Rules

Avoid anything that changes between render samples:

- No `Date.now()`, `performance.now()`, unseeded `Math.random()`, live network fetches, or at-render-time data pulls.
- Do not load Google Fonts or external CSS with `@import`/`<link>` at render time. Use system font stacks or bundle font files locally with `@font-face`.
- No timeline construction inside `async`, `setTimeout`, `Promise`, event handlers, media callbacks, or observers.
- No `repeat: -1`; calculate a finite repeat count from clip duration.
- No manual media `play()`, `pause()`, or `currentTime` control.
- Do not animate `display` or `visibility`; use opacity/transforms.
- Do not use `gsap.set()` on a clip before it exists in the DOM at its scene time. Prefer `tl.set(selector, vars, time)` at or after `data-start`.

## Layout Rules

- Size every ancestor needed for `height:100%`.
- Use a full-scene `.scene-content` with padding for title-safe margins.
- Position decorative absolute elements intentionally; keep them clear at their largest animated state.
- Give transformed elements display and dimensions. Scaling an inline span or auto-sized zero-width element can render as no motion.
- Avoid body-copy `<br>` line breaks; use max-width and natural wrapping.
- Reference-frame bleed is allowed only for decorative shapes or intentionally cropped background type. Do not let important headlines, stat numbers, process nodes, diagrams, captions, or CTAs leave the canvas or caption safe zone at any animation sample.
- Avoid rotating a whole diagram or card cluster unless the rotated bounding box still fits. Prefer static layouts with animated arrows, highlights, counters, fills, masks, or accent shapes.

## Media Rules

Video/audio elements must be direct children of the host root in the assembled file. Do not put decoded media inside sub-composition templates or deep wrappers. Animate media wrapper geometry from the host timeline.

Typical host media shape:

```html
<video
  class="clip"
  data-start="0"
  data-duration="20"
  data-track-index="0"
  data-media-start="0"
  src="./assets/input.mp4"
  muted
></video>
```

## Sub-Composition Shape

Use sub-compositions for reused scenes, complex multi-scene work, or when the project already uses modular files. Top-level `index.html` hosts slots; each sub-composition file wraps its root in `template`.

A file referenced by `data-composition-src` is not a normal standalone HTML page in this lightweight workflow. Do not mount a file that starts with `<!doctype html>` / `<html>` / `<body>` unless it also exposes the composition root inside `<template>`. Standalone files can look correct in screenshots yet render blank when assembled into the host video.

For videos over about 60 seconds, over 8 scenes, or with several catalog blocks/assets/caption layers, prefer a modular host structure. Do not make one file per minute mechanically; split at natural section boundaries and target about 30-75 seconds per sub-composition. Rendering the top-level `index.html` renders all mounted sub-compositions into one continuous video.

The host slot owns global time. The sub-composition owns local time. In practice, the host `data-start` places the section on the full video timeline, while clips inside the sub-composition usually start from `0` and stay within that section's local `data-duration`.

Host slot:

```html
<div
  class="clip"
  data-composition-src="./compositions/scene-a.html"
  data-composition-id="scene-a"
  data-start="3"
  data-duration="4"
  data-track-index="2"
></div>
```

Sub-composition file:

```html
<template>
  <div data-composition-id="scene-a" data-width="1920" data-height="1080" data-duration="4">
    <style>/* styles live inside template */</style>
    <section class="clip" data-start="0" data-duration="4" data-track-index="1">...</section>
    <script>
      window.__timelines = window.__timelines || {};
      var tl = gsap.timeline({ paused: true });
      window.__timelines["scene-a"] = tl;
    </script>
  </div>
</template>
```

The host `data-composition-id`, inner root id, and timeline key must match.

## Common Pitfalls

### gsap.from() with CSS opacity:0 — the invisible element trap

`gsap.from({ opacity: 0 })` animates **FROM** 0 **TO** the element's current CSS value. If the element already has `style="opacity:0"` (inline or via class), the animation goes from 0 → 0 and the element never becomes visible.

```html
<!-- WRONG: element is invisible forever -->
<div id="card" style="opacity:0">...</div>
<script>
  tl.from("#card", { opacity: 0, x: 40, duration: 0.6 }); // 0 → 0, no-op!
</script>

<!-- CORRECT: let gsap.from handle the initial hidden state -->
<div id="card">...</div>
<script>
  tl.from("#card", { opacity: 0, x: 40, duration: 0.6 }); // 0 → 1, works!
</script>
```

Rule: **Do not set `opacity:0` via CSS or inline style on elements that `gsap.from()` will animate to opacity.** The `gsap.from()` call itself sets the initial hidden state.

### `.scene { opacity: 0 }` — background and audio only

Do not hide scene roots with CSS in this lightweight workflow. HyperFrames already controls clip visibility from `data-start` and `data-duration`; if the scene parent is transparent, all child titles, cards, captions, and graphics remain invisible even when their own GSAP animations run. Audio can still play because it is not visually affected, creating a "background plus narration only" render.

```css
/* WRONG: every scene stays invisible unless each scene root is explicitly set back to 1 */
.scene {
  position: absolute;
  inset: 0;
  opacity: 0;
}

/* CORRECT: scene roots are visible while their clip is active */
.scene {
  position: absolute;
  inset: 0;
}
```

Animate scene children:

```js
tl.from("#s1-title", { y: 48, opacity: 0, duration: 0.65 }, 0.28);
tl.to("#s1", { opacity: 0, duration: 0.25 }, 3.85);
```

### Google Fonts and remote font CSS

Do not use Google Fonts URLs or external CSS imports in generated compositions. They may work in an interactive browser but fail, stall, or fall back during headless render, causing text reflow, clipped captions, different line breaks, or noisy validation warnings. For frame-specific and Chinese font pairing, read `references/font-assets.md`.

```css
/* WRONG: render-time network dependency */
@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap");

/* CORRECT: stable system stack */
.body {
  font-family: "Segoe UI", sans-serif;
}

/* CORRECT when a specific font is required: bundle it in the project */
@font-face {
  font-family: "ProjectDisplay";
  src: url("./assets/fonts/project-display.woff2") format("woff2");
}
```

Avoid `font-family: var(--font-body)` in generated compositions. Current HyperFrames lint may treat the variable reference as a literal font name. Also avoid explicitly listing Chinese system font names such as `"Microsoft YaHei"` unless you define a local `@font-face` for that family; generic `sans-serif` lets Chromium choose a Chinese fallback without lint noise.

### Floating-point clip boundary overlap

When clips on the same track have `data-start` values that are exact arithmetic sums of previous durations (e.g., `0 + 11.10 = 11.10`), floating-point precision can cause the linter to report an overlap. Shorten the earlier clip's `data-duration` by 0.01s or add a small gap to avoid this:

```html
<!-- Instead of exact boundary touching: -->
<section data-start="0" data-duration="11.10">...</section>
<section data-start="11.10" data-duration="11.58">...</section>

<!-- Use a tiny gap: -->
<section data-start="0" data-duration="11.09">...</section>
<section data-start="11.10" data-duration="11.57">...</section>
```

### Audio clip overlap warning

Multiple `<audio>` elements on the same track that overlap at boundaries trigger a lint warning. Use non-overlapping time windows or different `data-track-index` values for audio tracks.
