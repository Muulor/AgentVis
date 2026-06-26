---
name: html-slides
description: Generate interactive HTML slides featuring rich visual elements or creative, freeform multimedia designs. Trigger this skill when a user's request involves visually appealing presentations, visual displays, or web-based presentations requiring creative layouts and interactive elements. The slides come with built-in keyboard/touch navigation and a variety of creative, aesthetically pleasing templates. If the user asks to create a PPT, please ask whether they prefer the HTML format or the traditional binary PPT format.
triggers: [html-slides, html ppt, interactive slides, 交互式幻灯片, 交互式演示, 网页演示, 网页幻灯片, HTML演示, 数据演示, html slides, html幻灯片, 交互演示, 网页PPT]
---

# HTML Interactive Slides skill for AgentVis 

Create visually stunning interactive presentations based on HTML/CSS/JS and the latest Pretext technology. The deliverable is a single `.html` file that can be presented by opening it directly in a browser.

**Before execution, you must understand three things:**
-  1. Understand the **page-turning mechanism, page-turning engine, and interaction capabilities**. You must read the **engine file** [engine.html](templates/engine.html), **extend based on this template**, do not build the page-turning engine from scratch, copy the page-turning JS code from `templates/engine.html`, follow the engine file instructions and notes, and independently design everything else.
-  2. Understand **Pretext core principles**. Pretext is the latest cutting-edge technology library; it computes layout in the pure JS arithmetic layer without triggering DOM reflow. `layoutNextLine(prepared, cursor, width)` returns `{text, width, start, end}` or `null`, and can specify different widths line by line to achieve typography effects that CSS cannot produce. **You must read** [advanced-layouts.md](references/advanced-layouts.md), otherwise your freeform creative work can easily go wrong.
-  3. Understand **theme aesthetics**. You must read [aesthetics-guidelines.md](references/aesthetics-guidelines.md) to anchor aesthetic cognition; this is key to improving delivery quality.

## Execution Flow

1. **Internalize cognition** — Use the read tool to read the above 3 files that must be deeply understood in parallel, and establish your cognition of how to create advanced-typography html slides
2. **Determine the theme temperament** — Before writing any code, first define: emotional tone, color tendency, font style
3. **Plan the structure** — List all slides and each slide's content and layout intent
4. **Build HTML** — Based on the "page-turning mechanism" skeleton, design CSS completely independently (colors/fonts/layout/motion)
5. **Add data visualization** (if needed) — Use Plotly.js, refer to [plotly-charts.md](references/plotly-charts.md)
6. **Add advanced typography** — Use Pretext to freely express your creativity

⚠️ `engine.html`: **engine file instructions and notes** must be read carefully, otherwise delivered html can easily contain errors. After generating the HTML, self-check: **does the first `<section>` contain `class="... active"`** (omitting it causes the initial page to be completely black).

---

### Interaction Capabilities

| Method | Operation |
|------|------|
| Keyboard | `→` / `Space` next page, `←` previous page |
| Buttons | Bottom ← → |
| Touch | Swipe left/right >60px |
| Progress bar | Fixed at top, updates automatically |
| Speaker notes | `<section data-notes="...">` -> output to console during page turns |
| Autoplay | Toggle with the navigation bar ▶/⏸ button or the `F` key; default interval 5 seconds; auto-pause on mouse hover; loop from the last page back to the first page |
| Navigation bar auto-hide | Navigation bar fades out after 1.5 seconds of inactivity; immediately shows again on mouse movement/keyboard/touch/navigation bar hover.|

---

## References

| Document | Content |
|------|------|
| [engine.html](templates/engine.html) | Page-turning engine |
| [aesthetics-guidelines.md](references/aesthetics-guidelines.md) | Frontend aesthetics best practices, 20+ named style directions (font/color/layout/motion strategies) |
| [advanced-layouts.md](references/advanced-layouts.md) | Complete Pretext API reference + code examples |
| [plotly-charts.md](references/plotly-charts.md) | Plotly and slide background integration configuration + quick reference for common charts |

---

## Avoid

- **[FATAL] The first slide must write `class="... active"` in HTML** — the engine JS is only responsible for switching and will not automatically activate any slide; omission causes an initially all-black screen
- **Do not use external frameworks** (Reveal.js / Swiper, etc.) — pure native JS is enough
- **Do not generate multiple HTML files** — single-file self-contained
- **Do not copy the color scheme of any existing template** — each presentation's color scheme must be determined by the theme temperament
- **Do not only change content without changing style** — not modifying colors/fonts is equivalent to copying a template
- **Do not ignore space utilization** — each slide is a 100vw×100vh canvas, use it fully
- **Do not make all slide layouts identical** — varied layouts create rhythm
- **Do not set the chart displayModeBar to true** — presentation scenarios do not need it

---

## Dependencies

No installation required, introduce CDN as needed:
- `https://cdn.plot.ly/plotly-2.35.2.min.js` (charts)
- `https://cdn.jsdelivr.net/npm/@chenglou/pretext/+esm` (advanced typography)
- Google Fonts (fonts, choose according to the theme)
