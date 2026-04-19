const TRANSPARENT = 0xFEFE;
const MAX_HISTORY = 40;

const state = {
    width: 16,
    height: 16,
    pixels: new Array(16 * 16).fill(TRANSPARENT),
    tool: 'pen',
    zoom: 18,
    showGrid: true,
    showCoords: false,
    color565: 0xF800,
    useTransparentPaint: false,
    isDrawing: false,
    history: [],
    historyIndex: -1,
    generatedHeader: ''
};

const el = {
    spriteWidth: document.getElementById('sprite-width'),
    spriteHeight: document.getElementById('sprite-height'),
    loadWidth: document.getElementById('load-width'),
    loadHeight: document.getElementById('load-height'),
    loadValues: document.getElementById('load-values'),
    toolButtons: Array.from(document.querySelectorAll('#tool-palette .tool-btn')),
    zoom: document.getElementById('zoom'),
    showGrid: document.getElementById('show-grid'),
    colorPicker: document.getElementById('color-picker'),
    colorRgb565: document.getElementById('color-rgb565'),
    useTransparentPaint: document.getElementById('use-transparent-paint'),
    exportName: document.getElementById('export-name'),
    useTransparentToken: document.getElementById('use-transparent-token'),
    status: document.getElementById('status'),
    headerWrap: document.getElementById('header-wrap'),
    headerOutput: document.getElementById('header-output'),
    canvas: document.getElementById('editor-canvas'),
    btnNew: document.getElementById('btn-new'),
    btnLoad: document.getElementById('btn-load'),
    btnUndo: document.getElementById('btn-undo'),
    btnRedo: document.getElementById('btn-redo'),
    btnClear: document.getElementById('btn-clear'),
    btnSavePngZoom: document.getElementById('btn-save-png-zoom'),
    btnSavePng1x: document.getElementById('btn-save-png-1x'),
    btnGenerate: document.getElementById('btn-generate'),
    btnDownload: document.getElementById('btn-download'),
    btnCopy: document.getElementById('btn-copy'),
    showCoords: document.getElementById('show-coords'),
    coordTooltip: document.getElementById('coord-tooltip')
};

const ctx = el.canvas.getContext('2d');

function setStatus(msg) {
    el.status.textContent = msg;
}

function updateCanvasCursor() {
    el.canvas.classList.remove('tool-pen', 'tool-eraser', 'tool-bucket', 'tool-picker');
    el.canvas.classList.add(`tool-${state.tool}`);
}

function updateToolPalette() {
    el.toolButtons.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tool === state.tool);
    });
}

function updateTransparentPaintUI() {
    state.useTransparentPaint = el.useTransparentPaint.checked;
    el.colorPicker.disabled = state.useTransparentPaint;
    el.colorRgb565.disabled = state.useTransparentPaint;
}

function getActiveDrawColor() {
    return state.useTransparentPaint ? TRANSPARENT : state.color565;
}

function markHeaderDirty() {
    state.generatedHeader = '';
    el.headerOutput.value = '';
    el.headerWrap.classList.add('hidden');
}

function clampInt(v, min, max) {
    const n = Number.parseInt(v, 10);
    if (Number.isNaN(n)) return min;
    return Math.max(min, Math.min(max, n));
}

function sanitizeSpriteName(name) {
    const out = (name || '').trim().replaceAll(/\W+/g, '_').replace(/^_+/, '');
    return out || 'my_sprite';
}

function rgb565ToRgb(v) {
    const r = ((v >> 11) & 31) << 3;
    const g = ((v >> 5) & 63) << 2;
    const b = (v & 31) << 3;
    return { r, g, b };
}

function rgbTo565(r, g, b) {
    return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
}

function rgb565ToHex(v) {
    if (v === TRANSPARENT) return 'FEFE';
    return v.toString(16).toUpperCase().padStart(4, '0');
}

function rgb565ToPickerHex(v) {
    const c = rgb565ToRgb(v === TRANSPARENT ? 0 : v);
    const toHex = n => n.toString(16).padStart(2, '0');
    return `#${toHex(c.r)}${toHex(c.g)}${toHex(c.b)}`;
}

function parseRgb565Input(text) {
    const cleaned = (text || '').trim().replace(/^0x/i, '');
    if (!/^[0-9a-fA-F]{1,4}$/.test(cleaned)) return null;
    return Number.parseInt(cleaned, 16);
}

function syncPickerFrom565() {
    el.colorRgb565.value = rgb565ToHex(state.color565);
    el.colorPicker.value = rgb565ToPickerHex(state.color565);
}

function sync565FromPicker(hex) {
    const m = /^#([0-9a-fA-F]{6})$/.exec(hex || '');
    if (!m) return;
    const raw = m[1];
    const r = Number.parseInt(raw.slice(0, 2), 16);
    const g = Number.parseInt(raw.slice(2, 4), 16);
    const b = Number.parseInt(raw.slice(4, 6), 16);
    state.color565 = rgbTo565(r, g, b);
    el.colorRgb565.value = rgb565ToHex(state.color565);
}

// ─── Rulers ──────────────────────────────────────────────────────────────

const RULER_W = 20;
const RULER_H = 16;

function rulerStep(z) {
    for (const n of [1, 2, 4, 5, 8, 10, 16, 20, 32, 64]) {
        if (n * z >= 24) return n;
    }
    return 64;
}

function drawRulerAxisX(ctx, count, z, step) {
    ctx.canvas.width  = count * z;
    ctx.canvas.height = RULER_H;
    ctx.fillStyle = '#0c1220';
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

function drawRulerAxisY(ctx, count, z, step) {
    ctx.canvas.width  = RULER_W;
    ctx.canvas.height = count * z;
    ctx.fillStyle = '#0c1220';
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
    const step = rulerStep(state.zoom);
    drawRulerAxisX(rx.getContext('2d'), state.width,  state.zoom, step);
    drawRulerAxisY(ry.getContext('2d'), state.height, state.zoom, step);
}

function resizeCanvas() {
    el.canvas.width = state.width * state.zoom;
    el.canvas.height = state.height * state.zoom;
}

function drawCheckerboard() {
    const size = Math.max(8, state.zoom);
    for (let y = 0; y < el.canvas.height; y += size) {
        for (let x = 0; x < el.canvas.width; x += size) {
            ctx.fillStyle = ((Math.floor(x / size) + Math.floor(y / size)) % 2 === 0) ? '#555' : '#888';
            ctx.fillRect(x, y, size, size);
        }
    }
}

function drawPixels() {
    for (let y = 0; y < state.height; y++) {
        for (let x = 0; x < state.width; x++) {
            const idx = y * state.width + x;
            const v = state.pixels[idx];
            if (v === TRANSPARENT) continue;
            const c = rgb565ToRgb(v);
            ctx.fillStyle = `rgb(${c.r}, ${c.g}, ${c.b})`;
            ctx.fillRect(x * state.zoom, y * state.zoom, state.zoom, state.zoom);
        }
    }
}

function drawGrid() {
    if (!state.showGrid || state.zoom < 6) return;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = 1;

    for (let x = 0; x <= state.width; x++) {
        const gx = x * state.zoom + 0.5;
        ctx.beginPath();
        ctx.moveTo(gx, 0);
        ctx.lineTo(gx, el.canvas.height);
        ctx.stroke();
    }

    for (let y = 0; y <= state.height; y++) {
        const gy = y * state.zoom + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, gy);
        ctx.lineTo(el.canvas.width, gy);
        ctx.stroke();
    }
}

function render() {
    resizeCanvas();
    drawCheckerboard();
    drawPixels();
    drawGrid();
    drawRulers();
}

function pushHistorySnapshot() {
    const snapshot = {
        width: state.width,
        height: state.height,
        pixels: state.pixels.slice()
    };

    state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push(snapshot);
    if (state.history.length > MAX_HISTORY) {
        state.history.shift();
    }
    state.historyIndex = state.history.length - 1;
}

function restoreSnapshot(snapshot) {
    state.width = snapshot.width;
    state.height = snapshot.height;
    state.pixels = snapshot.pixels.slice();
    el.spriteWidth.value = state.width;
    el.spriteHeight.value = state.height;
    el.loadWidth.value = state.width;
    el.loadHeight.value = state.height;
    markHeaderDirty();
    render();
}

function undo() {
    if (state.historyIndex <= 0) {
        setStatus('Nothing to undo.');
        return;
    }
    state.historyIndex -= 1;
    restoreSnapshot(state.history[state.historyIndex]);
    setStatus('Undo complete.');
}

function redo() {
    if (state.historyIndex >= state.history.length - 1) {
        setStatus('Nothing to redo.');
        return;
    }
    state.historyIndex += 1;
    restoreSnapshot(state.history[state.historyIndex]);
    setStatus('Redo complete.');
}

function createBlankSprite() {
    const w = clampInt(el.spriteWidth.value, 1, 256);
    const h = clampInt(el.spriteHeight.value, 1, 256);
    state.width = w;
    state.height = h;
    state.pixels = new Array(w * h).fill(TRANSPARENT);
    el.loadWidth.value = w;
    el.loadHeight.value = h;
    markHeaderDirty();
    pushHistorySnapshot();
    render();
    setStatus(`Created ${w}x${h} blank sprite.`);
}

function parseTokenValue(token, constants = {}) {
    const t = (token || '').trim();
    if (!t) return 0;
    if (t === 'TRANSPARENT') return TRANSPARENT;
    if (constants[t] !== undefined) return constants[t];
    if (/^0[xX]/.test(t)) {
        const n = Number.parseInt(t, 16);
        return Number.isNaN(n) ? 0 : (n & 0xFFFF);
    }
    if (/^-?\d+$/.test(t)) {
        const n = Number.parseInt(t, 10);
        return Number.isNaN(n) ? 0 : (n & 0xFFFF);
    }
    return 0;
}

function parseConstants(source) {
    const constants = { TRANSPARENT };
    for (const m of source.matchAll(/const\s+(?:unsigned\s+short|uint16_t)\s+(\w+)\s*=\s*(0x[0-9A-Za-z]+|\d+)/g)) {
        constants[m[1]] = parseTokenValue(m[2], constants);
    }
    for (const m of source.matchAll(/#define\s+(\w+)\s+(0x[0-9A-Za-z]+|\d+)/g)) {
        constants[m[1]] = parseTokenValue(m[2], constants);
    }
    return constants;
}

function parseValuesList(text, constants = {}) {
    const cleaned = (text || '')
        .replaceAll(/\/\*[\s\S]*?\*\//g, '')
        .replaceAll(/\/\/.*$/gm, '');
    return cleaned
        .split(',')
        .map(token => token.trim())
        .filter(Boolean)
        .map(token => parseTokenValue(token, constants));
}

function parseSpriteSource(text = '') {
    const source = text;
    const constants = parseConstants(source);
    const arrMatch = /const\s+(?:unsigned\s+short|uint16_t)\s+(\w+)\s*\[[^\]]*\][^=]*=\s*\{([\s\S]*?)\};/m.exec(source);
    if (!arrMatch) return null;

    const name = arrMatch[1];
    const values = parseValuesList(arrMatch[2], constants);

    let width = null;
    let height = null;

    const sizeRe = new RegExp(String.raw`const\s+byte\s+${name}_size\s*\[\s*\d+\s*\]\s*=\s*\{\s*(\d+)\s*,\s*(\d+)\s*\}`, 'i');
    const sizeMatch = sizeRe.exec(source);
    if (sizeMatch) {
        width = Number.parseInt(sizeMatch[1], 10);
        height = Number.parseInt(sizeMatch[2], 10);
    }

    if (width === null || height === null) {
        const defW = new RegExp(String.raw`#define\s+${name}_width\s+(\d+)`, 'i').exec(source);
        const defH = new RegExp(String.raw`#define\s+${name}_height\s+(\d+)`, 'i').exec(source);
        if (defW && defH) {
            width = Number.parseInt(defW[1], 10);
            height = Number.parseInt(defH[1], 10);
        }
    }

    return { name, values, width, height };
}

function loadFromValues() {
    const source = el.loadValues.value;
    const parsedSource = parseSpriteSource(source);

    let w = clampInt(el.loadWidth.value, 1, 256);
    let h = clampInt(el.loadHeight.value, 1, 256);
    let vals;

    if (parsedSource) {
        if (parsedSource.width && parsedSource.height) {
            w = clampInt(parsedSource.width, 1, 256);
            h = clampInt(parsedSource.height, 1, 256);
            el.loadWidth.value = w;
            el.loadHeight.value = h;
        }
        if (parsedSource.name) {
            el.exportName.value = sanitizeSpriteName(parsedSource.name);
        }
        vals = parsedSource.values;
    } else {
        vals = parseValuesList(source, { TRANSPARENT });
    }

    const expected = w * h;

    const originalCount = vals.length;
    if (vals.length < expected) {
        vals = vals.concat(new Array(expected - vals.length).fill(TRANSPARENT));
        setStatus(`Loaded with padding: expected ${expected}, got ${originalCount}; padded missing pixels as transparent.`);
    } else if (vals.length > expected) {
        vals = vals.slice(0, expected);
        setStatus(`Loaded with trim: expected ${expected}, got ${originalCount}; trimmed extras.`);
    }

    state.width = w;
    state.height = h;
    state.pixels = vals.map(v => {
        if (!Number.isFinite(v)) return TRANSPARENT;
        if (v < 0) return TRANSPARENT;
        if (v > 0xFFFF) return v & 0xFFFF;
        return v;
    });

    el.spriteWidth.value = w;
    el.spriteHeight.value = h;
    markHeaderDirty();
    pushHistorySnapshot();
    render();
    if (vals.length === expected) {
        setStatus(`Loaded ${expected} pixels into ${w}x${h} canvas.`);
    }
}

function tryLoadInjectedSprite() {
    const key = 'spriteanvil.editorPayload';
    const raw = localStorage.getItem(key);
    if (!raw) return false;

    try {
        const payload = JSON.parse(raw);
        if (!payload || !Array.isArray(payload.data)) return false;
        const w = clampInt(payload.width, 1, 256);
        const h = clampInt(payload.height, 1, 256);
        const expected = w * h;
        let vals = payload.data.slice(0, expected).map(v => {
            if (!Number.isFinite(v)) return TRANSPARENT;
            if (v < 0) return TRANSPARENT;
            return v & 0xFFFF;
        });
        if (vals.length < expected) vals = vals.concat(new Array(expected - vals.length).fill(TRANSPARENT));

        state.width = w;
        state.height = h;
        state.pixels = vals;
        state.history = [];
        state.historyIndex = -1;

        el.spriteWidth.value = w;
        el.spriteHeight.value = h;
        el.loadWidth.value = w;
        el.loadHeight.value = h;
        if (payload.name) el.exportName.value = sanitizeSpriteName(payload.name);

        markHeaderDirty();
        pushHistorySnapshot();
        render();
        setStatus(`Loaded ${payload.name || 'sprite'} from main view into editor.`);
        localStorage.removeItem(key);
        return true;
    } catch (err) {
        console.error('Failed to load sprite payload', err);
        localStorage.removeItem(key);
        return false;
    }
}

function pointToPixel(clientX, clientY) {
    const rect = el.canvas.getBoundingClientRect();
    const px = Math.floor((clientX - rect.left) / state.zoom);
    const py = Math.floor((clientY - rect.top) / state.zoom);
    if (px < 0 || py < 0 || px >= state.width || py >= state.height) return null;
    return { x: px, y: py };
}

function pixelIndex(x, y) {
    return y * state.width + x;
}

function paintPixel(x, y, value) {
    state.pixels[pixelIndex(x, y)] = value;
}

function floodFill(startX, startY, replacement) {
    const startIdx = pixelIndex(startX, startY);
    const target = state.pixels[startIdx];
    if (target === replacement) return;

    const queue = [[startX, startY]];
    while (queue.length) {
        const [x, y] = queue.pop();
        if (x < 0 || x >= state.width || y < 0 || y >= state.height) continue;
        const idx = pixelIndex(x, y);
        if (state.pixels[idx] !== target) continue;
        state.pixels[idx] = replacement;
        queue.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
}

function applyToolAt(x, y) {
    if (state.tool === 'pen') {
        paintPixel(x, y, getActiveDrawColor());
    } else if (state.tool === 'eraser') {
        paintPixel(x, y, TRANSPARENT);
    } else if (state.tool === 'bucket') {
        floodFill(x, y, getActiveDrawColor());
    } else if (state.tool === 'picker') {
        const picked = state.pixels[pixelIndex(x, y)];
        state.color565 = picked;
        el.useTransparentPaint.checked = picked === TRANSPARENT;
        updateTransparentPaintUI();
        syncPickerFrom565();
        setStatus(`Picked color 0x${rgb565ToHex(state.color565)} from (${x}, ${y}).`);
    }
}

function onCanvasDown(e) {
    const p = pointToPixel(e.clientX, e.clientY);
    if (!p) return;

    if (state.tool === 'picker') {
        applyToolAt(p.x, p.y);
        return;
    }

    pushHistorySnapshot();
    applyToolAt(p.x, p.y);
    markHeaderDirty();
    render();

    if (state.tool === 'bucket') {
        setStatus(`Bucket fill at (${p.x}, ${p.y}).`);
        return;
    }

    state.isDrawing = true;
}

function onCanvasMove(e) {
    if (state.showCoords) {
        const p = pointToPixel(e.clientX, e.clientY);
        if (p) {
            el.coordTooltip.textContent = `${p.x}, ${p.y}`;
            el.coordTooltip.style.display = 'block';
            el.coordTooltip.style.left = `${e.clientX + 14}px`;
            el.coordTooltip.style.top  = `${e.clientY + 8}px`;
        } else {
            el.coordTooltip.style.display = 'none';
        }
    }
    if (!state.isDrawing || state.tool === 'bucket') return;
    const p = pointToPixel(e.clientX, e.clientY);
    if (!p) return;
    applyToolAt(p.x, p.y);
    render();
}

function onCanvasUp() {
    if (!state.isDrawing) return;
    state.isDrawing = false;
    markHeaderDirty();
    setStatus('Stroke applied.');
}

function clearToTransparent() {
    pushHistorySnapshot();
    state.pixels = new Array(state.width * state.height).fill(TRANSPARENT);
    markHeaderDirty();
    render();
    setStatus('Canvas cleared to transparent.');
}

function fmtValues(data, perLine, useTransparentToken) {
    const vals = data.map(v => {
        if (v === TRANSPARENT) {
            return useTransparentToken ? 'TRANSPARENT' : '0xFEFE';
        }
        return '0x' + v.toString(16).toUpperCase().padStart(4, '0');
    });
    const chunks = [];
    for (let i = 0; i < vals.length; i += perLine) chunks.push(vals.slice(i, i + perLine).join(', '));
    return chunks.join(',\n    ');
}

function generateHeaderText() {
    const name = sanitizeSpriteName(el.exportName.value);
    const useTransparentToken = el.useTransparentToken.checked && state.pixels.includes(TRANSPARENT);
    const values = fmtValues(state.pixels, 16, useTransparentToken);

    const transparentBlock = useTransparentToken
        ? ['const unsigned short TRANSPARENT = 0xFEFE;', '']
        : [];

    const lines = [
        '#pragma once',
        '',
        ...transparentBlock,
        `const uint16_t ${name}[${state.width * state.height}] = {`,
        `    ${values}`,
        '};',
        `const byte ${name}_size[2] = {${state.width}, ${state.height}};`,
        ''
    ];

    return lines.join('\n');
}

function generateHeader() {
    state.generatedHeader = generateHeaderText();
    el.headerWrap.classList.remove('hidden');
    el.headerOutput.value = state.generatedHeader;
    setStatus('Header generated.');
}

function drawSpriteCanvas(z) {
    const canvas = document.createElement('canvas');
    canvas.width = state.width * z;
    canvas.height = state.height * z;
    const c = canvas.getContext('2d');

    const size = Math.max(6, Math.floor(z / 2));
    for (let y = 0; y < canvas.height; y += size) {
        for (let x = 0; x < canvas.width; x += size) {
            c.fillStyle = ((Math.floor(x / size) + Math.floor(y / size)) % 2 === 0) ? '#4a4a4a' : '#737373';
            c.fillRect(x, y, size, size);
        }
    }

    for (let y = 0; y < state.height; y++) {
        for (let x = 0; x < state.width; x++) {
            const v = state.pixels[y * state.width + x];
            if (v === TRANSPARENT) continue;
            const col = rgb565ToRgb(v);
            c.fillStyle = `rgb(${col.r}, ${col.g}, ${col.b})`;
            c.fillRect(x * z, y * z, z, z);
        }
    }

    return canvas;
}

function downloadCanvas(canvas, filename) {
    canvas.toBlob(blob => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }, 'image/png');
}

function savePngCurrentZoom() {
    const name = sanitizeSpriteName(el.exportName.value);
    const z = state.zoom;
    downloadCanvas(drawSpriteCanvas(z), `${name}_${z}x.png`);
    setStatus(`Saved PNG at ${z}x zoom.`);
}

function savePngNative() {
    const name = sanitizeSpriteName(el.exportName.value);
    downloadCanvas(drawSpriteCanvas(1), `${name}.png`);
    setStatus('Saved PNG at native size (1x).');
}

function downloadHeader() {
    if (!state.generatedHeader) generateHeader();
    const name = sanitizeSpriteName(el.exportName.value);
    const blob = new Blob([state.generatedHeader], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.h`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    setStatus(`Downloaded ${name}.h.`);
}

async function copyHeader() {
    if (!state.generatedHeader) generateHeader();
    try {
        await navigator.clipboard.writeText(state.generatedHeader);
        setStatus('Header copied to clipboard.');
    } catch (err) {
        console.error('Clipboard write failed', err);
        setStatus('Clipboard access failed. You can copy from the output box manually.');
    }
}

function bindEvents() {
    el.btnNew.addEventListener('click', createBlankSprite);
    el.btnLoad.addEventListener('click', loadFromValues);
    el.btnUndo.addEventListener('click', undo);
    el.btnRedo.addEventListener('click', redo);
    el.btnClear.addEventListener('click', clearToTransparent);
    el.btnSavePngZoom.addEventListener('click', savePngCurrentZoom);
    el.btnSavePng1x.addEventListener('click', savePngNative);
    el.btnGenerate.addEventListener('click', generateHeader);
    el.btnDownload.addEventListener('click', downloadHeader);
    el.btnCopy.addEventListener('click', copyHeader);

    el.toolButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            state.tool = btn.dataset.tool;
            updateToolPalette();
            updateCanvasCursor();
            setStatus(`Tool set to ${state.tool}.`);
        });
    });

    el.exportName.addEventListener('input', markHeaderDirty);
    el.useTransparentToken.addEventListener('change', markHeaderDirty);

    el.zoom.addEventListener('input', () => {
        state.zoom = clampInt(el.zoom.value, 6, 40);
        render();
    });

    el.showGrid.addEventListener('change', () => {
        state.showGrid = el.showGrid.checked;
        render();
    });

    el.showCoords.addEventListener('change', () => {
        state.showCoords = el.showCoords.checked;
        if (!state.showCoords) el.coordTooltip.style.display = 'none';
    });

    el.useTransparentPaint.addEventListener('change', () => {
        updateTransparentPaintUI();
        setStatus(state.useTransparentPaint
            ? 'Transparent paint enabled.'
            : `Color set to 0x${rgb565ToHex(state.color565)}.`);
    });

    el.colorPicker.addEventListener('input', () => {
        sync565FromPicker(el.colorPicker.value);
        el.useTransparentPaint.checked = false;
        updateTransparentPaintUI();
        setStatus(`Color set to 0x${rgb565ToHex(state.color565)}.`);
    });

    el.colorRgb565.addEventListener('change', () => {
        const parsed = parseRgb565Input(el.colorRgb565.value);
        if (parsed === null) {
            setStatus('Invalid RGB565 hex. Enter 1 to 4 hex digits.');
            syncPickerFrom565();
            return;
        }
        state.color565 = parsed & 0xFFFF;
        el.useTransparentPaint.checked = state.color565 === TRANSPARENT;
        updateTransparentPaintUI();
        syncPickerFrom565();
        setStatus(`Color set to 0x${rgb565ToHex(state.color565)}.`);
    });

    el.canvas.addEventListener('mousedown', onCanvasDown);
    el.canvas.addEventListener('mousemove', onCanvasMove);
    globalThis.addEventListener('mouseup', onCanvasUp);
    el.canvas.addEventListener('mouseleave', () => {
        onCanvasUp();
        el.coordTooltip.style.display = 'none';
    });
}

function init() {
    bindEvents();
    syncPickerFrom565();
    updateTransparentPaintUI();
    updateToolPalette();
    updateCanvasCursor();
    markHeaderDirty();
    if (!tryLoadInjectedSprite()) {
        pushHistorySnapshot();
        render();
        setStatus('Ready. Choose a tool, draw, save PNG, then generate/export your header.');
    }
}

init();
