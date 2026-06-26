# Catalog Effects Guide

Use this before writing visual HTML. The catalog is optional for simple typography, cards, fades, and basic diagrams, but it is the preferred path for specialty effects that already exist in HyperFrames.

## What `hyperframes add` Means

`npx hyperframes add <name>` runs the HyperFrames CLI and installs a registry item into the current project. It is not `npm install <name>` and it is not a JavaScript package dependency.

Typical result:

1. A block file is written to `compositions/<name>.html`.
2. The CLI prints a host snippet.
3. The host `index.html` must include that snippet as a timed composition clip.

Typical block host:

```html
<div
  data-composition-id="code-3d-extrude"
  data-composition-src="compositions/code-3d-extrude.html"
  data-start="0"
  data-duration="8"
  data-track-index="1"
  data-width="1920"
  data-height="1080"
></div>
```

Global `npm install -g hyperframes` only changes how the CLI is invoked:

- With global install: `hyperframes add code-3d-extrude`
- Without global install: `npx hyperframes add code-3d-extrude`

In managed agent environments, prefer `npx hyperframes add <name> --dir <project> --no-clipboard` or run through the project directory. After adding, open the installed file and verify it follows sub-composition rules.

## Catalog Decision Gate

Before authoring HTML, write a compact decision table in the scene plan:

| Scene | Visual need | Matching catalog ID | Decision | Reason |
| --- | --- | --- | --- | --- |
| 01 | code hero reveal | `code-3d-extrude` | add | Specialty code effect; catalog match is strong. |
| 02 | plain subtitle | none | hand-author | Basic readable caption; no catalog needed. |

Use decision add when all of these are true:

1. The scene needs a specialty effect: code/dev, data/map, device/UI, social card, VFX/3D, styled captions, or a specialty transition.
2. A candidate ID below clearly matches the scene purpose.
3. The user did not ask for a tiny/lightweight draft and the runtime is not obviously constrained.

Use decision hand-author when the effect is basic typography/layout, a simple fade/translate/stagger/count-up/bar/path draw, a plain readable caption, a small custom diagram, or when the catalog ID is unavailable or fails validation.

When decision is add, run:

```bash
npx hyperframes add <id> --dir <project> --no-clipboard
```

Then inspect the installed file, mount it in `index.html`, run `visual-guard`, run `layout-guard` for user-facing/dense/captioned scenes, snapshot it, and only then depend on it.

## Install Discipline

- Start with a lightweight host composition. Install catalog blocks/components for selected specialty moments from the decision table.
- Use at most 1-3 catalog blocks in a short narrated video. More blocks can make the video feel like a demo reel.
- Do not install blocks just because the scene feels plain. First improve layout, motif, palette, and text hierarchy.
- Do not let a catalog block or selected frame system dictate every scene layout. Use blocks for specialty effects and keep layout archetypes driven by the story beat.
- After installing a block, mount it in `index.html`; unmounted files in `compositions/` are invisible.
- Do not edit block internals blindly. First read its `data-composition-id`, `data-duration`, local styles, and scripts.
- If the installed file will be mounted with `data-composition-src`, it must be a template sub-composition. Its root must live inside `<template>`, and the host id, inner id, and timeline key must match. Do not mount standalone `<!doctype html><html>...</html>` files directly; convert them to template form or hand-author the effect.
- Run `visual-guard`, `check --layout`, and snapshots after mounting when the block affects visible layout.
- If a block uses WebGL/WebGPU/3D or DOM-to-canvas capture, snapshot and validate early. These blocks are higher impact and higher risk, especially when mounted as `data-composition-src` sub-compositions.
- Component catalog items may be snippets/effects to paste into an existing composition, not standalone host clips.

Standalone-to-template conversion checklist:

1. Remove outer `<!doctype>`, `<html>`, `<head>`, and `<body>` wrappers.
2. Wrap the composition root, local `<style>`, and local `<script>` in one `<template>`.
3. Remove Google Fonts links/imports and use system stacks or bundled local fonts.
4. Make the host `data-composition-id`, inner root `data-composition-id`, root `id`, and `window.__timelines["id"]` match exactly.
5. Keep media/audio as direct children of the host root, not inside the sub-composition template.
6. Run `visual-guard`, `validate`, `inspect`, `layout-guard`, and at least one render-frame check before trusting the block.

If a WebGL catalog effect fails with a runtime error such as `Illegal invocation`, stop adapting that block as a sub-composition. Either hand-author a CSS/GSAP equivalent or inline the effect directly in the host if it validates there.

## Selection Ladder

1. Use handcrafted GSAP for basic effects: fade, translate, stagger, line draw, count-up, bar fill, simple cards, and plain captions.
2. Use a catalog component when it provides a small reusable specialty layer: grain, vignette, shimmer, motion blur, or caption style.
3. Use a catalog block when the scene needs a full specialty composition: code 3D, map, device mockup, VFX portal, social card, or transition showcase.
4. Avoid catalog blocks only when the user asked for a tiny artifact, a very fast draft, a constrained CPU/browser environment, or when the catalog item fails validation.

## ID Confidence

Candidate IDs in this guide are meant to be real HyperFrames catalog IDs, not invented effect names. If an ID fails to install or the installed catalog has changed, verify against the local catalog before using it:

```bash
npx hyperframes catalog
```

Do not guess a nearby ID during production; choose a verified ID or hand-author the effect locally.

## Effect Families

### Code And Developer Scenes

Use when the subject is code, prompts, repos, CLI, debugging, or developer education.

| Need | Candidate IDs | Notes |
| --- | --- | --- |
| Premium code hero | `code-3d-extrude` | WebGL depth; good for a hero beat, not every scene. |
| Code appears/disappears | `code-shader-dissolve`, `code-particle-assemble`, `code-morph` | Use for transformation metaphors. Snapshot for legibility. |
| Fast code detail | `code-typing`, `code-diff`, `code-highlight`, `code-scroll` | Often better to hand-author if only one small code pane is needed. |
| Terminal or docs card | `code-snippet-*` blocks if available | Prefer readable 28px+ code and short snippets. |

Do not use dense real code as narration support unless the user needs code-level detail.

### Captions And Spoken Emphasis

Use for existing footage captions or generated narration captions when the user asks for styled subtitles.

| Need | Candidate IDs | Notes |
| --- | --- | --- |
| Plain readable captions | Hand-authored `.caption` clips | Default for generated MOSS narration. |
| Social highlight | `caption-highlight`, `caption-pill-karaoke` | Needs word timing or deliberate phrase timing. |
| Big emphasis words | `caption-kinetic-slam`, `caption-editorial-emphasis` | Use only for peak words, not all narration. |
| Tech/glitch mood | `caption-glitch-rgb`, `caption-matrix-decode` | Good for AI/security/dev topics. |
| Premium glow | `caption-neon-accent`, `caption-neon-glow`, `caption-gradient-fill` | Use sparingly; verify contrast. |
| Behind-subject/depth captions | `caption-parallax-layers` | Advanced; needs matte/safe-zone QA for real footage. |

Generated MOSS narration should first run `moss-captions`; catalog caption components are optional styling layers.

### Transitions

Most scene changes should be hard cuts. Use transition blocks only for section changes, product reveals, or the final beat.

| Mood | Candidate IDs | Notes |
| --- | --- | --- |
| Clean business | `transitions-push`, `transitions-cover`, `transitions-dissolve` | Safe for explainers. |
| Energetic/social | `whip-pan`, `transitions-scale`, `transitions-grid` | Keep short, usually 0.2-0.5s. |
| Cinematic/premium | `cinematic-zoom`, `light-leak`, `flash-through-white` | Good for reveals and endings. |
| Tech/glitch | `glitch`, `chromatic-radial-split`, `domain-warp-dissolve` | Use for AI/dev/security. |
| Organic/distorted | `ripple-waves`, `swirl-vortex`, `thermal-distortion`, `ridged-burn` | Use when the metaphor fits. |

Avoid using a different transition every scene. Pick one primary transition language and repeat it 1-3 times.

### Data, Maps, And Diagrams

Use when the scene needs proof, geography, statistics, or process structure.

| Need | Candidate IDs | Notes |
| --- | --- | --- |
| Chart proof | `data-chart` | Keep numbers readable and labels short. |
| Flow/process | `flowchart` | Good for explainers; avoid too many nodes. |
| US geography | `us-map`, `us-map-bubble`, `us-map-flow`, `us-map-hex` | Pick one map mode per video. |
| World/Europe maps | `world-map`, `spain-map` | Use only when geography matters. |

Do not use charts as decoration. If the data is invented, keep claims generic or state that values are illustrative.

### Product, UI, And Device Showcases

Use when the subject is an app, SaaS, creator tool, mobile feature, or product surface.

| Need | Candidate IDs | Notes |
| --- | --- | --- |
| App overview | `app-showcase`, `ui-3d-reveal` | Good for product promo and feature reveal. |
| Device mockup | `vfx-iphone-device`, `ios26-liquid-glass` | High-impact; requires snapshot checks. |
| Glass UI | `liquid-glass-widgets`, `liquid-glass-notification`, `liquid-glass-media-controls`, `liquid-glass-context-menu` | Use for premium Apple-like moments. |
| YouTube/product insert | `vpn-youtube-spot`, `apple-money-count` | Better for social/creator videos than sober explainers. |

Do not let a device mockup replace the actual message. Pair it with concise copy or narration.

### Social And Overlay Cards

Use when packaging social proof, creator content, posts, follow prompts, or existing footage overlays.

| Need | Candidate IDs | Notes |
| --- | --- | --- |
| Social post card | `x-post`, `reddit-post` | Use with real supplied text or clearly illustrative text. |
| Follow CTA | `instagram-follow`, `tiktok-follow`, `yt-lower-third` | Best near intro/outro or over footage. |
| Music/now playing | `spotify-card` | Use for music or creator context. |
| System notification | `macos-notification` | Good for app/product moments. |

For existing footage, keep overlays timed and do not re-time/reframe the source video.

### Texture And Polish Components

Use these as small finishing layers, not the core concept.

| Need | Candidate IDs | Notes |
| --- | --- | --- |
| Film texture | `grain-overlay` | Low opacity; do not obscure text. |
| Focus falloff | `vignette` | Good for cinematic scenes. |
| Premium sweep | `shimmer-sweep` | Use on logos, chips, key words. |
| Speed feel | `motion-blur` | Use on fast-moving elements only. |
| Text material | `texture-mask-text` | Great for one hero word. |
| Grid wipe | `grid-pixelate-wipe` | Can serve as a lightweight transition. |
| Parallax hero | `parallax-zoom`, `parallax-unzoom` | Good for card grids and galleries. |

Polish components should not create new reading-order problems.

### VFX And 3D

Use when the user's requested tone is cinematic, futuristic, premium, or visual-first.

| Need | Candidate IDs | Notes |
| --- | --- | --- |
| Portal/reveal | `vfx-portal` | One major reveal beat. |
| Break apart | `vfx-shatter` | Use for disruption/destruction metaphors. |
| Magnetic motion | `vfx-magnetic` | Good for attraction/assembly concepts. |
| Liquid surface | `vfx-liquid-background` | Background hero layer; keep text readable. |
| Cursor light | `vfx-text-cursor` | Strong text-first tech intro. |

VFX blocks can dominate the video. Use one strong VFX idea rather than several unrelated ones.

## Host Integration Checklist

After `hyperframes add <name>`:

1. Confirm the installed file exists under `compositions/` or configured project paths.
2. Paste/mount the host snippet in `index.html`.
3. Add `data-start`, `data-duration`, and `data-track-index`.
4. Make host `data-composition-id` match the inner composition id.
5. If the installed file is a sub-composition, keep its root inside `<template>`.
6. Keep media/audio direct children of the host root, not inside nested templates.
7. Do not trust snapshots alone. After render, extract or inspect the same timestamp from the MP4 when a block is mounted or transformed.
8. Run `visual-guard`, `check --layout`, and snapshots at the block midpoint.

## When Not To Use The Catalog

- The scene only needs a clean title, caption, or simple card.
- The user asked for a lightweight draft or quick fix.
- The composition is already visually coherent.
- The block would require remote assets, online fonts, or unverified heavy runtime behavior.
- The installed block would be unmounted or only used as inspiration.

If using the catalog only as inspiration, copy the visual idea into a local GSAP scene rather than installing a block.
