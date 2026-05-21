import { storageManager } from './storage.js';
import { CELL } from './constants.js';

export function applyHistory(GameClass) {
  const p = GameClass.prototype;

  // Appends the current state to the undo history, truncating any undone future
  p.saveHistory = function () {
    const snap = JSON.stringify(this.state);
    // Deduplicate: skip if state hasn't actually changed since the last snapshot.
    if (snap === this.history[this.historyIdx]) return;

    this.history = this.history.slice(0, this.historyIdx + 1);
    this.history.push(snap);
    this.historyIdx++;
    this.updateControls();
  };

  // Steps back one entry in undo history.
  p.undo = function () {
    this.hideToast();
    if (this.historyIdx > 0) {
      this.historyIdx--;
      this.state = JSON.parse(this.history[this.historyIdx]);
      this.updateVisuals();
      this.validate();
      this.updateControls();
      this.saveCurrentState();
    }
  };

  // Steps forward one entry in undo history.
  p.redo = function () {
    this.hideToast();
    if (this.historyIdx < this.history.length - 1) {
      this.historyIdx++;
      this.state = JSON.parse(this.history[this.historyIdx]);
      this.updateVisuals();
      this.validate();
      this.updateControls();
      this.saveCurrentState();
    }
  };

  // Persists the current cell state to localStorage under the puzzle's unique ID.
  p.saveCurrentState = function () {
    storageManager.savePuzzleState(this.currentPuzzleUniqueId, this.state);
  };

  // Restores saved cell state from localStorage if it exists, then syncs all UI
  p.loadProgress = function ({ suppressWinToast = false, isReset = false } = {}) {
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
      this.state = [...this.solution].map(cell => cell === 'x' ? CELL.STAR : CELL.DOT);
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
  };

  p.doReset = function () {
    this.hideToast();
    this.state.fill(CELL.NONE);
    this.history = [JSON.stringify(this.state)];
    this.historyIdx = 0;
    this.clearHintUI();
    this.updateVisuals();
    this.updateControls();
    this.validate();
    this.saveCurrentState();
  };

  // Deletes all puzzle state and solved-history entries from localStorage,
  // leaving settings (setting-*) untouched. Also resets the current board
  // to an empty state so the UI stays consistent.
  p._clearAllSaveData = function () {
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
  };

  // Records this puzzle as solved in localStorage and updates the solved badge.
  p.markAsSolved = function () {
    storageManager.markPuzzleSolved(this.currentPuzzleUniqueId);
    this._updateSolvedBadge(storageManager.getSolvedList());
  };
}
