import { storageManager } from './storage.js';
import { CELL } from './constants.js';

// dotReasons (see rules.js) is a Map<cellIndex, Set<reason>> -- neither
// Map nor Set survives JSON.stringify on its own, so history snapshots
// serialize it to a plain {idx: [reasons]} object alongside state, and
// deserialize it back on undo/redo. An empty/missing dotReasons still
// round-trips fine (deserializes to an empty Map), so this doesn't need
// special-casing for puzzle loads that never had one to begin with.
function serializeDotReasons(dotReasons) {
  const obj = {};
  if (dotReasons) {
    for (const [idx, reasons] of dotReasons) {
      obj[idx] = [...reasons];
    }
  }
  return obj;
}

function deserializeDotReasons(obj) {
  const map = new Map();
  for (const key of Object.keys(obj || {})) {
    map.set(Number(key), new Set(obj[key]));
  }
  return map;
}

export function applyHistory(GameClass) {
  const p = GameClass.prototype;

  // Save current state to history and truncate any undone future states.
  p.saveHistory = function () {
    const snap = JSON.stringify({ state: this.state, dotReasons: serializeDotReasons(this.dotReasons), highlights: this.highlights });
    // Skip if state is unchanged.
    if (snap === this.history[this.historyIdx]) return;

    this.history = this.history.slice(0, this.historyIdx + 1);
    this.history.push(snap);
    this.historyIdx++;
    this.updateControls();
  };

  // Revert to the previous history state.
  p.undo = function () {
    this.hideToast();
    if (this.historyIdx > 0) {
      this.historyIdx--;
      const snap = JSON.parse(this.history[this.historyIdx]);
      this.state = snap.state;
      this.dotReasons = deserializeDotReasons(snap.dotReasons);
      this.highlights = snap.highlights ?? new Array(this.n * this.n).fill(null);
      this.updateVisuals();
      this.validate();
      this.updateControls();
      this.saveCurrentState();
    }
  };

  // Advance to the next history state.
  p.redo = function () {
    this.hideToast();
    if (this.historyIdx < this.history.length - 1) {
      this.historyIdx++;
      const snap = JSON.parse(this.history[this.historyIdx]);
      this.state = snap.state;
      this.dotReasons = deserializeDotReasons(snap.dotReasons);
      this.highlights = snap.highlights ?? new Array(this.n * this.n).fill(null);
      this.updateVisuals();
      this.validate();
      this.updateControls();
      this.saveCurrentState();
    }
  };

  // Persist current state to localStorage, along with the timer's
  // in-progress elapsed time so a resumed session picks up where it left off.
  p.saveCurrentState = function () {
    storageManager.savePuzzleState(this.currentPuzzleUniqueId, this.state);
    storageManager.saveHighlights(this.currentPuzzleUniqueId, this.highlights);
    this._persistTimerProgress();
  };

  // Replace the live board state, and reset history to a single fresh
  // snapshot of it. A freshly loaded/reset/reconstructed state has no
  // per-cell provenance to restore (only stars and dots are saved, not WHY
  // each dot exists), so every dot already on the board is recorded as the
  // player's own ('manual', see rules.js's dot-provenance helpers). Without
  // that, such a dot would have no reason at all, and the first star placed
  // in any of its groups would give it one (a row/column/region quota) that
  // is retracted again when the star is removed -- wiping a dot that was
  // there before the star. `highlights` (the player's cell colors) is the
  // exception to "nothing carried over" -- it's saved per puzzle, so loads
  // pass the saved copy back in; everything else (reset, clear-all) gets none.
  p._resetHistoryTo = function (state, highlights = null) {
    this.state = state;
    this.dotReasons = new Map();
    state.forEach((cell, i) => {
      if (cell === CELL.DOT) this._addDotReason(i, 'manual');
    });
    this.highlights = highlights ?? new Array(this.n * this.n).fill(null);
    this.history = [JSON.stringify({ state, dotReasons: serializeDotReasons(this.dotReasons), highlights: this.highlights })];
    this.historyIdx = 0;
  };

  // Reset the solve timer to a fresh, paused state. Like a fresh puzzle
  // load, it doesn't start running again until the player's next move.
  p._resetTimer = function () {
    this.timerElapsedTime = 0;
    this._updateTimerDisplay(0);
    this._timerStarted = false;
    this._timerLocked = false;
    this._stopTimer();
    this.timerStartTime = null;
  };

  // Load saved state or reconstruct from solved history.
  p.loadProgress = function ({ suppressWinToast = false, isReset = false } = {}) {
    const savedState = storageManager.getPuzzleState(this.currentPuzzleUniqueId);
    if (savedState && savedState.length === this.n * this.n) {
      this._resetHistoryTo(savedState, storageManager.getHighlights(this.currentPuzzleUniqueId, this.n * this.n));
      this.updateVisuals();
      this.validate({ suppressWinToast });
    } else if (!isReset && storageManager.getSolvedList().includes(this.currentPuzzleUniqueId)) {
      // Reconstruct board from solution if solved on another device.
      this._resetHistoryTo([...this.solution].map((cell, i) =>
        this.regions[0][i] === '*' ? CELL.NONE : cell === 'x' ? CELL.STAR : CELL.DOT
      ));
      this.saveCurrentState();
      this.updateVisuals();
      this.validate({ suppressWinToast: true });
    } else {
      // Clear state if no progress or solved record exists.
      this._resetHistoryTo(new Array(this.n * this.n).fill(CELL.NONE));
      this.updateVisuals();
      this.validate({ suppressWinToast: true });
    }
    this.updateControls();
    this.updateSolvedUI();
  };

  p.doReset = function () {
    this.hideToast();
    this._resetHistoryTo(new Array(this.n * this.n).fill(CELL.NONE));
    this.clearHintUI();
    this.updateVisuals();
    this.updateControls();

    this._resetTimer();

    this.validate();
    this.saveCurrentState();
  };

  // Clear all saved puzzle data and reset active board.
  p._clearAllSaveData = async function () {
    await storageManager.clearAllPuzzleData();

    if (this.state) {
      this._resetHistoryTo(new Array(this.n * this.n).fill(CELL.NONE));
      this.clearHintUI();
      this.updateVisuals();
      this.updateControls();
      this.validate();
      this.updateSolvedUI();

      // Reset the solve timer, since any saved time for this puzzle is gone.
      this._resetTimer();
    }

    this.showToast('Cleared all puzzle saves.', 'info');
  };

  // Mark puzzle as solved and update UI.
  p.markAsSolved = function () {
    storageManager.markPuzzleSolved(this.currentPuzzleUniqueId);
    this._updateSolvedBadge(storageManager.getSolvedList());
  };

  // Persist a fresh solve time as the new best if it beats any prior one,
  // and clear the (now irrelevant) in-progress elapsed time for this puzzle.
  p.recordSolveTime = function (seconds) {
    storageManager.saveSolveTime(this.currentPuzzleUniqueId, seconds);
    storageManager.clearElapsedTime(this.currentPuzzleUniqueId);
  };

  // Persist the current puzzle's in-progress timer so it can resume from
  // here next time it's loaded. Called before switching to a different
  // puzzle, and when the tab is hidden/closed. Solved puzzles don't need
  // this — their best time is already tracked via recordSolveTime.
  p._persistTimerProgress = function () {
    if (!this.currentPuzzleUniqueId || !this.state) return;
    if (this.isSolved()) return;
    const elapsed = this.timerStartTime
      ? Math.floor((Date.now() - this.timerStartTime) / 1000)
      : this.timerElapsedTime;
    storageManager.saveElapsedTime(this.currentPuzzleUniqueId, elapsed);
  };
}
