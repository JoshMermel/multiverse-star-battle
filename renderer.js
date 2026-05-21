// Mixin for rendering logic (game state to DOM updates).

export function applyRenderer(GameClass) {
  const p = GameClass.prototype;

  // --- Board Construction ---

  // Render cell grid and SVG region borders for a board.
  p.renderBoard = function (id, regionMap) {
    const wrapper = document.getElementById(id);
    const grid = this._buildGrid();
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
    document.querySelectorAll('.cell').forEach(cell => {
      this.updateCellVisual(cell, this.state[cell.dataset.index]);
    });
  };

  // Sync cell hover state across boards.
  p._setHoverSync = function (idx, on) {
    document.querySelectorAll(`.cell[data-index="${idx}"]`).forEach(cell => {
      cell.classList.toggle('cell-hover-sync', on);
    });
  };

  // --- Error Highlights ---

  p._applyErrorHighlights = function (errorIndices) {
    document.querySelectorAll('.cell').forEach(cell => {
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
  p.applyHintUI = function (hint) {
    const selectors = (hint.boardIdx !== undefined)
      ? [`#board${hint.boardIdx + 1}`]
      : ['#board1', '#board2'];

    for (const { idx, color } of [...hint.highlights, ...hint.marks]) {
      for (const sel of selectors) {
        const cell = document.querySelector(`${sel} [data-index="${idx}"]`);
        if (cell) cell.classList.add(color);
      }
    }

    // Switch active board tab if hint is board-specific.
    if (document.body.classList.contains('tab-mode') && hint.boardIdx !== undefined) {
      this._showBoard(hint.boardIdx + 1);
    }

    this.showToast(hint.description, "hint", 30000);
  };

  // Clear active hint highlights.
  p.clearHintUI = function () {
    document.querySelectorAll('.cell').forEach(cell => {
      cell.classList.remove('hint-source-blue', 'hint-target-yellow', 'hint-target-green', 'hint-error-red');
    });
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

  // --- Global UI State ---

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

    // Bind tab click handlers.
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
