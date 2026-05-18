// renderer.js
// Mixes rendering methods into StarBattleGame.prototype.
// Call applyRenderer(StarBattleGame) once before instantiating the class.
//
// Everything here is "game state → DOM": no game state is mutated,
// no events are wired. Methods read `this.n`, `this.state`, `this.regions`,
// etc. and update the DOM accordingly.

export function applyRenderer(GameClass) {
  const p = GameClass.prototype;

  // ── Board construction ────────────────────────────────────────────────────

  // Builds the cell grid and SVG region borders for one board.
  p.renderBoard = function (id, regionMap) {
    const wrapper = document.getElementById(id);
    const grid = this._buildGrid();
    const svg = this._buildRegionSvg(regionMap);

    const axisLabelsOn = localStorage.getItem('setting-axis-labels') === 'true';
    if (axisLabelsOn) {
      wrapper.classList.add('grid-wrapper--labeled');

      // Set the grid template explicitly in JS so we don't depend on
      // var(--grid-n) resolving correctly on this element.
      wrapper.style.gridTemplateColumns = `var(--cell-size) repeat(${this.n}, var(--cell-size))`;
      wrapper.style.gridTemplateRows = `var(--cell-size) repeat(${this.n}, var(--cell-size))`;

      // Corner spacer: row 1, col 1
      const corner = document.createElement('div');
      corner.className = 'axis-corner';
      corner.style.gridRow = '1';
      corner.style.gridColumn = '1';
      wrapper.appendChild(corner);

      // Column labels: row 1, cols 2..(n+1) — one per column, explicitly placed
      for (let c = 0; c < this.n; c++) {
        const label = document.createElement('div');
        label.className = 'axis-label axis-label--col';
        label.textContent = String.fromCharCode(65 + c);
        label.setAttribute('aria-hidden', 'true');
        label.style.gridRow = '1';
        label.style.gridColumn = String(c + 2);
        wrapper.appendChild(label);
      }

      // Row labels: rows 2..(n+1), col 1 — one per row, explicitly placed
      for (let r = 0; r < this.n; r++) {
        const label = document.createElement('div');
        label.className = 'axis-label axis-label--row';
        label.textContent = String(r + 1);
        label.setAttribute('aria-hidden', 'true');
        label.style.gridRow = String(r + 2);
        label.style.gridColumn = '1';
        wrapper.appendChild(label);
      }

      // Inner wrapper: rows 2..(n+1), col 2 — holds the grid + SVG overlay
      const inner = document.createElement('div');
      inner.className = 'axis-board-inner';
      inner.style.gridRow = `2 / span ${this.n}`;
      inner.style.gridColumn = '2';
      // Explicit size required so the absolutely-positioned SVG overlay fills
      // the board correctly (100% resolves against this element's dimensions).
      inner.style.width = `calc(${this.n} * var(--cell-size))`;
      inner.style.height = `calc(${this.n} * var(--cell-size))`;
      inner.appendChild(grid);
      inner.appendChild(svg);
      wrapper.appendChild(inner);
    } else {
      wrapper.classList.remove('grid-wrapper--labeled');
      wrapper.style.gridTemplateColumns = '';
      wrapper.style.gridTemplateRows = '';
      wrapper.appendChild(grid);
      wrapper.appendChild(svg);
    }
  };

  // Creates the interactive grid div with all pointer event handlers attached.
  p._buildGrid = function () {
    const grid = document.createElement('div');
    grid.className = 'star-battle-grid';
    grid.style.width = 'fit-content';
    grid.style.gridTemplateColumns = `repeat(${this.n}, var(--cell-size))`;
    grid.oncontextmenu = (e) => e.preventDefault();

    for (let i = 0; i < this.n * this.n; i++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.index = i;

      // Desktop-only cross-board hover: highlight the same cell index on both
      // boards. window.matchMedia is checked once at grid-build time; grids
      // are rebuilt per puzzle so this stays current if the user
      // resizes/changes input device.
      if (window.matchMedia('(pointer: fine)').matches) {
        cell.addEventListener('pointerenter', () => {
          if (this.isDragging) return;
          this._setHoverSync(i, true);
        });
        cell.addEventListener('pointerleave', () => {
          this._setHoverSync(i, false);
        });
      }

      grid.appendChild(cell);
    }

    grid.onpointerdown = (e) => {
      const cell = e.target.closest('.cell');
      if (!cell) return;
      e.preventDefault();
      cell.setPointerCapture(e.pointerId);
      const idx = parseInt(cell.dataset.index);
      this.lastDraggedIndex = idx;
      this.handleStart(idx, e.button === 2);
    };

    grid.onpointerover = (e) => {
      const cell = e.target.closest('.cell');
      if (!cell || !this.isDragging) return;
      const idx = parseInt(cell.dataset.index);
      if (idx !== this.lastDraggedIndex) {
        this.lastDraggedIndex = idx;
        this.handleDrag(idx);
      }
    };

    grid.onpointermove = (e) => {
      if (!this.isDragging) return;
      // pointerover doesn't fire on touch during drag, so fall back to
      // elementFromPoint.
      const cell = document.elementFromPoint(e.clientX, e.clientY)?.closest('.cell');
      if (cell) {
        const idx = parseInt(cell.dataset.index);
        if (idx !== this.lastDraggedIndex) {
          this.lastDraggedIndex = idx;
          this.handleDrag(idx);
        }
      }
    };

    return grid;
  };

  // Creates the SVG overlay that draws thick borders between regions.
  p._buildRegionSvg = function (regionMap) {
    const COORD = 100; // virtual units per cell
    const totalCoord = this.n * COORD;
    const STROKE = COORD * 0.07;
    const HALF = STROKE / 2;

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "region-svg");
    svg.setAttribute("viewBox", `${-HALF} ${-HALF} ${totalCoord + STROKE} ${totalCoord + STROKE}`);

    // Walk every cell; draw a border segment wherever the region changes.
    let paths = "";
    for (let i = 0; i < this.n * this.n; i++) {
      const r = Math.floor(i / this.n), c = i % this.n;
      const x2 = (c + 1) * COORD, y2 = (r + 1) * COORD;
      if (c < this.n - 1 && regionMap[i] !== regionMap[i + 1])
        paths += `M ${x2} ${r * COORD} L ${x2} ${y2} `;
      if (r < this.n - 1 && regionMap[i] !== regionMap[i + this.n])
        paths += `M ${c * COORD} ${y2} L ${x2} ${y2} `;
    }

    const borderEl = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    borderEl.setAttribute("x", "0");
    borderEl.setAttribute("y", "0");
    borderEl.setAttribute("width", String(totalCoord));
    borderEl.setAttribute("height", String(totalCoord));
    borderEl.setAttribute("fill", "none");
    borderEl.setAttribute("stroke", "black");
    borderEl.setAttribute("stroke-width", String(STROKE));
    svg.appendChild(borderEl);

    const pathEl = document.createElementNS("http://www.w3.org/2000/svg", "path");
    pathEl.setAttribute("d", paths);
    pathEl.setAttribute("stroke", "black");
    pathEl.setAttribute("stroke-width", String(STROKE));
    pathEl.setAttribute("stroke-linecap", "round");
    pathEl.setAttribute("stroke-linejoin", "round");
    pathEl.setAttribute("fill", "none");
    svg.appendChild(pathEl);

    return svg;
  };

  // ── Cell & board visuals ──────────────────────────────────────────────────

  // Updates a single cell's DOM to reflect its current state value.
  p.updateCellVisual = function (cell, val) {
    const { CELL } = this._constants;
    cell.innerHTML = val === CELL.STAR ? '<span class="star">★</span>'
      : val === CELL.DOT ? '<div class="dot"></div>'
        : '';
  };

  // Re-renders all cells on both boards to match the current state array.
  p.updateVisuals = function () {
    document.querySelectorAll('.cell').forEach(cell => {
      this.updateCellVisual(cell, this.state[cell.dataset.index]);
    });
  };

  // Highlights (or un-highlights) the cell at `idx` on every board simultaneously.
  // Only called on pointer:fine (desktop) devices; dragging suppresses it.
  p._setHoverSync = function (idx, on) {
    document.querySelectorAll(`.cell[data-index="${idx}"]`).forEach(cell => {
      cell.classList.toggle('cell-hover-sync', on);
    });
  };

  // ── Error highlights ──────────────────────────────────────────────────────

  p._applyErrorHighlights = function (errorIndices) {
    document.querySelectorAll('.cell').forEach(cell => {
      const idx = parseInt(cell.dataset.index);
      cell.classList.toggle('error-cell', errorIndices.has(idx));
    });
  };

  // ── Controls ──────────────────────────────────────────────────────────────

  // Enables or disables undo/redo buttons based on current history position.
  p.updateControls = function () {
    const undoBtn = document.getElementById('undo-btn');
    const redoBtn = document.getElementById('redo-btn');
    undoBtn.disabled = (this.historyIdx === 0);
    redoBtn.disabled = (this.historyIdx >= this.history.length - 1);
  };

  // Disables navigation controls and fades the boards while a puzzle fetch is
  // in flight.
  p.setLoading = function (isLoading) {
    const ids = ['prev-puz', 'next-puz', 'puzzle-input', 'category-select',
      'hint-btn', 'check-btn', 'reset-btn'];
    ids.forEach(id => document.getElementById(id).disabled = isLoading);
    const boardsWrapper = document.getElementById('boards-wrapper');
    boardsWrapper.style.opacity = isLoading ? '0.4' : '1';
    boardsWrapper.style.pointerEvents = isLoading ? 'none' : '';
  };

  // ── Solved badge ──────────────────────────────────────────────────────────

  // Shows or hides the ✅ badge based on whether this puzzle is recorded as solved.
  p.updateSolvedUI = function () {
    const { storageManager } = this._deps;
    const solved = storageManager.getSolvedList();
    this._updateSolvedBadge(solved);
  };

  // Sets the solved badge opacity from an already-fetched solved list.
  p._updateSolvedBadge = function (solved) {
    const badge = document.getElementById('solved-badge');
    badge.style.opacity = solved.includes(this.currentPuzzleUniqueId) ? '1' : '0';
  };

  // ── Hints ─────────────────────────────────────────────────────────────────

  // Applies highlight and mark classes to cells based on a hint object,
  // and shows the hint description as a toast.
  p.applyHintUI = function (hint) {
    const selectors = (hint.boardIdx !== undefined)
      ? [`#board${hint.boardIdx + 1}`]
      : ['#board1', '#board2'];

    // Unified loop — highlights and marks both just add a CSS class to a cell
    for (const { idx, color } of [...hint.highlights, ...hint.marks]) {
      for (const sel of selectors) {
        const cell = document.querySelector(`${sel} [data-index="${idx}"]`);
        if (cell) cell.classList.add(color);
      }
    }

    // In tab mode, switch to the board the hint is about. If the hint is
    // cross-board (boardIdx undefined), stay on whichever board the user
    // is already looking at — they can flip between tabs to see both sides.
    if (document.body.classList.contains('tab-mode') && hint.boardIdx !== undefined) {
      this._showBoard(hint.boardIdx + 1);
    }

    this.showToast(hint.description, "hint", 30000);
  };

  // Removes all hint highlight classes from every cell on both boards.
  p.clearHintUI = function () {
    document.querySelectorAll('.cell').forEach(cell => {
      cell.classList.remove('hint-source-blue', 'hint-target-yellow', 'hint-target-green', 'hint-error-red');
    });
  };

  // ── Toast ─────────────────────────────────────────────────────────────────

  // Displays a dismissible notification at the bottom of the screen.
  // Clears any previous toast type before applying the new one.
  p.showToast = function (message, type = 'info', duration = 2000) {
    const toast = document.getElementById('toast');
    this.activeToastType = type;
    toast.textContent = message;
    toast.className = '';
    toast.classList.add(`toast-${type}`, 'toast-hidden');
    void toast.offsetHeight;
    toast.classList.remove('toast-hidden');
    this.toastBirthTime = Date.now();

    toast.classList.remove('toast-hidden');
    toast.onclick = () => {
      if (Date.now() - this.toastBirthTime < 500) return;
      toast.classList.add('toast-hidden');
    };
    clearTimeout(this.toastTimeout);
    this.toastTimeout = setTimeout(() => {
      toast.classList.add('toast-hidden');
    }, duration);
  };

  p.hideToast = function () {
    this.activeToastType = null;
    document.getElementById('toast').classList.add('toast-hidden');
  };

  // ── Global UI state ───────────────────────────────────────────────────────

  p._applyDarkMode = function (on) {
    document.documentElement.setAttribute('data-theme', on ? 'dark' : '');
  };

  p._applyTabMode = function (on) {
    document.body.classList.toggle('tab-mode', on);
    const tabs = document.getElementById('board-tabs');
    tabs.setAttribute('aria-hidden', on ? 'false' : 'true');

    if (on) {
      this._showBoard(this._activeTabBoard ?? 1);
    } else {
      document.querySelectorAll('.board-container').forEach(el => {
        el.classList.remove('tab-visible');
      });
    }

    // Wire tab buttons (idempotent — replaces onclick each time)
    document.querySelectorAll('.board-tab').forEach(btn => {
      const board = parseInt(btn.dataset.board);
      btn.onclick = () => this._showBoard(board);
    });
  };

  p._showBoard = function (boardNum) {
    this._activeTabBoard = boardNum;
    document.querySelectorAll('.board-container').forEach((el, i) => {
      const isVisible = (i + 1) === boardNum;
      el.classList.toggle('tab-visible', isVisible);
    });
    document.querySelectorAll('.board-tab').forEach(btn => {
      btn.classList.toggle('board-tab--active', parseInt(btn.dataset.board) === boardNum);
    });
  };
}
