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
    ballRadius: 13, // pixels in game canvas space (auto-calibrated after detection)
    // Selection
    mode: 'idle', // 'calibrate' | 'select-cue' | 'select-target' | 'select-pocket' | 'idle'
    cueBall: null,
    cueManual: false,
    targetBall: null,
    targetManual: false,
    targetPocket: null,
    detectedBalls: [],
    cueStick: null,
    rafId: null,
    lastDetection: { ts: 0, count: 0, error: null },
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

  function waitForCanvasAndStart() {
    // Always mount the panel immediately so the user sees feedback
    if (!state.panel) mountPanel();
    tryMountOverlay(false);
    // Keep polling for the canvas in the background in case it mounts later
    clearInterval(state._canvasPoll);
    state._canvasPoll = setInterval(() => {
      if (state.gameCanvas) { clearInterval(state._canvasPoll); return; }
      tryMountOverlay(true);
    }, 1000);
  }

  function tryMountOverlay(silent) {
    const canvas = findGameCanvas();
    if (!canvas) {
      if (!silent) setHint('Canvas do jogo NAO encontrado. Clique em "Achar jogo" ou recarregue a pagina.');
      return false;
    }
    state.gameCanvas = canvas;
    if (!state.overlay) mountOverlay();
    if (!state.rafId) startLoop();
    // Preflight: if drawImage returns non-blank, great (fast path).
    // Otherwise we will fall back to captureVisibleTab automatically.
    const direct = canReadCanvasPixels(canvas);
    if (direct) {
      setHint('Canvas detectado (leitura direta OK). Clique em "Calibrar" e marque os 4 cantos.');
    } else {
      setHint('Canvas detectado (usando modo screenshot). Clique em "Calibrar" e marque os 4 cantos.');
    }
    return true;
  }

  // Quick 8x8 sample test — true if drawImage actually copies content.
  function canReadCanvasPixels(canvas) {
    try {
      const s = 8;
      const off = document.createElement('canvas');
      off.width = s; off.height = s;
      const o = off.getContext('2d', { willReadFrequently: true });
      o.drawImage(canvas, 0, 0, s, s);
      const d = o.getImageData(0, 0, s, s).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) {
        sum += d[i] + d[i + 1] + d[i + 2];
      }
      return sum > 50; // non-blank
    } catch (e) {
      return false;
    }
  }

  function findGameCanvas() {
    const canvases = collectAllCanvases();
    if (canvases.length === 0) return null;
    let best = null;
    let bestArea = 0;
    for (const c of canvases) {
      const r = getCanvasRectInTopFrame(c);
      const area = r.width * r.height;
      if (area > bestArea && r.width > 200 && r.height > 150) {
        bestArea = area;
        best = c;
      }
    }
    return best;
  }

  // Collect canvases from top frame and from same-origin iframes recursively
  function collectAllCanvases() {
    const list = [];
    function walk(doc) {
      if (!doc) return;
      try {
        list.push(...doc.querySelectorAll('canvas'));
        const iframes = doc.querySelectorAll('iframe');
        for (const f of iframes) {
          try { walk(f.contentDocument); } catch (e) { /* cross-origin */ }
        }
      } catch (e) { /* ignore */ }
    }
    walk(document);
    return list;
  }

  // Returns canvas bounding rect in top-window CSS coordinates,
  // accounting for nested same-origin iframes.
  function getCanvasRectInTopFrame(canvas) {
    let rect = canvas.getBoundingClientRect();
    let offX = 0, offY = 0;
    let win = canvas.ownerDocument.defaultView;
    while (win && win !== window.top) {
      const frame = win.frameElement;
      if (!frame) break;
      const fr = frame.getBoundingClientRect();
      offX += fr.left;
      offY += fr.top;
      win = win.parent;
    }
    return {
      left: rect.left + offX,
      top: rect.top + offY,
      right: rect.right + offX,
      bottom: rect.bottom + offY,
      width: rect.width,
      height: rect.height,
    };
  }

  function teardown() {
    stopLoop();
    stopContinuousDetection();
    if (state._canvasPoll) { clearInterval(state._canvasPoll); state._canvasPoll = null; }
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
    const rect = getCanvasRectInTopFrame(state.gameCanvas);
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
    const rect = getCanvasRectInTopFrame(state.gameCanvas);
    const sx = rect.width / state.gameCanvas.width;
    const sy = rect.height / state.gameCanvas.height;
    return { x: pt.x * sx, y: pt.y * sy };
  }
  function cssToGame(cssX, cssY) {
    if (!state.gameCanvas) return { x: cssX, y: cssY };
    const rect = getCanvasRectInTopFrame(state.gameCanvas);
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

        <div class="sa-hint" data-testid="status-line" style="font-size:11px;padding:6px 8px;border:1px solid #30363d;border-radius:6px;background:rgba(0,0,0,0.3);">
          Aguardando deteccao...
        </div>

        <div class="sa-actions">
          <button data-action="find" class="primary wide" data-testid="btn-find">Achar jogo (canvas)</button>
          <button data-action="calibrate" data-testid="btn-calibrate">Calibrar</button>
          <button data-action="detect" data-testid="btn-detect">Detectar bolas</button>
          <button data-action="cue" data-testid="btn-pick-cue">Escolher branca</button>
          <button data-action="target" data-testid="btn-pick-target">Escolher alvo</button>
          <button data-action="pocket" data-testid="btn-pick-pocket">Escolher caçapa</button>
          <button data-action="clear" class="danger" data-testid="btn-clear">Limpar seleção</button>
          <button data-action="reset" class="danger wide" data-testid="btn-reset">Resetar tudo</button>
        </div>

        <div class="sa-hint" data-testid="hint">
          Se o painel apareceu mas nada acontece, clique em "Achar jogo"
          depois em "Calibrar" e marque os cantos da mesa em ordem:
          SUP-ESQ, SUP-DIR, INF-DIR, INF-ESQ.
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
      case 'find': {
        const ok = tryMountOverlay(false);
        if (ok) {
          const r = getCanvasRectInTopFrame(state.gameCanvas);
          setHint(`Canvas achado (${Math.round(r.width)}x${Math.round(r.height)}). Agora clique em "Calibrar".`);
        }
        break;
      }
      case 'calibrate':
        if (!state.gameCanvas) { tryMountOverlay(false); }
        if (!state.gameCanvas) return setHint('Canvas do jogo nao encontrado. Clique "Achar jogo".');
        state.mode = 'calibrate';
        state.corners = [];
        state.pockets = [];
        setHint('Clique nos 4 cantos da mesa na ordem: SUP-ESQ, SUP-DIR, INF-DIR, INF-ESQ.');
        enableInteractive(true);
        break;
      case 'cue':
        if (!state.gameCanvas) return setHint('Canvas nao encontrado. Clique "Achar jogo".');
        if (state.corners.length !== 4) return setHint('Calibre a mesa primeiro (4 cantos).');
        state.mode = 'select-cue';
        setHint('Clique sobre a BOLA BRANCA.');
        enableInteractive(true);
        break;
      case 'target':
        if (!state.gameCanvas) return setHint('Canvas nao encontrado. Clique "Achar jogo".');
        if (state.corners.length !== 4) return setHint('Calibre a mesa primeiro.');
        state.mode = 'select-target';
        setHint('Clique na BOLA ALVO que quer encaçapar.');
        enableInteractive(true);
        break;
      case 'pocket':
        if (!state.gameCanvas) return setHint('Canvas nao encontrado. Clique "Achar jogo".');
        if (state.corners.length !== 4) return setHint('Calibre a mesa primeiro.');
        state.mode = 'select-pocket';
        setHint('Clique na caçapa desejada (ou em qualquer ponto proximo a ela).');
        enableInteractive(true);
        break;
      case 'detect':
        if (!state.gameCanvas) return setHint('Canvas nao encontrado. Clique "Achar jogo".');
        if (state.corners.length !== 4) return setHint('Calibre a mesa antes de detectar bolas.');
        detectBalls()
          .then(() => {
            startContinuousDetection();
            setHint(`Detectadas ${state.detectedBalls.length} bolas. Clique numa bola ALVO para mira automatica.`);
            state.mode = 'select-target';
            enableInteractive(true);
          })
          .catch((e) => {
            state.lastDetection = { ts: Date.now(), count: 0, error: e.message || String(e) };
            updateStatusLine();
            setHint('Falha na deteccao: ' + (e.message || e));
          });
        break;
      case 'clear':
        state.cueBall = null;
        state.targetBall = null;
        state.targetPocket = null;
        state.cueManual = false;
        state.targetManual = false;
        state.mode = 'idle';
        enableInteractive(false);
        setHint('Selecao limpa. A mira segue o taco automaticamente. Clique numa bola para forcar alvo manual.');
        // re-enter select-target for one-click aim
        if (state.corners.length === 4) {
          state.mode = 'select-target';
          enableInteractive(true);
        }
        break;
      case 'reset':
        state.corners = [];
        state.pockets = [];
        state.cueBall = null;
        state.targetBall = null;
        state.targetPocket = null;
        state.detectedBalls = [];
        state.cueManual = false;
        state.targetManual = false;
        state.cueStick = null;
        state.mode = 'idle';
        enableInteractive(false);
        stopContinuousDetection();
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
        setHint('Mesa calibrada! Detectando bolas...');
        // Auto-run detection (async) + start continuous detection loop
        detectBalls()
          .then(() => {
            setHint(`${state.detectedBalls.length} bolas detectadas. Clique numa bola ALVO para mira automatica.`);
          })
          .catch((e) => {
            state.lastDetection = { ts: Date.now(), count: 0, error: e.message || String(e) };
            updateStatusLine();
            setHint('Mesa calibrada. Deteccao tentando via screenshot... aguarde alguns segundos.');
          });
        startContinuousDetection();
        // Auto-enter select-target mode so next click picks target ball
        state.mode = 'select-target';
        enableInteractive(true);
      } else {
        const labels = ['sup-dir', 'inf-dir', 'inf-esq'];
        setHint(`Canto ${state.corners.length}/4 marcado. Clique em ${labels[state.corners.length - 1]}.`);
      }
    } else if (state.mode === 'select-cue') {
      state.cueBall = snapToDetected(pt) || pt;
      state.cueManual = true;
      state.mode = 'idle';
      enableInteractive(false);
      setHint('Bola branca selecionada. Agora clique em "Escolher alvo".');
    } else if (state.mode === 'select-target') {
      state.targetBall = snapToDetected(pt) || pt;
      state.targetManual = true;
      // Auto-pick best pocket (min cut angle) if we have cue ball + pockets
      if (state.cueBall && state.pockets.length === 6) {
        state.targetPocket = findBestPocket(
          state.cueBall,
          state.targetBall,
          state.pockets,
          state.ballRadius
        );
      }
      state.mode = 'idle';
      enableInteractive(false);
      if (state.targetPocket) {
        setHint('Mira pronta! Caçapa escolhida automaticamente. Clique em outra bola para recalcular, ou "Limpar seleção".');
      } else {
        setHint('Alvo selecionado. Agora clique em "Escolher caçapa" ou em uma caçapa.');
      }
      // After first aim, re-enable target selection so subsequent clicks
      // let the user quickly switch target balls without pressing buttons.
      state.mode = 'select-target';
      enableInteractive(true);
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
  /* Pixel capture: drawImage fast-path, captureVisibleTab fallback     */
  /* ------------------------------------------------------------------ */
  async function getGameImageData() {
    const src = state.gameCanvas;
    if (!src) throw new Error('no_canvas');
    const W = src.width, H = src.height;

    // Fast path: drawImage (works only if WebGL preserveDrawingBuffer=true)
    try {
      const off = document.createElement('canvas');
      off.width = W; off.height = H;
      const octx = off.getContext('2d', { willReadFrequently: true });
      octx.drawImage(src, 0, 0);
      const img = octx.getImageData(0, 0, W, H);
      const data = img.data;
      let nonBlack = 0;
      const stride = Math.max(4, ((data.length / 4 / 1500) | 0) * 4);
      for (let i = 0; i < data.length; i += stride) {
        if (data[i] + data[i + 1] + data[i + 2] > 30) {
          nonBlack++;
          if (nonBlack > 30) break;
        }
      }
      if (nonBlack > 30) {
        state._captureMode = 'direct';
        return img;
      }
    } catch (e) { /* fall through */ }

    // Fallback path: captureVisibleTab via service worker (compositor readback)
    // IMPORTANT: the screenshot captures our own overlay too, which would
    // show up as white/colored blobs (pocket markers, aim ring, detection
    // highlights) and confuse the ball detection. So we hide the overlay
    // briefly, wait two frames, capture, then restore visibility.
    const wasVisible = state.overlay && state.overlay.style.visibility !== 'hidden';
    if (wasVisible) state.overlay.style.visibility = 'hidden';
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    const resp = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'capture' }, (r) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(r);
        });
      } catch (e) { resolve({ ok: false, error: String(e) }); }
    });

    if (wasVisible && state.overlay) state.overlay.style.visibility = 'visible';

    if (!resp || !resp.ok) throw new Error('capture_failed:' + (resp && resp.error));

    const fullImg = await loadImage(resp.dataUrl);
    const dpr = window.devicePixelRatio || 1;
    const rect = getCanvasRectInTopFrame(src);
    const off = document.createElement('canvas');
    off.width = W; off.height = H;
    const octx = off.getContext('2d', { willReadFrequently: true });
    // Full canvas region in tab-screenshot pixels (may be partially off-viewport)
    const srcLeft = rect.left * dpr;
    const srcTop = rect.top * dpr;
    const srcW = rect.width * dpr;
    const srcH = rect.height * dpr;
    const clipLeft = Math.max(0, -srcLeft);
    const clipTop = Math.max(0, -srcTop);
    const sx = Math.max(0, srcLeft);
    const sy = Math.max(0, srcTop);
    const sw = Math.max(1, Math.min(fullImg.naturalWidth - sx, srcW - clipLeft));
    const sh = Math.max(1, Math.min(fullImg.naturalHeight - sy, srcH - clipTop));
    const scaleX = W / srcW;
    const scaleY = H / srcH;
    const dx = clipLeft * scaleX;
    const dy = clipTop * scaleY;
    const dw = sw * scaleX;
    const dh = sh * scaleY;
    octx.fillStyle = '#000';
    octx.fillRect(0, 0, W, H);
    octx.drawImage(fullImg, sx, sy, sw, sh, dx, dy, dw, dh);
    state._captureMode = 'capture';
    return octx.getImageData(0, 0, W, H);
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = dataUrl;
    });
  }

  /* ------------------------------------------------------------------ */
  /* Ball detection (green-dominance + flood-fill + circularity)        */
  /* ------------------------------------------------------------------ */
  async function detectBalls() {
    if (!state.gameCanvas) throw new Error('no_canvas');
    if (state.corners.length !== 4) throw new Error('not_calibrated');
    if (state._detecting) return;
    state._detecting = true;
    try {
      const img = await getGameImageData();
      runDetection(img);
    } finally {
      state._detecting = false;
    }
  }

  function runDetection(img) {
    const data = img.data;
    const W = img.width, H = img.height;

    // Bounding box of the table polygon
    const poly = state.corners;
    let minX = Math.max(0, Math.floor(Math.min(...poly.map((p) => p.x))));
    let maxX = Math.min(W - 1, Math.ceil(Math.max(...poly.map((p) => p.x))));
    let minY = Math.max(0, Math.floor(Math.min(...poly.map((p) => p.y))));
    let maxY = Math.min(H - 1, Math.ceil(Math.max(...poly.map((p) => p.y))));

    // Shrink a bit to avoid rails
    const shrink = Math.round(state.ballRadius * 0.9);
    minX += shrink; maxX -= shrink; minY += shrink; maxY -= shrink;
    if (minX >= maxX || minY >= maxY) { state.detectedBalls = []; return; }

    // Green dominance heuristic — robust vs vignette, shadows and the
    // translucent "SINUCADA.COM" logo watermark (still greenish).
    function isFelt(i) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      // felt = green channel clearly dominates
      return g > r + 12 && g > b + 12 && g > 40;
    }

    // Mask: 1 if NOT felt AND inside polygon
    const mask = new Uint8Array(W * H);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (!pointInPoly(x, y, poly)) continue;
        const i = (y * W + x) * 4;
        if (!isFelt(i)) mask[y * W + x] = 1;
      }
    }

    // Connected components (BFS)
    const visited = new Uint8Array(W * H);
    const balls = [];
    const R0 = state.ballRadius;
    const minArea = Math.PI * (R0 * 0.45) ** 2;
    const maxArea = Math.PI * (R0 * 1.9) ** 2;
    const qx = new Int32Array(W * H);
    const qy = new Int32Array(W * H);

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const idx = y * W + x;
        if (!mask[idx] || visited[idx]) continue;
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
        const w = bbR - bbL + 1, h = bbB - bbT + 1;
        if (w === 0 || h === 0) continue;
        const aspect = Math.max(w / h, h / w);
        if (aspect > 1.7) continue; // rejects cue stick and elongated noise
        // circularity: fill ratio of bounding circle
        const rBB = Math.max(w, h) / 2;
        const fill = area / (Math.PI * rBB * rBB);
        if (fill < 0.45) continue; // rejects C-shapes / holes
        balls.push({
          x: sx2 / area,
          y: sy2 / area,
          r: rBB,
          area,
          color: { r: rSum / area, g: gSum / area, b: bSum / area },
        });
      }
    }

    // Auto-calibrate ballRadius to the median radius detected (gives
    // better ghost ball sizing without the user touching the slider).
    if (balls.length >= 3) {
      const sorted = balls.map((b) => b.r).sort((a, b) => a - b);
      const medR = sorted[Math.floor(sorted.length / 2)];
      if (medR > 4 && medR < 80) {
        state.ballRadius = Math.round(medR);
        saveCalibration();
        if (state.panel) {
          const slider = state.panel.querySelector('[data-testid="radius-range"]');
          const vs = state.panel.querySelector('[data-testid="radius-val"]');
          if (slider) slider.value = state.ballRadius;
          if (vs) vs.textContent = state.ballRadius;
        }
      }
    }

    // Whitest blob = cue ball. Require pure white AND temporally stable.
    let cueIdx = -1, bestScore = -Infinity;
    for (let i = 0; i < balls.length; i++) {
      const c = balls[i].color;
      const bright = (c.r + c.g + c.b) / 3;
      const spread = Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
      // Hard gate: must be genuinely white (not a striped ball's white half)
      if (bright < 170 || spread > 45) continue;
      // Area gate: must be close to typical ball area (no tiny specks)
      const R0 = state.ballRadius;
      const idealArea = Math.PI * R0 * R0;
      const areaRatio = balls[i].area / idealArea;
      if (areaRatio < 0.4 || areaRatio > 2.2) continue;
      // Temporal stickiness: prefer a candidate close to previous cue ball
      let temporal = 0;
      if (state.cueBall && !state.cueManual) {
        const dx = balls[i].x - state.cueBall.x;
        const dy = balls[i].y - state.cueBall.y;
        const d = Math.hypot(dx, dy);
        temporal = Math.max(0, 80 - d); // bonus 0..80 inversely with distance
      }
      const score = bright - spread * 3 + temporal;
      if (score > bestScore) { bestScore = score; cueIdx = i; }
    }
    if (cueIdx >= 0) {
      balls[cueIdx].isCue = true;
      if (!state.cueManual) {
        state.cueBall = { x: balls[cueIdx].x, y: balls[cueIdx].y };
      }
    }

    state.detectedBalls = balls;
    state.lastDetection = { ts: Date.now(), count: balls.length, error: null };
    updateStatusLine();

    // Detect the cue stick direction: non-felt pixels minus ball regions,
    // close to the cue ball. This lets the aim line follow the player's cue.
    if (state.cueBall) detectCueStick(data, W, H, minX, maxX, minY, maxY, balls);

    // If user already has a target ball picked, re-snap it to nearest
    // detected blob so the aim line follows moving balls.
    if (state.targetBall) {
      const snapped = snapToDetected(state.targetBall);
      if (snapped) state.targetBall = snapped;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Cue stick detection                                                */
  /*   1. Build a mask of non-felt pixels minus ball regions            */
  /*   2. Find pixels within a window around the cue ball (e.g. 250px)  */
  /*   3. Exclude a small disk right at the cue ball so the ball        */
  /*      itself doesn't skew the center-of-mass                        */
  /*   4. Center of mass of remaining = cue stick body                  */
  /*   5. Direction = (cueBall - stickCenter), normalised               */
  /* ------------------------------------------------------------------ */
  function detectCueStick(data, W, H, minX, maxX, minY, maxY, balls) {
    const cue = state.cueBall;
    const R = state.ballRadius;
    const searchR = Math.max(120, R * 12); // 12x ball radius search window
    const excludeR = R * 1.6; // mask out the cue ball itself
    const ballExcludeR = R * 1.3; // mask out other balls
    const xMin = Math.max(minX, Math.floor(cue.x - searchR));
    const xMax = Math.min(maxX, Math.ceil(cue.x + searchR));
    const yMin = Math.max(minY, Math.floor(cue.y - searchR));
    const yMax = Math.min(maxY, Math.ceil(cue.y + searchR));

    // Precompute ball centers to avoid repeated array scans
    const ballsArr = balls;

    let sumX = 0, sumY = 0, count = 0;
    let farX = 0, farY = 0, farDist = -1;
    const r2 = searchR * searchR;
    const ex2 = excludeR * excludeR;
    const be2 = ballExcludeR * ballExcludeR;

    for (let y = yMin; y <= yMax; y++) {
      for (let x = xMin; x <= xMax; x++) {
        const ddx = x - cue.x, ddy = y - cue.y;
        const d2 = ddx * ddx + ddy * ddy;
        if (d2 > r2) continue;
        if (d2 < ex2) continue; // skip the cue ball itself
        const i = (y * W + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        // Not felt: green not dominant
        if (g > r + 12 && g > b + 12 && g > 40) continue;
        // Skip any ball area
        let inBall = false;
        for (let k = 0; k < ballsArr.length; k++) {
          const bb = ballsArr[k];
          if (bb.isCue) continue; // already excluded by ex2
          const dx2 = x - bb.x, dy2 = y - bb.y;
          if (dx2 * dx2 + dy2 * dy2 < be2) { inBall = true; break; }
        }
        if (inBall) continue;
        // Cue stick pixel candidate
        sumX += x; sumY += y; count++;
        if (d2 > farDist) { farDist = d2; farX = x; farY = y; }
      }
    }

    if (count < 40) {
      state.cueStick = null;
      return;
    }
    const cmx = sumX / count, cmy = sumY / count;
    // Direction from stick center-of-mass toward the cue ball (unit vector).
    let dx = cue.x - cmx, dy = cue.y - cmy;
    const norm = Math.hypot(dx, dy) || 1;
    dx /= norm; dy /= norm;
    state.cueStick = {
      cmx, cmy,
      dx, dy,
      count,
      farX, farY,
    };
    // If no manual target ball, auto-pick the ball the cue is aiming at.
    autoPickTargetAlongCue();
  }

  /* Given cue ball + cue stick direction, cast a ray and pick the
   * first detected ball whose center is close to the ray. Then
   * compute best pocket automatically. */
  function autoPickTargetAlongCue() {
    if (!state.cueBall || !state.cueStick || state.targetManual) return;
    if (!state.detectedBalls || state.detectedBalls.length === 0) return;
    const { dx, dy } = state.cueStick;
    const cue = state.cueBall;
    const R = state.ballRadius;
    const maxDev = R * 1.4; // how far a ball center can be from the ray
    let best = null, bestT = Infinity;
    for (const b of state.detectedBalls) {
      if (b.isCue) continue;
      // Project ball center on the ray from cue along (dx,dy)
      const rx = b.x - cue.x, ry = b.y - cue.y;
      const t = rx * dx + ry * dy; // along-ray distance
      if (t < R) continue; // behind or overlapping cue
      const perp = Math.abs(rx * (-dy) + ry * dx);
      if (perp > maxDev) continue;
      if (t < bestT) { bestT = t; best = b; }
    }
    if (best) {
      state.targetBall = { x: best.x, y: best.y };
      if (state.pockets.length === 6) {
        state.targetPocket = findBestPocket(
          state.cueBall,
          state.targetBall,
          state.pockets,
          state.ballRadius
        );
      }
    } else {
      // No ball along the cue line — clear auto target so we can draw the
      // long straight "cue extension" line instead.
      if (!state.targetManual) {
        state.targetBall = null;
        state.targetPocket = null;
      }
    }
  }

  function updateStatusLine() {
    if (!state.panel) return;
    const el = state.panel.querySelector('[data-testid="status-line"]');
    if (!el) return;
    const d = state.lastDetection;
    const age = d.ts ? Math.floor((Date.now() - d.ts) / 100) / 10 : '—';
    const mode = state._captureMode === 'direct' ? 'direct' : (state._captureMode === 'capture' ? 'screenshot' : '?');
    if (d.error && d.error.indexOf('capture_failed') === 0) {
      el.textContent = 'Erro captura: ' + d.error;
      el.style.color = '#ff7b72';
    } else if (d.error && d.error !== 'not_calibrated') {
      el.textContent = 'Erro: ' + d.error;
      el.style.color = '#ff7b72';
    } else if (d.ts) {
      el.textContent = `Bolas: ${d.count} | Raio: ${state.ballRadius}px | Modo: ${mode} | ${age}s atras`;
      el.style.color = d.count > 0 ? '#3fb950' : '#d29922';
    } else {
      el.textContent = 'Aguardando deteccao...';
      el.style.color = '#8b949e';
    }
  }

  /* ------------------------------------------------------------------ */
  /* Best pocket auto-selection (min cut angle, rewards short distance) */
  /* ------------------------------------------------------------------ */
  function findBestPocket(cue, target, pockets, R) {
    let best = null;
    let bestScore = -Infinity;
    for (const p of pockets) {
      const dx1 = p.x - target.x;
      const dy1 = p.y - target.y;
      const d1 = Math.hypot(dx1, dy1);
      if (d1 < R * 2) continue;
      const ghost = {
        x: target.x - (2 * R * dx1) / d1,
        y: target.y - (2 * R * dy1) / d1,
      };
      const dx2 = ghost.x - cue.x;
      const dy2 = ghost.y - cue.y;
      const d2 = Math.hypot(dx2, dy2);
      if (d2 < R * 2) continue;
      const cosCut = (dx1 * dx2 + dy1 * dy2) / (d1 * d2);
      // cutAngle near 0 = straight shot (best); near pi/2 = very thin cut
      const cutAngle = Math.acos(Math.max(-1, Math.min(1, cosCut)));
      // Score: penalize big cut angle much more than distance
      const score = -(cutAngle * 180) / Math.PI - (d1 + d2) / 400;
      // Reject shots where the target ball would be hit on the wrong side
      if (cosCut < 0.1) continue;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    return best;
  }

  /* ------------------------------------------------------------------ */
  /* Continuous detection loop                                          */
  /* ------------------------------------------------------------------ */
  function startContinuousDetection() {
    if (state._detectInterval) return;
    state._detectInterval = setInterval(async () => {
      if (!state.gameCanvas || state.corners.length !== 4) return;
      try {
        await detectBalls();
      } catch (e) {
        state.lastDetection = { ts: Date.now(), count: 0, error: e.message || String(e) };
        updateStatusLine();
      }
    }, 700); // 700ms is safe under captureVisibleTab rate limit (~2/sec)
  }
  function stopContinuousDetection() {
    if (state._detectInterval) {
      clearInterval(state._detectInterval);
      state._detectInterval = null;
    }
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

    // Pockets — draw as thin dark-red rings to avoid being re-captured
    // as white blobs during screenshot-based ball detection.
    if (state.pockets.length === 6) {
      for (const p of state.pockets) {
        const c = gameToCss(p);
        ctx.save();
        ctx.strokeStyle = 'rgba(255,80,80,0.6)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(c.x, c.y, 9, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Detected balls — outline-only to avoid contaminating the next
    // captureVisibleTab pass with white/colored blobs.
    if (state.detectedBalls && state.detectedBalls.length) {
      for (const b of state.detectedBalls) {
        const c = gameToCss(b);
        ctx.save();
        ctx.strokeStyle = b.isCue ? '#ffe600' : 'rgba(0,200,255,0.7)';
        ctx.lineWidth = b.isCue ? 2 : 1.2;
        ctx.beginPath();
        const rCss = b.r * (state.overlay.clientWidth / state.gameCanvas.width);
        ctx.arc(c.x, c.y, Math.max(4, rCss), 0, Math.PI * 2);
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

      // Ghost ball circle (outline only to avoid self-capture)
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(gho.x, gho.y, rCss, 0, Math.PI * 2);
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

      ctx.strokeStyle = 'rgba(63,185,80,0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(poc.x, poc.y, 9, 0, Math.PI * 2);
      ctx.stroke();

      ctx.restore();
    } else if (state.cueBall && state.cueStick) {
      // No target ball along the cue line: draw a long "cue extension" line
      // from the cue ball going in the cue stick's direction so the user can
      // see where the cue is currently pointing.
      const cue = gameToCss(state.cueBall);
      const { dx, dy } = state.cueStick;
      // Convert direction to CSS (same scale for x & y since game canvas
      // is sampled isotropically)
      const rect = getCanvasRectInTopFrame(state.gameCanvas);
      const sx = rect.width / state.gameCanvas.width;
      const sy = rect.height / state.gameCanvas.height;
      const ex = cue.x + dx * sx * 2000;
      const ey = cue.y + dy * sy * 2000;
      const rCss = state.ballRadius * sx;
      ctx.save();
      ctx.strokeStyle = 'rgba(63,185,80,0.9)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.moveTo(cue.x, cue.y);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cue.x, cue.y, rCss + 2, 0, Math.PI * 2);
      ctx.stroke();
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
