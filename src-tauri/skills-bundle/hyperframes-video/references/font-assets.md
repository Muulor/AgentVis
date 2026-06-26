# Font Assets And CJK Typography

Use this after selecting a frame system and before writing CSS. Frame docs name the intended typography, but most frame fonts are Latin-first Google Fonts. For Chinese or mixed Chinese/English videos, choose a local font strategy explicitly.

## Rules

- Do not load Google Fonts, gstatic, CDN font CSS, or remote `@import` at render time.
- Do not use a bare frame font name unless that exact font file is bundled locally and declared with `@font-face`.
- Do not bundle proprietary OS fonts such as Segoe UI, Microsoft YaHei, SimHei, SimSun, or DengXian in this skill. Use them only as system fallback stacks when validation allows.
- Prefer open-source bundled fonts in `assets/fonts/`. For Chinese, the safest core pair is `NotoSansSC-VF.ttf` and `NotoSerifSC-VF.ttf`.
- Copy only the needed font files into the project under `assets/fonts/`, then load them with project-relative `@font-face`.
- Use direct `font-family` declarations in selectors. Avoid `font-family: var(--font-body)` because current HyperFrames lint may treat CSS variable references as literal font names.

## Recommended Core Chinese Fonts

| Local file | CSS family | Best for |
| --- | --- | --- |
| `NotoSansSC-VF.ttf` | `"Noto Sans SC"` | Modern Chinese UI, SaaS, explainers, cards, labels, subtitles |
| `NotoSerifSC-VF.ttf` | `"Noto Serif SC"` | Editorial Chinese titles, literary tone, premium/minimal frames |

If these files are not bundled, fall back to `"Segoe UI", sans-serif` for lint-stable drafts. Do not write `"Noto Sans SC"` in CSS without a matching local `@font-face`; lint can fail even if the machine has the font installed.

## Frame Font Mapping

| Frame | Latin frame fonts | Chinese pairing |
| --- | --- | --- |
| `biennale-yellow` | Instrument Serif, Archivo, JetBrains Mono | `Noto Serif SC` for titles, `Noto Sans SC` for body/labels, mono only for Latin/data |
| `blockframe` | Inter, Space Grotesk | `Noto Sans SC` bold/black for Chinese display, regular/medium for body |
| `blue-professional` | Space Grotesk, Inter | `Noto Sans SC` for all Chinese UI/body, medium/semibold for headings |
| `bold-poster` | Shrikhand, Libre Baskerville, Space Grotesk | `Noto Serif SC` bold/black for Chinese poster display, `Noto Sans SC` for labels |
| `broadside` | Barlow, IBM Plex Mono | `Noto Sans SC` black for Chinese statement type, regular for support copy |
| `capsule` | Bodoni Moda, Space Grotesk | `Noto Serif SC` for display, `Noto Sans SC` for body/labels |
| `cartesian` | Playfair Display, Inter | `Noto Serif SC` regular/medium for quiet display, `Noto Sans SC` for body |
| `cobalt-grid` | Newsreader, Hanken Grotesk, DM Mono | `Noto Serif SC` for editorial Chinese, `Noto Sans SC` for data labels |
| `coral` | Bebas Neue, Inter | `Noto Sans SC` black for hard-edged Chinese display, regular for body |
| `creative-mode` | Archivo Black, JetBrains Mono, Space Grotesk | `Noto Sans SC` black for Chinese display, regular/medium for body; keep mono for Latin/code |
| `daisy-days` | Fredoka One, Quicksand | `Noto Sans SC` bold/medium for Chinese; use rounded shapes, shadows, and pastel motifs to carry playfulness |
| `editorial-forest` | Source Serif 4, JetBrains Mono | `Noto Serif SC` medium for Chinese display/body, `Noto Sans SC` for small labels when needed |

## CSS Pattern

```css
@font-face {
  font-family: "Noto Sans SC";
  src: url("./assets/fonts/NotoSansSC-VF.ttf") format("truetype");
  font-weight: 100 900;
  font-style: normal;
  font-display: block;
}

@font-face {
  font-family: "Noto Serif SC";
  src: url("./assets/fonts/NotoSerifSC-VF.ttf") format("truetype");
  font-weight: 100 900;
  font-style: normal;
  font-display: block;
}

.headline {
  font-family: "Noto Serif SC", serif;
  font-weight: 600;
}

.body-copy,
.caption {
  font-family: "Noto Sans SC", sans-serif;
  font-weight: 400;
}
```

For Latin-only labels or code, keep the frame's bundled Latin face if available. If not available, use `"Segoe UI", sans-serif` or `ui-monospace, monospace` for drafts and keep the frame's color, spacing, motif, and hierarchy intact.
