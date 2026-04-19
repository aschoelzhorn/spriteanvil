// ─── State ────────────────────────────────────────────────────────────────────
let canvasW = 64;
let canvasH = 64;
let zoom = 6;
let showGrid = false;
let showCoords = false;
let canvasBgMode = 'checker';  // 'checker' | 'color'
let canvasBgColor = '#000000';
let librarySprites = [];  // { name, width, height, data[] }
let layers = [];
let nextLayerId = 1;
let selectedLayerId = null;
let dragState = null;      // canvas drag-to-reposition state
let dragLibIdx = null;     // library item being HTML-dragged

// ─── Color helpers ─────────────────────────────────────────────────────────────

function rgb565ToRgb(v) {
    if (v === 0xFEFE) return null; // transparent
    return {
        r: ((v >> 11) & 0x1F) << 3,
        g: ((v >>  5) & 0x3F) << 2,
        b:  (v        & 0x1F) << 3
    };
}

// ─── Parser ────────────────────────────────────────────────────────────────────
// Ported and simplified from app.js — sprite arrays only, no fonts/validation UI.

function extractBracedContent(str, openPos) {
    let depth = 0;
    for (let i = openPos; i < str.length; i++) {
        if (str[i] === '{') depth++;
        else if (str[i] === '}' && --depth === 0) return str.slice(openPos + 1, i);
    }
    return null;
}

function parseValues(raw, constants) {
    return raw.split(',').map(v => v.trim()).filter(Boolean).map(v => {
        if (v === 'TRANSPARENT') return 0xFEFE;
        if (constants[v] !== undefined) return constants[v];
        if (/^0[xX]/.test(v)) return Number.parseInt(v, 16);
        if (/^\d+$/.test(v)) return Number.parseInt(v, 10);
        return 0;
    });
}

function convertArgb(data) {
    // Piskel ABGR32 → RGB565, alpha=0 → transparent marker
    return data.map(v => {
        if (typeof v !== 'number' || v <= 0xFFFF) return v;
        const a = (v >>> 24) & 0xFF;
        const b = (v >>> 16) & 0xFF;
        const g = (v >>>  8) & 0xFF;
        const r =  v         & 0xFF;
        if (a === 0) return 0xFEFE;
        return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
    });
}

/**
 * Build a size resolver that maps sprite names to {w, h} via #define macros.
 */
function buildDefineResolver(defW, defH) {
    return function resolveDefines(name, singleFallback = false) {
        const n = name.toLowerCase();
        if (defW[n] !== undefined && defH[n] !== undefined) return { w: defW[n], h: defH[n] };
        const parts = n.split('_');
        for (let i = parts.length - 1; i > 0; i--) {
            const p = parts.slice(0, i).join('_');
            if (defW[p] !== undefined && defH[p] !== undefined) return { w: defW[p], h: defH[p] };
        }
        for (let i = parts.length - 1; i > 0; i--) {
            const p = parts.slice(0, i).join('_');
            const hits = Object.keys(defW).filter(k => k.startsWith(p) && defH[k] !== undefined);
            if (hits.length > 0) {
                hits.sort((a, b) => b.length - a.length);
                return { w: defW[hits[0]], h: defH[hits[0]] };
            }
        }
        if (singleFallback) {
            const keys = Object.keys(defW).filter(k => defH[k] !== undefined);
            if (keys.length === 1) return { w: defW[keys[0]], h: defH[keys[0]] };
        }
        return null;
    };
}

function parse2DFrameArrays(code, constants, sizes, resolveDefines) {
    const sprites = [];
    const handled = new Set();
    const re = /const\s+(unsigned\s+short|uint16_t|uint32_t)\s+(\w+)\s*\[\s*\d*\s*\]\s*\[(\d+)\][^;=]*=\s*\{/g;
    let m;
    while ((m = re.exec(code)) !== null) {
        const origType = m[1], name = m[2], framePixels = +m[3];
        const body = extractBracedContent(code, m.index + m[0].length - 1);
        if (!body) continue;
        const se = sizes[name.toLowerCase()] || resolveDefines(name);
        const fw = se ? se.w : Math.round(Math.sqrt(framePixels));
        const fh = se ? se.h : Math.round(framePixels / Math.max(1, fw));
        [...body.matchAll(/\{([^}]*)\}/g)].forEach((fm, i) => {
            let data = parseValues(fm[1].replaceAll(/\/\/.*$/gm, ''), constants);
            if (origType === 'uint32_t') data = convertArgb(data);
            sprites.push({ name: `${name}_frame${i}`, width: fw, height: fh, data });
        });
        handled.add(name);
    }
    return { sprites, handled };
}

function parse1DArrays(code, constants, sizes, resolveDefines, handled2D) {
    const result = [];
    const re = /const\s+((unsigned\s+short)|(uint16_t)|(uint32_t))\s+(\w+)\s*\[[\s\d]*\]([^=[]*)=\s*\{([\s\S]*?)\}/g;
    for (const m of code.matchAll(re)) {
        let origType = 'uint32_t';
        if (m[2]) origType = 'unsigned short';
        else if (m[3]) origType = 'uint16_t';
        const name = m[5];
        if (/^.+_size$/i.test(name) || handled2D.has(name)) continue;
        const raw = m[7].replaceAll(/\/\/.*$/gm, '');
        let data = parseValues(raw, constants);
        if (origType === 'uint32_t') data = convertArgb(data);
        if (!data.length) continue;
        const se = sizes[name.toLowerCase()] || resolveDefines(name);
        const w = se ? se.w : Math.round(Math.sqrt(data.length));
        const h = se ? se.h : Math.round(data.length / Math.max(1, w));
        result.push({ name, width: w, height: h, data });
    }
    return result;
}

function parseMonoBytes(raw) {
    return raw.split(',').map(v => {
        v = v.trim();
        if (!v) return null;
        if (/^0[xX]/.test(v)) return Number.parseInt(v, 16);
        if (/^\d+$/.test(v)) return Number.parseInt(v, 10);
        return null;
    }).filter(v => v !== null);
}

function unpackMonoBitmap(name, bytes, { w, h }) {
    const bytesPerRow = Math.ceil(w / 8);
    const data = [];
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const b = bytes[y * bytesPerRow + Math.floor(x / 8)] ?? 0;
            data.push(((b >> (x % 8)) & 1) ? 0xFFFF : 0xFEFE);
        }
    return { name, width: w, height: h, data };
}

function parseMonoBitmaps(code, sizes, resolveDefines) {
    const result = [];
    for (const m of code.matchAll(
        /const\s+unsigned\s+char\s+(\w+)\s*\[\s*\d*\s*\][^;=]*=\s*\{([\s\S]*?)\}/g
    )) {
        const name = m[1];
        if (/^.+_size$/i.test(name)) continue;
        const bytes = parseMonoBytes(m[2].replaceAll(/\/\/.*$/gm, ''));
        if (!bytes.length) continue;
        const sd = sizes[name.toLowerCase()] || resolveDefines(name, true);
        if (!sd) continue;
        result.push(unpackMonoBitmap(name, bytes, sd));
    }
    return result;
}

/**
 * Parse C header code and return an array of sprite objects.
 * Multi-frame 2-D arrays are split into individual "NAME_frameN" entries.
 * @param {string} code
 * @returns {{ name: string, width: number, height: number, data: number[] }[]}
 */
function parseSpritesFromCode(code) {
    const constants = {};
    const sizes = {};

    for (const m of code.matchAll(
        /const\s+(?:unsigned\s+short|uint16_t)\s+(\w+)\s*=\s*(0x[0-9A-Fa-f]+|\d+)/g
    )) constants[m[1]] = Number.parseInt(m[2], 16);

    for (const m of code.matchAll(
        /const\s+byte\s+(\w+)_size\s*\[\d+\]\s*=\s*\{(\d+)\s*,\s*(\d+)\}/gi
    )) sizes[m[1].toLowerCase()] = { w: +m[2], h: +m[3] };

    const defW = {}, defH = {};
    for (const m of code.matchAll(/#define\s+(\w+)_width\s+(\d+)/gi))  defW[m[1].toLowerCase()] = +m[2];
    for (const m of code.matchAll(/#define\s+(\w+)_height\s+(\d+)/gi)) defH[m[1].toLowerCase()] = +m[2];
    const resolveDefines = buildDefineResolver(defW, defH);

    const { sprites: frames, handled: handled2D } = parse2DFrameArrays(code, constants, sizes, resolveDefines);
    const singles = parse1DArrays(code, constants, sizes, resolveDefines, handled2D);
    const mono    = parseMonoBitmaps(code, sizes, resolveDefines);

    return [...frames, ...singles, ...mono];
}

// ─── Sprite thumbnail ──────────────────────────────────────────────────────────

const THUMB_MAX = 32;

function fillScaledPixel(buf, rowStride, py, px, scale, rgb, alpha) {
    for (let sy = 0; sy < scale; sy++)
        for (let sx = 0; sx < scale; sx++) {
            const i = ((py * scale + sy) * rowStride + (px * scale + sx)) * 4;
            buf[i] = rgb[0]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[2]; buf[i + 3] = alpha;
        }
}

function makeThumbnail(sprite, maxPx = THUMB_MAX) {
    const { width: w, height: h, data } = sprite;
    const scale = Math.max(1, Math.floor(maxPx / Math.max(w, h)));
    const canvas = document.createElement('canvas');
    canvas.width  = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w * scale, h * scale);
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const rgb = rgb565ToRgb(data[y * w + x]);
            // rowStride = w * scale (actual pixel width of the image buffer)
            fillScaledPixel(img.data, w * scale, y, x, scale,
                rgb ? [rgb.r, rgb.g, rgb.b] : [0, 0, 0], rgb ? 255 : 0);
        }
    ctx.putImageData(img, 0, 0);
    return canvas;
}

// ─── Library panel ─────────────────────────────────────────────────────────────

function renderLibrary() {
    const container = document.getElementById('lib-sprites');
    container.innerHTML = '';
    if (!librarySprites.length) {
        container.innerHTML = '<div class="empty-hint">No sprites loaded yet</div>';
        return;
    }
    librarySprites.forEach((sprite, idx) => {
        const item = document.createElement('div');
        item.className = 'lib-item';
        item.draggable = true;
        item.dataset.idx = idx;

        const thumb = makeThumbnail(sprite);
        item.appendChild(thumb);

        const info = document.createElement('div');
        info.className = 'lib-item-info';

        const nameEl = document.createElement('div');
        nameEl.className = 'lib-item-name';
        nameEl.textContent = sprite.name;

        const dimEl = document.createElement('div');
        dimEl.className = 'lib-item-dim';
        dimEl.textContent = `${sprite.width}\u00d7${sprite.height}`;

        info.appendChild(nameEl);
        info.appendChild(dimEl);
        item.appendChild(info);

        item.addEventListener('dragstart', e => {
            dragLibIdx = idx;
            e.dataTransfer.effectAllowed = 'copy';
            e.dataTransfer.setData('text/plain', String(idx));
        });
        item.addEventListener('dragend', () => { dragLibIdx = null; });

        container.appendChild(item);
    });
}

// ─── Composition canvas ────────────────────────────────────────────────────────

function getMainCanvas() { return document.getElementById('composer-canvas'); }

/**
 * Draw a single sprite layer onto ctx at its (x,y) position at the given zoom.
 * Transparent pixels (0xFEFE) are skipped so lower layers show through.
 */
function drawLayerOnCtx(ctx, layer, z) {
    const { sprite, x: ox, y: oy } = layer;
    const { width: w, height: h, data } = sprite;
    // Use an offscreen canvas so transparent pixels don't erase the layer below
    const off = document.createElement('canvas');
    off.width  = w * z;
    off.height = h * z;
    const offCtx = off.getContext('2d');
    const img = offCtx.createImageData(w * z, h * z);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const rgb = rgb565ToRgb(data[y * w + x]);
            if (!rgb) continue; // transparent — leave alpha=0
            for (let sy = 0; sy < z; sy++)
                for (let sx = 0; sx < z; sx++) {
                    const pi = ((y * z + sy) * w * z + (x * z + sx)) * 4;
                    img.data[pi]     = rgb.r;
                    img.data[pi + 1] = rgb.g;
                    img.data[pi + 2] = rgb.b;
                    img.data[pi + 3] = 255;
                }
        }
    }
    offCtx.putImageData(img, 0, 0);
    // drawImage composites correctly, respecting alpha
    ctx.drawImage(off, ox * z, oy * z);
}

// ─── Rulers ───────────────────────────────────────────────────────────────────

const RULER_W = 20; // Y ruler width (left side, px)
const RULER_H = 16; // X ruler height (top side, px)

function rulerStep(z) {
    for (const n of [1, 2, 4, 5, 8, 10, 16, 20, 32, 64]) {
        if (n * z >= 24) return n;
    }
    return 64;
}

function drawRulerX(ctx, count, z, step) {
    ctx.canvas.width  = count * z;
    ctx.canvas.height = RULER_H;
    ctx.fillStyle = '#12121e';
    ctx.fillRect(0, 0, ctx.canvas.width, RULER_H);
    ctx.lineWidth = 1;
    ctx.font = '8px monospace';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    for (let i = 0; i <= count; i++) {
        const px = i * z;
        const isMajor = i % step === 0;
        if (!isMajor && z < 4) continue;
        ctx.strokeStyle = isMajor ? '#446688' : '#202840';
        ctx.beginPath();
        ctx.moveTo(px + 0.5, RULER_H - (isMajor ? 5 : 2));
        ctx.lineTo(px + 0.5, RULER_H);
        ctx.stroke();
        if (isMajor && i < count) {
            ctx.fillStyle = '#7799bb';
            ctx.fillText(String(i), px + 2, 1);
        }
    }
}

function drawRulerY(ctx, count, z, step) {
    ctx.canvas.width  = RULER_W;
    ctx.canvas.height = count * z;
    ctx.fillStyle = '#12121e';
    ctx.fillRect(0, 0, RULER_W, ctx.canvas.height);
    ctx.lineWidth = 1;
    ctx.font = '8px monospace';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'right';
    for (let i = 0; i <= count; i++) {
        const py = i * z;
        const isMajor = i % step === 0;
        if (!isMajor && z < 4) continue;
        ctx.strokeStyle = isMajor ? '#446688' : '#202840';
        ctx.beginPath();
        ctx.moveTo(RULER_W - (isMajor ? 5 : 2), py + 0.5);
        ctx.lineTo(RULER_W, py + 0.5);
        ctx.stroke();
        if (isMajor && i < count) {
            ctx.fillStyle = '#7799bb';
            ctx.fillText(String(i), RULER_W - 7, py + 1);
        }
    }
}

function drawRulers() {
    const rx = document.getElementById('ruler-x');
    const ry = document.getElementById('ruler-y');
    const step = rulerStep(zoom);
    drawRulerX(rx.getContext('2d'), canvasW, zoom, step);
    drawRulerY(ry.getContext('2d'), canvasH, zoom, step);
}

function drawComposerCheckerboard(ctx, w, h, z) {
    for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
            ctx.fillStyle = ((px + py) % 2 === 0) ? '#555' : '#888';
            ctx.fillRect(px * z, py * z, z, z);
        }
    }
}

function renderComposition() {
    const canvas = getMainCanvas();
    canvas.width  = canvasW * zoom;
    canvas.height = canvasH * zoom;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    // Canvas background
    if (canvasBgMode === 'checker') {
        drawComposerCheckerboard(ctx, canvasW, canvasH, zoom);
    } else {
        ctx.fillStyle = canvasBgColor;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // Layers bottom-to-top
    for (const layer of layers) drawLayerOnCtx(ctx, layer, zoom);

    // Selection highlight
    if (selectedLayerId !== null) {
        const layer = layers.find(l => l.id === selectedLayerId);
        if (layer) {
            ctx.strokeStyle = '#4a9eff';
            ctx.lineWidth = 1;
            ctx.strokeRect(
                layer.x * zoom + 0.5,
                layer.y * zoom + 0.5,
                layer.sprite.width  * zoom,
                layer.sprite.height * zoom
            );
        }
    }

    // Grid overlay
    if (showGrid) {
        ctx.strokeStyle = 'rgba(255,255,255,0.1)';
        ctx.lineWidth = 0.5;
        for (let x = 0; x <= canvasW; x++) {
            ctx.beginPath(); ctx.moveTo(x * zoom, 0); ctx.lineTo(x * zoom, canvas.height); ctx.stroke();
        }
        for (let y = 0; y <= canvasH; y++) {
            ctx.beginPath(); ctx.moveTo(0, y * zoom); ctx.lineTo(canvas.width, y * zoom); ctx.stroke();
        }
    }
    drawRulers();
}

// ─── Layers panel ──────────────────────────────────────────────────────────────

function renderLayers() {
    const container = document.getElementById('layer-list');
    container.innerHTML = '';
    if (!layers.length) {
        container.innerHTML = '<div class="empty-hint">Drag sprites onto the canvas</div>';
        return;
    }
    // Reverse so top layer is listed first
    [...layers].reverse().forEach(layer => {
        const item = document.createElement('div');
        item.className = 'layer-item' + (layer.id === selectedLayerId ? ' selected' : '');
        item.dataset.id = layer.id;

        // ── Top row: thumbnail + name + delete ──
        const top = document.createElement('div');
        top.className = 'layer-item-top';

        const thumb = makeThumbnail(layer.sprite, 24);
        top.appendChild(thumb);

        const nameEl = document.createElement('div');
        nameEl.className = 'layer-item-name';
        nameEl.textContent = layer.sprite.name;
        top.appendChild(nameEl);

        const delBtn = document.createElement('button');
        delBtn.className = 'layer-delete-btn';
        delBtn.textContent = '\u2715';
        delBtn.title = 'Remove layer';
        delBtn.addEventListener('click', e => {
            e.stopPropagation();
            layers = layers.filter(l => l.id !== layer.id);
            if (selectedLayerId === layer.id) selectedLayerId = null;
            renderLayers();
            renderComposition();
        });
        top.appendChild(delBtn);
        item.appendChild(top);

        // ── XY row ──
        const xyRow = document.createElement('div');
        xyRow.className = 'layer-xy';

        const makeCoordInput = (axis, initVal, onChange) => {
            const label = document.createElement('label');
            label.textContent = axis + '\u00a0';
            const input = document.createElement('input');
            input.type = 'number';
            input.value = initVal;
            input.min = -512; input.max = 512;
            input.addEventListener('input', () => onChange(Number.parseInt(input.value) || 0));
            label.appendChild(input);
            return { label, input };
        };

        const xCtrl = makeCoordInput('X', layer.x, v => { layer.x = v; renderComposition(); });
        const yCtrl = makeCoordInput('Y', layer.y, v => { layer.y = v; renderComposition(); });
        xyRow.appendChild(xCtrl.label);
        xyRow.appendChild(yCtrl.label);

        // Store refs for live sync during canvas drag
        layer._xInput = xCtrl.input;
        layer._yInput = yCtrl.input;

        item.appendChild(xyRow);

        item.addEventListener('click', () => {
            selectedLayerId = layer.id;
            renderLayers();
            renderComposition();
        });

        container.appendChild(item);
    });
}

// ─── Canvas interaction ────────────────────────────────────────────────────────

function canvasPixelAt(canvas, e) {
    const rect = canvas.getBoundingClientRect();
    return {
        px: Math.floor((e.clientX - rect.left)  / zoom),
        py: Math.floor((e.clientY - rect.top)   / zoom)
    };
}

function topLayerAt(px, py) {
    for (let i = layers.length - 1; i >= 0; i--) {
        const l = layers[i];
        if (px >= l.x && px < l.x + l.sprite.width &&
            py >= l.y && py < l.y + l.sprite.height) return l;
    }
    return null;
}

function initCanvasInteraction() {
    const canvas = getMainCanvas();

    // ── Drag to reposition ──
    canvas.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        const { px, py } = canvasPixelAt(canvas, e);
        const hit = topLayerAt(px, py);
        if (hit) {
            selectedLayerId = hit.id;
            dragState = {
                layerId: hit.id,
                startMouseX: e.clientX,
                startMouseY: e.clientY,
                origX: hit.x,
                origY: hit.y
            };
            canvas.classList.add('dragging');
        } else {
            selectedLayerId = null;
        }
        renderLayers();
        renderComposition();
    });

    canvas.addEventListener('mousemove', e => {
        if (showCoords) {
            const { px, py } = canvasPixelAt(canvas, e);
            const tip = document.getElementById('coord-tooltip');
            if (px >= 0 && px < canvasW && py >= 0 && py < canvasH) {
                tip.textContent = `${px}, ${py}`;
                tip.style.display = 'block';
                tip.style.left = `${e.clientX + 14}px`;
                tip.style.top  = `${e.clientY + 8}px`;
            } else {
                tip.style.display = 'none';
            }
        }
        if (!dragState) return;
        const dxPx = Math.round((e.clientX - dragState.startMouseX) / zoom);
        const dyPx = Math.round((e.clientY - dragState.startMouseY) / zoom);
        const layer = layers.find(l => l.id === dragState.layerId);
        if (!layer) return;
        layer.x = dragState.origX + dxPx;
        layer.y = dragState.origY + dyPx;
        // Sync coordinate inputs without full layer re-render
        if (layer._xInput) layer._xInput.value = layer.x;
        if (layer._yInput) layer._yInput.value = layer.y;
        renderComposition();
    });

    const endDrag = () => {
        if (dragState) {
            dragState = null;
            canvas.classList.remove('dragging');
        }
        document.getElementById('coord-tooltip').style.display = 'none';
    };
    canvas.addEventListener('mouseup', endDrag);
    canvas.addEventListener('mouseleave', endDrag);

    // ── Drop from library ──
    canvas.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    });

    canvas.addEventListener('drop', e => {
        e.preventDefault();
        const idx = Number.parseInt(e.dataTransfer.getData('text/plain'));
        if (Number.isNaN(idx) || !librarySprites[idx]) return;
        const { px, py } = canvasPixelAt(canvas, e);
        const sprite = librarySprites[idx];
        // Center sprite on drop point, clamp to canvas bounds
        const x = Math.max(0, Math.min(canvasW - sprite.width,  px - Math.floor(sprite.width  / 2)));
        const y = Math.max(0, Math.min(canvasH - sprite.height, py - Math.floor(sprite.height / 2)));
        const layer = { id: nextLayerId++, sprite, x, y };
        layers.push(layer);
        selectedLayerId = layer.id;
        renderLayers();
        renderComposition();
    });
}

// ─── PNG export ────────────────────────────────────────────────────────────────

function compositeLayerAt1x(ctx, layer) {
    const { sprite, x: ox, y: oy } = layer;
    const { width: w, height: h, data } = sprite;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const cx = ox + x, cy = oy + y;
            if (cx < 0 || cx >= canvasW || cy < 0 || cy >= canvasH) continue;
            const v = data[y * w + x];
            if (v === 0xFEFE) continue;
            const rgb = rgb565ToRgb(v);
            if (!rgb) continue;
            ctx.fillStyle = `rgb(${rgb.r},${rgb.g},${rgb.b})`;
            ctx.fillRect(cx, cy, 1, 1);
        }
    }
}

function exportPng() {
    const useAlpha = document.getElementById('export-alpha').checked;
    const off = document.createElement('canvas');
    off.width  = canvasW;
    off.height = canvasH;
    const ctx = off.getContext('2d');
    // Export: transparent pixels become black in LED mode; use chosen solid color if set
    if (!useAlpha) {
        const bg = canvasBgMode === 'color' ? canvasBgColor : '#000000';
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, canvasW, canvasH);
    }
    for (const layer of layers) compositeLayerAt1x(ctx, layer);
    off.toBlob(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `composition_${canvasW}x${canvasH}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }, 'image/png');
}

// ─── Save layout (coordinates) ────────────────────────────────────────────────

function saveLayout() {
    const layout = {
        canvas: { width: canvasW, height: canvasH },
        layers: [...layers].reverse().map(l => ({
            sprite: l.sprite.name,
            x: l.x,
            y: l.y,
            width: l.sprite.width,
            height: l.sprite.height
        }))
    };
    const blob = new Blob([JSON.stringify(layout, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `layout_${canvasW}x${canvasH}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ─── File loading ──────────────────────────────────────────────────────────────

async function loadSingleFile(file) {
    const text = await file.text();
    const newSprites = parseSpritesFromCode(text);
    newSprites.forEach(ns => {
        const existing = librarySprites.findIndex(s => s.name === ns.name);
        if (existing >= 0) librarySprites[existing] = ns;
        else librarySprites.push(ns);
    });
}

function loadFiles(files) {
    const toRead = Array.from(files).filter(f => /\.[hc]$/i.test(f.name));
    if (!toRead.length) return;
    Promise.all(toRead.map(loadSingleFile)).then(() => renderLibrary());
}

// ─── Canvas size & zoom controls ──────────────────────────────────────────────

function applyCanvasSize() {
    canvasW = Math.max(1, Math.min(512, Number.parseInt(document.getElementById('canvas-w').value) || 64));
    canvasH = Math.max(1, Math.min(512, Number.parseInt(document.getElementById('canvas-h').value) || 64));
    document.getElementById('canvas-w').value = canvasW;
    document.getElementById('canvas-h').value = canvasH;
    renderComposition();
}

function setPreset(w, h) {
    canvasW = w; canvasH = h;
    document.getElementById('canvas-w').value = w;
    document.getElementById('canvas-h').value = h;
    renderComposition();
}

// ─── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    // Canvas size
    document.getElementById('canvas-w').addEventListener('change', applyCanvasSize);
    document.getElementById('canvas-h').addEventListener('change', applyCanvasSize);

    // Zoom slider
    const zoomSlider = document.getElementById('zoom-slider');
    const zoomVal    = document.getElementById('zoom-val');
    zoomSlider.addEventListener('input', () => {
        zoom = +zoomSlider.value;
        zoomVal.textContent = zoom;
        renderComposition();
    });

    // Grid toggle
    document.getElementById('grid-toggle').addEventListener('change', e => {
        showGrid = e.target.checked;
        renderComposition();
    });

    // Canvas background mode
    const bgModeEl  = document.getElementById('bg-mode');
    const bgColorEl = document.getElementById('bg-color');
    bgColorEl.style.display = canvasBgMode === 'color' ? '' : 'none';
    bgModeEl.addEventListener('change', e => {
        canvasBgMode = e.target.value;
        bgColorEl.style.display = canvasBgMode === 'color' ? '' : 'none';
        renderComposition();
    });
    bgColorEl.addEventListener('input', e => {
        canvasBgColor = e.target.value;
        renderComposition();
    });

    // Coords toggle
    document.getElementById('show-coords').addEventListener('change', e => {
        showCoords = e.target.checked;
        if (!showCoords) document.getElementById('coord-tooltip').style.display = 'none';
    });

    // Save layout
    document.getElementById('btn-save-layout').addEventListener('click', saveLayout);

    // Library dropzone
    const dropzone  = document.getElementById('lib-dropzone');
    const fileInput = document.getElementById('lib-file-input');
    const browseBtn = document.getElementById('lib-browse-btn');

    browseBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => { loadFiles(fileInput.files); fileInput.value = ''; });
    dropzone.addEventListener('dragover',  e => { e.preventDefault(); dropzone.classList.add('hover'); });
    dropzone.addEventListener('dragleave', ()  => dropzone.classList.remove('hover'));
    dropzone.addEventListener('drop', e => {
        e.preventDefault();
        dropzone.classList.remove('hover');
        loadFiles(e.dataTransfer.files);
    });

    // Canvas interaction
    initCanvasInteraction();

    // Export PNG
    document.getElementById('btn-export-png').addEventListener('click', exportPng);

    // Clear all layers
    document.getElementById('btn-clear').addEventListener('click', () => {
        if (layers.length === 0 || confirm('Remove all layers?')) {
            layers = [];
            selectedLayerId = null;
            renderLayers();
            renderComposition();
        }
    });

    // Initial render
    renderComposition();
    renderLibrary();
    renderLayers();
});
