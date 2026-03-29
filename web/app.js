// ─── State ────────────────────────────────────────────────────────────────────
let sprites = [];
let sizes = {};
let constants = {};
let sourceFiles = [];
let fonts = [];
let currentTab = 'sprites';
const animState = new Map(); // baseName → intervalId

// ─── Tab switching ────────────────────────────────────────────────────────────
function switchTab(name) {
    currentTab = name;
    document.getElementById('tab-sprites').style.display    = name === 'sprites' ? '' : 'none';
    document.getElementById('tab-fonts').style.display      = name === 'fonts'   ? '' : 'none';
    document.getElementById('tab-btn-sprites').classList.toggle('active', name === 'sprites');
    document.getElementById('tab-btn-fonts').classList.toggle('active',   name === 'fonts');
    document.getElementById('btn-export-zip').style.display = name === 'sprites' ? '' : 'none';
}

function updateTabCounts() {
    const groups = new Set(sprites.map(s => s.isFrame ? s.baseName : s.name));
    const sc = groups.size, fc = fonts.length;
    document.getElementById('tab-btn-sprites').textContent = 'Sprites' + (sc ? ` (${sc})` : '');
    document.getElementById('tab-btn-fonts').textContent   = 'Fonts'   + (fc ? ` (${fc})` : '');
}

// ─── Parse entry points ────────────────────────────────────────────────────────
function doParse() {
    const code = document.getElementById('code').value;
    if (!code.trim()) return;
    parseCode(code, null, false);
    if (currentTab === 'sprites' && sprites.length === 0 && fonts.length > 0)
        switchTab('fonts');
    else if (currentTab === 'fonts' && fonts.length === 0 && sprites.length > 0)
        switchTab('sprites');
}

function parseCode(code, filename, merge) {
    if (!merge) { sprites = []; sizes = {}; constants = {}; sourceFiles = []; }
    // fonts are never bulk-cleared; same-named fonts are replaced by step 7
    if (filename && !sourceFiles.find(s => s.name === filename))
        sourceFiles.push({ name: filename, content: code });

    // 1. Scalar constants: const unsigned short/uint16_t NAME = 0xHHHH
    for (const m of code.matchAll(
        /const\s+(?:unsigned\s+short|uint16_t)\s+(\w+)\s*=\s*(0x[0-9A-Fa-f]+|\d+)/g
    )) constants[m[1]] = parseInt(m[2], 16);

    // 2. SIZE arrays – case-insensitive suffix (_SIZE or _size), any bracket content
    for (const m of code.matchAll(
        /const\s+byte\s+(\w+)_size\s*\[\d+\]\s*=\s*\{(\d+)\s*,\s*(\d+)\}/gi
    )) sizes[m[1].toLowerCase()] = { w: +m[2], h: +m[3], origDecl: m[0].trim() };

    // 2.5. #define width/height macros (e.g. #define logo_width 216 / logo_height 131)
    const defW = {}, defH = {};
    for (const m of code.matchAll(/#define\s+(\w+)_width\s+(\d+)/gi))
        defW[m[1].toLowerCase()] = +m[2];
    for (const m of code.matchAll(/#define\s+(\w+)_height\s+(\d+)/gi))
        defH[m[1].toLowerCase()] = +m[2];
    // Match a name against #define macros:
    //   1. Exact:   array name === define key
    //   2. Forward: define key is a prefix of array name (rancilio_logo_bits → rancilio_logo)
    //   3. Reverse: array name prefix starts a define key (update_bits→update → update_icon)
    //               longest/most-specific key wins in case of ties
    //   4. Single-pair fallback (opt-in): if exactly one pair exists, use it
    const resolveDefines = (name, singleFallback = false) => {
        const n = name.toLowerCase();
        if (defW[n] !== undefined && defH[n] !== undefined) return { w: defW[n], h: defH[n] };
        const parts = n.split('_');
        // forward: define key is prefix of array name
        for (let i = parts.length - 1; i > 0; i--) {
            const p = parts.slice(0, i).join('_');
            if (defW[p] !== undefined && defH[p] !== undefined) return { w: defW[p], h: defH[p] };
        }
        // reverse: array name prefix is prefix of define key
        for (let i = parts.length - 1; i > 0; i--) {
            const p = parts.slice(0, i).join('_');
            const hits = Object.keys(defW).filter(k => k.startsWith(p) && defH[k] !== undefined);
            if (hits.length > 0) {
                hits.sort((a, b) => b.length - a.length); // most-specific first
                return { w: defW[hits[0]], h: defH[hits[0]] };
            }
        }
        // single-pair fallback for unsigned char arrays
        if (singleFallback) {
            const keys = Object.keys(defW).filter(k => defH[k] !== undefined);
            if (keys.length === 1) return { w: defW[keys[0]], h: defH[keys[0]] };
        }
        return null;
    };

    // 3. 2-D frame arrays: support uint16_t, unsigned short, and uint32_t
    const handled2D = new Set();
    const re2D = /const\s+(unsigned\s+short|uint16_t|uint32_t)\s+(\w+)\s*\[\s*\d*\s*\]\s*\[(\d+)\][^;=]*=\s*\{/g;
    let m2D;
    while ((m2D = re2D.exec(code)) !== null) {
        const origType = m2D[1];
        const name = m2D[2];
        const framePixels = +m2D[3];
        const body = extractBracedContent(code, m2D.index + m2D[0].length - 1);
        if (!body) continue;
        const se = sizes[name.toLowerCase()] || resolveDefines(name);
        const fw = se ? se.w : Math.round(Math.sqrt(framePixels));
        const fh = se ? se.h : Math.round(framePixels / Math.max(1, fw));
        [...body.matchAll(/\{([^}]*)\}/g)].forEach((fm, i) => {
            let data = parseValues(fm[1].replace(/\/\/.*$/gm, ''));
            let type = origType;
            if (origType === 'uint32_t') {
                // Piskel and many tools export ABGR, so swap red and blue
                data = data.map(v => {
                    if (typeof v === 'number') {
                        if (v <= 0xFFFF) return v;
                        let a = (v >>> 24) & 0xFF;
                        let b = (v >>> 16) & 0xFF;
                        let g = (v >>> 8) & 0xFF;
                        let r = v & 0xFF;
                        if (a === 0) return 0xFEFE;
                        return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
                    }
                    return v;
                });
                type = 'uint16_t';
            }
            sprites.push({
                name: `${name}_frame${i}`, baseName: name, frameIndex: i,
                data,
                width: fw, height: fh, isFrame: true,
                sizeExplicit: !!se, origType: type, useProgmem: true,
                origSizeDecl: se ? se.origDecl : null
            });
        });
        handled2D.add(name);
    }

    // 4. 1-D arrays  const unsigned short/uint16_t/uint32_t NAME[N] or NAME[] PROGMEM? = {…}
    //    [^=\[] after ] blocks matching 2-D [][N] patterns
    const re1D = /const\s+((unsigned\s+short)|(uint16_t)|(uint32_t))\s+(\w+)\s*\[[\s\d]*\]([^=\[]*)=\s*\{([\s\S]*?)\}/g;
    for (const m of code.matchAll(re1D)) {
        let origType = m[2] ? 'unsigned short' : (m[3] ? 'uint16_t' : (m[4] ? 'uint32_t' : ''));
        const name = m[5];
        if (/^.+_size$/i.test(name)) continue;
        if (handled2D.has(name)) continue;
        const raw = m[7].replace(/\/\/.*$/gm, '');
        let data = parseValues(raw);
        // If uint32_t, convert ARGB/RGBA/0xAARRGGBB/0xRRGGBBAA to RGB565
        if (origType === 'uint32_t') {
            // Piskel and many tools export ABGR, so swap red and blue
            data = data.map(v => {
                if (typeof v === 'number') {
                    if (v <= 0xFFFF) return v;
                    let a = (v >>> 24) & 0xFF;
                    let b = (v >>> 16) & 0xFF;
                    let g = (v >>> 8) & 0xFF;
                    let r = v & 0xFF;
                    if (a === 0) return 0xFEFE;
                    return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
                }
                return v;
            });
            origType = 'uint16_t'; // treat as RGB565 for downstream
        }
        if (!data.length) continue;
        const se = sizes[name.toLowerCase()] || resolveDefines(name);
        const w = se ? se.w : Math.round(Math.sqrt(data.length));
        const h = se ? se.h : Math.round(data.length / Math.max(1, w));
        sprites.push({
            name, data, width: w, height: h, isFrame: false,
            sizeExplicit: !!se, origType, useProgmem: /\bPROGMEM\b/.test(m[6]),
            origSizeDecl: se ? se.origDecl : null
        });
    }

    // ─── 4.5. unsigned char 1-bit bitmaps (XBM / PROGMEM style)
    //          Bits are packed LSB-first; rows are padded to a byte boundary.
    //          Size must come from a #define NAME_width/height pair in the same file.
    for (const m of code.matchAll(
        /const\s+unsigned\s+char\s+(\w+)\s*\[\s*\d*\s*\][^;=]*=\s*\{([\s\S]*?)\}/g
    )) {
        const name = m[1];
        if (/^.+_size$/i.test(name)) continue;
        const raw = m[2].replace(/\/\/.*$/gm, '');
        const bytes = raw.split(',').map(v => {
            v = v.trim();
            if (!v) return null;
            if (/^0[xX]/.test(v)) return parseInt(v, 16);
            if (/^\d+$/.test(v)) return parseInt(v, 10);
            return null;
        }).filter(v => v !== null);
        if (!bytes.length) continue;
        const sd = sizes[name.toLowerCase()] || resolveDefines(name, true);
        if (!sd) continue;                              // can't unpack without explicit W/H
        const { w, h } = sd;
        const bytesPerRow = Math.ceil(w / 8);
        const bits = [];
        for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++) {
                const b = bytes[y * bytesPerRow + Math.floor(x / 8)] ?? 0;
                bits.push((b >> (x % 8)) & 1);
            }
        const monoSprite = {
            name, bits, data: [], width: w, height: h, isFrame: false,
            sizeExplicit: true, origType: 'unsigned char',
            useProgmem: /\bPROGMEM\b/.test(m[0]), origSizeDecl: null,
            isMono: true, fgColor: '#ffffff', bgColor: '#000000', bgTransparent: true
        };
        recolorMono(monoSprite);
        sprites.push(monoSprite);
    }

    // ─── 5. GFX font bitmaps: const uint8_t NAMEBitmaps[] PROGMEM = { … };
    const fntBitmaps = {};
    for (const m of code.matchAll(
        /const\s+uint8_t\s+(\w+)Bitmaps\s*\[\s*\]\s*PROGMEM\s*=\s*\{([\s\S]*?)\};/g
    )) fntBitmaps[m[1]] = m[2].split(',').map(v => Number.parseInt(v.trim(), 16)).filter(n => !Number.isNaN(n));

    // ─── 6. GFX glyph tables: const GFXglyph NAMEGlyphs[] PROGMEM = { {…}, … };
    const fntGlyphs = {};
    for (const m of code.matchAll(
        /const\s+GFXglyph\s+(\w+)Glyphs\s*\[\s*\]\s*PROGMEM\s*=\s*\{([\s\S]*?)\};/g
    )) {
        const glyphs = [];
        for (const gm of m[2].matchAll(
            /\{\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\}/g
        )) glyphs.push({ bitmapOffset: +gm[1], width: +gm[2], height: +gm[3],
                         xAdvance: +gm[4], xOffset: +gm[5], yOffset: +gm[6] });
        fntGlyphs[m[1]] = glyphs;
    }

    // ─── 7. GFX font struct: const GFXfont NAME PROGMEM = { ptr, ptr, first, last, yAdv };
    for (const m of code.matchAll(
        /const\s+GFXfont\s+(\w+)\s+PROGMEM\s*=\s*\{[^,]*,\s*[^,]*,\s*(0x[0-9A-Fa-f]+|\d+)\s*,\s*(0x[0-9A-Fa-f]+|\d+)\s*,\s*(\d+)/g
    )) {
        const name = m[1];
        const first    = Number.parseInt(m[2], 16);
        const last     = Number.parseInt(m[3], 16);
        const yAdvance = +m[4];
        if (!fntBitmaps[name] || !fntGlyphs[name]) continue;
        const fontObj = { name, first, last, yAdvance,
                     bitmaps: fntBitmaps[name], glyphs: fntGlyphs[name],
                     previewText: 'Hello 123', fgColor: '#ffffff' };
        const existingIdx = fonts.findIndex(f => f.name === name);
        if (existingIdx >= 0) fonts[existingIdx] = fontObj; // auto-replace same-named
        else fonts.push(fontObj);
    }

    renderSprites();
    validateAll();
    updateTabCounts();
}

function extractBracedContent(str, openPos) {
    let depth = 0;
    for (let i = openPos; i < str.length; i++) {
        if (str[i] === '{') depth++;
        else if (str[i] === '}' && --depth === 0) return str.slice(openPos + 1, i);
    }
    return null;
}

function parseValues(raw) {
    return raw.split(',').map(v => v.trim()).filter(Boolean).map(v => {
        if (v === 'TRANSPARENT') return 0xFEFE;
        if (constants[v] !== undefined) return constants[v];
        if (/^0[xX]/.test(v)) return parseInt(v, 16);
        if (/^\d+$/.test(v)) return parseInt(v, 10);
        return 0;
    });
}

// ─── Rendering ────────────────────────────────────────────────────────────────
function getSpriteZoom() { return +document.getElementById('zoom-sprites').value; }
function getFontZoom()   { return +document.getElementById('zoom-fonts').value; }
function getZoom()       { return currentTab === 'fonts' ? getFontZoom() : getSpriteZoom(); }
function getGrid()       { return document.getElementById('grid').checked; }
function getStrip()      { return document.getElementById('stripMode').checked; }
function getSpriteBg() {
    return { mode: document.getElementById('bgMode-sprites').value,
             color: document.getElementById('bgColor-sprites').value };
}
function getFontBg() {
    return { mode: document.getElementById('bgMode-fonts').value,
             color: document.getElementById('bgColor-fonts').value };
}

// ─── Mono (1-bit) color helpers ──────────────────────────────────────────────────
function hexToRgb565(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
}

function recolorMono(s) {
    const fg = hexToRgb565(s.fgColor);
    const bg = s.bgTransparent ? 0xFEFE : hexToRgb565(s.bgColor);
    s.data = s.bits.map(bit => bit ? fg : bg);
}

function mkMonoPickers(s, canvas) {
    const row = document.createElement('div');
    row.className = 'mono-pickers';

    // FG
    const fgWrap = document.createElement('label');
    fgWrap.className = 'mono-picker-label';
    fgWrap.title = 'Foreground — drawn pixels (bit = 1)';
    fgWrap.appendChild(document.createTextNode('FG '));
    const fgInput = document.createElement('input');
    fgInput.type = 'color'; fgInput.value = s.fgColor;
    fgWrap.appendChild(fgInput);
    row.appendChild(fgWrap);

    // Transparent BG toggle
    const transpWrap = document.createElement('label');
    transpWrap.className = 'mono-picker-label';
    const transpCheck = document.createElement('input');
    transpCheck.type = 'checkbox'; transpCheck.checked = s.bgTransparent;
    transpWrap.appendChild(transpCheck);
    transpWrap.appendChild(document.createTextNode(' Transp. BG'));
    row.appendChild(transpWrap);

    // BG (hidden when transparent)
    const bgWrap = document.createElement('label');
    bgWrap.className = 'mono-picker-label';
    bgWrap.title = 'Background — empty pixels (bit = 0)';
    bgWrap.appendChild(document.createTextNode('BG '));
    const bgInput = document.createElement('input');
    bgInput.type = 'color'; bgInput.value = s.bgColor;
    bgWrap.appendChild(bgInput);
    bgWrap.style.display = s.bgTransparent ? 'none' : '';
    row.appendChild(bgWrap);

    function refresh() {
        recolorMono(s);
        const z = getSpriteZoom(), g = getGrid();
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        drawBg(ctx, s.width, s.height, z, 0, getSpriteBg());
        pixelDraw(ctx, s.data, s.width, s.height, z);
        if (g) gridDraw(ctx, s.width, s.height, z);
    }

    fgInput.addEventListener('input', () => { s.fgColor = fgInput.value; refresh(); });
    bgInput.addEventListener('input', () => { s.bgColor = bgInput.value; refresh(); });
    transpCheck.addEventListener('change', () => {
        s.bgTransparent = transpCheck.checked;
        bgWrap.style.display = transpCheck.checked ? 'none' : '';
        refresh();
    });
    return row;
}

function renderSprites() {
    document.getElementById('zoomVal-sprites').textContent = getSpriteZoom();
    const z = getSpriteZoom(), grid = getGrid(), useStrip = getStrip();
    const container = document.getElementById('sprites');
    stopAllAnims();
    container.innerHTML = '';

    const frameGroups = {}, singles = [];
    sprites.forEach(s => {
        if (s.isFrame) {
            (frameGroups[s.baseName] = frameGroups[s.baseName] || []).push(s);
        } else {
            singles.push(s);
        }
    });
    // Move any 'animated' group with only one frame to singles
    Object.entries(frameGroups).forEach(([base, frames]) => {
        if (frames.length === 1) {
            singles.push(frames[0]);
            delete frameGroups[base];
        }
    });

    singles.forEach(s => {
        const { card, zoomBtn, nativeBtn, exportBtn } = mkCard(`${s.name} <span class="dim">${s.width}&times;${s.height}</span>`);
        const canvas = drawSprite(s, z, grid);
        card.appendChild(canvas);
        if (s.isMono) card.appendChild(mkMonoPickers(s, canvas));
        zoomBtn.onclick   = () => downloadCanvas(drawSprite(s, getZoom(), false), s.name, getZoom());
        nativeBtn.onclick = () => downloadCanvas(drawSprite(s, 1, false), s.name);
        exportBtn.onclick = () => exportSpriteHeader(s);
        container.appendChild(card);
    });

    Object.entries(frameGroups).forEach(([base, frames]) => {
        const { width: w, height: h } = frames[0];
        const { card, zoomBtn, nativeBtn, exportBtn } = mkCard(
            `${base} <span class="dim">${frames.length} frames &times; ${w}&times;${h}</span>`);

        // ── animated preview ─────────────────────────────────────────────────
        const animWrap = document.createElement('div');
        animWrap.className = 'anim-wrap';

        const animCanvas = document.createElement('canvas');
        animCanvas.width  = w * z;
        animCanvas.height = h * z;
        animWrap.appendChild(animCanvas);

        const animCtrl = document.createElement('div');
        animCtrl.className = 'anim-controls';

        const playBtn = document.createElement('button');
        playBtn.className = 'anim-btn';
        playBtn.textContent = '⏸';
        animCtrl.appendChild(playBtn);

        const fpsLabel = document.createElement('label');
        fpsLabel.className = 'anim-fps-label';
        fpsLabel.appendChild(document.createTextNode('FPS '));
        const fpsInput = document.createElement('input');
        fpsInput.type = 'range'; fpsInput.min = 1; fpsInput.max = 30; fpsInput.value = 6;
        const fpsVal = document.createElement('span');
        fpsVal.textContent = '6';
        fpsInput.addEventListener('input', () => { fpsVal.textContent = fpsInput.value; });
        fpsLabel.appendChild(fpsInput);
        fpsLabel.appendChild(fpsVal);
        animCtrl.appendChild(fpsLabel);

        animWrap.appendChild(animCtrl);
        card.appendChild(animWrap);
        const getCurrentFrame = setupAnim(base, frames, animCanvas, fpsInput, playBtn);
        attachPixelInspector(animCanvas, getCurrentFrame);

        // ── strip or individual frames ───────────────────────────────────────
        if (useStrip && frames.length > 1) {
            card.appendChild(drawStrip(frames, z, grid));
        } else {
            const row = document.createElement('div');
            row.className = 'frames-row';
            frames.forEach((f, i) => {
                const wrap = document.createElement('div');
                wrap.className = 'frame-wrap';
                wrap.innerHTML = `<div class="frame-num">Frame ${i}</div>`;
                wrap.appendChild(drawSprite(f, z, grid));
                // Add per-frame PNG download button
                const framePngBtn = document.createElement('button');
                framePngBtn.className = 'save-png-btn';
                framePngBtn.textContent = `PNG ${z}×`;
                framePngBtn.title = `Save Frame ${i} as PNG at current zoom (${z}×)`;
                framePngBtn.onclick = () => downloadCanvas(drawSprite(f, z, false), `${base}_frame${i}`, z);
                wrap.appendChild(framePngBtn);
                row.appendChild(wrap);
            });
            card.appendChild(row);
        }

        // Add 'Save all frames as PNGs (ZIP)' buttons if more than one frame
        if (frames.length > 1) {
            // Use the same JSZip logic as exportZip, but only for this group and zoom
            async function zipAllFramesGroup(frames, base, z) {
                const zip = new JSZip();
                for (let i = 0; i < frames.length; i++) {
                    const canvas = drawSprite(frames[i], z, false);
                    // eslint-disable-next-line no-await-in-loop
                    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
                    zip.file(`${base}_frame${i}_${z}x.png`, blob);
                }
                const out = await zip.generateAsync({ type: 'blob' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(out);
                a.download = `${base}_frames_${z}x.zip`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 5000);
            }
            // Button for current zoom
            const allFramesBtnZ = document.createElement('button');
            allFramesBtnZ.className = 'save-png-btn';
            allFramesBtnZ.textContent = `Save all frames as PNGs (ZIP)`;
            allFramesBtnZ.title = `Download all frames as PNGs at current zoom (${z}×) in a ZIP`;
            allFramesBtnZ.onclick = () => zipAllFramesGroup(frames, base, z);
            card.appendChild(allFramesBtnZ);
            // Button for native (1x)
            const allFramesBtn1 = document.createElement('button');
            allFramesBtn1.className = 'save-png-btn';
            allFramesBtn1.textContent = `Save all frames as PNGs (ZIP, 1x)`;
            allFramesBtn1.title = `Download all frames as PNGs at native size (1x) in a ZIP`;
            allFramesBtn1.onclick = () => zipAllFramesGroup(frames, base, 1);
            card.appendChild(allFramesBtn1);
        }

        // Disable APNG export button for now
        zoomBtn.style.display = 'none';
        nativeBtn.style.display = 'none';

        // Add Export RGB565 .h for animated (2D array)
        exportBtn.onclick = () => exportAnimatedHeader(base, frames);

        container.appendChild(card);
    });
    // Export a 2D array (animated sprite group) as a C header file (RGB565 array)
    function exportAnimatedHeader(baseName, frames) {
        if (!frames.length) return;
        const w = frames[0].width, h = frames[0].height, n = frames.length;
        const arrName = baseName.replace(/\W/g, '_');
        let lines = [];
        lines.push(`#pragma once`);
        lines.push(`// Animated Sprite: ${baseName} (${n} frames, ${w}x${h})`);
        lines.push(`// Format: RGB565, ${n}x${w}x${h}`);
        lines.push("");
        lines.push(`const uint16_t ${arrName}[${n}][${w * h}] = {`);
        for (let i = 0; i < n; i++) {
            lines.push(`    { // Frame ${i}`);
            let row = '';
            for (let y = 0; y < h; y++) {
                row += '        ';
                for (let x = 0; x < w; x++) {
                    const v = frames[i].data[y * w + x];
                    row += `0x${(v === 0xFEFE || v === undefined ? 0 : v).toString(16).toUpperCase().padStart(4, '0')}`;
                    if (x < w * 1 - 1 || y < h - 1) row += ', ';
                }
                row += '\n';
            }
            lines.push(row + '    },');
        }
        lines.push('};');
        // Always include a size array if width/height are known
        if (w && h) {
            lines.push(`const byte ${arrName}_size[3] = {${n}, ${w}, ${h}};`);
        }
        lines.push('');
        const content = lines.join('\n');
        const blob = new Blob([content], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${arrName}.h`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
    renderFonts();
    updateTabCounts();
}

function mkCard(labelHtml) {
    const card = document.createElement('div');
    card.className = 'sprite-card';
    const lbl = document.createElement('div');
    lbl.className = 'sprite-label';
    const textSpan = document.createElement('span');
    textSpan.className = 'label-text';
    textSpan.innerHTML = labelHtml;
    lbl.appendChild(textSpan);
    const btns = document.createElement('div');
    btns.className = 'save-png-btns';
    const z = getSpriteZoom();
    const zoomBtn = document.createElement('button');
    zoomBtn.className = 'save-png-btn';
    zoomBtn.textContent = `PNG ${z}×`;
    zoomBtn.title = `Save PNG at current zoom (${z}× — ${z} screen pixels per sprite pixel)`;
    const nativeBtn = document.createElement('button');
    nativeBtn.className = 'save-png-btn';
    nativeBtn.textContent = 'PNG 1×';
    nativeBtn.title = 'Save PNG at native size (1 screen pixel per sprite pixel)';
    btns.appendChild(zoomBtn);
    btns.appendChild(nativeBtn);
    // Add Export RGB565 .h button
    const exportBtn = document.createElement('button');
    exportBtn.className = 'save-png-btn';
    exportBtn.textContent = 'Export RGB565 .h';
    exportBtn.title = 'Export this sprite as a C header file (RGB565 array)';
    btns.appendChild(exportBtn);
    lbl.appendChild(btns);
    card.appendChild(lbl);
    return { card, zoomBtn, nativeBtn, exportBtn };
}

function drawBg(ctx, w, h, z, offX = 0, bg = null) {
    if (!bg) bg = getSpriteBg();
    if (bg.mode === 'color') {
        ctx.fillStyle = bg.color;
        ctx.fillRect(offX, 0, w * z, h * z);
    } else {
        const sz = Math.max(8, z);
        for (let py = 0; py < h * z; py += sz)
            for (let px = 0; px < w * z; px += sz) {
                ctx.fillStyle = ((Math.floor((offX + px) / sz) + Math.floor(py / sz)) % 2 === 0)
                    ? '#555' : '#888';
                ctx.fillRect(offX + px, py, sz, sz);
            }
    }
}

function pixelDraw(ctx, data, w, h, z, offX = 0) {
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const v = data[y * w + x];
            if (v === 0xFEFE || v === undefined) continue;
            ctx.fillStyle = `rgb(${((v >> 11) & 31) << 3},${((v >> 5) & 63) << 2},${(v & 31) << 3})`;
            ctx.fillRect(offX + x * z, y * z, z, z);
        }
}

function gridDraw(ctx, w, h, z, offX = 0) {
    if (z < 4) return;
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 0.5;
    for (let x = 0; x <= w; x++) {
        ctx.beginPath(); ctx.moveTo(offX + x * z, 0); ctx.lineTo(offX + x * z, h * z); ctx.stroke();
    }
    for (let y = 0; y <= h; y++) {
        ctx.beginPath(); ctx.moveTo(offX, y * z); ctx.lineTo(offX + w * z, y * z); ctx.stroke();
    }
}

function drawSprite(s, z, grid) {
    const canvas = document.createElement('canvas');
    canvas.width = s.width * z;  canvas.height = s.height * z;
    const ctx = canvas.getContext('2d');
    drawBg(ctx, s.width, s.height, z, 0, getSpriteBg());
    pixelDraw(ctx, s.data, s.width, s.height, z);
    if (grid) gridDraw(ctx, s.width, s.height, z);
    attachPixelInspector(canvas, s);
    return canvas;
}

function drawStrip(frames, z, grid) {
    const { width: w, height: h } = frames[0];
    const gap = 4, labelH = 16;
    const canvas = document.createElement('canvas');
    canvas.width  = frames.length * w * z + (frames.length - 1) * gap;
    canvas.height = h * z + labelH;
    const ctx = canvas.getContext('2d');
    frames.forEach((frame, i) => {
        const offX = i * (w * z + gap);
        drawBg(ctx, w, h, z, offX, getSpriteBg());
        pixelDraw(ctx, frame.data, w, h, z, offX);
        if (grid) gridDraw(ctx, w, h, z, offX);
        ctx.fillStyle = '#aaa';
        ctx.font = '10px monospace';
        ctx.fillText(`#${i}`, offX + 2, h * z + 12);
    });
    return canvas;
}

// ─── Pixel hover inspector ───────────────────────────────────────────────────
const pxTooltip = document.getElementById('px-tooltip');

// sprite can be an object or a zero-arg function that returns the current sprite
function attachPixelInspector(canvas, spriteOrGetter) {
    const getSprite = typeof spriteOrGetter === 'function' ? spriteOrGetter : () => spriteOrGetter;
    canvas.addEventListener('mousemove', e => {
        if (!document.getElementById('inspector').checked) {
            pxTooltip.style.display = 'none';
            return;
        }
        const sprite = getSprite();
        const z = getZoom();
        const rect = canvas.getBoundingClientRect();
        const px = Math.floor((e.clientX - rect.left) / z);
        const py = Math.floor((e.clientY - rect.top)  / z);
        if (px < 0 || py < 0 || px >= sprite.width || py >= sprite.height) {
            pxTooltip.style.display = 'none';
            return;
        }
        const v = sprite.data[py * sprite.width + px];
        let html;
        if (v === 0xFEFE || v === undefined) {
            html = `<b>${px}, ${py}</b> &nbsp; transparent`;
        } else {
            const r = ((v >> 11) & 31) << 3;
            const g = ((v >> 5)  & 63) << 2;
            const b =  (v & 31)        << 3;
            const hex = '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
            html = `<span class="px-swatch" style="background:${hex}"></span>` +
                   `<b>${px}, ${py}</b> &nbsp; ` +
                   `0x${v.toString(16).toUpperCase().padStart(4,'0')} &nbsp; ` +
                   `rgb(${r},${g},${b})`;
        }
        pxTooltip.innerHTML = html;
        pxTooltip.style.display = 'block';
        // Default: above-right of cursor (eye is already there while hovering).
        // Fall back to below if too close to top; flip left if too close to right edge.
        const tw = pxTooltip.offsetWidth, th = pxTooltip.offsetHeight;
        const margin = 12;
        let tx = e.clientX + margin;
        let ty = e.clientY - th - margin;
        if (ty < 4)                          ty = e.clientY + margin; // near top → go below
        if (tx + tw > window.innerWidth - 4) tx = e.clientX - tw - margin; // near right → go left
        pxTooltip.style.left = tx + 'px';
        pxTooltip.style.top  = ty + 'px';
    });
    canvas.addEventListener('mouseleave', () => { pxTooltip.style.display = 'none'; });
}

function downloadCanvas(canvas, name, zoom) {
    canvas.toBlob(blob => {
        const a = document.createElement('a');
        let fname = name;
        if (zoom && zoom > 1) fname += `_${zoom}x`;
        a.href = URL.createObjectURL(blob);
        a.download = `${fname}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }, 'image/png');
}

// ─── Animation ────────────────────────────────────────────────────────────────
function stopAllAnims() {
    for (const id of animState.values()) clearInterval(id);
    animState.clear();
}

function setupAnim(baseName, frames, canvas, fpsEl, playBtn) {
    let frameIdx = 0;
    let playing  = true;
    let timerId  = null;

    function drawAnimFrame() {
        const z = getSpriteZoom(), grid = getGrid();
        const f = frames[frameIdx];
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        drawBg(ctx, f.width, f.height, z, 0, getSpriteBg());
        pixelDraw(ctx, f.data, f.width, f.height, z);
        if (grid) gridDraw(ctx, f.width, f.height, z);
    }

    function schedule() {
        timerId = setInterval(() => {
            frameIdx = (frameIdx + 1) % frames.length;
            drawAnimFrame();
        }, 1000 / Math.max(1, +fpsEl.value));
        animState.set(baseName, timerId);
    }

    drawAnimFrame(); // render frame 0 immediately
    schedule();

    playBtn.addEventListener('click', () => {
        playing = !playing;
        playBtn.textContent = playing ? '⏸' : '▶';
        if (playing) { schedule(); } else { clearInterval(timerId); }
    });

    fpsEl.addEventListener('input', () => {
        if (playing) { clearInterval(timerId); schedule(); }
    });

    return () => frames[frameIdx]; // getter for the pixel inspector
}

document.getElementById('zoom-sprites').addEventListener('input', renderSprites);
document.getElementById('zoom-fonts').addEventListener('input', renderFonts);
document.getElementById('grid').addEventListener('change', renderSprites);
document.getElementById('stripMode').addEventListener('change', renderSprites);
document.getElementById('bgMode-sprites').addEventListener('change', () => {
    document.getElementById('bgColor-sprites').style.display =
        document.getElementById('bgMode-sprites').value === 'color' ? '' : 'none';
    renderSprites();
});
document.getElementById('bgColor-sprites').addEventListener('input', renderSprites);
document.getElementById('bgMode-fonts').addEventListener('change', () => {
    document.getElementById('bgColor-fonts').style.display =
        document.getElementById('bgMode-fonts').value === 'color' ? '' : 'none';
    renderFonts();
});
document.getElementById('bgColor-fonts').addEventListener('input', renderFonts);

// hide colour pickers on initial load (default = checker)
document.getElementById('bgColor-sprites').style.display = 'none';
document.getElementById('bgColor-fonts').style.display = 'none';

// ─── Validation ───────────────────────────────────────────────────────────────
function validateAll() {
    const lines = [], reported = new Set();
    sprites.forEach(s => {
        if (s.isFrame) {
            if (reported.has(s.baseName)) return;
            reported.add(s.baseName);
            const grp = sprites.filter(x => x.baseName === s.baseName);
            const ok  = grp.every(f => f.width * f.height === f.data.length);
            const w   = s.sizeExplicit ? '' : '  ⚠️ no SIZE defined';
            lines.push(`${ok ? '✅' : '❌'} ${s.baseName} (${grp.length} frames · ${s.width}×${s.height})${w}`);
        } else {
            const exp = s.width * s.height, ok = exp === s.data.length;
            const w   = s.sizeExplicit ? '' : '  ⚠️ no SIZE defined';
            lines.push(`${ok ? '✅' : '❌'} ${s.name} (${s.width}×${s.height})` +
                       `${ok ? '' : `: ${s.data.length}/${exp} px`}${w}`);
        }
    });
    document.getElementById('validation').textContent =
        lines.length ? lines.join('\n') : '(no sprites loaded)';
}

// ─── Font rendering ───────────────────────────────────────────────────────────
function renderFonts() {
    const container = document.getElementById('fonts');
    container.innerHTML = '';
    const fz = getFontZoom();
    document.getElementById('zoomVal-fonts').textContent = fz;
    if (!fonts.length) return;
    const z = fz;
    const hdr = document.createElement('h2');
    hdr.className = 'section-header';
    hdr.textContent = 'Fonts';
    container.appendChild(hdr);
    fonts.forEach(font => container.appendChild(mkFontUI(font, z)));
}

// Compute shared baseline metrics across all glyphs in the font.
// Used so every charmap cell has the same height with a common baseline.
function fontMetrics(font) {
    let top = 0, bot = 1, any = false;
    for (const g of font.glyphs) {
        if (g.width === 0 && g.height === 0) continue;
        if (!any) { top = g.yOffset; bot = g.yOffset + g.height; any = true; }
        else { top = Math.min(top, g.yOffset); bot = Math.max(bot, g.yOffset + g.height); }
    }
    if (!any) { top = 0; bot = font.yAdvance; }
    return { top, bottom: bot, baseline: -top, cellH: Math.max(1, bot - top) };
}

// Draw one glyph cell. When `metrics` is supplied every cell shares the same
// height with glyphs positioned on a common baseline (fixes misalignment).
function drawGlyph(font, glyphIdx, z, fgColor, metrics = null) {
    const g = font.glyphs[glyphIdx];
    if (!g || g.width === 0 || g.height === 0) return null;
    const bg = getFontBg();
    const cellH    = metrics ? metrics.cellH    : g.height;
    const baseline = metrics ? metrics.baseline : 0;
    const cellW    = metrics
        ? Math.max(g.xAdvance, g.width + Math.max(0, g.xOffset))
        : g.width;
    const canvas = document.createElement('canvas');
    canvas.width  = Math.max(1, cellW) * z;
    canvas.height = cellH * z;
    const ctx = canvas.getContext('2d');
    drawBg(ctx, Math.max(1, cellW), cellH, z, 0, bg);
    ctx.fillStyle = fgColor;
    const dy = metrics ? (baseline + g.yOffset) * z : 0;
    const dx = metrics ? Math.max(0, g.xOffset) * z  : 0;
    for (let row = 0; row < g.height; row++)
        for (let col = 0; col < g.width; col++)
            if (glyphBit(font, g.bitmapOffset, row * g.width + col))
                ctx.fillRect(dx + col * z, dy + row * z, z, z);
    if (getGrid()) gridDraw(ctx, Math.max(1, cellW), cellH, z);
    return canvas;
}

// 1-bit glyph bitmap: bitmapOffset is a BYTE offset; bits are packed MSB-first
function glyphBit(font, bitmapOffset, bitIndex) {
    const globalBit = bitmapOffset * 8 + bitIndex;
    const byte = font.bitmaps[Math.floor(globalBit / 8)];
    return (byte !== undefined) ? (byte >> (7 - (globalBit % 8))) & 1 : 0;
}

function renderFontPreview(font, text, z, fgColor, canvas) {
    // Compute the tight bounding box of the actual rendered glyphs.
    // baseline = distance from top of canvas to the cursor Y (GFX cursor sits at baseline;
    // yOffset is negative for pixels above it, positive for pixels below).
    let topExtent = 0, bottomExtent = 1;
    let hasGlyphs = false;
    let totalW = 0;
    for (const ch of text) {
        const code = ch.codePointAt(0);
        if (code < font.first || code > font.last) { totalW += font.yAdvance; continue; }
        const g = font.glyphs[code - font.first];
        totalW += g.xAdvance;
        if (g.width > 0 && g.height > 0) {
            if (!hasGlyphs) {
                topExtent = g.yOffset; bottomExtent = g.yOffset + g.height; hasGlyphs = true;
            } else {
                topExtent    = Math.min(topExtent,    g.yOffset);
                bottomExtent = Math.max(bottomExtent, g.yOffset + g.height);
            }
        }
    }
    if (!hasGlyphs) { topExtent = 0; bottomExtent = font.yAdvance; }
    const baseline = -topExtent;
    const canvasH  = Math.max(1, bottomExtent - topExtent);
    canvas.width  = Math.max(1, totalW * z);
    canvas.height = canvasH * z;
    const ctx = canvas.getContext('2d');
    drawBg(ctx, totalW, canvasH, z, 0, getFontBg());
    ctx.fillStyle = fgColor;
    let curX = 0;
    for (const ch of text) {
        const code = ch.codePointAt(0);
        if (code < font.first || code > font.last) { curX += font.yAdvance; continue; }
        const g = font.glyphs[code - font.first];
        if (g.width > 0 && g.height > 0) {
            const dy = (baseline + g.yOffset) * z;
            const dx = (curX    + g.xOffset ) * z;
            for (let row = 0; row < g.height; row++)
                for (let col = 0; col < g.width; col++)
                    if (glyphBit(font, g.bitmapOffset, row * g.width + col))
                        ctx.fillRect(dx + col * z, dy + row * z, z, z);
        }
        curX += g.xAdvance;
    }
}

function mkFontUI(font, z) {
    const cmZ  = Math.max(1, Math.min(6, z)); // charmap uses capped zoom
    const card = document.createElement('div');
    card.className = 'font-card';

    // header
    const metrics = fontMetrics(font);
    const activeCount = font.glyphs.filter(g => g.width > 0 || g.xAdvance > 0).length;
    const hdr = document.createElement('div');
    hdr.className = 'sprite-label';
    hdr.innerHTML = `${font.name} <span class="dim">${activeCount} glyphs &middot; ` +
        `0x${font.first.toString(16).toUpperCase()}&ndash;` +
        `0x${font.last.toString(16).toUpperCase()} &middot; yAdv&nbsp;${font.yAdvance}</span>`;
    card.appendChild(hdr);

    // font metrics row
    const metaRow = document.createElement('div');
    metaRow.className = 'font-meta';
    metaRow.innerHTML =
        `Leading&nbsp;<b>${font.yAdvance}</b> &nbsp;&middot;&nbsp; ` +
        `Baseline&nbsp;<b>${metrics.baseline}</b> &nbsp;&middot;&nbsp; ` +
        `Cell height&nbsp;<b>${metrics.cellH}px</b>`;
    card.appendChild(metaRow);

    // preview controls row
    const previewRow = document.createElement('div');
    previewRow.className = 'font-preview-row';
    const colorInput = document.createElement('input');
    colorInput.type = 'color'; colorInput.value = font.fgColor; colorInput.title = 'Glyph colour';
    previewRow.appendChild(colorInput);
    const textInput = document.createElement('input');
    textInput.type = 'text'; textInput.className = 'font-text-input';
    textInput.placeholder = 'Type preview text\u2026'; textInput.value = font.previewText;
    previewRow.appendChild(textInput);
    card.appendChild(previewRow);

    // preview canvas (rendered text)
    const previewCanvas = document.createElement('canvas');
    previewCanvas.className = 'font-preview-canvas';
    card.appendChild(previewCanvas);

    // character map grid
    const mapDiv = document.createElement('div');
    mapDiv.className = 'font-charmap';
    for (let i = 0; i < font.glyphs.length; i++) {
        const g    = font.glyphs[i];
        const code = font.first + i;
        // skip truly undefined glyphs (zero everything)
        if (g.width === 0 && g.height === 0 && g.xAdvance === 0) continue;
        const cell = document.createElement('div');
        cell.className = 'font-char-cell';
        cell.title = `U+${code.toString(16).toUpperCase().padStart(2, '0')} '${
            code >= 33 ? String.fromCodePoint(code) : ' '}'`;
        if (g.width > 0 && g.height > 0) {
            cell.appendChild(drawGlyph(font, i, cmZ, font.fgColor, metrics));
        } else {
            const ph = document.createElement('div');
            ph.className = 'font-char-empty';
            ph.style.width  = `${Math.max(4, g.xAdvance) * cmZ}px`;
            ph.style.height = `${metrics.cellH * cmZ}px`;
            cell.appendChild(ph);
        }
        const lbl = document.createElement('div');
        lbl.className = 'font-char-label';
        lbl.textContent = code >= 33 ? String.fromCodePoint(code) : `·`;
        cell.appendChild(lbl);
        mapDiv.appendChild(cell);
    }
    card.appendChild(mapDiv);

    // event handlers – store values on font object so re-renders restore them
    const updatePreview = () => {
        font.previewText = textInput.value;
        renderFontPreview(font, font.previewText, z, font.fgColor, previewCanvas);
    };
    textInput.addEventListener('input', updatePreview);
    colorInput.addEventListener('input', () => {
        font.fgColor = colorInput.value;
        mapDiv.querySelectorAll('.font-char-cell').forEach((cell, i) => {
            // find the glyph index this cell corresponds to (skipping all-zero entries)
            const gc = cell.querySelector('canvas');
            if (!gc) return;
            const cellIdx = [...mapDiv.children].indexOf(cell);
            // map visible cell index back to glyph index
            let visIdx = 0;
            for (let gi = 0; gi < font.glyphs.length; gi++) {
                const gg = font.glyphs[gi];
                if (gg.width === 0 && gg.height === 0 && gg.xAdvance === 0) continue;
                if (visIdx === cellIdx) {
                    const ng = drawGlyph(font, gi, cmZ, font.fgColor, metrics);
                    if (ng) cell.replaceChild(ng, gc);
                    break;
                }
                visIdx++;
            }
        });
        renderFontPreview(font, font.previewText, z, font.fgColor, previewCanvas);
    });
    updatePreview();

    card.appendChild(mkSubsetUI(font));
    return card;
}

// ─── Font subsetting ──────────────────────────────────────────────────────────

// Extracts bits for one glyph from the font's packed bitmap buffer.
function extractGlyphBits(font, gi) {
    const g = font.glyphs[gi];
    const bits = [];
    for (let b = 0; b < g.width * g.height; b++) bits.push(glyphBit(font, g.bitmapOffset, b));
    return bits;
}

// Returns a new font object containing only the codepoints in keepCodes.
// Gaps in the range are filled with zero-size spacer glyphs (GFX-compatible).
function subsetFont(font, keepCodes) {
    const keepSet = new Set(keepCodes.filter(c => c >= font.first && c <= font.last));
    if (keepSet.size === 0) return null;
    const newFirst = Math.min(...keepSet);
    const newLast  = Math.max(...keepSet);

    const newBitmaps = [];
    const newGlyphs  = [];
    let   bitPos     = 0;

    for (let code = newFirst; code <= newLast; code++) {
        const origIdx  = code - font.first;
        const g        = (origIdx >= 0 && origIdx < font.glyphs.length) ? font.glyphs[origIdx] : null;
        const byteOff  = Math.floor(bitPos / 8);

        if (keepSet.has(code) && g && g.width > 0 && g.height > 0) {
            for (const bit of extractGlyphBits(font, origIdx)) {
                const bIdx = Math.floor(bitPos / 8);
                while (newBitmaps.length <= bIdx) newBitmaps.push(0);
                if (bit) newBitmaps[bIdx] |= (1 << (7 - (bitPos % 8)));
                bitPos++;
            }
            // Pad to byte boundary after each glyph — matches fontconvert.c behaviour
            // (bitmapOffset is a BYTE index, so every glyph must start on a byte boundary)
            if (bitPos % 8 !== 0) bitPos += (8 - (bitPos % 8));
            newGlyphs.push({ bitmapOffset: byteOff,
                width: g.width, height: g.height,
                xAdvance: g.xAdvance, xOffset: g.xOffset, yOffset: g.yOffset });
        } else {
            // Gap glyph: zero xAdvance so SpriteAnvil skips it in the charmap
            // and the GFX renderer on-device advances by 0 (character silently skipped).
            newGlyphs.push({ bitmapOffset: byteOff,
                width: 0, height: 0, xAdvance: 0, xOffset: 0, yOffset: 0 });
        }
    }
    if (newBitmaps.length === 0) newBitmaps.push(0);

    return { name: font.name, bitmaps: newBitmaps, glyphs: newGlyphs,
             first: newFirst, last: newLast, yAdvance: font.yAdvance,
             previewText: font.previewText, fgColor: font.fgColor };
}

// Serialises a font object to a valid GFXfont C header string.
function fontToHeader(font, subName) {
    const hex2 = n => '0x' + n.toString(16).toUpperCase().padStart(2, '0');
    const pad  = (n, w) => String(n).padStart(w);
    const lines = [
        '#pragma once',
        '#include <Adafruit_GFX.h>',
        '',
        `// Subset of ${font.name}  (${font.glyphs.length} glyphs, ` +
            `U+${font.first.toString(16).toUpperCase().padStart(2,'0')}` +
            `\u2013U+${font.last.toString(16).toUpperCase().padStart(2,'0')})`,
        '',
        `const uint8_t ${subName}Bitmaps[] PROGMEM = {`,
    ];
    for (let i = 0; i < font.bitmaps.length; i += 16)
        lines.push('    ' + font.bitmaps.slice(i, i + 16).map(hex2).join(', ') + ',');
    lines.push('};', '');

    lines.push(`const GFXglyph ${subName}Glyphs[] PROGMEM = {`);
    font.glyphs.forEach((g, i) => {
        const code = font.first + i;
        const ch   = (code >= 33 && code <= 126) ? String.fromCodePoint(code)
                                                  : `U+${code.toString(16).toUpperCase().padStart(4,'0')}`;
        const sep  = i < font.glyphs.length - 1 ? ',' : ' ';
        lines.push(`    { ${pad(g.bitmapOffset,5)}, ${pad(g.width,3)}, ${pad(g.height,3)}, ` +
                   `${pad(g.xAdvance,3)}, ${pad(g.xOffset,3)}, ${pad(g.yOffset,4)} }${sep} // ${ch}`);
    });
    lines.push('};', '');

    lines.push(`const GFXfont ${subName} PROGMEM = {`,
        `    (uint8_t  *)${subName}Bitmaps,`,
        `    (GFXglyph *)${subName}Glyphs,`,
        `    ${hex2(font.first)}, ${hex2(font.last)},`,
        `    ${font.yAdvance}`,
        '};');
    return lines.join('\n');
}

// Quick-set character groups for the subset UI.
const SUBSET_PRESETS = [
    { label: 'Digits',       chars: '0123456789'                  },
    { label: '+ colon',      chars: '0123456789:'                 },
    { label: '+ date',       chars: '0123456789:/.-'              },
    { label: 'Uppercase',    chars: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'  },
    { label: 'Lowercase',    chars: 'abcdefghijklmnopqrstuvwxyz'  },
    { label: 'Printable',    chars: Array.from({length: 95}, (_, i) => String.fromCodePoint(32 + i)).join('') },
    { label: 'Full font',    chars: null }, // special: keep all
];

function mkSubsetUI(font) {
    const det = document.createElement('details');
    det.className = 'font-subset-panel';
    const sum = document.createElement('summary');
    sum.textContent = 'Subset & Export .h';
    det.appendChild(sum);

    const body = document.createElement('div');
    body.className = 'font-subset-body';

    // --- preset buttons ---
    const presetRow = document.createElement('div');
    presetRow.className = 'font-subset-presets';
    SUBSET_PRESETS.forEach(p => {
        const btn = document.createElement('button');
        btn.className = 'subset-preset-btn';
        btn.textContent = p.label;
        btn.onclick = () => {
            charsInput.value = p.chars === null
                ? Array.from({length: font.last - font.first + 1},
                    (_, i) => String.fromCodePoint(font.first + i)).join('')
                : p.chars;
            updateCount();
        };
        presetRow.appendChild(btn);
    });
    body.appendChild(presetRow);

    // --- chars input ---
    const inputRow = document.createElement('div');
    inputRow.className = 'font-subset-input-row';
    const charsInput = document.createElement('input');
    charsInput.type = 'text';
    charsInput.className = 'font-subset-chars';
    charsInput.placeholder = 'Characters to keep, e.g. 0123456789:';
    charsInput.value = '0123456789';

    const countLabel = document.createElement('span');
    countLabel.className = 'font-subset-count';

    function updateCount() {
        const codes  = [...new Set([...charsInput.value].map(c => c.codePointAt(0)))]
                         .filter(c => c >= font.first && c <= font.last);
        const active = codes.filter(c => {
            const g = font.glyphs[c - font.first];
            return g && (g.width > 0 || g.xAdvance > 0);
        });
        countLabel.textContent = `${active.length} glyph${active.length !== 1 ? 's' : ''} selected`;
        countLabel.style.color = active.length > 0 ? '#7df' : '#f77';
    }
    charsInput.addEventListener('input', updateCount);
    updateCount();

    inputRow.appendChild(charsInput);
    inputRow.appendChild(countLabel);
    body.appendChild(inputRow);

    // --- name + download ---
    const dlRow = document.createElement('div');
    dlRow.className = 'font-subset-dl-row';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'font-subset-name';
    nameInput.value = font.name + '_sub';
    nameInput.placeholder = 'C identifier name';

    const dlBtn = document.createElement('button');
    dlBtn.className = 'subset-dl-btn';
    dlBtn.textContent = '⬇ Download .h';
    dlBtn.onclick = () => {
        const codes = [...new Set([...charsInput.value].map(c => c.codePointAt(0)))];
        const sub   = subsetFont(font, codes);
        if (!sub) { alert('No matching glyphs — nothing to export.'); return; }
        const subName = (nameInput.value.trim() || font.name + '_sub').replace(/\W/g, '_');
        const content = fontToHeader(sub, subName);
        const blob = new Blob([content], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = subName + '.h';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    };

    dlRow.appendChild(nameInput);
    dlRow.appendChild(dlBtn);
    body.appendChild(dlRow);

    det.appendChild(body);
    return det;
}

// ─── Drag & Drop + file browse ────────────────────────────────────────────────
const dz = document.getElementById('dropzone');
dz.ondragover  = e => { e.preventDefault(); dz.classList.add('hover'); };
dz.ondragleave = () => dz.classList.remove('hover');
dz.ondrop = e => {
    e.preventDefault(); dz.classList.remove('hover');
    collectDroppedFiles(e.dataTransfer.items).then(handleFiles);
};
dz.onclick = () => document.getElementById('fileInput').click();

document.getElementById('fileInput').addEventListener('change', e => {
    handleFiles([...e.target.files]);
    e.target.value = '';
});

// Recursively collect all .h files from a DataTransferItemList.
// Handles plain files, multiple files, and folder drops (via webkitGetAsEntry).
async function collectDroppedFiles(items) {
    const files = [];

    async function readDirEntries(reader) {
        const all = [];
        let batch;
        do {
            batch = await new Promise(res => reader.readEntries(res));
            all.push(...batch);
        } while (batch.length > 0);
        return all;
    }

    async function readEntry(entry) {
        if (entry.isFile) {
            if (entry.name.endsWith('.h') || entry.name.endsWith('.c')) {
                const file = await new Promise(res => entry.file(res));
                files.push(file);
            }
        } else if (entry.isDirectory) {
            const entries = await readDirEntries(entry.createReader());
            for (const child of entries) await readEntry(child);
        }
    }

    for (const item of items) {
        const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
        if (entry) {
            await readEntry(entry);
        } else if (item.kind === 'file') {
            const f = item.getAsFile();
            if (f && (f.name.endsWith('.h') || f.name.endsWith('.c'))) files.push(f);
        }
    }
    return files;
}

async function handleFiles(files) {
    files = files.filter(f => f.name.endsWith('.h') || f.name.endsWith('.c'));
    if (!files.length) return;

    // On Sprites tab: prompt to add or replace sprites. On Fonts tab: always merge silently.
    let mergeSprites = currentTab === 'fonts';
    if (!mergeSprites && sprites.length > 0) {
        mergeSprites = confirm(
            `${sprites.length} sprite(s) already loaded.\n\n` +
            `OK     → Add ${files.length} file(s)\n` +
            `Cancel → Replace everything`
        );
    }

    for (let i = 0; i < files.length; i++) {
        const code = await files[i].text();
        if (i === 0) document.getElementById('code').value = code;
        parseCode(code, files[i].name, i === 0 ? mergeSprites : true);
    }

    // Auto-switch to the tab that received content if the current tab ended up empty
    if (currentTab === 'sprites' && sprites.length === 0 && fonts.length > 0)
        switchTab('fonts');
    else if (currentTab === 'fonts' && fonts.length === 0 && sprites.length > 0)
        switchTab('sprites');
}

// ─── Export ───────────────────────────────────────────────────────────────────
async function exportZip() {
    if (!sprites.length) { alert('No sprites loaded.'); return; }
    const zip = new JSZip();

    // Include original source files unchanged
    sourceFiles.forEach(sf => zip.file(sf.name, sf.content));

    const exported = new Set();
    for (const s of sprites) {
        const key = s.isFrame ? s.baseName : s.name;
        if (exported.has(key)) continue;
        exported.add(key);

        let h = '#pragma once\n\n';
        if (s.isFrame) {
            const frames = sprites.filter(x => x.baseName === key);
            const fp = frames[0].width * frames[0].height;
            h += `const ${frames[0].origType} ${key}[][${fp}] PROGMEM = {\n`;
            frames.forEach((f, i) => {
                h += `    { // frame ${i} (${f.width}x${f.height})\n        `;
                h += fmtValues(f.data, 8);
                h += `\n    }${i < frames.length - 1 ? ',' : ''}\n`;
            });
            h += `};\n`;
        } else {
            const decl = s.useProgmem
                ? `const ${s.origType} ${s.name}[] PROGMEM`
                : `const ${s.origType} ${s.name}[${s.data.length}]`;
            h += `${decl} = {\n    ${fmtValues(s.data, 16)}\n};\n`;
        }
        // SIZE companion (original decl if available, else generate one)
        const sd = s.origSizeDecl || `const byte ${key}_size[2] = {${s.width}, ${s.height}};`;
        h += `\n${sd}\n`;

        zip.file(`sprites/${key.toLowerCase()}.h`, h);

        // PNG at current zoom (no grid)
        const canvas = s.isFrame
            ? drawStrip(sprites.filter(x => x.baseName === key), getZoom(), false)
            : drawSprite(s, getZoom(), false);
        const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
        zip.file(`sprites/${key.toLowerCase()}.png`, blob);
    }

    // Root assets.h
    let main = '#pragma once\n\n';
    if (sourceFiles.length) {
        main += '// Original source files\n';
        sourceFiles.forEach(sf => { main += `#include "${sf.name}"\n`; });
    } else {
        main += '// Split sprite headers\n';
        exported.forEach(k => { main += `#include "sprites/${k.toLowerCase()}.h"\n`; });
    }
    zip.file('assets.h', main);

    const out = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(out);
    a.download = 'assets.zip';
    a.click();
}

function fmtValues(data, perLine) {
    const vals = data.map(v =>
        v === 0xFEFE ? '0xFEFE' : '0x' + v.toString(16).toUpperCase().padStart(4, '0'));
    const chunks = [];
    for (let i = 0; i < vals.length; i += perLine) chunks.push(vals.slice(i, i + perLine).join(', '));
    return chunks.join(',\n    ');
}

// Export a single sprite as a C header file (RGB565 array)
function exportSpriteHeader(sprite) {
    const name = sprite.name.replace(/\W/g, '_');
    const w = sprite.width, h = sprite.height;
    const arrName = name;
    let lines = [];
    lines.push(`#pragma once`);
    lines.push(`// Sprite: ${sprite.name} (${w}x${h})`);
    lines.push(`// Format: RGB565, ${w}x${h}`);
    lines.push("");
    lines.push(`const uint16_t ${arrName}[${w * h}] = {`);
    for (let y = 0; y < h; y++) {
        let row = '    ';
        for (let x = 0; x < w; x++) {
            const v = sprite.data[y * w + x];
            row += `0x${(v === 0xFEFE || v === undefined ? 0 : v).toString(16).toUpperCase().padStart(4, '0')}`;
            if (x < w * 1 - 1 || y < h - 1) row += ', ';
        }
        lines.push(row);
    }
    lines.push('};');
    // Always include a size array if width/height are known
    if (w && h) {
        lines.push(`const byte ${arrName}_size[2] = {${w}, ${h}};`);
    }
    lines.push('');
    const content = lines.join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${arrName}.h`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
