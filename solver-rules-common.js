import { CELL } from './constants.js';

// Rules referenced, by the exact same underlying function, in both the
// single-star and multi-star rule lists: error/already-solved checks,
// onlyEmpty/excludeAdjacency/excludeSolvedUnit, hintRegionSubsetSync (used
// at different K by each family), hintFromSolution, and hintLookahead (used
// at different stage counts by each family). See solver-rules-single.js /
// solver-rules-multi.js for the rules unique to each star-count family.
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
      if (isWrong) highlights.push({ idx: i, color: 'hint-error-red' });
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
        candidates.push({ unit, empty, stars });
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.unit.indices[0] - b.unit.indices[0]);
    return candidates.map(({ unit, empty, stars }) => {
      const unitType = unit.label.includes("Row") ? "row"
        : unit.label.includes("Column") ? "column"
        : "region";
      const description = starsPerGroup === 1
        ? `Only one spot is left for a star in this ${unitType}.`
        : `Exactly ${empty.length} spots are left for the remaining stars in this ${unitType}.`;
      return {
        description,
        highlights: unit.indices
          .filter(i => !empty.includes(i) && !stars.includes(i))
          .map(idx => ({ idx, color: 'hint-source-blue' })),
         marks: empty.map(idx => ({ idx, color: 'hint-target-green' })),
         boardIdx: unit.boardIdx
      };
    });
  };

  // Rule: Check for units that already have all their stars placed.
  p.hintExcludeSolvedUnit = function () {
    const starsPerGroup = this.starsPerGroup || 1;
    const typeDescs = {
      "Row": starsPerGroup === 1 ? "This row already has its star." : `This row already has its ${starsPerGroup} stars.`,
      "Column": starsPerGroup === 1 ? "This column already has its star." : `This column already has its ${starsPerGroup} stars.`,
      "Region": starsPerGroup === 1 ? "This region already has its star." : `This region already has its ${starsPerGroup} stars.`,
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
      const key = unit.label.includes("Row") ? "Row"
        : unit.label.includes("Column") ? "Column"
        : "Region";
      const stars = unit.indices.filter(idx => this.vState(idx) === CELL.STAR);
      const empty = unit.indices.filter(idx => this.vState(idx) === CELL.NONE);
      return {
        description: typeDescs[key],
        highlights: stars.map(idx => ({ idx, color: 'hint-source-blue' })),
        marks: empty.map(idx => ({ idx, color: 'hint-target-yellow' })),
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
        .map(nb => ({ idx: nb, color: 'hint-target-yellow' }));
      if (marks.length > 0) candidates.push({ i, marks });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.i - b.i);
    return candidates.map(({ i, marks }) => ({
      description: "Stars cannot touch each other.",
      highlights: [{ idx: i, color: 'hint-source-blue' }],
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

    for (let bIdx = 0; bIdx < this.game.regions.length; bIdx++) {
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
      this.formatSubsetHint(setA.regions, setB.regions, targets, setA.boardIdx));
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
      marks: [{ idx, color: 'hint-target-yellow' }],
      boardIdx: undefined
    }));
  };

  // Rule: Multi-stage lookahead for contradiction checking.
  p.hintLookahead = function (nStages) {
    const candidates = [];

    const emptyIndices = this.game.state
      .flatMap((val, idx) => this.vState(idx) === CELL.NONE ? [idx] : []);

    for (const testIdx of emptyIndices) {
      // Build simulated sandbox layout populated with the virtual void dots
      let sandboxState = [...this.game.state];
      this.voidIndices.forEach(idx => { sandboxState[idx] = CELL.DOT; });
      sandboxState[testIdx] = CELL.STAR;

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
      description: `Placing a star here would make the puzzle unsolvable. Seeing why requires some lookahead.`,
      highlights: [],
      marks: [{ idx: testIdx, color: 'hint-target-yellow' }]
    }));
  };
}
