# Motion And Design

Use this when creating visual content, not just wiring a project. Read the selected `example/<frame>/FRAME.md` first for visual direction and `catalog-effects-guide.md` before installing catalog blocks; use this file to turn that frame system into scene timing and GSAP motion.

## Design Gate

Before writing HTML for a non-trivial video, decide:

- Subject and audience.
- Aspect ratio and approximate duration.
- Selected frame system or user-supplied visual reference.
- Visual identity: palette, font pairing, motif, texture, density.
- One-sentence concept angle: what visual world expresses the subject?
- Scene plan with duration, key on-screen words, and a different `layout_archetype` for each adjacent scene.

Avoid default-looking frames: flat dark gradient, centered title stack, generic blue/purple glow, Inter/system font, identical cards, and text-only slides.

## Frame Systems Are Style, Not Storyboards

Treat the selected frame as a visual vocabulary:

- Do borrow: palette ratios, font roles, border/radius/shadow rules, texture, motif shapes, label/chrome style, density, and anti-patterns.
- Do not copy by default: the showcase's exact scene order, centered hero layout, corner badge, decorative poster position, CTA composition, or repeated card arrangement.
- Let the story beat choose the layout. A definition, proof point, process, contrast, example, and CTA should not all share the same centered headline skeleton.

Frame systems may show oversized typography, tilted cards, or decorative elements bleeding off canvas. Copy that only for non-essential decoration. Keep key words, charts, process nodes, captions, and CTAs inside the visible canvas across the whole animation.

Use a layout vocabulary across the scene plan. Pick the smallest set that fits the story and avoid repeating the same archetype in adjacent scenes:

| Archetype | Use for |
| --- | --- |
| `title-field` | Opening or final identity beat with one dominant phrase |
| `split-proof` | Before/after, two claims, metric plus explanation |
| `process-map` | Loops, pipelines, cause/effect, system flow |
| `object-constellation` | Several concepts orbiting one idea |
| `card-grid` | Multiple examples or principles |
| `timeline-path` | Sequence, evolution, iteration |
| `quote-pullout` | A memorable sentence or thesis |
| `ui-focus` | Product/screenshot/code/document detail |
| `cta-lockup` | Final action, promise, or closing thought |

For a closing scene, do not always use `title-field`. Use `cta-lockup`, `timeline-path`, `object-constellation`, or `split-proof` when the narration calls for movement, decision, contrast, or next step.

## Layout Before Motion

For each scene, build the most readable "hero frame" first:

1. Place text, images, diagrams, and decoratives in their final visible positions.
2. Check reading order and title-safe margins.
3. Only then add `gsap.from()` or `fromTo()` entrance motion.

Animation should travel to the CSS layout, not compensate for an unfinished layout.

## Scene Timing

Use these as starting points:

| Scene content | Duration |
| --- | --- |
| Logo/title/icon only | 1.5-2.5s |
| 1-3 key words or a single stat | 2-3s |
| Headline plus subhead | 3-4s |
| Short sentence or two-line point | 4-5s |
| Dense paragraph | split into multiple scenes |

The last important readable element should appear by halfway through the scene.

## Motion Patterns

Use at least an entrance plus one hold activity per scene. Keep readable text stable during holds: avoid continuous `scale`, `rotation`, or tiny repeated `x`/`y` yoyo on headlines, captions, and stat numbers. Browser glyph rasterization can shimmer frame-to-frame. Put looping activity on accents, backgrounds, masks, charts, arrows, glows, or non-critical decorative elements instead. If text must move, make it a brief entrance/exit, use integer pixel travel, and settle it before the viewer needs to read.

```js
tl.from("#headline", { y: 44, opacity: 0, duration: 0.55, ease: "power3.out" }, 0.2);
tl.from("#subhead", { y: 18, opacity: 0, duration: 0.45, ease: "power2.out" }, 0.45);
tl.to("#accent", { y: -6, duration: 1.4, ease: "sine.inOut", yoyo: true, repeat: 1 }, 0.8);
```

Good patterns:

- Character stagger for kinetic titles.
- Counter animation for numbers.
- SVG stroke draw for paths, arrows, flow diagrams, signatures.
- Bar/chart fill for comparisons.
- Slow image zoom or pan for screenshots.
- Highlight sweep for emphasized words.
- Breathing float or opacity pulse for logos, badges, glows, backgrounds, or decorative wrappers, not the live text itself.
- Camera or parallax drift for layered compositions.

When rotating or drifting a whole diagram/card group, check the largest animated bounding box. If any important node would leave the canvas, keep the group static and animate internal arrows, highlights, fills, or accent shapes instead.

## Transitions

Most cuts should be hard cuts. Use effect transitions sparingly for reveal, energy shift, or final CTA.

Recommended rhythm for 6-8 scenes: hard, hard, effect, hard, hard, effect.

If using shader transitions, ensure the scenes bracketing the transition are visible when captured and that non-anchor scenes are not poisoned by `opacity:0`. When in doubt, use a hard cut plus strong entrance motion.

## Text And Typography

- Use large video-scale type: display text is usually 60px+ on 1080p.
- Use strong weight contrast.
- Prefer a deliberate local/system font pairing over browser defaults. Do not use Google Fonts or remote font CSS; if a specific font matters, bundle it in `assets/fonts/` and load it with local `@font-face`.
- Keep body copy short; split long copy.
- Check contrast with `validate`, but still inspect visually.

## Existing Footage Overlays

For overlay cards, design around the footage:

- Keep the source clip playing untouched.
- Use safe zones that avoid faces and important gestures.
- Use lower-thirds for quick labels, side panels for dense data, fullscreen cards only for major beats, and PiP when the speaker should remain visible.
- Clamp overlay timing to media duration.

## Practical Polish Checklist

- Every scene has a clear focal point.
- The frame has foreground detail beyond the main title.
- Text fits at the chosen aspect ratio.
- There is motion after entrance, not just a static slide.
- Transitions do not hide content before it is readable.
- Final frame has a deliberate hold.
