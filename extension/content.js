/* Sinucada Aim Helper - content script
 * Draws a ghost-ball aim line over the game canvas.
 * Flow:
 *   1. Calibrate: user clicks the 4 table corners (TL, TR, BR, BL).
 *   2. Detect balls (optional) or manually click cue ball / target ball / pocket.
 *   3. Overlay draws ghost-ball, aim line and target->pocket trajectory.
 */

(function () {
  if (window.__sinucadaAimLoaded) return;
  window.__sinucadaAimLoaded = true;

  const STORAGE_KEY = 'sinucadaAimEnabled';
  const CALIB_KEY = 'sinucadaAimCalibration';

  const state = {
    enabled: false,
    gameCanvas: null,
    overlay: null,
    overlayCtx: null,
    panel: null,
    // Calibration (in game canvas pixel coords)
    corners: [], // [TL, TR, BR, BL]
    pockets: [], // derived: 4 corners + 2 side mids
    ballRadius: 16, // pixels in game canvas space
    // Selection
    mode: 'idle', // 'calibrate' | 'select-cue' | 'select-target' | 'select-pocket' | 'idle'
    cueBall: null,
    targetBall: null,
    targetPocket: null,
    detectedBalls: [],
    rafId: null,
  };

  /* ------------------------------------------------------------------ */
  /* Init / messaging                                                   */
  /* ------------------------------------------------------------------ */
  chrome.storage.local.get([STORAGE_KEY, CALIB_KEY], (res) => {
    if (res[CALIB_KEY]) {
      try {
        const c = res[CALIB_KEY];
        if (Array.isArray(c.corners)) state.corners = c.corners;
        if (Array.isArray(c.pockets)) state.pockets = c.pockets;
        if (typeof c.ballRadius === 'number') state.ballRadius = c.ballRadius;
      } catch (e) { /* ignore */ }
    }
    if (res[STORAGE_KEY]) {
      state.enabled = true;
      waitForCanvasAndStart();
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'toggle') {
      state.enabled = !!msg.enabled;
      if (state.enabled) waitForCanvasAndStart();
      else teardown();
      sendResponse({ ok: true });
    }
    return true;
  });

  function waitForCanvasAndStart(tries = 0) {
    const canvas = findGameCanvas();
    if (canvas) {
      state.gameCanvas = canvas;
      mountOverlay();
      mountPanel();
      startLoop();
      return;
    }
    if (tries > 40) {
      console.warn('[SinucadaAim] Canvas do jogo nao encontrado.');
      return;
    }
    setTimeout(() => waitForCanvasAndStart(tries + 1), 500);
  }

  function findGameCanvas() {
    const canvases = Array.from(document.querySelectorAll('canvas'));
    if (canvases.length === 0) return null;
    let best = null;
    let bestArea = 0;
    for (const c of canvases) {
      const r = c.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea && r.width > 200 && r.height > 150) {
        bestArea = area;
        best = c;
      }
    }
    return best;
  }

  function teardown() {
    stopLoop();
    if (state.overlay && state.overlay.parentNode) {
      state.overlay.parentNode.removeChild(state.overlay);
    }
    if (state.panel && state.panel.parentNode) {
      state.panel.parentNode.removeChild(state.panel);
    }
    state.overlay = null;
    state.overlayCtx = null;
    state.panel = null;
    state.gameCanvas = null;
  }

  /* ------------------------------------------------------------------ */
  /* Overlay canvas                                                     */
  /* ------------------------------------------------------------------ */
  function mountOverlay() {
    const overlay = document.createElement('canvas');
    overlay.id = 'sinucada-aim-overlay';
    document.body.appendChild(overlay);
    state.overlay = overlay;
    state.overlayCtx = overlay.getContext('2d');
    overlay.addEventListener('click', handleOverlayClick);
    window.addEventListener('resize', syncOverlay);
    window.addEventListener('scroll', syncOverlay, true);
    syncOverlay();
  }

  function syncOverlay() {
    if (!state.overlay || !state.gameCanvas) return;
    const rect = state.gameCanvas.getBoundingClientRect();
    const overlay = state.overlay;
    overlay.style.left = rect.left + 'px';
    overlay.style.top = rect.top + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
    // Backing store in device pixels
    const dpr = window.devicePixelRatio || 1;
    overlay.width = Math.max(1, Math.round(rect.width * dpr));
    overlay.height = Math.max(1, Math.round(rect.height * dpr));
    state.overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // Game canvas pixel <-> overlay CSS pixel conversion helpers
  function gameToCss(pt) {
    if (!state.gameCanvas) return pt;
    const rect = state.gameCanvas.getBoundingClientRect();
    const sx = rect.width / state.gameCanvas.width;
    const sy = rect.height / state.gameCanvas.height;
    return { x: pt.x * sx, y: pt.y * sy };
  }
  function cssToGame(cssX, cssY) {
    if (!state.gameCanvas) return { x: cssX, y: cssY };
    const rect = state.gameCanvas.getBoundingClientRect();
    const sx = state.gameCanvas.width / rect.width;
    const sy = state.gameCanvas.height / rect.height;
    return { x: cssX * sx, y: cssY * sy };
  }

  /* ------------------------------------------------------------------ */
  /* Control panel                                                      */
  /* ------------------------------------------------------------------ */
  function mountPanel() {
    const panel = document.createElement('div');
    panel.id = 'sinucada-aim-panel';
    panel.setAttribute('data-testid', 'aim-panel');
    panel.innerHTML = `
      <div class="sa-head" data-testid="panel-head">
        <div><span class="sa-dot"></span><strong>Aim Helper</strong></div>
        <button class="sa-collapse" data-testid="panel-collapse" title="Minimizar">_</button>
      </div>
      <div class="sa-body">
        <div class="sa-step" data-step="calibrate" data-testid="step-calibrate">
          <span class="sa-num">1</span>
          <span class="sa-label">Calibrar 4 cantos da mesa</span>
        </div>
        <div class="sa-step" data-step="cue" data-testid="step-cue">
          <span class="sa-num">2</span>
          <span class="sa-label">Clicar na bola branca</span>
        </div>
        <div class="sa-step" data-step="target" data-testid="step-target">
          <span class="sa-num">3</span>
          <span class="sa-label">Clicar na bola alvo</span>
        </div>
        <div class="sa-step" data-step="pocket" data-testid="step-pocket">
          <span class="sa-num">4</span>
          <span class="sa-label">Clicar na caçapa</span>
        </div>

        <div class="sa-radius">
          <span>Raio:</span>
          <input type="range" min="6" max="40" step="1" value="${state.ballRadius}" data-testid="radius-range" />
          <span data-testid="radius-val">${state.ballRadius}</span>
        </div>

        <div class="sa-actions">
          <button data-action="calibrate" data-testid="btn-calibrate">Calibrar</button>
          <button data-action="detect" data-testid="btn-detect">Detectar bolas</button>
          <button data-action="cue" data-testid="btn-pick-cue">Escolher branca</button>
          <button data-action="target" data-testid="btn-pick-target">Escolher alvo</button>
          <button data-action="pocket" data-testid="btn-pick-pocket">Escolher caçapa</button>
          <button data-action="clear" class="danger" data-testid="btn-clear">Limpar seleção</button>
          <button data-action="reset" class="danger wide" data-testid="btn-reset">Resetar tudo</button>
        </div>

        <div class="sa-hint" data-testid="hint">
          Clique em "Calibrar" e, em ordem, marque os cantos:
          superior-esquerdo, superior-direito, inferior-direito, inferior-esquerdo.
        </div>
      </div>
    `;
    document.body.appendChild(panel);
    state.panel = panel;

    // Drag
    const head = panel.querySelector('.sa-head');
    makeDraggable(panel, head);

    // Collapse
    panel.querySelector('.sa-collapse').addEventListener('click', (e) => {
      e.stopPropagation();
      panel.classList.toggle('collapsed');
    });

    // Actions
    panel.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleAction(btn.dataset.action);
      });
    });

    // Radius slider
    const slider = panel.querySelector('[data-testid="radius-range"]');
    const valSpan = panel.querySelector('[data-testid="radius-val"]');
    slider.addEventListener('input', () => {
      state.ballRadius = parseInt(slider.value, 10);
      valSpan.textContent = state.ballRadius;
      saveCalibration();
    });

    updateStepUI();
  }

  function makeDraggable(el, handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect();
      ox = r.left; oy = r.top;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      el.style.left = (ox + e.clientX - sx) + 'px';
      el.style.top = (oy + e.clientY - sy) + 'px';
      el.style.right = 'auto';
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  }

  function setHint(text) {
    if (!state.panel) return;
    state.panel.querySelector('[data-testid="hint"]').textContent = text;
  }

  function updateStepUI() {
    if (!state.panel) return;
    const steps = {
      calibrate: state.corners.length === 4,
      cue: !!state.cueBall,
      target: !!state.targetBall,
      pocket: !!state.targetPocket,
    };
    state.panel.querySelectorAll('.sa-step').forEach((s) => {
      const k = s.dataset.step;
      s.classList.toggle('done', !!steps[k]);
      s.classList.toggle('active', state.mode === activeStepForMode());
    });
    // Active highlight
    state.panel.querySelectorAll('.sa-step').forEach((s) => s.classList.remove('active'));
    const activeKey = activeStepForMode();
    if (activeKey) {
      const node = state.panel.querySelector(`.sa-step[data-step="${activeKey}"]`);
      if (node) node.classList.add('active');
    }
  }
  function activeStepForMode() {
    if (state.mode === 'calibrate') return 'calibrate';
    if (state.mode === 'select-cue') return 'cue';
    if (state.mode === 'select-target') return 'target';
    if (state.mode === 'select-pocket') return 'pocket';
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Actions                                                            */
  /* ------------------------------------------------------------------ */
  function handleAction(action) {
    switch (action) {
      case 'calibrate':
        state.mode = 'calibrate';
        state.corners = [];
        state.pockets = [];
        setHint('Clique nos 4 cantos da mesa na ordem: SUP-ESQ, SUP-DIR, INF-DIR, INF-ESQ.');
        enableInteractive(true);
        break;
      case 'cue':
        if (state.corners.length !== 4) return setHint('Calibre a mesa primeiro (4 cantos).');
        state.mode = 'select-cue';
        setHint('Clique sobre a BOLA BRANCA.');
        enableInteractive(true);
        break;
      case 'target':
        if (state.corners.length !== 4) return setHint('Calibre a mesa primeiro.');
        state.mode = 'select-target';
        setHint('Clique na BOLA ALVO que quer encaçapar.');
        enableInteractive(true);
        break;
      case 'pocket':
        if (state.corners.length !== 4) return setHint('Calibre a mesa primeiro.');
        state.mode = 'select-pocket';
        setHint('Clique na caçapa desejada (ou em qualquer ponto proximo a ela).');
        enableInteractive(true);
        break;
      case 'detect':
        if (state.corners.length !== 4) return setHint('Calibre a mesa antes de detectar bolas.');
        try {
          detectBalls();
          setHint(`Detectadas ${state.detectedBalls.length} bolas. Agora clique em "Escolher branca" / "alvo".`);
        } catch (e) {
          console.warn(e);
          setHint('Falha na detecção (canvas pode ter CORS). Use seleção manual.');
        }
        break;
      case 'clear':
        state.cueBall = null;
        state.targetBall = null;
        state.targetPocket = null;
        state.mode = 'idle';
        enableInteractive(false);
        setHint('Seleção limpa. Escolha bola branca, alvo e caçapa novamente.');
        break;
      case 'reset':
        state.corners = [];
        state.pockets = [];
        state.cueBall = null;
        state.targetBall = null;
        state.targetPocket = null;
        state.detectedBalls = [];
        state.mode = 'idle';
        enableInteractive(false);
        saveCalibration();
        setHint('Tudo resetado. Clique em "Calibrar" para comecar.');
        break;
    }
    updateStepUI();
  }

  function enableInteractive(on) {
    if (!state.overlay) return;
    state.overlay.classList.toggle('interactive', !!on);
  }

  /* ------------------------------------------------------------------ */
  /* Click handling                                                     */
  /* ------------------------------------------------------------------ */
  function handleOverlayClick(e) {
    if (!state.overlay) return;
    const rect = state.overlay.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    const pt = cssToGame(cssX, cssY);

    if (state.mode === 'calibrate') {
      state.corners.push(pt);
      if (state.corners.length === 4) {
        state.pockets = derivePockets(state.corners);
        state.mode = 'idle';
        enableInteractive(false);
        saveCalibration();
        setHint('Mesa calibrada! Agora clique em "Escolher branca".');
      } else {
        const labels = ['sup-dir', 'inf-dir', 'inf-esq'];
        setHint(`Canto ${state.corners.length}/4 marcado. Clique em ${labels[state.corners.length - 1]}.`);
      }
    } else if (state.mode === 'select-cue') {
      state.cueBall = snapToDetected(pt) || pt;
      state.mode = 'idle';
      enableInteractive(false);
      setHint('Bola branca selecionada. Agora clique em "Escolher alvo".');
    } else if (state.mode === 'select-target') {
      state.targetBall = snapToDetected(pt) || pt;
      state.mode = 'idle';
      enableInteractive(false);
      setHint('Bola alvo selecionada. Agora clique em "Escolher caçapa".');
    } else if (state.mode === 'select-pocket') {
      // Snap to nearest pocket
      let best = null, bestD = Infinity;
      for (const p of state.pockets) {
        const dx = p.x - pt.x, dy = p.y - pt.y;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = p; }
      }
      state.targetPocket = best || pt;
      state.mode = 'idle';
      enableInteractive(false);
      setHint('Mira pronta! Ghost ball desenhada. Use "Limpar" para nova jogada.');
    }
    updateStepUI();
  }

  function snapToDetected(pt) {
    if (!state.detectedBalls || state.detectedBalls.length === 0) return null;
    let best = null, bestD = Infinity;
    const maxD = (state.ballRadius * 2.5) ** 2;
    for (const b of state.detectedBalls) {
      const dx = b.x - pt.x, dy = b.y - pt.y;
      const d = dx * dx + dy * dy;
      if (d < bestD && d < maxD) { bestD = d; best = { x: b.x, y: b.y }; }
    }
    return best;
  }

  /* ------------------------------------------------------------------ */
  /* Pocket derivation                                                  */
  /* ------------------------------------------------------------------ */
  function derivePockets(corners) {
    const [tl, tr, br, bl] = corners;
    const topMid = { x: (tl.x + tr.x) / 2, y: (tl.y + tr.y) / 2 };
    const botMid = { x: (bl.x + br.x) / 2, y: (bl.y + br.y) / 2 };
    return [tl, tr, br, bl, topMid, botMid];
  }

  function saveCalibration() {
    chrome.storage.local.set({
      [CALIB_KEY]: {
        corners: state.corners,
        pockets: state.pockets,
        ballRadius: state.ballRadius,
      },
    });
  }

  /* ------------------------------------------------------------------ */
  /* Ball detection (simple color-blob inside table polygon)            */
  /* ------------------------------------------------------------------ */
  function detectBalls() {
    const src = state.gameCanvas;
    if (!src) throw new Error('no game canvas');

    const off = document.createElement('canvas');
    off.width = src.width;
    off.height = src.height;
    const octx = off.getContext('2d', { willReadFrequently: true });
    // drawImage on a webgl canvas requires preserveDrawingBuffer (patched in inject.js)
    octx.drawImage(src, 0, 0);
    const img = octx.getImageData(0, 0, off.width, off.height);
    const data = img.data;
    const W = img.width, H = img.height;

    // Bounding box of the table polygon
    const poly = state.corners;
    let minX = Math.max(0, Math.floor(Math.min(...poly.map((p) => p.x))));
    let maxX = Math.min(W - 1, Math.ceil(Math.max(...poly.map((p) => p.x))));
    let minY = Math.max(0, Math.floor(Math.min(...poly.map((p) => p.y))));
    let maxY = Math.min(H - 1, Math.ceil(Math.max(...poly.map((p) => p.y))));

    // Shrink a bit to avoid rails
    const shrink = Math.round(state.ballRadius * 0.6);
    minX += shrink; maxX -= shrink; minY += shrink; maxY -= shrink;

    // Sample felt color from center of table
    const cx = Math.round((minX + maxX) / 2);
    const cy = Math.round((minY + maxY) / 2);
    let fr = 0, fg = 0, fb = 0, fc = 0;
    for (let dy = -8; dy <= 8; dy += 2) {
      for (let dx = -8; dx <= 8; dx += 2) {
        const i = ((cy + dy) * W + (cx + dx)) * 4;
        fr += data[i]; fg += data[i + 1]; fb += data[i + 2]; fc++;
      }
    }
    fr /= fc; fg /= fc; fb /= fc;

    // Mask: 1 if NOT felt AND inside polygon, 0 otherwise
    const mask = new Uint8Array(W * H);
    const feltThresh = 55; // color distance threshold
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (!pointInPoly(x, y, poly)) continue;
        const i = (y * W + x) * 4;
        const dr = data[i] - fr, dg = data[i + 1] - fg, db = data[i + 2] - fb;
        const dist = Math.sqrt(dr * dr + dg * dg + db * db);
        if (dist > feltThresh) mask[y * W + x] = 1;
      }
    }

    // Connected components (BFS)
    const visited = new Uint8Array(W * H);
    const balls = [];
    const minArea = Math.PI * (state.ballRadius * 0.5) ** 2;
    const maxArea = Math.PI * (state.ballRadius * 1.7) ** 2;
    const qx = new Int32Array(W * H);
    const qy = new Int32Array(W * H);

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const idx = y * W + x;
        if (!mask[idx] || visited[idx]) continue;
        // BFS
        let head = 0, tail = 0;
        qx[tail] = x; qy[tail] = y; tail++;
        visited[idx] = 1;
        let sx2 = 0, sy2 = 0, area = 0, rSum = 0, gSum = 0, bSum = 0;
        let bbL = x, bbR = x, bbT = y, bbB = y;
        while (head < tail) {
          const cx2 = qx[head], cy2 = qy[head]; head++;
          area++;
          sx2 += cx2; sy2 += cy2;
          if (cx2 < bbL) bbL = cx2;
          if (cx2 > bbR) bbR = cx2;
          if (cy2 < bbT) bbT = cy2;
          if (cy2 > bbB) bbB = cy2;
          const pi = (cy2 * W + cx2) * 4;
          rSum += data[pi]; gSum += data[pi + 1]; bSum += data[pi + 2];
          // neighbours
          if (cx2 > minX) {
            const ni = cy2 * W + (cx2 - 1);
            if (mask[ni] && !visited[ni]) { visited[ni] = 1; qx[tail] = cx2 - 1; qy[tail] = cy2; tail++; }
          }
          if (cx2 < maxX) {
            const ni = cy2 * W + (cx2 + 1);
            if (mask[ni] && !visited[ni]) { visited[ni] = 1; qx[tail] = cx2 + 1; qy[tail] = cy2; tail++; }
          }
          if (cy2 > minY) {
            const ni = (cy2 - 1) * W + cx2;
            if (mask[ni] && !visited[ni]) { visited[ni] = 1; qx[tail] = cx2; qy[tail] = cy2 - 1; tail++; }
          }
          if (cy2 < maxY) {
            const ni = (cy2 + 1) * W + cx2;
            if (mask[ni] && !visited[ni]) { visited[ni] = 1; qx[tail] = cx2; qy[tail] = cy2 + 1; tail++; }
          }
        }
        if (area < minArea || area > maxArea) continue;
        const w = bbR - bbL, h = bbB - bbT;
        // must be roughly circular
        if (w === 0 || h === 0) continue;
        const aspect = Math.max(w / h, h / w);
        if (aspect > 1.8) continue;
        balls.push({
          x: sx2 / area,
          y: sy2 / area,
          r: Math.max(w, h) / 2,
          area,
          color: { r: rSum / area, g: gSum / area, b: bSum / area },
        });
      }
    }

    // Mark cue ball = whitest blob
    let whitest = null, whiteScore = -1;
    for (const b of balls) {
      const score = b.color.r + b.color.g + b.color.b - Math.abs(b.color.r - b.color.g) - Math.abs(b.color.g - b.color.b);
      if (score > whiteScore) { whiteScore = score; whitest = b; }
    }
    if (whitest) whitest.isCue = true;

    state.detectedBalls = balls;
  }

  function pointInPoly(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y;
      const xj = poly[j].x, yj = poly[j].y;
      const intersect =
        yi > y !== yj > y &&
        x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-9) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  /* ------------------------------------------------------------------ */
  /* Geometry: ghost ball                                               */
  /* ------------------------------------------------------------------ */
  function computeGhostBall(target, pocket, R) {
    const dx = pocket.x - target.x;
    const dy = pocket.y - target.y;
    const d = Math.hypot(dx, dy) || 1;
    return {
      x: target.x - (2 * R * dx) / d,
      y: target.y - (2 * R * dy) / d,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Render loop                                                        */
  /* ------------------------------------------------------------------ */
  function startLoop() {
    const step = () => {
      render();
      state.rafId = requestAnimationFrame(step);
    };
    state.rafId = requestAnimationFrame(step);
  }
  function stopLoop() {
    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }

  function render() {
    const ctx = state.overlayCtx;
    if (!ctx || !state.gameCanvas) return;
    syncOverlay();
    const overlay = state.overlay;
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    // Table polygon
    if (state.corners.length > 0) {
      ctx.save();
      ctx.strokeStyle = 'rgba(63,185,80,0.9)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      state.corners.forEach((p, i) => {
        const c = gameToCss(p);
        if (i === 0) ctx.moveTo(c.x, c.y); else ctx.lineTo(c.x, c.y);
      });
      if (state.corners.length === 4) ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
      // corner points
      state.corners.forEach((p, i) => {
        const c = gameToCss(p);
        ctx.fillStyle = '#3fb950';
        ctx.beginPath();
        ctx.arc(c.x, c.y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#0d1117';
        ctx.font = 'bold 10px system-ui';
        ctx.fillText(String(i + 1), c.x - 3, c.y + 3);
      });
      ctx.restore();
    }

    // Pockets
    if (state.pockets.length === 6) {
      for (const p of state.pockets) {
        const c = gameToCss(p);
        ctx.save();
        ctx.fillStyle = 'rgba(255,255,255,0.2)';
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(c.x, c.y, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }

    // Detected balls
    if (state.detectedBalls && state.detectedBalls.length) {
      for (const b of state.detectedBalls) {
        const c = gameToCss(b);
        ctx.save();
        ctx.strokeStyle = b.isCue ? '#ffffff' : 'rgba(255,255,255,0.35)';
        ctx.lineWidth = b.isCue ? 2 : 1;
        ctx.beginPath();
        const rCss = b.r * (state.overlay.clientWidth / state.gameCanvas.width);
        ctx.arc(c.x, c.y, Math.max(6, rCss), 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Aim
    if (state.cueBall && state.targetBall && state.targetPocket) {
      const R = state.ballRadius;
      const ghost = computeGhostBall(state.targetBall, state.targetPocket, R);

      const cue = gameToCss(state.cueBall);
      const tgt = gameToCss(state.targetBall);
      const gho = gameToCss(ghost);
      const poc = gameToCss(state.targetPocket);
      const rCss = R * (state.overlay.clientWidth / state.gameCanvas.width);

      // Line cue -> ghost (extended a little)
      ctx.save();
      ctx.strokeStyle = '#3fb950';
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 6]);
      ctx.beginPath();
      ctx.moveTo(cue.x, cue.y);
      // extend line 10% beyond ghost
      const ex = gho.x + (gho.x - cue.x) * 0.02;
      const ey = gho.y + (gho.y - cue.y) * 0.02;
      ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.setLineDash([]);

      // Ghost ball circle
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(gho.x, gho.y, rCss, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Target -> pocket
      ctx.strokeStyle = '#f9c74f';
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.moveTo(tgt.x, tgt.y);
      ctx.lineTo(poc.x, poc.y);
      ctx.stroke();
      ctx.setLineDash([]);

      // Highlights
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cue.x, cue.y, rCss + 2, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = '#ff7b72';
      ctx.beginPath();
      ctx.arc(tgt.x, tgt.y, rCss + 2, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = 'rgba(63,185,80,0.6)';
      ctx.beginPath();
      ctx.arc(poc.x, poc.y, 8, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    } else {
      // Show selection-in-progress markers
      if (state.cueBall) drawMarker(ctx, state.cueBall, '#ffffff', 'B');
      if (state.targetBall) drawMarker(ctx, state.targetBall, '#ff7b72', 'A');
      if (state.targetPocket) drawMarker(ctx, state.targetPocket, '#3fb950', 'P');
    }
  }

  function drawMarker(ctx, gamePt, color, label) {
    const c = gameToCss(gamePt);
    const rCss =
      state.ballRadius * (state.overlay.clientWidth / state.gameCanvas.width);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(c.x, c.y, rCss + 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.font = 'bold 11px system-ui';
    ctx.fillText(label, c.x + rCss + 4, c.y + 4);
    ctx.restore();
  }
})();
