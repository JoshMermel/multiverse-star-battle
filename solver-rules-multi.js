import { CELL, HINT_COLOR, HINT_SOURCE_VARIANTS } from './constants.js';

// 2★+ rule implementations: everything written against an arbitrary
// this.starsPerGroup rather than assuming exactly 1 star per
// row/column/region. Used identically for 2★, 3★, and 4★+ puzzles via
// _getMultiStarRuleList(). See solver-rules-single.js for the 1★-only
// rules they generalize, and solver-rules-common.js for the rules shared
// verbatim by both families.
export function applyMultiStarRules(PuzzleSolver) {
  const p = PuzzleSolver.prototype;

  // --- 2★/3★-specific rules ---
  // These rely on enumerating every valid way to complete a still-unsatisfied unit's
  // stars (respecting non-adjacency), which is only cheap enough to brute-force through
  // 3★ (i.e. at most 3 stars still needed per unit). See _enumerateUnitCompletions and
  // _unitCompletionsByLevel for the weak/intermediate/strong levels this enumeration is
  // shared across: weak only rules out completions that touch each other or an existing
  // star; strong also rules out completions that would overload some other
  // row/column/region; intermediate is strong restricted to one board's units at a time.

  // Rule (2★/3★): For a row/column/region with missing stars, enumerate every valid
  // way to place its remaining stars. If EVERY one of those completions exactly fills
  // up some OTHER row/column/region (of a different type), then that other unit's
  // entire remaining quota is guaranteed to come from this unit no matter which
  // completion turns out to be true -- so any of its other empty cells (outside this
  // unit) must be dots. Checked in both directions: a region's placements can force a
  // row or column, and a row's or column's placements can force a region (or the
  // other axis).
  //
  // level is 'intermediate' or 'strong' (no 'weak' -- a capacity-free version of this
  // rule wouldn't reliably prove anything, since the whole deduction hinges on quota
  // bookkeeping). See _unitCompletionsByLevel: 'intermediate' only ever needs one
  // board's regions to reach its conclusion; 'strong' may need both.
  p.hintUnitCompletionSatisfiesOtherUnit = function (level = 'strong') {
    const candidateMap = new Map(); // "unitLabel|otherLabel" -> candidate, deduped across scopes

    for (const unit of this.units) {
      const completionSets = this._unitCompletionsByLevel(unit, level)
        .filter(combos => combos !== null && combos.length > 0);
      if (completionSets.length === 0) continue;

      const sourceKind = this._unitKind(unit);
      const avail = unit.indices.filter(i => this.vState(i) === CELL.NONE);
      const scopes = unit.boardIdx !== undefined ? [unit.boardIdx] : this.boardIndices;

      completionSets.forEach((combos, i) => {
        // For 'intermediate', an "other" unit is only a fair candidate if
        // it's visible from THIS SAME scope's single-board viewpoint --
        // a region on a different board isn't something this particular
        // completion set's reasoning ever looked at.
        const scopeBoardIdx = level === 'intermediate' ? scopes[i] : null;

        const seenLabels = new Set();
        const others = [];
        for (const idx of avail) {
          for (const otherUnit of this._unitsByCell[idx]) {
            if (otherUnit.label === unit.label) continue;
            if (this._unitKind(otherUnit) === sourceKind) continue;
            if (scopeBoardIdx !== null && otherUnit.boardIdx !== undefined && otherUnit.boardIdx !== scopeBoardIdx) continue;
            if (seenLabels.has(otherUnit.label)) continue;
            seenLabels.add(otherUnit.label);
            others.push(otherUnit);
          }
        }

        for (const other of others) {
          const key = `${unit.label}|${other.label}`;
          if (candidateMap.has(key)) continue;

          const otherStars = other.indices.filter(i => this.vState(i) === CELL.STAR).length;
          const otherNeeded = this.starsPerGroup - otherStars;
          if (otherNeeded <= 0) continue;

          const otherSet = new Set(other.indices);
          const allSatisfy = combos.every(combo =>
            combo.filter(c => otherSet.has(c)).length === otherNeeded
          );
          if (!allSatisfy) continue;

          const unitSet = new Set(unit.indices);
          const targets = other.indices.filter(idx => !unitSet.has(idx) && this.vState(idx) === CELL.NONE);
          if (targets.length > 0) {
            candidateMap.set(key, { unit, other, targets });
          }
        }
      });
    }

    const candidates = [...candidateMap.values()];
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (a.targets[0] ?? 0) - (b.targets[0] ?? 0));

    const caveat = level === 'intermediate' ? ' (using only this board\'s regions)' : ' (potentially combining both boards\' regions)';
    return candidates.map(({ unit, other, targets }) => ({
      description: `Every valid way to place this ${this._unitKind(unit)}'s remaining star(s)${caveat} completely fills up this ${this._unitKind(other)} too, so the rest of that ${this._unitKind(other)} must be dots.`,
      highlights: unit.indices
        .filter(i => this.vState(i) === CELL.NONE)
        .map(idx => ({ idx, color: HINT_COLOR.SOURCE })),
      marks: targets.map(idx => ({ idx, color: HINT_COLOR.TARGET })),
      boardIdx: unit.boardIdx ?? other.boardIdx
    }));
  };

  p.hintDisjointUnitRegionSyncMulti = function (N) {
    const candidates = [];
    // needingRegs/cellToRegionMap only depend on bIdx, not on axis or combo,
    // so compute them once per board here rather than on every combo below.
    const perBoard = this.boardIndices.map(bIdx => ({
      needingRegs: this.getRegionsNeedingStars(bIdx),
      cellToRegionMap: this.buildCellToRegionMap(bIdx),
    }));
    // Finds combinations of N rows or columns that are not necessarily adjacent
    for (const axis of ["Row", "Column"]) {
      const axisIndices = this.axisIndices[axis];
      const starlessUnitIndices = Array.from({length: this.n}, (_, i) => i)
        .filter(u => !axisIndices[u].some(i => this.vState(i) === CELL.STAR));

      for (const combo of this.getCombinations(starlessUnitIndices, N)) {
        const unitCombo = combo.map(u => axisIndices[u]);
        for (const bIdx of this.boardIndices) {
          const { needingRegs, cellToRegionMap } = perBoard[bIdx];
          const trapped = this._hintMultiRegionsTrappedInUnits(unitCombo, bIdx, axis, needingRegs);
          if (trapped) candidates.push(trapped);
          const covered = this._hintMultiUnitsCoveredByRegions(unitCombo, bIdx, axis, needingRegs, cellToRegionMap);
          if (covered) candidates.push(covered);
        }
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (a.highlights[0]?.idx ?? 0) - (b.highlights[0]?.idx ?? 0));
    return candidates;
  };

  // Generalizes hintCrossBoardRegionPinned (1★-only, solver-rules-single.js)
  // to any starsPerGroup. The 1★ version matches exactly N regions (each
  // implicitly needing exactly 1 star, since 1★ regions always need 1)
  // whose available cells all fall in the same N adjacent rows/cols --
  // which for 1★ automatically fills that window's entire quota (N rows x
  // 1 star/row = N). Once a region can need more than one star, "N regions
  // confined to N rows" no longer implies "these regions supply the
  // window's entire quota" (a window of N rows needs N * starsPerGroup
  // stars, not N) -- see _hintMultiRegionsTrappedInUnits's requiredCount
  // for the same distinction. So this pools every trapped region (any
  // board) in the window and compares their summed remaining need to the
  // window's actual requiredCount, not to N. Genuinely cross-board only:
  // an all-same-board trapped set would already have been caught earlier
  // (Medium/Hard) by hintUnitRegionSyncMulti(2/3)'s "trapped" case
  // (_hintMultiRegionsTrappedInUnits's own per-board version), so this
  // requires the trapped set to span at least 2 distinct boards. Requires
  // the trapped regions' open cells to be pairwise disjoint: since boards
  // share one physical grid, a region on board A and a region on board B
  // can include the same cell, and summing "remaining" across overlapping
  // regions would overcount how many distinct stars are actually still
  // needed. Reuses formatCrossBoardHint for consistent hint rendering
  // (including its per-region board coloring).
  p.hintCrossBoardRegionPinnedMulti = function (N, axis = "Row") {
    const n = this.n;
    const axisIndices = this.axisIndices[axis];
    const needing = this.boardIndices.flatMap(bIdx => this.getRegionsNeedingStars(bIdx));

    const candidates = [];
    for (let startU = 0; startU <= n - N; startU++) {
      const windowIndices = Array.from({ length: N }, (_, i) => axisIndices[startU + i]);
      const windowSet = new Set(windowIndices.flat());
      const allIndices = windowIndices.flat();

      const starsInWindow = allIndices.filter(i => this.vState(i) === CELL.STAR).length;
      const requiredCount = N * this.starsPerGroup - starsInWindow;
      if (requiredCount <= 0) continue;

      const trapped = needing.filter(({ region }) => {
        const regAvail = region.indices.filter(i => this.vState(i) === CELL.NONE);
        return regAvail.length > 0 && regAvail.every(idx => windowSet.has(idx));
      });
      if (trapped.length === 0) continue;

      const boardsTouched = new Set(trapped.map(e => e.region.boardIdx));
      if (boardsTouched.size < 2) continue; // same-board only: already covered elsewhere

      const idxSets = trapped.map(e => new Set(e.region.indices));
      if (!this._areDisjoint(idxSets)) continue;

      const totalTrappedNeeded = trapped.reduce((sum, e) => sum + e.remaining, 0);
      if (totalTrappedNeeded !== requiredCount) continue;

      const regUnion = new Set(trapped.flatMap(e => Array.from(e.region.indices)));
      const targets = allIndices.filter(idx => this.vState(idx) === CELL.NONE && !regUnion.has(idx));
      if (targets.length === 0) continue;

      const uList = Array.from({ length: N }, (_, i) => startU + i);

      // Match formatCrossBoardHint's expected combo entry shape.
      const comboForFormat = trapped.map(e => ({
        availableIdxs: e.region.indices.filter(i => this.vState(i) === CELL.NONE),
        original: e.region
      }));
      candidates.push({ combo: comboForFormat, targets, uList });
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (a.targets[0] ?? 0) - (b.targets[0] ?? 0));
    return candidates.map(({ combo, targets, uList }) => this.formatCrossBoardHint(combo, targets, axis, uList));
  };

  // Generalizes hintSymmetryDeduction (1★-only, solver-rules-single.js) to
  // any starsPerGroup. For 1★, i and its symmetric counterpart sharing any
  // unit (row/column/region) is ALWAYS a contradiction if both were stars
  // (every unit's quota is 1). For k★, sharing a unit is only a
  // contradiction if that specific unit's remaining need is <= 1 -- if
  // it's still >= 2, both i and its counterpart can perfectly well be
  // stars in the same unit. _cellsIncompatible below captures exactly
  // that (plus the always-true adjacency case); both the "can't be a
  // star" checks and the parity check's "mutual visibility" argument are
  // rebuilt on top of it. (The fill half, hintSymmetryFill, has no such
  // issue -- copying a known star/dot to its mirror doesn't depend on
  // quota -- so it's reused unchanged; see _getMultiStarRuleList.)
  p._cellsIncompatible = function (a, b) {
    if (this._cellsAdjacent(a, b)) return true;
    const unitsB = new Set(this._unitsByCell[b]);
    for (const unit of this._unitsByCell[a]) {
      if (!unitsB.has(unit)) continue;
      const stars = unit.indices.filter(i => this.vState(i) === CELL.STAR).length;
      if (this.starsPerGroup - stars <= 1) return true;
    }
    return false;
  };

  p.hintSymmetryDeductionMulti = function () {
    const n = this.n;
    const results = [];

    const trySeesOwnMirror = (mirrorFn, description) => {
      const marks = [];
      for (let i = 0; i < n * n; i++) {
        if (this.vState(i) !== CELL.NONE) continue;
        const mirror = mirrorFn(i);
        if (mirror === i) continue;
        if (this._cellsIncompatible(i, mirror)) marks.push({ idx: i, color: HINT_COLOR.TARGET });
      }
      if (marks.length > 0) results.push({ description, highlights: [], marks, boardIdx: undefined });
    };

    if (this.internalRotation180 || this.crossboardRotation180) {
      const description = this.internalRotation180 && this.crossboardRotation180
        ? `Each board has 180° rotational symmetry, and every board is also paired with another board that's its 180° rotation. Any cell that "sees" its own rotation (in a shared row/column, or a shared region with no room for both) cannot be a star.`
        : this.internalRotation180
        ? `Each board independently has 180° rotational symmetry. Any cell that "sees" its own rotation (in a shared row/column, or a shared region with no room for both) cannot be a star.`
        : `Every board is paired with another board that's its 180° rotation. Any cell that "sees" its counterpart (in a shared row/column, or a shared region with no room for both) cannot be a star.`;
      trySeesOwnMirror(i => (n * n - 1) - i, description);
    }

    if (this.isMainDiagonalSymmetric) {
      const description = this.mainDiagCrossBoard && this.mainDiagInternal
        ? `Every board is paired with another board that's its reflection across the main diagonal (↘), and each board also has that symmetry internally. The solution must be symmetric, so any cell that "sees" its own reflection (in a shared row/column, or a shared region with no room for both) cannot be a star.`
        : this.mainDiagInternal
        ? `Each board independently has diagonal symmetry across the main diagonal (↘). The solution must be symmetric, so any cell that "sees" its own reflection (in a shared row/column, or a shared region with no room for both) cannot be a star.`
        : `Every board is paired with another board that's its reflection across the main diagonal (↘). The solution must be symmetric, so any cell that "sees" its own reflection (in a shared row/column, or a shared region with no room for both) cannot be a star.`;
      trySeesOwnMirror(i => (i % n) * n + Math.floor(i / n), description);
    }

    if (this.isAntiDiagonalSymmetric) {
      const description = this.antiDiagCrossBoard && this.antiDiagInternal
        ? `Every board is paired with another board that's its reflection across the anti-diagonal (↙), and each board also has that symmetry internally. The solution must be symmetric, so any cell that "sees" its own reflection (in a shared row/column, or a shared region with no room for both) cannot be a star.`
        : this.antiDiagInternal
        ? `Each board independently has diagonal symmetry across the anti-diagonal (↙). The solution must be symmetric, so any cell that "sees" its own reflection (in a shared row/column, or a shared region with no room for both) cannot be a star.`
        : `Every board is paired with another board that's its reflection across the anti-diagonal (↙). The solution must be symmetric, so any cell that "sees" its own reflection (in a shared row/column, or a shared region with no room for both) cannot be a star.`;
      trySeesOwnMirror(i => (n - 1 - i % n) * n + (n - 1 - Math.floor(i / n)), description);
    }

    // Diagonal parity, generalized: for 1★ the total star count is fixed
    // at n (one per row), so the diagonal's own star count must share n's
    // parity. For k★ the fixed total is n * starsPerGroup. And "all
    // empties mutually see each other" no longer means "at most 1 could
    // be a star" for k★ -- it only does when every pair is pairwise
    // incompatible (_cellsIncompatible), which is what's checked below
    // instead of plain adjacency-or-shared-region.
    const totalStars = n * this.starsPerGroup;
    const tryDiagParity = (diagIndices, dirLabel, crossBoard, internal) => {
      const parity = totalStars % 2 === 0 ? 'even' : 'odd';
      const reason = crossBoard && internal
        ? `Every board is paired with another board that's its ${dirLabel} reflection, and each also has that symmetry internally`
        : internal
        ? `Each board independently has ${dirLabel} diagonal symmetry`
        : `Every board is paired with another board that's its ${dirLabel} reflection`;

      const diagStars = diagIndices.filter(i => this.vState(i) === CELL.STAR).length;
      const diagEmpties = diagIndices.filter(i => this.vState(i) === CELL.NONE);

      if (diagEmpties.length === 1) {
        const needStar = (diagStars % 2) !== (totalStars % 2);
        const idx = diagEmpties[0];
        const color = needStar ? HINT_COLOR.TARGET_STAR : HINT_COLOR.TARGET;
        results.push({
          description: `${reason}, so by parity the diagonal must have an ${parity} number of stars — this cell must be a ${needStar ? 'star' : 'dot'}.`,
          highlights: diagIndices.filter(i => this.vState(i) === CELL.STAR)
            .map(i => ({ idx: i, color: HINT_COLOR.SOURCE })),
          marks: [{ idx, color }],
          boardIdx: undefined
        });
      } else if (diagEmpties.length >= 2) {
        if ((diagStars % 2) !== (totalStars % 2)) return;
        const allIncompatible = diagEmpties.every((a, ai) => diagEmpties.every((b, bi) =>
          ai === bi || this._cellsIncompatible(a, b)
        ));
        if (!allIncompatible) return;
        results.push({
          description: `${reason}, so by parity the diagonal must have an ${parity} number of stars — the remaining diagonal cells must all be dots.`,
          highlights: diagIndices.filter(i => this.vState(i) === CELL.STAR)
            .map(i => ({ idx: i, color: HINT_COLOR.SOURCE })),
          marks: diagEmpties.map(i => ({ idx: i, color: HINT_COLOR.TARGET })),
          boardIdx: undefined
        });
      }
    };

    if (this.isMainDiagonalSymmetric) {
      tryDiagParity(Array.from({ length: n }, (_, k) => k * n + k), '↘', this.mainDiagCrossBoard, this.mainDiagInternal);
    }
    if (this.isAntiDiagonalSymmetric) {
      tryDiagParity(Array.from({ length: n }, (_, k) => k * n + (n - 1 - k)), '↙', this.antiDiagCrossBoard, this.antiDiagInternal);
    }

    return results.length > 0 ? results : null;
  };

  // Rule (2★/3★): For a row/column/region with missing stars, enumerate every valid
  // way to place its starsPerGroup non-touching stars, then asks one unified
  // question of every candidate cell, inside the unit or just outside it: is placing
  // a star THERE incompatible with every one of those valid placements?
  //  - Inside the unit: a cell absent from some placement is incompatible with it,
  //    since starring it in addition to that placement would overfill the unit's
  //    quota.
  //  - Just outside the unit (any cell touching one of its cells): a cell is
  //    incompatible with a placement if it's adjacent (including diagonally) to one
  //    of that placement's stars.
  // If EVERY valid placement is incompatible with starring a given cell, that cell
  // must be a dot -- whichever placement turns out to be real, a star there
  // couldn't coexist with it. Symmetrically, a cell INSIDE the unit that's present
  // in every placement must itself be a star: a dot there would leave no valid way
  // to fill the unit at all. (Outside cells have no such "forced star" case -- a dot
  // outside never conflicts with completing the unit.)
  //
  // This one test covers what used to be two separate rules -- one for cells inside
  // the unit, one for cells outside it -- since both ask the same question, just of
  // different cells. It also renders as a single combined hint: a player doesn't
  // need to know whether a given marked cell is forced by the overfill argument or
  // the touching argument, just that a star can't go there.
  p.hintUnitPlacementForced = function (level = 'strong', filterCondition = null) {
    // 'all_stars'/'any_star' only ever look at forcedStars (see below), so skip the
    // dot-side enumeration entirely for those -- same cost as before this rule
    // absorbed the outside-cell case.
    const wantsDots = filterCondition !== 'all_stars' && filterCondition !== 'any_star';

    const candidates = [];
    for (const unit of this.units) {
      const stars = unit.indices.filter(i => this.vState(i) === CELL.STAR);
      const needed = this.starsPerGroup - stars.length;
      if (needed <= 0) continue;

      const completionSets = this._unitCompletionsByLevel(unit, level)
        .filter(combos => combos !== null && combos.length > 0);
      if (completionSets.length === 0) continue;

      const unitSet = new Set(unit.indices);
      const avail = unit.indices.filter(i => this.vState(i) === CELL.NONE);

      // Union across scopes: forced if ANY single scope's combos alone
      // already prove it -- see _unitCompletionsByLevel.
      let forcedStars = avail.filter(cell => completionSets.some(combos => combos.every(combo => combo.includes(cell))));
      let forcedDots = [];

      if (wantsDots) {
        // Cells just outside the unit: touching one of its cells, not
        // already decided, and not themselves part of the unit.
        const outside = new Set();
        for (const cell of unit.indices) {
          for (const nb of this.getNeighbors(cell)) {
            if (!unitSet.has(nb) && this.vState(nb) === CELL.NONE) outside.add(nb);
          }
        }

        const starIncompatible = (cell, combo) =>
          unitSet.has(cell) ? !combo.includes(cell) : combo.some(s => this._cellsAdjacent(s, cell));

        forcedDots = [...avail, ...outside].filter(cell =>
          completionSets.some(combos => combos.every(combo => starIncompatible(cell, combo)))
        );
      }

      if (filterCondition === 'all_stars') {
        if (forcedStars.length !== needed) forcedStars = [];
      } else if (filterCondition === 'any_star') {
        if (forcedStars.length === 0 || forcedStars.length === needed) forcedStars = [];
      } else if (filterCondition === 'dots') {
        forcedStars = [];
      }

      if (forcedStars.length > 0 || forcedDots.length > 0) {
        candidates.push({ unit, forcedStars, forcedDots });
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.unit.indices[0] - b.unit.indices[0]);

    const caveat = level === 'weak' ? ""
      : level === 'intermediate' ? ", also accounting for other rows/columns/regions' star limits on this board,"
      : ", also accounting for other rows/columns/regions' star limits across every board,";
    const hints = [];
    for (const { unit, forcedStars, forcedDots } of candidates) {
      const unitType = this._unitKind(unit);
      const starsWord = `${this.starsPerGroup} non-touching star${this.starsPerGroup === 1 ? '' : 's'}`;

      if (forcedStars.length > 0) {
        hints.push({
          description: `Every way to place this ${unitType}'s ${starsWord}${caveat} includes the marked cell, so it must be a star.`,
          highlights: unit.indices
            .filter(i => this.vState(i) === CELL.NONE && !forcedStars.includes(i))
            .map(idx => ({ idx, color: HINT_COLOR.SOURCE })),
          marks: forcedStars.map(idx => ({ idx, color: HINT_COLOR.TARGET_STAR })),
          boardIdx: unit.boardIdx
        });
      }
      // One combined hint for every forced dot this unit produces, inside or
      // outside its own cells -- a player doesn't need to know WHICH of the
      // two mechanisms applies to which marked cell, just that a star can't
      // go there.
      if (forcedDots.length > 0) {
        hints.push({
          description: `Every valid way to place this ${unitType}'s ${starsWord}${caveat} is incompatible with a star at the marked cell(s), so they must be dots.`,
          highlights: unit.indices
            .filter(i => this.vState(i) === CELL.NONE && !forcedDots.includes(i))
            .map(idx => ({ idx, color: HINT_COLOR.SOURCE })),
          marks: forcedDots.map(idx => ({ idx, color: HINT_COLOR.TARGET })),
          boardIdx: unit.boardIdx
        });
      }
    }
    return hints;
  };

  // --- 2★/3★-generalized row/col <-> region sync ---
  // These mirror _hintUnitsCoveredByRegions / _hintRegionsTrappedInUnits (in
  // solver-rules-single.js), but work off each region's remaining star COUNT (via
  // getRegionsNeedingStars) rather than just whether it has any star at all, so they
  // stay correct when a region or row/col can hold more than one star.

  // Case (a): if the regions touching N adjacent rows/cols need, in total, exactly as
  // many stars as those rows/cols still need, then all of those regions' remaining
  // stars must land inside the window — so the rest of those regions must be dots.
  // `needingRegs`/`cellToRegionMap` are precomputed once per board by the
  // caller (they only depend on bIdx, not on unitCombo) rather than
  // recomputed on every window this is checked against.
  p._hintMultiUnitsCoveredByRegions = function (unitCombo, bIdx, axis, needingRegs, cellToRegionMap) {
    const windowIndices = unitCombo.flat();
    const windowSet = new Set(windowIndices);

    const starsInWindow = windowIndices.filter(i => this.vState(i) === CELL.STAR).length;
    const requiredCount = unitCombo.length * this.starsPerGroup - starsInWindow;
    if (requiredCount <= 0) return null;

    const availInUnits = windowIndices.filter(i => this.vState(i) === CELL.NONE);
    if (availInUnits.length === 0) return null;

    const touchingLabels = new Set(availInUnits.map(idx => cellToRegionMap[idx]).filter(Boolean));
    const touchingRegs = needingRegs.filter(({ region }) => touchingLabels.has(region.label));

    const totalTouchingNeeded = touchingRegs.reduce((sum, { remaining }) => sum + remaining, 0);
    if (touchingRegs.length === 0 || totalTouchingNeeded !== requiredCount) return null;

    const regUnion = new Set(touchingRegs.flatMap(({ region }) => region.indices));
    const targets = Array.from(regUnion)
      .filter(idx => !windowSet.has(idx) && this.vState(idx) === CELL.NONE);

    if (targets.length === 0) return null;

    const targetSet = new Set(targets);
    const N = unitCombo.length;
    const unitsPhrase = N === 1 ? `this ${axis.toLowerCase()}` : `these ${N} ${axis.toLowerCase()}s`;
    const starsPhrase = requiredCount === 1 ? "1 star" : `${requiredCount} stars`;

    return {
      boardIdx: bIdx,
      description: `The blue region(s) still need exactly ${starsPhrase} in total — exactly what's left for ${unitsPhrase} — so all of it must land inside, and the rest of those regions must be dots.`,
      highlights: touchingRegs.flatMap(({ region }) =>
        region.indices.filter(i => this.vState(i) === CELL.NONE && !targetSet.has(i))
      ).map(idx => ({ idx, color: HINT_COLOR.SOURCE })),
      marks: targets.map(idx => ({ idx, color: HINT_COLOR.TARGET }))
    };
  };

  // Case (b): if the regions entirely confined to N adjacent rows/cols need, in total,
  // exactly as many stars as those rows/cols still need, then those rows/cols' entire
  // remaining quota must come from those regions — so the rest of the window (outside
  // those regions) must be dots.
  // `needingRegs` is precomputed once per board by the caller (see
  // _hintMultiUnitsCoveredByRegions above).
  p._hintMultiRegionsTrappedInUnits = function (windowIndices, bIdx, axis, needingRegs) {
    const windowSet = new Set(windowIndices.flat());
    const allIndices = windowIndices.flat();

    const starsInWindow = allIndices.filter(i => this.vState(i) === CELL.STAR).length;
    const requiredCount = windowIndices.length * this.starsPerGroup - starsInWindow;
    if (requiredCount <= 0) return null;

    const pinnedRegs = needingRegs.filter(({ region }) => {
      const regAvail = region.indices.filter(i => this.vState(i) === CELL.NONE);
      return regAvail.length > 0 && regAvail.every(idx => windowSet.has(idx));
    });

    const totalPinnedNeeded = pinnedRegs.reduce((sum, { remaining }) => sum + remaining, 0);
    if (pinnedRegs.length === 0 || totalPinnedNeeded !== requiredCount) return null;

    const regUnion = new Set(pinnedRegs.flatMap(({ region }) => region.indices));
    const targets = allIndices.filter(idx =>
      this.vState(idx) === CELL.NONE && !regUnion.has(idx)
    );

    if (targets.length === 0) return null;

    const targetSet = new Set(targets);
    const N = windowIndices.length;
    const unitsPhrase = N === 1 ? `this ${axis.toLowerCase()}` : `these ${N} ${axis.toLowerCase()}s`;
    const starsPhrase = requiredCount === 1 ? "1 star" : `${requiredCount} stars`;

    return {
      boardIdx: bIdx,
      description: `${unitsPhrase[0].toUpperCase()}${unitsPhrase.slice(1)} still need exactly ${starsPhrase} in total, which is exactly what's left in the blue region(s) — so the rest of ${unitsPhrase} must be dots.`,
      highlights: pinnedRegs.flatMap(({ region }) =>
        region.indices.filter(i => this.vState(i) === CELL.NONE && !targetSet.has(i))
      ).map(idx => ({ idx, color: HINT_COLOR.SOURCE })),
      marks: targets.map(idx => ({ idx, color: HINT_COLOR.TARGET }))
    };
  };

  // Find all 2★/3★-generalized sync hints for a window of N adjacent rows/cols.
  p._hintMultiWindowRegionSyncAll = function (N, axis) {
    const n = this.n;
    const axisIndices = this.axisIndices[axis];

    const windows = Array.from({ length: n - N + 1 }, (_, startU) =>
      Array.from({ length: N }, (_, i) => axisIndices[startU + i]));

    const candidates = [];
    for (const bIdx of this.boardIndices) {
      const needingRegs = this.getRegionsNeedingStars(bIdx);
      const cellToRegionMap = this.buildCellToRegionMap(bIdx);
      for (const windowIndices of windows) {
        const trapped = this._hintMultiRegionsTrappedInUnits(windowIndices, bIdx, axis, needingRegs);
        if (trapped) candidates.push(trapped);

        const covered = this._hintMultiUnitsCoveredByRegions(windowIndices, bIdx, axis, needingRegs, cellToRegionMap);
        if (covered) candidates.push(covered);
      }
    }
    return candidates;
  };

  // Rule (2★/3★): Check N adjacent rows/columns synchronized with the regions they touch,
  // accounting for units and regions that can hold more than 1 star.
  p.hintUnitRegionSyncMulti = function (N) {
    const candidates = [];
    for (const axis of ["Row", "Column"]) {
      candidates.push(...this._hintMultiWindowRegionSyncAll(N, axis));
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (a.highlights[0]?.idx ?? 0) - (b.highlights[0]?.idx ?? 0));
    return candidates;
  };

  // Rule (2★+): speculatively place one star, add only the dots that single star
  // directly implies (adjacency, plus any row/column/region it happens to complete),
  // and check whether that already breaks some unit on ONE board's view alone.
  //
  // Unlike the 1★ version, placing a single star does NOT usually fill an entire
  // row/column/region when starsPerGroup > 1 -- only units that already held
  // (starsPerGroup - 1) stars get completed by this one placement. Region
  // elimination is restricted to a single board at a time, so a contradiction is
  // only accepted if it's visible from that board's viewpoint alone (or is
  // board-agnostic row/col/adjacency geometry).
  // Shared implementation for hintLookaheadDotsSingleBoard/hintLookaheadDots:
  // speculatively place one star, add only the dots it directly implies, and
  // check for a broken unit. singleBoard=true checks each board in turn,
  // restricting region completion (and the resulting hint) to that one
  // board's viewpoint; singleBoard=false checks region completion across
  // every board the test cell belongs to at once, catching contradictions
  // that only surface by combining information from multiple boards.
  p._hintLookaheadDotsImpl = function (singleBoard) {
    const candidates = [];

    const emptyIndices = this.game.state
      .flatMap((val, idx) => this.vState(idx) === CELL.NONE ? [idx] : []);

    const boardScopes = singleBoard
      ? this.boardIndices
      : [null];

    for (const testIdx of emptyIndices) {
      for (const bIdx of boardScopes) {
        if (singleBoard) {
          const boardReg = this._getRegionsContaining(testIdx).find(r => r.boardIdx === bIdx);
          if (!boardReg) continue;
          // Skip if this board's region has already reached quota (it's solved).
          const existingRegStars = boardReg.indices.filter(i => this.vState(i) === CELL.STAR).length;
          if (existingRegStars >= this.starsPerGroup) continue;
        }

        const sandboxState = this._buildSpeculativeState(testIdx);
        this._applyStarPlacementDots(sandboxState, testIdx, bIdx);

        const brokenUnits = singleBoard
          ? this._findAllBrokenUnits(sandboxState, bIdx)
          : this._findAllBrokenUnits(sandboxState);
        for (const broken of brokenUnits) {
          candidates.push(singleBoard ? { testIdx, broken, boardIdx: bIdx } : { testIdx, broken });
        }
      }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.testIdx - b.testIdx);
    return candidates.map(({ testIdx, broken, boardIdx }) => ({
      boardIdx: singleBoard ? boardIdx : (broken.type === 'region' ? broken.boardIdx : undefined),
      description: `The blue cells can no longer reach their required star count if the circled cell holds a star.`,
      highlights: broken.indices.map(idx => ({ idx, color: HINT_COLOR.SOURCE })),
      marks: [{ idx: testIdx, color: HINT_COLOR.TARGET }]
    }));
  };

  p.hintLookaheadDotsSingleBoard = function () {
    return this._hintLookaheadDotsImpl(true);
  };

  // Rule (2★+): same speculative single-star placement as hintLookaheadDotsSingleBoard,
  // but region completion is checked across EVERY board the test cell belongs to, so
  // contradictions that only surface when combining region information from multiple
  // boards are also caught.
  p.hintLookaheadDots = function () {
    return this._hintLookaheadDotsImpl(false);
  };

  // --- At-least-1 / at-most-1 (2★+) ------------------------------------------
  //
  // JS port of the Python engine's tiered at-least-1/at-most-1 rule family;
  // see tools/scorer/rules_multi_star.py for the full derivation of sources
  // 1-3 below. A group of cells can be known to jointly hold "at least 1"
  // star, or jointly hold "at most 1" star. Two forcing checks consume
  // those facts:
  //
  // (a) N+1 candidates, N needed (_applyAtMostOneForcing): if a unit needs
  //     2 more stars from exactly 3 candidates {x, y, z}, and some pair
  //     among them is a known at-most-1 group, that pair supplies at most
  //     1 of the 2 needed stars, so the third candidate is forced.
  // (b) Q disjoint groups fill the quota (_applyDisjointQuotaFill): if a
  //     unit needs Q more stars and Q mutually disjoint at-least-1 groups
  //     are found among its candidates, they account for the quota
  //     exactly, so every other candidate is forced to a dot.
  //
  // Three sources feed those checks, kept separate (not pooled) so a hint
  // only ever traces back to ONE kind of reasoning: sources 1 and 2 are
  // single geometric hops a player can check by eye, feeding the Hard-tier
  // hintClump* rules; source 3 is a two-hop chain, feeding the Expert-tier
  // hintWitness* rules.
  //
  // Hint UI shows the final forcing step (the at-most-1/at-least-1 group
  // and the forced cell) plus a short label for how each group was found
  // (the `source` field each producer below attaches) -- not the full
  // derivation chain (e.g. hintUnitPlacementForced still doesn't re-derive
  // _enumerateUnitCompletions for the player), but enough that a match
  // doesn't just assert "trust these highlighted cells."

  p._groupKey = function (indices) {
    return [...indices].sort((a, b) => a - b).join(',');
  };

  // Source 3's at-least-1 half. level is 'intermediate' or 'strong' (no
  // 'weak' -- same reasoning as hintUnitCompletionSatisfiesOtherUnit: a
  // capacity-free version wouldn't reliably prove anything). See
  // _unitCompletionsByLevel: 'intermediate' only ever needs one board's
  // regions to reach its conclusion; 'strong' may need both.
  // (_cellsForcedToDotIfStarred, the at-most-1 half below, is
  // deliberately NOT level-gated: it's a simple one-step consequence
  // check that's equally valid whichever board(s) it happens to touch,
  // not a capacity-combining argument.)
  p._findAtLeastOnePairs = function (level) {
    return this._cachedOnState(`atLeastOnePairs_${level}`, () => this._findAtLeastOnePairsImpl(level));
  };

  p._findAtLeastOnePairsImpl = function (level) {
    const pairs = new Map(); // key -> { indices: [i, j], source }
    for (const unit of this.units) {
      const completionSets = this._unitCompletionsByLevel(unit, level)
        .filter(combos => combos !== null && combos.length > 0);
      if (completionSets.length === 0) continue;
      const avail = unit.indices.filter(i => this.vState(i) === CELL.NONE);
      for (let idx1 = 0; idx1 < avail.length; idx1++) {
        for (let idx2 = idx1 + 1; idx2 < avail.length; idx2++) {
          const i = avail[idx1], j = avail[idx2];
          if (completionSets.some(combos => combos.every(combo => combo.includes(i) || combo.includes(j)))) {
            const key = this._groupKey([i, j]);
            if (!pairs.has(key)) {
              pairs.set(key, {
                indices: [i, j],
                source: "no valid way to complete a unit leaves both cells empty",
              });
            }
          }
        }
      }
    }
    return pairs;
  };

  // Cells that would be forced to a dot as an immediate, one-step
  // consequence of placing a star at idx: its neighbors (adjacency always
  // applies, regardless of quota), plus any row/column/region containing
  // idx that would reach its star quota as a RESULT of this one placement
  // (i.e. currently has quota - 1 stars).
  p._cellsForcedToDotIfStarred = function (idx) {
    const n = this.n;
    const quota = this.starsPerGroup;
    const forced = new Set(this.getNeighbors(idx).filter(nb => this.vState(nb) === CELL.NONE));

    const row = Math.floor(idx / n), col = idx % n;
    for (const unitIndices of [this.axisIndices.Row[row], this.axisIndices.Column[col]]) {
      const stars = unitIndices.filter(i => this.vState(i) === CELL.STAR).length;
      if (stars === quota - 1) {
        unitIndices.forEach(i => { if (i !== idx && this.vState(i) === CELL.NONE) forced.add(i); });
      }
    }

    for (const reg of this._getRegionsContaining(idx)) {
      const stars = reg.indices.filter(i => this.vState(i) === CELL.STAR).length;
      if (stars === quota - 1) {
        reg.indices.forEach(i => { if (i !== idx && this.vState(i) === CELL.NONE) forced.add(i); });
      }
    }

    return forced;
  };

  // Source 3's at-most-1 half.
  p._deriveAtMostOneGroupsFromWitnessPairs = function (atLeastOnePairs) {
    const groups = new Map();
    for (const { indices: [i, j] } of atLeastOnePairs.values()) {
      const forcedByI = this._cellsForcedToDotIfStarred(i);
      const forcedByJ = this._cellsForcedToDotIfStarred(j);
      for (const a of forcedByI) {
        for (const b of forcedByJ) {
          if (a !== b) {
            const gkey = this._groupKey([a, b]);
            if (!groups.has(gkey)) {
              groups.set(gkey, {
                indices: [a, b],
                source: "witness pair: starring either cell forces one of these empty",
              });
            }
          }
        }
      }
    }
    return groups;
  };

  // Upper bound on how many stars could simultaneously occupy `cells`,
  // from mutual non-adjacency alone -- always sound regardless of what
  // units the cells belong to. Brute-forces every subset, so only meant
  // for small cell sets (a "tiny clump", e.g. bounded by a 2x2 box --
  // which always gives exactly 1 -- or smaller/sparser).
  p._maxStarsFittable = function (cells) {
    const arr = [...cells];
    const n = arr.length;
    let best = 0;
    for (let mask = 1; mask < (1 << n); mask++) {
      const subset = [];
      for (let i = 0; i < n; i++) {
        if (mask & (1 << i)) subset.push(arr[i]);
      }
      if (subset.length <= best) continue;
      let ok = true;
      for (let a = 0; a < subset.length && ok; a++) {
        for (let b = a + 1; b < subset.length; b++) {
          if (this._cellsAdjacent(subset[a], subset[b])) { ok = false; break; }
        }
      }
      if (ok) best = subset.length;
    }
    return best;
  };

  // Cap on the region's "leftover" cell count source 1 will analyze via
  // _maxStarsFittable's brute force -- keeps it a cheap "tiny clump" check
  // rather than a full sub-region solver.
  p._LINE_SPLIT_REMAINDER_CAP = 4;

  // Small memoization helper for the Hard/Expert "clump"/"witness" analysis
  // passes below: several sibling rules (hintClump*, hintWitness*) each
  // independently trigger the same expensive board-wide scan when they run
  // within the same getHint() call, since only the FIRST rule to produce
  // hints ever gets returned and this.game.state never changes mid-call
  // (it's only ever mutated by player actions between hint requests).
  // Keyed on a snapshot of this.game.state rather than tracked mutation
  // sites, so a cache hit is only ever returned for a state identical to
  // the one it was computed from.
  p._cachedOnState = function (cacheKey, computeFn) {
    const stateString = this.game.state.join(',');
    if (!this._stateCache) this._stateCache = {};
    const bucket = this._stateCache[cacheKey];
    if (bucket && bucket.stateString === stateString) return bucket.value;
    const value = computeFn();
    this._stateCache[cacheKey] = { stateString, value };
    return value;
  };

  // Source 1 (see class-level comment above). Returns { directDotHints,
  // atMostGroups, atLeastGroups }: directDotHints is every "rest of the
  // line is entirely dots" hint found; atMostGroups is every "rest of
  // line" cell set found to hold at most 1 star instead; atLeastGroups is
  // every "inLine" cell set proven to hold at least 1 star (only when
  // that bound is exactly 1). atMostGroups/atLeastGroups values are
  // { indices, source }, source being a short player-facing label for how
  // that group was found -- shown in the hint text so a match doesn't just
  // say "trust me" (see _applyAtMostOneForcing / _applyDisjointQuotaFill).
  p._regionLineSplitFacts = function () {
    return this._cachedOnState('regionLineSplitFacts', () => this._regionLineSplitFactsImpl());
  };

  p._regionLineSplitFactsImpl = function () {
    const directDotHints = [];
    const atMostGroups = new Map();
    const atLeastGroups = new Map();
    const cap = this._LINE_SPLIT_REMAINDER_CAP;
    const n = this.n;

    for (const bIdx of this.boardIndices) {
      const regionsOnBoard = this.units.filter(u => this._unitKind(u) === "region" && u.boardIdx === bIdx);
      for (const region of regionsOnBoard) {
        const avail = region.indices.filter(i => this.vState(i) === CELL.NONE);
        if (avail.length < 2) continue;
        const starsInRegion = region.indices.filter(i => this.vState(i) === CELL.STAR).length;
        const k = this.starsPerGroup - starsInRegion;
        if (k <= 0) continue;

        for (const axis of ["Row", "Column"]) {
          const lines = new Map(); // lineIdx -> cells of `avail` in that line
          for (const i of avail) {
            const key = axis === "Row" ? Math.floor(i / n) : i % n;
            if (!lines.has(key)) lines.set(key, []);
            lines.get(key).push(i);
          }

          for (const [lineIdx, inLine] of lines) {
            const inLineSet = new Set(inLine);
            const remainder = avail.filter(i => !inLineSet.has(i));
            if (remainder.length === 0 || remainder.length > cap) continue;
            const m = this._maxStarsFittable(remainder);
            const q = k - m;
            if (q < 1) continue; // remainder alone could already cover it

            if (q === 1) {
              const inLineKey = this._groupKey(inLine);
              if (!atLeastGroups.has(inLineKey)) {
                atLeastGroups.set(inLineKey, {
                  indices: inLine,
                  source: "the region's leftover need forces a star into this segment",
                });
              }
            }

            const lineIndices = this.axisIndices[axis][lineIdx];
            const lineStars = lineIndices.filter(i => this.vState(i) === CELL.STAR).length;
            const lineNeeded = this.starsPerGroup - lineStars;
            const restOfLine = lineIndices.filter(i => this.vState(i) === CELL.NONE && !inLineSet.has(i));
            if (restOfLine.length === 0) continue;

            const bound = lineNeeded - q;
            const axisWord = axis.toLowerCase();
            if (bound <= 0) {
              directDotHints.push({
                boardIdx: bIdx,
                description: `This region still needs ${k} star${k === 1 ? '' : 's'}, but the small cluster outside this ${axisWord} (blue) can hold at most ${m}, so its portion in this ${axisWord} (blue) must supply the rest -- leaving no room for stars anywhere else in this ${axisWord}.`,
                highlights: inLine.map(idx => ({ idx, color: HINT_COLOR.SOURCE }))
                  .concat(remainder.map(idx => ({ idx, color: HINT_COLOR.SOURCE }))),
                marks: restOfLine.map(idx => ({ idx, color: HINT_COLOR.TARGET })),
              });
            } else if (bound === 1) {
              const gkey = this._groupKey(restOfLine);
              if (!atMostGroups.has(gkey)) {
                atMostGroups.set(gkey, {
                  indices: restOfLine,
                  source: "the rest of the region is capped to at most 1 star here",
                });
              }
            }
          }
        }
      }
    }

    return { directDotHints, atMostGroups, atLeastGroups };
  };

  // Source 2 (see class-level comment above). Board-agnostic: rows/columns
  // are shared across every board, so this never loops over per-board
  // regions, unlike source 1.
  p._findLinePairBoxCoverGroups = function () {
    return this._cachedOnState('linePairBoxCoverGroups', () => this._findLinePairBoxCoverGroupsImpl());
  };

  p._findLinePairBoxCoverGroupsImpl = function () {
    const groups = new Map();
    const n = this.n;

    for (const axis of ["Row", "Column"]) {
      const units = this.axisIndices[axis];
      for (let start = 0; start < n - 1; start++) {
        const windowIndices = units[start].concat(units[start + 1]);
        const avail = windowIndices.filter(i => this.vState(i) === CELL.NONE);
        if (avail.length === 0) continue;
        const starsInWindow = windowIndices.filter(i => this.vState(i) === CELL.STAR).length;
        const required = 2 * this.starsPerGroup - starsInWindow;
        if (required <= 0) continue;

        // Positions along the OTHER axis (columns, if axis === "Row")
        // that have at least one empty cell in this band.
        const otherPositions = [...new Set(
          avail.map(i => axis === "Row" ? i % n : Math.floor(i / n))
        )].sort((a, b) => a - b);

        // Greedy minimum covering by width-2 spans: start a box at the
        // leftmost uncovered position, extend one more position right,
        // skip everything that box now covers, repeat -- the standard
        // optimal strategy for "minimum number of fixed-width intervals
        // to cover a set of points", and naturally disjoint (each skips
        // past its own full span before the next one starts).
        const boxes = [];
        let idx = 0;
        while (idx < otherPositions.length) {
          const c0 = otherPositions[idx];
          boxes.push([c0, c0 + 1]);
          idx++;
          while (idx < otherPositions.length && otherPositions[idx] <= c0 + 1) idx++;
        }

        if (boxes.length !== required) continue;

        for (const [c0, c1] of boxes) {
          const boxCells = avail.filter(i => {
            const pos = axis === "Row" ? i % n : Math.floor(i / n);
            return pos === c0 || pos === c1;
          });
          if (boxCells.length > 0) {
            const key = this._groupKey(boxCells);
            if (!groups.has(key)) {
              groups.set(key, {
                indices: boxCells,
                source: "paired rows/cols covered by 2x2 boxes",
              });
            }
          }
        }
      }
    }

    return groups;
  };

  // For a unit needing N more stars from exactly N+1 remaining candidates,
  // if some pair among them is a subset of any known at-most-1 group,
  // that pair supplies at most 1 of the N needed stars -- so the other
  // N-1 candidates must jointly supply at least N-1, and since there are
  // exactly that many of them, ALL of them are forced to stars
  // (pigeonhole). N=2 is the classic case (a single "third candidate"
  // forced); this generalizes to any N>=2, which matters for 3-star+
  // puzzles where a unit can need 3 or more stars from 4 or more
  // candidates.
  // `atMostOneGroups` values are { indices, source } -- source is a short
  // player-facing label for how that group was proven at-most-1 (see the
  // three producers above: region/line-split, box covering, witness
  // projection), surfaced in the hint text below instead of the old vague
  // "based on other constraints elsewhere on the board".
  p._applyAtMostOneForcing = function (atMostOneGroups) {
    const hints = [];
    const groupList = [...atMostOneGroups.values()];
    for (const unit of this.units) {
      const stars = unit.indices.filter(i => this.vState(i) === CELL.STAR).length;
      const needed = this.starsPerGroup - stars;
      if (needed < 2) continue;
      const avail = unit.indices.filter(i => this.vState(i) === CELL.NONE);
      if (avail.length !== needed + 1) continue;

      for (let x = 0; x < avail.length; x++) {
        for (let y = x + 1; y < avail.length; y++) {
          const a = avail[x], b = avail[y];
          const matched = groupList.find(g => g.indices.includes(a) && g.indices.includes(b));
          if (matched) {
            const rest = avail.filter(i => i !== a && i !== b);
            hints.push({
              boardIdx: unit.boardIdx,
              description: rest.length === 1
                ? `At most one of the two blue-highlighted candidates can be a star (${matched.source}), so the remaining candidate must be a star.`
                : `At most one of the two blue-highlighted candidates can be a star (${matched.source}), and that's not enough to cover this unit's remaining need on its own -- so every other candidate must be a star.`,
              highlights: [a, b].map(idx => ({ idx, color: HINT_COLOR.SOURCE })),
              marks: rest.map(idx => ({ idx, color: HINT_COLOR.TARGET_STAR })),
            });
          }
        }
      }
    }
    return hints;
  };

  // Backtracking search for k mutually disjoint groups among `groups`
  // (each { indices, source }). Returns the combo (an array of k groups)
  // if found, else null. `groups` and k are both expected to be small in
  // practice (k is a unit's remaining star quota -- at most
  // starsPerGroup), so this is cheap.
  p._findDisjointGroupCombo = function (groups, k) {
    const backtrack = (start, chosen, used) => {
      if (chosen.length === k) return chosen;
      for (let idx = start; idx < groups.length; idx++) {
        const g = groups[idx];
        if (g.indices.some(c => used.has(c))) continue;
        const result = backtrack(idx + 1, [...chosen, g], new Set([...used, ...g.indices]));
        if (result) return result;
      }
      return null;
    };
    return backtrack(0, [], new Set());
  };

  // For a unit needing exactly Q more stars: if Q mutually disjoint
  // at-least-1 groups can be found, all contained within the unit's
  // remaining candidates, those groups collectively guarantee exactly Q
  // stars -- matching the unit's remaining need exactly -- so every other
  // candidate in the unit, outside their union, must be a dot.
  //
  // Q=2 (a still-fully-open 2★ unit) needs two disjoint at-least-1
  // groups; Q=1 (a unit already at quota-1, down to its last star) needs
  // just one -- that single group fully accounts for the unit's last
  // star, so the rest of its empties are dots. Both are the same
  // principle at different Q.
  //
  // `atLeastOneGroups` values are { indices, source } (see the three
  // producers above). combo.length >= 2 pairs each group's own color
  // (cycled from HINT_SOURCE_VARIANTS) with its source in the description,
  // so a multi-group match doesn't just say "trust these colors" -- the
  // player can check each group's reasoning individually.
  p._applyDisjointQuotaFill = function (atLeastOneGroups) {
    const allGroups = [...atLeastOneGroups.values()];
    const candidates = [];
    for (const unit of this.units) {
      const stars = unit.indices.filter(i => this.vState(i) === CELL.STAR).length;
      const q = this.starsPerGroup - stars;
      if (q <= 0) continue;
      const avail = unit.indices.filter(i => this.vState(i) === CELL.NONE);
      if (avail.length <= q) continue; // nothing extra to eliminate even if this succeeds

      const availSet = new Set(avail);
      const relevant = allGroups.filter(g => g.indices.every(c => availSet.has(c)));
      if (relevant.length < q) continue;

      const combo = this._findDisjointGroupCombo(relevant, q);
      if (!combo) continue;

      const covered = new Set(combo.flatMap(g => g.indices));
      const targets = avail.filter(i => !covered.has(i));
      if (targets.length === 0) continue;

      candidates.push({ unit, combo, targets });
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (a.targets[0] ?? 0) - (b.targets[0] ?? 0));

    return candidates.map(({ unit, combo, targets }) => {
      const description = combo.length === 1
        ? `At least one of the highlighted cells must be a star (${combo[0].source}), and that's this unit's last remaining star -- so every other empty cell here must be a dot.`
        : `Each of these ${combo.length} differently-colored groups must contain a star -- `
          + combo.map((g, i) => {
            const colorName = HINT_SOURCE_VARIANTS[i % HINT_SOURCE_VARIANTS.length].replace('hint-source-', '');
            return `${colorName}: ${g.source}`;
          }).join('; ')
          + ` -- and that already accounts for every star this unit still needs, so every other empty cell here must be a dot.`;
      return {
        boardIdx: unit.boardIdx,
        description,
        // Each group gets its own color (cycled from HINT_SOURCE_VARIANTS) so
        // several disjoint groups shown at once are visually distinguishable
        // instead of blurring into one indistinct blob -- a single group
        // (the combo.length === 1 case) still just uses plain SOURCE blue.
        highlights: combo.flatMap((group, i) =>
          group.indices.map(idx => ({ idx, color: HINT_SOURCE_VARIANTS[i % HINT_SOURCE_VARIANTS.length] }))
        ),
        marks: targets.map(idx => ({ idx, color: HINT_COLOR.TARGET })),
      };
    });
  };

  // -- Hard tier: clump-sourced (sources 1 + 2, single geometric hop) --------

  // Region/line-split's self-contained direct-dots case, standalone.
  p.hintClumpDirectDots = function () {
    const { directDotHints } = this._regionLineSplitFacts();
    return directDotHints.length > 0 ? directDotHints : null;
  };

  // _applyAtMostOneForcing fed only by sources 1 and 2.
  p.hintClumpAtMostOneForcing = function () {
    const { atMostGroups } = this._regionLineSplitFacts();
    const boxGroups = this._findLinePairBoxCoverGroups();
    const atMostOneGroups = new Map([...atMostGroups, ...boxGroups]);
    if (atMostOneGroups.size === 0) return null;
    const hints = this._applyAtMostOneForcing(atMostOneGroups);
    return hints.length > 0 ? hints : null;
  };

  // _applyDisjointQuotaFill fed only by sources 1 and 2.
  p.hintClumpDisjointQuotaFill = function () {
    const { atLeastGroups } = this._regionLineSplitFacts();
    const boxGroups = this._findLinePairBoxCoverGroups();
    const atLeastOneGroups = new Map([...atLeastGroups, ...boxGroups]);
    if (atLeastOneGroups.size === 0) return null;
    return this._applyDisjointQuotaFill(atLeastOneGroups);
  };

  // -- Hard/Expert tier: witness-sourced (source 3, two-hop chain) -----------
  //
  // 'intermediate' (Hard): the at-least-1 pairs only ever needed one
  // board's regions to prove -- meaningfully harder than the
  // single-geometric-hop clump rules, but still doesn't require combining
  // both boards. 'strong' (Expert): may need both boards' regions
  // combined. Same split as hintUnitPlacementForced etc.

  // _applyAtMostOneForcing fed only by source 3.
  p.hintWitnessAtMostOneForcing = function (level = 'strong') {
    const atLeastPairs = this._findAtLeastOnePairs(level);
    if (atLeastPairs.size === 0) return null;
    const witnessGroups = this._deriveAtMostOneGroupsFromWitnessPairs(atLeastPairs);
    if (witnessGroups.size === 0) return null;
    const hints = this._applyAtMostOneForcing(witnessGroups);
    return hints.length > 0 ? hints : null;
  };

  // _applyDisjointQuotaFill fed only by source 3.
  p.hintWitnessDisjointQuotaFill = function (level = 'strong') {
    const atLeastPairs = this._findAtLeastOnePairs(level);
    if (atLeastPairs.size === 0) return null;
    return this._applyDisjointQuotaFill(atLeastPairs);
  };

  // --- Rule list for starsPerGroup >= 2 ---
  //
  // Used identically for 2★, 3★, and 4★+ puzzles.
  p._getMultiStarRuleList = function () {
    return [
      // Error validation
      { key: 'checkForErrors',                 fn: () => this.hintCheckForErrors() },
      { key: 'alreadySolved',                  fn: () => this.hintAlreadySolved() },
      // Beginner
      { key: 'onlyEmpty',                      fn: () => this.hintOnlyEmpty() },
      { key: 'excludeAdjacency',               fn: () => this.hintExcludeAdjacency() },
      { key: 'excludeSolvedUnit',              fn: () => this.hintExcludeSolvedUnit() },
      { key: 'unitPlacementForcedWeakAll',     fn: () => this.hintUnitPlacementForced('weak', 'all_stars') },
      { key: 'unitPlacementForcedWeakAny',     fn: () => this.hintUnitPlacementForced('weak', 'any_star') },
      // 'dots' covers both inside-the-unit and outside-the-unit forced dots --
      // see hintUnitPlacementForced's comment for the unified reasoning.
      { key: 'unitPlacementForcedWeakDots',    fn: () => this.hintUnitPlacementForced('weak', 'dots') },
      // Medium
      { key: 'unitRegionSyncMulti1',           fn: () => this.hintUnitRegionSyncMulti(1) },
      { key: 'unitPlacementForcedIntermediateAll', fn: () => this.hintUnitPlacementForced('intermediate', 'all_stars') },
      { key: 'unitRegionSyncMulti2',           fn: () => this.hintUnitRegionSyncMulti(2) },
      // Reused directly from applySingleStarRules -- copying a known
      // star/dot to its symmetric counterpart doesn't depend on
      // starsPerGroup, so no multi-star variant is needed.
      { key: 'symmetryFillMulti',              fn: () => this.hintSymmetryFill() },
      // Hard
      { key: 'unitPlacementForcedIntermediateAny',  fn: () => this.hintUnitPlacementForced('intermediate', 'any_star') },
      { key: 'unitPlacementForcedIntermediateDots', fn: () => this.hintUnitPlacementForced('intermediate', 'dots') },
      { key: 'unitRegionSyncMulti3',           fn: () => this.hintUnitRegionSyncMulti(3) },
      { key: 'regionSubsetSync1',              fn: () => this.hintRegionSubsetSync(1) },
      { key: 'regionSyncSubset2',              fn: () => this.hintRegionSubsetSync(2) },
      { key: 'unitRegionSyncMulti4Plus',       fn: () => {
          const candidates = [];
          for (let n = 4; n < this.n; n++) {
            for (const axis of ["Row", "Column"]) {
              candidates.push(...this._hintMultiWindowRegionSyncAll(n, axis));
            }
          }
          return candidates.length > 0 ? candidates : null;
        }
      },
      { key: 'unitCompletionSatisfiesOtherUnitIntermediate', fn: () => this.hintUnitCompletionSatisfiesOtherUnit('intermediate') },
      { key: 'clumpDirectDots',                fn: () => this.hintClumpDirectDots() },
      { key: 'clumpAtMostOneForcing',          fn: () => this.hintClumpAtMostOneForcing() },
      { key: 'clumpDisjointQuotaFill',         fn: () => this.hintClumpDisjointQuotaFill() },
      { key: 'witnessAtMostOneForcingIntermediate', fn: () => this.hintWitnessAtMostOneForcing('intermediate') },
      { key: 'witnessDisjointQuotaFillIntermediate', fn: () => this.hintWitnessDisjointQuotaFill('intermediate') },
      // Symmetry - requires insight but not hard to apply
      { key: 'symmetryDeductionMulti',         fn: () => this.hintSymmetryDeductionMulti() },
      // Expert
      // The full (cross-board) strong variants: a deduction here may
      // require combining BOTH boards' region layouts, unlike the
      // Medium/Hard intermediate variants above, which only ever need one
      // board's information at a time.
      { key: 'unitPlacementForcedStrongAll',   fn: () => this.hintUnitPlacementForced('strong', 'all_stars') },
      { key: 'unitPlacementForcedStrongAny',   fn: () => this.hintUnitPlacementForced('strong', 'any_star') },
      { key: 'unitPlacementForcedStrongDots',  fn: () => this.hintUnitPlacementForced('strong', 'dots') },
      { key: 'unitCompletionSatisfiesOtherUnitStrong', fn: () => this.hintUnitCompletionSatisfiesOtherUnit('strong') },
      { key: 'disjointUnitRegionSyncMulti2',   fn: () => this.hintDisjointUnitRegionSyncMulti(2) },
      { key: 'witnessAtMostOneForcingStrong',  fn: () => this.hintWitnessAtMostOneForcing('strong') },
      { key: 'witnessDisjointQuotaFillStrong', fn: () => this.hintWitnessDisjointQuotaFill('strong') },
      // Cross-board N-regions-pin-N-rows/cols: generalizes the 1★-only
      // hintCrossBoardRegionPinned to any starsPerGroup. Always genuinely
      // cross-board (see hintCrossBoardRegionPinnedMulti's comment).
      { key: 'crossBoardPinnedMulti2Row',      fn: () => this.hintCrossBoardRegionPinnedMulti(2, "Row") },
      { key: 'crossBoardPinnedMulti2Col',      fn: () => this.hintCrossBoardRegionPinnedMulti(2, "Column") },
      { key: 'crossBoardPinnedMulti3Row',      fn: () => this.hintCrossBoardRegionPinnedMulti(3, "Row") },
      { key: 'crossBoardPinnedMulti3Col',      fn: () => this.hintCrossBoardRegionPinnedMulti(3, "Column") },
      { key: 'regionSubsetSync3',              fn: () => this.hintRegionSubsetSync(3) },
      { key: 'regionSubsetSync4',              fn: () => this.hintRegionSubsetSync(4) },
      { key: 'lookaheadDotsSingleBoard',       fn: () => this.hintLookaheadDotsSingleBoard() },
      { key: 'lookaheadDots',                  fn: () => this.hintLookaheadDots() },
      // Grandmaster
      { key: 'lookaheadLoop1',                 fn: () => this.hintLookahead(1) },
      { key: 'lookaheadLoop2',                 fn: () => this.hintLookahead(2) },
      { key: 'lookaheadLoop3',                 fn: () => this.hintLookahead(3) },
      { key: 'lookaheadLoop8',                 fn: () => this.hintLookahead(8) },
      { key: 'fromSolution',                  fn: () => this.hintFromSolution() },
    ];
  };
}
