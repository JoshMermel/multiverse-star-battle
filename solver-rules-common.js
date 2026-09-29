import { CELL, HINT_COLOR, HINT_SOURCE_VARIANTS } from './constants.js';

// Rules referenced, by the exact same underlying function, in both the
// single-star and multi-star rule lists: error/already-solved checks,
// onlyEmpty/excludeAdjacency/excludeSolvedUnit, hintRegionSubsetSync (used
// at different K by each family), hintRowColLineSync (used at different N by
// each family), hintFromSolution, and hintLookahead (used at different stage
// counts by each family). See solver-rules-single.js / solver-rules-multi.js
// for the rules unique to each star-count family.
export function applyCommonSolverRules(PuzzleSolver) {
  const p = PuzzleSolver.prototype;

  p.hintCheckForErrors = function () {
    const n = this.n;
    const highlights = [];

    for (let i = 0; i < n * n; i++) {
      // A star on a void cell is always wrong, even if this.game.state
      // hasn't been reconciled with voidIndices for this cell.
      const isWrong = (this.game.state[i] === CELL.STAR && (this.game.solution[i] !== 'x' || this.voidIndices.has(i)))
        || (this.game.state[i] === CELL.DOT  && this.game.solution[i] === 'x' && !this.voidIndices.has(i));
      if (isWrong) highlights.push({ idx: i, color: HINT_COLOR.ERROR });
    }

    if (highlights.length > 0) {
      return [{
        description: "Can't provide a hint, fix the errors marked in red first",
        highlights,
        marks: [],
        boardIdx: undefined
      }];
    }

    return null;
  };

  // Rule: Check if the puzzle is already solved.
  p.hintAlreadySolved = function () {
    // vState (not raw state) so void cells, which always read as DOT,
    // compare correctly against the solution.
    const isSolved = this.game.state.every((v, i) =>
      (this.game.solution[i] === 'x') ? this.vState(i) === CELL.STAR : this.vState(i) !== CELL.STAR
    );
    if (!isSolved) return null;

    return [{
      description: "The puzzle is already solved!",
      highlights: [],
      marks: [],
      boardIdx: undefined
    }];
  };

  // Rule: Check for units where empty cells equal the remaining needed stars.
  p.hintOnlyEmpty = function () {
    const starsPerGroup = this.starsPerGroup || 1;
    const candidates = [];
    for (const unit of this.units) {
      const empty = unit.indices.filter(i => this.vState(i) === CELL.NONE);
      const stars = unit.indices.filter(i => this.vState(i) === CELL.STAR);
      const needed = starsPerGroup - stars.length;
      if (needed > 0 && empty.length === needed) {
        candidates.push({ unit, empty });
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.unit.indices[0] - b.unit.indices[0]);
    return candidates.map(({ unit, empty }) => {
      const unitType = this._unitKind(unit);
      const description = starsPerGroup === 1
        ? `Only one spot is left for a star in this ${unitType}.`
        : `Exactly ${empty.length} spots are left for the remaining stars in this ${unitType}.`;
      return {
        description,
        highlights: [],
        marks: empty.map(idx => ({ idx, color: HINT_COLOR.TARGET_STAR })),
        boardIdx: unit.boardIdx,
        // Outline the unit's own full shape/boundary for the player --
        // a row/column outlines board-agnostically (see _outlineEntriesFor),
        // a region only on its own board.
        regionOutlines: this._outlineEntriesFor(unit, 'blue'),
      };
    });
  };

  // Rule: Check for units that already have all their stars placed.
  p.hintExcludeSolvedUnit = function () {
    const starsPerGroup = this.starsPerGroup || 1;
    const typeDescs = {
      row: starsPerGroup === 1 ? "This row already has its star." : `This row already has its ${starsPerGroup} stars.`,
      column: starsPerGroup === 1 ? "This column already has its star." : `This column already has its ${starsPerGroup} stars.`,
      region: starsPerGroup === 1 ? "This region already has its star." : `This region already has its ${starsPerGroup} stars.`,
    };
    const candidates = [];
    for (const unit of this.units) {
      const stars = unit.indices.filter(idx => this.vState(idx) === CELL.STAR);
      const empty = unit.indices.filter(idx => this.vState(idx) === CELL.NONE);
      if (stars.length >= starsPerGroup && empty.length > 0) candidates.push(unit);
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.indices[0] - b.indices[0]);
    return candidates.map(unit => {
      const key = this._unitKind(unit);
      const empty = unit.indices.filter(idx => this.vState(idx) === CELL.NONE);
      return {
        description: typeDescs[key],
        highlights: [],
        marks: empty.map(idx => ({ idx, color: HINT_COLOR.TARGET })),
        boardIdx: unit.boardIdx ?? undefined,
        // Outline the unit's own full shape/boundary -- same reasoning as
        // hintOnlyEmpty above.
        regionOutlines: this._outlineEntriesFor(unit, 'blue'),
      };
    });
  };

  // Rule: Check for empty cells adjacent to placed stars.
  p.hintExcludeAdjacency = function () {
    const candidates = [];
    for (let i = 0; i < this.n * this.n; i++) {
      if (this.vState(i) !== CELL.STAR) continue;
      const marks = this.getNeighbors(i)
        .filter(nb => this.vState(nb) === CELL.NONE)
        .map(nb => ({ idx: nb, color: HINT_COLOR.TARGET }));
      if (marks.length > 0) candidates.push({ i, marks });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.i - b.i);
    return candidates.map(({ i, marks }) => ({
      description: "Stars cannot touch each other.",
      highlights: [{ idx: i, color: HINT_COLOR.SOURCE }],
      marks,
      boardIdx: undefined
    }));
  };

  // Rule: Identify subsets where regions are nested within others.
  // Build region combos (per board) whose TOTAL remaining star need sums to exactly K.
  // Unlike a plain "N regions" combo (which implicitly assumed 1 star per region),
  // this also picks up partially-solved regions (e.g. a region needing exactly 1 more
  // star) and lets different-sized combos be compared against each other -- e.g. one
  // region needing 2 stars vs two different regions each needing 1.
  p._buildRegionNeedComboSets = function (K) {
    const comboSets = [];

    for (const bIdx of this.boardIndices) {
      const needing = this.getRegionsNeedingStars(bIdx);

      // A combo's size can never exceed K, since every member needs >= 1 star.
      for (let size = 1; size <= K; size++) {
        for (const combo of this.getCombinations(needing, size)) {
          const total = combo.reduce((sum, e) => sum + e.remaining, 0);
          if (total !== K) continue;

          const regions = combo.map(e => e.region);
          comboSets.push({
            label: `Board ${bIdx + 1} Combo (${regions.map(r => r.label.split(' ').pop()).join(',')})`,
            indices: new Set(regions.flatMap(r => r.indices.filter(i => this.vState(i) === CELL.NONE))),
            boardIdx: bIdx,
            regions
          });
        }
      }
    }

    return comboSets;
  };

  p.hintRegionSubsetSync = function (K) {
    const comboSets = this._buildRegionNeedComboSets(K);

    const candidates = [];
    for (let i = 0; i < comboSets.length; i++) {
      for (let j = 0; j < comboSets.length; j++) {
        if (i === j) continue;

        const setA = comboSets[i];
        const setB = comboSets[j];

        const isSubset = Array.from(setA.indices).every(idx => setB.indices.has(idx));
        if (!isSubset) continue;

        const targets = Array.from(setB.indices)
          .filter(idx => !setA.indices.has(idx) && this.vState(idx) === CELL.NONE);

        if (targets.length > 0) candidates.push({ setA, setB, targets });
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (a.targets[0] ?? 0) - (b.targets[0] ?? 0));
    return candidates.map(({ setA, setB, targets }) =>
      this.formatSubsetHint(setA.regions, setB.regions, targets, setA.boardIdx, setB.boardIdx));
  };

  p.hintFromSolution = function () {
    const n = this.n;
    const candidates = [];
    for (let i = 0; i < n * n; i++) {
      if (this.game.solution[i] !== 'x' && this.vState(i) === CELL.NONE) {
        candidates.push(i);
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a - b);
    return candidates.map(idx => ({
      description: "No logical hint was found. Here's a nudge from the solution.",
      highlights: [],
      marks: [{ idx, color: HINT_COLOR.TARGET }],
      boardIdx: undefined
    }));
  };

  // Check "N rows/cols whose empties are confined to units of the other axis whose
  // combined remaining room exactly matches what's still needed" deduction. This is the
  // cross-axis analogue of _hintRegionsTrappedInUnits: instead of trapping N rows/cols
  // inside N regions, it traps N rows inside columns directly, with no region
  // information involved at all -- works identically on regular and irregular boards
  // (moved here from solver-rules-single.js: originally 1★-only, now generalized to any
  // starsPerGroup so both star-count families share the exact same function).
  //
  // For starsPerGroup === 1, every other-axis unit a window's empty cells touch always
  // has exactly 1 cell of remaining room (a unit already at quota has no empty cell left
  // to touch in the first place) -- so requiredCount ends up equal to the touched-unit
  // COUNT, which is what this checked before generalizing. For starsPerGroup > 1 that
  // stops being guaranteed (a touched column might still have room for 2+ stars), so the
  // real invariant is the touched units' TOTAL remaining room, not just how many there are.
  p._hintAxisLineTrapped = function (unitCombo, axisLabel) {
    const n = this.n;
    const quota = this.starsPerGroup;
    const otherAxisLabel = axisLabel === "Row" ? "Column" : "Row";
    const otherAxisIndices = this.axisIndices[otherAxisLabel];

    const windowIndices = unitCombo.flat();
    const windowSet = new Set(windowIndices);

    const starsInWindow = windowIndices.filter(i => this.vState(i) === CELL.STAR).length;
    const requiredCount = unitCombo.length * quota - starsInWindow;
    if (requiredCount <= 0) return null;

    const availInUnits = windowIndices.filter(i => this.vState(i) === CELL.NONE);
    if (availInUnits.length === 0) return null;

    // Which units of the OTHER axis do these empty cells actually touch?
    const touchedOther = new Set(
      availInUnits.map(i => axisLabel === "Row" ? i % n : Math.floor(i / n))
    );

    let otherRemaining = 0;
    for (const otherIdx of touchedOther) {
      const otherStars = otherAxisIndices[otherIdx].filter(i => this.vState(i) === CELL.STAR).length;
      otherRemaining += quota - otherStars;
    }
    if (otherRemaining !== requiredCount) return null;

    // Every other-axis unit touched is now "used up" by this window — any of its empty
    // cells outside the window can no longer hold a star.
    const targets = [];
    for (const otherIdx of touchedOther) {
      for (const idx of otherAxisIndices[otherIdx]) {
        if (!windowSet.has(idx) && this.vState(idx) === CELL.NONE) targets.push(idx);
      }
    }
    if (targets.length === 0) return null;

    const N = unitCombo.length;
    const axisWord = axisLabel.toLowerCase();
    const otherWord = otherAxisLabel.toLowerCase();
    const unitsPhrase = N === 1 ? `this ${axisWord}` : `these ${N} ${axisWord}s`;
    const otherCount = touchedOther.size;
    const otherPhrase = otherCount === 1 ? otherWord : `${otherWord}s`;
    const thoseWord = otherCount === 1 ? 'that' : 'those';

    // Identical wording to before this generalized (requiredCount === otherCount is the
    // starsPerGroup === 1 case, and still the common case at higher quotas too) -- only
    // reaches for the more explicit "combined room" phrasing when that's no longer exact
    // enough to describe accurately (a touched unit whose own remaining need is > 1).
    const description = requiredCount === otherCount
      ? `All empty cells in ${unitsPhrase} fall within ${otherCount} ${otherPhrase}, so the rest of ${thoseWord} ${otherPhrase} must be dots.`
      : `All empty cells in ${unitsPhrase} fall within ${otherCount} ${otherPhrase}, whose remaining room adds up to exactly ${requiredCount} star${requiredCount === 1 ? '' : 's'} -- so the rest of ${thoseWord} ${otherPhrase} must be dots.`;

    return {
      boardIdx: undefined,
      description,
      // The trapping lines' own empty cells -- each one already known (by
      // construction) to fall within one of the touched other-axis units.
      // Filled in addition to the outline since the outlined lines are the
      // WHOLE row/column, not just this subset.
      highlights: availInUnits.map(idx => ({ idx, color: HINT_COLOR.SOURCE })),
      marks: targets.map(idx => ({ idx, color: HINT_COLOR.TARGET })),
      // Outline the trapping rows/columns' full shape -- board-agnostic, so
      // it's drawn on every board -- same treatment as the region-based
      // sibling rules (_hintRegionsTrappedInUnits/_hintMultiRegionsTrappedInUnits).
      // One entry per board with every line's cells unioned together (not
      // per-line) so non-adjacent lines still split into separate contours
      // automatically, same as those siblings' own combo.flatMap pattern.
      regionOutlines: this.boardIndices.map(boardIdx => ({ indices: unitCombo.flat(), color: 'blue', boardIdx })),
    };
  };

  // Find all row<->column line-sync hints for a window size of N.
  p._hintAxisLineSyncAll = function (N, axis) {
    const n = this.n;
    const quota = this.starsPerGroup;
    const axisIndices = this.axisIndices[axis];

    // Units still short of quota -- for starsPerGroup === 1 that's exactly "no star yet"
    // (the previous, 1★-only condition this generalizes).
    const unsaturatedUnitIndices = Array.from({ length: n }, (_, i) => i)
      .filter(u => axisIndices[u].filter(i => this.vState(i) === CELL.STAR).length < quota);

    const candidates = [];
    for (const combo of this.getCombinations(unsaturatedUnitIndices, N)) {
      const unitCombo = combo.map(u => axisIndices[u]);
      const hint = this._hintAxisLineTrapped(unitCombo, axis);
      if (hint) candidates.push(hint);
    }
    return candidates;
  };

  // Rule: N rows (or N columns) whose empty cells are confined to units of the other axis
  // with just enough combined room for what's needed — no region information needed,
  // works identically on regular and irregular (including regionless) boards, at any
  // starsPerGroup. Used at different N by each star-count family's rule list.
  p.hintRowColLineSync = function (N) {
    const candidates = [];
    for (const axis of ["Row", "Column"]) {
      candidates.push(...this._hintAxisLineSyncAll(N, axis));
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (a.highlights[0]?.idx ?? a.marks[0]?.idx ?? 0) - (b.highlights[0]?.idx ?? b.marks[0]?.idx ?? 0));
    return candidates;
  };

  // -- Region-pair placement forced (1★ AND 2★+, Expert) ------------------
  //
  // hintUnitPlacementForced's weak (adjacency-only) enumeration applied to a
  // synthetic "hybrid region": the union of two unfinished regions on the
  // same board that share at least one orthogonal edge, needing both
  // regions' combined remaining stars. Pure union -- each region's own quota
  // is deliberately NOT enforced, so a placement may put all of the pair's
  // stars in one of the two regions. A cell in no placement, or a cell just
  // outside the union touching a star of every placement, is a dot; a cell
  // in every placement is a star. Single-board only, never cross-board.
  // Pairs whose enumeration would exceed ENUMERATION_COMBO_CAP are skipped.
  // Python port: rule_region_pair_placement_forced in rules_common.py.
  p._touchingRegionPairs = function () {
    if (this._touchingRegionPairsCache) return this._touchingRegionPairsCache;
    const n = this.n;
    const pairs = [];
    const regionsByBoard = new Map();
    for (const u of this.units) {
      if (u.boardIdx === undefined) continue;
      if (!regionsByBoard.has(u.boardIdx)) regionsByBoard.set(u.boardIdx, []);
      regionsByBoard.get(u.boardIdx).push(u);
    }
    for (const [boardIdx, regions] of regionsByBoard) {
      const owner = new Map();
      for (const u of regions) for (const i of u.indices) owner.set(i, u);
      const seen = new Set();
      for (const [i, ua] of owner) {
        const r = Math.floor(i / n), c = i % n;
        const nbs = [];
        if (r + 1 < n) nbs.push(i + n);
        if (c + 1 < n) nbs.push(i + 1);
        for (const j of nbs) {
          const ub = owner.get(j);
          if (!ub || ub === ua) continue;
          const [a, b] = ua.indices[0] < ub.indices[0] ? [ua, ub] : [ub, ua];
          const key = `${a.label}|${b.label}`;
          if (seen.has(key)) continue;
          seen.add(key);
          pairs.push({ a, b, boardIdx });
        }
      }
    }
    this._touchingRegionPairsCache = pairs;
    return pairs;
  };

  // Weak enumeration depends only on the union's own cells, so it's cached on
  // exactly that state and survives across moves elsewhere on the board --
  // most pairs are untouched by any single move. Cleared wholesale if it
  // grows large, since each entry can hold many combos.
  p._regionPairCombos = function (union) {
    if (!this._regionPairCombosCache || this._regionPairCombosCache.size > 5000) {
      this._regionPairCombosCache = new Map();
    }
    const key = `${union.label}|${union.indices.map(i => this.vState(i)).join(',')}`;
    let combos = this._regionPairCombosCache.get(key);
    if (combos === undefined) {
      combos = this._enumerateUnitCompletions(union, false, 2 * this.starsPerGroup);
      this._regionPairCombosCache.set(key, combos);
    }
    return combos;
  };

  p.hintRegionPairPlacementForced = function () {
    const hints = [];
    const pairs = this._touchingRegionPairs()
      .slice()
      .sort((x, y) => (x.a.indices[0] - y.a.indices[0]) || (x.b.indices[0] - y.b.indices[0]));
    for (const { a, b, boardIdx } of pairs) {
      const needA = this.starsPerGroup - a.indices.filter(i => this.vState(i) === CELL.STAR).length;
      const needB = this.starsPerGroup - b.indices.filter(i => this.vState(i) === CELL.STAR).length;
      if (needA <= 0 || needB <= 0) continue;

      const union = { indices: [...a.indices, ...b.indices], label: `${a.label}+${b.label}`, boardIdx };
      const combos = this._regionPairCombos(union);
      if (!combos || combos.length === 0) continue;

      const unionSet = new Set(union.indices);
      const avail = union.indices.filter(i => this.vState(i) === CELL.NONE);
      const outside = new Set();
      for (const cell of union.indices) {
        for (const nb of this.getNeighbors(cell)) {
          if (!unionSet.has(nb) && this.vState(nb) === CELL.NONE) outside.add(nb);
        }
      }
      const forcedStars = avail.filter(cell => combos.every(combo => combo.includes(cell)));
      const forcedDots = [
        ...avail.filter(cell => !combos.some(combo => combo.includes(cell))),
        ...[...outside].filter(cell => combos.every(combo => combo.some(s => this._cellsAdjacent(s, cell)))),
      ];
      if (forcedStars.length === 0 && forcedDots.length === 0) continue;

      const need = needA + needB;
      const shape = `these two touching regions as one combined region`;
      const starsWord = `its ${need} remaining non-touching star${need === 1 ? '' : 's'}`;
      const note = `(ignoring how they split between the two regions)`;
      // Prototype: outline the union (a and b touching, so they trace as
      // ONE seamless blue shape -- no shared-edge line between them, since
      // both are in the same outline entry) instead of filling its cells.
      // See renderer.js's _buildRegionOutlineSvg.
      const regionOutlines = [{ indices: union.indices, color: 'blue', boardIdx }];
      if (forcedStars.length > 0) {
        hints.push({
          description: `Treat ${shape} (outlined in blue). Every way to place ${starsWord} ${note} includes the marked cell${forcedStars.length === 1 ? ", so it's a star" : "s, so they're stars"}.`,
          highlights: [],
          marks: forcedStars.map(idx => ({ idx, color: HINT_COLOR.TARGET_STAR })),
          regionOutlines,
          boardIdx
        });
      }
      if (forcedDots.length > 0) {
        hints.push({
          description: `Treat ${shape} (outlined in blue). Every way to place ${starsWord} ${note} rules out a star at the marked cell${forcedDots.length === 1 ? ", so it's a dot" : "s, so they're dots"}.`,
          highlights: [],
          marks: forcedDots.map(idx => ({ idx, color: HINT_COLOR.TARGET })),
          regionOutlines,
          boardIdx
        });
      }
    }
    return hints.length > 0 ? hints : null;
  };

  // -- Region algebra (1★ AND 2★+, Expert) ---------------------------------
  //
  // Two DISJOINT units A, B -- each a row, a column, or a region (on any
  // board) -- jointly hold 2N stars. If some OTHER unit C (any row, column,
  // or region, other than A/B themselves) has all of its non-dot cells
  // inside A∪B (and reaches into both A and B), then all N of C's stars lie
  // in A∪B, so the remainder R = (A∪B) \ C holds exactly N stars. R is then
  // reasoned about like a region of its own:
  //  - R already has its N stars: every other open cell of R is a dot.
  //  - 1★: a cell outside R that sees (same row/column, or adjacent) every
  //    open cell of R is a dot; a lone open cell of R is a star.
  //  - 2★+: hintUnitPlacementForced's weak (adjacency-only) enumeration on R.
  // Shown as R in blue and C in brown, on whichever board(s) A/B/C actually
  // live on (see abBoards/marksOn below) -- a whole row/column is board-
  // agnostic and drawn wherever the rest of the hint is; a region is drawn
  // on its own board, plus (for C) wherever it overlaps A/B if that's a
  // different board.
  //
  // A/B used to be restricted to "two regions on one board" (with C then
  // required to be a row/column or a region on a DIFFERENT board, so it
  // wouldn't just be a third region of that same board). Generalized so A
  // and B can be any disjoint pair of units at all -- e.g. two rows, or a
  // row and a region -- which also means there's no longer a single "home
  // board" to exclude C from; C only has to be a different unit than A/B.
  //
  // Finding (A, B) by testing every disjoint PAIR of units up front doesn't
  // scale -- O(units^2 * units), measured at ~90ms/call on a 25x25/6★ board.
  // Instead this iterates C first, exactly like the original did (which
  // built a single-valued cell->region owner Map, since regions partition a
  // board): for C's FIRST live cell, try each unit touching it as A (a
  // cell's row, column, and one region per board -- a small, fixed list via
  // _unitsByCell, not a single owner anymore since a cell can belong to
  // several candidate units at once); then require every remaining live
  // cell to share one common OTHER unit, which must be B. That's the whole
  // candidate set for this C, found in time proportional to C's own cell
  // count rather than the total unit count -- measured at ~0.3ms/call on
  // the same 25x25/6★ board, matching the original's cost profile.
  // Python port: rule_region_algebra in rules_common.py.
  p.hintRegionAlgebra = function () {
    const n = this.n;
    const N = this.starsPerGroup;
    const starsText = N === 1 ? '1 star' : `${N} stars`;
    const hints = [];
    const sees = (a, b) => {
      const ra = Math.floor(a / n), ca = a % n, rb = Math.floor(b / n), cb = b % n;
      return ra === rb || ca === cb || (Math.abs(ra - rb) <= 1 && Math.abs(ca - cb) <= 1);
    };

    for (const cUnit of this.units) {
      const live = cUnit.indices.filter(i => this.vState(i) !== CELL.DOT);
      if (live.length < 2) continue;

      const firstCandidates = this._unitsByCell[live[0]].filter(u => u !== cUnit);
      for (const ua of firstCandidates) {
        const aSet = new Set(ua.indices);
        const remaining = live.slice(1).filter(i => !aSet.has(i));
        if (remaining.length === 0) continue; // B would never be touched

        let bCandidates = null;
        for (const i of remaining) {
          const cands = new Set(this._unitsByCell[i].filter(u => u !== cUnit && u !== ua));
          bCandidates = bCandidates === null ? cands : new Set([...bCandidates].filter(u => cands.has(u)));
          if (bCandidates.size === 0) break;
        }
        if (!bCandidates || bCandidates.size === 0) continue;

        for (const ub of bCandidates) {
          const bSet = new Set(ub.indices);
          if (ua.indices.some(i => bSet.has(i))) continue; // not disjoint

          const cSet = new Set(cUnit.indices);
          const rem = [...ua.indices, ...ub.indices].filter(i => !cSet.has(i));
          const have = rem.filter(i => this.vState(i) === CELL.STAR).length;
          const avail = rem.filter(i => this.vState(i) === CELL.NONE);
          if (avail.length === 0) continue;
          const remSet = new Set(rem);

          let forcedStars = [];
          let forcedDots = [];
          let why;
          if (have >= N) {
            forcedDots = avail;
            why = { dots: forcedDots.length === 1
              ? `The cyan-highlighted cells already have their ${starsText}, so the marked cell is a dot.`
              : `The cyan-highlighted cells already have their ${starsText}, so the marked cells are dots.` };
          } else if (N === 1) {
            if (avail.length === 1) forcedStars = avail;
            for (let i = 0; i < n * n; i++) {
              if (this.vState(i) === CELL.NONE && !remSet.has(i) && avail.every(c => sees(i, c))) forcedDots.push(i);
            }
            why = {
              // forcedStars is only ever populated when avail.length === 1,
              // so this branch is always singular.
              stars: `Only one cyan-highlighted cell is still open, so it's a star.`,
              dots: forcedDots.length === 1
                ? `A star at the marked cell would see every open cyan-highlighted cell, leaving them without their star, so it's a dot.`
                : `A star at any of the marked cells would see every open cyan-highlighted cell, leaving them without their star, so they're dots.`,
            };
          } else {
            const combos = this._enumerateUnitCompletions({ indices: rem, label: 'regionAlgebra' }, false, N);
            if (!combos || combos.length === 0) continue;
            const outside = new Set();
            for (const cell of rem) {
              for (const nb of this.getNeighbors(cell)) {
                if (!remSet.has(nb) && this.vState(nb) === CELL.NONE) outside.add(nb);
              }
            }
            forcedStars = avail.filter(cell => combos.every(combo => combo.includes(cell)));
            forcedDots = [
              ...avail.filter(cell => !combos.some(combo => combo.includes(cell))),
              ...[...outside].filter(cell => combos.every(combo => combo.some(s => this._cellsAdjacent(s, cell)))),
            ];
            why = {
              stars: forcedStars.length === 1
                ? `Every way to place ${N} non-touching stars in the cyan-highlighted cells includes the marked cell, so it's a star.`
                : `Every way to place ${N} non-touching stars in the cyan-highlighted cells includes the marked cells, so they're stars.`,
              dots: forcedDots.length === 1
                ? `Every way to place ${N} non-touching stars in the cyan-highlighted cells rules out a star at the marked cell, so it's a dot.`
                : `Every way to place ${N} non-touching stars in the cyan-highlighted cells rules out a star at the marked cells, so they're dots.`,
            };
          }
          if (forcedStars.length === 0 && forcedDots.length === 0) continue;

          // Outline A∪B -- the whole "region pair" -- in blue. C (the
          // thing "implied" to lie inside it) and R (= A∪B minus C, the
          // thing actually gaining an exact star count) each get their own
          // highlight-fill color instead of a second outline color: C can
          // sit deep inside A∪B, so its boundary and part of A∪B's own
          // boundary often run right alongside each other, and two
          // semi-transparent outline strokes doing that read as a blurry
          // mess rather than two distinct shapes. A fill has no boundary
          // of its own to compete with an outline's, so both read cleanly
          // nested inside it instead.
          //
          // A/B's cells are split by board the same way region shapes
          // always are: a region outlines on its own board; a row/column
          // (boardIdx undefined) outlines on every board. When A and B
          // share a board (including a row/col that expands onto it),
          // their indices are merged into ONE array for that board so
          // touching units still trace as a single seamless shape, same as
          // hintRegionPairPlacementForced's union.
          const pairByBoard = new Map();
          for (const unit of [ua, ub]) {
            const boards = unit.boardIdx !== undefined ? [unit.boardIdx] : this.boardIndices;
            for (const b of boards) {
              if (!pairByBoard.has(b)) pairByBoard.set(b, []);
              pairByBoard.get(b).push(...unit.indices);
            }
          }
          const regionOutlines = [...pairByBoard.entries()].map(([b, indices]) => ({ indices, color: 'blue', boardIdx: b }));

          // A region only has geometric meaning on its own board, but its
          // cells still exist (and still matter to this argument) on every
          // board -- highlight them everywhere so the relationship is
          // visible no matter which board the player is looking at. A
          // row/column already looks identical on every board, so
          // repeating its highlight on all of them is just noise -- show
          // it once, on whichever board the blue outline is itself
          // anchored to (a concrete region's board if either A or B is
          // one, else the lowest board index the outline actually
          // touches).
          const fallbackBoard = ua.boardIdx ?? ub.boardIdx ?? [...pairByBoard.keys()].sort((x, y) => x - y)[0];
          const cBoards = cUnit.boardIdx !== undefined ? this.boardIndices : [fallbackBoard];
          const cColor = HINT_SOURCE_VARIANTS[1]; // brown
          // C's cells minus dots (see `live` above) -- a dot isn't part of
          // the "C lies entirely inside A∪B" argument, so it isn't part of
          // what's highlighted either.
          const highlights = cBoards.flatMap(b => live.map(idx => ({ idx, color: cColor, boards: [b] })));

          // R gets the same per-cell board treatment as the blue outline
          // (each cell shown on its owning unit's board, or the same
          // fallback a row/col owner would use) -- just as a highlight
          // instead of a separate outline entry.
          const rColor = HINT_SOURCE_VARIANTS[2]; // cyan
          for (const idx of rem) {
            const owner = aSet.has(idx) ? ua : ub;
            const boards = owner.boardIdx !== undefined ? [owner.boardIdx] : [fallbackBoard];
            for (const b of boards) highlights.push({ idx, color: rColor, boards: [b] });
          }

          // Marked cells are board-agnostic facts; show them on every
          // board the outline or either highlight actually appears on.
          const allBoardsInvolved = new Set([...pairByBoard.keys(), ...cBoards, fallbackBoard]);
          const marksOn = [...allBoardsInvolved];
          const boardIdx = allBoardsInvolved.size === 1 ? marksOn[0] : undefined;

          const cName = cUnit.boardIdx !== undefined ? `the brown-highlighted region` : `${cUnit.label} (brown-highlighted)`;
          const intro = `Two units, outlined in blue, hold ${2 * N} stars together. `
            + `Apart from dotted cells, ${cName} lies entirely inside them and holds ${starsText}, `
            + `so the cyan-highlighted cells hold exactly ${starsText}. `;
          if (forcedStars.length > 0) {
            hints.push({
              description: intro + why.stars,
              highlights,
              marks: forcedStars.map(idx => ({ idx, color: HINT_COLOR.TARGET_STAR, boards: marksOn })),
              regionOutlines,
              boardIdx
            });
          }
          if (forcedDots.length > 0) {
            hints.push({
              description: intro + why.dots,
              highlights,
              marks: forcedDots.map(idx => ({ idx, color: HINT_COLOR.TARGET, boards: marksOn })),
              regionOutlines,
              boardIdx
            });
          }
        }
      }
    }
    return hints.length > 0 ? hints : null;
  };

  // Rule: Multi-stage lookahead for contradiction checking.
  p.hintLookahead = function (nStages) {
    const candidates = [];

    const emptyIndices = this.game.state
      .flatMap((val, idx) => this.vState(idx) === CELL.NONE ? [idx] : []);

    for (const testIdx of emptyIndices) {
      const sandboxState = this._buildSpeculativeState(testIdx);

      let broken = false;
      for (let i = 0; i < nStages; i++) {
        this._applySimulatedRules(sandboxState);
        if (this._isBoardBroken(sandboxState)) {
          broken = true;
          break;
        }
      }

      if (broken) candidates.push(testIdx);
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a - b);
    return candidates.map(testIdx => ({
      boardIdx: undefined,
      description: `Placing a star here would make the puzzle unsolvable (takes some lookahead to see why).`,
      highlights: [],
      marks: [{ idx: testIdx, color: HINT_COLOR.TARGET }]
    }));
  };
}
