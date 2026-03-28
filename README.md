<h1>
  <img src="web/favicon.svg" width="48" height="36" alt="" style="vertical-align:middle; margin-right:10px;"/>
  SpriteAnvil
</h1>

[![Deploy to GitHub Pages](https://github.com/aschoelzhorn/spriteanvil/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/aschoelzhorn/spriteanvil/actions/workflows/deploy-pages.yml)

**[Live demo → https://aschoelzhorn.github.io/spriteanvil](https://aschoelzhorn.github.io/spriteanvil)**

A browser-based tool for viewing, editing, and exporting pixel-art sprite assets for ESP32 LED panel projects.  
No install required — use it instantly in the browser via GitHub Pages, or run it locally in Docker.

---

## Screenshots

| Sprites & Zoom | Animation Strip |
|:---:|:---:|
| ![Sprites view](docs/screenshot-sprites.png) | ![Animation strip](docs/screenshot-animation.gif) |

| Font Charmap & Preview |
|:---:|
| ![Fonts view](docs/screenshot-fonts.png) |

---

## Features

| | |
|---|---|
| **Parse** | Drag & drop or paste `.h` files containing `uint16_t` / `unsigned short` C++ arrays |
| **Render** | RGB565 → RGB888 canvas preview with zoom (2–64 px) and optional pixel grid |
| **Transparency** | Checkerboard pattern *or* a custom solid colour for transparent pixels (`0xFEFE`) |
| **Animation** | Multi-frame arrays play as live animation — ▶/⏸ toggle + per-animation FPS slider |
| **Strip view** | Animation frames shown as a single side-by-side canvas or as individual canvases |
| **Validation** | Per-sprite ✅/❌ pixel-count check; ⚠️ warning when no SIZE array is found |
| **Multi-file** | Load multiple `.h` files — prompted to **Add** or **Replace** existing sprites |
| **Export ZIP** | Original source files + per-sprite split `.h` + `.png` preview + root `assets.h` |
| **Fonts** | Parse and preview Adafruit GFX font files — glyph charmap + live text preview with colour picker |

---

## Quick Start

### Browser (GitHub Pages)

No setup needed — just open the live demo:  
**[https://aschoelzhorn.github.io/spriteanvil](https://aschoelzhorn.github.io/spriteanvil)**

### Local (Docker)

```bash
docker compose up
```

Then open **http://localhost:8080** in your browser.

---

## Supported `.h` File Formats

The parser handles all common ESP32 asset patterns without modification:

```cpp
// 1-D array — named size companion (case-insensitive)
const unsigned short BLOCK[361] = { … };
const byte BLOCK_SIZE[2] = {19, 19};

// PROGMEM + empty brackets
const uint16_t MARIO_IDLE [] PROGMEM = { … };
const byte MARIO_IDLE_SIZE[2] = {13, 16};

// Named colour constants resolved automatically
const unsigned short M_RED = 0xF801;
const unsigned short TRANSPARENT = 0xFEFE;

// 2-D frame animation array
const uint16_t _PACMAN_CONST [][25] PROGMEM = {
    { /* frame 0 */ … },
    { /* frame 1 */ … }
};
```

### Transparent pixels

`0xFEFE` (or the symbol `TRANSPARENT`) is treated as transparent.  
Use the **BG** selector to choose how transparent pixels are displayed:
- **Checkerboard** — grey checker pattern (Photoshop-style)
- **Solid color** — fill with any colour (useful for sprites that are hard to see on a checker)

### SIZE arrays

Every array should have a companion size declaration so the tool knows the image dimensions:

```cpp
const byte MY_SPRITE_SIZE[2] = {width, height};  // uppercase or lowercase, either works
```

If no SIZE array is found the validation list shows a **⚠️ no SIZE defined** warning. The tool will still attempt to render the image by assuming a square layout.

---

## Hosting on GitHub

### 1. Create the repository

Create a new **public** repository named `spriteanvil` on GitHub, then push:

```bash
git remote add origin https://github.com/aschoelzhorn/spriteanvil.git
git add .
git commit -m "Initial commit"
git push -u origin main
```

### 2. Enable GitHub Pages

1. Go to **Settings → Pages** in your repository
2. Under **Source**, select **GitHub Actions**
3. The `Deploy to GitHub Pages` workflow will run automatically on every push to `main`

Your site will be live at **https://aschoelzhorn.github.io/spriteanvil**

---

## Project Structure

```
spriteanvil/
├── web/
│   ├── index.html       # UI
│   ├── app.js           # Parser, renderer, animation, export
│   └── styles.css       # Dark-theme styles
├── Dockerfile           # nginx:alpine serving web/
├── docker-compose.yml   # Port 8080
└── examples/
    ├── mario_assets.h              # Example: Mario sprites (named constants, PROGMEM)
    ├── pacman_assets.h             # Example: Pacman animation (2-D frame array)
    ├── story_dune_assets.h         # Example: Dune backgrounds (64×64, lowercase _size)
    └── fonts/
        ├── mario_Super_Mario_Bros__24pt7b.h   # Example: GFX font (Super Mario Bros)
        └── pacman_hour_font.h                 # Example: GFX font (Pacman hour digits)
```

---

## GFX Font Files

The tool also parses Adafruit GFX-compatible font headers. These are the `GFXfont` structs used by the Arduino GFX / Adafruit GFX library:

```cpp
const uint8_t MyFontBitmaps[] PROGMEM = { … };      // packed 1-bit glyph bitmaps

const GFXglyph MyFontGlyphs[] PROGMEM = {
    { bitmapOffset, width, height, xAdvance, xOffset, yOffset },
    …
};

const GFXfont MyFont PROGMEM = {
    (uint8_t *)MyFontBitmaps,
    (GFXglyph *)MyFontGlyphs,
    0x20, 0x7E,   // first, last codepoint
    13            // yAdvance
};
```

Once loaded, each font is shown in a **Fonts** section below the sprites with:
- A **glyph charmap** — every character in the font rendered at the current zoom
- A **live text preview** — type any string to see it rendered pixel-accurately
- A **colour picker** to change the glyph foreground colour

---

## Export ZIP Layout

```
assets.zip
├── assets.h                    # Root include (original source files)
├── <original_filename>.h       # Original source file(s), unchanged
└── sprites/
    ├── block.h                 # Per-sprite header (preserves PROGMEM, type, SIZE)
    ├── block.png               # PNG preview at current zoom
    ├── mario_idle.h
    ├── mario_idle.png
    └── …
```

Split `.h` files preserve the original declaration style — `uint16_t` vs `unsigned short`, `PROGMEM` attribute, and the `_SIZE` companion array.

---

## Controls Reference

| Control | Description |
|---|---|
| Drag & drop / click dropzone | Load a `.h` file |
| Paste + **Parse** button | Parse code pasted into the text area |
| **Zoom** slider | 2–64 px per pixel |
| **Grid** checkbox | Pixel grid overlay (auto-hidden below 4 px zoom) |
| **Frames as strip** checkbox | Show animation frames in one canvas or individually |
| **BG** selector | Checkerboard or solid colour for transparent pixels |
| Colour picker | Transparent pixel fill colour (visible in Solid color mode) |
| ▶ / **⏸** button | Play / pause animation per sprite group |
| **FPS** slider | Animation speed 1–30 fps per sprite group |
| **Export ZIP** | Download everything as a ZIP archive |
| Font colour picker | Change the glyph foreground colour for a loaded font |
| Font text input | Type preview text to render the font at current zoom |
