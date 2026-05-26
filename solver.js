import { CELL } from './constants.js';

export class PuzzleSolver {
  // --- Setup & Utilities ---
  constructor(game) {
    this.game = game;
    this.n = game.n;

    // Precompute values required by multiple hint functions.
    this.units = this.getAllUnits();
    this.axisIndices = {
      Row: this.getAxisIndices("Row"),
      Column: this.getAxisIndices("Column"),
    };

    // Precompute and cache board symmetry properties.
    const mainDiagFn = i => (i % this.n) * this.n + Math.floor(i / this.n);
    const antiDiagFn = i => (this.n-1 - i%this.n) * this.n + (this.n-1 - Math.floor(i/this.n));
    this.isMainDiagonalSymmetric = this._isBoardSymmetric(mainDiagFn) || this._computeInternalDiagonalSymmetry(mainDiagFn);
    this.isAntiDiagonalSymmetric = this._isBoardSymmetric(antiDiagFn) || this._computeInternalDiagonalSymmetry(antiDiagFn);
    // Track specific symmetry types for hint descriptions.
    this.mainDiagCrossBoard   = this._isBoardSymmetric(mainDiagFn);
    this.mainDiagInternal     = this._computeInternalDiagonalSymmetry(mainDiagFn);
    this.antiDiagCrossBoard   = this._isBoardSymmetric(antiDiagFn);
    this.antiDiagInternal     = this._computeInternalDiagonalSymmetry(antiDiagFn);
    this.internalRotation180   = this._computeInternalRotation180();
    this.crossboardRotation180 = this._computeCrossboardRotation180();

    // Hint cycling state.
    this.lastStateString  = null;
    this.currentHintType  = null;
    this.currentHintIndex = 0;
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
      const regionIds = [...new Set(regionString.split(''))];
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
      !u.indices.some(i => this.game.state[i] === CELL.STAR)
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
    const rules = [
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
      { key: 'mainDiagonalFill',         fn: () => this.hintMainDiagonalFill() },
      { key: 'antiDiagonalFill',         fn: () => this.hintAntiDiagonalFill() },
      { key: 'rotation180Fill',          fn: () => this.hintRotation180Fill() },
      // Hard
      { key: 'unitRegionSync3',          fn: () => this.hintUnitRegionSync(3) },
      { key: 'disjointUnitRegionSync2',  fn: () => this.hintDisjointUnitRegionSync(2) },
      { key: 'manyRegionsSync',          fn: () => this.hintManyRegionsSync() },
      { key: 'regionSubsetSync1',        fn: () => this.hintRegionSubsetSync(1) },
      { key: 'rotation180',             fn: () => this.hintRotation180() },
      { key: 'diagonalReflection',       fn: () => this.hintDiagonalReflection() },
      // Expert
      { key: 'disjointUnitRegionSync3',  fn: () => this.hintDisjointUnitRegionSync(3) },
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

      // If a different (earlier) rule fires, reset the cycling index.
      if (key !== this.currentHintType) {
        this.currentHintType  = key;
        this.currentHintIndex = 0;
      }

      const hint = hints[this.currentHintIndex % hints.length];
      this.currentHintIndex++;
      return hint;
    }
    return null;
  }

  hintCheckForErrors() {
    const n = this.n;
    const highlights = [];

    for (let i = 0; i < n * n; i++) {
      const isWrong = (this.game.state[i] === CELL.STAR && this.game.solution[i] !== 'x')
        || (this.game.state[i] === CELL.DOT  && this.game.solution[i] === 'x');
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
    const isSolved = this.game.state.every((v, i) => 
      (this.game.solution[i] === 'x') ? v === CELL.STAR : v !== CELL.STAR
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
    for (let bIdx = 0; bIdx < 2; bIdx++) {
      for (const region of this.getUnsolvedRegions(bIdx)) {
        if (region.indices.length === 1 && this.game.state[region.indices[0]] === CELL.NONE) {
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

  // Rule: Check for units with no star and exactly one empty cell.
  hintOnlyEmpty() {
    const candidates = [];
    for (const unit of this.units) {
      const empty = unit.indices.filter(i => this.game.state[i] === CELL.NONE);
      const hasStar = unit.indices.some(i => this.game.state[i] === CELL.STAR);
      if (hasStar || empty.length !== 1) continue;
      candidates.push(unit);
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.indices[0] - b.indices[0]);
    return candidates.map(unit => {
      const empty = unit.indices.filter(i => this.game.state[i] === CELL.NONE);
      const unitType = unit.label.includes("Row") ? "row"
        : unit.label.includes("Column") ? "column"
        : "region";
      return {
        description: `Only one spot is left for a star in this ${unitType}.`,
        highlights: unit.indices
          .filter(i => i !== empty[0])
          .map(idx => ({ idx, color: 'hint-source-blue' })),
        marks: [{ idx: empty[0], color: 'hint-target-green' }],
        boardIdx: unit.boardIdx
      };
    });
  }

  // Rule: Check for units that already have their star placed.
  hintExcludeSolvedUnit() {
    const typeDescs = {
      "Row": "This row already has its star.",
      "Column": "This column already has its star.",
      "Region": "This region already has its star.",
    };
    const candidates = [];
    for (const unit of this.units) {
      const stars = unit.indices.filter(idx => this.game.state[idx] === CELL.STAR);
      const empty = unit.indices.filter(idx => this.game.state[idx] === CELL.NONE);
      if (stars.length > 0 && empty.length > 0) candidates.push(unit);
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.indices[0] - b.indices[0]);
    return candidates.map(unit => {
      const key = unit.label.includes("Row") ? "Row"
        : unit.label.includes("Column") ? "Column"
        : "Region";
      const stars = unit.indices.filter(idx => this.game.state[idx] === CELL.STAR);
      const empty = unit.indices.filter(idx => this.game.state[idx] === CELL.NONE);
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
      if (this.game.state[i] !== CELL.STAR) continue;
      const marks = this.getNeighbors(i)
        .filter(nb => this.game.state[nb] === CELL.NONE)
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

    for (let bIdx = 0; bIdx < 2; bIdx++) {
      for (const region of this.getUnsolvedRegions(bIdx)) {
        const empty = region.indices.filter(i => this.game.state[i] === CELL.NONE);
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
          .filter(idx => this.game.state[idx] === CELL.NONE);

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

    const starsInWindow = windowIndices.filter(i => this.game.state[i] === CELL.STAR).length;
    const requiredCount = unitCombo.length - starsInWindow;
    if (requiredCount <= 0) return null;

    const availInUnits = windowIndices.filter(i => this.game.state[i] === CELL.NONE);
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
      .filter(idx => !windowSet.has(idx) && this.game.state[idx] === CELL.NONE);

    if (targets.length === 0) return null;

    const targetSet = new Set(targets);
    const N = unitCombo.length;
    const unitsPhrase = N === 1 ? `this ${axis.toLowerCase()}` : `these ${N} ${axis.toLowerCase()}s`;

    return {
      boardIdx: bIdx,
      description: `All empty cells in ${unitsPhrase} are covered by the blue regions.`,
      highlights: coveringUnsolved.flatMap(r =>
        r.indices.filter(i => this.game.state[i] === CELL.NONE && !targetSet.has(i))
      ).map(idx => ({ idx, color: 'hint-source-blue' })),
      marks: targets.map(idx => ({ idx, color: 'hint-target-yellow' }))
    };
  }

  // Check "N regions trapped in N units" deduction.
  _hintRegionsTrappedInUnits(windowIndices, bIdx, axis) {
    const windowSet = new Set(windowIndices.flat());
    const allIndices = windowIndices.flat();

    const starsInWindow = allIndices.filter(i => this.game.state[i] === CELL.STAR).length;
    const requiredCount = windowIndices.length - starsInWindow;
    if (requiredCount <= 0) return null;

    const unsolvedRegs = this.getUnsolvedRegions(bIdx);
    const pinnedRegs = unsolvedRegs.filter(reg => {
      const regAvail = reg.indices.filter(i => this.game.state[i] === CELL.NONE);
      return regAvail.length > 0 && regAvail.every(idx => windowSet.has(idx));
    });

    if (pinnedRegs.length !== requiredCount) return null;

    const regUnion = new Set(pinnedRegs.flatMap(r => r.indices));
    const targets = allIndices.filter(idx =>
      this.game.state[idx] === CELL.NONE && !regUnion.has(idx)
    );

    if (targets.length === 0) return null;

    const targetSet = new Set(targets);
    const N = windowIndices.length;
    const unitsPhrase = N === 1 ? `this ${axis.toLowerCase()}` : `these ${N} ${axis.toLowerCase()}s`;

    return {
      boardIdx: bIdx,
      description: `The star for ${unitsPhrase} must fall in one of the blue regions.`,
      highlights: pinnedRegs.flatMap(r =>
        r.indices.filter(i => this.game.state[i] === CELL.NONE && !targetSet.has(i))
      ).map(idx => ({ idx, color: 'hint-source-blue' })),
      marks: targets.map(idx => ({ idx, color: 'hint-target-yellow' }))
    };
  }

  // Find all synchronization hints for a window size of N.
  _hintWindowRegionSyncAll(N, axis, adjacent) {
    const n = this.n;
    const axisIndices = this.axisIndices[axis];

    const windows = adjacent
      ? Array.from({length: n - N + 1}, (_, startU) =>
        Array.from({length: N}, (_, i) => axisIndices[startU + i]))
        : this.getCombinations(Array.from({length: n}, (_, i) => i), N)
        .map(combo => combo.map(u => axisIndices[u]));

    const candidates = [];
    for (let bIdx = 0; bIdx < 2; bIdx++) {
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

  // Helper to find external cells that see all options in a unit.
  _hintSeesTooMuchForUnits(units) {
    const n = this.n;
    const hintCandidates = [];
    for (const unit of units) {
      const candidates = unit.indices.filter(i => this.game.state[i] === CELL.NONE);
      if (candidates.length === 0) continue;

      const candCoords = candidates.map(i => ({ r: Math.floor(i / n), c: i % n }));
      const targets = [];

      for (let i = 0; i < n * n; i++) {
        if (this.game.state[i] !== CELL.NONE || unit.indices.includes(i)) continue;
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
      !u.indices.some(i => this.game.state[i] === CELL.STAR)
    );
    return this._hintSeesTooMuchForUnits(rowColUnits);
  }

  // Rule: Check regions where all empty cells are visible to an external cell.
  hintSeesTooMuch(nTarget = null) {
    const regionUnits = [0, 1].flatMap(bIdx => this.getUnsolvedRegions(bIdx))
      .filter(u => nTarget === null || u.indices.filter(i => this.game.state[i] === CELL.NONE).length === nTarget);
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

    for (let bIdx = 0; bIdx < 2; bIdx++) {
      for (const combo of this.getCombinations(this.getUnsolvedRegions(bIdx), N)) {
        comboSets.push({
          label: `Board ${bIdx + 1} Combo (${combo.map(r => r.label.split(' ').pop()).join(',')})`,
          indices: new Set(combo.flatMap(r => r.indices.filter(i => this.game.state[i] !== CELL.DOT))),
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
          .filter(idx => !setA.indices.has(idx) && this.game.state[idx] === CELL.NONE);

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
    const unsolvedRegions = [0, 1].flatMap(bIdx =>
      this.getUnsolvedRegions(bIdx)
      .filter(reg => reg.indices.some(i => this.game.state[i] === CELL.NONE))
      .map(reg => ({
        label: `B${bIdx + 1}-${reg.label.split(' ').pop()}`,
        allIdxs: new Set(reg.indices),
        availableIdxs: reg.indices.filter(i => this.game.state[i] === CELL.NONE),
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
          if (!regionUnion.has(idx) && this.game.state[idx] === CELL.NONE) {
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

    const board0Regions = this.getUnsolvedRegions(0);
    const board1Regions = this.getUnsolvedRegions(1);

    for (const regA of board0Regions) {
      for (const regB of board1Regions) {
        const setA = new Set(regA.indices.filter(i => this.game.state[i] !== CELL.DOT));
        const setB = new Set(regB.indices.filter(i => this.game.state[i] !== CELL.DOT));

        const shared  = [...setA].filter(i => setB.has(i));
        const onlyA   = [...setA].filter(i => !setB.has(i));
        const onlyB   = [...setB].filter(i => !setA.has(i));
        const disjoint = [...onlyA, ...onlyB];

        if (shared.length === 0 || disjoint.length === 0) continue;

        const allInOneUnit = (indices, axis) => {
          const vals = indices.map(i => axis === 'row' ? Math.floor(i / n) : i % n);
          return new Set(vals).size === 1;
        };

        if (!allInOneUnit(disjoint, 'row') && !allInOneUnit(disjoint, 'col')) continue;

        const targets = shared.filter(i => this.game.state[i] === CELL.NONE);
        if (targets.length === 0) continue;

        candidates.push({ shared, onlyA, onlyB });
      }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (a.shared[0] ?? 0) - (b.shared[0] ?? 0));
    return candidates.map(({ shared, onlyA, onlyB }) => ({
      boardIdx: undefined,
      description: `These two regions overlap everywhere except one row or column. A star anywhere in any non-shared cell would make one region unsolvable.`,
      highlights: shared
        .filter(i => this.game.state[i] === CELL.NONE)
        .map(i => ({ idx: i, color: 'hint-source-blue' })),
      marks: [
        ...onlyA.filter(i => this.game.state[i] === CELL.NONE).map(i => ({ idx: i, color: 'hint-target-yellow' })),
        ...onlyB.filter(i => this.game.state[i] === CELL.NONE).map(i => ({ idx: i, color: 'hint-target-yellow' })),
      ]
    }));
  }

  // MATCH: An empty cell where placing a star immediately creates a contradiction
  //   that is visible on a single board alone — i.e. a region on the same board
  //   as the test cell becomes unsatisfiable, or a row/column is broken without
  //   needing to combine information from both boards' region layouts.
  // ACTION: That cell must be a dot.
  // This is a strictly cheaper observation than hintLookaheadHalf: the broken
  // unit is either (a) a region belonging to the same board as testIdx, or
  // (b) a row/col whose only remaining empty cells all belonged to a single
  // region on that same board (so the deduction requires no cross-board
  // reasoning).
  hintLookaheadHalfSingleBoard() {
    const n = this.n;
    const candidates = [];

    const emptyIndices = this.game.state
      .flatMap((val, idx) => val === CELL.NONE ? [idx] : []);

    for (const testIdx of emptyIndices) {
      const row = Math.floor(testIdx / n);
      const col = testIdx % n;

      // Run one sandbox per board, applying only that board's region for testIdx.
      // Row, col, and adjacency consequences are board-agnostic and applied in
      // both passes — but only the single board's region is used to fill dots.
      for (const bIdx of [0, 1]) {
        const boardReg = this._getRegionsContaining(testIdx)
          .find(r => r.boardIdx === bIdx);
        if (!boardReg) continue; // cell not in any region on this board

        const sandboxState = [...this.game.state];
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

        // Only accept contradictions that are visible within this single board:
        // a broken region on bIdx, a broken row/col, or an adjacency violation.
        // We explicitly exclude broken regions belonging to the *other* board,
        // since those require cross-board region reasoning.
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

  // Rule: Lookahead level 1 (check single-star placement contradiction).
  hintLookaheadHalf() {
    const n = this.n;
    const candidates = [];

    const emptyIndices = this.game.state
      .flatMap((val, idx) => val === CELL.NONE ? [idx] : []);

    for (const testIdx of emptyIndices) {
      const sandboxState = [...this.game.state];
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

    // Find all empty cells to test
    const emptyIndices = this.game.state
      .flatMap((val, idx) => val === CELL.NONE ? [idx] : []);

    for (const testIdx of emptyIndices) {
      // 1. Create a sandbox
      let sandboxState = [...this.game.state];
      sandboxState[testIdx] = CELL.STAR;

      // 2. Cascade consequences for n stages
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
    const n = this.n;
    const [r1, r2] = this.game.regions;
    for (let i = 0; i < n * n; i++) {
      const mirror = mirrorFn(i);
      // Check if board 1 and board 2 region boundaries mirror each other.
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
    // Check if both boards have internal diagonal symmetry.
    const total = this.n * this.n;
    const [r1, r2] = this.game.regions;
    for (let i = 0; i < total; i++) {
      const mi = mirrorFn(i);
      for (let j = i + 1; j < total; j++) {
        const mj = mirrorFn(j);
        if ((r1[i] === r1[j]) !== (r1[mi] === r1[mj])) return false;
        if ((r2[i] === r2[j]) !== (r2[mi] === r2[mj])) return false;
      }
    }
    return true;
  }

  _computeInternalRotation180() {
    const total = this.n * this.n;
    const mirrorFn = i => total - 1 - i;
    const [r1, r2] = this.game.regions;
    for (let i = 0; i < total; i++) {
      for (let j = i + 1; j < total; j++) {
        if ((r1[i] === r1[j]) !== (r1[mirrorFn(i)] === r1[mirrorFn(j)])) return false;
        if ((r2[i] === r2[j]) !== (r2[mirrorFn(i)] === r2[mirrorFn(j)])) return false;
      }
    }
    return true;
  }

  _computeCrossboardRotation180() {
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
    const cellToRegion0 = this.buildCellToRegionMap(0);
    const cellToRegion1 = this.buildCellToRegionMap(1);

    const marks = [];
    for (let i = 0; i < n * n; i++) {
      if (this.game.state[i] !== CELL.NONE) continue;

      const mirror = mirrorFn(i);
      if (mirror === i) continue;

      const r  = Math.floor(i / n),      c  = i % n;
      const mr = Math.floor(mirror / n), mc = mirror % n;

      const seesOwnMirror =
        r === mr || c === mc ||
        this.getNeighbors(i).includes(mirror) ||
        (cellToRegion0[i] && cellToRegion0[i] === cellToRegion0[mirror]) ||
        (cellToRegion1[i] && cellToRegion1[i] === cellToRegion1[mirror]);

      if (seesOwnMirror) marks.push({ idx: i, color: 'hint-target-yellow' });
    }

    if (marks.length === 0) return null;

    return { description, highlights: [], marks, boardIdx: undefined };
  }

  hintDiagonalReflection() {
    const n = this.n;
    const variants = [
      {
        active: this.isMainDiagonalSymmetric,
        mirrorFn: i => (i % n) * n + Math.floor(i / n),
        description: this.mainDiagCrossBoard && this.mainDiagInternal
          ? `The two boards are reflections of each other across the main diagonal (↘), and each board also has that symmetry internally. The solution must be symmetric, so any cell that "sees" its own reflection cannot be a star.`
          : this.mainDiagInternal
          ? `Each board independently has diagonal symmetry across the main diagonal (↘). The solution must be symmetric, so any cell that "sees" its own reflection cannot be a star.`
          : `The two boards are reflections of each other across the main diagonal (↘). The solution must be symmetric, so any cell that "sees" its own reflection cannot be a star.`
      },
      {
        active: this.isAntiDiagonalSymmetric,
        mirrorFn: i => (n-1 - i%n) * n + (n-1 - Math.floor(i/n)),
        description: this.antiDiagCrossBoard && this.antiDiagInternal
          ? `The two boards are reflections of each other across the anti-diagonal (↙), and each board also has that symmetry internally. The solution must be symmetric, so any cell that "sees" its own reflection cannot be a star.`
          : this.antiDiagInternal
          ? `Each board independently has diagonal symmetry across the anti-diagonal (↙). The solution must be symmetric, so any cell that "sees" its own reflection cannot be a star.`
          : `The two boards are reflections of each other across the anti-diagonal (↙). The solution must be symmetric, so any cell that "sees" its own reflection cannot be a star.`
      },
    ];
    const results = [];
    for (const { active, mirrorFn, description } of variants) {
      if (!active) continue;
      const hint = this._hintSymmetry(mirrorFn, description);
      if (hint) results.push(hint);
    }
    return results.length > 0 ? results : null;
  }

  hintRotation180() {
    const hasInternal   = this.internalRotation180;
    const hasCrossboard = this.crossboardRotation180;
    if (!hasInternal && !hasCrossboard) return null;

    const n = this.n;
    const description = hasInternal && hasCrossboard
      ? `Each board has 180° rotational symmetry, and the boards are also 180° rotations of each other. Any cell that "sees" its own rotation cannot be a star.`
      : hasInternal
      ? `Each board independently has 180° rotational symmetry. Any cell that "sees" its own rotation cannot be a star.`
      : `The two boards are 180° rotations of each other. Any cell that "sees" its counterpart on the rotated board cannot be a star.`;

    const hint = this._hintSymmetry(i => (n * n - 1) - i, description);
    return hint ? [hint] : null;
  }

  _hintSymmetryFill(mirrorFn, description) {
    const starMarks = [];
    const dotMarks  = [];

    for (let i = 0; i < this.n * this.n; i++) {
      if (this.game.state[i] !== CELL.NONE) continue;
      const mirror = mirrorFn(i);
      if (mirror === i) continue;

      const mirrorState = this.game.state[mirror];
      if (mirrorState === CELL.STAR) {
        starMarks.push({ idx: i, color: 'hint-target-green' });
      } else if (mirrorState === CELL.DOT) {
        dotMarks.push({ idx: i, color: 'hint-target-yellow' });
      }
    }

    // Prefer star placements, fall back to dots.
    const marks = starMarks.length > 0 ? starMarks : dotMarks;
    if (marks.length === 0) return null;

    const filling = starMarks.length > 0 ? 'stars' : 'dots';
    return [{
      description: `${description} You can copy ${filling} across by symmetry.`,
      highlights: marks.map(({ idx }) => ({
        idx: mirrorFn(idx), color: 'hint-source-blue'
      })),
      marks,
      boardIdx: undefined
    }];
  }

  hintRotation180Fill() {
    if (!this.internalRotation180 && !this.crossboardRotation180) return null;
    const n = this.n;
    return this._hintSymmetryFill(
      i => (n * n - 1) - i,
      `The solution has 180° rotational symmetry.`
    );
  }

  hintMainDiagonalFill() {
    if (!this.isMainDiagonalSymmetric) return null;
    const n = this.n;
    const desc = this.mainDiagInternal && !this.mainDiagCrossBoard
      ? `Each board independently has diagonal symmetry across the main diagonal (↘). The solution is symmetric.`
      : `The solution is symmetric across the main diagonal (↘).`;
    return this._hintSymmetryFill(
      i => (i % n) * n + Math.floor(i / n),
      desc
    );
  }

  hintAntiDiagonalFill() {
    if (!this.isAntiDiagonalSymmetric) return null;
    const n = this.n;
    const desc = this.antiDiagInternal && !this.antiDiagCrossBoard
      ? `Each board independently has diagonal symmetry across the anti-diagonal (↙). The solution is symmetric.`
      : `The solution is symmetric across the anti-diagonal (↙).`;
    return this._hintSymmetryFill(
      i => (n - 1 - i % n) * n + (n - 1 - Math.floor(i / n)),
      desc
    );
  }

  hintFromSolution() {
    const n = this.n;
    const candidates = [];
    for (let i = 0; i < n * n; i++) {
      if (this.game.solution[i] !== 'x' && this.game.state[i] === CELL.NONE) {
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

  // Formats a hint result for the region subset family of hints.
  formatSubsetHint(sourceRegs, targets, bIdx) {
    const targetSet = new Set(targets);
    const sourceHighlights = sourceRegs.flatMap(r =>
      r.indices.filter(i => this.game.state[i] === CELL.NONE && !targetSet.has(i))
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

  // Formats a hint result for the cross-board region pinned hint.
  formatCrossBoardHint(combo, targets, axis, uList) {
    const targetSet = new Set(targets);

    // Source highlights: Empty squares in regions that aren't targets
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

  // Run one step of simplified rule simulation.
  _applySimulatedRules(state) {
    const n = this.n;

    // Apply star visibility constraints.
    for (let i = 0; i < state.length; i++) {
      if (state[i] !== CELL.STAR) continue;

      const row = Math.floor(i / n);
      const col = i % n;

      // Eliminate other row/col cells.
      for (let j = 0; j < n; j++) {
        const rIdx = row * n + j;
        const cIdx = j * n + col;
        if (state[rIdx] === CELL.NONE && rIdx !== i) state[rIdx] = CELL.DOT;
        if (state[cIdx] === CELL.NONE && cIdx !== i) state[cIdx] = CELL.DOT;
      }

      // Eliminate adjacent cells.
      for (const nb of this.getNeighbors(i)) {
        if (state[nb] === CELL.NONE) state[nb] = CELL.DOT;
      }

      // Eliminate other cells in containing regions.
      for (const reg of this._getRegionsContaining(i)) {
        reg.indices.forEach(idx => {
          if (state[idx] === CELL.NONE) state[idx] = CELL.DOT;
        });
      }
    }

    // Check units with only one empty cell remaining.
    for (const u of this.units) {
      const noneIndices = u.indices.filter(i => state[i] === CELL.NONE);
      const starIndices = u.indices.filter(i => state[i] === CELL.STAR);
      if (starIndices.length === 0 && noneIndices.length === 1) {
        state[noneIndices[0]] = CELL.STAR;
      }
    }
  }

  // Find the first rule violation in the state.
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

    // Check for touching stars.
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
