import { CELL } from './constants.js';

export function applyRules(GameClass) {
  const p = GameClass.prototype;

  // Dots every CELL.NONE cell that shares a row, column, or region with the
  // star just placed at `idx`. Operates on the shared state (both boards see
  // the same state array), so the fill naturally appears on both boards.
  // Called only while _suppressAutoFill is true, so no recursion occurs.
  p._autoFillDots = function (idx) {
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
  };

  // Returns true if every solution star is placed and no extra stars exist.
  // Empty cells and dots are ignored — the puzzle is solved even with blank
  // squares.
  p.isSolved = function () {
    return this.state.every((v, i) => (this.solution[i] === 'x') ? v === CELL.STAR : v !== CELL.STAR);
  };

  // Returns the set of cell indices involved in adjacency violations.
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

  // Highlights obvious rule violations in real time.
  // debounceMs controls how long to wait before showing error highlights:
  //   0   — show immediately (star placements, drags — clearly not mid-double-click)
  //   200 — short delay (dot placements — could be the first click of a double-click)
  p.validate = function ({ suppressWinToast = false, debounceMs = 0 } = {}) {
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
  };

  // Checks the user's current placements against the solution and shows a toast
  // with the result. Only considers filled cells (dots and stars), not empty ones.
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
