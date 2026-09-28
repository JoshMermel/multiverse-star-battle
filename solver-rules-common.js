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
        // Every already-resolved cell of the unit (dots AND any stars it
        // already has), not just the dots -- this is meant to outline the
        // unit's own shape/boundary for the player, and a star belongs to
        // that outline exactly as much as a dot does. Excluding stars was
        // invisible for 1★ (a unit can only reach this rule with 0 stars
        // already placed there -- any star would already satisfy its
        // 1-star quota, making `needed` 0), only showing up for 2★+ once
        // a unit can have a star AND still need more.
        highlights: unit.indices
          .filter(i => !empty.includes(i))
          .map(idx => ({ idx, color: HINT_COLOR.SOURCE })),
         marks: empty.map(idx => ({ idx, color: HINT_COLOR.TARGET_STAR })),
         boardIdx: unit.boardIdx
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
        // Every already-resolved cell of the unit (its placed stars AND
        // any pre-existing dots), not just the stars -- same reasoning as
        // hintOnlyEmpty: this outlines the unit's own shape/boundary for
        // the player, and a dot belongs to that outline exactly as much
        // as a star does.
        highlights: unit.indices
          .filter(idx => !empty.includes(idx))
          .map(idx => ({ idx, color: HINT_COLOR.SOURCE })),
        marks: empty.map(idx => ({ idx, color: HINT_COLOR.TARGET })),
        boardIdx: unit.boardIdx ?? undefined
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

    const targetSet = new Set(targets);
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
      highlights: availInUnits.filter(i => !targetSet.has(i)).map(idx => ({ idx, color: HINT_COLOR.SOURCE })),
      marks: targets.map(idx => ({ idx, color: HINT_COLOR.TARGET })),
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
      if (forcedStars.length > 0) {
        hints.push({
          description: `Treat ${shape}. Every way to place ${starsWord} ${note} includes the marked cell${forcedStars.length === 1 ? ", so it's a star" : "s, so they're stars"}.`,
          highlights: union.indices
            .filter(i => !forcedStars.includes(i))
            .map(idx => ({ idx, color: HINT_COLOR.SOURCE })),
          marks: forcedStars.map(idx => ({ idx, color: HINT_COLOR.TARGET_STAR })),
          boardIdx
        });
      }
      if (forcedDots.length > 0) {
        hints.push({
          description: `Treat ${shape}. Every way to place ${starsWord} ${note} rules out a star at the marked cell(s), so they're dots.`,
          highlights: union.indices
            .filter(i => !forcedDots.includes(i))
            .map(idx => ({ idx, color: HINT_COLOR.SOURCE })),
          marks: forcedDots.map(idx => ({ idx, color: HINT_COLOR.TARGET })),
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
            why = { dots: `The blue cells already have their ${starsText}, so the marked cells are dots.` };
          } else if (N === 1) {
            if (avail.length === 1) forcedStars = avail;
            for (let i = 0; i < n * n; i++) {
              if (this.vState(i) === CELL.NONE && !remSet.has(i) && avail.every(c => sees(i, c))) forcedDots.push(i);
            }
            why = {
              stars: `Only one blue cell is still open, so it's a star.`,
              dots: `A star at the marked cell(s) would see every open blue cell, leaving the blue cells without their star, so they're dots.`,
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
              stars: `Every way to place ${N} non-touching stars in the blue cells includes the marked cell(s), so they're stars.`,
              dots: `Every way to place ${N} non-touching stars in the blue cells rules out a star at the marked cell(s), so they're dots.`,
            };
          }
          if (forcedStars.length === 0 && forcedDots.length === 0) continue;

          // Which board(s) A/B actually live on -- empty when both are
          // board-agnostic rows/cols, one board when either is a region,
          // two when A and B are regions on DIFFERENT boards.
          const abBoards = [...new Set([ua.boardIdx, ub.boardIdx].filter(b => b !== undefined))];
          const drawBoards = abBoards.length > 0 ? abBoards : this.boardIndices;
          const cIsRegion = cUnit.boardIdx !== undefined;
          const cOnOwnBoard = cIsRegion && !abBoards.includes(cUnit.boardIdx);
          const cName = cIsRegion
            ? (abBoards.length > 1 ? `the brown region on Board ${cUnit.boardIdx + 1}` : `the brown region`)
            : `${cUnit.label} (brown)`;
          const boardWord = abBoards.length === 1 ? `Board ${abBoards[0] + 1}` : 'the board(s)';
          const intro = `The two units on ${boardWord} made up of the blue and brown cells hold ${2 * N} stars together. `
            + `Apart from dotted cells, ${cName} lies entirely inside them and holds ${starsText}, `
            + `so the blue cells hold exactly ${starsText}. `;
          const highlights = [
            ...rem.map(idx => ({ idx, color: HINT_SOURCE_VARIANTS[0], boards: drawBoards })),
            // A row/column C is shown whole (the player reads it as a
            // line); a region C is shown on A/B's board(s) only where it
            // overlaps them.
            ...cUnit.indices.filter(i => !cIsRegion || aSet.has(i) || bSet.has(i))
              .map(idx => ({ idx, color: HINT_SOURCE_VARIANTS[1], boards: drawBoards })),
            ...(cOnOwnBoard ? cUnit.indices.map(idx => ({ idx, color: HINT_SOURCE_VARIANTS[1], boards: [cUnit.boardIdx] })) : []),
          ];
          // Marked cells are board-agnostic facts; show them wherever the
          // hint is drawn (plus C's own board too, when that's a different
          // one than A/B's).
          const boardIdx = abBoards.length === 1 && !cOnOwnBoard ? abBoards[0] : undefined;
          const marksOn = cOnOwnBoard ? [...drawBoards, cUnit.boardIdx] : drawBoards;
          const without = cells => highlights.filter(h => !cells.includes(h.idx));
          if (forcedStars.length > 0) {
            hints.push({
              description: intro + why.stars,
              highlights: without(forcedStars),
              marks: forcedStars.map(idx => ({ idx, color: HINT_COLOR.TARGET_STAR, boards: marksOn })),
              boardIdx
            });
          }
          if (forcedDots.length > 0) {
            hints.push({
              description: intro + why.dots,
              highlights: without(forcedDots),
              marks: forcedDots.map(idx => ({ idx, color: HINT_COLOR.TARGET, boards: marksOn })),
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
