import { CELL } from './constants.js';

export class PuzzleSolver {
  // --- Setup & Utilities ---
  constructor(game) {
    this.game = game;
    this.n = game.n;
    this.starsPerGroup = game.starsPerGroup || 1;

    // --- NEW: Track void cell indices virtually ---
    this.voidIndices = new Set();
    if (this.game.regions) {
      this.game.regions.forEach((regionString) => {
        for (let i = 0; i < regionString.length; i++) {
          if (regionString[i] === '*') {
            this.voidIndices.add(i);
          }
        }
      });
    }

    // Precompute values required by multiple hint functions.
    this.units = this.getAllUnits();
    this.axisIndices = {
      Row: this.getAxisIndices("Row"),
      Column: this.getAxisIndices("Column"),
    };

    // Precompute and cache board symmetry properties.
    const mainDiagFn = i => (i % this.n) * this.n + Math.floor(i / this.n);
    const antiDiagFn = i => (this.n-1 - i%this.n) * this.n + (this.n-1 - Math.floor(i/this.n));
    const numBoards = this.game.regions.length;
    this.isMainDiagonalSymmetric = (numBoards === 2 && this._isBoardSymmetric(mainDiagFn)) || this._computeInternalDiagonalSymmetry(mainDiagFn);
    this.isAntiDiagonalSymmetric = (numBoards === 2 && this._isBoardSymmetric(antiDiagFn)) || this._computeInternalDiagonalSymmetry(antiDiagFn);
    // Track specific symmetry types for hint descriptions.
    this.mainDiagCrossBoard   = (numBoards === 2) && this._isBoardSymmetric(mainDiagFn);
    this.mainDiagInternal     = this._computeInternalDiagonalSymmetry(mainDiagFn);
    this.antiDiagCrossBoard   = (numBoards === 2) && this._isBoardSymmetric(antiDiagFn);
    this.antiDiagInternal     = this._computeInternalDiagonalSymmetry(antiDiagFn);
    this.internalRotation180   = this._computeInternalRotation180();
    this.crossboardRotation180 = (numBoards === 2) && this._computeCrossboardRotation180();

    // Hint cycling state.
    this.lastStateString  = null;
    this.currentHintType  = null;
    this.currentHintIndex = 0;
  }

  // --- NEW: Virtual State Interceptor ---
  // Pretends void cells are DOTS without mutating this.game.state (keeping GUI clean)
  vState(idx, stateArray = this.game.state) {
    if (this.voidIndices.has(idx)) return CELL.DOT;
    return stateArray[idx];
  }

  // Get all units (rows, columns, and regions).
  getAllUnits() {
    const n = this.n;
    const units = [];

    // Rows (Shared)
    for (let r = 0; r < n; r++) {
      const indices = Array.from({ length: n }, (_, k) => r * n + k);
      units.push({ indices, label: `Row ${r + 1}` });
    }

    // Columns (Shared)
    for (let c = 0; c < n; c++) {
      const indices = Array.from({ length: n }, (_, k) => k * n + c);
      units.push({ indices, label: `Column ${String.fromCharCode(65 + c)}` });
    }

    if (!this.game.regions) {
      console.error("Regions data is missing from the game instance!");
      return units;
    }

    // Regions (board-specific indices)
    this.game.regions.forEach((regionString, boardIdx) => {
      // FIX: Filter out '*' so it doesn't create phantom regions
      const regionIds = [...new Set(regionString.split(''))].filter(id => id !== '*');
      regionIds.forEach(id => {
        const indices = [];
        for (let j = 0; j < regionString.length; j++) {
          if (regionString[j] === id) indices.push(j);
        }
        units.push({ 
          indices, 
          label: `Board ${boardIdx + 1} Region ${id}`,
          boardIdx: boardIdx 
        });
      });
    });

    return units;
  }

  // Get unsolved regions on the specified board.
  getUnsolvedRegions(boardIdx) {
    return this.units.filter(u =>
      u.label.includes("Region") &&
      u.boardIdx === boardIdx &&
      !u.indices.some(i => this.vState(i) === CELL.STAR)
    );
  }

  // Get cell indices grouped by axis (Row or Column).
  getAxisIndices(axis) {
    const n = this.n;
    const result = [];
    for (let i = 0; i < n; i++) {
      const unitIdxs = [];
      for (let j = 0; j < n; j++) {
        unitIdxs.push(axis === "Row" ? i * n + j : j * n + i);
      }
      result.push(unitIdxs);
    }
    return result;
  }

  // Map cell indices to region labels.
  buildCellToRegionMap(boardIdx) {
    const map = {};
    this.units
      .filter(u => u.label.includes("Region") && u.boardIdx === boardIdx)
      .forEach(reg => reg.indices.forEach(idx => { map[idx] = reg.label; }));
    return map;
  }

  // Get adjacent neighbor cell indices (8-way).
  getNeighbors(idx) {
    const n = this.n;
    const row = Math.floor(idx / n);
    const col = idx % n;
    const neighbors = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = row + dr, nc = col + dc;
        if (nr >= 0 && nr < n && nc >= 0 && nc < n) {
          neighbors.push(nr * n + nc);
        }
      }
    }
    return neighbors;
  }

  // Generate combinations of size k.
  getCombinations(array, k) {
    const result = [];
    const fn = (start, prev) => {
      if (prev.length === k) {
        result.push(prev);
        return;
      }
      for (let i = start; i < array.length; i++) {
        fn(i + 1, [...prev, array[i]]);
      }
    };
    fn(0, []);
    return result;
  }

  _areDisjoint(sets) {
    const seen = new Set();
    for (const s of sets) {
      for (const item of s) {
        if (seen.has(item)) return false;
        seen.add(item);
      }
    }
    return true;
  }

  // Find all regions containing the cell.
  _getRegionsContaining(idx) {
    return this.units.filter(u => u.label.includes("Region") && u.indices.includes(idx));
  }

  // --- Hint Dispatch ---

  getHint() {
    let rules = [];
    if (this.starsPerGroup === 1) {
      rules = [
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
        { key: 'crossBoardPinned2Col',     fn: () => this.hintCrossBoardRegionPinned(2, "Col") },
        { key: 'crossBoardPinned3Row',     fn: () => this.hintCrossBoardRegionPinned(3, "Row") },
        { key: 'crossBoardPinned3Col',     fn: () => this.hintCrossBoardRegionPinned(3, "Col") },
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
    } else {
      rules = [
        // Error validation
        { key: 'checkForErrors',           fn: () => this.hintCheckForErrors() },
        { key: 'alreadySolved',            fn: () => this.hintAlreadySolved() },
        // Multi-star validated/compatible rules
        { key: 'onlyEmpty',                fn: () => this.hintOnlyEmpty() },
        { key: 'excludeAdjacency',         fn: () => this.hintExcludeAdjacency() },
        { key: 'excludeSolvedUnit',        fn: () => this.hintExcludeSolvedUnit() },
        { key: 'unitRegionSync1',          fn: () => this.hintUnitRegionSync(1) },
        { key: 'unitRegionSync2',          fn: () => this.hintUnitRegionSync(2) },
        { key: 'unitRegionSync3',          fn: () => this.hintUnitRegionSync(3) },
        { key: 'unitRegionSync4',          fn: () => this.hintUnitRegionSync(4) },
        { key: 'regionSubsetSync1',        fn: () => this.hintRegionSubsetSync(1) },
        { key: 'regionSubsetSync2',        fn: () => this.hintRegionSubsetSync(2) },
        { key: 'fromSolution',            fn: () => this.hintFromSolution() },
      ];
    }

    // Detect board-state changes; reset cycling when the board changes.
    const stateString = this.game.state.join(',');
    if (stateString !== this.lastStateString) {
      this.lastStateString  = stateString;
      this.currentHintType  = null;
      this.currentHintIndex = 0;
    }

    for (const { key, fn } of rules) {
      const hints = fn();
      if (!hints || hints.length === 0) continue;

      // If a different (earlier) rule fires, reset the cycling index and re-shuffle.
      if (key !== this.currentHintType) {
        this.currentHintType  = key;
        this.currentHintIndex = 0;
        this.currentHints     = hints.slice().sort(() => Math.random() - 0.5);
      }

      const hint = this.currentHints[this.currentHintIndex % this.currentHints.length];
      this.currentHintIndex++;
      return hint;
    }
    return null;
  }

  hintCheckForErrors() {
    const n = this.n;
    const highlights = [];

    for (let i = 0; i < n * n; i++) {
      // FIX: Ensure stars placed manually on void cells register as an error
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
  }

  // Rule: Check if the puzzle is already solved.
  hintAlreadySolved() {
    // FIX: Use vState to safely match end solution conditions
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
  }

  // Rule: Check for unsolved regions containing exactly one cell.
  hintSingleCellRegion() {
    const candidates = [];
    for (let bIdx = 0; bIdx < this.game.regions.length; bIdx++) {
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
      highlights: [{ idx: region.indices[0], color: 'hint-target-green' }],
      marks: [],
      boardIdx: region.boardIdx
    }));
  }

  // Rule: Check for units where empty cells equal the remaining needed stars.
  hintOnlyEmpty() {
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
  }

  // Rule: Check for units that already have all their stars placed.
  hintExcludeSolvedUnit() {
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
  }

  // Rule: Check for empty cells adjacent to placed stars.
  hintExcludeAdjacency() {
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
  }

  // Rule: Check for domino patterns in unsolved regions.
  hintDomino() {
    const n = this.n;
    const candidates = [];

    for (let bIdx = 0; bIdx < this.game.regions.length; bIdx++) {
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
        { idx: idxA, color: 'hint-source-blue' },
        { idx: idxB, color: 'hint-source-blue' }
      ],
      marks: targets.map(idx => ({ idx, color: 'hint-target-yellow' })),
      boardIdx
    }));
  }

  // Check "N units covered by N regions" deduction.
  _hintUnitsCoveredByRegions(unitCombo, bIdx, axis) {
    const windowIndices = unitCombo.flat();
    const windowSet = new Set(windowIndices);

    const starsInWindow = windowIndices.filter(i => this.vState(i) === CELL.STAR).length;
    const requiredCount = unitCombo.length - starsInWindow;
    if (requiredCount <= 0) return null;

    const availInUnits = windowIndices.filter(i => this.vState(i) === CELL.NONE);
    if (availInUnits.length === 0) return null;

    const unsolvedRegs = this.getUnsolvedRegions(bIdx);
    const cellToRegionMap = this.buildCellToRegionMap(bIdx);

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
      ).map(idx => ({ idx, color: 'hint-source-blue' })),
      marks: targets.map(idx => ({ idx, color: 'hint-target-yellow' }))
    };
  }

  // Check "N regions trapped in N units" deduction.
  _hintRegionsTrappedInUnits(windowIndices, bIdx, axis) {
    const windowSet = new Set(windowIndices.flat());
    const allIndices = windowIndices.flat();

    const starsInWindow = allIndices.filter(i => this.vState(i) === CELL.STAR).length;
    const requiredCount = windowIndices.length - starsInWindow;
    if (requiredCount <= 0) return null;

    const unsolvedRegs = this.getUnsolvedRegions(bIdx);
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
      ).map(idx => ({ idx, color: 'hint-source-blue' })),
      marks: targets.map(idx => ({ idx, color: 'hint-target-yellow' }))
    };
  }

  // Find all synchronization hints for a window size of N.
  _hintWindowRegionSyncAll(N, axis, adjacent) {
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
    for (let bIdx = 0; bIdx < this.game.regions.length; bIdx++) {
      for (const windowIndices of windows) {

        const standard = this._hintRegionsTrappedInUnits(windowIndices, bIdx, axis);
        if (standard) candidates.push(standard);

        const inverse = this._hintUnitsCoveredByRegions(windowIndices, bIdx, axis);
        if (inverse) candidates.push(inverse);
      }
    }
    return candidates;
  }

  _hintWindowRegionSync(N, axis, adjacent) {
    const candidates = this._hintWindowRegionSyncAll(N, axis, adjacent);
    if (candidates.length === 0) return null;
    return candidates;
  }

  // Rule: Check for N adjacent rows/columns synchronized with N regions.
  hintUnitRegionSync(N) {
    const candidates = [];
    for (const axis of ["Row", "Column"]) {
      const hints = this._hintWindowRegionSyncAll(N, axis, true);
      candidates.push(...hints);
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (a.highlights[0]?.idx ?? 0) - (b.highlights[0]?.idx ?? 0));
    return candidates;
  }

  // Rule: Check region synchronization for 4+ rows/columns.
  hintManyRegionsSync() {
    const candidates = [];
    for (let n = 4; n < this.n; n++) {
      for (const axis of ["Row", "Column"]) {
        candidates.push(...this._hintWindowRegionSyncAll(n, axis, true));
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (a.highlights[0]?.idx ?? 0) - (b.highlights[0]?.idx ?? 0));
    return candidates;
  }

  // Check "N rows/cols whose empties are confined to N cells of the other axis" deduction.
  // This is the cross-axis analogue of _hintRegionsTrappedInUnits: instead of trapping N
  // rows/cols inside N regions, it traps N rows inside N columns (or vice versa) directly,
  // with no region information involved at all.
  _hintAxisLineTrapped(unitCombo, axisLabel) {
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
      highlights: availInUnits.filter(i => !targetSet.has(i)).map(idx => ({ idx, color: 'hint-source-blue' })),
      marks: targets.map(idx => ({ idx, color: 'hint-target-yellow' })),
    };
  }

  // Find all row<->column line-sync hints for a window size of N.
  _hintAxisLineSyncAll(N, axis) {
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
  }

  // Rule: N rows (or N columns) whose empty cells are confined to N columns (or N rows) —
  // no region information needed, works identically on regular and irregular boards.
  hintRowColLineSync(N) {
    const candidates = [];
    for (const axis of ["Row", "Column"]) {
      candidates.push(...this._hintAxisLineSyncAll(N, axis));
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (a.highlights[0]?.idx ?? a.marks[0]?.idx ?? 0) - (b.highlights[0]?.idx ?? b.marks[0]?.idx ?? 0));
    return candidates;
  }

  // Helper to find external cells that see all options in a unit.
  _hintSeesTooMuchForUnits(units) {
    const n = this.n;
    const hintCandidates = [];
    for (const unit of units) {
      const candidates = unit.indices.filter(i => this.vState(i) === CELL.NONE);
      if (candidates.length === 0) continue;

      const candCoords = candidates.map(i => ({ r: Math.floor(i / n), c: i % n }));
      const targets = [];

      for (let i = 0; i < n * n; i++) {
        if (this.vState(i) !== CELL.NONE || unit.indices.includes(i)) continue;
        const ir = Math.floor(i / n), ic = i % n;
        const canSeeAll = candCoords.every(({ r, c }) =>
          ir === r || ic === c || (Math.abs(ir - r) <= 1 && Math.abs(ic - c) <= 1)
        );
        if (canSeeAll) targets.push({ idx: i, color: 'hint-target-yellow' });
      }

      if (targets.length > 0) hintCandidates.push({ unit, candidates, targets });
    }
    if (hintCandidates.length === 0) return null;
    hintCandidates.sort((a, b) => a.candidates[0] - b.candidates[0]);
    return hintCandidates.map(({ unit, candidates, targets }) => ({
      boardIdx: unit.boardIdx,
      description: `The blue cells must contain a star.`,
      highlights: candidates.map(i => ({ idx: i, color: 'hint-source-blue' })),
      marks: targets,
    }));
  }

  // Rule: Check rows/columns where all empty cells are visible to an external cell.
  hintUnitSeesTooMuch() {
    const rowColUnits = this.units.filter(u =>
      !u.label.includes("Region") &&
      !u.indices.some(i => this.vState(i) === CELL.STAR)
    );
    return this._hintSeesTooMuchForUnits(rowColUnits);
  }

  // Rule: Check regions where all empty cells are visible to an external cell.
  hintSeesTooMuch(nTarget = null) {
    const regionUnits = Array.from({ length: this.game.regions.length }, (_, bIdx) => bIdx)
      .flatMap(bIdx => this.getUnsolvedRegions(bIdx))
      .filter(u => nTarget === null || u.indices.filter(i => this.vState(i) === CELL.NONE).length === nTarget);
    return this._hintSeesTooMuchForUnits(regionUnits);
  }

  // Rule: Check disjoint units synchronized with regions.
  hintDisjointUnitRegionSync(N) {
    const candidates = [];
    for (const axis of ["Row", "Column"]) {
      const hints = this._hintWindowRegionSyncAll(N, axis, false);
      candidates.push(...hints);
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (a.highlights[0]?.idx ?? 0) - (b.highlights[0]?.idx ?? 0));
    return candidates;
  }

  // Rule: Identify subsets where regions are nested within others.
  hintRegionSubsetSync(N) {
    const comboSets = [];

    for (let bIdx = 0; bIdx < this.game.regions.length; bIdx++) {
      for (const combo of this.getCombinations(this.getUnsolvedRegions(bIdx), N)) {
        comboSets.push({
          label: `Board ${bIdx + 1} Combo (${combo.map(r => r.label.split(' ').pop()).join(',')})`,
          indices: new Set(combo.flatMap(r => r.indices.filter(i => this.vState(i) !== CELL.DOT))),
          boardIdx: bIdx,
          regions: combo
        });
      }
    }

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

        if (targets.length > 0) candidates.push({ setA, targets });
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (a.targets[0] ?? 0) - (b.targets[0] ?? 0));
    return candidates.map(({ setA, targets }) => this.formatSubsetHint(setA.regions, targets, setA.boardIdx));
  }

  // Rule: Check cross-board pinned regions.
  hintCrossBoardRegionPinned(N, axis = "Row") {
    const n = this.n;

    // Build unsolved region descriptors from both boards
    const unsolvedRegions = Array.from({ length: this.game.regions.length }, (_, bIdx) => bIdx).flatMap(bIdx =>
      this.getUnsolvedRegions(bIdx)
      .filter(reg => reg.indices.some(i => this.vState(i) === CELL.NONE))
      .map(reg => ({
        label: `B${bIdx + 1}-${reg.label.split(' ').pop()}`,
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
  }


  // Rule: Check overlapping regions across boards.
  hintPartialOverlap() {
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

            if (shared.length === 0 || disjoint.length === 0) continue;

            const sees = (i, j) => {
              const ri = Math.floor(i / n), ci = i % n;
              const rj = Math.floor(j / n), cj = j % n;
              return ri === rj || ci === cj || (Math.abs(ri - rj) <= 1 && Math.abs(ci - cj) <= 1);
            };

            const onlyASeesAllOnlyB = onlyA.every(a => onlyB.every(b => sees(a, b)));
            if (!onlyASeesAllOnlyB) continue;

            const targets = shared.filter(i => this.vState(i) === CELL.NONE);
            if (targets.length === 0) continue;

            candidates.push({ shared, onlyA, onlyB });
          }
        }
      }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (a.shared[0] ?? 0) - (b.shared[0] ?? 0));
    return candidates.map(({ shared, onlyA, onlyB }) => ({
      boardIdx: undefined,
      description: `These two regions overlap. Any star placed in a non-shared cell would see all the non-shared cells of the other region, making that region unsolvable. Both stars must land in the shared cells.`,
      highlights: shared
        .filter(i => this.vState(i) === CELL.NONE)
        .map(i => ({ idx: i, color: 'hint-source-blue' })),
      marks: [
        ...onlyA.filter(i => this.vState(i) === CELL.NONE).map(i => ({ idx: i, color: 'hint-target-yellow' })),
        ...onlyB.filter(i => this.vState(i) === CELL.NONE).map(i => ({ idx: i, color: 'hint-target-yellow' })),
      ]
    }));
  }

  // Rule: Lookahead level 1 (check single-star placement contradiction within single board constraints).
  hintLookaheadHalfSingleBoard() {
    const n = this.n;
    const candidates = [];

    const emptyIndices = this.game.state
      .flatMap((val, idx) => this.vState(idx) === CELL.NONE ? [idx] : []);

    for (const testIdx of emptyIndices) {
      const row = Math.floor(testIdx / n);
      const col = testIdx % n;

      for (let bIdx = 0; bIdx < this.game.regions.length; bIdx++) {
        const boardReg = this._getRegionsContaining(testIdx)
          .find(r => r.boardIdx === bIdx);
        if (!boardReg) continue; 

        // Build simulated sandbox layout populated with the virtual void dots
        const sandboxState = [...this.game.state];
        this.voidIndices.forEach(idx => { sandboxState[idx] = CELL.DOT; });
        sandboxState[testIdx] = CELL.STAR;

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

        // Region elimination for this board only.
        boardReg.indices.forEach(i => {
          if (sandboxState[i] === CELL.NONE) sandboxState[i] = CELL.DOT;
        });

        const broken = this._findBrokenUnit(sandboxState);
        if (!broken) continue;

        if (broken.type === 'region' && broken.boardIdx !== bIdx) continue;

        candidates.push({ testIdx, broken, boardIdx: bIdx });
      }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.testIdx - b.testIdx);
    return candidates.map(({ testIdx, broken, boardIdx }) => ({
      boardIdx: boardIdx,
      description: `The blue cells must contain a star. This is impossible if the circled cell holds a star.`,
      highlights: broken.indices.map(idx => ({ idx, color: 'hint-source-blue' })),
      marks: [{ idx: testIdx, color: 'hint-target-yellow' }]
    }));
  }

  // Rule: Lookahead level 1 (check single-star placement contradiction across both boards).
  hintLookaheadHalf() {
    const n = this.n;
    const candidates = [];

    const emptyIndices = this.game.state
      .flatMap((val, idx) => this.vState(idx) === CELL.NONE ? [idx] : []);

    for (const testIdx of emptyIndices) {
      // Build simulated sandbox layout populated with the virtual void dots
      const sandboxState = [...this.game.state];
      this.voidIndices.forEach(idx => { sandboxState[idx] = CELL.DOT; });
      sandboxState[testIdx] = CELL.STAR;

      const row = Math.floor(testIdx / n);
      const col = testIdx % n;

      for (let j = 0; j < n; j++) {
        const rIdx = row * n + j;
        const cIdx = j * n + col;
        if (sandboxState[rIdx] === CELL.NONE && rIdx !== testIdx) sandboxState[rIdx] = CELL.DOT;
        if (sandboxState[cIdx] === CELL.NONE && cIdx !== testIdx) sandboxState[cIdx] = CELL.DOT;
      }

      for (const nb of this.getNeighbors(testIdx)) {
        if (sandboxState[nb] === CELL.NONE) sandboxState[nb] = CELL.DOT;
      }

      for (const reg of this._getRegionsContaining(testIdx)) {
        reg.indices.forEach(i => {
          if (sandboxState[i] === CELL.NONE) sandboxState[i] = CELL.DOT;
        });
      }

      const broken = this._findBrokenUnit(sandboxState);
      if (broken) candidates.push({ testIdx, broken });
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.testIdx - b.testIdx);
    return candidates.map(({ testIdx, broken }) => ({
      boardIdx: broken.type === 'region' ? broken.boardIdx : undefined,
      description: `The blue cells must contain a star. This is impossible if the circled cell holds a star.`,
      highlights: broken.indices.map(idx => ({ idx, color: 'hint-source-blue' })),
      marks: [{ idx: testIdx, color: 'hint-target-yellow' }]
    }));
  }

  // Rule: Multi-stage lookahead for contradiction checking.
  hintLookahead(nStages) {
    const n = this.n;
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
  }

  _isBoardSymmetric(mirrorFn) {
    if (this.game.regions.length !== 2) return false;
    const n = this.n;
    const [r1, r2] = this.game.regions;
    for (let i = 0; i < n * n; i++) {
      const mirror = mirrorFn(i);
      for (let j = i + 1; j < n * n; j++) {
        const mj = mirrorFn(j);
        const sameRegionBoard1 = r1[i] === r1[j];
        const sameRegionBoard2 = r2[mirror] === r2[mj];
        if (sameRegionBoard1 !== sameRegionBoard2) return false;
      }
    }
    return true;
  }

  _computeInternalDiagonalSymmetry(mirrorFn) {
    const total = this.n * this.n;
    for (const r of this.game.regions) {
      for (let i = 0; i < total; i++) {
        const mi = mirrorFn(i);
        for (let j = i + 1; j < total; j++) {
          const mj = mirrorFn(j);
          if ((r[i] === r[j]) !== (r[mi] === r[mj])) return false;
        }
      }
    }
    return true;
  }

  _computeInternalRotation180() {
    const total = this.n * this.n;
    const mirrorFn = i => total - 1 - i;
    for (const r of this.game.regions) {
      for (let i = 0; i < total; i++) {
        for (let j = i + 1; j < total; j++) {
          if ((r[i] === r[j]) !== (r[mirrorFn(i)] === r[mirrorFn(j)])) return false;
        }
      }
    }
    return true;
  }

  _computeCrossboardRotation180() {
    if (this.game.regions.length !== 2) return false;
    const total = this.n * this.n;
    const mirrorFn = i => total - 1 - i;
    const [r1, r2] = this.game.regions;
    for (let i = 0; i < total; i++) {
      for (let j = i + 1; j < total; j++) {
        const sameOnBoard1 = r1[i] === r1[j];
        const sameOnBoard2Mirrored = r2[mirrorFn(i)] === r2[mirrorFn(j)];
        if (sameOnBoard1 !== sameOnBoard2Mirrored) return false;
      }
    }
    return true;
  }

  _hintSymmetry(mirrorFn, description) {
    const n = this.n;
    const cellToRegionMaps = this.game.regions.map((_, bIdx) => this.buildCellToRegionMap(bIdx));

    const marks = [];
    for (let i = 0; i < n * n; i++) {
      if (this.vState(i) !== CELL.NONE) continue;

      const mirror = mirrorFn(i);
      if (mirror === i) continue;

      const r  = Math.floor(i / n),      c  = i % n;
      const mr = Math.floor(mirror / n), mc = mirror % n;

      const seesOwnMirror =
        r === mr || c === mc ||
        this.getNeighbors(i).includes(mirror) ||
        cellToRegionMaps.some(map => map[i] && map[i] === map[mirror]);

      if (seesOwnMirror) marks.push({ idx: i, color: 'hint-target-yellow' });
    }

    if (marks.length === 0) return null;

    return { description, highlights: [], marks, boardIdx: undefined };
  }

  hintSymmetryFill() {
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
  }


  // Rule: diagonal-parity constraint.
  // When the puzzle has diagonal symmetry the number of stars on that diagonal
  // must share the same parity as N (even N → even count, odd N → odd count).
  hintSymmetryDeduction() {
    const n = this.n;
    const results = [];

    if (this.internalRotation180 || this.crossboardRotation180) {
      const description = this.internalRotation180 && this.crossboardRotation180
        ? `Each board has 180° rotational symmetry, and the boards are also 180° rotations of each other. Any cell that "sees" its own rotation cannot be a star.`
        : this.internalRotation180
        ? `Each board independently has 180° rotational symmetry. Any cell that "sees" its own rotation cannot be a star.`
        : `The two boards are 180° rotations of each other. Any cell that "sees" its counterpart on the rotated board cannot be a star.`;
      const hint = this._hintSymmetry(i => (n * n - 1) - i, description);
      if (hint) results.push(hint);
    }

    if (this.isMainDiagonalSymmetric) {
      const description = this.mainDiagCrossBoard && this.mainDiagInternal
        ? `The two boards are reflections of each other across the main diagonal (↘), and each board also has that symmetry internally. The solution must be symmetric, so any cell that "sees" its own reflection cannot be a star.`
        : this.mainDiagInternal
        ? `Each board independently has diagonal symmetry across the main diagonal (↘). The solution must be symmetric, so any cell that "sees" its own reflection cannot be a star.`
        : `The two boards are reflections of each other across the main diagonal (↘). The solution must be symmetric, so any cell that "sees" its own reflection cannot be a star.`;
      const hint = this._hintSymmetry(i => (i % n) * n + Math.floor(i / n), description);
      if (hint) results.push(hint);
    }

    if (this.isAntiDiagonalSymmetric) {
      const description = this.antiDiagCrossBoard && this.antiDiagInternal
        ? `The two boards are reflections of each other across the anti-diagonal (↙), and each board also has that symmetry internally. The solution must be symmetric, so any cell that "sees" its own reflection cannot be a star.`
        : this.antiDiagInternal
        ? `Each board independently has diagonal symmetry across the anti-diagonal (↙). The solution must be symmetric, so any cell that "sees" its own reflection cannot be a star.`
        : `The two boards are reflections of each other across the anti-diagonal (↙). The solution must be symmetric, so any cell that "sees" its own reflection cannot be a star.`;
      const hint = this._hintSymmetry(
        i => (n - 1 - i % n) * n + (n - 1 - Math.floor(i / n)),
        description
      );
      if (hint) results.push(hint);
    }


    const tryDiagParity = (diagIndices, dirLabel, crossBoard, internal) => {
      const parity = n % 2 === 0 ? 'even' : 'odd';
      const reason = crossBoard && internal
        ? `The boards are ${dirLabel} reflections of each other and each has that symmetry internally`
        : internal
        ? `Each board independently has ${dirLabel} diagonal symmetry`
        : `The boards are ${dirLabel} reflections of each other`;

      const diagStars  = diagIndices.filter(i => this.vState(i) === CELL.STAR).length;
      const diagEmpties = diagIndices.filter(i => this.vState(i) === CELL.NONE);

      if (diagEmpties.length === 1) {
        const needStar = (diagStars % 2) !== (n % 2);
        const idx   = diagEmpties[0];
        const color = needStar ? 'hint-target-green' : 'hint-target-yellow';
        results.push({
          description: `${reason}, so by parity the diagonal must have an ${parity} number of stars — this cell must be a ${needStar ? 'star' : 'dot'}.`,
          highlights: diagIndices.filter(i => this.vState(i) === CELL.STAR)
            .map(i => ({ idx: i, color: 'hint-source-blue' })),
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
            .map(i => ({ idx: i, color: 'hint-source-blue' })),
          marks: diagEmpties.map(i => ({ idx: i, color: 'hint-target-yellow' })),
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
  }

  _hintSymmetryFill(mirrorFn, description) {
    const starMarks = [];
    const dotMarks  = [];

    for (let i = 0; i < this.n * this.n; i++) {
      if (this.vState(i) !== CELL.NONE) continue;
      const mirror = mirrorFn(i);
      if (mirror === i) continue;

      const mirrorState = this.vState(mirror);
      if (mirrorState === CELL.STAR) {
        starMarks.push({ idx: i, color: 'hint-target-green' });
      } else if (mirrorState === CELL.DOT) {
        dotMarks.push({ idx: i, color: 'hint-target-yellow' });
      }
    }

    const marks = starMarks.length > 0 ? starMarks : dotMarks;
    if (marks.length === 0) return null;

    const filling = starMarks.length > 0 ? 'stars' : 'dots';
    return {
      description: `${description} You can copy ${filling} across by symmetry.`,
      highlights: marks.map(({ idx }) => ({
        idx: mirrorFn(idx), color: 'hint-source-blue'
      })),
      marks,
      boardIdx: undefined
    };
  }

  hintFromSolution() {
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
  }

  // --- Hint Formatters ---

  formatSubsetHint(sourceRegs, targets, bIdx) {
    const targetSet = new Set(targets);
    const sourceHighlights = sourceRegs.flatMap(r =>
      r.indices.filter(i => this.vState(i) === CELL.NONE && !targetSet.has(i))
    ).map(idx => ({ idx, color: 'hint-source-blue' }));

    const description = sourceRegs.length === 1
      ? `One region is a subset of another.`
      : `${sourceRegs.length} regions are a subset of ${sourceRegs.length} other regions.`;

    return {
      boardIdx: undefined,
      description,
      highlights: sourceHighlights,
      marks: targets.map(idx => ({ idx, color: 'hint-target-yellow' }))
    };
  }

  formatCrossBoardHint(combo, targets, axis, uList) {
    const targetSet = new Set(targets);

    const sourceHighlights = combo.flatMap(r => 
      r.availableIdxs.filter(idx => !targetSet.has(idx))
    ).map(idx => ({ idx, color: 'hint-source-blue' }));

    return {
      boardIdx: undefined,
      description: `Cross-board: These ${combo.length} regions must place their stars in the same ${combo.length} ${axis.toLowerCase()}s.`,
      highlights: sourceHighlights,
      marks: targets.map(idx => ({ idx, color: 'hint-target-yellow' }))
    };
  }

  // --- Simulation ---

  _applySimulatedRules(state) {
    const n = this.n;

    for (let i = 0; i < state.length; i++) {
      if (state[i] !== CELL.STAR) continue;

      const row = Math.floor(i / n);
      const col = i % n;

      for (let j = 0; j < n; j++) {
        const rIdx = row * n + j;
        const cIdx = j * n + col;
        if (state[rIdx] === CELL.NONE && rIdx !== i) state[rIdx] = CELL.DOT;
        if (state[cIdx] === CELL.NONE && cIdx !== i) state[cIdx] = CELL.DOT;
      }

      for (const nb of this.getNeighbors(i)) {
        if (state[nb] === CELL.NONE) state[nb] = CELL.DOT;
      }

      for (const reg of this._getRegionsContaining(i)) {
        reg.indices.forEach(idx => {
          if (state[idx] === CELL.NONE) state[idx] = CELL.DOT;
        });
      }
    }

    for (const u of this.units) {
      const noneIndices = u.indices.filter(i => state[i] === CELL.NONE);
      const starIndices = u.indices.filter(i => state[i] === CELL.STAR);
      if (starIndices.length === 0 && noneIndices.length === 1) {
        state[noneIndices[0]] = CELL.STAR;
      }
    }
  }

  _findBrokenUnit(state) {
    const n = this.n;

    for (let r = 0; r < n; r++) {
      const indices = this.axisIndices.Row[r];
      if (!indices.some(i => state[i] === CELL.STAR) &&
        !indices.some(i => state[i] === CELL.NONE)) {
        return { type: 'row', label: `Row ${r + 1}`, indices };
      }
    }
    for (let c = 0; c < n; c++) {
      const indices = this.axisIndices.Column[c];
      if (!indices.some(i => state[i] === CELL.STAR) &&
        !indices.some(i => state[i] === CELL.NONE)) {
        return { type: 'col', label: `Column ${String.fromCharCode(65 + c)}`, indices };
      }
    }
    for (const unit of this.units.filter(u => u.label.includes('Region'))) {
      if (!unit.indices.some(i => state[i] === CELL.STAR) &&
        !unit.indices.some(i => state[i] === CELL.NONE)) {
        return { type: 'region', label: unit.label, indices: unit.indices, boardIdx: unit.boardIdx };
      }
    }

    for (let i = 0; i < state.length; i++) {
      if (state[i] === CELL.STAR) {
        if (this.getNeighbors(i).some(nb => state[nb] === CELL.STAR)) {
          return { type: 'adjacency', label: 'adjacency', indices: [] };
        }
      }
    }

    return null;
  }

  _isBoardBroken(state) {
    for (const indices of this.units.map(u => u.indices)) {
      const starCount = indices.filter(i => state[i] === CELL.STAR).length;
      const hasEmpty = indices.some(i => state[i] === CELL.NONE);
      if (starCount > 1) return true;
      if (starCount === 0 && !hasEmpty) return true;
    }
    for (let i = 0; i < state.length; i++) {
      if (state[i] === CELL.STAR) {
        if (this.getNeighbors(i).some(nb => state[nb] === CELL.STAR)) return true;
      }
    }
    return false;
  }
}
