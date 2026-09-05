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
    // The old board's DOM (including any tile-outline/line-highlight
    // overlays) is about to be replaced wholesale -- drop stale references
    // rather than leaving them pointing at detached nodes.
    this._hintTileOutlineEls = [];
    this._hintLineHighlightEls = [];
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

  // Sync cell hover state across boards. When "setting-row-col-highlight"
  // is on, also bands the cursor's full row and column across every board
  // — read live off localStorage (no separate apply/re-render step needed,
  // same pattern as auto-fill-dots) so toggling it in Settings takes effect
  // on the very next hover, mid-session.
  p._setHoverSync = function (idx, on) {
    this._getCellsByIndex(idx).forEach(cell => {
      cell.classList.toggle('cell-hover-sync', on);
    });

    if (localStorage.getItem('setting-row-col-highlight') !== 'true') return;
    const n = this.n;
    const row = Math.floor(idx / n);
    const col = idx % n;
    const lineIndices = new Set();
    for (let c = 0; c < n; c++) lineIndices.add(row * n + c);
    for (let r = 0; r < n; r++) lineIndices.add(r * n + col);
    lineIndices.delete(idx); // the cursor cell already has its own highlight
    lineIndices.forEach(i => {
      this._getCellsByIndex(i).forEach(cell => {
        cell.classList.toggle('cell-hover-line', on);
      });
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
    const undoDisabled = (this.historyIdx === 0);
    const redoDisabled = (this.historyIdx >= this.history.length - 1);
    document.querySelectorAll('.ctrl-undo').forEach(btn => btn.disabled = undoDisabled);
    document.querySelectorAll('.ctrl-redo').forEach(btn => btn.disabled = redoDisabled);
  };

  // Update loading state overlay and controls.
  p.setLoading = function (isLoading) {
    const ids = ['prev-puz', 'next-puz', 'puzzle-input', 'category-select'];
    ids.forEach(id => document.getElementById(id).disabled = isLoading);
    const classes = ['ctrl-hint', 'ctrl-check', 'ctrl-reset'];
    classes.forEach(cls => document.querySelectorAll(`.${cls}`).forEach(btn => btn.disabled = isLoading));
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

    // Tile outlines and the line-highlight band are separate overlay
    // elements (not cell classes -- see _applyTileOutlines/
    // _applyLineHighlight), so they don't get swept up by the class-based
    // highlight loop below and need their own accumulation guard: clear
    // any leftovers from a PREVIOUS hint before drawing this one's, since
    // repeated Hint clicks call applyHintUI without necessarily going
    // through clearHintUI in between.
    this._clearTileOutlines();
    this._clearLineHighlight();

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
    if (hint.lineHighlight) this._applyLineHighlight(hint.lineHighlight);

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

  // Draws one outline box spanning an entire row or column -- see the
  // "Region/line quota fill" rule family in solver-rules-multi.js. Same
  // absolute-positioning technique as _applyTileOutlines (see its comment
  // for why), just sized to span the whole line instead of a 2x2 tile.
  // Always single-board (the rule's own reasoning never crosses boards --
  // see hintRegionLineQuotaFill's comment), so this draws on exactly one
  // board's grid, found via a representative cell at the line's start.
  p._applyLineHighlight = function ({ boardIdx, axis, index, color }) {
    const repIdx = axis === 'row' ? index * this.n : index;
    const cell = this._getCellsByIndex(repIdx)[boardIdx];
    const grid = cell?.parentElement;
    if (!grid) return;

    const outline = document.createElement('div');
    outline.className = `line-highlight line-highlight-${color}`;
    if (axis === 'row') {
      outline.style.top = `calc(${index} * var(--cell-size))`;
      outline.style.left = '0';
      outline.style.width = `calc(${this.n} * var(--cell-size))`;
      outline.style.height = 'var(--cell-size)';
    } else {
      outline.style.top = '0';
      outline.style.left = `calc(${index} * var(--cell-size))`;
      outline.style.width = 'var(--cell-size)';
      outline.style.height = `calc(${this.n} * var(--cell-size))`;
    }
    grid.appendChild(outline);
    if (!this._hintLineHighlightEls) this._hintLineHighlightEls = [];
    this._hintLineHighlightEls.push(outline);
  };

  p._clearLineHighlight = function () {
    if (!this._hintLineHighlightEls) return;
    for (const el of this._hintLineHighlightEls) el.remove();
    this._hintLineHighlightEls = [];
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
    this._clearLineHighlight();
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

  // Show/hide the duplicate control bar at the bottom of the page (the
  // "Buttons also on bottom" setting) -- handy on puzzles whose boards are
  // tall enough to scroll the top bar out of view. See #controls-bottom
  // in style.css for how the class actually toggles display.
  p._applyBottomControls = function (on) {
    document.body.classList.toggle('show-bottom-controls', on);
    // The bottom bar eats into the vertical space _recomputeBoardLayout
    // measures for the >=900px grid layout, so a live toggle needs to
    // reshuffle board sizing, not just its own visibility.
    this._recomputeBoardLayout();
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

    // Tab mode changes how many boards are ever visible at once (1,
    // instead of every board), which is exactly what the >=900px grid
    // layout sizes around -- recompute so a wide-screen player who turns
    // this on gets one big board instead of a small multi-board grid.
    // _renderBoards calls _applyTabMode unconditionally on every puzzle
    // load, so this also covers the initial per-puzzle sizing pass --
    // no separate call needed there.
    this._recomputeBoardLayout();
  };

  // --- Board Layout Sizing (>=900px row-wrapping grid) ---
  //
  // Below the min-width:900px breakpoint, #boards-wrapper stacks boards in
  // a single column and CSS alone sizes cells (see style.css's :root and
  // max-width:600px --cell-size formulas) -- each board just gets the full
  // available width, no board-count math needed.
  //
  // At >=900px, boards wrap into a row-by-row grid instead, and how many
  // fit per row depends on this puzzle's own N and board count against the
  // ACTUAL available box -- something a fixed vw/vh CSS formula can only
  // approximate (see the min-width:900px block's own comment for how that
  // used to go wrong: assuming a board-count-only "boards per row" guess,
  // e.g. ceil(sqrt(3)) = 2 for a 3-board puzzle, regardless of whether 3
  // boards might easily fit on one row at that size -- sizing for a
  // 2-row layout that then never actually renders, wasting space on both
  // axes). So this measures the real thing instead:
  //  - the real available width: #boards-wrapper's own clientWidth (already
  //    nets out page padding/max-width, unlike a vw guess),
  //  - the real available height: window.innerHeight minus #boards-wrapper's
  //    own getBoundingClientRect().top (nets out the ACTUAL rendered header
  //    and controls above it, not a guessed chrome-height constant) minus
  //    whatever's reserved below it (the bottom control bar, if the
  //    "Buttons also on bottom" setting is on, else a little breathing room),
  //  - the real column/row gaps, read live via getComputedStyle so this
  //    stays in sync if that CSS value ever changes.
  //
  // Then it decides how many boards sit per row from WIDTH ALONE: the
  // most that fit without any cell dropping below MIN_CELL. Only once
  // that's fixed does height come in, as a cap on cell size -- and only
  // when there's a single row of boards, since that's the only
  // arrangement where avoiding a page scroll is actually the goal; once
  // multiple rows are unavoidable, scrolling between them is normal (see
  // this function's own comment further down for why capping every row
  // was itself a bug). Row count never changes because of height. That
  // split matters, not just for clean code: an
  // earlier version picked whichever (per-row count, cell size) pair
  // MAXIMIZED cell size outright, height included, which is a
  // non-monotonic function of the available box -- e.g. dragging a
  // window's corner smaller shrinks both width and height together, and
  // 2-per-row can lose to 3-per-row purely because 2 rows' worth of
  // height stopped fitting, even though 3-per-row is narrower "progress"
  // in the wrong direction. That showed up as real, reported jank: boards
  // would jump from 3 per row to 2 mid-drag, then SNAP BACK to 3 the
  // moment the drag ended and the debounced recompute ran once more
  // against the final, smaller box. Width-only row-count avoids this
  // entirely -- it can only ever go DOWN as the window narrows, never
  // back up, regardless of what height is doing.
  //
  // "Actually fits" per row is computed the SAME way #boards-wrapper's
  // own flex-wrap will lay them out (available width / one board's
  // footprint, rounded down), so the assumed per-row count and the real
  // rendered one can't disagree the way the old ceil(sqrt(count)) guess
  // could. That also means no CSS layout change was needed here --
  // #boards-wrapper keeps its existing flex-wrap (including its nice
  // centered-last-row behavior); only the cell size fed into it changes.
  //
  // Tab mode only ever shows one board at a time, so it sizes as if
  // board count were 1 (one big board) rather than the puzzle's real
  // count -- see the call site in _applyTabMode above.
  //
  // Runs once per puzzle load (via _applyTabMode) and again on resize
  // (see setupGlobalListeners in input.js) and whenever the bottom
  // control bar's visibility changes (_applyBottomControls) -- both
  // affect the available box this measures.
  p._recomputeBoardLayout = function () {
    const wrapper = document.getElementById('boards-wrapper');
    if (!wrapper || !this.n || !this.regions) return;

    const root = document.documentElement;
    const DESKTOP_BREAKPOINT = 900; // matches style.css's min-width:900px
    if (window.innerWidth < DESKTOP_BREAKPOINT) {
      // Hand sizing back to the stacked-layout CSS formulas.
      root.style.removeProperty('--cell-size');
      root.style.removeProperty('--boards-per-row');
      return;
    }

    const isTabActive = document.body.classList.contains('tab-mode');
    const boardCount = isTabActive ? 1 : this.regions.length;

    const wrapperStyle = getComputedStyle(wrapper);
    const colGap = parseFloat(wrapperStyle.columnGap) || 0;
    const rowGap = parseFloat(wrapperStyle.rowGap) || 0;
    const availableWidth = wrapper.clientWidth;

    const bottomControls = document.getElementById('controls-bottom');
    const bottomVisible = bottomControls && getComputedStyle(bottomControls).display !== 'none';
    // 20px covers #controls-bottom's own margin-block; 24px is just
    // breathing room at the bottom of the page when it's hidden.
    const bottomReserve = bottomVisible
      ? bottomControls.getBoundingClientRect().height + 20
      : 24;
    const availableHeight = window.innerHeight - wrapper.getBoundingClientRect().top - bottomReserve;

    // Same (grid-n + 1) convention as the CSS formulas: always reserve the
    // row-label column's width/height, whether or not the "Axis labels"
    // setting is actually on, so toggling it doesn't reflow every board.
    const unitsPerBoard = this.n + 1;
    const MIN_CELL = 28;
    const MAX_CELL = 90; // sanity cap -- purely aesthetic/usability past this, not a space constraint
    const cellFromWidth = (perRow) => (availableWidth - (perRow - 1) * colGap) / perRow / unitsPerBoard;

    // Width alone decides perRow: the most boards that fit per row
    // without any cell dropping below MIN_CELL. Starting from
    // boardCount and counting down means the first candidate that
    // clears MIN_CELL is also the largest one that does.
    let perRow = 1;
    for (let candidate = boardCount; candidate >= 1; candidate--) {
      if (cellFromWidth(candidate) >= MIN_CELL) {
        perRow = candidate;
        break;
      }
    }

    // Height only ever caps cell size for that fixed row count -- it
    // never feeds back into perRow (see this function's comment for why).
    // But it only applies AT ALL when there's a single row: the point of
    // the cap is to keep one full row of boards from forcing a page
    // scroll to see the bottom of it, which stops being the relevant
    // question once boards are ALREADY going to need more than one row
    // -- at that point the player scrolls between rows regardless (same
    // as the stacked mobile layout, uncontroversially), so capping cell
    // size for a 2nd or 3rd row too just makes every board needlessly
    // tiny despite plenty of width being free next to them (a real
    // reported bug: at the width where 3 boards no longer fit even 2 per
    // row, each of the resulting 3 stacked single-board "rows" was
    // capped to roughly availableHeight/3, even though nothing else was
    // competing for that width).
    const rows = Math.ceil(boardCount / perRow);
    const cellFromHeight = rows === 1
      ? availableHeight / unitsPerBoard
      : Infinity;
    const cellSize = Math.max(MIN_CELL, Math.min(cellFromWidth(perRow), cellFromHeight, MAX_CELL));

    root.style.setProperty('--cell-size', `${Math.floor(cellSize)}px`);
    root.style.setProperty('--boards-per-row', perRow);
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
