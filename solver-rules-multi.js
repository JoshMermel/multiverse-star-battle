import { CELL, HINT_COLOR, HINT_SOURCE_VARIANTS, TILE_OUTLINE_COLORS } from './constants.js';

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
      // Just states the solution's symmetry, whether internal or cross-board
      // -- same as the 1★ hintSymmetryDeduction.
      const description = `The solution has 180° rotational symmetry. A cell that "sees" its own rotation (shares a row/column, or a region with no room for both) can't be a star.`;
      trySeesOwnMirror(i => (n * n - 1) - i, description);
    }

    if (this.isMainDiagonalSymmetric) {
      const description = `The solution is symmetric across the main diagonal (↘). A cell that "sees" its own reflection (shares a row/column, or a region with no room for both) can't be a star.`;
      trySeesOwnMirror(i => (i % n) * n + Math.floor(i / n), description);
    }

    if (this.isAntiDiagonalSymmetric) {
      const description = `The solution is symmetric across the anti-diagonal (↙). A cell that "sees" its own reflection (shares a row/column, or a region with no room for both) can't be a star.`;
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
    const tryDiagParity = (diagIndices, dirLabel) => {
      const parity = totalStars % 2 === 0 ? 'even' : 'odd';
      const reason = `The solution is symmetric across the ${dirLabel} diagonal`;

      const diagStars = diagIndices.filter(i => this.vState(i) === CELL.STAR).length;
      const diagEmpties = diagIndices.filter(i => this.vState(i) === CELL.NONE);

      if (diagEmpties.length === 1) {
        const needStar = (diagStars % 2) !== (totalStars % 2);
        const idx = diagEmpties[0];
        const color = needStar ? HINT_COLOR.TARGET_STAR : HINT_COLOR.TARGET;
        results.push({
          description: `${reason}, so by parity the diagonal needs an ${parity} number of stars — this cell is a ${needStar ? 'star' : 'dot'}.`,
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
          description: `${reason}, so by parity the diagonal needs an ${parity} number of stars — the rest of the diagonal is dots.`,
          highlights: diagIndices.filter(i => this.vState(i) === CELL.STAR)
            .map(i => ({ idx: i, color: HINT_COLOR.SOURCE })),
          marks: diagEmpties.map(i => ({ idx: i, color: HINT_COLOR.TARGET })),
          boardIdx: undefined
        });
      }
    };

    if (this.isMainDiagonalSymmetric) {
      tryDiagParity(Array.from({ length: n }, (_, k) => k * n + k), '↘');
    }
    if (this.isAntiDiagonalSymmetric) {
      tryDiagParity(Array.from({ length: n }, (_, k) => k * n + (n - 1 - k)), '↙');
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
          description: forcedStars.length === 1
            ? `Every way to place this ${unitType}'s ${starsWord}${caveat} includes the marked cell.`
            : `Every way to place this ${unitType}'s ${starsWord}${caveat} includes the marked cells.`,
          highlights: [],
          marks: forcedStars.map(idx => ({ idx, color: HINT_COLOR.TARGET_STAR })),
          boardIdx: unit.boardIdx,
          // Outline the unit's own full shape/boundary -- coexists fine
          // with the forcedStars marks above, which are a separate visual
          // layer (a cell mark, not a highlight fill).
          regionOutlines: this._outlineEntriesFor(unit, 'blue'),
          observation: this._unitObservation(unit),
        });
      }
      // One combined hint for every forced dot this unit produces, inside or
      // outside its own cells -- a player doesn't need to know WHICH of the
      // two mechanisms applies to which marked cell, just that a star can't
      // go there.
      if (forcedDots.length > 0) {
        hints.push({
          description: forcedDots.length === 1
            ? `Every way to place this ${unitType}'s ${starsWord}${caveat} rules out a star at the marked cell.`
            : `Every way to place this ${unitType}'s ${starsWord}${caveat} rules out a star at the marked cells.`,
          highlights: [],
          marks: forcedDots.map(idx => ({ idx, color: HINT_COLOR.TARGET })),
          boardIdx: unit.boardIdx,
          // Same reasoning as the forced-star branch above -- forcedDots
          // can additionally include cells OUTSIDE the unit (the
          // "touching" case), which the outline naturally excludes since
          // it's only ever built from unit.indices.
          regionOutlines: this._outlineEntriesFor(unit, 'blue'),
          observation: this._unitObservation(unit),
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
  //
  // At 'weak' (Medium), this whole family -- quota fill, partition forced,
  // and partition trap below -- is restricted to lines that need EXACTLY
  // one more star. Summing several regions' guarantees to hit a line's
  // quota is a genuinely harder skill than reading off one region's own
  // guarantee, so that combinatorial step (needed >= 2) is reserved for
  // 'intermediate'/'strong' (Hard/Expert), where it's the whole point.

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
      // At 'weak' (Medium), only bite off the easy case: the line needs
      // exactly one more star, so there's nothing to sum -- a single
      // region's own guarantee already settles it. Multi-region subset-sum
      // matches (needed >= 2) stay reserved for intermediate/strong
      // (Hard/Expert), where combining several regions' guarantees is the
      // whole point.
      if (level === 'weak' && needed !== 1) continue;
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

        // Point at the line by its outline color, not a row number/column
        // letter -- axis labels are an optional setting (see renderer.js's
        // renderBoard), so "Row 5"/"Column C" would be meaningless to a
        // player with them off. The amber outline is drawn either way, so
        // it's the one identifier every player actually has. Matches
        // --line-highlight-amber (reused by .region-outline-amber) -- keep
        // this word in sync if that color ever changes.
        const lineWord = kind === 'row' ? 'row' : 'column';
        const regionWord = combo.length === 1 ? 'region' : 'regions';
        const resolveWord = combo.length === 1 ? 'it resolves' : 'they resolve';

        candidates.push({
          boardIdx,
          description: `The amber-outlined ${lineWord} needs ${needed} more star${needed === 1 ? '' : 's'}. The blue-outlined ${regionWord} always put${combo.length === 1 ? 's' : ''} at least ${needed} there, no matter how ${resolveWord} -- so every other empty cell in the outlined ${lineWord} is a dot.`,
          highlights: [],
          marks: targets.map(idx => ({ idx, color: HINT_COLOR.TARGET })),
          // Outline the matched regions (blue) instead of filling their
          // cells -- all on this same boardIdx by construction ("Never
          // cross-board" above) -- plus the line itself (amber), replacing
          // the older rectangular lineHighlight band with the same outline
          // mechanism. Always single-board like the old lineHighlight, not
          // _outlineEntriesFor's every-board default.
          regionOutlines: [
            { indices: combo.flatMap(({ unit }) => unit.indices), color: 'blue', boardIdx },
            { indices: lineIndices, color: 'amber', boardIdx, inset: true },
          ],
        });
      }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.marks[0].idx - b.marks[0].idx);
    return candidates;
  };

  // -- Region/line partition trap (2★+) --------------------------------------------
  //
  // A sibling of hintRegionLineQuotaFill above, built on the same per-region,
  // per-line completion tally. That rule splits a region's remaining cells
  // into "in this row/column" and "everywhere else", and asks how many
  // stars are guaranteed on the IN side (to fill the line's own quota).
  // This rule asks the same split's question about EITHER side on its
  // own: whenever a region's cells on one side of that split (in the line,
  // or outside it -- both are checked) are proven to hold at least m >= 1
  // of the region's stars, no matter which valid completion turns out to
  // be real, any candidate cell (anywhere on the board) that's adjacent to
  // EVERY cell on that side can't be a star: whichever of them ends up
  // holding the guarantee, that candidate would be touching it. m doesn't
  // need to equal the number of cells on that side for this to be useful
  // -- e.g. 3 cells guaranteed to jointly hold only 1 star still traps any
  // cell touching all 3, even without knowing which one it'll be.
  //
  // Concretely, per region/line pair, from the same per-combo tally:
  //  - IN-line guarantee: minInLine = MIN over combos of (cells in the
  //    line) -- the same k _regionLineGuaranteesImpl computes.
  //  - OUT-of-line guarantee: needed - maxInLine, where maxInLine = MAX
  //    over combos of (cells in the line) -- the complement, since a
  //    completion placing `count` in the line places (needed - count)
  //    outside it, so the guaranteed-outside minimum is needed minus the
  //    guaranteed-inside MAXIMUM.
  // Both are independent, valid "at least m stars among this fixed cell
  // set" facts, so both get the same touches-all-of-them-is-a-dot check.

  // Every region/line/side triple, on any board, where the region is
  // PROVEN to place at least `guarantee` >= 1 of its remaining stars among
  // a fixed set of its own cells (`groupCells`) -- either every cell it
  // has in that row/column ('inside'), or every cell it has outside it
  // ('outside'). Returns an array of
  // { boardIdx, lineKind, lineIdx, side, groupCells, guarantee }.
  p._regionLinePartitionGuarantees = function (level) {
    return this._cachedOnState(`regionLinePartitionGuarantees_${level}`, () => this._regionLinePartitionGuaranteesImpl(level));
  };

  p._regionLinePartitionGuaranteesImpl = function (level) {
    const result = [];
    for (const unit of this.units) {
      if (unit.boardIdx === undefined) continue; // rows/columns aren't a source here, only regions

      const completionSets = this._unitCompletionsByLevel(unit, level)
        .filter(combos => combos !== null && combos.length > 0);
      if (completionSets.length === 0) continue;
      // Regions always resolve to exactly one scope (see _unitCompletionsByLevel).
      const combos = completionSets[0];
      const needed = combos[0].length;

      const rowsTouched = new Set(), colsTouched = new Set();
      for (const combo of combos) {
        for (const cell of combo) {
          rowsTouched.add(Math.floor(cell / this.n));
          colsTouched.add(cell % this.n);
        }
      }

      const avail = unit.indices.filter(i => this.vState(i) === CELL.NONE);

      const tryLine = (lineKind, lineIdx, inLine) => {
        // Same 'weak' (Medium) restriction as hintRegionLineQuotaFill/
        // hintRegionLinePartitionForced -- see hintRegionLineQuotaFill's
        // comment. This rule doesn't do its own subset-sum match, but it's
        // still keyed to a row/column, so it gets the same easy-case-only
        // gate: only reason about lines that need exactly one more star.
        if (level === 'weak') {
          const lineIndices = lineKind === 'row' ? this.axisIndices.Row[lineIdx] : this.axisIndices.Column[lineIdx];
          const lineStars = lineIndices.filter(i => this.vState(i) === CELL.STAR).length;
          if (this.starsPerGroup - lineStars !== 1) return;
        }
        const countsInLine = combos.map(combo => combo.filter(inLine).length);
        const minInLine = Math.min(...countsInLine);
        const maxInLine = Math.max(...countsInLine);

        if (minInLine >= 1) {
          const insideCells = avail.filter(inLine);
          if (insideCells.length > 0) {
            result.push({ boardIdx: unit.boardIdx, lineKind, lineIdx, side: 'inside', groupCells: insideCells, guarantee: minInLine });
          }
        }

        const g = needed - maxInLine;
        if (g >= 1) {
          const outsideCells = avail.filter(i => !inLine(i));
          // Should be impossible (g >= 1 means every completion leaves at
          // least one of its own cells outside the line) but guard anyway.
          if (outsideCells.length > 0) {
            result.push({ boardIdx: unit.boardIdx, lineKind, lineIdx, side: 'outside', groupCells: outsideCells, guarantee: g });
          }
        }
      };

      for (const r of rowsTouched) tryLine('row', r, cell => Math.floor(cell / this.n) === r);
      for (const c of colsTouched) tryLine('col', c, cell => cell % this.n === c);
    }
    return result;
  };

  p.hintRegionLinePartitionTrapped = function (level) {
    const partitions = this._regionLinePartitionGuarantees(level);
    const candidates = [];

    for (const { boardIdx, lineKind, lineIdx, side, groupCells, guarantee } of partitions) {
      const groupSet = new Set(groupCells);

      for (let i = 0; i < this.n * this.n; i++) {
        if (this.vState(i) !== CELL.NONE) continue;
        if (groupSet.has(i)) continue;
        if (!groupCells.every(cell => this._cellsAdjacent(i, cell))) continue;
        candidates.push({ boardIdx, lineKind, lineIdx, side, groupCells, guarantee, target: i });
      }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.target - b.target);

    return candidates.map(({ boardIdx, lineKind, lineIdx, side, groupCells, guarantee, target }) => {
      const lineWord = lineKind === 'row' ? 'row' : 'column';
      const cellWord = groupCells.length === 1 ? 'cell' : 'cells';
      const sideWord = side === 'inside' ? 'inside' : 'outside';
      const lineIndices = lineKind === 'row' ? this.axisIndices.Row[lineIdx] : this.axisIndices.Column[lineIdx];

      return {
        boardIdx,
        description: `At least ${guarantee} star${guarantee === 1 ? '' : 's'} from the blue-outlined cells falls ${sideWord} the amber-outlined ${lineWord}, among the marked ${cellWord} -- and the circled cell touches every one of them, so it can't be a star.`,
        highlights: [],
        marks: [{ idx: target, color: HINT_COLOR.TARGET }],
        // Outline this region-slice (the part of one region on one side of
        // the line split) instead of filling its cells -- not a full
        // region shape, but still a real geometric fact -- plus the line
        // itself (amber), replacing the older rectangular lineHighlight
        // band with the same outline mechanism. Always single-board like
        // the old lineHighlight, not _outlineEntriesFor's every-board
        // default.
        regionOutlines: [
          { indices: groupCells, color: 'blue', boardIdx },
          { indices: lineIndices, color: 'amber', boardIdx, inset: true },
        ],
      };
    });
  };

  // -- Region/line partition forced star (2★+) -------------------------------------
  //
  // A second sibling reasoning off the same per-region guarantees
  // hintRegionLineQuotaFill computes (_regionLineGuarantees /
  // _findSubsetSumCombo), but drawing a different conclusion from the same
  // successful subset-sum match: hintRegionLineQuotaFill uses it to dot
  // every OTHER cell in the line, since the matched regions' guarantees
  // already account for the line's whole remaining need. This rule notices
  // something else that same match implies: since the matched regions' k's
  // already sum EXACTLY to the line's need, none of them can contribute
  // MORE than its own guaranteed k -- that would overshoot the line's
  // actual quota, which is impossible. So each matched region's in-line
  // count is pinned to EXACTLY k, not just "at least k". That pins its
  // remainder too (its own total need minus k), on BOTH sides of the split
  // -- letting each side be reasoned about as its own small local placement
  // problem: how many ways are there to fit exactly that many non-touching
  // stars among just those cells? If every local arrangement agrees on
  // some cell, that cell must be a star. E.g. a "rest" shaped like a
  // P-pentomino needing 2 non-touching stars might only have a couple of
  // valid 2-cell arrangements, all of which happen to include one specific
  // cell.
  //
  // Why ignoring the rest of the board (no capacity checks, no reasoning
  // about which cells the OTHER side's completion touches) is still sound:
  // the true realized arrangement on a side must itself be one of the
  // valid LOCAL ones (adjacency is the only thing that can ever disqualify
  // it), so it's necessarily a MEMBER of the set _forcedCellsInGroup
  // enumerates -- a cell common to that whole (possibly larger, since it
  // ignores extra constraints the true arrangement also happens to
  // satisfy) set is common to the true arrangement too. Same principle as
  // 'weak' mode in _enumerateUnitCompletions.

  // Every cell in `cells` that appears in EVERY valid way to choose `k`
  // mutually non-touching cells from `cells` alone (also not touching any
  // of `existingStars`). Returns [] if there's no valid arrangement, or if
  // the valid arrangements don't all agree on any cell.
  p._forcedCellsInGroup = function (cells, k, existingStars) {
    const candidates = cells.filter(c => !existingStars.some(s => this._cellsAdjacent(s, c)));
    if (k <= 0 || candidates.length < k) return [];

    let intersection = null;
    const chosen = [];
    const tryFrom = (start) => {
      if (intersection && intersection.size === 0) return; // nothing left to narrow
      if (chosen.length === k) {
        if (intersection === null) {
          intersection = new Set(chosen);
        } else {
          for (const c of intersection) {
            if (!chosen.includes(c)) intersection.delete(c);
          }
        }
        return;
      }
      if (candidates.length - start < k - chosen.length) return;
      for (let i = start; i < candidates.length; i++) {
        const cell = candidates[i];
        if (chosen.some(c => this._cellsAdjacent(c, cell))) continue;
        chosen.push(cell);
        tryFrom(i + 1);
        chosen.pop();
        if (intersection && intersection.size === 0) return;
      }
    };
    tryFrom(0);
    return intersection ? [...intersection] : [];
  };

  // Outline colors for a region-line combo (hintRegionLinePartitionForced /
  // hintCrossBoardRegionLinePartitionForced): a single-region combo always
  // gets plain 'blue', matching every other region-outline hint. Once a
  // line's exact split depends on >1 region's guarantee summing together
  // (see the section comment above hintRegionLinePartitionForced), each
  // region gets its own color from the rest of the outline palette --
  // otherwise the "other" region(s) that make the exact-count claim true
  // would be invisible, which was the original bug report for this whole
  // rule family.
  const COMBO_OUTLINE_COLORS = ['blue', 'brown', 'cyan', 'pink'];
  p._comboOutlineColors = function (comboUnits) {
    return comboUnits.map((_, i) => COMBO_OUTLINE_COLORS[i % COMBO_OUTLINE_COLORS.length]);
  };

  // "blue-outlined region" / "blue- and brown-outlined regions" /
  // "blue-, brown-, and cyan-outlined regions" -- names every region in a
  // combo by its assigned outline color, for the multi-region phrasing
  // below.
  p._colorsPhrase = function (colors) {
    const noun = colors.length === 1 ? 'region' : 'regions';
    if (colors.length === 1) return `${colors[0]}-outlined ${noun}`;
    const allButLast = colors.slice(0, -1).map(c => `${c}-`).join(', ');
    const sep = colors.length === 2 ? ' and ' : ', and ';
    return `${allButLast}${sep}${colors[colors.length - 1]}-outlined ${noun}`;
  };

  // Cross-board variant of the above: names each region by color AND the
  // board it's on (matches the existing "the blue region (Board 1)"
  // convention from hintRegionAlgebra), since for a cross-board combo which
  // board a region lives on is itself part of the point.
  p._colorsPhraseWithBoards = function (comboUnits, colors) {
    const parts = comboUnits.map((u, i) => `${colors[i]}-outlined region (${this._describeBoards([u.boardIdx])})`);
    if (parts.length === 1) return parts[0];
    if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
    return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
  };

  // Every region/line/side triple, on any board, where a successful
  // regionLineQuotaFill-style subset-sum match pins the region's split to
  // an exact count and some specific cell is forced across every local
  // arrangement of that side's share. Returns an array of
  // { boardIdx, lineKind, lineIdx, side, groupCells, forcedCells }.
  p._regionLinePartitionForcedFacts = function (level) {
    return this._cachedOnState(`regionLinePartitionForcedFacts_${level}`, () => this._regionLinePartitionForcedFactsImpl(level));
  };

  p._regionLinePartitionForcedFactsImpl = function (level) {
    const guarantees = this._regionLineGuarantees(level);
    const result = [];

    for (const [key, entries] of guarantees) {
      const [kind, idxStr] = key.split(':');
      const lineIdx = Number(idxStr);
      const lineIndices = kind === 'row' ? this.axisIndices.Row[lineIdx] : this.axisIndices.Column[lineIdx];
      const inLine = kind === 'row'
        ? (cell => Math.floor(cell / this.n) === lineIdx)
        : (cell => cell % this.n === lineIdx);

      const stars = lineIndices.filter(i => this.vState(i) === CELL.STAR).length;
      const needed = this.starsPerGroup - stars;
      if (needed <= 0) continue;
      // Same 'weak' restriction as hintRegionLineQuotaFill -- see its
      // comment. A single region's own guarantee is all Medium should need.
      if (level === 'weak' && needed !== 1) continue;
      const avail = lineIndices.filter(i => this.vState(i) === CELL.NONE);
      if (avail.length === 0) continue;

      // Same board grouping as hintRegionLineQuotaFill -- never cross-board.
      const byBoard = new Map();
      for (const entry of entries) {
        if (!byBoard.has(entry.boardIdx)) byBoard.set(entry.boardIdx, []);
        byBoard.get(entry.boardIdx).push(entry);
      }

      for (const [boardIdx, boardEntries] of byBoard) {
        const combo = this._findSubsetSumCombo(boardEntries, needed);
        if (!combo) continue;
        // The full matched combo, carried on every fact pushed below (even
        // ones about just one region's own share) -- the "exactly k, not
        // just at least k" claim for ANY of these regions is only true
        // because the OTHER regions in this same combo cover the rest of
        // the line's need, so the hint needs to show all of them, not just
        // the one holding the marked cell.
        const comboUnits = combo.map(e => e.unit);

        // Every region in this matched combo is now pinned to EXACTLY its
        // own guaranteed k in this line (see the section comment above).
        for (const { unit, k } of combo) {
          const regionStars = unit.indices.filter(i => this.vState(i) === CELL.STAR).length;
          const regionNeeded = this.starsPerGroup - regionStars;
          const outsideCount = regionNeeded - k;

          const insideCells = unit.indices.filter(i => this.vState(i) === CELL.NONE && inLine(i));
          const outsideCells = unit.indices.filter(i => this.vState(i) === CELL.NONE && !inLine(i));
          const existingStars = unit.indices.filter(i => this.vState(i) === CELL.STAR);

          if (k >= 1) {
            const forced = this._forcedCellsInGroup(insideCells, k, existingStars);
            if (forced.length > 0) {
              result.push({ boardIdx, lineKind: kind, lineIdx, lineNeeded: needed, side: 'inside', regionIndices: unit.indices, comboUnits, forcedCells: forced, lineCount: k, restCount: outsideCount });
            }
          }
          if (outsideCount >= 1) {
            const forced = this._forcedCellsInGroup(outsideCells, outsideCount, existingStars);
            if (forced.length > 0) {
              result.push({ boardIdx, lineKind: kind, lineIdx, lineNeeded: needed, side: 'outside', regionIndices: unit.indices, comboUnits, forcedCells: forced, lineCount: k, restCount: outsideCount });
            }
          }
        }
      }
    }
    return result;
  };

  p.hintRegionLinePartitionForced = function (level) {
    const facts = this._regionLinePartitionForcedFacts(level);

    // A cell can end up forced via more than one fact (row and column
    // reasoning about the same region can coincide) -- dedupe by the exact
    // forced-cell set so it's shown once.
    const seen = new Map();
    for (const fact of facts) {
      const key = this._groupKey(fact.forcedCells);
      if (!seen.has(key)) seen.set(key, fact);
    }
    const candidates = [...seen.values()];
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.forcedCells[0] - b.forcedCells[0]);

    return candidates.map(({ boardIdx, lineKind, lineIdx, lineNeeded, side, regionIndices, comboUnits, forcedCells, lineCount, restCount }) => {
      const lineWord = lineKind === 'row' ? 'row' : 'column';
      const cellWord = forcedCells.length === 1 ? 'cell' : 'cells';
      const itsAStar = forcedCells.length === 1 ? "it's a star" : "they're stars";

      // 'outside' facts also name what the line's own exact count leaves
      // for the rest of the region -- that's the count whose placements
      // are actually being reasoned about below, even though the marked
      // cells might be only SOME of them (e.g. 1 forced cell among a
      // 2-star remainder): "every one of those arrangements includes the
      // marked cell(s)" stays correct either way, unlike asserting the
      // marked cells are the star count's only home.
      const restClause = side === 'outside'
        ? `, leaving exactly ${restCount} star${restCount === 1 ? '' : 's'} for the rest of the region`
        : '';

      const lineIndices = lineKind === 'row' ? this.axisIndices.Row[lineIdx] : this.axisIndices.Column[lineIdx];

      // One outline color per region in the matched combo (see
      // _comboOutlineColors) -- a single-region combo (the common case)
      // always resolves to plain 'blue', same as before this family
      // supported >1 region. `ownColor` is specifically the color of the
      // region this fact's marked cell(s) belong to, found by reference
      // (regionIndices IS comboUnits[i].indices, see
      // _regionLinePartitionForcedFactsImpl).
      const colors = this._comboOutlineColors(comboUnits);
      const ownColor = colors[comboUnits.findIndex(u => u.indices === regionIndices)];

      // "No matter how... always" names the actual justification for the
      // region's own exact-count claim -- it comes from checking every
      // valid way the region's remaining stars could be arranged (see
      // _regionLineGuarantees/_unitCompletionsByLevel), not something
      // visible from the shapes alone. Leading with a flat assertion here
      // read as unexplained; this at least tells the player WHAT kind of
      // fact it is (an exhaustive check), matching the phrasing
      // hintRegionLineQuotaFill already uses for the same kind of claim.
      //
      // When >1 region's guarantee was needed to pin this exact count (the
      // original bug report for this whole rule: two regions both forced
      // into a line, but only one ever shown), the description says so
      // explicitly and names every region by its outline color, instead of
      // asserting the "own region" claim as if it stood alone.
      const description = comboUnits.length === 1
        ? `No matter how the ${ownColor}-outlined region places its remaining stars, exactly ${lineCount} `
          + `of them always land in the amber-outlined ${lineWord}${restClause} -- and every one of those `
          + `arrangements includes the marked ${cellWord}, so ${itsAStar}.`
        : `The amber-outlined ${lineWord} needs ${lineNeeded} more star${lineNeeded === 1 ? '' : 's'}. No matter `
          + `how the ${this._colorsPhrase(colors)} place their own remaining stars, they always account for `
          + `exactly ${lineNeeded} of them between them -- which pins the ${ownColor}-outlined region's own `
          + `share to exactly ${lineCount}${restClause}. Every way to do that includes the marked ${cellWord}, `
          + `so ${itsAStar}.`;

      return {
        boardIdx,
        description,
        highlights: [],
        marks: forcedCells.map(idx => ({ idx, color: HINT_COLOR.TARGET_STAR })),
        // Outline every region in the matched combo (not just the one
        // holding the marked cell) on its own color, plus the line itself
        // (amber). Each region's full shape is shown (not just its
        // in-line/out-of-line slice) so the player can see it genuinely
        // reaches into the amber line, at a glance -- the marked cell(s)
        // above are the actual, narrower claim. Always single-board like
        // the old lineHighlight, not _outlineEntriesFor's every-board
        // default. Deliberately NOT split or stepped-aside around the
        // overlap (tried both -- see commit history) -- the user was fine
        // with outlines overlapping; the real gaps were the text not
        // explaining the region's own guarantee, and (this rule's other
        // region(s), when >1 was involved) being invisible -- both fixed
        // above instead.
        regionOutlines: [
          ...comboUnits.map((u, i) => ({ indices: u.indices, color: colors[i], boardIdx })),
          { indices: lineIndices, color: 'amber', boardIdx, inset: true },
        ],
      };
    });
  };

  // -- Cross-board region/line quota fill + partition forced (Grandmaster, 2★+) -
  //
  // hintRegionLineQuotaFill and _regionLinePartitionForcedFactsImpl both
  // deliberately group a line's per-region guarantees BY BOARD before
  // subset-summing, and only ever search within one board's regions at a
  // time (see both functions' "Never cross-board" comments) -- the
  // same-board case is already sound and cheap, so there was no reason to
  // widen the search. This section adds the genuinely cross-board
  // generalization of that same subset-sum match: pool guarantees from
  // EVERY board for a line, and search for a combo that sums to the
  // line's need using regions from more than one board at once. E.g.
  // board 1's region A alone guarantees 1 star in the line, and board 2's
  // region K alone guarantees 1 star in the same line; individually
  // neither covers a needed=2 line, but together they do.
  //
  // This is only sound if the matched regions' remaining cells are
  // pairwise DISJOINT: boards share one physical grid, so a region on
  // board 1 and a region on board 2 can include the very same cell, and
  // summing guarantees across overlapping regions would double-count how
  // many distinct stars are actually still available -- the same concern
  // hintCrossBoardRegionPinnedMulti already handles for the
  // trapped-region-pin rule, via _areDisjoint (this is that same fix
  // applied to the subset-sum search directly, checked incrementally
  // during the backtracking search below). Also requires the winning
  // combo to span >= 2 distinct boards: an all-same-board match would
  // already have been found by the plain per-board hints above, so this
  // only exists to catch the genuinely cross-board case (mirrors
  // hintCrossBoardRegionPinnedMulti's own "boardsTouched < 2: already
  // covered elsewhere" guard).
  //
  // Only built on 'strong'-level guarantees: a region's own "at least k
  // in this line" fact is true regardless of which level computed it (a
  // weaker level just enumerates a superset of completions, so its k is
  // a safe -- if possibly looser -- lower bound), but 'strong' is the
  // level already used by the Expert-tier siblings this generalizes, and
  // cross-board combination is itself the expensive, deep reasoning step
  // that earns the Grandmaster tier -- there's no separate weak/
  // intermediate cross-board tier the way the per-region levels have.
  // Python port: rules_multi_star.py's matching section.

  // Like _findSubsetSumCombo, but `entries` are pooled from ALL boards
  // (the raw { boardIdx, k, unit } entries _regionLineGuarantees returns,
  // not grouped by board first), and a valid combo must additionally have
  // pairwise-disjoint index sets (checked incrementally via `used`) and
  // span at least 2 distinct boards (checked once a full-target combo is
  // found).
  p._findCrossBoardSubsetSumCombo = function (entries, target) {
    const backtrack = (i, remaining, chosen, used, boards) => {
      if (remaining === 0) return boards.size >= 2 ? chosen.slice() : null;
      if (i >= entries.length || remaining < 0) return null;
      const entry = entries[i];
      const unitIdxs = entry.unit.indices;
      const disjoint = unitIdxs.every(idx => !used.has(idx));
      if (entry.k <= remaining && disjoint) {
        chosen.push(entry);
        const result = backtrack(
          i + 1, remaining - entry.k, chosen,
          new Set([...used, ...unitIdxs]), new Set([...boards, entry.boardIdx]));
        if (result) return result;
        chosen.pop();
      }
      return backtrack(i + 1, remaining, chosen, used, boards);
    };
    return backtrack(0, target, [], new Set(), new Set());
  };

  // Cross-board generalization of hintRegionLineQuotaFill('strong'): once
  // a cross-board combo of regions' guarantees sums exactly to a line's
  // remaining need, every other empty cell in that line must be a dot.
  p.hintCrossBoardRegionLineQuotaFill = function () {
    const guarantees = this._regionLineGuarantees('strong');
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

      const combo = this._findCrossBoardSubsetSumCombo(entries, needed);
      if (!combo) continue;

      const covered = new Set(combo.flatMap(e => e.unit.indices));
      const targets = avail.filter(i => !covered.has(i));
      if (targets.length === 0) continue;

      const lineWord = kind === 'row' ? 'row' : 'column';
      const regionWord = combo.length === 1 ? 'region' : 'regions';
      const resolveWord = combo.length === 1 ? 'it resolves' : 'they resolve';
      const boardsNote = this._describeBoards(combo.map(e => e.boardIdx));

      candidates.push({
        boardIdx: undefined,
        description: `Cross-board (${boardsNote}): the amber-outlined ${lineWord} needs ${needed} more `
          + `star${needed === 1 ? '' : 's'}. The blue-outlined ${regionWord} on different boards always `
          + `put${combo.length === 1 ? 's' : ''} at least ${needed} there between them, no matter how `
          + `${resolveWord} -- so every other empty cell in the outlined ${lineWord} is a dot.`,
        highlights: [],
        marks: targets.map(idx => ({ idx, color: HINT_COLOR.TARGET })),
        // Outline each matched region on its own board instead of filling
        // its cells, plus the line itself (amber) on one representative
        // board -- same single board the old lineHighlight used, since
        // the line's own identity doesn't depend on which board's copy of
        // the matched regions it's shown next to.
        regionOutlines: [
          ...combo.map(({ unit }) => ({ indices: unit.indices, color: 'blue', boardIdx: unit.boardIdx })),
          { indices: lineIndices, color: 'amber', boardIdx: combo[0].unit.boardIdx, inset: true },
        ],
      });
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.marks[0].idx - b.marks[0].idx);
    return candidates;
  };

  // Cross-board generalization of hintRegionLinePartitionForced('strong'):
  // once a cross-board combo pins a region's in-line count to an exact k,
  // its remainder (own quota minus k) is pinned too, on both sides of the
  // split -- and either side's local placement problem may force a
  // specific cell to be a star.
  p.hintCrossBoardRegionLinePartitionForced = function () {
    const guarantees = this._regionLineGuarantees('strong');
    const seen = new Map();

    for (const [key, entries] of guarantees) {
      const [kind, idxStr] = key.split(':');
      const lineIdx = Number(idxStr);
      const lineIndices = kind === 'row' ? this.axisIndices.Row[lineIdx] : this.axisIndices.Column[lineIdx];
      const inLine = kind === 'row'
        ? (cell => Math.floor(cell / this.n) === lineIdx)
        : (cell => cell % this.n === lineIdx);

      const stars = lineIndices.filter(i => this.vState(i) === CELL.STAR).length;
      const needed = this.starsPerGroup - stars;
      if (needed <= 0) continue;
      const avail = lineIndices.filter(i => this.vState(i) === CELL.NONE);
      if (avail.length === 0) continue;

      const combo = this._findCrossBoardSubsetSumCombo(entries, needed);
      if (!combo) continue;
      // Always >= 2 regions by construction (_findCrossBoardSubsetSumCombo
      // requires >= 2 distinct boards), carried on every fact below so the
      // hint can show every region the exact-count claim actually depends
      // on -- see the identical comment in
      // _regionLinePartitionForcedFactsImpl.
      const comboUnits = combo.map(e => e.unit);

      for (const { unit, k } of combo) {
        const regionStars = unit.indices.filter(i => this.vState(i) === CELL.STAR).length;
        const regionNeeded = this.starsPerGroup - regionStars;
        const outsideCount = regionNeeded - k;

        const insideCells = unit.indices.filter(i => this.vState(i) === CELL.NONE && inLine(i));
        const outsideCells = unit.indices.filter(i => this.vState(i) === CELL.NONE && !inLine(i));
        const existingStars = unit.indices.filter(i => this.vState(i) === CELL.STAR);

        if (k >= 1) {
          const forced = this._forcedCellsInGroup(insideCells, k, existingStars);
          if (forced.length > 0) {
            const fkey = this._groupKey(forced);
            if (!seen.has(fkey)) {
              seen.set(fkey, { unit, comboUnits, side: 'inside', forcedCells: forced, lineKind: kind, lineIdx, lineNeeded: needed, lineCount: k, restCount: outsideCount });
            }
          }
        }
        if (outsideCount >= 1) {
          const forced = this._forcedCellsInGroup(outsideCells, outsideCount, existingStars);
          if (forced.length > 0) {
            const fkey = this._groupKey(forced);
            if (!seen.has(fkey)) {
              seen.set(fkey, { unit, comboUnits, side: 'outside', forcedCells: forced, lineKind: kind, lineIdx, lineNeeded: needed, lineCount: k, restCount: outsideCount });
            }
          }
        }
      }
    }

    const candidates = [...seen.values()];
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.forcedCells[0] - b.forcedCells[0]);

    return candidates.map(({ unit, comboUnits, side, forcedCells, lineKind, lineIdx, lineNeeded, lineCount, restCount }) => {
      const lineWord = lineKind === 'row' ? 'row' : 'column';
      const cellWord = forcedCells.length === 1 ? 'cell' : 'cells';
      const itsAStar = forcedCells.length === 1 ? "it's a star" : "they're stars";
      const restClause = side === 'outside'
        ? `, leaving exactly ${restCount} star${restCount === 1 ? '' : 's'} for the rest of the region`
        : '';
      const lineIndices = lineKind === 'row' ? this.axisIndices.Row[lineIdx] : this.axisIndices.Column[lineIdx];

      // One outline color per region in the matched combo -- see the
      // same-board sibling's identical comment in
      // hintRegionLinePartitionForced. Always >= 2 regions here (cross-board
      // by construction), so this always takes the multi-region phrasing.
      const colors = this._comboOutlineColors(comboUnits);
      const ownColor = colors[comboUnits.findIndex(u => u === unit)];

      return {
        boardIdx: unit.boardIdx,
        // See the same-board sibling's identical comment on why this leads
        // with "no matter how... always" instead of asserting the region's
        // own guarantee flat, and names every region in the combo instead
        // of just this one -- the "combined with a region on another
        // board" clause used to leave that other region (and which board
        // it's on) unstated and unoutlined entirely.
        description: `Cross-board: the amber-outlined ${lineWord} needs ${lineNeeded} more star${lineNeeded === 1 ? '' : 's'}. `
          + `No matter how the ${this._colorsPhraseWithBoards(comboUnits, colors)} place their own remaining `
          + `stars, they always account for exactly ${lineNeeded} of them between them -- which pins the `
          + `${ownColor}-outlined region's own share to exactly ${lineCount}${restClause}. Every way to do that `
          + `includes the marked ${cellWord}, so ${itsAStar}.`,
        highlights: [],
        marks: forcedCells.map(idx => ({ idx, color: HINT_COLOR.TARGET_STAR })),
        // Outline every region in the matched combo, each on its own board,
        // in its own color -- see the same-board sibling's identical
        // comment in hintRegionLinePartitionForced.
        regionOutlines: [
          ...comboUnits.map((u, i) => ({ indices: u.indices, color: colors[i], boardIdx: u.boardIdx })),
          { indices: lineIndices, color: 'amber', boardIdx: unit.boardIdx, inset: true },
        ],
      };
    });
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

    // Same wording as the 1★ _hintUnitsCoveredByRegions, plus "remaining"
    // since a region/line can already hold some of its stars here.
    const N = unitCombo.length;
    const axisWord = axis.toLowerCase();
    const regWord = touchingRegs.length === 1 ? 'region' : 'regions';
    const description = N === 1
      ? `The highlighted ${axisWord} provides all the remaining stars for the blue-outlined ${regWord}.`
      : `The ${N} highlighted ${axisWord}s provide all the remaining stars for the blue-outlined ${regWord}.`;

    return {
      boardIdx: bIdx,
      description,
      // The window's own empty cells -- each one already known (by
      // construction, see touchingLabels above) to belong to one of the
      // outlined regions below. Filled in addition to the outline since the
      // outlined regions can extend well beyond the window; this pins down
      // exactly which part of them is the row/column-relevant part.
      highlights: availInUnits.map(idx => ({ idx, color: HINT_COLOR.SOURCE })),
      marks: targets.map(idx => ({ idx, color: HINT_COLOR.TARGET })),
      // Outline the touching regions' own full shape instead of filling
      // them -- all on this same bIdx by construction. See
      // _buildRegionOutlineSvg.
      regionOutlines: [{ indices: touchingRegs.flatMap(({ region }) => region.indices), color: 'blue', boardIdx: bIdx }],
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

    // Same wording/fill as the 1★ _hintRegionsTrappedInUnits, plus
    // "remaining" since a region/line can already hold some of its stars.
    const N = windowIndices.length;
    const axisWord = axis.toLowerCase();
    const regWord = pinnedRegs.length === 1 ? 'region' : 'regions';
    const description = N === 1
      ? `All remaining stars for this ${axisWord} must come from the blue-outlined ${regWord}.`
      : `All remaining stars for these ${N} ${axisWord}s must come from the blue-outlined ${regWord}.`;

    return {
      boardIdx: bIdx,
      description,
      // The pinned regions' own empty cells -- all inside the window by
      // construction (the subset side gets its empty cells filled).
      highlights: pinnedRegs
        .flatMap(({ region }) => region.indices.filter(i => this.vState(i) === CELL.NONE))
        .map(idx => ({ idx, color: HINT_COLOR.SOURCE })),
      marks: targets.map(idx => ({ idx, color: HINT_COLOR.TARGET })),
      // Prototype: outline the pinned regions instead of filling their
      // cells -- all on this same bIdx by construction. See
      // _buildRegionOutlineSvg.
      regionOutlines: [{ indices: pinnedRegs.flatMap(({ region }) => region.indices), color: 'blue', boardIdx: bIdx }],
    };
  };

  // Find all 2★/3★-generalized sync hints for a window of N adjacent rows/cols.
  p._hintMultiWindowRegionSyncAll = function (N, axis) {
    const n = this.n;
    const axisIndices = this.axisIndices[axis];

    // Skip any window containing an already-solved unit, anywhere in it --
    // not just at the ends. A window like [A, B(solved), C] isn't a genuine
    // 3-contiguous-column relationship at all: B contributes nothing, so
    // the real deduction (if any) is actually a DISJOINT 2-column
    // relationship between A and C -- exactly what the disjoint sibling
    // rules (hintDisjointUnitRegionSyncMulti et al.) exist to catch. Keeping
    // a solved unit in the middle would attribute that deduction to the
    // wrong rule/tier (a contiguous N-window instead of a disjoint N-1
    // one), even though the arithmetic still happens to check out.
    //
    // Tradeoff (2026-10-02, user's call): the disjoint rules don't (yet)
    // reach every case this contiguous-with-a-gap path used to -- a 14x14/
    // 2★ Expert-tier corpus regression found 14 puzzles that move tier
    // under this stricter filter (8 Expert -> Grandmaster, 6 Expert ->
    // UNSOLVED by this specific rule, though still solvable overall via a
    // harder one). Accepted in favor of correct rule attribution over
    // squeezing maximum solve power out of this one rule.
    const isSolved = unitIndices =>
      unitIndices.filter(i => this.vState(i) === CELL.STAR).length >= this.starsPerGroup;

    const windows = [];
    for (let startU = 0; startU + N <= n; startU++) {
      const window = Array.from({ length: N }, (_, i) => axisIndices[startU + i]);
      if (window.some(isSolved)) continue;
      windows.push(window);
    }

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
      description: `Every way to place this ${this._unitKind(unit)} (blue)'s remaining star(s)${caveat} completely fills up this ${this._unitKind(other)} (brown) too, so the rest of that ${this._unitKind(other)} is dots.`,
      highlights: [],
      marks: targets.map(idx => ({ idx, color: HINT_COLOR.TARGET })),
      boardIdx: unit.boardIdx ?? other.boardIdx,
      // Prototype: outline both units instead of filling the source's
      // cells (the "other" unit previously had no visual treatment at
      // all). See _outlineEntriesFor/_buildRegionOutlineSvg.
      regionOutlines: [
        ...this._outlineEntriesFor(unit, 'blue'),
        ...this._outlineEntriesFor(other, 'brown'),
      ],
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

  // -- Cross-board partial overlap (2★+) --------------------------------------
  //
  // Multi-star generalization of hintPartialOverlap (solver-rules-single.js,
  // 1★ only). Two regions on different boards, each still needing its full
  // starsPerGroup quota (no star placed in either yet), that share almost
  // all their cells: shared = cells common to both regions' shapes,
  // onlyA/onlyB = each region's own leftover cells. Both regions obey the
  // same equation against the SAME shared cells -- stars(shared) +
  // stars(onlyA) = starsPerGroup = stars(shared) + stars(onlyB) -- so
  // stars(shared) cancels out and stars(onlyA) always equals stars(onlyB),
  // regardless of what starsPerGroup actually is.
  //
  // If every onlyA cell is ADJACENT to every onlyB cell, any star in onlyA
  // would touch a star in onlyB and vice versa -- so onlyA and onlyB can't
  // both hold a star simultaneously, and since their counts are forced
  // equal, the only value that works is 0 for both. Every onlyA/onlyB cell
  // must be a dot.
  //
  // Needs ADJACENCY specifically, not the broader "sees" (same row/column/
  // adjacent) the 1★ version uses: for 1★, two cells in the same row
  // already can't both be stars (a row only ever holds 1), but once
  // starsPerGroup > 1 that's no longer true -- only physical touching is
  // still an unconditional "can't both be stars" fact.
  //
  // Requires >= 2 shared cells AND both onlyA and onlyB non-empty:
  // - < 2 shared cells: matches hintPartialOverlap's own guard -- with
  //   only 1 shared cell, "the star is in the shared cells" is just a
  //   roundabout way of saying "the star is in this one cell".
  // - onlyA or onlyB empty: one region's cells would be a strict subset of
  //   the other's, and the deduction that follows (the containing region's
  //   extra cells must be dots) is real but a DIFFERENT, simpler argument
  //   (no adjacency involved at all) -- not this rule's job to claim
  //   credit for via a vacuously-true "every pair adjacent" check over an
  //   empty side.
  p.hintCrossBoardPartialOverlapMulti = function () {
    const candidates = [];
    const numBoards = this.game.regions.length;

    for (let boardA = 0; boardA < numBoards; boardA++) {
      for (let boardB = boardA + 1; boardB < numBoards; boardB++) {
        const boardARegions = this.getUnsolvedRegions(boardA);
        const boardBRegions = this.getUnsolvedRegions(boardB);

        for (const regA of boardARegions) {
          const setA = new Set(regA.indices.filter(i => this.vState(i) === CELL.NONE));
          if (setA.size === 0) continue;
          for (const regB of boardBRegions) {
            const setB = new Set(regB.indices.filter(i => this.vState(i) === CELL.NONE));
            if (setB.size === 0) continue;

            const shared = [...setA].filter(i => setB.has(i));
            if (shared.length < 2) continue;
            const onlyA = [...setA].filter(i => !setB.has(i));
            const onlyB = [...setB].filter(i => !setA.has(i));
            if (onlyA.length === 0 || onlyB.length === 0) continue;

            const allAdjacent = onlyA.every(a => onlyB.every(b => this._cellsAdjacent(a, b)));
            if (!allAdjacent) continue;

            const disjoint = [...onlyA, ...onlyB];
            const targets = disjoint.filter(i => this.vState(i) === CELL.NONE);
            if (targets.length === 0) continue;

            candidates.push({ shared, onlyA, onlyB, boardA, boardB, regA, regB });
          }
        }
      }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (a.onlyA[0] ?? 0) - (b.onlyA[0] ?? 0));
    return candidates.map(({ regA, regB, shared, onlyA, onlyB, boardA, boardB }) => ({
      boardIdx: undefined,
      description: `The blue region (${this._describeBoards([boardA])}) and the brown region (${this._describeBoards([boardB])}) overlap in the cyan cells. `
        + `Outside the cyan cells, both regions must hold the same number of stars -- but every such cell of one region touches every such cell of the other, `
        + `so neither can hold any. All their stars are in the cyan cells.`,
      // The overlap's empty cells, shaded on both boards -- same treatment
      // as the 1★ hintPartialOverlap.
      highlights: shared.map(idx => ({ idx, color: HINT_SOURCE_VARIANTS[2], boards: [boardA, boardB] })),
      marks: [
        ...onlyA.filter(i => this.vState(i) === CELL.NONE).map(i => ({ idx: i, color: HINT_COLOR.TARGET, boards: [boardA] })),
        ...onlyB.filter(i => this.vState(i) === CELL.NONE).map(i => ({ idx: i, color: HINT_COLOR.TARGET, boards: [boardB] })),
      ],
      // Prototype: outline each region's full shape on its own board --
      // see hintPartialOverlap's identical comment (solver-rules-single.js).
      regionOutlines: [
        { indices: regA.indices, color: 'blue', boardIdx: boardA },
        { indices: regB.indices, color: 'brown', boardIdx: boardB },
      ],
    }));
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

  // Cache key helper for _cachedOnState (solver-core.js) callers that key
  // on a set of cell indices -- order-independent, so the same group of
  // cells always produces the same key regardless of how it was assembled.
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
  // Structural (board-state-independent) geometry for band `u` on `axis`:
  // the two line index-lists and the subset of their union that isn't
  // void. Computed once per (axis, u) per puzzle and cached forever,
  // since it never depends on which cells are filled.
  p._tileBandLines = function (axis, u) {
    if (!this._tileBandLinesCache) this._tileBandLinesCache = new Map();
    const key = axis + ':' + u;
    if (!this._tileBandLinesCache.has(key)) {
      const n = this.n;
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
      const bandIndices = [...lineA, ...lineB].filter(i => !this.voidCells?.has(i));
      this._tileBandLinesCache.set(key, { lineA, lineB, bandIndices });
    }
    return this._tileBandLinesCache.get(key);
  };

  // Cached per band rather than on the whole board state: which tilings a
  // given row/column band produces depends only on the state of THAT
  // band's own cells (via starsInBand and hasEmpty below), never on cells
  // elsewhere on the board. A single-cell change anywhere only
  // invalidates the (at most two row-axis and two col-axis) bands that
  // cell actually belongs to, instead of every band on the board.
  p._confirmedTiles = function () {
    if (!this._confirmedTilesBandCache) this._confirmedTilesBandCache = new Map();
    const cache = this._confirmedTilesBandCache;
    const n = this.n;
    const quota = this.starsPerGroup;
    const tilings = [];

    for (const axis of ['row', 'col']) {
      for (let u = 0; u < n - 1; u++) {
        const { lineA, lineB, bandIndices } = this._tileBandLines(axis, u);
        const stateKey = bandIndices.map(i => this.vState(i)).join(',');
        const cacheKey = axis + ':' + u + ':' + stateKey;
        if (!cache.has(cacheKey)) {
          cache.set(cacheKey, this._confirmedTilesBand(axis, u, quota, lineA, lineB));
        }
        for (const tiling of cache.get(cacheKey)) tilings.push(tiling);
      }
    }
    return tilings;
  };

  // The confirmed tilings for a single row/column band (see
  // _confirmedTiles). tilingId is derived from (axis, u, local index)
  // instead of a global incrementing counter -- every consumer only ever
  // uses it as an opaque Map/Set key to group tiles that came from the
  // SAME tiling (see _colorSlotsForTiles), never its numeric value, and
  // this form stays unique across bands without needing shared mutable
  // state, which a plain per-band counter reset to 0 would not.
  p._confirmedTilesBand = function (axis, u, quota, lineA, lineB) {
    const n = lineA.length;
    const isEmpty = (i) => !this.voidCells?.has(i) && this.vState(i) === CELL.NONE;

    const starsInBand = [...lineA, ...lineB].filter(i => this.vState(i) === CELL.STAR).length;
    const k = 2 * quota - starsInBand;
    if (k <= 0) return [];

    const hasEmpty = [];
    for (let c = 0; c < n; c++) {
      hasEmpty.push(isEmpty(lineA[c]) || isEmpty(lineB[c]));
    }

    const result = [];
    let localTilingIndex = 0;
    for (const tiling of this._findTilings(hasEmpty)) {
      if (tiling.length !== k) continue;
      // Every tile below shares this same id -- see the color-grouping
      // comment on _colorSlotsForTiles: all tiles from one row-pair/
      // col-pair covering are meant to render as the SAME color, since
      // together they're a single argument ("these K tiles partition
      // this band's empties"), not K separate ones.
      const tilingId = `${axis}:${u}:${localTilingIndex++}`;
      const tiles = [];
      for (const boxStart of tiling) {
        const cells = [lineA[boxStart], lineB[boxStart], lineA[boxStart + 1], lineB[boxStart + 1]]
          .filter(isEmpty);
        if (cells.length === 0) continue;
        const topRow = axis === 'row' ? u : boxStart;
        const leftCol = axis === 'row' ? boxStart : u;
        // axis is carried on both the tiling and each tile (the latter so
        // it survives _allConfirmedTilesFlat's flattening) purely for
        // hint wording -- "row pair" vs "column pair" -- not used in any
        // geometry/matching logic.
        tiles.push({ cells, topLeftIdx: topRow * n + leftCol, tilingId, axis });
      }
      if (tiles.length > 0) result.push({ tiles, axis });
    }
    return result;
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
    const boardsFor = this._tileBoardAssigner(outlineTiles);

    // Draw order (later = on top): context tiles first -- row/column-pair
    // band tiles, then region/line tiles -- and the tiles the deduction
    // actually turns on LAST, so their outline is never hidden under (or
    // mistaken for) a neighboring tiling's overlapping box.
    const comboKeys = new Set(highlightTiles.map(t => this._groupKey(t.cells)));
    const rank = t => comboKeys.has(this._groupKey(t.cells)) ? 2
      : (t.tilingKind === 'region' || t.tilingKind === 'row' || t.tilingKind === 'column') ? 1 : 0;
    const ordered = outlineTiles
      .map((t, i) => ({ t, i }))
      .sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i)
      .map(e => e.t);

    return {
      tileOutlines: ordered.map(t => {
        const boards = boardsFor(t);
        return {
          topLeftIdx: t.topLeftIdx,
          color: TILE_OUTLINE_COLORS[slotByTilingId.get(t.tilingId)],
          ...(boards ? { boards } : {}),
          // Region and single-line tiles shrink to hug their actual empty
          // cells (less overlap with neighboring tiles' boxes); row-pair/
          // column-pair band tiles keep the full 2x2 box.
          ...(t.tilingKind === 'region' || t.tilingKind === 'row' || t.tilingKind === 'column'
            ? { cells: this._tileShapeCells(t) } : {})
        };
      }),
      highlights: highlightTiles.flatMap(t => {
        const boards = boardsFor(t);
        return t.cells.filter(c => !exclude.has(c))
          .map(idx => ({
            idx, color: HINT_SOURCE_VARIANTS[slotByTilingId.get(t.tilingId)],
            ...(boards ? { boards } : {})
          }));
      })
    };
  };

  // The cells a shrunken tile outline should enclose: the tile's own empty
  // cells. For two DIAGONALLY opposite cells (not edge-contiguous) the
  // renderer draws a "bowtie": the two cells joined through a narrow neck at
  // their shared corner (see _tileShapePath).
  p._tileShapeCells = function (tile) {
    return tile.cells;
  };

  // Which boards each tile is drawn on. Row/column-pair (and single-line)
  // tiles are plain geometry, valid on every board; a REGION tile only
  // means something on its own region's board. When a hint mixes both, the
  // region tiles stay on their own board and the board-agnostic tiles move
  // to whichever board(s) have no region tile, so the two tile sets don't
  // pile onto each other (if every board hosts a region tile, they go
  // everywhere and rely on draw order). Hints with no region tiles are
  // untouched: returns undefined for "every board".
  p._tileBoardAssigner = function (tiles) {
    const regionBoards = new Set(tiles.filter(t => t.boardIdx !== undefined).map(t => t.boardIdx));
    if (regionBoards.size === 0) return () => undefined;
    const free = this.boardIndices.filter(b => !regionBoards.has(b));
    const agnosticBoards = free.length > 0 ? free : this.boardIndices;
    return t => (t.boardIdx !== undefined ? [t.boardIdx] : agnosticBoards);
  };

  // "row pair" / "column pair" -- spelled out per-hint (rule 1/2 always
  // know the single tiling's axis) instead of the ambiguous "row/column
  // pair", per user feedback that the slash reads as "which one do you
  // mean?" rather than "one of these two".
  p._axisPairLabel = function (axis) {
    return axis === 'row' ? 'row pair' : 'column pair';
  };

  // Rule 1 (2★+, Hard): a confirmed tile with only 1 empty cell means
  // that cell IS the star. Shows the tile's whole originating tiling (not
  // just the one tile), so the player can see the covering argument that
  // makes it trustworthy -- see _confirmedTilesImpl's comment.
  //
  // A tiling can confirm MORE than one single-empty tile at once (e.g. two
  // different tiles in the same K-tile covering both happen to already
  // have only 1 empty cell) -- those all get combined into ONE hint here,
  // rather than one hint per tile forcing the player to cycle through
  // sibling forced-stars from the exact same covering one at a time.
  p.hintTileSingleEmpty = function () {
    const seenMarks = new Set(); // markIdx already claimed by an earlier tiling
    const hints = [];
    for (const tiling of this._confirmedTiles()) {
      const matchingTiles = tiling.tiles.filter(t => t.cells.length === 1 && !seenMarks.has(t.cells[0]));
      if (matchingTiles.length === 0) continue;

      const markIdxs = matchingTiles.map(t => t.cells[0]).sort((a, b) => a - b);
      markIdxs.forEach(idx => seenMarks.add(idx));

      const K = tiling.tiles.length;
      const { tileOutlines, highlights } = this._tileOutlinesAndHighlights(tiling.tiles, matchingTiles, markIdxs);
      const forceText = matchingTiles.length === 1
        ? "This tile's last empty cell must be the star."
        : `${matchingTiles.length} of these tiles have only one empty cell left, so each one must be the star.`;

      hints.push({
        description: `This ${this._axisPairLabel(tiling.axis)} still needs ${K} star${K === 1 ? '' : 's'}, split into these ${K} tiles -- one each. ${forceText}`,
        highlights,
        marks: markIdxs.map(idx => ({ idx, color: HINT_COLOR.TARGET_STAR })),
        tileOutlines,
        boardIdx: undefined
      });
    }
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
  //
  // Same combining as rule 1 above: a tiling can have more than one
  // 2-empty tile that each produce a dot deduction, so they're merged into
  // one hint per tiling -- the union of every contributing tile's own
  // target cells, deduped (two different tiles can happen to share a
  // target cell that touches both of them).
  p.hintTileTwoEmptyDot = function () {
    const seenKeys = new Set(); // "targets|tile cells" already claimed by an earlier tiling
    const hints = [];
    for (const tiling of this._confirmedTiles()) {
      const matchingTiles = [];
      const targetSet = new Set();
      for (const tile of tiling.tiles) {
        if (tile.cells.length !== 2) continue;
        const [a, b] = tile.cells;
        const targets = this.getNeighbors(a).filter(i =>
          this._cellsAdjacent(b, i) && !tile.cells.includes(i) && this.vState(i) === CELL.NONE
        );
        if (targets.length === 0) continue;
        const key = this._groupKey(targets) + '|' + this._groupKey(tile.cells);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        matchingTiles.push(tile);
        targets.forEach(t => targetSet.add(t));
      }
      if (matchingTiles.length === 0) continue;

      const targetList = [...targetSet].sort((a, b) => a - b);
      const K = tiling.tiles.length;
      const { tileOutlines, highlights } = this._tileOutlinesAndHighlights(tiling.tiles, matchingTiles, targetList);
      // The "marked cell(s)" count here is targetList.length -- the total
      // number of distinct target cells -- not matchingTiles.length (the
      // number of tiles), which is a different count and can differ from
      // it (e.g. several tiles sharing one deduped target, or one tile
      // with several touching targets).
      const dotWord = targetList.length === 1 ? 'cell' : 'cells';
      const dotText = matchingTiles.length === 1
        ? `Both of this tile's empty cells touch the marked ${dotWord}, so ${targetList.length === 1 ? "it's a dot" : "they're dots"}.`
        : `In each of these ${matchingTiles.length} tiles, both empty cells touch a marked cell next to it, so the marked ${dotWord} ${targetList.length === 1 ? 'is a dot' : 'are dots'}.`;

      hints.push({
        description: `This ${this._axisPairLabel(tiling.axis)} still needs ${K} star${K === 1 ? '' : 's'}, split into these ${K} tiles -- one each. ${dotText}`,
        highlights,
        marks: targetList.map(idx => ({ idx, color: HINT_COLOR.TARGET })),
        tileOutlines,
        boardIdx: undefined
      });
    }
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
    const sorted = [...candidates].sort((a, b) => (a.targets[0] ?? 0) - (b.targets[0] ?? 0));

    return sorted.map(({ unit, combo, targets }) => {
      // combo tiles can come from different coverings (row/column pairs
      // or regions) --
      // expand each one out to its full sibling tile set (see
      // _displayTilesForCombo) so the player can see why every combo tile
      // is trustworthy. Only the combo tiles themselves get highlighted,
      // though (via _tileOutlinesAndHighlights' highlightTiles param) --
      // they're the ones actually inside THIS region/unit and doing the
      // work for THIS deduction; a sibling tile from the same covering can
      // easily sit elsewhere on the board, and highlighting it too just
      // buries which cells the "still needs" argument is actually about.
      const displayTiles = this._displayTilesForCombo(combo);
      const { tileOutlines, highlights } = this._tileOutlinesAndHighlights(displayTiles, combo, targets);

      const tileWord = combo.length === 1 ? 'tile' : 'tiles';
      const holdWord = combo.length === 1 ? 'holds' : 'each hold';
      // "all 1 star" reads as a typo, not a count -- "all" only pulls its
      // weight once there's more than one to sum up.
      const starsPhrase = combo.length === 1 ? 'the 1 star' : `all ${combo.length} stars`;
      // A region is worth outlining (its shape isn't obvious from the
      // tiles alone); a row or column is not -- the tiles all sit in it and
      // the marked dots are the rest of it, so an amber band across the
      // whole line was just clutter.
      const kind = this._unitKind(unit);
      const unitPhrase = kind === 'region' ? 'the amber-outlined region' : `this ${kind}`;
      return {
        description: `The ${combo.length} highlighted ${tileWord} ${holdWord} exactly one star, accounting for ${starsPhrase} ${unitPhrase} needs.${this._tileCoverClause(displayTiles)}`,
        highlights,
        marks: targets.map(idx => ({ idx, color: HINT_COLOR.TARGET })),
        tileOutlines,
        // The region the tiles are filling. Amber, since the tiles
        // themselves already cycle through every TILE_OUTLINE_COLORS hue.
        regionOutlines: kind === 'region' ? this._outlineEntriesFor(unit, 'amber') : [],
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

  // -- Tile sees too much, multi-star (2★+, Hard, toward the end) -------------
  //
  // The 2★+ generalization of hintTileSeesTooMuch (1★, solver-rules-
  // single.js): a confirmed tile with exactly 3 empty cells, or 2
  // diagonally-opposite ones, guarantees its 1 star lands at one of those
  // candidates. For 1★, "sees" (_externalCellsSeeingAll: touching, OR
  // sharing a row/column) always means "conflicts", since a 1★ row/column
  // only ever needs 1 star -- any other cell in that same line can never
  // ALSO be a star. For 2★+, sharing a row/column does NOT automatically
  // conflict (that line may still have room for more than one star) --
  // UNLESS this specific candidate's placement would exhaust the line's
  // remaining quota (its last needed star), in which case every other
  // cell in that line becomes a dot too, same as always.
  //
  // So an external cell is forced to be a dot only if, for EVERY one of
  // the tile's candidates, EITHER the external cell touches it
  // (unconditional, quota-independent -- ordinary adjacency), OR the
  // external cell shares that candidate's row (or column) AND placing a
  // star there would complete that row (or column) -- which then dots
  // the rest of it, external cell included.
  p._wouldFinishLine = function (idx, axis) {
    const n = this.n, quota = this.starsPerGroup;
    const lineIndices = axis === 'row' ? this.axisIndices.Row[Math.floor(idx / n)] : this.axisIndices.Column[idx % n];
    const stars = lineIndices.filter(i => this.vState(i) === CELL.STAR).length;
    return stars === quota - 1;
  };

  // Whether external cell `t` is ruled out by candidate `c` specifically
  // (touches it outright, or shares c's row/column and c's placement
  // would complete that line) -- see the section comment above.
  p._externalConflictsWithCandidate = function (t, c) {
    if (this._cellsAdjacent(t, c)) return true;
    const n = this.n;
    if (Math.floor(t / n) === Math.floor(c / n) && this._wouldFinishLine(c, 'row')) return true;
    if ((t % n) === (c % n) && this._wouldFinishLine(c, 'col')) return true;
    return false;
  };

  p.hintTileSeesTooMuchMulti = function () {
    const seenKeys = new Set(); // "targets|tile cells" already claimed by an earlier tiling
    const hints = [];
    for (const tiling of this._confirmedTiles()) {
      const matchingTiles = [];
      const targetSet = new Set();
      for (const tile of tiling.tiles) {
        if (tile.cells.length !== 3 && !this._isDiagonalTilePair(tile.cells)) continue;

        const targets = [];
        for (let i = 0; i < this.n * this.n; i++) {
          if (this.vState(i) !== CELL.NONE || tile.cells.includes(i)) continue;
          if (tile.cells.every(c => this._externalConflictsWithCandidate(i, c))) targets.push(i);
        }
        if (targets.length === 0) continue;

        const key = this._groupKey(targets) + '|' + this._groupKey(tile.cells);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        matchingTiles.push(tile);
        targets.forEach(t => targetSet.add(t));
      }
      if (matchingTiles.length === 0) continue;

      const targetList = [...targetSet].sort((a, b) => a - b);
      const { tileOutlines, highlights } = this._tileOutlinesAndHighlights(tiling.tiles, matchingTiles, targetList);
      // Same wording as the 1★ hintTileSeesTooMuch.
      hints.push({
        description: matchingTiles.length === 1
          ? `This tile's empty cells must contain a star.`
          : `${matchingTiles.length} of these tiles' empty cells must each contain a star.`,
        highlights,
        marks: targetList.map(idx => ({ idx, color: HINT_COLOR.TARGET })),
        tileOutlines,
        boardIdx: undefined
      });
    }
    if (hints.length === 0) return null;
    hints.sort((a, b) => a.marks[0].idx - b.marks[0].idx);
    return hints;
  };

  // Rule 3b (2★+, Expert): the general K>1 case -- K mutually disjoint
  // confirmed tiles together account for all K stars a unit still needs.
  p.hintTileDisjointQuotaFill = function () {
    return this._formatTileQuotaFillHints(this._tileQuotaFillCandidates(false));
  };

  // -- Tile pair quota fill (1★ AND 2★+, Expert/Grandmaster) -------------------
  //
  // Rule 4 (see the "Tiles" section comment above hintTileSingleEmpty; this
  // one is shared by both star-count families, unlike the rest of the
  // Tiles rules, which each got their own 1★/2★+ variant). A confirmed
  // tile is normally used within its OWN row-pair/column-pair band (e.g.
  // hintTileQuotaFillSingle/hintTileDisjointQuotaFill combine tiles from
  // the SAME band to fill one row/column/region's quota). This rule
  // instead combines tiles from DIFFERENT column-pair bands that happen to
  // land in the SAME row-pair window (or symmetrically, different row-pair
  // bands landing in the same column-pair window): each such tile still
  // guarantees exactly 1 star, computed independently of the others, but
  // if enough of them (from unrelated bands) land in the same 2-row (or
  // 2-column) window to add up to that window's own remaining need, every
  // other empty cell in that window must be a dot -- the window's whole
  // quota is already spoken for.
  //
  // E.g. columns B+C's own tiling puts one of its tiles at rows 5-6, and
  // (unrelated) columns E+F's own tiling ALSO puts one of its tiles at
  // rows 5-6. Neither band's tiling has anything to do with the other, but
  // together their rows-5-6 tiles account for both stars rows 5-6 need
  // (1★: one each) -- so every other empty cell in rows 5-6 (outside
  // either tile) is a dot.
  //
  // Slotted at the start of Expert for both families: spotting a single
  // band's own tiles is Hard-tier work, but noticing that SEVERAL
  // unrelated bands' tiles happen to converge on the same row/column-pair
  // window is a step up -- there's no shared tiling to visually anchor the
  // observation the way hintTileQuotaFillSingle/Disjoint have.
  //
  // Split by combo size: exactly 2 independent tiles converging stays
  // Expert (hintTilePairQuotaFill), but 3-OR-MORE independent tiles
  // converging on the same window is a bigger inferential leap again --
  // that case is Grandmaster (hintTilePairQuotaFillGrandmaster, in the
  // Grandmaster section of _getMultiStarRuleList below).

  // Every confirmed tile whose ORIGINATING band ran along `bandAxis`
  // ('col' for a column-pair band, 'row' for a row-pair band), grouped by
  // the OTHER axis's window it lands in (a column-pair band's tiles are
  // grouped by which row-pair they occupy, and vice versa) -- exactly the
  // window this rule tries to fill. Returns a Map: window start index ->
  // [tile, ...].
  //
  // Deliberately does NOT source from _allConfirmedTilesFlat(): that
  // dedupes purely by cell-set, which silently drops window information a
  // tile can genuinely have more than one of. When a box's "extra"
  // column/row is already fully decided, two different box positions --
  // e.g. columns A/B and columns B/C -- can both collapse to the exact
  // same surviving empty cells (say, just {B6, B7}) once column A (or C)
  // has nothing left empty to contribute. Those two box positions belong
  // to DIFFERENT windows (0/1 vs 1/2) of the OTHER axis, and both are
  // legitimately confirmed -- but a cells-only dedup keeps only whichever
  // one _confirmedTilesImpl happened to enumerate first, discarding the
  // other window's registration entirely. That's exactly the parity gap
  // found against Python's rule_tile_pair_quota_fill (which recomputes
  // fresh per band_axis and dedupes on (cells, window), not cells alone --
  // see _confirmed_tiles_with_window in rules_multi_star.py) on a real
  // stuck 9x9/2★ board: the missing window meant this rule couldn't find
  // enough disjoint tiles to fill the quota, even though Python's
  // equivalent did. Iterating _confirmedTiles() directly (one entry per
  // TILING, not deduped across tilings) and keying the dedup on
  // `${windowStart}|${cells}` instead preserves every window a tile is
  // legitimately confirmed for, while still collapsing literal repeats of
  // the same (cells, window) pair from different tilings.
  p._tilesByPairWindow = function (bandAxis) {
    const n = this.n;
    const byWindow = new Map();
    const seen = new Set();
    for (const { tiles, axis } of this._confirmedTiles()) {
      if (axis !== bandAxis) continue;
      for (const tile of tiles) {
        const topRow = Math.floor(tile.topLeftIdx / n), leftCol = tile.topLeftIdx % n;
        const windowStart = bandAxis === 'col' ? topRow : leftCol;
        const key = `${windowStart}|${this._groupKey(tile.cells)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!byWindow.has(windowStart)) byWindow.set(windowStart, []);
        byWindow.get(windowStart).push(tile);
      }
    }
    return byWindow;
  };

  // bandAxis: 'col' looks for column-pair tiles filling a ROW-pair's
  // quota; 'row' looks for row-pair tiles filling a COLUMN-pair's quota
  // (the symmetric case) -- see the section comment above.
  // minTiles/maxTiles restricts to windows whose combo needs exactly this
  // many disjoint tiles (`needed` below IS the combo size, since
  // _findDisjointTileCombo only ever returns a combo of exactly `needed`
  // tiles). Combining exactly 2 independent tiles into one argument
  // (hintTilePairQuotaFill, Expert) is a materially smaller leap than
  // combining 3 or more (hintTilePairQuotaFillGrandmaster) -- see both
  // functions below.
  p._tilePairQuotaFillCandidates = function (bandAxis, minTiles = 2, maxTiles = Infinity) {
    const quota = this.starsPerGroup;
    const byWindow = this._tilesByPairWindow(bandAxis);
    const targetAxisIndices = bandAxis === 'col' ? this.axisIndices.Row : this.axisIndices.Column;

    const candidates = [];
    for (const [windowStart, tiles] of byWindow) {
      const windowIndices = [...targetAxisIndices[windowStart], ...targetAxisIndices[windowStart + 1]];
      const starsInWindow = windowIndices.filter(i => this.vState(i) === CELL.STAR).length;
      const needed = 2 * quota - starsInWindow;
      if (needed <= 0) continue;
      if (needed < minTiles || needed > maxTiles) continue;

      const combo = this._findDisjointTileCombo(tiles, needed);
      if (!combo) continue;

      const covered = new Set(combo.flatMap(t => t.cells));
      const targets = windowIndices.filter(i => this.vState(i) === CELL.NONE && !covered.has(i));
      if (targets.length === 0) continue;

      candidates.push({ bandAxis, combo, targets, windowStart });
    }
    return candidates;
  };

  // Shared by hintTilePairQuotaFill/hintTilePairQuotaFillGrandmaster: turns
  // a list of candidates (already filtered to the desired tile-count range)
  // into hints.
  p._formatTilePairQuotaFillHints = function (candidates) {
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (a.targets[0] ?? 0) - (b.targets[0] ?? 0));

    // Same "show each combo tile's whole originating tiling for context"
    // approach as _formatTileQuotaFillHints, since these combo tiles can
    // come from several DIFFERENT tilings here even more often than that
    // rule (that's the whole point -- unrelated bands converging on one
    // window).
    return candidates.map(({ bandAxis, combo, targets, windowStart }) => {
      const displayTiles = this._displayTilesForCombo(combo);
      const { tileOutlines, highlights } = this._tileOutlinesAndHighlights(displayTiles, combo, targets);

      // The pair being filled, named the same way renderer.js labels its
      // axes: rows by 1-indexed number, columns by letter.
      const pairName = bandAxis === 'col'
        ? `rows ${windowStart + 1} and ${windowStart + 2}`
        : `columns ${String.fromCharCode(65 + windowStart)} and ${String.fromCharCode(66 + windowStart)}`;

      return {
        description: `Each tile must hold exactly one star. The colored cells satisfy ${pairName}.${this._tileCoverClause(displayTiles)}`,
        highlights,
        marks: targets.map(idx => ({ idx, color: HINT_COLOR.TARGET })),
        tileOutlines,
        boardIdx: undefined
      };
    });
  };

  // Rule 4 (Expert, 1★ and 2★+): exactly 2 disjoint tiles from unrelated
  // bands filling one pair-window's quota. See hintTilePairQuotaFillGrandmaster
  // for 3-or-more.
  p.hintTilePairQuotaFill = function () {
    const candidates = [
      ...this._tilePairQuotaFillCandidates('col', 2, 2),
      ...this._tilePairQuotaFillCandidates('row', 2, 2),
    ];
    return this._formatTilePairQuotaFillHints(candidates);
  };

  // Rule 4b (Grandmaster, 1★ and 2★+): the same argument as
  // hintTilePairQuotaFill, but combining THREE OR MORE independent tiles
  // (each from its own unrelated band) into one pair-window's quota,
  // rather than just two. Two independent tiles happening to land in the
  // same window is already a step up from a band's own (same-tiling) tile
  // rules -- three or more compounds that same leap again, so this is
  // gated to Grandmaster instead of sharing Expert with the 2-tile case.
  p.hintTilePairQuotaFillGrandmaster = function () {
    const candidates = [
      ...this._tilePairQuotaFillCandidates('col', 3),
      ...this._tilePairQuotaFillCandidates('row', 3),
    ];
    return this._formatTilePairQuotaFillHints(candidates);
  };

  // -- Region tiles: shared machinery (2★+) ----------------------------------------
  //
  // Besides the row-pair/column-pair BAND tilings above, a region still
  // needing K stars whose empties can be partitioned into exactly K CLIQUES
  // (cells that all mutually touch, i.e. subsets of one 2x2 box) confirms
  // tiles by the very same pigeonhole argument -- K stars needed, K groups
  // that can each hold at most 1, so each group holds exactly 1. Used by the
  // region-tile rules below (regionTileStar/Dots/LineFill).
  //
  // (Mixed rules combining band, region, and line tiles were tried and
  // removed -- the hints stacked too many overlapping coverings for the few
  // deductions they added. See tools/tile_sources_*.py for the experiments.)

  // Every partition of `empties` into exactly k cliques. Each partition is a
  // list of cell-index arrays. Empty if none exists (e.g. the unit's
  // minimum clique cover is bigger than k). Capped, so a pathological unit
  // can only lose tiles (never gain a wrong one).
  p._cliquePartitions = function (empties, k, cap = 500) {
    const cells = [...empties].sort((a, b) => a - b);
    if (k <= 0 || cells.length < k || cells.length > 4 * k) return [];
    const adj = new Map(cells.map(c => [c, new Set(this.getNeighbors(c))]));

    // Every clique containing x within `rest` (size 1..4, x first).
    const groupsFor = (x, rest) => {
      const partners = rest.filter(c => adj.get(x).has(c));
      const groups = [];
      const grow = (start, chosen) => {
        groups.push([x, ...chosen]);
        if (chosen.length >= 3) return;
        for (let i = start; i < partners.length; i++) {
          const c = partners[i];
          if (chosen.every(d => adj.get(d).has(c))) grow(i + 1, [...chosen, c]);
        }
      };
      grow(0, []);
      return groups;
    };

    const memo = new Map();
    const feasible = (rem, kLeft) => {
      if (rem.length === 0) return kLeft === 0;
      if (kLeft === 0 || rem.length > 4 * kLeft || rem.length < kLeft) return false;
      const key = `${kLeft}|${rem.join(',')}`;
      if (memo.has(key)) return memo.get(key);
      const [x, ...rest] = rem;
      let ok = false;
      for (const g of groupsFor(x, rest)) {
        const gs = new Set(g);
        if (feasible(rest.filter(c => !gs.has(c)), kLeft - 1)) { ok = true; break; }
      }
      memo.set(key, ok);
      return ok;
    };
    if (!feasible(cells, k)) return [];

    const partitions = [];
    const walk = (rem, kLeft, acc) => {
      if (partitions.length >= cap) return;
      if (rem.length === 0) { if (kLeft === 0) partitions.push(acc.slice()); return; }
      const [x, ...rest] = rem;
      for (const g of groupsFor(x, rest)) {
        const gs = new Set(g);
        const next = rest.filter(c => !gs.has(c));
        if (!feasible(next, kLeft - 1)) continue;
        acc.push(g);
        walk(next, kLeft - 1, acc);
        acc.pop();
      }
    };
    walk(cells, k, []);
    return partitions;
  };

  // Top-left cell of a 2x2 box containing every cell in `cells` (they
  // always fit in one: a clique is a subset of a 2x2 box). Clamped so the
  // box stays on the board -- only used to position the tile outline.
  p._tileBoxTopLeft = function (cells) {
    const n = this.n;
    const minRow = Math.min(...cells.map(i => Math.floor(i / n)));
    const minCol = Math.min(...cells.map(i => i % n));
    return Math.min(minRow, n - 2) * n + Math.min(minCol, n - 2);
  };

  // Region/line tiles for one unit, as [{ cells, witness }] -- `witness` is
  // ONE full partition (tile objects sharing a tilingId) that confirms the
  // tile, kept so a hint can show the whole covering, same as band tiles.
  // Cached on the unit's own state (a unit's tiles never depend on cells
  // outside it).
  p._unitTileEntries = function (unit) {
    const stars = unit.indices.filter(i => this.vState(i) === CELL.STAR).length;
    const k = this.starsPerGroup - stars;
    if (k <= 0) return [];
    const empties = unit.indices.filter(i => this.vState(i) === CELL.NONE);
    if (empties.length < k || empties.length > 4 * k) return [];

    if (!this._unitTileEntriesCache) this._unitTileEntriesCache = new Map();
    const cacheKey = `${unit.label}|${k}|${empties.join(',')}`;
    if (this._unitTileEntriesCache.has(cacheKey)) return this._unitTileEntriesCache.get(cacheKey);

    const kind = this._unitKind(unit);
    const entries = new Map();
    this._cliquePartitions(empties, k).forEach((partition, pIdx) => {
      const tilingId = `${unit.label}#${pIdx}`;
      const witness = partition.map(group => {
        const cells = [...group].sort((a, b) => a - b);
        return { cells, topLeftIdx: this._tileBoxTopLeft(cells), tilingId, tilingKind: kind, boardIdx: unit.boardIdx };
      });
      for (const tile of witness) {
        const key = this._groupKey(tile.cells);
        if (!entries.has(key)) entries.set(key, { cells: tile.cells, rep: tile, witness });
      }
    });
    const result = [...entries.values()];
    this._unitTileEntriesCache.set(cacheKey, result);
    return result;
  };

  // The full set of tiles to outline for a combo: each combo tile's whole
  // originating covering (deduped), so the player can see why every combo
  // tile holds exactly one star. Works for band tiles (looked up by
  // tilingId), and pool tiles carrying their own `witness`.
  p._displayTilesForCombo = function (combo) {
    const byTilingId = new Map();
    for (const { tiles } of this._confirmedTiles()) {
      for (const t of tiles) {
        if (!byTilingId.has(t.tilingId)) byTilingId.set(t.tilingId, tiles);
      }
    }
    const seen = new Set();
    const out = [];
    for (const t of combo) {
      const group = t.witness ?? byTilingId.get(t.tilingId) ?? [t];
      const id = group[0].tilingId;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(...group);
    }
    return out;
  };

  // Extra sentence explaining WHY outlined tiles hold exactly one star,
  // only when a region/row/column covering is involved (band coverings are
  // already what the base wording assumes, so pure-band hints are unchanged).
  p._tileCoverClause = function (displayTiles) {
    const kinds = [];
    for (const t of displayTiles) {
      const kind = t.tilingKind ?? (t.axis === 'row' ? 'row pair' : 'column pair');
      if (!kinds.includes(kind)) kinds.push(kind);
    }
    if (!kinds.some(k => k === 'region' || k === 'row' || k === 'column')) return '';
    const joined = kinds.length === 1 ? kinds[0]
      : kinds.length === 2 ? `${kinds[0]} or ${kinds[1]}`
      : `${kinds.slice(0, -1).join(', ')}, or ${kinds[kinds.length - 1]}`;
    return ` Each color of outlined tiles exactly covers the empty cells of one ${joined} that still needs that many stars, so every tile holds exactly one.`;
  };

  // -- Region and line tiles on their own (2★+, Beginner) ----------------------------------
  //
  // The pure single-region version of the tile deductions: a region still
  // needing K stars whose empty cells split into K cliques (tiles) holds
  // exactly one star per tile. Two things follow from the tile alone:
  //  - a tile with just ONE empty cell: that cell is the star;
  //  - a tile of 2-3 empty cells: any other cell touching EVERY one of them
  //    touches that tile's star whichever cell it is, so it's a dot.
  // unitPlacementForced('weak') already finds both of these (it enumerates
  // the region's placements), which is why they sit immediately before its
  // 'all_stars' / 'dots' variants at the same tier and score -- same
  // deductions, but shown as the tiling that makes them obvious. K=1 with
  // the whole region in a 2x2 box is by far the commonest case. At most one
  // hint per region (the tiling marking the most cells). The line versions
  // (lineTileStar/Dots) do the same for a single row/column, whose tiles are
  // 1x2 dominoes or single cells.
  p._regionTileHints = function (wantStar, lines = false) {
    const hints = [];
    const seenWitness = new Set();
    for (const unit of this.units) {
      // Region units, or (lines = true) single rows/columns, whose tiles are
      // dominoes: 1 empty cell or 2 touching ones.
      if ((unit.boardIdx === undefined) !== lines) continue;
      const kind = this._unitKind(unit);
      const byWitness = new Map();
      for (const entry of this._unitTileEntries(unit)) {
        let targets;
        if (wantStar) {
          // A tiling of ALL single cells is just "the region has exactly as
          // many empties as it needs" -- unitPlacementForced's own wording
          // is the natural one there, so only show tilings with a real tile.
          if (entry.cells.length !== 1 || entry.witness.every(t => t.cells.length === 1)) continue;
          targets = [entry.cells[0]];
        } else {
          if (entry.cells.length < 2) continue;
          const [first, ...others] = entry.cells;
          targets = this.getNeighbors(first).filter(i =>
            this.vState(i) === CELL.NONE && !entry.cells.includes(i)
            && others.every(c => this._cellsAdjacent(c, i)));
        }
        if (targets.length === 0) continue;
        const id = entry.witness[0].tilingId;
        if (!byWitness.has(id)) byWitness.set(id, { witness: entry.witness, matching: [], targets: new Set() });
        const group = byWitness.get(id);
        group.matching.push(entry.rep);
        targets.forEach(t => group.targets.add(t));
      }
      // A region can have several similar tilings with similar deductions;
      // show only the one that marks the most cells (first found on ties).
      let best = null;
      for (const [id, group] of byWitness) {
        if (!best || group.targets.size > best.group.targets.size) best = { id, group };
      }
      for (const [id, { witness, matching, targets }] of best ? [[best.id, best.group]] : []) {
        if (seenWitness.has(id)) continue;
        seenWitness.add(id);
        const targetList = [...targets].sort((a, b) => a - b);
        const { tileOutlines, highlights } = this._tileOutlinesAndHighlights(witness, matching, targetList);
        const K = witness.length;
        const intro = lines
          ? (K === 1
            ? `This ${kind} needs one more star, and its empty cells are just these two touching cells, which can hold only one star.`
            : `This ${kind} still needs ${K} stars, and its empty cells split into these ${K} tiles of one or two touching cells -- each holds at most one star, so exactly one each.`)
          : (K === 1
            ? `The empty cells of the amber-outlined region all touch each other (they fit in a 2x2 box), so it can hold only one star -- and it needs exactly one more.`
            : `The amber-outlined region still needs ${K} stars, and its empty cells split into these ${K} tiles that can each hold at most one star -- so exactly one each.`);
        const outro = wantStar
          ? (matching.length === 1
            ? `The highlighted tile has only one empty cell left, so that cell is the star.`
            : `${matching.length} of these tiles have only one empty cell left, so each of those cells is a star.`)
          : (matching.length === 1
            ? `The marked ${targetList.length === 1 ? 'cell touches' : 'cells touch'} every empty cell of the highlighted tile, so ${targetList.length === 1 ? "it's a dot" : "they're dots"}.`
            : `Each marked cell touches every empty cell of one of the highlighted tiles, so ${targetList.length === 1 ? "it's a dot" : "they're dots"}.`);
        hints.push({
          description: `${intro} ${outro}`,
          highlights,
          marks: targetList.map(idx => ({ idx, color: wantStar ? HINT_COLOR.TARGET_STAR : HINT_COLOR.TARGET })),
          tileOutlines,
          regionOutlines: this._outlineEntriesFor(unit, 'amber'),
          boardIdx: unit.boardIdx,
          observation: this._unitObservation(unit)
        });
      }
    }
    if (hints.length === 0) return null;
    hints.sort((a, b) => a.marks[0].idx - b.marks[0].idx);
    return hints;
  };

  p.hintRegionTileStar = function () { return this._regionTileHints(true); };
  p.hintRegionTileDots = function () { return this._regionTileHints(false); };
  // Same deductions for a single row/column tiled by 1x2 dominoes -- see the
  // section comment above; slotted right after the region versions.
  p.hintLineTileStar = function () { return this._regionTileHints(true, true); };
  p.hintLineTileDots = function () { return this._regionTileHints(false, true); };

  // -- Region tiles fill a row/column (2★+) --------------------------------------
  //
  // A row/column still needing K stars, with K disjoint REGION tiles lying
  // entirely inside it: each tile holds exactly one star, so together they
  // account for all K and every other empty cell in the line is a dot.
  // Only region tiles count -- a single row/column's own "domino" tiles
  // would cover the whole line (nothing to dot), and band tiles are the
  // harder Hard-tier rules.
  //
  // Two rules share this body. regionTileLineFill (end of Medium) only
  // combines tiles from ONE board's regions at a time -- easy to spot, since
  // you only ever look at one board's coloring. regionTileLineFillCross
  // (Hard, right after regionSubsetHard) may also mix tiles from both boards'
  // regions to reach K, which means holding both colorings in mind at once.
  p._regionTileLineFillHints = function (crossBoard) {
    // Tiles by board. The pool is keyed by (board, cells) so the same cell
    // set appearing on two boards stays two tiles for the single-board pass.
    const byBoard = new Map();
    for (const unit of this.units) {
      if (unit.boardIdx === undefined) continue;
      if (!byBoard.has(unit.boardIdx)) byBoard.set(unit.boardIdx, new Map());
      const pool = byBoard.get(unit.boardIdx);
      for (const e of this._unitTileEntries(unit)) {
        const key = this._groupKey(e.cells);
        if (!pool.has(key)) pool.set(key, { ...e.rep, cells: e.cells, witness: e.witness });
      }
    }
    if (byBoard.size === 0) return null;

    // Each entry is one tile list to search: a single board's tiles, or
    // (cross-board) every board's tiles together, deduped by cell set.
    let tileLists;
    if (crossBoard) {
      const all = new Map();
      for (const pool of byBoard.values()) {
        for (const [key, t] of pool) if (!all.has(key)) all.set(key, t);
      }
      tileLists = [[...all.values()]];
    } else {
      tileLists = [...byBoard.values()].map(pool => [...pool.values()]);
    }

    const candidates = [];
    for (const unit of this.units) {
      if (unit.boardIdx !== undefined) continue;
      const stars = unit.indices.filter(i => this.vState(i) === CELL.STAR).length;
      const k = this.starsPerGroup - stars;
      if (k <= 0) continue;
      const avail = new Set(unit.indices.filter(i => this.vState(i) === CELL.NONE));
      if (avail.size <= k) continue;
      for (const tiles of tileLists) {
        const inside = tiles.filter(t => t.cells.every(c => avail.has(c)));
        if (inside.length < k) continue;
        const combo = this._findDisjointTileCombo(inside, k);
        if (!combo) continue;
        const covered = new Set(combo.flatMap(t => t.cells));
        const targets = [...avail].filter(i => !covered.has(i));
        if (targets.length === 0) continue;
        candidates.push({ unit, combo, targets });
        break;
      }
    }
    return this._formatTileQuotaFillHints(candidates);
  };

  p.hintRegionTileLineFill = function () { return this._regionTileLineFillHints(false); };
  p.hintRegionTileLineFillCross = function () { return this._regionTileLineFillHints(true); };

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
    // The single-board (Expert) version's contradiction is usually simple
    // enough to spot by eye (the blue cells just run out of room). The
    // cross-board (Grandmaster) version's contradiction is subtler -- it
    // only shows up once you also account for every OTHER row, column, and
    // region's own remaining capacity (often one on the other board), which
    // is why it's worth spelling out explicitly here.
    const description = singleBoard
      ? `The blue-outlined cells can no longer reach their required star count if the circled cell holds a star.`
      : `The blue-outlined cells can no longer reach their required star count if the circled cell holds a star -- every way to place their remaining stars would break some other row, column, or region's own star limit.`;
    // The cross-board version also says which boards the player needs to
    // look at, when it's more than one -- same as the 1★ hintLookaheadHalf.
    const sandboxForBoards = testIdx => boards => {
      const state = this._buildSpeculativeState(testIdx);
      this._applyStarPlacementDots(state, testIdx, boards);
      return state;
    };
    return candidates.map(({ testIdx, broken, boardIdx }) => ({
      boardIdx: singleBoard ? boardIdx : (broken.type === 'region' ? broken.boardIdx : undefined),
      description: description + (singleBoard ? '' : this._boardsNeededNote(broken, sandboxForBoards(testIdx))),
      highlights: [],
      marks: [{ idx: testIdx, color: HINT_COLOR.TARGET }],
      // Same treatment as hintLookaheadHalf's identical broken-unit outline.
      regionOutlines: this._outlineEntriesFor(broken, 'blue'),
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
  // -- Tiles: partial tiling + trapped "bar" (2★+) -----------------------------------
  //
  // A sibling of rule 1/2/3 above, built on the SAME 2x2-tile pigeonhole
  // idea (_confirmedTilesImpl), but for bands where a COMPLETE tiling
  // doesn't exist. A row-pair or column-pair band's empties don't always
  // partition cleanly into exactly the K boxes the band needs -- e.g. a
  // run of consecutive "only one of the two lines is empty here"
  // positions of ODD length can never itself split into 2-wide boxes, no
  // matter how the rest of the band tiles. When that happens today,
  // _confirmedTilesImpl finds NOTHING for the whole band -- one bad
  // stretch throws away every tile the band's OTHER, perfectly tileable
  // portions could have confirmed.
  //
  // This rule instead looks for a PARTIAL tiling: some number of clean
  // boxes covering everything EXCEPT one contiguous "bar" -- a run where
  // only one of the band's two lines is empty at every position (so it's
  // a straight run of single cells, never two adjacent ones, i.e. a
  // simple path -- no two bar cells ever touch except consecutive ones in
  // the run). Those j boxes hold at most j stars between them (1 each,
  // same as always); the band needs k total; so the bar alone must hold
  // at least (k - j). That "at least m stars, non-adjacent, packed into
  // this specific path of cells" fact traps any OUTSIDE cell touching
  // enough of the bar to drop its own achievable max below that minimum --
  // same "guarantee -> trap" shape as hintRegionLinePartitionTrapped, just
  // with the guarantee coming from tile pigeonholing instead of a
  // cross-region quota sum.
  //
  // A single band can have several genuinely different valid splits (the
  // bar can sit at the start, the end, or in the middle, with tiled
  // stretches on either side) -- e.g. a real 17x17/4★ case with j=5 and a
  // 7-cell bar, ANOTHER with j=6 and a 5-cell bar, and a third with j=7
  // and a 3-cell bar, all for variations on the same idea. This searches
  // every contiguous candidate bar, not just the single "best" one, since
  // a smaller bar with a smaller guarantee can still trap a cell a bigger
  // bar's own (larger) guarantee doesn't reach (different cells touch
  // different bars). For a FIXED bar, though, only the tightest (largest)
  // guarantee is ever useful -- a looser one can never trap more than the
  // tightest already does -- so per bar this keeps only the smallest
  // achievable tile count.
  //
  // Verified against two real occurrences on 17x17_mono puzzle_7610
  // (#2001): a 5-tile/7-cell-bar case forcing >=3 (correctly traps one
  // cell) and a 6-tile/5-cell-bar case forcing >=2 (correctly traps a
  // different cell) -- both cross-checked against that puzzle's actual
  // solution, confirming neither trapped cell is really a star. Python
  // port: tools/scorer/rules_multi_star.py's matching section.

  // Every (offset, tileCount) reachable by cleanly tiling [0, offset) of
  // `hasEmpty` with the same singleton (only where NOT hasEmpty) / box (2
  // adjacent positions, at least one hasEmpty) rule _findTilings uses,
  // together with enough breadcrumbs to reconstruct one concrete tiling
  // for any specific reachable (offset, tileCount) pair (see
  // _reconstructPrefixBoxes). Needed because a FIXED hasEmpty pattern
  // doesn't tile with a unique box count the way a plain domino-counting
  // DP would assume -- e.g. hasEmpty [false,true,true,false] tiles as
  // either singleton+box+singleton (1 box) or box+box (2 boxes), both
  // ending at offset 4 -- so "can [0, offset) tile with exactly k boxes"
  // needs its own reachability search per count, not just "can it tile at
  // all". Returns one Map<count, {via, prevOffset, prevCount}> per offset
  // (index 0..n).
  p._prefixTilingDP = function (hasEmpty) {
    const n = hasEmpty.length;
    const reachable = Array.from({ length: n + 1 }, () => new Map());
    reachable[0].set(0, null);
    for (let offset = 0; offset < n; offset++) {
      for (const count of reachable[offset].keys()) {
        if (!hasEmpty[offset] && !reachable[offset + 1].has(count)) {
          reachable[offset + 1].set(count, { via: 'singleton', prevOffset: offset, prevCount: count });
        }
        if (offset + 1 < n && (hasEmpty[offset] || hasEmpty[offset + 1]) && !reachable[offset + 2].has(count + 1)) {
          reachable[offset + 2].set(count + 1, { via: 'box', prevOffset: offset, prevCount: count });
        }
      }
    }
    return reachable;
  };

  // Walks a _prefixTilingDP's breadcrumbs back from (endOffset, count) to
  // (0, 0), collecting the box-start offsets used along the way (same
  // shape _findTilings returns). Caller must already know (endOffset,
  // count) is reachable.
  p._reconstructPrefixBoxes = function (reachable, endOffset, count) {
    const boxes = [];
    let offset = endOffset, c = count;
    while (offset > 0) {
      const step = reachable[offset].get(c);
      if (step.via === 'box') boxes.unshift(step.prevOffset);
      offset = step.prevOffset;
      c = step.prevCount;
    }
    return boxes;
  };

  // Prefix/suffix max-non-touching-along-path arrays for pathCells, given
  // a FIXED blocked set (existing stars only -- NOT a candidate).
  // prefix[i] = best achievable using only pathCells[0:i]; suffix[i] =
  // best achievable using only pathCells[i:]. pathCells is always a
  // straight physical line -- exactly one cell per row/column of a
  // straight 2-line band, so only consecutive entries can ever touch --
  // a single outside candidate's neighbors among them are always a
  // contiguous index range [lo, hi] -- so "what's the max with existing
  // stars AND this one candidate both blocked" is just
  // prefix[lo] + suffix[hi + 1] (the two halves are independent:
  // excluding at least one position between them means they can never be
  // adjacent to each other). Turns hintTileBarTrapped's per-candidate
  // check from an O(barLen) rescan into an O(1) lookup after this
  // O(barLen) setup, done once per bar rather than once per candidate.
  // Python port: rules_multi_star.py's _tile_bar_prefix_suffix.
  p._tileBarPrefixSuffix = function (pathCells, blocked) {
    const blockedNeighbors = new Set();
    for (const b of blocked) for (const nb of this.getNeighbors(b)) blockedNeighbors.add(nb);
    const usable = pathCells.map(c => blockedNeighbors.has(c) ? 0 : 1);
    const n = pathCells.length;

    const prefix = new Array(n + 1).fill(0);
    let prev2 = 0, prev1 = 0;
    for (let i = 0; i < n; i++) {
      const cur = Math.max(prev1, prev2 + usable[i]);
      prefix[i + 1] = cur;
      prev2 = prev1;
      prev1 = cur;
    }

    const suffix = new Array(n + 1).fill(0);
    prev2 = 0; prev1 = 0;
    for (let i = n - 1; i >= 0; i--) {
      const cur = Math.max(prev1, prev2 + usable[i]);
      suffix[i] = cur;
      prev2 = prev1;
      prev1 = cur;
    }

    return { prefix, suffix };
  };

  p._tileBarFacts = function () {
    return this._cachedOnState('tileBarFacts', () => this._tileBarFactsImpl());
  };

  // Every (axis, lineIdx, tiles, barCells, need) fact across every
  // row-pair/column-pair band -- see this section's own comment above for
  // the reasoning. tiles is one concrete witness tiling (topLeftIdx +
  // cells per tile, same shape _confirmedTilesImpl produces) for the
  // SMALLEST tile count achieving that bar, since a smaller count means a
  // bigger (tighter) `need`.
  p._tileBarFactsImpl = function () {
    const n = this.n;
    const quota = this.starsPerGroup;
    const isEmpty = (i) => !this.voidCells?.has(i) && this.vState(i) === CELL.NONE;
    const facts = [];

    for (const axis of ['row', 'col']) {
      for (let u = 0; u < n - 1; u++) {
        const lineA = [], lineB = [];
        for (let c = 0; c < n; c++) {
          if (axis === 'row') { lineA.push(u * n + c); lineB.push((u + 1) * n + c); }
          else { lineA.push(c * n + u); lineB.push(c * n + (u + 1)); }
        }

        const starsInBand = [...lineA, ...lineB].filter(i => this.vState(i) === CELL.STAR).length;
        const k = 2 * quota - starsInBand;
        if (k <= 0) continue;

        const isEmptyA = lineA.map(isEmpty), isEmptyB = lineB.map(isEmpty);
        const hasEmpty = lineA.map((_, c) => isEmptyA[c] || isEmptyB[c]);
        const width = lineA.map((_, c) => (isEmptyA[c] ? 1 : 0) + (isEmptyB[c] ? 1 : 0));

        const prefixDP = this._prefixTilingDP(hasEmpty);
        const reversedHasEmpty = hasEmpty.slice().reverse();
        const suffixDP = this._prefixTilingDP(reversedHasEmpty);

        for (let barStart = 0; barStart < n; barStart++) {
          // Once the prefix [0, barStart) itself can't be cleanly tiled at
          // all, no barEnd starting here can work either.
          if (prefixDP[barStart].size === 0) continue;
          for (let barEnd = barStart + 1; barEnd <= n; barEnd++) {
            let validBar = true;
            for (let c = barStart; c < barEnd; c++) {
              if (!hasEmpty[c] || width[c] !== 1) { validBar = false; break; }
            }
            // Also require the whole bar to be confined to a single one of
            // the pair's two lines. A bar that alternates -- some
            // positions drawn from lineA, others from lineB -- is still a
            // genuine simple path (consecutive cells stay diagonally
            // adjacent either way, so the max-non-touching DP is unaffected)
            // and the deduction is just as sound, but highlighted it reads
            // as the marked strip jumping between rows/columns, which is
            // confusing even when correct. Skipping it costs nothing: the
            // search tries every barStart/barEnd independently, so the same
            // final target is generally still reachable via a same-line bar
            // with one more tile absorbing the flip point instead.
            if (validBar) {
              const barSide = isEmptyA[barStart];
              for (let c = barStart + 1; c < barEnd; c++) {
                if (isEmptyA[c] !== barSide) { validBar = false; break; }
              }
            }
            if (!validBar) continue;

            const revBarStart = n - barEnd; // suffix [barEnd, n) == reversed-prefix [0, n-barEnd)
            const suffixCounts = suffixDP[revBarStart];
            if (suffixCounts.size === 0) continue;

            const minPrefixCount = Math.min(...prefixDP[barStart].keys());
            const minSuffixCount = Math.min(...suffixCounts.keys());
            const j = minPrefixCount + minSuffixCount;
            const need = k - j;
            if (need < 1) continue;

            const barCells = [];
            for (let c = barStart; c < barEnd; c++) {
              barCells.push(isEmptyA[c] ? lineA[c] : lineB[c]);
            }

            const prefixBoxOffsets = this._reconstructPrefixBoxes(prefixDP, barStart, minPrefixCount);
            const revSuffixBoxOffsets = this._reconstructPrefixBoxes(suffixDP, revBarStart, minSuffixCount);
            // A box at reversed offset r covers reversed positions r, r+1
            // -- i.e. original positions n-1-r and n-2-r -- so its
            // original (smaller-index) box-start is n-2-r.
            const suffixBoxOffsets = revSuffixBoxOffsets.map(r => n - 2 - r);
            const tileBoxStarts = [...prefixBoxOffsets, ...suffixBoxOffsets];

            const tiles = tileBoxStarts.map(boxStart => {
              const cells = [lineA[boxStart], lineB[boxStart], lineA[boxStart + 1], lineB[boxStart + 1]]
                .filter(isEmpty);
              const topRow = axis === 'row' ? u : boxStart;
              const leftCol = axis === 'row' ? boxStart : u;
              return { cells, topLeftIdx: topRow * n + leftCol };
            });

            facts.push({ axis, lineIdx: u, tiles, barCells, need });
          }
        }
      }
    }
    return facts;
  };

  p.hintTileBarTrapped = function () {
    const existingStars = [];
    for (let i = 0; i < this.n * this.n; i++) {
      if (this.vState(i) === CELL.STAR) existingStars.push(i);
    }

    const seen = new Map(); // "targets|bar cells" already claimed by an earlier fact
    // { axis, lineIdx, barLen, hint } per surviving fact -- one row-pair/
    // column-pair band can produce several valid bar/tile splits (see
    // _tileBarFactsImpl's barStart/barEnd search), which read as redundant
    // near-duplicate hints once shown together. Collected here so only the
    // widest bar per band gets kept, below.
    const candidates = [];
    for (const { axis, lineIdx, tiles, barCells, need } of this._tileBarFacts()) {
      const { prefix, suffix } = this._tileBarPrefixSuffix(barCells, existingStars);
      const baseMax = prefix[barCells.length];
      if (baseMax < need) continue; // shouldn't happen on a consistent board; guard anyway

      const barSet = new Set(barCells);
      // For each outside candidate, the contiguous [lo, hi] range of
      // barCells indices it touches (a candidate not on the bar can only
      // neighbor a contiguous run of it -- see _tileBarPrefixSuffix's
      // own comment above).
      const candidateRange = new Map();
      barCells.forEach((cell, i) => {
        for (const nb of this.getNeighbors(cell)) {
          if (this.vState(nb) === CELL.NONE && !barSet.has(nb)) {
            const r = candidateRange.get(nb);
            if (!r) candidateRange.set(nb, [i, i]);
            else {
              if (i < r[0]) r[0] = i;
              if (i > r[1]) r[1] = i;
            }
          }
        }
      });

      const targets = [...candidateRange.entries()]
        .filter(([, [lo, hi]]) => prefix[lo] + suffix[hi + 1] < need)
        .map(([cand]) => cand);
      if (targets.length === 0) continue;

      targets.sort((a, b) => a - b);
      const key = this._groupKey(targets) + '|' + this._groupKey(barCells);
      if (seen.has(key)) continue;
      seen.set(key, true);

      const lineWord = axis === 'row' ? 'row' : 'column';
      const barWord = barCells.length === 1 ? 'cell' : 'cells';

      candidates.push({
        axis, lineIdx, barLen: barCells.length,
        hint: {
          boardIdx: undefined,
          description: `The ${tiles.length} tile${tiles.length === 1 ? '' : 's'} provide${tiles.length === 1 ? 's' : ''} at most ${tiles.length} star${tiles.length === 1 ? '' : 's'} to this ${lineWord} pair, so the ${barCells.length} highlighted ${barWord} must provide at least ${need} star${need === 1 ? '' : 's'}.`,
          // The bar's own cells, filled (board-agnostic, so on every
          // board). Never overlaps `targets`, which are all off the bar.
          highlights: barCells.map(idx => ({ idx, color: HINT_COLOR.SOURCE })),
          marks: targets.map(idx => ({ idx, color: HINT_COLOR.TARGET })),
          // Index 0 (blue), matching every other tile hint's single-
          // covering case -- hints display one at a time, so there's never
          // a second concurrent covering here needing a distinct color the
          // way _colorSlotsForTiles exists for (rule 3's combined case).
          tileOutlines: tiles.map(t => ({ topLeftIdx: t.topLeftIdx, color: TILE_OUTLINE_COLORS[0] })),
        },
      });
    }

    // Keep only the widest-bar candidate per (axis, lineIdx) band. A
    // narrower bar for the same band is a weaker version of the exact same
    // argument (fewer blue cells forced to carry the same or a smaller
    // "at least" count), so once the widest one is shown the rest add
    // nothing -- they were reading as near-duplicate hints on the same
    // board state.
    const bestByBand = new Map();
    for (const c of candidates) {
      const bandKey = `${c.axis}|${c.lineIdx}`;
      const existing = bestByBand.get(bandKey);
      if (!existing || c.barLen > existing.barLen) bestByBand.set(bandKey, c);
    }
    const hints = [...bestByBand.values()].map(c => c.hint);

    if (hints.length === 0) return null;
    hints.sort((a, b) => a.marks[0].idx - b.marks[0].idx);
    return hints;
  };

  // Windows of N adjacent rows/cols for lo <= N < hi (hi=Infinity -> up to
  // the board size). 4-5 is Hard (unitRegionSyncMulti4To5); 6 or more is
  // Expert (unitRegionSyncMulti6Plus).
  p._hintMultiRegionSyncRange = function (lo, hi) {
    const candidates = [];
    for (let n = lo; n < Math.min(hi, this.n); n++) {
      for (const axis of ["Row", "Column"]) {
        candidates.push(...this._hintMultiWindowRegionSyncAll(n, axis));
      }
    }
    return candidates.length > 0 ? candidates : null;
  };

  p._getMultiStarRuleList = function () {
    return [
      // Error validation
      { key: 'checkForErrors',                 fn: () => this.hintCheckForErrors() },
      { key: 'alreadySolved',                  fn: () => this.hintAlreadySolved() },
      // Beginner
      { key: 'onlyEmpty',                      fn: () => this.hintOnlyEmpty() },
      { key: 'excludeAdjacency',               fn: () => this.hintExcludeAdjacency() },
      { key: 'excludeSolvedUnit',              fn: () => this.hintExcludeSolvedUnit() },
      // Region tiles (see "Region tiles on their own"): the tile-shaped version
      // of the next rule(s), tried first at the same tier and score.
      { key: 'regionTileStar',                 fn: () => this.hintRegionTileStar() },
      { key: 'lineTileStar',                   fn: () => this.hintLineTileStar() },
      { key: 'unitPlacementForcedWeakAll',     fn: () => this.hintUnitPlacementForced('weak', 'all_stars') },
      { key: 'unitPlacementForcedWeakAny',     fn: () => this.hintUnitPlacementForced('weak', 'any_star') },
      // 'dots' covers both inside-the-unit and outside-the-unit forced dots --
      // see hintUnitPlacementForced's comment for the unified reasoning.
      { key: 'regionTileDots',                 fn: () => this.hintRegionTileDots() },
      { key: 'lineTileDots',                   fn: () => this.hintLineTileDots() },
      { key: 'unitPlacementForcedWeakDots',    fn: () => this.hintUnitPlacementForced('weak', 'dots') },
      // Moved here from Medium (multi-star-rules-experiment).
      { key: 'unitRegionSyncMulti1',           fn: () => this.hintUnitRegionSyncMulti(1) },
      // Medium
      { key: 'unitRegionSyncMulti2',           fn: () => this.hintUnitRegionSyncMulti(2) },
      // Reused directly from applySingleStarRules -- copying a known
      // star/dot to its symmetric counterpart doesn't depend on
      // starsPerGroup, so no multi-star variant is needed.
      { key: 'symmetryFillMulti',              fn: () => this.hintSymmetryFill() },
      // Region/line quota fill (see the section comment above
      // hintRegionLineQuotaFill). weak/intermediate/strong track one tier
      // above the matching unitPlacementForced level, since this rule needs
      // a placement-forced fact PLUS a cross-region quota argument on top.
      { key: 'regionLineQuotaFillWeak',        fn: () => this.hintRegionLineQuotaFill('weak') },
      // Region/line partition trap (see the section comment above
      // hintRegionLinePartitionTrapped) -- a sibling of regionLineQuotaFill
      // built on the same per-region completion tally, just reasoning
      // about the guaranteed-inside/outside-the-line counts on their own
      // instead of summing them across regions. Slotted at the same tier
      // as its regionLineQuotaFill counterpart, not one above, since it
      // doesn't need regionLineQuotaFill's extra cross-region subset-sum
      // step. The forced-star variant (see the section comment above
      // hintRegionLinePartitionForced) runs first at each tier, same as
      // unitPlacementForced's 'all_stars' running before 'any_star'/'dots'
      // -- confirming a star outright is a bigger win than excluding one.
      { key: 'regionLinePartitionForcedWeak',      fn: () => this.hintRegionLinePartitionForced('weak') },
      { key: 'regionLinePartitionTrappedWeak',     fn: () => this.hintRegionLinePartitionTrapped('weak') },
      // Region tiles from ONE board inside one row/column fill its quota
      // (see _regionTileLineFillHints) -- last in Medium. The cross-board
      // version is in Hard, after regionSubsetHard.
      { key: 'regionTileLineFill',             fn: () => this.hintRegionTileLineFill() },
      // Hard
      // Tiles rule 1 (see the "Tiles" section comment above hintTileSingleEmpty)
      // -- moved here from the start of Medium: a confirmed tile down to its
      // last empty cell is a simple, mechanical deduction, but still needs
      // spotting a tiling in the first place, which belongs a tier above the
      // plain unit/region reasoning that makes up Medium.
      { key: 'tileSingleEmpty',                fn: () => this.hintTileSingleEmpty() },
      // The 'intermediate' triple, reunited: this generation's own weak/
      // strong triples both stay together (all three of a level's
      // all/any/dots variants in the same tier), so intermediate's
      // all_stars variant belongs here with its any_star/dots siblings too
      // -- not a tier down in Medium, which it was splitting off from for
      // no documented reason. The real cost of this rule is the
      // enumeration itself (every valid completion, aware of every other
      // unit's remaining capacity on this board); once that's done,
      // reading off "always included" vs "always excluded" are equally
      // easy conclusions, so there's no basis for putting one a tier
      // below the other two.
      { key: 'unitPlacementForcedIntermediateAll',  fn: () => this.hintUnitPlacementForced('intermediate', 'all_stars') },
      { key: 'unitPlacementForcedIntermediateAny',  fn: () => this.hintUnitPlacementForced('intermediate', 'any_star') },
      { key: 'unitPlacementForcedIntermediateDots', fn: () => this.hintUnitPlacementForced('intermediate', 'dots') },
      { key: 'unitRegionSyncMulti3',           fn: () => this.hintUnitRegionSyncMulti(3) },
      { key: 'tileTwoEmptyDot',                fn: () => this.hintTileTwoEmptyDot() },
      // Region subset, by capacity: a region needing K stars sits inside a
      // region needing K stars (any K). See hintRegionSubsetHard in
      // solver-rules-common.js; the Expert version (pairs of regions) is below.
      { key: 'regionSubsetHard',               fn: () => this.hintRegionSubsetHard() },
      // Same as regionTileLineFill (Medium), but the K disjoint region tiles
      // may come from both boards' regions.
      { key: 'regionTileLineFillCross',        fn: () => this.hintRegionTileLineFillCross() },
      // Tile-quota-fill's K=1 special case: a single confirmed tile already
      // covers a unit's whole remaining need. See tileDisjointQuotaFill
      // (Expert) for K>1. Deliberately AFTER regionSubsetHard: when a tile is
      // a whole region's empties this is just that rule restated in tile
      // language, and the subset wording is the one a player would actually
      // notice.
      { key: 'tileQuotaFillSingle',            fn: () => this.hintTileQuotaFillSingle() },
      { key: 'regionLineQuotaFillIntermediate', fn: () => this.hintRegionLineQuotaFill('intermediate') },
      { key: 'regionLinePartitionForcedIntermediate', fn: () => this.hintRegionLinePartitionForced('intermediate') },
      { key: 'regionLinePartitionTrappedIntermediate', fn: () => this.hintRegionLinePartitionTrapped('intermediate') },
      { key: 'unitRegionSyncMulti4To5',      fn: () => this._hintMultiRegionSyncRange(4, 6) },
      // Restored from pre-experiment (see the section comment above
      // hintUnitCompletionSatisfiesOtherUnit).
      { key: 'unitCompletionSatisfiesOtherUnitIntermediate', fn: () => this.hintUnitCompletionSatisfiesOtherUnit('intermediate') },
      // 2★+ generalization of tileSeesTooMuch -- see the section comment
      // above hintTileSeesTooMuchMulti. Toward the end of Hard: it needs
      // the same tile-spotting as tileSingleEmpty/tileTwoEmptyDot (start
      // of Hard) PLUS a per-candidate line-completion check on top.
      { key: 'tileSeesTooMuchMulti',           fn: () => this.hintTileSeesTooMuchMulti() },
      // Symmetry - requires insight but not hard to apply
      { key: 'symmetryDeductionMulti',         fn: () => this.hintSymmetryDeductionMulti() },
      // Expert
      // 6 or more adjacent rows/cols: the long-window tail of
      // unitRegionSyncMulti4To5 (Hard), easiest end of Expert.
      { key: 'unitRegionSyncMulti6Plus',      fn: () => this._hintMultiRegionSyncRange(6, Infinity) },
      // Cross-board N-regions-pin-N-rows/cols: generalizes the 1★-only
      // hintCrossBoardRegionPinned to any starsPerGroup. Always genuinely
      // cross-board (see hintCrossBoardRegionPinnedMulti's comment). The
      // 2-region case opens Expert; the 3-region case sits later (after
      // tilePairQuotaFill). The two swapped positions: 60ef66b had
      // promoted the 3-region case here, leaving the strictly simpler
      // 2-region case behind it. 1★'s matching order sits at the same
      // spots in its own list.
      { key: 'crossBoardPinnedMulti2Row',      fn: () => this.hintCrossBoardRegionPinnedMulti(2, "Row") },
      { key: 'crossBoardPinnedMulti2Col',      fn: () => this.hintCrossBoardRegionPinnedMulti(2, "Column") },
      // The full (cross-board) strong variants: a deduction here may
      // require combining BOTH boards' region layouts, unlike the
      // Medium/Hard intermediate variants above, which only ever need one
      // board's information at a time.
      { key: 'unitPlacementForcedStrongAll',   fn: () => this.hintUnitPlacementForced('strong', 'all_stars') },
      { key: 'unitPlacementForcedStrongAny',   fn: () => this.hintUnitPlacementForced('strong', 'any_star') },
      { key: 'unitPlacementForcedStrongDots',  fn: () => this.hintUnitPlacementForced('strong', 'dots') },
      // Tiles rule 4 (see the section comment above hintTileBarTrapped) --
      // needs a genuinely incomplete tiling (a band _confirmedTilesImpl
      // gives up on entirely) to have anything to say. Moved earlier in
      // Expert (was after tileDisjointQuotaFill) per a manual scoring
      // reorder -- matches Python's composite_scorer.py.
      { key: 'tileBarTrapped',                 fn: () => this.hintTileBarTrapped() },
      // 1★ counterpart (hintPartialOverlap, solver-rules-single.js) sits
      // early in Expert there too; see the section comment above
      // hintCrossBoardPartialOverlapMulti for the starsPerGroup-agnostic
      // algebra behind it.
      { key: 'crossBoardPartialOverlapMulti',  fn: () => this.hintCrossBoardPartialOverlapMulti() },
      // Tiles rule 3.
      { key: 'tileDisjointQuotaFill',          fn: () => this.hintTileDisjointQuotaFill() },
      { key: 'regionLineQuotaFillStrong',      fn: () => this.hintRegionLineQuotaFill('strong') },
      { key: 'regionLinePartitionForcedStrong',    fn: () => this.hintRegionLinePartitionForced('strong') },
      { key: 'regionLinePartitionTrappedStrong',   fn: () => this.hintRegionLinePartitionTrapped('strong') },
      // Restored from pre-experiment.
      { key: 'unitCompletionSatisfiesOtherUnitStrong', fn: () => this.hintUnitCompletionSatisfiesOtherUnit('strong') },
      { key: 'disjointUnitRegionSyncMulti2',   fn: () => this.hintDisjointUnitRegionSyncMulti(2) },
      // Tiles rule 4 -- see the section comment above hintTilePairQuotaFill.
      // Moved here (was the very start of Expert) per a manual scoring
      // reorder -- matches Python's composite_scorer.py.
      { key: 'tilePairQuotaFill',              fn: () => this.hintTilePairQuotaFill() },
      // Cross-board pin, 3-region case -- see the 2-region case at the
      // start of Expert.
      { key: 'crossBoardPinnedMulti3Row',      fn: () => this.hintCrossBoardRegionPinnedMulti(3, "Row") },
      { key: 'crossBoardPinnedMulti3Col',      fn: () => this.hintCrossBoardRegionPinnedMulti(3, "Column") },
      // A region or PAIR of regions needing K stars inside another region or
      // pair needing K stars (at least one side a pair; groups of 3+ regions
      // aren't considered). See hintRegionSubsetExpert in solver-rules-common.js.
      { key: 'regionSubsetExpert',             fn: () => this.hintRegionSubsetExpert() },
      // Region algebra, then the region-pair hybrid enumeration -- see the
      // section comments above hintRegionAlgebra/hintRegionPairPlacementForced
      // in solver-rules-common.js.
      { key: 'regionAlgebra',                  fn: () => this.hintRegionAlgebra() },
      { key: 'regionPairPlacementForced',      fn: () => this.hintRegionPairPlacementForced() },
      { key: 'lookaheadDotsSingleBoard',       fn: () => this.hintLookaheadDotsSingleBoard() },
      // Grandmaster
      // Cross-board region/line quota fill + partition forced -- see the
      // section comment above hintCrossBoardRegionLineQuotaFill. Genuinely
      // cross-board only (same-board matches are already caught by the
      // Expert-tier regionLineQuotaFillStrong/regionLinePartitionForcedStrong
      // above), so this is strictly additional reasoning, not a duplicate
      // of those. Forced-star runs first, same convention as every other
      // weak/any/dots-style pairing in this list. Matches Python's
      // rule_crossboard_region_line_partition_forced/
      // rule_crossboard_region_line_quota_fill in rules_multi_star.py --
      // unlike the N-stage lookahead rules below, these are bounded by the
      // (small) number of regions touching one line, not a full board
      // sweep, so they stay enabled here.
      { key: 'crossBoardRegionLinePartitionForced', fn: () => this.hintCrossBoardRegionLinePartitionForced() },
      { key: 'crossBoardRegionLineQuotaFill',        fn: () => this.hintCrossBoardRegionLineQuotaFill() },
      // Tiles rule 4b -- see the section comment above hintTilePairQuotaFill.
      // The 3-or-more-tile generalization of hintTilePairQuotaFill
      // (Expert, above). Not cross-board -- slotted after the two
      // cross-board rules above purely by convention (every other
      // Grandmaster entry here is cross-board-only), not because it
      // depends on them. Matches Python's rule_tile_pair_quota_fill_
      // grandmaster in rules_multi_star.py.
      { key: 'tilePairQuotaFillGrandmaster',   fn: () => this.hintTilePairQuotaFillGrandmaster() },
      // Cross-board lookahead-dots: moved here (was Expert, right after
      // lookaheadDotsSingleBoard) to match Python's identical reorder --
      // see the comment above rule_lookahead_dots in composite_scorer.py.
      // Same cheap one-round speculative placement as lookaheadDotsSingleBoard
      // above, but the contradiction only shows up by combining two
      // different regions' remaining quotas across BOTH boards after
      // committing to the hypothetical star -- too much to track by hand
      // at Expert.
      { key: 'lookaheadDots',                  fn: () => this.hintLookaheadDots() },
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
