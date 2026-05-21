import { CELL } from './constants.js';

export function applyRules(GameClass) {
  const p = GameClass.prototype;

  // Fill empty cells in the same row, column, or region with dots when a star is placed.
  p._autoFillDots = function (idx) {
    const n = this.n;
    const row = Math.floor(idx / n);
    const col = idx % n;

    // Collect cells to dot (row, column, and board 1 region).
    const regionId = this.regions[0][idx];
    const toFill = new Set();

    for (let i = 0; i < n * n; i++) {
      const r = Math.floor(i / n), c = i % n;
      if (r === row || c === col || this.regions[0][i] === regionId) {
        toFill.add(i);
      }
    }

    // Add cells from board 2 region (groupings may differ from board 1).
    const regionId2 = this.regions[1][idx];
    for (let i = 0; i < n * n; i++) {
      if (this.regions[1][i] === regionId2) toFill.add(i);
    }

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

    // Apply dots to empty cells only.
    for (const i of toFill) {
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


    for (let i = 0; i < n; i++) {
      checkGroup(Array.from({ length: n }, (_, k) => i * n + k));
      checkGroup(Array.from({ length: n }, (_, k) => k * n + i));
    }


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
      const toast = document.getElementById('toast');
      const winToastAlreadyVisible = toast.classList.contains('toast-win') &&
        !toast.classList.contains('toast-hidden');
      if (!suppressWinToast && !winToastAlreadyVisible) {
        this.showToast("🏆 Perfect! You've solved the Multiverse Star Battle!", "win", 15000);
      }
    } else {
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
