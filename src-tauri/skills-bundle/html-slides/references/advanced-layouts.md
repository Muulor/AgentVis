# Advanced Typography Reference — Pretext Layout

Reference for advanced typography patterns based on the `@chenglou/pretext` library. When the user needs creative typography, magazine style, or adaptive font sizing, use the `base-advanced.html` template.

## CDN Import

```html
<script type="module">
  // Actual exports in v0.0.4
  import {
    prepare, layout,
    prepareWithSegments, layoutWithLines,
    layoutNextLine, walkLineRanges
  } from 'https://cdn.jsdelivr.net/npm/@chenglou/pretext/+esm'
</script>
```

> **Key**: ESM import must be used inside `<script type="module">`. You must wait until fonts finish loading before calling prepare: `await document.fonts.ready`

---

## Layout 1: Canvas Creative Typography `layout-canvas-creative`

### Text Wrapping Around Irregular Images

Core principle: use `layoutNextLine()` to lay out text line by line, dynamically calculating the available width for each line based on obstacle positions. `layoutNextLine` directly returns `{text, width, start, end}` or `null`.

```html
<section class="slide layout-canvas-creative">
  <canvas id="canvas-slide-N" class="creative-canvas"></canvas>
</section>
```

```javascript
import { prepareWithSegments, layoutNextLine } from '...'

await document.fonts.ready

const canvas = document.getElementById('canvas-slide-N')
const dpr = window.devicePixelRatio || 1
const rect = canvas.getBoundingClientRect()
canvas.width = rect.width * dpr
canvas.height = rect.height * dpr
const ctx = canvas.getContext('2d')
ctx.scale(dpr, dpr)
const W = rect.width, H = rect.height

// Define obstacle area
const obstacle = { x: 500, y: 100, w: 300, h: 250, margin: 20 }

// Layout
const font = '16px Inter'
const lineHeight = 28
const prepared = prepareWithSegments(text, font)
let cursor = { segmentIndex: 0, graphemeIndex: 0 }
let y = startY

ctx.fillStyle = '#94a3b8'
ctx.font = font
ctx.textBaseline = 'top'

while (true) {
  // Calculate available width for this line
  let lineX = padding, lineW = W - padding * 2
  if (y + lineHeight > obstacle.y - obstacle.margin &&
      y < obstacle.y + obstacle.h + obstacle.margin) {
    lineW = obstacle.x - obstacle.margin - padding
  }

  const line = layoutNextLine(prepared, cursor, lineW)
  if (line === null) break
  ctx.fillText(line.text, lineX, y)
  cursor = line.end
  y += lineHeight
}
```

### Text Layout Along Variable-Width Containers (Trapezoid, Funnel)

```javascript
// Trapezoid: narrow at the top, wide at the bottom
function getTrapezoidWidth(y, top, bottom, topW, bottomW, totalH) {
  const ratio = Math.min(1, Math.max(0, (y - top) / totalH))
  return topW + (bottomW - topW) * ratio
}

while (true) {
  const lineW = getTrapezoidWidth(y, topY, bottomY, 200, 600, totalH)
  const line = layoutNextLine(prepared, cursor, lineW)
  // ...
}
```

### Line-by-Line Fly-In Animation

Combine with `requestAnimationFrame` and render line by line with delays to create a typewriter effect:

```javascript
const lines = [] // Precompute all lines
let cursor = { segmentIndex: 0, graphemeIndex: 0 }
while (true) {
  const line = layoutNextLine(prepared, cursor, maxWidth)
  if (!line) break
  lines.push(line)
  cursor = line.end
}

// Animation rendering
let visibleLines = 0
function animate() {
  ctx.clearRect(0, 0, W, H)
  for (let i = 0; i < visibleLines; i++) {
    const alpha = Math.min(1, (visibleLines - i) * 0.3)
    ctx.globalAlpha = alpha
    ctx.fillText(lines[i].text, padding, startY + i * lineHeight)
  }
  if (visibleLines < lines.length) {
    visibleLines++
    setTimeout(() => requestAnimationFrame(animate), 60)
  }
}
animate()
```

---

## Layout 2: Magazine Multi-Column Typography `layout-magazine`

### Basic Three Columns

```html
<section class="slide layout-magazine">
  <h2>Title</h2>
  <p class="mag-subtitle">Subtitle</p>
  <div class="magazine-columns">
    <canvas class="mag-col-canvas" id="mag-col-1"></canvas>
    <div class="mag-separator"></div>
    <canvas class="mag-col-canvas" id="mag-col-2"></canvas>
    <div class="mag-separator"></div>
    <canvas class="mag-col-canvas" id="mag-col-3"></canvas>
  </div>
</section>
```

```javascript
const canvases = [
  document.getElementById('mag-col-1'),
  document.getElementById('mag-col-2'),
  document.getElementById('mag-col-3')
]
const prepared = prepareWithSegments(text, '15px Inter')
let cursor = { segmentIndex: 0, graphemeIndex: 0 }

for (const canvas of canvases) {
  const dpr = window.devicePixelRatio || 1
  const rect = canvas.getBoundingClientRect()
  canvas.width = rect.width * dpr
  canvas.height = rect.height * dpr
  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)
  ctx.fillStyle = '#94a3b8'
  ctx.font = '15px Inter'
  ctx.textBaseline = 'top'

  let y = 0
  while (y + 26 <= rect.height) {
    const line = layoutNextLine(prepared, cursor, rect.width)
    if (line === null) break
    ctx.fillText(line.text, 0, y)
    cursor = line.end
    y += 26
  }
}
```

### Two-Column Variant

Remove the third column and change `.magazine-columns` to 2 canvases + 1 separator.

### Drop Cap

Render the first character of the text separately in a large font, and indent the following text for the first few lines:

```javascript
// Render the first character in a large font
ctx.font = `bold 60px 'Playfair Display'`
ctx.fillStyle = '#38bdf8'
ctx.fillText(text[0], 0, 0)
const dropCapWidth = ctx.measureText(text[0]).width + 8

// Following text: indent the first 3 lines
const restText = text.slice(1)
const prepared = prepareWithSegments(restText, '15px Inter')
let cursor = { segmentIndex: 0, graphemeIndex: 0 }
let y = 0, lineIdx = 0
while (true) {
  const w = lineIdx < 3 ? colWidth - dropCapWidth : colWidth
  const x = lineIdx < 3 ? dropCapWidth : 0
  const line = layoutNextLine(prepared, cursor, w)
  if (!line) break
  ctx.fillText(line.text, x, y)
  cursor = line.end
  y += 26
  lineIdx++
}
```

---

## Layout 3: Adaptive Font Size `layout-autofit`

Use pretext's `prepare()` + `layout()` to perform binary search and find the largest font size that does not overflow.

```html
<section class="slide layout-autofit">
  <div class="autofit-content">
    <h2>Title</h2>
    <p class="autofit-text" id="autofit-text-N">Content text...</p>
    <span class="autofit-badge" id="autofit-badge-N"></span>
  </div>
</section>
```

```javascript
import { prepare, layout } from '...'

function autoFitFontSize(text, containerW, containerH, fontFamily, opts = {}) {
  const { minSize = 14, maxSize = 64, lineHeightRatio = 1.8 } = opts
  let lo = minSize, hi = maxSize
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    const prepared = prepare(text, `${mid}px ${fontFamily}`)
    const lh = Math.round(mid * lineHeightRatio)
    const { height } = layout(prepared, containerW, lh)
    if (height <= containerH) lo = mid
    else hi = mid
  }
  return lo
}

// Usage
const el = document.getElementById('autofit-text-N')
const text = el.textContent.trim()
const container = el.parentElement.getBoundingClientRect()
const size = autoFitFontSize(text, container.width, container.height - 100, 'Inter')
el.style.fontSize = `${size}px`
el.style.lineHeight = `${Math.round(size * 1.8)}px`
```

### Parameter Tuning

| Parameter | Default | Description |
|------|--------|------|
| `minSize` | 14 | Minimum font size lower bound (avoid being too small to read)|
| `maxSize` | 64 | Maximum font size upper bound |
| `lineHeightRatio` | 1.8 | Line-height multiplier (relative to font size)|

- Less content (1-2 sentences): set `maxSize: 48-64`, with an effect like large text in `layout-center`
- More content (a whole paragraph): set `maxSize: 28` to avoid frequent scaling

---

## Combination Suggestions

| Scenario | Recommended Layout |
|------|----------|
| Apple-style product launch | `layout-canvas-creative` + large title text + image text wrap |
| Text-dense business report page | `layout-magazine` + three columns |
| Data insight page | `layout-autofit` + standard chart combination |
| Magazine cover story | `layout-magazine` + drop cap |
| Dynamic text display | `layout-canvas-creative` + line-by-line fly-in animation |

## Mixing With Plotly

Advanced typography slides can also contain Plotly charts. In `layout-canvas-creative`, you can overlay an absolutely positioned `div.chart-container` outside the Canvas:

```html
<section class="slide layout-canvas-creative" style="position: relative;">
  <canvas id="canvas-N" class="creative-canvas"></canvas>
  <div class="chart-container" id="chart-overlay-N"
       style="position:absolute; bottom:60px; right:60px; width:400px; height:300px; z-index:2;">
  </div>
</section>
```
