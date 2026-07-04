import { CELL } from './constants.js';

export function applyRules(GameClass) {
  const p = GameClass.prototype;

  // Fill empty cells in the same row, column, or region with dots when a star is placed.
  p._autoFillDots = function (idx) {
    const n = this.n;
    const row = Math.floor(idx / n);
    const col = idx % n;

    const toFill = new Set();

    for (let i = 0; i < n * n; i++) {
      const r = Math.floor(i / n), c = i % n;
      if (r === row || c === col) {
        toFill.add(i);
      }
    }

    // Add cells from region on all boards.
    this.regions.forEach(regionString => {
      const regionId = regionString[idx];
      for (let i = 0; i < n * n; i++) {
        if (regionString[i] === regionId) toFill.add(i);
      }
    });

    // Add adjacent cells (stars cannot touch orthogonally or diagonally).
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = row + dr, nc = col + dc;
        if (nr >= 0 && nr < n && nc >= 0 && nc < n) {
          toFill.add(nr * n + nc);
        }
      }
    }

    // Apply dots to empty cells only (never void cells).
    for (const i of toFill) {
      if (this.voidCells?.has(i)) continue;
      if (this.state[i] === CELL.NONE) {
        this.state[i] = CELL.DOT;
        document.querySelectorAll(`.cell[data-index="${i}"]`).forEach(cell => {
          this.updateCellVisual(cell, CELL.DOT);
        });
      }
    }
  };

  // Check if all solution stars are placed and no extra stars exist.
  p.isSolved = function () {
    return this.state.every((v, i) => (this.solution[i] === 'x') ? v === CELL.STAR : v !== CELL.STAR);
  };

  // Find all cell indices with adjacency violations.
  p._getAdjacentErrorIndices = function () {
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
  };

  // Validate current state and highlight rule violations.
  // debounceMs delays highlighting to prevent flashing during double-clicks.
  p.validate = function ({ suppressWinToast = false, debounceMs = 0 } = {}) {
    const n = this.n;
    const errorIndices = new Set();

    const checkGroup = (indices) => {
      const stars = indices.filter(i => this.state[i] === CELL.STAR);
      const allDots = indices.every(i => this.state[i] === CELL.DOT);
      // Mark group as erroneous if it has multiple stars or is completely dotted.
      if (stars.length > 1 || allDots) {
        indices.forEach(i => errorIndices.add(i));
      }
    };


    const isVoid = (i) => this.voidCells?.has(i);
    for (let i = 0; i < n; i++) {
      checkGroup(Array.from({ length: n }, (_, k) => i * n + k).filter(i => !isVoid(i)));
      checkGroup(Array.from({ length: n }, (_, k) => k * n + i).filter(i => !isVoid(i)));
    }


    this.regions.forEach(regionString => {
      const regionIds = [...new Set(regionString.split(''))].filter(id => id !== '*');
      regionIds.forEach(id => {
        const indices = [];
        for (let j = 0; j < regionString.length; j++) {
          if (regionString[j] === id) indices.push(j);
        }
        checkGroup(indices);
      });
    });


    for (const idx of this._getAdjacentErrorIndices()) {
      errorIndices.add(idx);
    }

    clearTimeout(this._errorHighlightTimer);
    if (errorIndices.size === 0 || debounceMs === 0) {
      this._applyErrorHighlights(errorIndices);
    } else {
      this._errorHighlightTimer = setTimeout(
        () => this._applyErrorHighlights(errorIndices), debounceMs
      );
    }

    // Check win condition.
    if (this.isSolved() && errorIndices.size === 0) {
      this.markAsSolved();

      // Only treat this as a genuine fresh solve — not a reload or
      // reconstruction of a puzzle that was already solved — when the win
      // toast isn't suppressed. Puzzle-load call sites always suppress it.
      if (!suppressWinToast) {
        const finalElapsed = this.timerStartTime
          ? Math.floor((Date.now() - this.timerStartTime) / 1000)
          : this.timerElapsedTime;
        this.timerElapsedTime = finalElapsed;
        this._updateTimerDisplay(finalElapsed);
        this.recordSolveTime(finalElapsed);
      }

      this._stopTimer();
      this.timerStartTime = null;
      // Lock the timer stopped for the rest of this session — even if the
      // player later undoes a star and un-solves the board, solve time was
      // already recorded above and shouldn't resume counting.
      this._timerLocked = true;
      const toast = document.getElementById('toast');
      const winToastAlreadyVisible = toast.classList.contains('toast-win') &&
        !toast.classList.contains('toast-hidden');
      if (!suppressWinToast && !winToastAlreadyVisible) {
        this.showToast("🏆 Perfect! You've solved the Multiverse Star Battle!", "win", 15000);
      }
    } else {
      // Resume the timer if it was already started this session but is
      // currently stopped/paused (e.g. an undo landed back on a solved
      // state momentarily, or a background-pause somehow left it stopped).
      // Gated on _timerStarted so this never fires as a way of starting the
      // timer for a puzzle the player hasn't actually touched yet — that's
      // _startTimerIfNeeded's job, triggered only by a real move.
      if (this._timerStarted && !this._timerLocked && !this.timerInterval) {
        this.timerStartTime = Date.now() - (this.timerElapsedTime * 1000);
        this._startTimer();
      }
      // Dismiss win toast if puzzle is no longer solved.
      const toast = document.getElementById('toast');
      if (toast.classList.contains('toast-win') && !toast.classList.contains('toast-hidden')) {
        this.hideToast();
      }
    }
  };

  // Check current placements against the solution and display results.
  p.checkCorrectness = function () {
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
  };
}
