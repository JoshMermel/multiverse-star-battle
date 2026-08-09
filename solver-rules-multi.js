import { CELL, HINT_COLOR, HINT_SOURCE_VARIANTS, TILE_OUTLINE_COLORS, LINE_HIGHLIGHT_COLOR } from './constants.js';

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

  // -- Region/line quota fill (2★+) --------------------------------------------
  //
  // A more powerful generalization of the "Rule of Clumps" (region/line-split,
  // Python's rules_multi_star.py -- not currently ported to JS): instead of the
  // cheap "remainder capped at m stars" heuristic, this asks
  // _unitCompletionsByLevel's full placement enumeration directly: across EVERY
  // valid way to place a region's remaining stars, how many of them are
  // guaranteed to land in a given row/column, no matter which valid placement
  // turns out to be real? E.g. a region shaped like [(0,0),(0,1),(0,2),(1,0),
  // (2,0)] with 1 star left has multiple valid placements, but every one of
  // them puts a star somewhere in row 0 AND somewhere in column A -- so this
  // region is worth "at least 1" to each of those lines, even though it isn't
  // confined to either one (unlike _hintMultiRegionsTrappedInUnits below, which
  // requires full confinement).
  //
  // A row/column's own quota need is met once enough of these per-region
  // guarantees (found on ONE board's own regions -- this reasoning is
  // deliberately single-board only, never combining regions across boards) add
  // up to exactly what's left. Regions are a strict partition of the board, so
  // distinct regions' guarantees about the same line never double count -- any
  // subset of them sums safely. Once some subset sums to exactly the line's
  // remaining need, every other empty cell in that line (i.e. in regions NOT in
  // that subset) must be a dot: the true solution already has nothing left over
  // for them. (Cells from a CHOSEN region beyond its own counted guarantee stay
  // untouched -- we know the count, not which of the region's cells in the line
  // realizes it.) Python port: rules_multi_star.py's matching section.

  // Every region, on any board, PROVEN (at the given _unitCompletionsByLevel
  // level) to place at least k >= 1 of its remaining stars in a given
  // row/column, regardless of which of its own valid completions turns out to
  // be real. Returns a Map keyed by `row:r` / `col:c` -> [{ boardIdx, k, unit }].
  p._regionLineGuarantees = function (level) {
    return this._cachedOnState(`regionLineGuarantees_${level}`, () => this._regionLineGuaranteesImpl(level));
  };

  p._regionLineGuaranteesImpl = function (level) {
    const result = new Map();
    for (const unit of this.units) {
      if (unit.boardIdx === undefined) continue; // rows/columns aren't a source here, only regions

      const completionSets = this._unitCompletionsByLevel(unit, level)
        .filter(combos => combos !== null && combos.length > 0);
      if (completionSets.length === 0) continue;
      // Regions always resolve to exactly one scope (see _unitCompletionsByLevel:
      // a region's boardIdx is never undefined, so 'intermediate' also collapses
      // to a single scope).
      const combos = completionSets[0];

      const rowsTouched = new Set(), colsTouched = new Set();
      for (const combo of combos) {
        for (const cell of combo) {
          rowsTouched.add(Math.floor(cell / this.n));
          colsTouched.add(cell % this.n);
        }
      }

      for (const r of rowsTouched) {
        const k = Math.min(...combos.map(combo => combo.filter(cell => Math.floor(cell / this.n) === r).length));
        if (k >= 1) {
          const key = `row:${r}`;
          if (!result.has(key)) result.set(key, []);
          result.get(key).push({ boardIdx: unit.boardIdx, k, unit });
        }
      }
      for (const c of colsTouched) {
        const k = Math.min(...combos.map(combo => combo.filter(cell => cell % this.n === c).length));
        if (k >= 1) {
          const key = `col:${c}`;
          if (!result.has(key)) result.set(key, []);
          result.get(key).push({ boardIdx: unit.boardIdx, k, unit });
        }
      }
    }
    return result;
  };

  // Backtracking search for a sublist of `items` (each { k, ... }) whose k's
  // sum EXACTLY to target. Unlike the Tiles rules' disjoint-combo search
  // (which needs exactly Q groups of weight 1 each), a region's guarantee can
  // be worth more than 1, so this is a general subset-sum search -- still
  // cheap since the candidate list is just the regions touching one line on
  // one board (at most n of them).
  p._findSubsetSumCombo = function (items, target) {
    const backtrack = (i, remaining, chosen) => {
      if (remaining === 0) return chosen.slice();
      if (i >= items.length || remaining < 0) return null;
      if (items[i].k <= remaining) {
        chosen.push(items[i]);
        const result = backtrack(i + 1, remaining - items[i].k, chosen);
        if (result) return result;
        chosen.pop();
      }
      return backtrack(i + 1, remaining, chosen);
    };
    return backtrack(0, target, []);
  };

  p.hintRegionLineQuotaFill = function (level) {
    const guarantees = this._regionLineGuarantees(level);
    const candidates = [];

    for (const [key, entries] of guarantees) {
      const [kind, idxStr] = key.split(':');
      const lineIdx = Number(idxStr);
      const lineIndices = kind === 'row' ? this.axisIndices.Row[lineIdx] : this.axisIndices.Column[lineIdx];

      const stars = lineIndices.filter(i => this.vState(i) === CELL.STAR).length;
      const needed = this.starsPerGroup - stars;
      if (needed <= 0) continue;
      const avail = lineIndices.filter(i => this.vState(i) === CELL.NONE);
      if (avail.length === 0) continue;

      // Never cross-board: group candidate regions by board and search each
      // board's regions independently.
      const byBoard = new Map();
      for (const entry of entries) {
        if (!byBoard.has(entry.boardIdx)) byBoard.set(entry.boardIdx, []);
        byBoard.get(entry.boardIdx).push(entry);
      }

      for (const [boardIdx, boardEntries] of byBoard) {
        const combo = this._findSubsetSumCombo(boardEntries, needed);
        if (!combo) continue;

        const covered = new Set(combo.flatMap(e => e.unit.indices));
        const targets = avail.filter(i => !covered.has(i));
        if (targets.length === 0) continue;

        const targetSet = new Set(targets);
        // Point at the line by its outline color, not a row number/column
        // letter -- axis labels are an optional setting (see renderer.js's
        // renderBoard), so "Row 5"/"Column C" would be meaningless to a
        // player with them off. The amber outline band (lineHighlight
        // below) is drawn either way, so it's the one identifier every
        // player actually has. Matches LINE_HIGHLIGHT_COLOR/
        // --line-highlight-amber -- keep this word in sync if that color
        // ever changes.
        const lineWord = kind === 'row' ? 'row' : 'column';
        const regionWord = combo.length === 1 ? 'region' : 'regions';
        const resolveWord = combo.length === 1 ? 'it resolves' : 'they resolve';

        candidates.push({
          boardIdx,
          description: `The amber-outlined ${lineWord} needs ${needed} more star${needed === 1 ? '' : 's'}. The highlighted ${regionWord} always put${combo.length === 1 ? 's' : ''} at least ${needed} there, no matter how ${resolveWord} -- so every other empty cell in the outlined ${lineWord} is a dot.`,
          highlights: combo.flatMap(({ unit }) =>
            unit.indices.filter(i => this.vState(i) === CELL.NONE && !targetSet.has(i))
          ).map(idx => ({ idx, color: HINT_COLOR.SOURCE })),
          marks: targets.map(idx => ({ idx, color: HINT_COLOR.TARGET })),
          lineHighlight: { boardIdx, axis: kind, index: lineIdx, color: LINE_HIGHLIGHT_COLOR },
        });
      }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.marks[0].idx - b.marks[0].idx);
    return candidates;
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

  // -- Restored from pre-experiment (2★+) --------------------------------------
  //
  // Three rule families that were cut during the multi-star-rules-experiment
  // stripping pass and later restored by explicit request. (The Clump and
  // Witness at-least-1/at-most-1 families from that same pass stay cut --
  // superseded by the Tiles/region-line-quota-fill rules above, or judged too
  // hard to explain to a player, per that decision.)

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

  // The disjoint (non-adjacent) generalization of hintUnitRegionSyncMulti(2):
  // any 2 starless rows or 2 starless columns, not just adjacent ones, checked
  // against the regions trapped in or covering them via the same
  // _hintMultiRegionsTrappedInUnits/_hintMultiUnitsCoveredByRegions helpers
  // the adjacent-window version uses.
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

  // -- Tiles (2★+, multi-star-rules-experiment) --------------------------------
  //
  // A "tile" is the set of currently-empty cells within some 2x2-bounded
  // box: two adjacent rows (or columns) times two adjacent columns (or
  // rows). Every pair of cells inside a 2x2 box touches (orthogonally or
  // diagonally), so a tile can NEVER hold more than 1 star, regardless of
  // which of its up to 4 cells are actually still empty.
  //
  // A pair of adjacent rows (or columns) -- a "band" -- still needing K
  // more stars can sometimes have its empties exactly partitioned into K
  // disjoint tiles (a "tiling"). Since each tile holds at most 1 star and
  // there are exactly K of them for K needed stars, pigeonhole forces
  // EVERY tile in that tiling to hold EXACTLY 1 star -- not just "at
  // most". A band can have more than one way to tile its empties into K
  // boxes (an isolated empty column can pair with either neighbor), so
  // multiple tilings -- and hence multiple "confirmed" (exactly-1-star)
  // tiles -- can coexist for the same band.
  //
  // Tilings are board-agnostic (row/column geometry, not regions), so
  // they're computed once per board state and reused by every board and
  // every rule below. More inferences from the same tiles are expected to
  // show up later; add them as their own hintTile* function rather than
  // folding into an existing one, so a hint always traces back to exactly
  // one idea. Python port: tools/scorer/rules_multi_star.py's "Tiles"
  // section (that one doesn't need the topLeftIdx bookkeeping below, since
  // it never renders a hint).

  // All ways to partition columns [offset, hasEmpty.length) into untouched
  // singletons (only where NOT hasEmpty) and adjacent pairs ("boxes", each
  // covering at least one hasEmpty column), such that every hasEmpty
  // position ends up inside exactly one box. Returns a list of tilings,
  // each a list of box start-column ints. A run of hasEmpty columns can
  // tile more than one way (an isolated hasEmpty column can pair with
  // either neighbor), so this can return several tilings for the same
  // hasEmpty pattern -- that's the point.
  p._findTilings = function (hasEmpty, offset = 0) {
    const n = hasEmpty.length;
    if (offset === n) return [[]];
    const results = [];
    if (!hasEmpty[offset]) {
      results.push(...this._findTilings(hasEmpty, offset + 1));
    }
    if (offset + 1 < n && (hasEmpty[offset] || hasEmpty[offset + 1])) {
      for (const rest of this._findTilings(hasEmpty, offset + 2)) {
        results.push([offset, ...rest]);
      }
    }
    return results;
  };

  // Small memoization helper: hintTile* each independently trigger the
  // same expensive tiling scan when they run within the same getHint()
  // call, since only the FIRST rule to produce hints ever gets returned
  // and this.game.state never changes mid-call. Keyed on a snapshot of
  // this.game.state rather than tracked mutation sites, so a cache hit is
  // only ever returned for a state identical to the one it was computed
  // from.
  p._cachedOnState = function (cacheKey, computeFn) {
    const stateString = this.game.state.join(',');
    if (!this._stateCache) this._stateCache = {};
    const bucket = this._stateCache[cacheKey];
    if (bucket && bucket.stateString === stateString) return bucket.value;
    const value = computeFn();
    this._stateCache[cacheKey] = { stateString, value };
    return value;
  };

  p._groupKey = function (indices) {
    return [...indices].sort((a, b) => a - b).join(',');
  };

  // Every confirmed tiling on the board: a list of { tiles }, where
  // `tiles` is the full set of K disjoint 2x2 tiles from ONE row-band or
  // column-band covering (each { cells: [idx...], topLeftIdx }) -- kept
  // together, not flattened, so a hint about any ONE tile can show the
  // player the WHOLE covering it came from: "these K tiles exactly
  // partition every empty cell of this row/column pair, which needs
  // exactly K more stars, so each tile holds exactly one" is the actual
  // argument: showing just the one relevant tile in isolation doesn't
  // convey why it's trustworthy. The same physical 2x2 square can appear
  // in more than one tiling (a row-band and a column-band view of it, or
  // two different tilings of the same band), so a tile is NOT deduped
  // away here -- see _allConfirmedTilesFlat for the deduped flat view
  // rule 3 needs instead. topLeftIdx is the box's own top-left grid cell
  // (which may not itself be one of `cells`, if that particular corner
  // is already decided) -- used only for positioning the outline overlay.
  p._confirmedTiles = function () {
    return this._cachedOnState('confirmedTiles', () => this._confirmedTilesImpl());
  };

  p._confirmedTilesImpl = function () {
    const n = this.n;
    const quota = this.starsPerGroup;
    const tilings = [];
    const isEmpty = (i) => !this.voidCells?.has(i) && this.vState(i) === CELL.NONE;
    let nextTilingId = 0;

    for (const axis of ['row', 'col']) {
      for (let u = 0; u < n - 1; u++) {
        const lineA = [], lineB = [];
        for (let c = 0; c < n; c++) {
          if (axis === 'row') {
            lineA.push(u * n + c);
            lineB.push((u + 1) * n + c);
          } else {
            lineA.push(c * n + u);
            lineB.push(c * n + (u + 1));
          }
        }

        const starsInBand = [...lineA, ...lineB].filter(i => this.vState(i) === CELL.STAR).length;
        const k = 2 * quota - starsInBand;
        if (k <= 0) continue;

        const hasEmpty = [];
        for (let c = 0; c < n; c++) {
          hasEmpty.push(isEmpty(lineA[c]) || isEmpty(lineB[c]));
        }

        for (const tiling of this._findTilings(hasEmpty)) {
          if (tiling.length !== k) continue;
          // Every tile below shares this same id -- see the color-grouping
          // comment on _colorSlotsForTiles: all tiles from one row-pair/
          // col-pair covering are meant to render as the SAME color, since
          // together they're a single argument ("these K tiles partition
          // this band's empties"), not K separate ones.
          const tilingId = nextTilingId++;
          const tiles = [];
          for (const boxStart of tiling) {
            const cells = [lineA[boxStart], lineB[boxStart], lineA[boxStart + 1], lineB[boxStart + 1]]
              .filter(isEmpty);
            if (cells.length === 0) continue;
            const topRow = axis === 'row' ? u : boxStart;
            const leftCol = axis === 'row' ? boxStart : u;
            // axis is carried on both the tiling and each tile (the latter
            // so it survives _allConfirmedTilesFlat's flattening) purely
            // for hint wording -- "row pair" vs "column pair" -- not used
            // in any geometry/matching logic.
            tiles.push({ cells, topLeftIdx: topRow * n + leftCol, tilingId, axis });
          }
          if (tiles.length > 0) tilings.push({ tiles, axis });
        }
      }
    }
    return tilings;
  };

  // Flattened, deduped view of every confirmed tile across every tiling
  // (the same physical 2x2 square can be confirmed by more than one
  // tiling) -- what rule 3 needs, since it searches for K disjoint tiles
  // regardless of which tiling(s) originally confirmed each one. Each
  // tile keeps its originating tilingId (see _confirmedTilesImpl), so a
  // hint combining tiles from several tilings can still color-group them
  // by which row-pair/col-pair covering each one came from.
  p._allConfirmedTilesFlat = function () {
    const byKey = new Map();
    for (const { tiles } of this._confirmedTiles()) {
      for (const tile of tiles) {
        const key = this._groupKey(tile.cells);
        if (!byKey.has(key)) byKey.set(key, tile);
      }
    }
    return [...byKey.values()];
  };

  // Assigns one color-slot index (0-3, cycling if more than 4 tilings are
  // combined into one hint) per DISTINCT tilingId among `tiles`, in
  // first-seen order, so every tile from the same row-pair/col-pair
  // covering renders identically -- per the request that grouped tiles all
  // be one color, and distinct coverings get distinct colors so a player
  // combining several (as rule 3 does) can tell them apart. The index is
  // shared by TILE_OUTLINE_COLORS (outline) and HINT_SOURCE_VARIANTS (cell
  // tint), which are deliberately index-matched -- see constants.js.
  p._colorSlotsForTiles = function (tiles) {
    const slotByTilingId = new Map();
    for (const t of tiles) {
      if (!slotByTilingId.has(t.tilingId)) {
        slotByTilingId.set(t.tilingId, slotByTilingId.size % TILE_OUTLINE_COLORS.length);
      }
    }
    return slotByTilingId;
  };

  // Shared by hintTileSingleEmpty/hintTileTwoEmptyDot/hintTileDisjointQuotaFill:
  // outlines EVERY tile passed in `outlineTiles` (the full covering(s), for
  // context -- so the player can see the K-tiles-for-K-stars argument that
  // makes them trustworthy), but only highlights `highlightTiles` (the
  // specific tile(s) the CURRENT deduction actually turns on). Highlighting
  // every tile in a covering got noisy fast once a hint could combine
  // several coverings at once (rule 3's row-pair + column-pair case) and
  // didn't even help for rule 1/2, where the other K-1 sibling tiles aren't
  // individually part of the argument for THIS specific cell -- only the
  // one relevant tile is. Cells already getting a `marks` color are
  // dropped from highlights so a cell never gets two conflicting classes.
  p._tileOutlinesAndHighlights = function (outlineTiles, highlightTiles, excludeFromHighlights) {
    const exclude = new Set(excludeFromHighlights);
    const slotByTilingId = this._colorSlotsForTiles(outlineTiles);
    return {
      tileOutlines: outlineTiles.map(t => ({
        topLeftIdx: t.topLeftIdx,
        color: TILE_OUTLINE_COLORS[slotByTilingId.get(t.tilingId)]
      })),
      highlights: highlightTiles.flatMap(t =>
        t.cells.filter(c => !exclude.has(c))
          .map(idx => ({ idx, color: HINT_SOURCE_VARIANTS[slotByTilingId.get(t.tilingId)] }))
      )
    };
  };

  // "row pair" / "column pair" -- spelled out per-hint (rule 1/2 always
  // know the single tiling's axis) instead of the ambiguous "row/column
  // pair", per user feedback that the slash reads as "which one do you
  // mean?" rather than "one of these two".
  p._axisPairLabel = function (axis) {
    return axis === 'row' ? 'row pair' : 'column pair';
  };

  // Rule 1 (2★+, Medium): a confirmed tile with only 1 empty cell means
  // that cell IS the star. Shows the tile's whole originating tiling (not
  // just the one tile), so the player can see the covering argument that
  // makes it trustworthy -- see _confirmedTilesImpl's comment.
  p.hintTileSingleEmpty = function () {
    const seen = new Map(); // markIdx -> hint, deduped (a tile can be confirmed by >1 tiling)
    for (const tiling of this._confirmedTiles()) {
      for (const tile of tiling.tiles) {
        if (tile.cells.length !== 1) continue;
        const markIdx = tile.cells[0];
        if (seen.has(markIdx)) continue;
        const K = tiling.tiles.length;
        const { tileOutlines, highlights } = this._tileOutlinesAndHighlights(tiling.tiles, [tile], [markIdx]);
        seen.set(markIdx, {
          description: `This ${this._axisPairLabel(tiling.axis)} needs ${K} star${K === 1 ? '' : 's'}, split into these ${K} tiles -- one each. This tile's last empty cell must be the star.`,
          highlights,
          marks: [{ idx: markIdx, color: HINT_COLOR.TARGET_STAR }],
          tileOutlines,
          boardIdx: undefined
        });
      }
    }
    const hints = [...seen.values()];
    if (hints.length === 0) return null;
    hints.sort((a, b) => a.marks[0].idx - b.marks[0].idx);
    return hints;
  };

  // Rule 2 (2★+, Hard): a confirmed tile with exactly 2 empty cells
  // (always mutually touching, since every pair of cells in a 2x2 box
  // touches) holds exactly 1 star, at one of those two cells -- whichever
  // it turns out to be. Any OTHER cell touching BOTH of them would touch
  // that star no matter which of the two it ends up being, so it must be
  // a dot. Shows the tile's whole originating tiling, same as rule 1.
  p.hintTileTwoEmptyDot = function () {
    const seen = new Map(); // key: targets|tile cells -> hint, deduped
    for (const tiling of this._confirmedTiles()) {
      for (const tile of tiling.tiles) {
        if (tile.cells.length !== 2) continue;
        const [a, b] = tile.cells;
        const targets = this.getNeighbors(a).filter(i =>
          this._cellsAdjacent(b, i) && !tile.cells.includes(i) && this.vState(i) === CELL.NONE
        );
        if (targets.length === 0) continue;
        const key = this._groupKey(targets) + '|' + this._groupKey(tile.cells);
        if (seen.has(key)) continue;
        const K = tiling.tiles.length;
        const { tileOutlines, highlights } = this._tileOutlinesAndHighlights(tiling.tiles, [tile], targets);
        seen.set(key, {
          description: `This ${this._axisPairLabel(tiling.axis)} needs ${K} star${K === 1 ? '' : 's'}, split into these ${K} tiles -- one each. Both of this tile's empty cells touch the marked cell(s), so they must be dots.`,
          highlights,
          marks: targets.map(idx => ({ idx, color: HINT_COLOR.TARGET })),
          tileOutlines,
          boardIdx: undefined
        });
      }
    }
    const hints = [...seen.values()];
    if (hints.length === 0) return null;
    hints.sort((a, b) => a.marks[0].idx - b.marks[0].idx);
    return hints;
  };

  // Backtracking search for k mutually disjoint tiles among `tiles` (each
  // { cells, topLeftIdx }). Returns the combo (array of k tiles) if found,
  // else null.
  p._findDisjointTileCombo = function (tiles, k) {
    const backtrack = (start, chosen, used) => {
      if (chosen.length === k) return chosen;
      for (let idx = start; idx < tiles.length; idx++) {
        const t = tiles[idx];
        if (t.cells.some(c => used.has(c))) continue;
        const result = backtrack(idx + 1, [...chosen, t], new Set([...used, ...t.cells]));
        if (result) return result;
      }
      return null;
    };
    return backtrack(0, [], new Set());
  };

  // Shared by hintTileQuotaFillSingle (Hard, K=1) and
  // hintTileDisjointQuotaFill (Expert, K>1): for a row/column/region (any
  // board) needing K more stars, if K mutually disjoint confirmed tiles are
  // all subsets of its remaining empties, those tiles collectively account
  // for all K stars -- so every other empty cell in the unit must be a dot.
  // Split into two tiers by K: spotting a single tile that already covers a
  // unit's whole remaining need (K=1) is a much smaller ask than combining
  // several disjoint tiles at once (K>1).
  p._tileQuotaFillCandidates = function (wantSingle) {
    const allTiles = this._allConfirmedTilesFlat();
    const candidates = [];
    for (const unit of this.units) {
      const stars = unit.indices.filter(i => this.vState(i) === CELL.STAR).length;
      const k = this.starsPerGroup - stars;
      if (k <= 0) continue;
      if (wantSingle ? k !== 1 : k <= 1) continue;
      const avail = new Set(unit.indices.filter(i => this.vState(i) === CELL.NONE));
      if (avail.size <= k) continue;

      const relevant = allTiles.filter(t => t.cells.every(c => avail.has(c)));
      if (relevant.length < k) continue;

      const combo = this._findDisjointTileCombo(relevant, k);
      if (!combo) continue;

      const covered = new Set(combo.flatMap(t => t.cells));
      const targets = [...avail].filter(i => !covered.has(i));
      if (targets.length === 0) continue;

      candidates.push({ unit, combo, targets });
    }
    return candidates;
  };

  // Builds hint objects for a list of { unit, combo, targets } candidates
  // (see _tileQuotaFillCandidates), showing each combo tile's full
  // originating tiling for context -- same pattern as hintTileSingleEmpty/
  // hintTileTwoEmptyDot.
  p._formatTileQuotaFillHints = function (candidates) {
    if (candidates.length === 0) return null;
    // Map tilingId -> that tiling's full tile list, so the hint can show
    // each combo tile's WHOLE originating row-pair/col-pair covering (not
    // just the one tile that happened to be picked for the combo) -- same
    // "show the full argument" idea as rules 1/2, applied per combo tile
    // instead of to a single tiling.
    const tilesByTilingId = new Map();
    for (const { tiles } of this._confirmedTiles()) {
      for (const t of tiles) {
        if (!tilesByTilingId.has(t.tilingId)) tilesByTilingId.set(t.tilingId, tiles);
      }
    }
    const sorted = [...candidates].sort((a, b) => (a.targets[0] ?? 0) - (b.targets[0] ?? 0));

    return sorted.map(({ unit, combo, targets }) => {
      // combo tiles can come from different row-pair/col-pair coverings --
      // expand each one out to its full sibling tile set (see
      // tilesByTilingId above) so the player can see why every combo tile
      // is trustworthy. Only the combo tiles themselves get highlighted,
      // though (via _tileOutlinesAndHighlights' highlightTiles param) --
      // they're the ones actually inside THIS region/unit and doing the
      // work for THIS deduction; a sibling tile from the same covering can
      // easily sit elsewhere on the board, and highlighting it too just
      // buries which cells the "still needs" argument is actually about.
      const tilingIds = [...new Set(combo.map(t => t.tilingId))];
      const displayTiles = tilingIds.flatMap(id => tilesByTilingId.get(id));
      const { tileOutlines, highlights } = this._tileOutlinesAndHighlights(displayTiles, combo, targets);

      const tileWord = combo.length === 1 ? 'tile' : 'tiles';
      const holdWord = combo.length === 1 ? 'holds' : 'each hold';
      const possessive = combo.length === 1 ? 'its' : 'their';
      const coveringWord = combo.length === 1 ? 'covering is' : 'coverings are';
      return {
        description: `The ${combo.length} highlighted ${tileWord} ${holdWord} exactly one star (${possessive} full row- or column-pair ${coveringWord} outlined too), accounting for all ${combo.length} star${combo.length === 1 ? '' : 's'} this ${this._unitKind(unit)} needs -- so every other empty cell here is a dot.`,
        highlights,
        marks: targets.map(idx => ({ idx, color: HINT_COLOR.TARGET })),
        tileOutlines,
        boardIdx: unit.boardIdx
      };
    });
  };

  // Rule 3a (2★+, Hard): the K=1 special case of tile-quota-fill -- a
  // single confirmed tile already accounts for a unit's entire remaining
  // need (it's down to its last star), so every other empty cell in the
  // unit must be a dot.
  p.hintTileQuotaFillSingle = function () {
    return this._formatTileQuotaFillHints(this._tileQuotaFillCandidates(true));
  };

  // Rule 3b (2★+, Expert): the general K>1 case -- K mutually disjoint
  // confirmed tiles together account for all K stars a unit still needs.
  p.hintTileDisjointQuotaFill = function () {
    return this._formatTileQuotaFillHints(this._tileQuotaFillCandidates(false));
  };

  // -- Lookahead-dots (2★+, restored from pre-experiment) ---------------------
  //
  // The multi-star analogue of the 1★ lookahead rules in
  // solver-rules-single.js. The key difference: placing a single
  // speculative star in a 2★+ puzzle does NOT, by itself, fill an entire
  // row/column/region -- it only completes a unit that already held
  // (starsPerGroup - 1) stars. So "the dots implied by that star" means
  // adjacency dots (always), plus unit-solved dots for any unit the
  // placement happens to complete. Python port: rules_multi_star.py's
  // _rule_lookahead_dots_impl.
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

  // --- Rule list for starsPerGroup >= 2 ---
  //
  // Used identically for 2★, 3★, and 4★+ puzzles.
  //
  // multi-star-rules-experiment branch: deliberately stripped down to
  // re-derive the tier structure from first principles, then selectively
  // restored by explicit request as testing progressed -- see
  // rules_multi_star.py's module docstring (the Python mirror of this file)
  // for the fuller history of what was removed/restored and why.
  // lookaheadLoop1/2/3/8 (see the comment above those entries below) are
  // commented out for performance; fromSolution is the only Grandmaster
  // entry still active, so it's always the final fallback past Expert.
  // `git show gh-pages:solver-rules-multi.js` has the pre-experiment
  // version if this doesn't pan out.
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
      // Moved here from Medium (multi-star-rules-experiment).
      { key: 'unitRegionSyncMulti1',           fn: () => this.hintUnitRegionSyncMulti(1) },
      // Medium
      { key: 'unitPlacementForcedIntermediateAll', fn: () => this.hintUnitPlacementForced('intermediate', 'all_stars') },
      { key: 'unitRegionSyncMulti2',           fn: () => this.hintUnitRegionSyncMulti(2) },
      // Reused directly from applySingleStarRules -- copying a known
      // star/dot to its symmetric counterpart doesn't depend on
      // starsPerGroup, so no multi-star variant is needed.
      { key: 'symmetryFillMulti',              fn: () => this.hintSymmetryFill() },
      // Tiles rule 1 (see the "Tiles" section comment above hintTileSingleEmpty).
      { key: 'tileSingleEmpty',                fn: () => this.hintTileSingleEmpty() },
      // Region/line quota fill (see the section comment above
      // hintRegionLineQuotaFill). weak/intermediate/strong track one tier
      // above the matching unitPlacementForced level, since this rule needs
      // a placement-forced fact PLUS a cross-region quota argument on top.
      { key: 'regionLineQuotaFillWeak',        fn: () => this.hintRegionLineQuotaFill('weak') },
      // Hard
      { key: 'unitPlacementForcedIntermediateAny',  fn: () => this.hintUnitPlacementForced('intermediate', 'any_star') },
      { key: 'unitPlacementForcedIntermediateDots', fn: () => this.hintUnitPlacementForced('intermediate', 'dots') },
      { key: 'unitRegionSyncMulti3',           fn: () => this.hintUnitRegionSyncMulti(3) },
      // Tiles rule 2.
      { key: 'tileTwoEmptyDot',                fn: () => this.hintTileTwoEmptyDot() },
      // Tile-quota-fill's K=1 special case: a single confirmed tile already
      // covers a unit's whole remaining need. See tileDisjointQuotaFill
      // (Expert) for K>1.
      { key: 'tileQuotaFillSingle',            fn: () => this.hintTileQuotaFillSingle() },
      { key: 'regionLineQuotaFillIntermediate', fn: () => this.hintRegionLineQuotaFill('intermediate') },
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
      // Restored from pre-experiment (see the section comment above
      // hintUnitCompletionSatisfiesOtherUnit).
      { key: 'unitCompletionSatisfiesOtherUnitIntermediate', fn: () => this.hintUnitCompletionSatisfiesOtherUnit('intermediate') },
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
      // Tiles rule 3.
      { key: 'tileDisjointQuotaFill',          fn: () => this.hintTileDisjointQuotaFill() },
      { key: 'regionLineQuotaFillStrong',      fn: () => this.hintRegionLineQuotaFill('strong') },
      // Restored from pre-experiment.
      { key: 'unitCompletionSatisfiesOtherUnitStrong', fn: () => this.hintUnitCompletionSatisfiesOtherUnit('strong') },
      { key: 'disjointUnitRegionSyncMulti2',   fn: () => this.hintDisjointUnitRegionSyncMulti(2) },
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
      // Grandmaster (see this function's leading comment)
      // lookaheadLoop1/2/3/8 all commented out for performance: hintLookahead
      // does a full board-wide speculative sweep per empty cell per stage,
      // and that's gotten noticeably slow at 3★+ scale -- even 1 stage.
      // Measured on a stuck 13x13/3★ puzzle: lookaheadLoop8 alone took ~14s,
      // and combined with lookaheadDotsSingleBoard/lookaheadDots/lookaheadLoop1
      // (each also a full sweep) added up to ~20s total. lookaheadDots(SingleBoard)
      // above -- a cheaper ONE-round version -- stays active. Matches
      // rule_lookahead_1/2/3_stage_multi being commented out in
      // rules_multi_star.py. 1★'s lookahead1/2/3/8 (solver-rules-single.js)
      // are untouched. Leave commented rather than deleting in case this
      // gets revisited.
      // { key: 'lookaheadLoop1',                 fn: () => this.hintLookahead(1) },
      // { key: 'lookaheadLoop2',                 fn: () => this.hintLookahead(2) },
      // { key: 'lookaheadLoop3',                 fn: () => this.hintLookahead(3) },
      // { key: 'lookaheadLoop8',                 fn: () => this.hintLookahead(8) },
      { key: 'fromSolution',                  fn: () => this.hintFromSolution() },
    ];
  };
}
