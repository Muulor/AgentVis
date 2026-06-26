# Design Style Direction Library

20+ named design style directions to help make evidence-based choices when determining visual tone. Each style includes key characteristic descriptions and applicable scenarios; they do not need to be copied exactly and can be mixed.

---

## How to Use

1. Based on product positioning and user persona, filter 2-3 candidate directions
2. Evaluate how well each direction fits the brand tone / technical constraints
3. Choose 1 primary direction, and if necessary, blend in local characteristics from other directions

---

## Style Catalog

### High-Contrast Swiss

**Characteristics**: oversized geometric sans-serif fonts, black-and-white main tone, strict grid system, and information hierarchy built through font size / weight. Very little decoration; content is the design.

- **Font strategy**: heavy Grotesque fonts (Helvetica Neue, Aktiv Grotesk), oversized headings (60-120px)
- **Color strategy**: primarily black/white/gray, occasional single-color accents
- **Layout strategy**: mathematical grid, abundant whitespace, asymmetrical balance
- **Motion strategy**: extremely minimal — only opacity + translateY transitions

**Suitable for**: brand websites, design agencies, architecture firms, high-end galleries

---

### Nature Organic

**Characteristics**: natural tones (green/brown/beige/earth colors), soft curves, natural material textures, warm and comfortable atmosphere.

- **Font strategy**: humanist sans-serif (Lato, Nunito) or elegant serif (Cormorant)
- **Color strategy**: low-saturation natural colors — forest green, earth brown, warm gray, cream white
- **Layout strategy**: rounded containers, soft edges, naturally flowing grids
- **Motion strategy**: slow and gentle — ease-in-out, 300-500ms

**Suitable for**: environmental brands, healthy foods, sustainable products, lifestyle brands

---

### Hyper-Saturated Fluid

**Characteristics**: high-saturation colors, fluid gradients, bold color-block collisions, full of energy and tension.

- **Font strategy**: geometric sans-serif (Montserrat, Outfit), bold all-caps headings
- **Color strategy**: high-saturation main color + contrasting accent colors, multicolor gradients
- **Layout strategy**: irregular color-block division, layered overlaps, breaking the grid
- **Motion strategy**: fluid feeling — gradient carousel, color breathing, parallax

**Suitable for**: fintech, sports brands, energetic startups, music/entertainment

---

### Brutalist Raw

**Characteristics**: exposed typography, no decoration, function first, deliberately preserving a "roughness" and "structural feeling".

- **Font strategy**: monospace or industrial fonts (Space Mono, IBM Plex Mono), all caps, extremely large font size
- **Color strategy**: black and white + single-color emphasis, no gradients, high contrast
- **Layout strategy**: visible grid lines, exposed borders, no rounded corners (`border-radius: 0`)
- **Motion strategy**: none or very little — use color inversion for state changes

**Suitable for**: independent brands, art projects, experimental websites, developer tools

---

### Midnight Editorial

**Characteristics**: dark base color, mixed serif and sans-serif typography, magazine-like typographic hierarchy, elegant and deep.

- **Font strategy**: serif headings (Playfair Display, DM Serif) + sans-serif body text (DM Sans)
- **Color strategy**: dark blue / dark gray base, low-saturation warm accents (beige/gold/copper)
- **Layout strategy**: mixed multi-column layout, pull quotes, cross-layout of images and text
- **Motion strategy**: fade + parallax scrolling, text reveal

**Suitable for**: design studios, content platforms, magazines/media, high-end services

---

### Architectural Blueprint

**Characteristics**: technical blue background, precise lines, visible grid, engineering drawing-like precision.

- **Font strategy**: primarily monospace fonts (JetBrains Mono), technical annotation style
- **Color strategy**: deep blue background + light blue/white lines, fluorescent accents
- **Layout strategy**: strict grid, alignment guide lines, annotation-style elements
- **Motion strategy**: line-drawing animation, data-flow effects

**Suitable for**: developer tools, technology products, data platforms, SaaS backends

---

### Bold Editorial Studio

**Characteristics**: large areas of whitespace, oversized brand typography, minimal navigation, confident and restrained.

- **Font strategy**: distinctive serif (Instrument Serif) or geometric sans-serif (Syne), oversized font sizes
- **Color strategy**: primarily white background + black text, brand color used only for tiny accents
- **Layout strategy**: full-screen paragraphs, large empty areas, extremely strong visual breathing room
- **Motion strategy**: large-text reveal, image mask reveal, scroll triggers

**Suitable for**: creative agencies, portfolios, brand websites, design companies

---

### Tectonic

**Characteristics**: dark tone, fractured/stone-carved text texture, geological textures, stable and weighty.

- **Font strategy**: heavy geometric fonts (Unbounded, Syne), uppercase letters, tight letter spacing
- **Color strategy**: deep gray/black background + slate gray + neon accents (cyan/green)
- **Layout strategy**: layered blocks, asymmetrical cuts, dark vignette
- **Motion strategy**: heavy scale + translate, slow transitions

**Suitable for**: high-end technology brands, security products, industrial design

---

### Liquid Metal

**Characteristics**: metallic gradients, dark purple/deep blue background, gloss and fluidity, both futuristic and luxurious.

- **Font strategy**: geometric sans-serif (Outfit, Sora), light font weight + increased letter spacing
- **Color strategy**: dark background + purple/blue/silver metallic gradients, glow effects
- **Layout strategy**: centered composition, bold negative space, floating feeling for elements
- **Motion strategy**: flowing gradients, gloss sweep effect, 3D tilt

**Suitable for**: games, entertainment technology, crypto/blockchain, high-end consumer goods

---

### Neo-Brutalism

**Characteristics**: thick black borders (2-4px), high-saturation pure color blocks, heavy shadows (4-8px hard shadows), retro but energetic.

- **Font strategy**: geometric bold fonts (DM Sans Bold, Lexend), all caps or extra-large font size
- **Color strategy**: high-saturation pure colors (yellow/pink/blue/green) + black outlines
- **Layout strategy**: card-based, sticker feeling, `border-radius: 0`, hard shadow offset
- **Motion strategy**: elastic bounce, hover displacement + shadow changes

**Suitable for**: e-commerce, developer tools, creative platforms, education

---

### Red Noir

**Characteristics**: dramatic contrast of deep red and black, cinematic light and shadow, dark-tone photography, emotional tension.

- **Font strategy**: elegant serif (Libre Baskerville) or stylized sans-serif
- **Color strategy**: black background + deep red (#8B0000 ~ #DC143C), warm gold accents
- **Layout strategy**: large dark color blocks, text overlaid on imagery
- **Motion strategy**: slow fade, spotlight effects, smoke/particles

**Suitable for**: film/television, music, nightclubs/bars, luxury goods

---

### Reductive Flat

**Characteristics**: very few elements, large flat color blocks, completely flat (no shadows/no gradients), geometric shapes.

- **Font strategy**: clean geometric sans-serif (Inter, Geist)
- **Color strategy**: a few selected colors + large areas of whitespace, color blocks used as sectioning tools
- **Layout strategy**: grid-based, card tiling, even spacing between elements
- **Motion strategy**: state changes use only color switching, very short transitions

**Suitable for**: design system documentation, Component libraries, internal tools

---

### International Style

**Characteristics**: strict grid, Grotesque font families, extremely clear information hierarchy, "the grid is authority".

- **Font strategy**: Helvetica / Neue Haas Grotesk-style fonts, clear font-size steps
- **Color strategy**: neutrals + monochromatic emphasis (red/blue only for annotations)
- **Layout strategy**: 12-column grid, strict horizontal/vertical alignment, consistent margins
- **Motion strategy**: optional, extremely restrained

**Suitable for**: government/institution websites, corporate portals, information-dense websites

---

### Warm Industrial

**Characteristics**: warm gray texture, humanist feeling from serif fonts, hints of industrial materials (concrete/metal/wood).

- **Font strategy**: humanist serif (Source Serif Pro, Lora) + clean sans-serif body text
- **Color strategy**: warm gray/mud/rust colors, low-key but warm
- **Layout strategy**: loose spacing, content-centered, generous whitespace
- **Motion strategy**: gentle fade-up, slow speed

**Suitable for**: architecture/interior design, consulting companies, handcrafted brands

---

### Dark Avant-Garde

**Characteristics**: experimental typography (text overlap/rotation/fragmentation), breaking conventions, avant-garde and uncompromising.

- **Font strategy**: display fonts (Clash Display, Lexend Zetta), distorted letters, mixed font sizes
- **Color strategy**: dark background + fluorescent accents (acid green/electric blue/magenta)
- **Layout strategy**: asymmetry, overlap, text bleeding, breaking container boundaries
- **Motion strategy**: glitch effects, text perturbation, nonlinear easing

**Suitable for**: AI products, innovation labs, art exhibitions, avant-garde brands

---

### Cyber Serif

**Characteristics**: the contrast aesthetics of using serif fonts in technology scenes — a collision of elegance and technology.

- **Font strategy**: modern serif (Fraunces, Bitter) for headings + monospace body text
- **Color strategy**: dark background + cool tones (blue-gray, silver-white) + warm serif text accents
- **Layout strategy**: classic editorial layouts used to display technical content
- **Motion strategy**: refined text reveal, smooth scrolling

**Suitable for**: educational technology, high-end SaaS, online course platforms

---

### Organic Modern

**Characteristics**: natural food/lifestyle photography, serif headings, handwritten accents, warm and authentic.

- **Font strategy**: elegant serif (Cormorant, Playfair Display) + handwritten font as decoration
- **Color strategy**: cream/beige background + dark brown/olive green, natural tones
- **Layout strategy**: large images + text wrapping, abundant whitespace, images as the protagonist
- **Motion strategy**: gentle fade-in, low-speed image parallax

**Suitable for**: food brands, restaurants, lifestyle, organic products

---

### Playful Geometric

**Characteristics**: rounded corners, high-saturation multicolor, sticker/badge feeling, friendly and full of vitality.

- **Font strategy**: rounded geometric fonts (Nunito, Quicksand, Comfortaa)
- **Color strategy**: multiple colors used together (purple/yellow/pink/green), color blocks with clear boundaries
- **Layout strategy**: card grids, rounded containers, "breathing room" between elements
- **Motion strategy**: elastic bounce, spring-like bounce, emoji-like motion

**Suitable for**: children's education, social apps, fun tools, creative platforms

---

### Kinetic Brutalism

**Characteristics**: sense of motion + exposed structure. Large text, dynamic movement, clear boundaries, high energy.

- **Font strategy**: ultra-heavy weight (Black/900), tight letter spacing, text as graphic elements
- **Color strategy**: high contrast (black/white + single fluorescent color)
- **Layout strategy**: full-bleed arrangement, text overflow, torn-grid feeling
- **Motion strategy**: high-speed translateX/Y, stagger reveal, text marquee

**Suitable for**: sports brands, energy drinks, music festivals, extreme sports

---

### Monochrome Craft

**Characteristics**: monochrome system (usually black/white or monochrome gradient), handcrafted refinement, meticulous details.

- **Font strategy**: carefully selected font pairs (such as serif headings + sans-serif body text)
- **Color strategy**: only black/white/gray or multiple lightness levels of a single hue
- **Layout strategy**: precise alignment, consistent rhythm, geometric sense of order
- **Motion strategy**: refined fades, restrained hover state changes

**Suitable for**: independent tools, handcrafted brands, photographer portfolios

---

### Terminal Hacker

**Characteristics**: green text on black background (or amber-on-black), monospace fonts, command-line aesthetics, hacker temperament.

- **Font strategy**: monospace fonts (Fira Code, JetBrains Mono), fixed font size
- **Color strategy**: black background + green/amber/cyan text, CRT scanline effects
- **Layout strategy**: text-flow layout, unified margins, information-dense
- **Motion strategy**: typewriter effect, cursor blinking, character-by-character display

**Suitable for**: developer tools, security products, Hacker News style, CLI products
