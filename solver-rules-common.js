import { CELL, HINT_COLOR } from './constants.js';

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
      const stars = unit.indices.filter(idx => this.vState(idx) === CELL.STAR);
      const empty = unit.indices.filter(idx => this.vState(idx) === CELL.NONE);
      return {
        description: typeDescs[key],
        highlights: stars.map(idx => ({ idx, color: HINT_COLOR.SOURCE })),
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
