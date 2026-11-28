// Scratch paper for Problem Solving (Tablet mode).
// Notes never leave the device: strokes live in this browser's IndexedDB (last 50 problems),
// and on Chrome/Edge for PC the user can also have a PNG of each page written to a folder they pick.
(() => {
  const KEEP = 50;
  const HL = ['rgba(224,178,90,.38)', 'rgba(143,211,168,.38)', 'rgba(141,179,219,.38)', 'rgba(231,154,154,.38)'];
  const INK = ['white', 'inkblue-400', 'rust-400', 'green-400'];
  const canFolder = typeof window.showDirectoryPicker === 'function';
  const ls = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } };

  let root, cv, ctx, board, built = false, visible = false;
  let cardId = null, page = { strokes: [], redo: [] }, cur = null;
  let tool = 'pen', size = 4, color = 0, penOnly = ls('bayaw-pen-only') === '1';
  let dir = null, dirOk = false, saveTimer = null, clearArmed = null;

  // ---------- IndexedDB ----------
  let dbp = null;
  const openDb = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('bayaw-notes', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('pages'); r.result.createObjectStore('meta'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const run = async (store, mode, fn) => {
    const d = await openDb();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = () => rej(t.error);
    });
  };

  // ---------- drawing ----------
  const inkColors = () => {
    const cs = getComputedStyle(document.documentElement);
    return INK.map(n => `rgb(${cs.getPropertyValue(`--c-${n}`).trim()})`);
  };
  const W = () => board.clientWidth || 1;

  function fit() {
    if (!visible) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(board.clientWidth * dpr);
    cv.height = Math.round(board.clientHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  }

  // Points are stored relative to the paper width, so notes still fit on a smaller or bigger screen
  function drawStroke(c, s, w, inks) {
    if (!s.pts.length) return;
    c.save();
    c.globalCompositeOperation = s.tool === 'eraser' ? 'destination-out' : 'source-over';
    c.strokeStyle = c.fillStyle = s.tool === 'hl' ? HL[s.color] : s.tool === 'eraser' ? '#000' : inks[s.color];
    c.lineCap = c.lineJoin = 'round';
    const base = s.tool === 'hl' ? s.size * 4 : s.tool === 'eraser' ? s.size * 5 : s.size;
    const P = s.pts;
    if (P.length < 4) {
      c.beginPath(); c.arc(P[0] * w, P[1] * w, base / 2, 0, 7); c.fill();
    } else if (s.tool === 'hl') { // one path so overlaps don't darken
      c.lineWidth = base; c.beginPath(); c.moveTo(P[0] * w, P[1] * w);
      for (let i = 3; i < P.length; i += 3) c.lineTo(P[i] * w, P[i + 1] * w);
      c.stroke();
    } else {
      for (let i = 3; i < P.length; i += 3) {
        c.lineWidth = base * (0.5 + P[i + 2]);
        c.beginPath(); c.moveTo(P[i - 3] * w, P[i - 2] * w); c.lineTo(P[i] * w, P[i + 1] * w); c.stroke();
      }
    }
    c.restore();
  }

  function redraw() {
    if (!ctx) return;
    const w = W(), inks = inkColors();
    ctx.clearRect(0, 0, cv.width, cv.height);
    page.strokes.forEach(s => drawStroke(ctx, s, w, inks));
    if (cur) drawStroke(ctx, cur, w, inks);
    const has = page.strokes.length > 0;
    root.querySelector('.notes-hint').style.opacity = has || cur ? 0 : 1;
    root.querySelector('[data-act="undo"]').disabled = !has;
    root.querySelector('[data-act="redo"]').disabled = !page.redo.length;
    root.querySelector('[data-act="clear"]').disabled = !has;
    root.querySelector('[data-act="image"]').disabled = !has;
  }

  function addPoint(e) {
    const r = cv.getBoundingClientRect(), w = W();
    const round = (n) => Math.round(n * 1e4) / 1e4;
    cur.pts.push(round((e.clientX - r.left) / w), round((e.clientY - r.top) / w), e.pointerType === 'pen' ? round(e.pressure || 0.5) : 0.5);
  }

  // ---------- saving ----------
  function scheduleSave() {
    clearTimeout(saveTimer);
    const id = cardId, snap = { strokes: page.strokes.slice(), updated: Date.now() };
    saveTimer = setTimeout(() => save(id, snap), 500);
  }
  async function save(id, snap) {
    saveTimer = null;
    if (!id) return;
    try {
      if (snap.strokes.length) await run('pages', 'readwrite', s => s.put(snap, id));
      else await run('pages', 'readwrite', s => s.delete(id));
      prune();
    } catch (e) { setStatus('Could not save notes on this device.'); }
    if (dirOk && snap.strokes.length && id === cardId) writeToFolder(id).catch(() => { dirOk = false; setStatus(); });
  }
  async function prune() {
    const keys = await run('pages', 'readonly', s => s.getAllKeys());
    if (keys.length <= KEEP) return;
    const vals = await run('pages', 'readonly', s => s.getAll());
    const old = keys.map((k, i) => [k, vals[i].updated || 0]).sort((a, b) => a[1] - b[1]).slice(0, keys.length - KEEP);
    await run('pages', 'readwrite', s => { old.forEach(([k]) => s.delete(k)); return null; });
  }
  function flush() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    save(cardId, { strokes: page.strokes.slice(), updated: Date.now() });
  }

  // The page as a picture: paper, grid, problem number, notes
  function snapshot() {
    const w = W(), h = board.clientHeight, scale = 2;
    const out = document.createElement('canvas');
    out.width = w * scale; out.height = h * scale;
    const c = out.getContext('2d');
    c.scale(scale, scale);
    const cs = getComputedStyle(document.documentElement);
    c.fillStyle = `rgb(${cs.getPropertyValue('--c-surface').trim()})`; c.fillRect(0, 0, w, h);
    c.strokeStyle = 'rgba(46,125,82,.12)'; c.lineWidth = 1;
    for (let x = 24; x < w; x += 24) { c.beginPath(); c.moveTo(x + .5, 0); c.lineTo(x + .5, h); c.stroke(); }
    for (let y = 24; y < h; y += 24) { c.beginPath(); c.moveTo(0, y + .5); c.lineTo(w, y + .5); c.stroke(); }
    const layer = document.createElement('canvas'); // eraser must only cut the ink, not the paper
    layer.width = out.width; layer.height = out.height;
    const lc = layer.getContext('2d'); lc.scale(scale, scale);
    const inks = inkColors();
    page.strokes.forEach(s => drawStroke(lc, s, w, inks));
    c.drawImage(layer, 0, 0, w, h);
    c.fillStyle = `rgb(${cs.getPropertyValue('--c-ink-400').trim()})`;
    c.font = '500 11px "IBM Plex Mono", monospace';
    c.fillText(`PROJECT BAYAW · PROBLEM ${cardId}`, 12, h - 12);
    return new Promise(res => out.toBlob(res, 'image/png'));
  }
  const fileName = (id) => `bayaw-notes-${String(id).replace(/[^\w-]+/g, '_')}.png`;

  async function saveImage() {
    if (!page.strokes.length) return;
    const blob = await snapshot();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName(cardId);
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  // ---------- folder (Chrome/Edge on PC) ----------
  async function restoreFolder() {
    if (!canFolder) return;
    try {
      dir = (await run('meta', 'readonly', s => s.get('dir'))) || null;
      dirOk = !!dir && (await dir.queryPermission({ mode: 'readwrite' })) === 'granted';
    } catch (e) { dir = null; dirOk = false; }
    setStatus();
  }
  async function folderAction() {
    if (dir && !dirOk) { // the browser forgets the permission after a restart: one tap to reconnect
      try { dirOk = (await dir.requestPermission({ mode: 'readwrite' })) === 'granted'; } catch (e) { dirOk = false; }
    } else if (dir) {
      dir = null; dirOk = false;
      await run('meta', 'readwrite', s => s.delete('dir'));
    } else {
      try { dir = await window.showDirectoryPicker({ id: 'bayaw-notes', mode: 'readwrite' }); } catch (e) { return; }
      dirOk = true;
      await run('meta', 'readwrite', s => s.put(dir, 'dir'));
    }
    setStatus();
    if (dirOk && page.strokes.length) writeToFolder(cardId).catch(() => {});
  }
  async function writeToFolder(id) {
    const blob = await snapshot();
    const fh = await dir.getFileHandle(fileName(id), { create: true });
    const wr = await fh.createWritable();
    await wr.write(blob); await wr.close();
  }

  function setStatus(msg) {
    if (!built) return;
    const st = root.querySelector('.notes-status'), fb = root.querySelector('[data-act="folder"]');
    st.textContent = msg || (dir ? (dirOk ? `Saved on this device, plus an image in your "${dir.name}" folder` : `Your "${dir.name}" folder needs permission again`) : 'Saved on this device only');
    if (fb) fb.textContent = dir ? (dirOk ? 'Stop folder' : 'Reconnect folder') : 'Save to a folder';
  }

  // ---------- UI ----------
  function setTool(t) {
    tool = t;
    root.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
    paintSwatches();
  }
  function paintSwatches() {
    const cols = tool === 'hl' ? HL : inkColors();
    root.querySelectorAll('[data-color]').forEach((b, i) => { b.style.background = cols[i]; b.classList.toggle('on', i === color && tool !== 'eraser'); });
  }
  const icon = (id) => `<svg class="ic" aria-hidden="true"><use href="#i-${id}"/></svg>`;

  function build() {
    root = document.getElementById('study-notes');
    root.innerHTML = `
      <div class="notes-bar" role="toolbar" aria-label="Pen tools">
        <button class="notes-tool on" data-tool="pen" aria-label="Pen" title="Pen">${icon('pen')}</button>
        <button class="notes-tool" data-tool="hl" aria-label="Highlighter" title="Highlighter">${icon('highlighter')}</button>
        <button class="notes-tool" data-tool="eraser" aria-label="Eraser" title="Eraser">${icon('eraser')}</button>
        <span class="notes-sep"></span>
        ${[0, 1, 2, 3].map(i => `<button class="notes-swatch" data-color="${i}" aria-label="Color ${i + 1}"></button>`).join('')}
        <span class="notes-sep"></span>
        ${[[2, 4], [4, 7], [8, 11]].map(([s, d]) => `<button class="notes-size ${s === size ? 'on' : ''}" data-size="${s}" aria-label="Size ${s}"><i style="width:${d}px;height:${d}px"></i></button>`).join('')}
        <span class="notes-sep"></span>
        <button class="notes-tool" data-act="undo" aria-label="Undo" title="Undo (Ctrl+Z)">${icon('undo')}</button>
        <button class="notes-tool" data-act="redo" aria-label="Redo" title="Redo (Ctrl+Y)">${icon('redo')}</button>
        <button class="notes-tool" data-act="clear" aria-label="Clear page" title="Clear page">${icon('trash')}</button>
        <button class="notes-penonly" data-act="penonly" aria-pressed="${penOnly}" title="Ignore your palm and fingers, only the stylus writes"><span class="notes-switch"></span>Pen only</button>
      </div>
      <div class="notes-board">
        <canvas></canvas>
        <div class="notes-hint"><div>${icon('pen')}<div>Your scratch paper for this problem.<br>Write with a stylus, finger or mouse.</div></div></div>
      </div>
      <div class="notes-foot">
        <span class="notes-status">Saved on this device only</span>
        <span class="flex flex-wrap gap-2">
          ${canFolder ? `<button class="notes-btn" data-act="folder">Save to a folder</button>` : ''}
          <button class="notes-btn" data-act="image">${icon('download')} Save as image</button>
        </span>
      </div>`;
    board = root.querySelector('.notes-board');
    cv = board.querySelector('canvas');
    ctx = cv.getContext('2d');

    root.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.tool) setTool(b.dataset.tool);
      else if (b.dataset.color) { color = +b.dataset.color; if (tool === 'eraser') setTool('pen'); else paintSwatches(); }
      else if (b.dataset.size) { size = +b.dataset.size; root.querySelectorAll('[data-size]').forEach(x => x.classList.toggle('on', x === b)); }
      else if (b.dataset.act === 'undo') undo();
      else if (b.dataset.act === 'redo') redo();
      else if (b.dataset.act === 'clear') clearPage(b);
      else if (b.dataset.act === 'penonly') { penOnly = !penOnly; ls('bayaw-pen-only', penOnly ? '1' : '0'); b.setAttribute('aria-pressed', penOnly); }
      else if (b.dataset.act === 'image') saveImage();
      else if (b.dataset.act === 'folder') folderAction();
    });

    cv.addEventListener('pointerdown', (e) => {
      if (penOnly && e.pointerType === 'touch') return;
      if (Math.abs(cv.width - board.clientWidth * (window.devicePixelRatio || 1)) > 2) fit();
      if (e.pointerType === 'pen' && e.button === 5) setTool('eraser'); // the stylus's eraser end
      cv.setPointerCapture(e.pointerId);
      cur = { tool, size, color, pts: [] };
      addPoint(e);
      redraw();
    });
    cv.addEventListener('pointermove', (e) => {
      if (!cur) return;
      const evs = e.getCoalescedEvents?.();
      (evs && evs.length ? evs : [e]).forEach(addPoint);
      redraw();
    });
    const end = () => {
      if (!cur) return;
      page.strokes.push(cur); page.redo = []; cur = null;
      redraw(); scheduleSave();
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);

    document.addEventListener('keydown', (e) => {
      if (!visible || !(e.ctrlKey || e.metaKey) || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      const k = e.key.toLowerCase();
      if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if (k === 'y') { e.preventDefault(); redo(); }
    });
    new ResizeObserver(fit).observe(board);
    new MutationObserver(() => { paintSwatches(); redraw(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    built = true;
    paintSwatches();
    restoreFolder();
    // Ask the browser not to clean up the notes on its own (no pop-up on most browsers)
    if (!ls('bayaw-notes-persist') && navigator.storage?.persist) { navigator.storage.persist().catch(() => {}); ls('bayaw-notes-persist', '1'); }
  }

  function undo() { if (page.strokes.length) { page.redo.push(page.strokes.pop()); redraw(); scheduleSave(); } }
  function redo() { if (page.redo.length) { page.strokes.push(page.redo.pop()); redraw(); scheduleSave(); } }
  function clearPage(btn) {
    if (!page.strokes.length) return;
    if (clearArmed) { // second tap clears; no browser pop-up
      clearTimeout(clearArmed); clearArmed = null; btn.classList.remove('armed');
      page.redo = page.strokes.slice().reverse(); page.strokes = [];
      redraw(); scheduleSave();
      return;
    }
    btn.classList.add('armed'); btn.title = 'Tap again to clear this page';
    clearArmed = setTimeout(() => { clearArmed = null; btn.classList.remove('armed'); btn.title = 'Clear page'; }, 2500);
  }

  async function open(id) {
    if (!built) build();
    visible = true;
    root.classList.remove('hidden');
    if (id === cardId) { fit(); return; }
    flush();
    cardId = id;
    page = { strokes: [], redo: [] };
    fit();
    try {
      const saved = await run('pages', 'readonly', s => s.get(id));
      if (cardId === id && saved) { page = { strokes: saved.strokes || [], redo: [] }; redraw(); }
    } catch (e) { setStatus('Notes cannot be saved in this browser window.'); }
  }
  function close() {
    if (!built) return;
    flush();
    visible = false;
    root.classList.add('hidden');
  }

  window.bayawNotes = { open, close };
})();
