import { PuzzleSolver } from './solver.js';
import { CELL } from './constants.js';

class StarBattleGame {
  // ────────────────────── 
  // ─── Initialisation ─── 
  // ────────────────────── 

  // Bootstraps the game: sets up global input handling then fetches puzzle data
  constructor() {
    this.puzzleCache = new Map();
    this.categories = [];
    this.loadedPuzzles = [];
    // Listener setup must run before initGame so they exist during puzzle load
    this.setupGlobalListeners();
    document.addEventListener('DOMContentLoaded', () => this.initGame());
  }

  // Fetches the manifest, populates the category menu, and loads the initial
  // puzzle.
  async initGame() {
    try {
      const resp = await fetch('data/manifest.json');
      const data = await resp.json();
      this.categories = data.categories;

      this.setupMenu();
      this.setupControls();
      this.setupHelpModal();
      this.setupResetModal();

      const catSelect = document.getElementById('category-select');
      if (this.categories.length > 0) {
        const { catId, puzNum } = this.readUrlParams();

        // Use URL cat if it exists in the manifest, otherwise fall back to first
        const validCat = this.categories.find(c => c.id === catId);
        catSelect.value = validCat ? validCat.id : this.categories[0].id;

        // Dispatch with the desired puzzle number attached so
        // catSelect.onchange can read it.
        catSelect.dispatchEvent(new CustomEvent('change', { detail: { targetPuz: puzNum } }));

      }
    } catch (e) {
      console.error(e);
      this.showToast("Failed to load game data", "error");
    }
  }

  // Wires up the main game action buttons. Called once after the DOM is ready.
  setupControls() {
    document.getElementById('undo-btn').onclick = () => this.undo();
    document.getElementById('redo-btn').onclick = () => this.redo();
    document.getElementById('check-btn').onclick = () => this.checkCorrectness();
    document.getElementById('hint-btn').onclick = () => this.getHint();
  }

  // Creates open/close behaviour for a modal: close button(s), backdrop click,
  // Escape key, and an optional confirm action. Returns { open, close } handles.
  setupModal(modalId, { onConfirm } = {}) {
    const modal = document.getElementById(modalId);
    const close = () => modal.classList.add('modal-hidden');
    const open  = () => modal.classList.remove('modal-hidden');

    modal.querySelectorAll('[data-close]').forEach(btn => btn.onclick = close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !modal.classList.contains('modal-hidden')) close();
    });
    if (onConfirm) {
      document.getElementById(`${modalId}-confirm-btn`).onclick = () => {
        close();
        onConfirm();
      };
    }
    return { open, close };
  }

  // Sets up open/close behaviour for the instructions modal.
  setupHelpModal() {
    const { open } = this.setupModal('help-modal');
    document.getElementById('help-btn').onclick = open;
  }

  // Sets up open/close behaviour for the board-clearing confirmation modal.
  setupResetModal() {
    const { open } = this.setupModal('reset-modal', { onConfirm: () => this.doReset() });
    document.getElementById('reset-btn').onclick = open;
  }

  // Returns true if catId refers to the special daily puzzle category.
  isDailyCategory(catId) {
    return catId === 'daily';
  }

  // Returns today's 0-based puzzle index by counting days since the Unix epoch
  // and wrapping around the available pool. This is stable for the whole day
  // regardless of when the page is loaded, and cycles forever as new puzzles
  // are added.
  getDailyPuzzleIndex(total) {
    // 1. Get the current time in Boston as a string (YYYY-MM-DD)
    const bostonDateStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());

    // 2. Convert that date string into a timestamp representing 
    // midnight of that day in the local system.
    // Note: 'en-CA' gives YYYY-MM-DD which Date() parses reliably.
    const midnightBoston = new Date(bostonDateStr).getTime();

    // 3. Calculate days since epoch based on that specific midnight
    const msPerDay = 24 * 60 * 60 * 1000;
    const daysSinceEpoch = Math.floor(midnightBoston / msPerDay);

    return daysSinceEpoch % total;
  }

  // Fetches daily.json, selects today's puzzle by date, loads it, and hides
  // the puzzle-navigation controls (prev/next/input) since there is only one
  // puzzle to show.
  async loadDailyCategory() {
    if (!this.puzzleCache.has('daily')) {
      const resp = await fetch('data/daily.csv');
      this.puzzleCache.set('daily', this.parseCsv(await resp.text()));
    }
    this.loadedPuzzles = this.puzzleCache.get('daily');
    const total = this.loadedPuzzles.length;
    const idx = this.getDailyPuzzleIndex(total);

    this._setPuzzleNavVisible(false);
    await this.loadPuzzle(this.loadedPuzzles[idx], 'daily');
  }

  // Parses the CSV format produced by gen_puzzles.py into an array of puzzle
  // objects. Expects a header row of: name,N,board_1,board_2,solution
  // Lines beginning with '#' (generator progress comments) are skipped.
  parseCsv(text) {
    const lines = text.split('\n');
    const puzzles = [];
    let id = 1;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const cols = line.split(',');
      // Skip the header row
      if (cols[0] === 'name') continue;
      const [name, N, board_1, board_2, solution, score, tier, is_solved] = cols;
      if (!name || !N || !board_1 || !board_2 || !solution) continue;
      puzzles.push({ id: id++, name, N: parseInt(N, 10), board1: board_1, board2: board_2, solution });
    }
    return puzzles;
  }

  // Fetches puzzles for a category, updates the nav UI, and loads the target puzzle.
  // targetPuz is clamped to the valid range automatically.
  async loadCategory(catId, targetPuz = 1) {
    if (this.isDailyCategory(catId)) {
      await this.loadDailyCategory();
      return;
    }

    const puzInput = document.getElementById('puzzle-input');
    const countLabel = document.getElementById('puzzle-count-label');

    if (!this.puzzleCache.has(catId)) {
      const response = await fetch(`data/${catId}.csv`);
      this.puzzleCache.set(catId, this.parseCsv(await response.text()));
    }
    this.loadedPuzzles = this.puzzleCache.get(catId);
    const total = this.loadedPuzzles.length;

    puzInput.max = total;
    countLabel.textContent = `of ${total}`;

    const clampedPuz = Math.max(1, Math.min(targetPuz, total));
    puzInput.value = clampedPuz;

    this._setPuzzleNavVisible(true);
    await this.loadPuzzle(this.loadedPuzzles[clampedPuz - 1], catId);
  }

  // Shows or hides the puzzle number input and prev/next buttons.
  // Called when switching between the daily category (no nav) and normal books.
  _setPuzzleNavVisible(visible) {
    document.querySelector('.puzzle-nav').style.visibility = visible ? '' : 'hidden';
  }

  setupMenu() {
    const catSelect = document.getElementById('category-select');
    const puzInput = document.getElementById('puzzle-input');
    const prevBtn = document.getElementById('prev-puz');
    const nextBtn = document.getElementById('next-puz');

    // Populate Categories.
    // Categories with no "group" field (e.g. Daily) are appended first as plain
    // options. The rest are grouped into <optgroup> elements, one per unique
    // group label, preserving manifest order within each group.
    const groups = new Map(); // group label -> <optgroup>
    this.categories.forEach(cat => {
      const opt = document.createElement('option');
      opt.value = cat.id;
      opt.textContent = cat.label;
      if (!cat.group) {
        catSelect.appendChild(opt);
      } else {
        if (!groups.has(cat.group)) {
          const og = document.createElement('optgroup');
          og.label = cat.group;
          catSelect.appendChild(og);
          groups.set(cat.group, og);
        }
        groups.get(cat.group).appendChild(opt);
      }
    });
    catSelect.onchange = async (e) => {
      const catId = e.target.value;
      if (!catId) return;
      this.setLoading(true);
      try {
        await this.loadCategory(catId, e.detail?.targetPuz ?? 1);
      } catch (err) {
        this.showToast("Could not load category", "error");
        console.error(err);
      } finally {
        this.setLoading(false);
      }
    };

    const commitPuzzleSelection = async () => {
      let val = parseInt(puzInput.value, 10);
      const catId = catSelect.value;
      if (isNaN(val)) val = 1;

      // Skip if the requested puzzle is already loaded
      if (this.currentCategoryId === catId &&
        this.currentPuzzle?.id === val) return;

      this.setLoading(true);
      try {
        await this.loadCategory(catId, val);
      } finally {
        this.setLoading(false);
      }
    };

    const stepPuzzle = (delta) => {
      let val = parseInt(puzInput.value) || 1;
      puzInput.value = val + delta;
      commitPuzzleSelection();
    };
    prevBtn.onpointerdown = (e) => {
      e.preventDefault();
      stepPuzzle(-1);
    };
    nextBtn.onpointerdown = (e) => {
      e.preventDefault();
      stepPuzzle(1);
    };

    puzInput.addEventListener('input', (e) => {
      // Fire immediately for spinner arrow clicks; wait for Enter when typing.
      if (e.inputType === undefined || e.inputType === 'insertReplacementText') {
        commitPuzzleSelection();
      }
    });

    puzInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitPuzzleSelection();
        puzInput.blur(); // Remove focus after selection
      }
    });

    // Also commit if the user clicks out of the box
    puzInput.addEventListener('blur', () => {
      commitPuzzleSelection();
    });
  }

  // Attaches window-level listeners that persist for the lifetime of the app.
  // Must be called before any puzzle loads.
  setupGlobalListeners() {
    window.addEventListener('pointerup', () => {
      if (this.isDragging) {
        // If dragStartIdx is still set, the user never dragged off the cell,
        // so commit the pending state change now.
        if (this.dragStartIdx !== undefined && this.dragStartNext !== undefined) {
          this.applyState(this.dragStartIdx, this.dragStartNext);
        }
        if (this.hasChangedDuringDrag) this.saveHistory();
        this.isDragging = false;
        this.hasChangedDuringDrag = false;
      }
      this.dragStartIdx = undefined;
      this.dragStartPrev = undefined;
      this.dragStartNext = undefined;
      this.clearHintUI();
    });
  }

  // Disables navigation controls and fades the boards while a puzzle fetch is
  // in flight.
  setLoading(isLoading) {
    const ids = ['prev-puz', 'next-puz', 'puzzle-input', 'category-select',
      'hint-btn', 'check-btn', 'reset-btn'];
    ids.forEach(id => document.getElementById(id).disabled = isLoading);
    const boardsWrapper = document.getElementById('boards-wrapper');
    boardsWrapper.style.opacity = isLoading ? '0.4' : '1';
    boardsWrapper.style.pointerEvents = isLoading ? 'none' : '';
  }

  // ────────────────────── 
  // ─── Puzzle Loading ─── 
  // ────────────────────── 

  // Hashes puzzle content to a stable 16-char hex ID for localStorage keying.
  // Using content rather than puzzle name means renamed puzzles don't lose
  // progress.
  async computePuzzleId(puzzleData) {
    const stable = JSON.stringify({
      board1: puzzleData.board1,
      board2: puzzleData.board2,
      solution: puzzleData.solution,
    });
    const hashBuffer = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(stable)
    );
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex.slice(0, 16); // 16 hex chars = 64 bits, plenty unique
  }

  // Initialises all game state for a new puzzle and re-renders both boards.
  async loadPuzzle(puzzleData, categoryId) {
    this.currentPuzzleUniqueId = await this.computePuzzleId(puzzleData);
    this.currentCategoryId = categoryId;
    this.currentPuzzle = puzzleData;

    this.n = puzzleData.N;
    this.solution = puzzleData.solution;
    this.regions = [puzzleData.board1, puzzleData.board2];

    this.state = new Array(this.n * this.n).fill(CELL.NONE);
    this.history = [JSON.stringify(this.state)];
    this.historyIdx = 0;

    document.getElementById('board1').innerHTML = '';
    document.getElementById('board2').innerHTML = '';
    document.documentElement.style.setProperty('--grid-n', this.n);

    this.renderBoard('board1', this.regions[0]);
    this.renderBoard('board2', this.regions[1]);
    this.updateVisuals();

    this.showToastOnLoad(categoryId, puzzleData.id);
    this.loadProgress({ suppressWinToast: true });
    this.updateControls();
    this.updateUrlParams(categoryId, puzzleData.id);

    this.solver = new PuzzleSolver(this);
  }

  showToastOnLoad(catId, puzId) {
    if (this.isDailyCategory(catId)) {
      const today = new Date().toLocaleDateString(undefined, { 
        month: 'long', 
        day: 'numeric' 
      });
      this.showToast(`Playing the Daily Puzzle for ${today}`);
    } else {
      this.showToast(`Playing Puzzle ${puzId}`, "info");
    }
  }

  // Builds the cell grid and SVG region borders for one board.
  renderBoard(id, regionMap) {
    const wrapper = document.getElementById(id);
    wrapper.appendChild(this._buildGrid());
    wrapper.appendChild(this._buildRegionSvg(regionMap));
  }

  // Creates the interactive grid div with all pointer event handlers attached.
  _buildGrid() {
    const grid = document.createElement('div');
    grid.className = 'star-battle-grid';
    grid.style.width = 'fit-content';
    grid.style.gridTemplateColumns = `repeat(${this.n}, var(--cell-size))`;
    grid.oncontextmenu = (e) => e.preventDefault();

    for (let i = 0; i < this.n * this.n; i++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.index = i;
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
      // pointerover doesn't fire on touch during drag, so fall back to elementFromPoint.
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
  }

  // Creates the SVG overlay that draws thick borders between regions.
  _buildRegionSvg(regionMap) {
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
  }

  // ────────────────── 
  // ─── Game State ─── 
  // ────────────────── 

  // Handles the initial pointer-down on a cell. Right-click toggles a star
  // directly; left-click cycles none -> dot -> star -> none and begins a drag
  // session.
  handleStart(idx, isRightClick) {
    this.hideToast();
    this.isDragging = true;

    if (isRightClick) {
      this.applyState(idx, this.state[idx] === CELL.STAR ? CELL.NONE : CELL.STAR);
      this.saveHistory();
      this.isDragging = false;
    } else {
      const current = this.state[idx];

      if (current === CELL.STAR) {
        this.applyState(idx, CELL.NONE);
        this.saveHistory();
        this.isDragging = false;
        return;
      }

      const next = current === CELL.NONE ? CELL.DOT : CELL.STAR;
      this.dragStartIdx = idx;
      this.dragStartPrev = current;
      this.dragStartNext = next;

      if (next !== CELL.STAR) {
        this.applyState(idx, next);
      }
    }
  }

  // Paints a dot on any empty cell the pointer passes over during a drag.
  handleDrag(idx) {
    if (!this.isDragging) return;

    // If there's a pending star promotion and the user dragged elsewhere, cancel it.
    if (this.dragStartIdx !== undefined && idx !== this.dragStartIdx) {
      this.dragStartIdx = undefined;
    }

    if (this.state[idx] === CELL.NONE) {
      this.applyState(idx, CELL.DOT);
    }
  }

  // Applies a state change to one cell, updates its visual, validates the
  // board, and persists to localStorage.
  applyState(idx, type) {
    if (this.state[idx] === type) return;
    this.state[idx] = type;
    this.hasChangedDuringDrag = true;
    document.querySelectorAll(`.cell[data-index="${idx}"]`).forEach(cell => {
      this.updateCellVisual(cell, type);
    });
    this.validate();
    this.saveCurrentState();
  }

  // Returns true if every solution star is placed and no extra stars exist.
  // Empty cells and dots are ignored — the puzzle is solved even with blank
  // squares.
  isSolved() {
    return this.state.every((v, i) => (this.solution[i] === 'x') ? v === CELL.STAR : v !== CELL.STAR);
  }

  // Returns the set of cell indices involved in adjacency violations.
  _getAdjacentErrorIndices() {
    const n = this.n;
    const errors = new Set();
    for (let i = 0; i < n * n; i++) {
      if (this.state[i] !== CELL.STAR) continue;
      const r = Math.floor(i / n), c = i % n;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < n && nc >= 0 && nc < n) {
            const nb = nr * n + nc;
            if (this.state[nb] === CELL.STAR) { errors.add(i); errors.add(nb); }
          }
        }
      }
    }
    return errors;
  }

  // Highlights obvious rule violations in real time.
  validate({ suppressWinToast = false } = {}) {
    const n = this.n;
    const errorIndices = new Set();

    const checkGroup = (indices) => {
      const stars = indices.filter(i => this.state[i] === CELL.STAR);
      const allDots = indices.every(i => this.state[i] === CELL.DOT);
      // Highlight if more than 1 star or if group is impossible (all dots)
      if (stars.length > 1 || allDots) {
        indices.forEach(i => errorIndices.add(i));
      }
    };

    // Check rows and columns
    for (let i = 0; i < n; i++) {
      checkGroup(Array.from({length: n}, (_, k) => i * n + k));
      checkGroup(Array.from({length: n}, (_, k) => k * n + i));
    }

    // Check regions for both boards
    this.regions.forEach(regionString => {
      const regionIds = [...new Set(regionString.split(''))];
      regionIds.forEach(id => {
        const indices = [];
        for (let j = 0; j < regionString.length; j++) {
          if (regionString[j] === id) indices.push(j);
        }
        checkGroup(indices);
      });
    });

    // Check adjacency
    for (const idx of this._getAdjacentErrorIndices()) {
      errorIndices.add(idx);
    }

    // Update error highlights
    document.querySelectorAll('.cell').forEach(cell => {
      const idx = parseInt(cell.dataset.index);
      cell.classList.toggle('error-cell', errorIndices.has(idx));
    });

    // Win check
    if (this.isSolved() && errorIndices.size === 0) {
      this.markAsSolved();
      if (!suppressWinToast) {
        this.showToast("🏆 Perfect! You've solved the Multiverse Star Battle!", "win", 15000);
      }
    }
  }

  // ─────────────── 
  // ─── History ─── 
  // ─────────────── 

  // Appends the current state to the undo history, truncating any undone future
  saveHistory() {
    const snap = JSON.stringify(this.state);
    // Deduplicate: skip if state hasn't actually changed since the last snapshot.
    if (snap === this.history[this.historyIdx]) return;

    this.history = this.history.slice(0, this.historyIdx + 1);
    this.history.push(snap);
    this.historyIdx++;
    this.updateControls()
  }

  // Steps back one entry in undo history.
  undo() {
    this.hideToast();
    if (this.historyIdx > 0) {
      this.historyIdx--;
      this.state = JSON.parse(this.history[this.historyIdx]);
      this.updateVisuals();
      this.validate();
      this.updateControls();
    }
  }

  // Steps forward one entry in undo history.
  redo() {
    this.hideToast();
    if (this.historyIdx < this.history.length - 1) {
      this.historyIdx++;
      this.state = JSON.parse(this.history[this.historyIdx]);
      this.updateVisuals();
      this.validate();
      this.updateControls();
    }
  }


  // ─────────────────── 
  // ─── Persistence ─── 
  // ─────────────────── 

  // Stable localStorage key for this puzzle's cell state.
  get stateKey() { return `sb_state_${this.currentPuzzleUniqueId}`; }

  // Shared localStorage key for the set of all solved puzzle IDs.
  get solvedKey() { return 'sb_solved'; }

  // Persists the current cell state to localStorage under the puzzle's unique
  // ID.
  saveCurrentState() {
    localStorage.setItem(this.stateKey, JSON.stringify(this.state));
  }

  // Restores saved cell state from localStorage if it exists, then syncs all UI
  loadProgress({ suppressWinToast = false } = {}) {
    const savedState = localStorage.getItem(this.stateKey);
    if (savedState) {
      this.state = JSON.parse(savedState);
      this.history = [JSON.stringify(this.state)];
      this.historyIdx = 0;
      this.updateVisuals();
      this.validate({ suppressWinToast });
    }
    this.updateControls();
    this.updateSolvedUI();
  }

  // Records this puzzle as solved in localStorage and updates the solved badge.
  markAsSolved() {
    const solved = JSON.parse(localStorage.getItem(this.solvedKey) || '[]');
    if (!solved.includes(this.currentPuzzleUniqueId)) {
      solved.push(this.currentPuzzleUniqueId);
      localStorage.setItem(this.solvedKey, JSON.stringify(solved));
    }
    this._updateSolvedBadge(solved);
  }

  // Shows or hides the ✅ badge based on whether this puzzle is recorded as solved.
  updateSolvedUI() {
    const solved = JSON.parse(localStorage.getItem(this.solvedKey) || '[]');
    this._updateSolvedBadge(solved);
  }

  // Sets the solved badge opacity from an already-fetched solved list.
  _updateSolvedBadge(solved) {
    const badge = document.getElementById('solved-badge');
    badge.style.opacity = solved.includes(this.currentPuzzleUniqueId) ? '1' : '0';
  }

  // ────────────────────── 
  // ─── UI & Rendering ─── 
  // ────────────────────── 

  // Updates a single cell's DOM to reflect its current state value.
  updateCellVisual(cell, val) {
    cell.innerHTML = val === CELL.STAR ? '<span class="star">★</span>'
      : val === CELL.DOT ? '<div class="dot"></div>'
      : '';
  }

  // Re-renders all cells on both boards to match the current state array.
  updateVisuals() {
    document.querySelectorAll('.cell').forEach(cell => {
      this.updateCellVisual(cell, this.state[cell.dataset.index]);
    });
  }

  // Enables or disables undo/redo buttons based on current history position.
  updateControls() {
    const undoBtn = document.getElementById('undo-btn');
    const redoBtn = document.getElementById('redo-btn');
    undoBtn.disabled = (this.historyIdx === 0);
    redoBtn.disabled = (this.historyIdx >= this.history.length - 1);
  }

  // Clears all cell state and resets history after the user confirms reset.
  doReset() {
    this.hideToast();
    this.state.fill(CELL.NONE);
    this.history = [JSON.stringify(this.state)];
    this.historyIdx = 0;
    this.clearHintUI();
    this.updateVisuals();
    this.updateControls();
    this.validate();
    this.saveCurrentState();
  }

  // ──────────────
  // ─── Hints ─── 
  // ──────────────

  // Asks the solver for the next hint and either displays it or shows a
  // fallback toast.
  getHint() {
    const hint = this.solver.getHint();
    if (hint) {
      this.applyHintUI(hint);
    } else {
      this.showToast("No hints found!", "info");
    }
  }

  // Applies highlight and mark classes to cells based on a hint object,
  // and shows the hint description as a toast.
  applyHintUI(hint) {
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

    this.showToast(hint.description, "hint", 30000);
  }

  // Removes all hint highlight classes from every cell on both boards.
  clearHintUI() {
    document.querySelectorAll('.cell').forEach(cell => {
      cell.classList.remove('hint-source-blue', 'hint-target-yellow', 'hint-target-green', 'hint-error-red');
    });
  }

  // ─────────────────
  // ─── Feedback ─── 
  // ─────────────────

  // Displays a dismissible notification at the bottom of the screen.
  // Clears any previous toast type before applying the new one.
  showToast(message, type = 'info', duration = 2000) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = '';
    toast.classList.add(`toast-${type}`);
    this.toastBirthTime = Date.now();

    toast.classList.remove('toast-hidden');
    toast.onclick = () => {
      if (Date.now() - this.toastBirthTime < 500) {
        return;
      }
      toast.classList.add('toast-hidden');
    };
    clearTimeout(this.toastTimeout);
    this.toastTimeout = setTimeout(() => {
      toast.classList.add('toast-hidden');
    }, duration);
  }
  hideToast() {
    document.getElementById('toast').classList.add('toast-hidden');
  }

  // Checks the user's current placements against the solution and shows a toast
  // with the result. Only considers filled cells (dots and stars), not empty
  // ones.
  checkCorrectness() {
    let errorCount = 0;
    let filledCount = 0;

    for (let i = 0; i < this.n * this.n; i++) {
      const userState = this.state[i]; // CELL.NONE, CELL.STAR, or CELL.DOT
      const isSolutionStar = (this.solution[i] === 'x');

      if (userState === CELL.NONE) continue;

      filledCount++;
      if ((userState === CELL.STAR && !isSolutionStar) || (userState === CELL.DOT && isSolutionStar)) {
        errorCount++;
      }
    }

    if (filledCount === 0) {
      this.showToast("The board is empty!", "info");
    } else if (errorCount > 0) {
      const squareText = errorCount === 1 ? "square is" : "squares are";
      this.showToast(`${errorCount} ${squareText} incorrect.`, "error");
    } else if (this.isSolved()) {
      this.showToast("You already solved the puzzle!", "win");
    } else {
      this.showToast("So far so good!", "success");
    }
  }

  // ────────────
  // ─── URL ─── 
  // ────────────

  // Reads ?book= and ?puzzle= from the URL.
  // Returns safe defaults if absent or invalid.
  readUrlParams() {
    const params = new URLSearchParams(window.location.search);
    return {
      catId: params.get('book'),
      puzNum: parseInt(params.get('puzzle'), 10) || 1,
    };
  }

  // Updates the URL bar to reflect the current puzzle without adding a browser
  // history entry. For the daily category, omits ?puzzle= since the date is
  // the implicit selector and a puzzle number in the URL would be misleading.
  updateUrlParams(catId, puzNum) {
    const params = new URLSearchParams();
    params.set('book', catId);
    if (!this.isDailyCategory(catId)) params.set('puzzle', puzNum);
    window.history.replaceState(null, '', `?${params.toString()}`);
  }
}

new StarBattleGame();
