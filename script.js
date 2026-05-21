import { PuzzleSolver } from './solver.js';
import { CELL } from './constants.js';
import { storageManager } from './storage.js';
import { applyRenderer } from './renderer.js';
import { applyInput } from './input.js';
import { applyPuzzleLoader } from './puzzle-loader.js';
import { applyRules } from './rules.js';
import { applyHistory } from './history.js';

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

// Apply mixins before instantiating
applyRenderer(StarBattleGame);
applyInput(StarBattleGame);
applyPuzzleLoader(StarBattleGame);
applyRules(StarBattleGame);
applyHistory(StarBattleGame);

new StarBattleGame();
