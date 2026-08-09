import { CELL, HINT_COLOR } from './constants.js';
import { cellsSee } from './geometry.js';

// 1★-only rule implementations: rules that assume exactly one star per
// row/column/region, plus the classic deduction techniques (domino,
// sees-too-much, row/col <-> region sync, disjoint sync, cross-board
// pinning, partial overlap, lookahead, and symmetry-based rules) that only
// ever get wired into the 1★ rule list via _getSingleStarRuleList(). See
// solver-rules-multi.js for their starsPerGroup >= 2 generalizations, and
// solver-rules-common.js for the rules shared verbatim by both families.
export function applySingleStarRules(PuzzleSolver) {
  const p = PuzzleSolver.prototype;

  // Rule: Check for unsolved regions containing exactly one cell.
  p.hintSingleCellRegion = function () {
    const candidates = [];
    for (const bIdx of this.boardIndices) {
      for (const region of this.getUnsolvedRegions(bIdx)) {
        if (region.indices.length === 1 && this.vState(region.indices[0]) === CELL.NONE) {
          candidates.push(region);
        }
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.indices[0] - b.indices[0]);
    return candidates.map(region => ({
      description: `Every region must contain a star.`,
      highlights: [{ idx: region.indices[0], color: HINT_COLOR.TARGET_STAR }],
      marks: [],
      boardIdx: region.boardIdx
    }));
  };

  // Rule: Check for domino patterns in unsolved regions.
  p.hintDomino = function () {
    const n = this.n;
    const candidates = [];

    for (const bIdx of this.boardIndices) {
      for (const region of this.getUnsolvedRegions(bIdx)) {
        const empty = region.indices.filter(i => this.vState(i) === CELL.NONE);
        if (empty.length !== 2) continue;

        const [idxA, idxB] = empty;
        const rA = Math.floor(idxA / n), cA = idxA % n;
        const rB = Math.floor(idxB / n), cB = idxB % n;

        // Only orthogonally adjacent pairs.
        if (Math.abs(rA - rB) + Math.abs(cA - cB) !== 1) continue;

        // Eliminate empty cells along the shared axis.
        const blockedIndices = new Set();
        if (rA === rB) {
          for (let k = 0; k < n; k++) blockedIndices.add(rA * n + k);
        } else {
          for (let k = 0; k < n; k++) blockedIndices.add(k * n + cA);
        }

        // Eliminate common neighbors.
        const adjA = new Set(this.getNeighbors(idxA));
        const adjB = new Set(this.getNeighbors(idxB));
        for (const idx of adjA) {
          if (adjB.has(idx)) blockedIndices.add(idx);
        }

        blockedIndices.delete(idxA);
        blockedIndices.delete(idxB);

        const targets = Array.from(blockedIndices)
          .filter(idx => this.vState(idx) === CELL.NONE);

        if (targets.length > 0) {
          candidates.push({ idxA, idxB, targets, boardIdx: region.boardIdx });
        }
      }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.idxA - b.idxA || a.idxB - b.idxB);
    return candidates.map(({ idxA, idxB, targets, boardIdx }) => ({
      description: "A star must be in the blue domino.",
      highlights: [
        { idx: idxA, color: HINT_COLOR.SOURCE },
        { idx: idxB, color: HINT_COLOR.SOURCE }
      ],
      marks: targets.map(idx => ({ idx, color: HINT_COLOR.TARGET })),
      boardIdx
    }));
  };

  // Check "N units covered by N regions" deduction. unsolvedRegs/cellToRegionMap
  // are precomputed once per board by the caller (they only depend on bIdx, not
  // on unitCombo) rather than recomputed on every window checked.
  p._hintUnitsCoveredByRegions = function (unitCombo, bIdx, axis, unsolvedRegs, cellToRegionMap) {
    const windowIndices = unitCombo.flat();
    const windowSet = new Set(windowIndices);

    const starsInWindow = windowIndices.filter(i => this.vState(i) === CELL.STAR).length;
    const requiredCount = unitCombo.length - starsInWindow;
    if (requiredCount <= 0) return null;

    const availInUnits = windowIndices.filter(i => this.vState(i) === CELL.NONE);
    if (availInUnits.length === 0) return null;

    const coveringRegLabels = new Set(availInUnits.map(idx => cellToRegionMap[idx]).filter(Boolean));
    const coveringUnsolved = Array.from(coveringRegLabels)
      .map(label => unsolvedRegs.find(r => r.label === label))
      .filter(Boolean);

    if (coveringUnsolved.length !== requiredCount) return null;

    const regUnion = new Set(coveringUnsolved.flatMap(r => r.indices));
    const targets = Array.from(regUnion)
      .filter(idx => !windowSet.has(idx) && this.vState(idx) === CELL.NONE);

    if (targets.length === 0) return null;

    const targetSet = new Set(targets);
    const N = unitCombo.length;
    const unitsPhrase = N === 1 ? `this ${axis.toLowerCase()}` : `these ${N} ${axis.toLowerCase()}s`;

    return {
      boardIdx: bIdx,
      description: `All empty cells in ${unitsPhrase} are covered by the blue regions.`,
      highlights: coveringUnsolved.flatMap(r =>
        r.indices.filter(i => this.vState(i) === CELL.NONE && !targetSet.has(i))
      ).map(idx => ({ idx, color: HINT_COLOR.SOURCE })),
      marks: targets.map(idx => ({ idx, color: HINT_COLOR.TARGET }))
    };
  };

  // Check "N regions trapped in N units" deduction. unsolvedRegs is
  // precomputed once per board by the caller (see
  // _hintUnitsCoveredByRegions above).
  p._hintRegionsTrappedInUnits = function (windowIndices, bIdx, axis, unsolvedRegs) {
    const windowSet = new Set(windowIndices.flat());
    const allIndices = windowIndices.flat();

    const starsInWindow = allIndices.filter(i => this.vState(i) === CELL.STAR).length;
    const requiredCount = windowIndices.length - starsInWindow;
    if (requiredCount <= 0) return null;

    const pinnedRegs = unsolvedRegs.filter(reg => {
      const regAvail = reg.indices.filter(i => this.vState(i) === CELL.NONE);
      return regAvail.length > 0 && regAvail.every(idx => windowSet.has(idx));
    });

    if (pinnedRegs.length !== requiredCount) return null;

    const regUnion = new Set(pinnedRegs.flatMap(r => r.indices));
    const targets = allIndices.filter(idx =>
      this.vState(idx) === CELL.NONE && !regUnion.has(idx)
    );

    if (targets.length === 0) return null;

    const targetSet = new Set(targets);
    const N = windowIndices.length;
    const unitsPhrase = N === 1 ? `this ${axis.toLowerCase()}` : `these ${N} ${axis.toLowerCase()}s`;

    return {
      boardIdx: bIdx,
      description: `The star for ${unitsPhrase} must fall in one of the blue regions.`,
      highlights: pinnedRegs.flatMap(r =>
        r.indices.filter(i => this.vState(i) === CELL.NONE && !targetSet.has(i))
      ).map(idx => ({ idx, color: HINT_COLOR.SOURCE })),
      marks: targets.map(idx => ({ idx, color: HINT_COLOR.TARGET }))
    };
  };

  // Find all synchronization hints for a window size of N.
  p._hintWindowRegionSyncAll = function (N, axis, adjacent) {
    const n = this.n;
    const axisIndices = this.axisIndices[axis];

    const starlessUnitIndices = Array.from({length: n}, (_, i) => i)
      .filter(u => !axisIndices[u].some(i => this.vState(i) === CELL.STAR));

    const windows = adjacent
      ? Array.from({length: n - N + 1}, (_, startU) =>
          Array.from({length: N}, (_, i) => axisIndices[startU + i]))
          .filter(w => w.every(unitIdxs => !unitIdxs.some(i => this.vState(i) === CELL.STAR)))
      : this.getCombinations(starlessUnitIndices, N)
          .map(combo => combo.map(u => axisIndices[u]));

    const candidates = [];
    for (const bIdx of this.boardIndices) {
      const unsolvedRegs = this.getUnsolvedRegions(bIdx);
      const cellToRegionMap = this.buildCellToRegionMap(bIdx);
      for (const windowIndices of windows) {

        const standard = this._hintRegionsTrappedInUnits(windowIndices, bIdx, axis, unsolvedRegs);
        if (standard) candidates.push(standard);

        const inverse = this._hintUnitsCoveredByRegions(windowIndices, bIdx, axis, unsolvedRegs, cellToRegionMap);
        if (inverse) candidates.push(inverse);
      }
    }
    return candidates;
  };

  p._hintWindowRegionSync = function (N, axis, adjacent) {
    const candidates = this._hintWindowRegionSyncAll(N, axis, adjacent);
    if (candidates.length === 0) return null;
    return candidates;
  };

  // Rule: Check for N adjacent rows/columns synchronized with N regions.
  p.hintUnitRegionSync = function (N) {
    const candidates = [];
    for (const axis of ["Row", "Column"]) {
      const hints = this._hintWindowRegionSyncAll(N, axis, true);
      candidates.push(...hints);
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (a.highlights[0]?.idx ?? 0) - (b.highlights[0]?.idx ?? 0));
    return candidates;
  };

  // Rule: Check region synchronization for 4+ rows/columns.
  p.hintManyRegionsSync = function () {
    const candidates = [];
    for (let n = 4; n < this.n; n++) {
      for (const axis of ["Row", "Column"]) {
        candidates.push(...this._hintWindowRegionSyncAll(n, axis, true));
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (a.highlights[0]?.idx ?? 0) - (b.highlights[0]?.idx ?? 0));
    return candidates;
  };

  // Helper to find external cells that see all options in a unit.
  p._hintSeesTooMuchForUnits = function (units) {
    const n = this.n;
    const hintCandidates = [];
    for (const unit of units) {
      const candidates = unit.indices.filter(i => this.vState(i) === CELL.NONE);
      if (candidates.length === 0) continue;

      const targets = [];

      for (let i = 0; i < n * n; i++) {
        if (this.vState(i) !== CELL.NONE || unit.indices.includes(i)) continue;
        const canSeeAll = candidates.every(c => cellsSee(i, c, n));
        if (canSeeAll) targets.push({ idx: i, color: HINT_COLOR.TARGET });
      }

      if (targets.length > 0) hintCandidates.push({ unit, candidates, targets });
    }
    if (hintCandidates.length === 0) return null;
    hintCandidates.sort((a, b) => a.candidates[0] - b.candidates[0]);
    return hintCandidates.map(({ unit, candidates, targets }) => ({
      boardIdx: unit.boardIdx,
      description: `The blue cells must contain a star.`,
      highlights: candidates.map(i => ({ idx: i, color: HINT_COLOR.SOURCE })),
      marks: targets,
    }));
  };

  // Rule: Check rows/columns where all empty cells are visible to an external cell.
  p.hintUnitSeesTooMuch = function () {
    const rowColUnits = this.units.filter(u =>
      this._unitKind(u) !== "region" &&
      !u.indices.some(i => this.vState(i) === CELL.STAR)
    );
    return this._hintSeesTooMuchForUnits(rowColUnits);
  };

  // Rule: Check regions where all empty cells are visible to an external cell.
  p.hintSeesTooMuch = function (nTarget = null) {
    const regionUnits = this.boardIndices
      .flatMap(bIdx => this.getUnsolvedRegions(bIdx))
      .filter(u => nTarget === null || u.indices.filter(i => this.vState(i) === CELL.NONE).length === nTarget);
    return this._hintSeesTooMuchForUnits(regionUnits);
  };

  // Rule: Check disjoint units synchronized with regions.
  p.hintDisjointUnitRegionSync = function (N) {
    const candidates = [];
    for (const axis of ["Row", "Column"]) {
      const hints = this._hintWindowRegionSyncAll(N, axis, false);
      candidates.push(...hints);
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (a.highlights[0]?.idx ?? 0) - (b.highlights[0]?.idx ?? 0));
    return candidates;
  };

  // Check "N rows/cols whose empties are confined to N cells of the other axis" deduction.
  // This is the cross-axis analogue of _hintRegionsTrappedInUnits: instead of trapping N
  // rows/cols inside N regions, it traps N rows inside N columns (or vice versa) directly,
  // with no region information involved at all.
  p._hintAxisLineTrapped = function (unitCombo, axisLabel) {
    const n = this.n;
    const otherAxisLabel = axisLabel === "Row" ? "Column" : "Row";
    const otherAxisIndices = this.axisIndices[otherAxisLabel];

    const windowIndices = unitCombo.flat();
    const windowSet = new Set(windowIndices);

    const starsInWindow = windowIndices.filter(i => this.vState(i) === CELL.STAR).length;
    const requiredCount = unitCombo.length - starsInWindow;
    if (requiredCount <= 0) return null;

    const availInUnits = windowIndices.filter(i => this.vState(i) === CELL.NONE);
    if (availInUnits.length === 0) return null;

    // Which units of the OTHER axis do these empty cells actually touch?
    const touchedOther = new Set(
      availInUnits.map(i => axisLabel === "Row" ? i % n : Math.floor(i / n))
    );
    if (touchedOther.size !== requiredCount) return null;

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
    const otherPhrase = requiredCount === 1 ? `${otherWord}` : `${otherWord}s`;

    return {
      boardIdx: undefined,
      description: `All empty cells in ${unitsPhrase} fall within ${requiredCount} ${otherPhrase}, so the rest of ${requiredCount === 1 ? 'that' : 'those'} ${otherPhrase} must be dots.`,
      highlights: availInUnits.filter(i => !targetSet.has(i)).map(idx => ({ idx, color: HINT_COLOR.SOURCE })),
      marks: targets.map(idx => ({ idx, color: HINT_COLOR.TARGET })),
    };
  };

  // Find all row<->column line-sync hints for a window size of N.
  p._hintAxisLineSyncAll = function (N, axis) {
    const n = this.n;
    const axisIndices = this.axisIndices[axis];

    const starlessUnitIndices = Array.from({ length: n }, (_, i) => i)
      .filter(u => !axisIndices[u].some(i => this.vState(i) === CELL.STAR));

    const candidates = [];
    for (const combo of this.getCombinations(starlessUnitIndices, N)) {
      const unitCombo = combo.map(u => axisIndices[u]);
      const hint = this._hintAxisLineTrapped(unitCombo, axis);
      if (hint) candidates.push(hint);
    }
    return candidates;
  };

  // Rule: N rows (or N columns) whose empty cells are confined to N columns (or N rows) —
  // no region information needed, works identically on regular and irregular boards.
  p.hintRowColLineSync = function (N) {
    const candidates = [];
    for (const axis of ["Row", "Column"]) {
      candidates.push(...this._hintAxisLineSyncAll(N, axis));
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (a.highlights[0]?.idx ?? a.marks[0]?.idx ?? 0) - (b.highlights[0]?.idx ?? b.marks[0]?.idx ?? 0));
    return candidates;
  };

  // Rule: Check cross-board pinned regions.
  p.hintCrossBoardRegionPinned = function (N, axis = "Row") {
    const n = this.n;

    // Build unsolved region descriptors from both boards
    const unsolvedRegions = this.boardIndices.flatMap(bIdx =>
      this.getUnsolvedRegions(bIdx)
      .filter(reg => reg.indices.some(i => this.vState(i) === CELL.NONE))
      .map(reg => ({
        allIdxs: new Set(reg.indices),
        availableIdxs: reg.indices.filter(i => this.vState(i) === CELL.NONE),
        original: reg
      }))
    );

    if (unsolvedRegions.length < N) return null;

    const candidates = [];
    for (const combo of this.getCombinations(unsolvedRegions, N)) {
      if (!this._areDisjoint(combo.map(r => r.allIdxs))) continue;

      const allAvailable = combo.flatMap(r => r.availableIdxs);
      const occupiedUnits = new Set(allAvailable.map(idx =>
        axis === "Row" ? Math.floor((idx % (n * n)) / n) : (idx % (n * n)) % n
      ));

      if (occupiedUnits.size !== N) continue;

      const uList = Array.from(occupiedUnits).sort((a, b) => a - b);
      if (uList[uList.length - 1] - uList[0] !== N - 1) continue;

      const regionUnion = new Set(combo.flatMap(r => Array.from(r.allIdxs)));
      const targets = [];

      for (const u of uList) {
        for (let i = 0; i < n; i++) {
          const idx = axis === "Row" ? u * n + i : i * n + u;
          if (!regionUnion.has(idx) && this.vState(idx) === CELL.NONE) {
            targets.push(idx);
          }
        }
      }
      if (targets.length > 0) candidates.push({ combo, targets, uList });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (a.targets[0] ?? 0) - (b.targets[0] ?? 0));
    return candidates.map(({ combo, targets, uList }) => this.formatCrossBoardHint(combo, targets, axis, uList));
  };

  // Rule: Check overlapping regions across boards.
  //
  // Requires at least 2 shared cells (not just >= 1): with only one shared
  // cell, "both stars must land in the shared cells" collapses to "the
  // star is in this one cell", which reads as an oddly roundabout way to
  // say the same thing a simpler rule would already have caught -- worth
  // it once there's an actual choice among several shared cells, not when
  // there's only one.
  p.hintPartialOverlap = function () {
    const n = this.n;
    const candidates = [];

    const numBoards = this.game.regions.length;

    for (let boardA = 0; boardA < numBoards; boardA++) {
      for (let boardB = boardA + 1; boardB < numBoards; boardB++) {
        const boardARegions = this.getUnsolvedRegions(boardA);
        const boardBRegions = this.getUnsolvedRegions(boardB);

        for (const regA of boardARegions) {
          for (const regB of boardBRegions) {
            const setA = new Set(regA.indices.filter(i => this.vState(i) !== CELL.DOT));
            const setB = new Set(regB.indices.filter(i => this.vState(i) !== CELL.DOT));

            const shared  = [...setA].filter(i => setB.has(i));
            const onlyA   = [...setA].filter(i => !setB.has(i));
            const onlyB   = [...setB].filter(i => !setA.has(i));
            const disjoint = [...onlyA, ...onlyB];

            if (shared.length < 2 || disjoint.length === 0) continue;

            const onlyASeesAllOnlyB = onlyA.every(a => onlyB.every(b => cellsSee(a, b, n)));
            if (!onlyASeesAllOnlyB) continue;

            const targets = shared.filter(i => this.vState(i) === CELL.NONE);
            if (targets.length === 0) continue;

            candidates.push({ shared, onlyA, onlyB, boardA, boardB });
          }
        }
      }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (a.shared[0] ?? 0) - (b.shared[0] ?? 0));
    return candidates.map(({ shared, onlyA, onlyB, boardA, boardB }) => ({
      boardIdx: undefined,
      description: `These two regions (${this._describeBoards([boardA, boardB])}) overlap. Any star placed in a non-shared cell would see all the non-shared cells of the other region, making that region unsolvable. Both stars must land in the shared cells.`,
      // A shared cell is a candidate for BOTH regions at once, so it's
      // relevant on both boards, not just one.
      highlights: shared
        .filter(i => this.vState(i) === CELL.NONE)
        .map(i => ({ idx: i, color: HINT_COLOR.SOURCE, boards: [boardA, boardB] })),
      marks: [
        ...onlyA.filter(i => this.vState(i) === CELL.NONE).map(i => ({ idx: i, color: HINT_COLOR.TARGET, boards: [boardA] })),
        ...onlyB.filter(i => this.vState(i) === CELL.NONE).map(i => ({ idx: i, color: HINT_COLOR.TARGET, boards: [boardB] })),
      ]
    }));
  };

  // Shared implementation for hintLookaheadHalfSingleBoard/hintLookaheadHalf:
  // speculatively place one star, eliminate the row/column/adjacency dots it
  // implies (board-agnostic) plus region dots, and check for a broken unit.
  // singleBoard=true does this once per board, restricting region
  // elimination (and the resulting hint) to that one board's region;
  // singleBoard=false does it once per test cell, eliminating from EVERY
  // board's region at once and checking across all boards together.
  p._hintLookaheadHalfImpl = function (singleBoard) {
    const n = this.n;
    const candidates = [];

    const emptyIndices = this.game.state
      .flatMap((val, idx) => this.vState(idx) === CELL.NONE ? [idx] : []);

    const boardScopes = singleBoard
      ? this.boardIndices
      : [null];

    for (const testIdx of emptyIndices) {
      const row = Math.floor(testIdx / n);
      const col = testIdx % n;

      for (const bIdx of boardScopes) {
        let boardReg = null;
        if (singleBoard) {
          boardReg = this._getRegionsContaining(testIdx).find(r => r.boardIdx === bIdx);
          if (!boardReg) continue;
        }

        const sandboxState = this._buildSpeculativeState(testIdx);

        // Row and column elimination (board-agnostic).
        for (let j = 0; j < n; j++) {
          const rIdx = row * n + j;
          const cIdx = j * n + col;
          if (sandboxState[rIdx] === CELL.NONE && rIdx !== testIdx) sandboxState[rIdx] = CELL.DOT;
          if (sandboxState[cIdx] === CELL.NONE && cIdx !== testIdx) sandboxState[cIdx] = CELL.DOT;
        }

        // Adjacency elimination (board-agnostic).
        for (const nb of this.getNeighbors(testIdx)) {
          if (sandboxState[nb] === CELL.NONE) sandboxState[nb] = CELL.DOT;
        }

        // Region elimination: this board only in single-board mode, every
        // board the cell belongs to otherwise.
        const regionsToEliminate = singleBoard ? [boardReg] : this._getRegionsContaining(testIdx);
        for (const reg of regionsToEliminate) {
          reg.indices.forEach(i => {
            if (sandboxState[i] === CELL.NONE) sandboxState[i] = CELL.DOT;
          });
        }

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
      description: `The blue cells must contain a star. This is impossible if the circled cell holds a star.`,
      highlights: broken.indices.map(idx => ({ idx, color: HINT_COLOR.SOURCE })),
      marks: [{ idx: testIdx, color: HINT_COLOR.TARGET }]
    }));
  };

  // Rule: Lookahead level 1 (check single-star placement contradiction within single board constraints).
  p.hintLookaheadHalfSingleBoard = function () {
    return this._hintLookaheadHalfImpl(true);
  };

  // Rule: Lookahead level 1 (check single-star placement contradiction across both boards).
  p.hintLookaheadHalf = function () {
    return this._hintLookaheadHalfImpl(false);
  };

  p._hintSymmetry = function (mirrorFn, description) {
    const n = this.n;
    const cellToRegionMaps = this.game.regions.map((_, bIdx) => this.buildCellToRegionMap(bIdx));

    const marks = [];
    for (let i = 0; i < n * n; i++) {
      if (this.vState(i) !== CELL.NONE) continue;

      const mirror = mirrorFn(i);
      if (mirror === i) continue;

      const seesOwnMirror =
        cellsSee(i, mirror, n) ||
        cellToRegionMaps.some(map => map[i] && map[i] === map[mirror]);

      if (seesOwnMirror) marks.push({ idx: i, color: HINT_COLOR.TARGET });
    }

    if (marks.length === 0) return null;

    return { description, highlights: [], marks, boardIdx: undefined };
  };

  p.hintSymmetryFill = function () {
    const n = this.n;
    const results = [];

    if (this.internalRotation180 || this.crossboardRotation180) {
      const hint = this._hintSymmetryFill(
        i => (n * n - 1) - i,
        `The solution has 180° rotational symmetry.`
      );
      if (hint) results.push(hint);
    }

    if (this.isMainDiagonalSymmetric) {
      const desc = this.mainDiagInternal && !this.mainDiagCrossBoard
        ? `Each board independently has diagonal symmetry across the main diagonal (↘). The solution is symmetric.`
        : `The solution is symmetric across the main diagonal (↘).`;
      const hint = this._hintSymmetryFill(i => (i % n) * n + Math.floor(i / n), desc);
      if (hint) results.push(hint);
    }

    if (this.isAntiDiagonalSymmetric) {
      const desc = this.antiDiagInternal && !this.antiDiagCrossBoard
        ? `Each board independently has diagonal symmetry across the anti-diagonal (↙). The solution is symmetric.`
        : `The solution is symmetric across the anti-diagonal (↙).`;
      const hint = this._hintSymmetryFill(
        i => (n - 1 - i % n) * n + (n - 1 - Math.floor(i / n)),
        desc
      );
      if (hint) results.push(hint);
    }

    return results.length > 0 ? results : null;
  };

  // Rule: diagonal-parity constraint.
  // When the puzzle has diagonal symmetry the number of stars on that diagonal
  // must share the same parity as N (even N → even count, odd N → odd count).
  p.hintSymmetryDeduction = function () {
    const n = this.n;
    const results = [];

    if (this.internalRotation180 || this.crossboardRotation180) {
      const description = this.internalRotation180 && this.crossboardRotation180
        ? `Each board has 180° rotational symmetry, and every board is also paired with another board that's its 180° rotation. Any cell that "sees" its own rotation cannot be a star.`
        : this.internalRotation180
        ? `Each board independently has 180° rotational symmetry. Any cell that "sees" its own rotation cannot be a star.`
        : `Every board is paired with another board that's its 180° rotation. Any cell that "sees" its counterpart on the paired board cannot be a star.`;
      const hint = this._hintSymmetry(i => (n * n - 1) - i, description);
      if (hint) results.push(hint);
    }

    if (this.isMainDiagonalSymmetric) {
      const description = this.mainDiagCrossBoard && this.mainDiagInternal
        ? `Every board is paired with another board that's its reflection across the main diagonal (↘), and each board also has that symmetry internally. The solution must be symmetric, so any cell that "sees" its own reflection cannot be a star.`
        : this.mainDiagInternal
        ? `Each board independently has diagonal symmetry across the main diagonal (↘). The solution must be symmetric, so any cell that "sees" its own reflection cannot be a star.`
        : `Every board is paired with another board that's its reflection across the main diagonal (↘). The solution must be symmetric, so any cell that "sees" its own reflection cannot be a star.`;
      const hint = this._hintSymmetry(i => (i % n) * n + Math.floor(i / n), description);
      if (hint) results.push(hint);
    }

    if (this.isAntiDiagonalSymmetric) {
      const description = this.antiDiagCrossBoard && this.antiDiagInternal
        ? `Every board is paired with another board that's its reflection across the anti-diagonal (↙), and each board also has that symmetry internally. The solution must be symmetric, so any cell that "sees" its own reflection cannot be a star.`
        : this.antiDiagInternal
        ? `Each board independently has diagonal symmetry across the anti-diagonal (↙). The solution must be symmetric, so any cell that "sees" its own reflection cannot be a star.`
        : `Every board is paired with another board that's its reflection across the anti-diagonal (↙). The solution must be symmetric, so any cell that "sees" its own reflection cannot be a star.`;
      const hint = this._hintSymmetry(
        i => (n - 1 - i % n) * n + (n - 1 - Math.floor(i / n)),
        description
      );
      if (hint) results.push(hint);
    }


    const tryDiagParity = (diagIndices, dirLabel, crossBoard, internal) => {
      const parity = n % 2 === 0 ? 'even' : 'odd';
      const reason = crossBoard && internal
        ? `Every board is paired with another board that's its ${dirLabel} reflection, and each also has that symmetry internally`
        : internal
        ? `Each board independently has ${dirLabel} diagonal symmetry`
        : `Every board is paired with another board that's its ${dirLabel} reflection`;

      const diagStars  = diagIndices.filter(i => this.vState(i) === CELL.STAR).length;
      const diagEmpties = diagIndices.filter(i => this.vState(i) === CELL.NONE);

      if (diagEmpties.length === 1) {
        const needStar = (diagStars % 2) !== (n % 2);
        const idx   = diagEmpties[0];
        const color = needStar ? HINT_COLOR.TARGET_STAR : HINT_COLOR.TARGET;
        results.push({
          description: `${reason}, so by parity the diagonal must have an ${parity} number of stars — this cell must be a ${needStar ? 'star' : 'dot'}.`,
          highlights: diagIndices.filter(i => this.vState(i) === CELL.STAR)
            .map(i => ({ idx: i, color: HINT_COLOR.SOURCE })),
          marks: [{ idx, color }],
          boardIdx: undefined
        });
      } else if (diagEmpties.length >= 2) {
        if ((diagStars % 2) !== (n % 2)) return;
        // All empties must mutually see each other (adjacency or same region on any board).
        const allSeeEachOther = diagEmpties.every((a, ai) => diagEmpties.every((b, bi) => {
          if (ai === bi) return true;
          const ra = Math.floor(a / n), ca = a % n;
          const rb = Math.floor(b / n), cb = b % n;
          return (Math.abs(ra - rb) <= 1 && Math.abs(ca - cb) <= 1)
            || this.game.regions.some(r => r[a] === r[b] && r[a] !== '*');
        }));
        if (!allSeeEachOther) return;
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

  p._hintSymmetryFill = function (mirrorFn, description) {
    const starMarks = [];
    const dotMarks  = [];

    for (let i = 0; i < this.n * this.n; i++) {
      if (this.vState(i) !== CELL.NONE) continue;
      const mirror = mirrorFn(i);
      if (mirror === i) continue;

      const mirrorState = this.vState(mirror);
      if (mirrorState === CELL.STAR) {
        starMarks.push({ idx: i, color: HINT_COLOR.TARGET_STAR });
      } else if (mirrorState === CELL.DOT) {
        dotMarks.push({ idx: i, color: HINT_COLOR.TARGET });
      }
    }

    const marks = starMarks.length > 0 ? starMarks : dotMarks;
    if (marks.length === 0) return null;

    const filling = starMarks.length > 0 ? 'stars' : 'dots';
    return {
      description: `${description} You can copy ${filling} across by symmetry.`,
      highlights: marks.map(({ idx }) => ({
        idx: mirrorFn(idx), color: HINT_COLOR.SOURCE
      })),
      marks,
      boardIdx: undefined
    };
  };

  // --- Rule list for starsPerGroup === 1 ---
  //
  // Kept as the single source of truth for hint ordering/priority; getHint()
  // in solver-core.js just picks between this and _getMultiStarRuleList().
  p._getSingleStarRuleList = function () {
    return [
      // Error validation
      { key: 'checkForErrors',           fn: () => this.hintCheckForErrors() },
      { key: 'alreadySolved',            fn: () => this.hintAlreadySolved() },
      // Beginner
      { key: 'singleCellRegion',         fn: () => this.hintSingleCellRegion() },
      { key: 'onlyEmpty',                fn: () => this.hintOnlyEmpty() },
      { key: 'excludeAdjacency',         fn: () => this.hintExcludeAdjacency() },
      { key: 'excludeSolvedUnit',        fn: () => this.hintExcludeSolvedUnit() },
      { key: 'domino',                   fn: () => this.hintDomino() },
      { key: 'unitSeesTooMuch',          fn: () => this.hintUnitSeesTooMuch() },
      { key: 'unitRegionSync1',          fn: () => this.hintUnitRegionSync(1) },
      // Medium
      { key: 'seesTooMuch2',             fn: () => this.hintSeesTooMuch(2) },
      { key: 'seesTooMuch3',             fn: () => this.hintSeesTooMuch(3) },
      { key: 'seesTooMuchAll',           fn: () => this.hintSeesTooMuch(null) },
      { key: 'unitRegionSync2',          fn: () => this.hintUnitRegionSync(2) },
      { key: 'symmetryFill',            fn: () => this.hintSymmetryFill() },
      // Hard
      { key: 'unitRegionSync3',          fn: () => this.hintUnitRegionSync(3) },
      { key: 'disjointUnitRegionSync2',  fn: () => this.hintDisjointUnitRegionSync(2) },
      { key: 'rowColLineSync2',          fn: () => this.hintRowColLineSync(2) },
      { key: 'manyRegionsSync',          fn: () => this.hintManyRegionsSync() },
      { key: 'regionSubsetSync1',        fn: () => this.hintRegionSubsetSync(1) },
      { key: 'symmetryDeduction',        fn: () => this.hintSymmetryDeduction() },
      // Expert
      { key: 'disjointUnitRegionSync3',  fn: () => this.hintDisjointUnitRegionSync(3) },
      { key: 'rowColLineSync3',          fn: () => this.hintRowColLineSync(3) },
      { key: 'crossBoardPinned2Row',     fn: () => this.hintCrossBoardRegionPinned(2, "Row") },
      { key: 'crossBoardPinned2Col',     fn: () => this.hintCrossBoardRegionPinned(2, "Column") },
      { key: 'crossBoardPinned3Row',     fn: () => this.hintCrossBoardRegionPinned(3, "Row") },
      { key: 'crossBoardPinned3Col',     fn: () => this.hintCrossBoardRegionPinned(3, "Column") },
      { key: 'partialOverlap',           fn: () => this.hintPartialOverlap() },
      { key: 'lookaheadHalfSingleBoard', fn: () => this.hintLookaheadHalfSingleBoard() },
      { key: 'lookaheadHalf',            fn: () => this.hintLookaheadHalf() },
      { key: 'regionSubsetSync2',        fn: () => this.hintRegionSubsetSync(2) },
      // Grandmaster
      { key: 'lookahead1',              fn: () => this.hintLookahead(1) },
      { key: 'lookahead2',              fn: () => this.hintLookahead(2) },
      { key: 'lookahead3',              fn: () => this.hintLookahead(3) },
      { key: 'lookahead8',              fn: () => this.hintLookahead(8) },
      { key: 'fromSolution',            fn: () => this.hintFromSolution() },
    ];
  };
}
