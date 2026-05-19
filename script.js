import { PuzzleSolver } from './solver.js';
import { CELL } from './constants.js';
import { storageManager } from './storage.js';
import { applyRenderer } from './renderer.js';
import { applyInput } from './input.js';

class StarBattleGame {
  // ────────────────────── 
  // ─── Initialisation ─── 
  // ────────────────────── 

  // Bootstraps the game: sets up global input handling then fetches puzzle data
  constructor() {
    // Expose shared singletons so renderer.js and input.js can reach them
    // without importing directly (keeps those files free of top-level imports).
    this._deps = { storageManager };
    this._constants = { CELL };

    this.puzzleCache = new Map();
    this.categories = [];
    this.loadedPuzzles = [];
    this.draggedIndices = [];
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
      this.groups = data.groups ?? {};

      this.setupMenu();
      this.setupControls();
      this.setupHelpModal();
      this.setupResetModal();

      const catSelect = document.getElementById('category-select');
      if (this.categories.length > 0) {
        const { catId, puzNum } = this.readUrlParams();

        // If the URL names a manifest category, load it normally via the
        // select. If it names an arbitrary data/ CSV (but not a daily_*
        // file, which is gated to one-per-day), load it directly. Otherwise
        // fall back to the first manifest category.
        const manifestCat = this.categories.find(c => c.id === catId);
        const isArbitraryCsv = catId && !manifestCat && !catId.startsWith('daily_');

        if (isArbitraryCsv) {
          await this.loadCategory(catId, puzNum);
        } else {
          catSelect.value = manifestCat ? manifestCat.id : this.categories[0].id;
          catSelect.dispatchEvent(new CustomEvent('change', { detail: { targetPuz: puzNum } }));
        }
      }
    } catch (e) {
      console.error(e);
      this.showToast("Failed to load game data", "error");
    }
  }

  // ────────────────────────────────────────
  // ─── Daily & Category / Puzzle Loading ───
  // ────────────────────────────────────────

  // Returns true if catId refers to the special daily puzzle category.
  isDailyCategory(catId) {
    return catId === 'daily';
  }

  // Returns true if today is Sunday in the Boston timezone.
  isSunday() {
    const day = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
    }).format(new Date());
    return day === 'Sun';
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
  async loadDailyCategory(targetSlot = 1) {
    if (!this.puzzleCache.has('daily')) {
      const isSunday = this.isSunday();

      // Fetch beginner/medium/hard in parallel; add expert on Sundays only.
      const fetches = [
        fetch('data/daily_beginner.csv').then(r => r.text()),
        fetch('data/daily_medium.csv').then(r => r.text()),
        fetch('data/daily_hard.csv').then(r => r.text()),
        ...(isSunday ? [fetch('data/daily_expert.csv').then(r => r.text())] : []),
      ];
      const texts = await Promise.all(fetches);

      const tierDefs = [
        { label: 'Beginner', text: texts[0] },
        { label: 'Medium', text: texts[1] },
        { label: 'Hard', text: texts[2] },
        ...(isSunday ? [{ label: 'Expert', text: texts[3] }] : []),
      ];

      const dailyPuzzles = tierDefs.map(({ label, text }) => {
        const puzzles = this.parseCsv(text);
        return {
          ...puzzles[this.getDailyPuzzleIndex(puzzles.length)],
          dailyLabel: label,
        };
      });

      this.puzzleCache.set('daily', dailyPuzzles);
    }

    this.loadedPuzzles = this.puzzleCache.get('daily');
    const total = this.loadedPuzzles.length;

    const puzInput = document.getElementById('puzzle-input');
    puzInput.max = total;
    const clampedSlot = Math.max(1, Math.min(targetSlot, total));
    puzInput.value = clampedSlot;
    document.getElementById('puzzle-count-label').textContent = `of ${total}`;

    await this._loadDailyPuzzleBySlot(clampedSlot);
  }

  async _loadDailyPuzzleBySlot(slot) {
    const puzzle = this.loadedPuzzles[slot - 1];
    await this.loadPuzzle(puzzle, 'daily');
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
      puzzles.push({ id: id++, name, N: parseInt(N, 10), board1: board_1, board2: board_2, solution, tier: tier || '' });
    }
    return puzzles;
  }

  // Fetches puzzles for a category, updates the nav UI, and loads the target puzzle.
  // targetPuz is clamped to the valid range automatically.
  async loadCategory(catId, targetPuz = 1) {
    if (this.isDailyCategory(catId)) {
      await this.loadDailyCategory(targetPuz);
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

    await this.loadPuzzle(this.loadedPuzzles[clampedPuz - 1], catId);
  }

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
        month: 'long', day: 'numeric'
      });
      const label = this.currentPuzzle?.dailyLabel ?? '';
      const sundayNote = label === 'Expert' ? ' ☀️ Sundays only' : '';
      this.showToast(`Daily ${label} — ${today}${sundayNote}`);
    } else {
      this.showToast(`Playing Puzzle ${puzId}`, "info");
    }
  }

  // ────────────────── 
  // ─── Game State ─── 
  // ────────────────── 

  // Handles the initial pointer-down on a cell. Right-click toggles a star
  // directly; left-click cycles none -> dot -> star -> none and begins a drag
  // session.
  handleStart(idx, isRightClick) {
    const toast = document.getElementById('toast');
    const isWinToast = toast.classList.contains('toast-win') &&
      !toast.classList.contains('toast-hidden');
    if (!isWinToast) this.hideToast();
    this.isDragging = true;

    if (isRightClick) {
      document.querySelectorAll(`.cell[data-index="${idx}"]`).forEach(cell => {
        cell.classList.add('cell-drag-highlight');
      });
      this.applyState(idx, this.state[idx] === CELL.STAR ? CELL.NONE : CELL.STAR);
      this.saveHistory();
      this.isDragging = false;
      setTimeout(() => {
        document.querySelectorAll(`.cell[data-index="${idx}"]`).forEach(cell => {
          cell.classList.remove('cell-drag-highlight');
        });
      }, 80);
    } else {
      this.draggedIndices = [idx];
      document.querySelectorAll(`.cell[data-index="${idx}"]`).forEach(cell => {
        cell.classList.add('cell-drag-highlight');
      });
    }
  }

  // Paints a dot on any empty cell the pointer passes over during a drag.
  handleDrag(idx) {
    if (!this.isDragging || this.draggedIndices.includes(idx)) return;
    this.draggedIndices.push(idx);
    document.querySelectorAll(`.cell[data-index="${idx}"]`).forEach(cell => {
      cell.classList.add('cell-drag-highlight');
    });
  }

  _commitDrag() {
    if (!this.draggedIndices || this.draggedIndices.length === 0) return;

    if (this.draggedIndices.length === 1) {
      const idx = this.draggedIndices[0];
      const current = this.state[idx];
      if (current === CELL.STAR) {
        this.applyState(idx, CELL.NONE);
      } else {
        const next = current === CELL.NONE ? CELL.DOT : CELL.STAR;
        this.applyState(idx, next);
      }
    } else {
      for (const idx of this.draggedIndices) {
        if (this.state[idx] === CELL.NONE) {
          this.applyState(idx, CELL.DOT, { suppressWinToast: true, debounceMs: 0 }); // suppress mid-drag; drag is unambiguous
        }
      }
      // One final validate after all cells are committed, with win toast allowed
      this.validate();
    }

    this.saveHistory();
    this.draggedIndices = [];
  }

  clearDragHighlights() {
    document.querySelectorAll('.cell-drag-highlight').forEach(cell => {
      cell.classList.remove('cell-drag-highlight');
    });
  }

  // Applies a state change to one cell, updates its visual, validates the
  // board, and persists to localStorage.
  applyState(idx, type, { suppressWinToast = false, debounceMs } = {}) {
    if (this.state[idx] === type) return;
    this.state[idx] = type;
    document.querySelectorAll(`.cell[data-index="${idx}"]`).forEach(cell => {
      this.updateCellVisual(cell, type);
    });
    // If the caller didn't specify, infer: dots may be the first click of a
    // double-click so delay errors; stars and removals are unambiguous.
    const delay = debounceMs ?? (type === CELL.DOT ? 200 : 0);

    // Auto-fill: when a star is placed (and not already in a recursive call),
    // dot every empty cell in the same row, col, and region on both boards.
    if (type === CELL.STAR && !this._suppressAutoFill &&
      localStorage.getItem('setting-auto-fill-dots') === 'true') {
      this._suppressAutoFill = true;
      this._autoFillDots(idx);
      this._suppressAutoFill = false;
    }

    this.validate({ suppressWinToast, debounceMs: delay });
    this.saveCurrentState();
  }

  // Dots every CELL.NONE cell that shares a row, column, or region with the
  // star just placed at `idx`. Operates on the shared state (both boards see
  // the same state array), so the fill naturally appears on both boards.
  // Called only while _suppressAutoFill is true, so no recursion occurs.
  _autoFillDots(idx) {
    const n = this.n;
    const row = Math.floor(idx / n);
    const col = idx % n;

    // Collect the union of cells to dot: entire row, entire col, entire region.
    // The region is defined by `this.regions[0]` — both boards share regions
    // that map to the same logical groups (they may differ visually but the
    // region id at each index is what matters for the rule).
    const regionId = this.regions[0][idx];
    const toFill = new Set();

    for (let i = 0; i < n * n; i++) {
      const r = Math.floor(i / n), c = i % n;
      if (r === row || c === col || this.regions[0][i] === regionId) {
        toFill.add(i);
      }
    }

    // Also apply the region from board 2 (in case the two boards have
    // different region groupings at this index).
    const regionId2 = this.regions[1][idx];
    for (let i = 0; i < n * n; i++) {
      if (this.regions[1][i] === regionId2) toFill.add(i);
    }

    // Also dot all 8 cells adjacent to the star (orthogonal and diagonal),
    // since stars can never touch each other even diagonally.
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = row + dr, nc = col + dc;
        if (nr >= 0 && nr < n && nc >= 0 && nc < n) {
          toFill.add(nr * n + nc);
        }
      }
    }

    // Dot only empty cells; never overwrite a star (including the one just placed).
    for (const i of toFill) {
      if (this.state[i] === CELL.NONE) {
        this.state[i] = CELL.DOT;
        document.querySelectorAll(`.cell[data-index="${i}"]`).forEach(cell => {
          this.updateCellVisual(cell, CELL.DOT);
        });
      }
    }
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
  // debounceMs controls how long to wait before showing error highlights:
  //   0   — show immediately (star placements, drags — clearly not mid-double-click)
  //   200 — short delay (dot placements — could be the first click of a double-click)
  validate({ suppressWinToast = false, debounceMs = 0 } = {}) {
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
      checkGroup(Array.from({ length: n }, (_, k) => i * n + k));
      checkGroup(Array.from({ length: n }, (_, k) => k * n + i));
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

    // Debounce error highlights — dot placements use a delay to avoid flashing
    // on the first click of a double-click; stars and drags show errors immediately.
    // Clears always run immediately so removing an error feels instant.
    clearTimeout(this._errorHighlightTimer);
    if (errorIndices.size === 0 || debounceMs === 0) {
      this._applyErrorHighlights(errorIndices);
    } else {
      this._errorHighlightTimer = setTimeout(
        () => this._applyErrorHighlights(errorIndices), debounceMs
      );
    }

    // Win check — runs eagerly regardless of the highlight debounce
    if (this.isSolved() && errorIndices.size === 0) {
      this.markAsSolved();
      const toast = document.getElementById('toast');
      const winToastAlreadyVisible = toast.classList.contains('toast-win') &&
        !toast.classList.contains('toast-hidden');
      if (!suppressWinToast && !winToastAlreadyVisible) {
        this.showToast("🏆 Perfect! You've solved the Multiverse Star Battle!", "win", 15000);
      }
    } else {
      // If the board is no longer solved, dismiss the win toast
      const toast = document.getElementById('toast');
      if (toast.classList.contains('toast-win') && !toast.classList.contains('toast-hidden')) {
        this.hideToast();
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
    this.updateControls();
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
      this.saveCurrentState();
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
      this.saveCurrentState();
    }
  }

  // ─────────────────── 
  // ─── Persistence ─── 
  // ─────────────────── 

  // Stable localStorage key for this puzzle's cell state.
  get stateKey() { return `sb_state_${this.currentPuzzleUniqueId}`; }

  // Shared localStorage key for the set of all solved puzzle IDs.
  get solvedKey() { return 'sb_solved'; }

  // Persists the current cell state to localStorage under the puzzle's unique ID.
  saveCurrentState() {
    storageManager.savePuzzleState(this.currentPuzzleUniqueId, this.state);
  }

  // Restores saved cell state from localStorage if it exists, then syncs all UI
  loadProgress({ suppressWinToast = false, isReset = false } = {}) {
    const savedState = storageManager.getPuzzleState(this.currentPuzzleUniqueId);
    if (savedState) {
      this.state = savedState;
      this.history = [JSON.stringify(this.state)];
      this.historyIdx = 0;
      this.updateVisuals();
      this.validate({ suppressWinToast });
    } else if (!isReset && storageManager.getSolvedList().includes(this.currentPuzzleUniqueId)) {
      // No local save, but the puzzle is marked solved (e.g. synced from cloud
      // on another device). Reconstruct the solved board from the solution so
      // the user can see the answer rather than a blank grid.
      this.state = this.solution.map(cell => cell === 'x' ? CELL.STAR : CELL.DOT);
      this.history = [JSON.stringify(this.state)];
      this.historyIdx = 0;
      this.saveCurrentState(); // persist locally so this path only runs once
      this.updateVisuals();
      this.validate({ suppressWinToast: true });
    } else {
      // If there's no saved state AND it's a reset (or not solved elsewhere),
      // ensure the board state is explicitly blank/cleared.
      this.state = new Array(this.n * this.n).fill(CELL.NONE);
      this.history = [JSON.stringify(this.state)];
      this.historyIdx = 0;
      this.updateVisuals();
      this.validate({ suppressWinToast: true });
    }
    this.updateControls();
    this.updateSolvedUI();
  }

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

  // Deletes all puzzle state and solved-history entries from localStorage,
  // leaving settings (setting-*) untouched. Also resets the current board
  // to an empty state so the UI stays consistent.
  _clearAllSaveData() {
    storageManager.clearAllPuzzleData();

    // Reset the live board so the UI reflects the cleared state
    if (this.state) {
      this.state.fill(CELL.NONE);
      this.history = [JSON.stringify(this.state)];
      this.historyIdx = 0;
      this.clearHintUI();
      this.updateVisuals();
      this.updateControls();
      this.validate();
      this.updateSolvedUI();
    }

    this.showToast('Cleared all puzzle saves.', 'info');
  }

  // Records this puzzle as solved in localStorage and updates the solved badge.
  markAsSolved() {
    storageManager.markPuzzleSolved(this.currentPuzzleUniqueId);
    this._updateSolvedBadge(storageManager.getSolvedList());
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

  // ─────────────────
  // ─── Feedback ─── 
  // ─────────────────

  // Checks the user's current placements against the solution and shows a toast
  // with the result. Only considers filled cells (dots and stars), not empty ones.
  checkCorrectness() {
    let errorCount = 0;
    let filledCount = 0;

    for (let i = 0; i < this.n * this.n; i++) {
      const userState = this.state[i];
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
    const catId = params.get('book');
    const puzzleParam = params.get('puzzle');

    // For daily, translate label → slot number; fall back to 1.
    // Expert (slot 4) is only available on Sundays — clamp to 3 otherwise.
    const dailySlotMap = { beginner: 1, medium: 2, hard: 3, expert: 4 };
    let puzNum = (catId === 'daily' && puzzleParam in dailySlotMap)
      ? dailySlotMap[puzzleParam]
      : parseInt(puzzleParam, 10) || 1;

    if (catId === 'daily' && puzNum === 4 && !this.isSunday()) {
      puzNum = 3;
    }

    return { catId, puzNum };
  }

  // Updates the URL bar to reflect the current puzzle without adding a browser
  // history entry.
  updateUrlParams(catId, puzNum) {
    const params = new URLSearchParams();
    params.set('book', catId);
    if (this.isDailyCategory(catId)) {
      const dailyLabels = ['beginner', 'medium', 'hard', 'expert'];
      const slot = parseInt(document.getElementById('puzzle-input').value, 10);
      params.set('puzzle', dailyLabels[slot - 1] ?? 'beginner');
    } else {
      params.set('puzzle', puzNum);
    }
    window.history.replaceState(null, '', `?${params.toString()}`);
  }
}

// Apply renderer and input mixins before instantiating
applyRenderer(StarBattleGame);
applyInput(StarBattleGame);

new StarBattleGame();
