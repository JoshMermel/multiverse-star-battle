import { CELL } from './constants.js';
import { getNeighbors8, rowIndices, colIndices } from './geometry.js';

export function applyRules(GameClass) {
  const p = GameClass.prototype;

  // Fill empty cells in the same row, column, or region with dots when stars are placed.
  // Also records WHY each dot exists (see the dot-provenance helpers below),
  // so removing a star can cleanly retract just the dots it alone justified
  // -- not ones some other still-present star (or the player, by hand)
  // also justifies.
  //
  // Two kinds of reason get recorded, and they behave differently on removal:
  //  - Adjacency to THIS star specifically: reason is the star's own cell
  //    index. Tied to one star, so removing that exact star always retracts
  //    it (see _removeStarAsReason).
  //  - A row/column/region reaching its star quota: reason is a group token
  //    (`row:R` / `col:C` / `region:B:ID`), not any particular star's index.
  //    Whichever star placement happens to push the group over quota is
  //    incidental -- what matters is whether the group STILL meets quota,
  //    which can depend on several stars at once (e.g. a 2-star quota met by
  //    two different stars). So this reason isn't retracted by removing one
  //    specific star; it's reconciled by rechecking the group's current
  //    count whenever any of its stars is removed (see _reconcileGroupQuota).
  // Returns the row/column/region groups CONTAINING idx that currently meet
  // their star quota, as { indices, reason } entries (reason is the group
  // token -- see the dot-provenance comment below). Shared by _autoFillDots
  // (idx is the star just placed; its groups may now be at quota) and
  // _refillIfNowJustified (idx is a just-vacated cell; its groups may
  // already have been at quota all along, just masked while idx was itself
  // a star).
  p._groupFillReasons = function (idx) {
    const n = this.n;
    const row = Math.floor(idx / n);
    const col = idx % n;
    const starsPerGroup = this.starsPerGroup || 1;
    const groups = [];

    const rowIdxs = rowIndices(n, row);
    if (rowIdxs.filter(i => this.state[i] === CELL.STAR).length >= starsPerGroup) {
      groups.push({ indices: rowIdxs, reason: `row:${row}` });
    }

    const colIdxs = colIndices(n, col);
    if (colIdxs.filter(i => this.state[i] === CELL.STAR).length >= starsPerGroup) {
      groups.push({ indices: colIdxs, reason: `col:${col}` });
    }

    this.regions.forEach((regionString, boardIdx) => {
      const regionId = regionString[idx];
      if (regionId === '*') return;
      const regionIndices = [];
      for (let i = 0; i < n * n; i++) {
        if (regionString[i] === regionId) regionIndices.push(i);
      }
      if (regionIndices.filter(i => this.state[i] === CELL.STAR).length >= starsPerGroup) {
        groups.push({ indices: regionIndices, reason: `region:${boardIdx}:${regionId}` });
      }
    });

    return groups;
  };

  p._autoFillDots = function (idx) {
    const n = this.n;

    // Each entry: cells to dot, plus the reason token to attach to them.
    const fillGroups = this._groupFillReasons(idx);

    // Stars cannot touch orthogonally or diagonally, so adjacent cells are
    // always dotted regardless of row/column/region quotas, attributed
    // directly to this star.
    fillGroups.push({ indices: getNeighbors8(idx, n), reason: idx });

    // Apply dots to empty cells (never void or already-starred cells), and
    // record each group's reason for every cell it covers -- including
    // cells that were already dots for some OTHER reason (e.g. two groups
    // whose cells overlap), so a cell only reverts to empty once every
    // reason justifying it is gone.
    for (const { indices, reason } of fillGroups) {
      for (const i of indices) {
        if (this.voidCells?.has(i)) continue;
        if (this.state[i] === CELL.STAR) continue;
        if (this.state[i] === CELL.NONE) {
          this.state[i] = CELL.DOT;
          this._getCellsByIndex(i).forEach(cell => {
            this.updateCellVisual(cell, CELL.DOT);
          });
        }
        this._addDotReason(i, reason);
      }
    }
  };

  // Called when the star at idx is removed, on the now-empty idx itself:
  // a cell that WAS a star is exempt from being dotted (see the STAR-skip
  // above), so any reason that already applied to it -- an adjacent star
  // that's still there, or a row/column/region that already met quota via
  // OTHER stars -- was never recorded, since it never got the chance to be
  // a dot in the first place. Now that idx is empty again, re-check and
  // dot it immediately if any such reason currently applies.
  p._refillIfNowJustified = function (idx) {
    if (this.voidCells?.has(idx)) return;
    if (this.state[idx] !== CELL.NONE) return;

    const reasons = [];
    getNeighbors8(idx, this.n).forEach(nb => {
      if (this.state[nb] === CELL.STAR) reasons.push(nb);
    });
    this._groupFillReasons(idx).forEach(({ reason }) => reasons.push(reason));

    if (reasons.length === 0) return;
    this.state[idx] = CELL.DOT;
    this._getCellsByIndex(idx).forEach(cell => {
      this.updateCellVisual(cell, CELL.DOT);
    });
    reasons.forEach(reason => this._addDotReason(idx, reason));
  };

  // --- Dot provenance ---
  //
  // `dotReasons` (Map<cellIndex, Set<reason>>) records why each currently-
  // dotted cell is a dot. A reason is one of:
  //   - 'manual': the player dotted it directly by hand.
  //   - a star's own cell index (number): that star's 8-neighbor adjacency
  //     covers this cell. Tied to exactly that star.
  //   - a group token (`row:R` / `col:C` / `region:B:ID`): that row/column/
  //     region currently meets its star quota, so the rest of the group is
  //     dotted. NOT tied to any one star -- a quota can be met by several
  //     stars together, so this reason is retracted only once the group's
  //     live star count drops back below quota (see _reconcileGroupQuota),
  //     not just because one contributing star was removed.
  // A dot only reverts to empty once every one of its reasons is gone --
  // removing one star that helped justify a dot doesn't clear it if another
  // star (or a manual click, or the group still otherwise meeting quota)
  // still does. Cells that aren't currently dots have no entry.

  p._addDotReason = function (idx, reason) {
    if (!this.dotReasons) this.dotReasons = new Map();
    let reasons = this.dotReasons.get(idx);
    if (!reasons) {
      reasons = new Set();
      this.dotReasons.set(idx, reasons);
    }
    reasons.add(reason);
  };

  // Removes one reason from idx's set. If that empties the set AND idx is
  // still a dot (not since overwritten by a star), reverts idx to empty.
  p._removeDotReason = function (idx, reason) {
    const reasons = this.dotReasons?.get(idx);
    if (!reasons || !reasons.has(reason)) return;
    reasons.delete(reason);
    if (reasons.size === 0) {
      this.dotReasons.delete(idx);
      if (this.state[idx] === CELL.DOT) {
        this.state[idx] = CELL.NONE;
        this._getCellsByIndex(idx).forEach(cell => {
          this.updateCellVisual(cell, CELL.NONE);
        });
      }
    }
  };

  // Removes `reason` from every cell in `indices` ONLY IF that group no
  // longer meets its star quota (checked against current state, i.e. after
  // the triggering star has already been removed). A group can meet quota
  // via several stars at once, so losing one doesn't necessarily invalidate
  // the group-fill reason -- e.g. a 2-star quota met by 3 stars still meets
  // quota after one of them is removed, and the reason correctly survives.
  p._reconcileGroupQuota = function (indices, reason) {
    const starsPerGroup = this.starsPerGroup || 1;
    const stars = indices.filter(i => this.state[i] === CELL.STAR).length;
    if (stars < starsPerGroup) {
      indices.forEach(i => this._removeDotReason(i, reason));
    }
  };

  // Called when the star at starIdx is removed: retracts it as an adjacency
  // reason from every cell that has it, and reconciles the row/column/region
  // group-quota reasons for every group starIdx belonged to (a group's fill
  // may have been justified by starIdx together with other stars, so it's
  // only retracted if the group has now dropped below quota -- see
  // _reconcileGroupQuota).
  p._removeStarAsReason = function (starIdx) {
    const n = this.n;
    const row = Math.floor(starIdx / n);
    const col = starIdx % n;

    if (this.dotReasons) {
      // Snapshot the keys first -- _removeDotReason mutates the map as it goes.
      for (const idx of [...this.dotReasons.keys()]) {
        this._removeDotReason(idx, starIdx);
      }
    }

    this._reconcileGroupQuota(rowIndices(n, row), `row:${row}`);
    this._reconcileGroupQuota(colIndices(n, col), `col:${col}`);

    this.regions.forEach((regionString, boardIdx) => {
      const regionId = regionString[starIdx];
      if (regionId === '*') return;
      const regionIndices = [];
      for (let i = 0; i < n * n; i++) {
        if (regionString[i] === regionId) regionIndices.push(i);
      }
      this._reconcileGroupQuota(regionIndices, `region:${boardIdx}:${regionId}`);
    });
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
      for (const nb of getNeighbors8(i, n)) {
        if (this.state[nb] === CELL.STAR) { errors.add(i); errors.add(nb); }
      }
    }
    return errors;
  };

  // Validate current state and highlight rule violations.
  // debounceMs delays highlighting to prevent flashing during double-clicks.
  p.validate = function ({ suppressWinToast = false, debounceMs = 0 } = {}) {
    const n = this.n;
    const errorIndices = new Set();
    const starsPerGroup = this.starsPerGroup || 1;
    const isVoid = (i) => this.voidCells?.has(i);

    const checkGroup = (indices) => {
      const stars = indices.filter(i => this.state[i] === CELL.STAR);
      const playable = indices.filter(i => this.state[i] !== CELL.DOT && !isVoid(i));
      // Mark group as erroneous if it has more stars than allowed,
      // or if there are fewer playable cells than the required number of stars.
      if (stars.length > starsPerGroup || playable.length < starsPerGroup) {
        indices.forEach(i => errorIndices.add(i));
      }
    };

    for (let i = 0; i < n; i++) {
      checkGroup(rowIndices(n, i).filter(idx => !isVoid(idx)));
      checkGroup(colIndices(n, i).filter(idx => !isVoid(idx)));
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
