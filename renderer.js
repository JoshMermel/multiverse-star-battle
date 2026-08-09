// Mixin for rendering logic (game state to DOM updates).

export function applyRenderer(GameClass) {
  const p = GameClass.prototype;

  // --- Cell index cache ---
  //
  // Every cell across every board, indexed by cell index (one entry per
  // board sharing that index) and as a flat list, so hot paths (drag
  // highlighting, hover sync, hint highlighting, visual refresh) can look
  // cells up directly instead of re-querying the DOM on every call. Reset
  // once per puzzle load (loadPuzzle clears both before rendering any
  // board) and populated incrementally as each board's grid is built.

  // Clears the cache; call once before (re)building any boards for a puzzle.
  p._resetCellCache = function () {
    this._cellsByIndex = new Map();
    this._allCells = [];
    // The old board's DOM (including any tile-outline overlays) is about
    // to be replaced wholesale -- drop stale references rather than
    // leaving them pointing at detached nodes.
    this._hintTileOutlineEls = [];
  };

  // Registers one cell element under its index. Called once per cell as
  // _buildGrid creates it.
  p._registerCell = function (idx, cell) {
    if (!this._cellsByIndex) this._cellsByIndex = new Map();
    if (!this._allCells) this._allCells = [];
    if (!this._cellsByIndex.has(idx)) this._cellsByIndex.set(idx, []);
    this._cellsByIndex.get(idx).push(cell);
    this._allCells.push(cell);
  };

  // Every cell (across every board) sharing the given index, in board order.
  p._getCellsByIndex = function (idx) {
    return this._cellsByIndex?.get(idx) ?? [];
  };

  // --- Board Construction ---

  // Render cell grid and SVG region borders for a board.
  p.renderBoard = function (id, regionMap) {
    const wrapper = document.getElementById(id);
    const grid = this._buildGrid(this.voidCells ?? new Set());
    const svg = this._buildRegionSvg(regionMap);

    const axisLabelsOn = localStorage.getItem('setting-axis-labels') === 'true';
    if (axisLabelsOn) {
      wrapper.classList.add('grid-wrapper--labeled');

      // Define grid template using custom property fallback directly.
      wrapper.style.gridTemplateColumns = `var(--cell-size) repeat(${this.n}, var(--cell-size))`;
      wrapper.style.gridTemplateRows = `var(--cell-size) repeat(${this.n}, var(--cell-size))`;

      // Corner spacer.
      const corner = document.createElement('div');
      corner.className = 'axis-corner';
      corner.style.gridRow = '1';
      corner.style.gridColumn = '1';
      wrapper.appendChild(corner);

      // Column labels (A-Z).
      for (let c = 0; c < this.n; c++) {
        const label = document.createElement('div');
        label.className = 'axis-label axis-label--col';
        label.textContent = String.fromCharCode(65 + c);
        label.setAttribute('aria-hidden', 'true');
        label.style.gridRow = '1';
        label.style.gridColumn = String(c + 2);
        wrapper.appendChild(label);
      }

      // Row labels (1-N).
      for (let r = 0; r < this.n; r++) {
        const label = document.createElement('div');
        label.className = 'axis-label axis-label--row';
        label.textContent = String(r + 1);
        label.setAttribute('aria-hidden', 'true');
        label.style.gridRow = String(r + 2);
        label.style.gridColumn = '1';
        wrapper.appendChild(label);
      }

      // Inner wrapper to hold grid and SVG overlay.
      const inner = document.createElement('div');
      inner.className = 'axis-board-inner';
      inner.style.gridRow = `2 / span ${this.n}`;
      inner.style.gridColumn = '2';
      // Set dimensions explicitly so absolute overlay matches board dimensions.
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

  // Build cell grid element.
  p._buildGrid = function (voidCells) {
    const grid = document.createElement('div');
    grid.className = 'star-battle-grid';
    grid.style.width = 'fit-content';
    grid.style.gridTemplateColumns = `repeat(${this.n}, var(--cell-size))`;
    grid.oncontextmenu = (e) => e.preventDefault();

    for (let i = 0; i < this.n * this.n; i++) {
      const cell = document.createElement('div');
      cell.dataset.index = i;
      this._registerCell(i, cell);
      if (voidCells.has(i)) {
        cell.className = 'cell cell--void';
        grid.appendChild(cell);
        continue;
      }
      cell.className = 'cell';

      // Synchronize hover state across boards on pointer devices.
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
      // Fall back to elementFromPoint for touch drag support.
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

  // Build SVG overlay containing region borders.
  p._buildRegionSvg = function (regionMap) {
    const COORD = 100;
    const totalCoord = this.n * COORD;
    const STROKE = COORD * 0.07;
    const HALF = STROKE / 2;

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "region-svg");
    svg.setAttribute("viewBox", `${-HALF} ${-HALF} ${totalCoord + STROKE} ${totalCoord + STROKE}`);

    // Draw boundary paths between different regions.
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

  // --- Cell & Board Visuals ---

  // Update cell contents based on state value (star/dot/empty).
  p.updateCellVisual = function (cell, val) {
    const { CELL } = this._constants;
    cell.innerHTML = val === CELL.STAR ? '<span class="star">★</span>'
      : val === CELL.DOT ? '<div class="dot"></div>'
        : '';
  };

  // Update visuals for all cells.
  p.updateVisuals = function () {
    this._allCells.forEach(cell => {
      this.updateCellVisual(cell, this.state[cell.dataset.index]);
    });
  };

  // Sync cell hover state across boards.
  p._setHoverSync = function (idx, on) {
    this._getCellsByIndex(idx).forEach(cell => {
      cell.classList.toggle('cell-hover-sync', on);
    });
  };

  // --- Error Highlights ---

  p._applyErrorHighlights = function (errorIndices) {
    this._allCells.forEach(cell => {
      const idx = parseInt(cell.dataset.index);
      cell.classList.toggle('error-cell', errorIndices.has(idx));
    });
  };

  // --- Controls ---

  // Enable/disable undo and redo buttons based on history position.
  p.updateControls = function () {
    const undoBtn = document.getElementById('undo-btn');
    const redoBtn = document.getElementById('redo-btn');
    undoBtn.disabled = (this.historyIdx === 0);
    redoBtn.disabled = (this.historyIdx >= this.history.length - 1);
  };

  // Update loading state overlay and controls.
  p.setLoading = function (isLoading) {
    const ids = ['prev-puz', 'next-puz', 'puzzle-input', 'category-select',
      'hint-btn', 'check-btn', 'reset-btn'];
    ids.forEach(id => document.getElementById(id).disabled = isLoading);
    const boardsWrapper = document.getElementById('boards-wrapper');
    boardsWrapper.style.opacity = isLoading ? '0.4' : '1';
    boardsWrapper.style.pointerEvents = isLoading ? 'none' : '';
  };

  // --- Solved Badge ---

  // Update solved badge visibility.
  p.updateSolvedUI = function () {
    const { storageManager } = this._deps;
    const solved = storageManager.getSolvedList();
    this._updateSolvedBadge(solved);
  };

  // Update opacity of the solved badge element.
  p._updateSolvedBadge = function (solved) {
    const badge = document.getElementById('solved-badge');
    badge.style.opacity = solved.includes(this.currentPuzzleUniqueId) ? '1' : '0';
  };

  // --- Hints ---

  // Highlight cells and display hint description.
  //
  // Each highlight/mark may carry its own `boards` array (which board(s)
  // that specific cell is actually about -- e.g. a cross-board rule's
  // source region lives on one board, but its row/column consequence is
  // board-agnostic and applies to all of them). Falls back to the hint's
  // own boardIdx, then to every board, so single-board rules (which never
  // set `boards`) render exactly as before.
  p.applyHintUI = function (hint) {
    const involvedBoards = new Set();

    // Tile outlines are separate overlay elements (not cell classes -- see
    // _applyTileOutlines), so they don't get swept up by the class-based
    // highlight loop below and need their own accumulation guard: clear
    // any outlines from a PREVIOUS hint before drawing this one's, since
    // repeated Hint clicks call applyHintUI without necessarily going
    // through clearHintUI in between.
    this._clearTileOutlines();

    for (const { idx, color, boards } of [...hint.highlights, ...hint.marks]) {
      const targetBoards = boards ?? (hint.boardIdx !== undefined ? [hint.boardIdx] : null);
      const cellsForIdx = this._getCellsByIndex(idx);
      // cellsForIdx is ordered by board index (0, 1, 2, ...), matching the
      // order boards were rendered in -- a board-specific hint can index
      // directly into it instead of re-querying the DOM per selector.
      const cells = targetBoards ? targetBoards.map(b => cellsForIdx[b]) : cellsForIdx;
      if (targetBoards) targetBoards.forEach(b => involvedBoards.add(b));
      for (const cell of cells) {
        // Only apply the color class if the cell exists and isn't a void square
        if (cell && !cell.classList.contains('cell--void')) {
          cell.classList.add(color);
        }
      }
    }

    if (hint.tileOutlines) this._applyTileOutlines(hint.tileOutlines);

    if (document.body.classList.contains('tab-mode')) {
      if (hint.boardIdx !== undefined) {
        // Single-board hint: just switch straight to it.
        this._showBoard(hint.boardIdx + 1);
      } else {
        // Multi-board hint: don't yank the player off their current board
        // (there's only one board visible at a time in tab mode, and a
        // cross-board hint may span boards other than the active one).
        // Flag the swap button instead so it's obvious another board is
        // also part of this deduction.
        this._flagSwapButtonForHint(involvedBoards);
      }
    }

    this.showToast(hint.description, "hint", 30000);
  };

  // Draws one colored, inset-bordered overlay box per { topLeftIdx, color }
  // entry, spanning the 2x2 area starting at that cell -- see the "Tiles"
  // rule family in solver-rules-multi.js. One overlay per board (tiles
  // are board-agnostic: the same row/column-based box applies to every
  // board's grid at once).
  //
  // Positioned with `position: absolute` (top/left set here, in
  // cell-size units; width/height and the inset are fixed in CSS) rather
  // than as a grid item spanning grid-row/grid-column. That looked
  // simpler at first -- no pixel math, just occupy the same 2x2 grid
  // area as the cells it outlines -- but a grid item with an EXPLICIT
  // position claims that area in the auto-placement algorithm BEFORE the
  // 81 auto-placed cell divs get laid out (CSS Grid places explicit-
  // position items first, regardless of DOM order), which visibly
  // corrupted the cells' positions (confirmed empirically: cells after
  // the outline's claimed area silently shifted over/wrapped). Absolute
  // positioning is pure decoration, entirely outside grid layout, so it
  // can't interfere with the cells no matter how many outlines are added.
  p._applyTileOutlines = function (tileOutlines) {
    for (const { topLeftIdx, color } of tileOutlines) {
      const row = Math.floor(topLeftIdx / this.n);
      const col = topLeftIdx % this.n;
      for (const cell of this._getCellsByIndex(topLeftIdx)) {
        const grid = cell?.parentElement;
        if (!grid) continue;
        const outline = document.createElement('div');
        outline.className = `tile-outline tile-outline-${color}`;
        // Shifted by the same 10%-of-a-cell inset .tile-outline's CSS
        // shrinks width/height by (2x that), so the box ends up
        // symmetrically inset on all four sides -- see style.css.
        outline.style.top = `calc(${row} * var(--cell-size) + var(--cell-size) * 0.1)`;
        outline.style.left = `calc(${col} * var(--cell-size) + var(--cell-size) * 0.1)`;
        grid.appendChild(outline);
        if (!this._hintTileOutlineEls) this._hintTileOutlineEls = [];
        this._hintTileOutlineEls.push(outline);
      }
    }
  };

  p._clearTileOutlines = function () {
    if (!this._hintTileOutlineEls) return;
    for (const el of this._hintTileOutlineEls) el.remove();
    this._hintTileOutlineEls = [];
  };

  // Highlights the swap button when the active hint involves a board other
  // than the one currently showing, so the player knows to check it. Cleared
  // whenever the board is actually switched (see _showBoard).
  p._flagSwapButtonForHint = function (involvedBoards) {
    const swapBtn = document.getElementById('board-swap-btn');
    if (!swapBtn) return;
    const currentBoard = (this._activeTabBoard ?? 1) - 1;
    const hasOtherBoard = [...involvedBoards].some(b => b !== currentBoard);
    swapBtn.classList.toggle('board-tab--hint-flag', hasOtherBoard);
  };

  // Clear active hint highlights.
  p.clearHintUI = function () {
    const { HINT_COLOR, HINT_SOURCE_VARIANTS } = this._constants;
    this._allCells.forEach(cell => {
      cell.classList.remove(
        HINT_COLOR.SOURCE, HINT_COLOR.TARGET, HINT_COLOR.TARGET_STAR, HINT_COLOR.ERROR,
        ...HINT_SOURCE_VARIANTS
      );
    });
    this._clearTileOutlines();
    const swapBtn = document.getElementById('board-swap-btn');
    if (swapBtn) swapBtn.classList.remove('board-tab--hint-flag');
  };

  // --- Toast Notifications ---

  // Show a dismissible toast notification.
  p.showToast = function (message, type = 'info', duration = 2000) {
    const toast = document.getElementById('toast');
    this.activeToastType = type;
    toast.textContent = message;
    toast.className = '';
    toast.classList.add(`toast-${type}`, 'toast-hidden');
    void toast.offsetHeight;
    toast.classList.remove('toast-hidden');
    this.toastBirthTime = Date.now();

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

  // --- Global UI State ---

  p._applyDarkMode = function (on) {
    document.documentElement.setAttribute('data-theme', on ? 'dark' : '');
  };

  p._applyTabMode = function (on) {
    const isTabNeeded = on && this.regions && this.regions.length > 1;
    document.body.classList.toggle('tab-mode', isTabNeeded);
    const tabs = document.getElementById('board-tabs');
    tabs.setAttribute('aria-hidden', isTabNeeded ? 'false' : 'true');

    if (isTabNeeded) {
      this._showBoard(this._activeTabBoard ?? 1);
    } else {
      document.querySelectorAll('.board-container').forEach(el => {
        el.classList.remove('tab-visible');
      });
    }

    // Bind swap button click handler.
    const swapBtn = document.getElementById('board-swap-btn');
    if (swapBtn) {
      if (this.regions && this.regions.length <= 1) {
        swapBtn.style.display = 'none';
      } else {
        swapBtn.style.display = '';
      }
      swapBtn.onclick = () => {
        const total = this.regions ? this.regions.length : 2;
        const nextBoard = ((this._activeTabBoard ?? 1) % total) + 1;
        this._showBoard(nextBoard);
      };
    }
  };

  p._showBoard = function (boardNum) {
    this._activeTabBoard = boardNum;
    document.querySelectorAll('.board-container').forEach((el, i) => {
      const isVisible = (i + 1) === boardNum;
      el.classList.toggle('tab-visible', isVisible);
    });
    const swapBtn = document.getElementById('board-swap-btn');
    if (swapBtn) {
      const total = this.regions ? this.regions.length : 2;
      const targetBoard = (boardNum % total) + 1;
      swapBtn.textContent = `Swap to Board ${targetBoard}`;
      swapBtn.classList.remove('board-tab--hint-flag');
    }
  };

  p._applyShowTimer = function (on) {
    const timerContainer = document.getElementById('timer-container');
    if (timerContainer) {
      timerContainer.style.display = on ? 'flex' : 'none';
    }
  };

  p._updateTimerDisplay = function (seconds) {
    const display = document.getElementById('timer-display');
    if (!display) return;

    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    let timeStr = "";
    if (hrs > 0) {
      timeStr += `${String(hrs).padStart(2, '0')}:`;
    }
    timeStr += `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    display.textContent = timeStr;
  };
}
