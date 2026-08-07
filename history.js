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
    const snap = JSON.stringify({ state: this.state, dotReasons: serializeDotReasons(this.dotReasons) });
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
    this._persistTimerProgress();
  };

  // Replace the live board state, and reset history to a single fresh
  // snapshot of it. dotReasons always starts empty here -- a freshly
  // loaded/reset/reconstructed state has no per-cell provenance to speak
  // of, so any dots already on the board (e.g. reconstructed from a
  // solved solution) are just inert until live play re-establishes
  // reasons for them.
  p._resetHistoryTo = function (state) {
    this.state = state;
    this.dotReasons = new Map();
    this.history = [JSON.stringify({ state, dotReasons: {} })];
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
      this._resetHistoryTo(savedState);
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
