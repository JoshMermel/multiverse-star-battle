import { CELL } from './constants.js';

// 2★+ rule implementations: everything written against an arbitrary
// this.starsPerGroup rather than assuming exactly 1 star per
// row/column/region. Used identically for 2★, 3★, and 4★+ puzzles via
// _getMultiStarRuleList() -- those three used to be byte-identical
// duplicated dispatch blocks in getHint(). See solver-rules-single.js for
// the 1★-only rules they generalize, and solver-rules-common.js for the
// rules shared verbatim by both families.
export function applyMultiStarRules(PuzzleSolver) {
  const p = PuzzleSolver.prototype;

  // --- 2★/3★-specific rules ---
  // These rely on enumerating every valid way to complete a still-unsatisfied unit's
  // stars (respecting non-adjacency), which is only cheap enough to brute-force through
  // 3★ (i.e. at most 3 stars still needed per unit). Each comes in a weak and strong
  // form (see _enumerateUnitCompletions): weak only rules out completions that touch
  // each other or an existing star; strong also rules out completions that would
  // overload some other row/column/region. Strong finds everything weak does, plus
  // more, but its reasoning is a bit more involved, so weak is offered as the easier
  // hint first.

  // Rule (2★/3★): For a row/column/region that has no stars placed yet, enumerate every
  // valid way to place its starsPerGroup non-touching stars inside it. A cell present in
  // every valid placement must be a star; a cell present in none of them must be a dot.
  // place its remaining star(s). If some cell outside the unit is adjacent (including
  // diagonally) to a star in EVERY one of those placements, then whichever placement
  // turns out to be true, that cell would end up touching a star — so it must be a dot.
  p.hintExternalDotFromPlacements = function (strong = true) {
    const candidates = [];
    for (const unit of this.units) {
      const combos = this._enumerateUnitCompletions(unit, strong);
      if (!combos || combos.length === 0) continue;

      const unitSet = new Set(unit.indices);
      let intersection = null;

      for (const combo of combos) {
        const seen = new Set();
        for (const cell of combo) {
          for (const nb of this.getNeighbors(cell)) {
            if (!unitSet.has(nb) && this.vState(nb) === CELL.NONE) seen.add(nb);
          }
        }
        intersection = intersection === null ? seen : new Set([...intersection].filter(x => seen.has(x)));
        if (intersection.size === 0) break;
      }

      if (intersection && intersection.size > 0) {
        candidates.push({ unit, targets: Array.from(intersection) });
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (a.targets[0] ?? 0) - (b.targets[0] ?? 0));

    const caveat = strong ? " (accounting for other rows/columns/regions' star limits)" : "";
    return candidates.map(({ unit, targets }) => {
      const unitType = unit.label.includes("Row") ? "row"
        : unit.label.includes("Column") ? "column"
        : "region";
      return {
        description: `Wherever this ${unitType}'s remaining star(s) end up${caveat}, one will always touch the marked cell(s), so they must be dots.`,
        highlights: unit.indices
          .filter(i => this.vState(i) === CELL.NONE)
          .map(idx => ({ idx, color: 'hint-source-blue' })),
        marks: targets.map(idx => ({ idx, color: 'hint-target-yellow' })),
        boardIdx: unit.boardIdx
      };
    });
  };

  // Row/Column/Region, based on a unit's label. Rows and columns never target each
  // other or themselves in hintUnitCompletionSatisfiesOtherUnit -- only cross-type
  // pairings (row<->region, column<->region, row<->column) are checked.
  p._unitKind = function (unit) {
    if (unit.label.startsWith("Row")) return "row";
    if (unit.label.startsWith("Column")) return "column";
    return "region";
  };

  // Rule (2★/3★): For a row/column/region with missing stars, enumerate every valid
  // way to place its remaining stars (strong -- i.e. also respecting other units'
  // limits). If EVERY one of those completions exactly fills up some OTHER row/column/
  // region (of a different type), then that other unit's entire remaining quota is
  // guaranteed to come from this unit no matter which completion turns out to be true
  // -- so any of its other empty cells (outside this unit) must be dots. Checked in
  // both directions: a region's placements can force a row or column, and a row's or
  // column's placements can force a region (or the other axis).
  p.hintUnitCompletionSatisfiesOtherUnit = function () {
    const candidates = [];
    for (const unit of this.units) {
      const combos = this._enumerateUnitCompletions(unit, true);
      if (!combos || combos.length === 0) continue;

      const sourceKind = this._unitKind(unit);
      const avail = unit.indices.filter(i => this.vState(i) === CELL.NONE);

      // Other units (of a different type) that share at least one candidate cell
      // with this one -- only these could possibly be "always satisfied".
      const seenLabels = new Set();
      const others = [];
      for (const idx of avail) {
        for (const otherUnit of this._unitsByCell[idx]) {
          if (otherUnit.label === unit.label) continue;
          if (this._unitKind(otherUnit) === sourceKind) continue;
          if (seenLabels.has(otherUnit.label)) continue;
          seenLabels.add(otherUnit.label);
          others.push(otherUnit);
        }
      }

      for (const other of others) {
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
          candidates.push({ unit, other, targets });
        }
      }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (a.targets[0] ?? 0) - (b.targets[0] ?? 0));

    return candidates.map(({ unit, other, targets }) => ({
      description: `Every valid way to place this ${this._unitKind(unit)}'s remaining star(s) completely fills up this ${this._unitKind(other)} too, so the rest of that ${this._unitKind(other)} must be dots.`,
      highlights: unit.indices
        .filter(i => this.vState(i) === CELL.NONE)
        .map(idx => ({ idx, color: 'hint-source-blue' })),
      marks: targets.map(idx => ({ idx, color: 'hint-target-yellow' })),
      boardIdx: unit.boardIdx ?? other.boardIdx
    }));
  };

  p.hintDisjointUnitRegionSyncMulti = function (N) {
    const candidates = [];
    // Finds combinations of N rows or columns that are not necessarily adjacent
    for (const axis of ["Row", "Column"]) {
      const axisIndices = this.axisIndices[axis];
      const starlessUnitIndices = Array.from({length: this.n}, (_, i) => i)
        .filter(u => !axisIndices[u].some(i => this.vState(i) === CELL.STAR));

      for (const combo of this.getCombinations(starlessUnitIndices, N)) {
        const unitCombo = combo.map(u => axisIndices[u]);
        for (let bIdx = 0; bIdx < this.game.regions.length; bIdx++) {
          const trapped = this._hintMultiRegionsTrappedInUnits(unitCombo, bIdx, axis);
          if (trapped) candidates.push(trapped);
          const covered = this._hintMultiUnitsCoveredByRegions(unitCombo, bIdx, axis);
          if (covered) candidates.push(covered);
        }
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (a.highlights[0]?.idx ?? 0) - (b.highlights[0]?.idx ?? 0));
    return candidates;
  };

  p.hintUnitPlacementForced = function (strong = true, filterCondition = null) {
    const candidates = [];
    for (const unit of this.units) {
      const stars = unit.indices.filter(i => this.vState(i) === CELL.STAR);
      const needed = this.starsPerGroup - stars.length;
      if (needed <= 0) continue;

      const combos = this._enumerateUnitCompletions(unit, strong);
      if (!combos || combos.length === 0) continue;

      const avail = unit.indices.filter(i => this.vState(i) === CELL.NONE);
      let forcedStars = avail.filter(cell => combos.every(combo => combo.includes(cell)));
      let forcedDots  = avail.filter(cell => !combos.some(combo => combo.includes(cell)));

      if (filterCondition === 'all_stars') {
        if (forcedStars.length !== needed) forcedStars = [];
        forcedDots = [];
      } else if (filterCondition === 'any_star') {
        if (forcedStars.length === 0 || forcedStars.length === needed) forcedStars = [];
        forcedDots = [];
      } else if (filterCondition === 'dots') {
        forcedStars = [];
      }

      if (forcedStars.length > 0 || forcedDots.length > 0) {
        candidates.push({ unit, forcedStars, forcedDots });
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.unit.indices[0] - b.unit.indices[0]);

    const caveat = strong ? ", also accounting for other rows/columns/regions' star limits," : "";
    const hints = [];
    for (const { unit, forcedStars, forcedDots } of candidates) {
      const unitType = unit.label.includes("Row") ? "row"
        : unit.label.includes("Column") ? "column"
        : "region";
      const starsWord = `${this.starsPerGroup} non-touching star${this.starsPerGroup === 1 ? '' : 's'}`;

      if (forcedStars.length > 0) {
        hints.push({
          description: `Every way to place this ${unitType}'s ${starsWord}${caveat} includes the marked cell, so it must be a star.`,
          highlights: unit.indices
            .filter(i => this.vState(i) === CELL.NONE && !forcedStars.includes(i))
            .map(idx => ({ idx, color: 'hint-source-blue' })),
          marks: forcedStars.map(idx => ({ idx, color: 'hint-target-green' })),
          boardIdx: unit.boardIdx
        });
      }
      if (forcedDots.length > 0) {
        hints.push({
          description: `No valid way to place this ${unitType}'s ${starsWord}${caveat} uses the marked cell, so it must be a dot.`,
          highlights: unit.indices
            .filter(i => this.vState(i) === CELL.NONE && !forcedDots.includes(i))
            .map(idx => ({ idx, color: 'hint-source-blue' })),
          marks: forcedDots.map(idx => ({ idx, color: 'hint-target-yellow' })),
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
  p._hintMultiUnitsCoveredByRegions = function (unitCombo, bIdx, axis) {
    const windowIndices = unitCombo.flat();
    const windowSet = new Set(windowIndices);

    const starsInWindow = windowIndices.filter(i => this.vState(i) === CELL.STAR).length;
    const requiredCount = unitCombo.length * this.starsPerGroup - starsInWindow;
    if (requiredCount <= 0) return null;

    const availInUnits = windowIndices.filter(i => this.vState(i) === CELL.NONE);
    if (availInUnits.length === 0) return null;

    const needingRegs = this.getRegionsNeedingStars(bIdx);
    const cellToRegionMap = this.buildCellToRegionMap(bIdx);

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
      ).map(idx => ({ idx, color: 'hint-source-blue' })),
      marks: targets.map(idx => ({ idx, color: 'hint-target-yellow' }))
    };
  };

  // Case (b): if the regions entirely confined to N adjacent rows/cols need, in total,
  // exactly as many stars as those rows/cols still need, then those rows/cols' entire
  // remaining quota must come from those regions — so the rest of the window (outside
  // those regions) must be dots.
  p._hintMultiRegionsTrappedInUnits = function (windowIndices, bIdx, axis) {
    const windowSet = new Set(windowIndices.flat());
    const allIndices = windowIndices.flat();

    const starsInWindow = allIndices.filter(i => this.vState(i) === CELL.STAR).length;
    const requiredCount = windowIndices.length * this.starsPerGroup - starsInWindow;
    if (requiredCount <= 0) return null;

    const needingRegs = this.getRegionsNeedingStars(bIdx);
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
      ).map(idx => ({ idx, color: 'hint-source-blue' })),
      marks: targets.map(idx => ({ idx, color: 'hint-target-yellow' }))
    };
  };

  // Find all 2★/3★-generalized sync hints for a window of N adjacent rows/cols.
  p._hintMultiWindowRegionSyncAll = function (N, axis) {
    const n = this.n;
    const axisIndices = this.axisIndices[axis];

    const windows = Array.from({ length: n - N + 1 }, (_, startU) =>
      Array.from({ length: N }, (_, i) => axisIndices[startU + i]));

    const candidates = [];
    for (let bIdx = 0; bIdx < this.game.regions.length; bIdx++) {
      for (const windowIndices of windows) {
        const trapped = this._hintMultiRegionsTrappedInUnits(windowIndices, bIdx, axis);
        if (trapped) candidates.push(trapped);

        const covered = this._hintMultiUnitsCoveredByRegions(windowIndices, bIdx, axis);
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
  p.hintLookaheadDotsSingleBoard = function () {
    const candidates = [];

    const emptyIndices = this.game.state
      .flatMap((val, idx) => this.vState(idx) === CELL.NONE ? [idx] : []);

    for (const testIdx of emptyIndices) {
      for (let bIdx = 0; bIdx < this.game.regions.length; bIdx++) {
        const boardReg = this._getRegionsContaining(testIdx)
          .find(r => r.boardIdx === bIdx);
        if (!boardReg) continue;

        // Skip if this board's region has already reached quota (it's solved).
        const existingRegStars = boardReg.indices.filter(i => this.vState(i) === CELL.STAR).length;
        if (existingRegStars >= this.starsPerGroup) continue;

        const sandboxState = [...this.game.state];
        this.voidIndices.forEach(idx => { sandboxState[idx] = CELL.DOT; });
        sandboxState[testIdx] = CELL.STAR;

        this._applyStarPlacementDots(sandboxState, testIdx, bIdx);

        const brokenUnits = this._findAllBrokenUnits(sandboxState, bIdx);
        for (const broken of brokenUnits) {
          candidates.push({ testIdx, broken, boardIdx: bIdx });
        }
      }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.testIdx - b.testIdx);
    return candidates.map(({ testIdx, broken, boardIdx }) => ({
      boardIdx,
      description: `The blue cells can no longer reach their required star count if the circled cell holds a star.`,
      highlights: broken.indices.map(idx => ({ idx, color: 'hint-source-blue' })),
      marks: [{ idx: testIdx, color: 'hint-target-yellow' }]
    }));
  };

  // Rule (2★+): same speculative single-star placement as hintLookaheadDotsSingleBoard,
  // but region completion is checked across EVERY board the test cell belongs to, so
  // contradictions that only surface when combining region information from multiple
  // boards are also caught.
  p.hintLookaheadDots = function () {
    const candidates = [];

    const emptyIndices = this.game.state
      .flatMap((val, idx) => this.vState(idx) === CELL.NONE ? [idx] : []);

    for (const testIdx of emptyIndices) {
      const sandboxState = [...this.game.state];
      this.voidIndices.forEach(idx => { sandboxState[idx] = CELL.DOT; });
      sandboxState[testIdx] = CELL.STAR;

      this._applyStarPlacementDots(sandboxState, testIdx, null);

      const brokenUnits = this._findAllBrokenUnits(sandboxState);
      for (const broken of brokenUnits) {
        candidates.push({ testIdx, broken });
      }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.testIdx - b.testIdx);
    return candidates.map(({ testIdx, broken }) => ({
      boardIdx: broken.type === 'region' ? broken.boardIdx : undefined,
      description: `The blue cells can no longer reach their required star count if the circled cell holds a star.`,
      highlights: broken.indices.map(idx => ({ idx, color: 'hint-source-blue' })),
      marks: [{ idx: testIdx, color: 'hint-target-yellow' }]
    }));
  };

  // --- Rule list for starsPerGroup >= 2 ---
  //
  // Used identically for 2★, 3★, and 4★+ puzzles -- those were three
  // byte-identical duplicated arrays in the pre-refactor getHint().
  p._getMultiStarRuleList = function () {
    return [
      // Error validation
      { key: 'checkForErrors',                 fn: () => this.hintCheckForErrors() },
      { key: 'alreadySolved',                  fn: () => this.hintAlreadySolved() },
      // Beginner
      { key: 'onlyEmpty',                      fn: () => this.hintOnlyEmpty() },
      { key: 'excludeAdjacency',               fn: () => this.hintExcludeAdjacency() },
      { key: 'excludeSolvedUnit',              fn: () => this.hintExcludeSolvedUnit() },
      { key: 'unitPlacementForcedWeakAll',     fn: () => this.hintUnitPlacementForced(false, 'all_stars') },
      { key: 'unitRegionSyncMulti1',           fn: () => this.hintUnitRegionSyncMulti(1) },
      // Medium
      { key: 'unitPlacementForcedWeakAny',     fn: () => this.hintUnitPlacementForced(false, 'any_star') },
      { key: 'unitPlacementForcedWeakDots',    fn: () => this.hintUnitPlacementForced(false, 'dots') },
      { key: 'externalDotFromPlacementsWeak',  fn: () => this.hintExternalDotFromPlacements(false) },
      { key: 'unitPlacementForcedStrongAll',   fn: () => this.hintUnitPlacementForced(true, 'all_stars') },
      { key: 'unitRegionSyncMulti2',           fn: () => this.hintUnitRegionSyncMulti(2) },
      // Hard
      { key: 'unitPlacementForcedStrongAny',   fn: () => this.hintUnitPlacementForced(true, 'any_star') },
      { key: 'unitPlacementForcedStrongDots',  fn: () => this.hintUnitPlacementForced(true, 'dots') },
      { key: 'externalDotFromPlacementsStrong',fn: () => this.hintExternalDotFromPlacements(true) },
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
      { key: 'unitCompletionSatisfiesOtherUnit', fn: () => this.hintUnitCompletionSatisfiesOtherUnit() },
      // Expert
      { key: 'regionSubsetSync3',              fn: () => this.hintRegionSubsetSync(3) },
      { key: 'regionSubsetSync4',              fn: () => this.hintRegionSubsetSync(4) },
      { key: 'disjointUnitRegionSyncMulti2',   fn: () => this.hintDisjointUnitRegionSyncMulti(2) },
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
