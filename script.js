import { PuzzleSolver } from './solver.js';
import { CELL, HINT_COLOR, HINT_SOURCE_VARIANTS } from './constants.js';
import { storageManager } from './storage.js';
import { applyRenderer } from './renderer.js';
import { applyInput } from './input.js';
import { applyPuzzleLoader } from './puzzle-loader.js';
import { applyRules } from './rules.js';
import { applyHistory } from './history.js';

// Daily puzzle tier labels, in slot order (slot 1 = beginner, ... slot 4 =
// expert). Single source of truth for both the label -> slot and
// slot -> label directions (readUrlParams / updateUrlParams).
const DAILY_TIER_LABELS = ['beginner', 'medium', 'hard', 'expert'];

class StarBattleGame {
  // --- Initialization ---

  // Bootstrap the game: set up global input handling and fetch puzzle data.
  constructor() {
    // Expose singletons to renderer and input modules to avoid circular imports.
    this._deps = { storageManager };
    this._constants = { CELL, HINT_COLOR, HINT_SOURCE_VARIANTS };

    this.puzzleCache = new Map();
    this.categories = [];
    this.loadedPuzzles = [];
    this.draggedIndices = [];
    this.timerInterval = null;
    this.timerStartTime = null;
    this.timerElapsedTime = 0;
    // True once the player has made their first move this puzzle-session.
    // Gates auto-resume (validate()) so the timer never starts on its own
    // before the player has actually touched the board.
    this._timerStarted = false;
    // True once this puzzle has been solved this session. Once set, the
    // timer stays stopped for good (even if the player later undoes a star
    // and "unsolves" it) — solve time was already recorded at the moment of
    // solving, so there's nothing further to time.
    this._timerLocked = false;
    // Set up global listeners before game initialization.
    this.setupGlobalListeners();
    document.addEventListener('DOMContentLoaded', () => this.initGame());
  }

  // Fetch the manifest, populate the category menu, and load the initial puzzle.
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

        // Load target category if specified in URL (handling custom CSVs directly),
        // otherwise default to the first manifest category.
        const manifestCat = this.categories.find(c => c.id === catId);
        // data/daily_<tier>.csv files exist on disk and would otherwise look
        // like valid arbitrary-CSV category IDs, but they're only meant to
        // be reached through loadDailyCategory's "today's puzzle per tier"
        // rotation (?book=daily&puzzle=<tier>) -- exclude them here so a
        // stray ?book=daily_beginner doesn't bypass that and load the whole
        // tier file as its own browsable book.
        const isArbitraryCsv = catId && !manifestCat && !catId.startsWith('daily_');

        if (isArbitraryCsv) {
          await this.loadCategory(catId, puzNum ?? this._getRememberedPuzzleNum(catId));
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

  // Initialize game state for a new puzzle and render both boards.
  async loadPuzzle(puzzleData, categoryId) {
    // Flush the outgoing puzzle's timer progress before switching away —
    // currentPuzzleUniqueId and this.state are about to change, and
    // _persistTimerProgress needs the old ones to save against the right
    // puzzle. (No-ops safely on the very first load, since there's no prior
    // puzzle yet.)
    this._persistTimerProgress();
    this._stopTimer();

    await this._initPuzzleState(puzzleData, categoryId);
    this._renderBoards();
    this._updateStarsBadges();
    this._syncPuzzleLoadBookkeeping(categoryId, puzzleData);

    this.solver = new PuzzleSolver(this);
    this._initTimerForPuzzle();
  }

  // Populate all the plain game-state fields a fresh puzzle needs
  // (identity, geometry, solution, blank board/history). Doesn't touch the
  // DOM -- see _renderBoards for that.
  async _initPuzzleState(puzzleData, categoryId) {
    this.currentPuzzleUniqueId = await this.computePuzzleId(puzzleData);
    this.currentCategoryId = categoryId;
    this.currentPuzzle = puzzleData;

    this.n = puzzleData.N;
    this.solution = puzzleData.solution;
    const solutionStars = (this.solution.match(/x/g) || []).length;
    this.starsPerGroup = Math.round(solutionStars / this.n) || 1;
    this.regions = puzzleData.boards || [puzzleData.board1, puzzleData.board2];

    // Build the void set from first board (all boards share the same void mask).
    this.voidCells = new Set(
      [...this.regions[0]].reduce((acc, ch, i) => { if (ch === '*') acc.push(i); return acc; }, [])
    );

    this.state = new Array(this.n * this.n).fill(CELL.NONE);
    this.history = [JSON.stringify(this.state)];
    this.historyIdx = 0;
  }

  // Tear down the old board DOM and build fresh containers/grids for
  // this.regions, then apply the visuals/settings that depend on them
  // existing. Assumes _initPuzzleState has already run this load.
  _renderBoards() {
    // Dynamically clear existing board containers from boards-wrapper.
    document.querySelectorAll('#boards-wrapper .board-container').forEach(el => el.remove());
    this._resetCellCache();
    document.documentElement.style.setProperty('--grid-n', this.n);
    // boards-per-row: ceil(sqrt(N)) gives a roughly square grid layout
    // (e.g. 4 boards → 2×2, 6 boards → 3×2, 9 boards → 3×3).
    document.documentElement.style.setProperty('--board-count', this.regions.length);
    document.documentElement.style.setProperty(
      '--boards-per-row', Math.ceil(Math.sqrt(this.regions.length))
    );

    // Create and append containers for each board dynamically.
    const boardsWrapper = document.getElementById('boards-wrapper');
    this.regions.forEach((regionString, idx) => {
      const section = document.createElement('section');
      section.className = 'board-container';
      section.setAttribute('aria-label', `Board ${idx + 1}`);

      const h2 = document.createElement('h2');
      h2.textContent = `Board ${idx + 1}`;
      section.appendChild(h2);

      const boardDiv = document.createElement('div');
      boardDiv.id = `board${idx + 1}`;
      boardDiv.className = 'grid-wrapper';
      section.appendChild(boardDiv);

      boardsWrapper.appendChild(section);
      this.renderBoard(`board${idx + 1}`, regionString);
    });

    // Tab mode depends on the board containers created just above, so (like
    // axis labels) it's applied here per puzzle load rather than at initial
    // settings setup, where the boards don't exist yet.
    this._applyTabMode(localStorage.getItem('setting-tab-mode') === 'true');

    this.updateVisuals();
  }

  // Update the small star-count badges (book picker button, help modal)
  // to match this puzzle's starsPerGroup.
  _updateStarsBadges() {
    const starsBadge = document.getElementById('bpb-current-stars');
    if (starsBadge) {
      starsBadge.textContent = `${'★'.repeat(this.starsPerGroup)}`;
    }
    const helpStars = document.getElementById('help-stars-count');
    if (helpStars) {
      helpStars.textContent = this.starsPerGroup === 1 ? '1 star' : `${this.starsPerGroup} stars`;
    }
  }

  // Everything else a puzzle load needs to keep in sync: load-toast,
  // saved progress, undo/redo button state, and URL/position bookkeeping.
  _syncPuzzleLoadBookkeeping(categoryId, puzzleData) {
    this.showToastOnLoad(categoryId, puzzleData.id);
    this.loadProgress({ suppressWinToast: true });
    this.updateControls();
    this.updateUrlParams(categoryId, puzzleData.id);
    if (!this.isDailyCategory(categoryId)) {
      this._rememberPuzzlePosition(categoryId, puzzleData.id);
    }
  }

  // Initialize the timer for this puzzle. It does NOT start running yet —
  // it stays paused until the player's first move (see _startTimerIfNeeded),
  // so simply browsing to a puzzle never burns solve time. If there's a
  // saved in-progress elapsed time for an unsolved puzzle, resume from
  // there instead of zero; if the puzzle is already solved, show its
  // recorded best time instead of zeroing it out.
  _initTimerForPuzzle() {
    this._stopTimer();
    this._timerStarted = false;
    this._timerLocked = false;
    this.timerStartTime = null;
    if (this.isSolved()) {
      // Defaults to 0 only if no time was ever recorded for this puzzle
      // (e.g. solved before the timer feature existed, or solved on
      // another device).
      const bestTime = storageManager.getSolveTime(this.currentPuzzleUniqueId);
      this.timerElapsedTime = typeof bestTime === 'number' ? bestTime : 0;
      this._timerLocked = true;
    } else {
      const savedElapsed = storageManager.getElapsedTime(this.currentPuzzleUniqueId);
      this.timerElapsedTime = typeof savedElapsed === 'number' ? savedElapsed : 0;
    }
    this._updateTimerDisplay(this.timerElapsedTime);
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

  // --- Game State ---

  // Handle initial pointer action on a cell. Left-click cycles states and
  // begins drag sessions; right-click toggles stars directly.
  handleStart(idx, isRightClick) {
    if (this.voidCells?.has(idx)) return;
    const toast = document.getElementById('toast');
    const isWinToast = toast.classList.contains('toast-win') &&
      !toast.classList.contains('toast-hidden');
    if (!isWinToast) this.hideToast();
    this.isDragging = true;

    if (isRightClick) {
      this._getCellsByIndex(idx).forEach(cell => {
        cell.classList.add('cell-drag-highlight');
      });
      this.applyState(idx, this.state[idx] === CELL.STAR ? CELL.NONE : CELL.STAR);
      this.saveHistory();
      this.isDragging = false;
      setTimeout(() => {
        this._getCellsByIndex(idx).forEach(cell => {
          cell.classList.remove('cell-drag-highlight');
        });
      }, 80);
    } else {
      this.draggedIndices = [idx];
      this._getCellsByIndex(idx).forEach(cell => {
        cell.classList.add('cell-drag-highlight');
      });
    }
  }

  // Paint dots on empty cells during drag actions.
  handleDrag(idx) {
    if (this.voidCells?.has(idx)) return;
    if (!this.isDragging || this.draggedIndices.includes(idx)) return;
    this.draggedIndices.push(idx);
    this._getCellsByIndex(idx).forEach(cell => {
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
          this.applyState(idx, CELL.DOT, { suppressWinToast: true, debounceMs: 0 });
        }
      }
      // Validate board state after drag completes.
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

  // Apply state change to a cell, update visuals, validate, and persist.
  applyState(idx, type, { suppressWinToast = false, debounceMs } = {}) {
    if (this.voidCells?.has(idx)) return;
    if (this.state[idx] === type) return;
    this._startTimerIfNeeded();
    this.state[idx] = type;
    this._getCellsByIndex(idx).forEach(cell => {
      this.updateCellVisual(cell, type);
    });
    // Delay dot placement validation to prevent flashing during double-clicks.
    const delay = debounceMs ?? (type === CELL.DOT ? 200 : 0);

    // Automatically fill dots in the same row, column, and region when placing a star.
    if (type === CELL.STAR && !this._suppressAutoFill &&
      localStorage.getItem('setting-auto-fill-dots') === 'true') {
      this._suppressAutoFill = true;
      this._autoFillDots(idx);
      this._suppressAutoFill = false;
    }

    this.validate({ suppressWinToast, debounceMs: delay });
    this.saveCurrentState();
  }



  // --- Hints ---

  // Request a hint from the solver and update UI.
  getHint() {
    const hint = this.solver.getHint();
    if (hint) {
      this.applyHintUI(hint);
    } else {
      this.showToast("No hints found!", "info");
    }
  }

  // --- URL Parameters ---

  // Read category and puzzle index from URL query parameters.
  readUrlParams() {
    const params = new URLSearchParams(window.location.search);
    const catId = params.get('book');
    const puzzleParam = params.get('puzzle');

    // Map daily labels to slot indices. Expert is restricted to Sundays.
    const slotFromLabel = DAILY_TIER_LABELS.indexOf(puzzleParam) + 1;
    let puzNum = (catId === 'daily' && slotFromLabel > 0)
      ? slotFromLabel
      : parseInt(puzzleParam, 10) || 1;

    if (catId === 'daily' && puzNum === 4 && !this.isSunday()) {
      puzNum = 3;
    }

    return { catId, puzNum };
  }

  // Update browser URL query parameters without creating a new history entry.
  updateUrlParams(catId, puzNum) {
    const params = new URLSearchParams();
    params.set('book', catId);
    if (this.isDailyCategory(catId)) {
      const slot = parseInt(document.getElementById('puzzle-input').value, 10);
      params.set('puzzle', DAILY_TIER_LABELS[slot - 1] ?? 'beginner');
    } else {
      params.set('puzzle', puzNum);
    }
    window.history.replaceState(null, '', `?${params.toString()}`);
  }

  _startTimer() {
    this._stopTimer();
    this.timerInterval = setInterval(() => {
      if (this.timerStartTime) {
        this.timerElapsedTime = Math.floor((Date.now() - this.timerStartTime) / 1000);
        this._updateTimerDisplay(this.timerElapsedTime);
      }
    }, 1000);
  }

  _stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  // Start the timer the first (and only the first) time the player actually
  // makes a move this puzzle-session. Later pauses (tab switches) resume
  // through _resumeTimerFromBackground / validate() instead of this method.
  _startTimerIfNeeded() {
    if (this._timerStarted || this._timerLocked || this.isSolved()) return;
    this._timerStarted = true;
    this.timerStartTime = Date.now() - (this.timerElapsedTime * 1000);
    this._startTimer();
  }

  // Pause the timer when the tab is backgrounded. Freezes timerElapsedTime
  // at the current value and clears timerStartTime so the timer reads as
  // genuinely stopped (not just throttled) until the tab regains focus.
  _pauseTimerForBackground() {
    if (this.timerStartTime) {
      this.timerElapsedTime = Math.floor((Date.now() - this.timerStartTime) / 1000);
      this._updateTimerDisplay(this.timerElapsedTime);
    }
    this._stopTimer();
    this.timerStartTime = null;
    this._persistTimerProgress();
  }

  // Resume the timer when the tab regains focus — but only if the player
  // had already started playing this session (never auto-starts a fresh,
  // untouched puzzle) and it isn't already solved.
  _resumeTimerFromBackground() {
    if (!this._timerStarted || this._timerLocked || this.isSolved()) return;
    this.timerStartTime = Date.now() - (this.timerElapsedTime * 1000);
    this._startTimer();
  }
}

// Register mixins before instantiating
applyRenderer(StarBattleGame);
applyInput(StarBattleGame);
applyPuzzleLoader(StarBattleGame);
applyRules(StarBattleGame);
applyHistory(StarBattleGame);

new StarBattleGame();
