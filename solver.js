import { CELL } from './constants.js';

export class PuzzleSolver {
  // ───────────────────── 
  // ─── Setup & Utils ─── 
  // ───────────────────── 
  constructor(game) {
    this.game = game;
    this.n = game.n;

    // Precompute some useful values that many hint functions need.
    this.units = this.getAllUnits();
    this.axisIndices = {
      Row: this.getAxisIndices("Row"),
      Column: this.getAxisIndices("Column"),
    };

    // precompute and cache symmetry properties that are useful for niche rules,
    // to avoid duplicating this work.
    this.isMainDiagonalSymmetric   = this._isBoardSymmetric(i => (i % this.n) * this.n + Math.floor(i / this.n));
    this.isAntiDiagonalSymmetric   = this._isBoardSymmetric(i => (this.n-1 - i%this.n) * this.n + (this.n-1 - Math.floor(i/this.n)));
    this.selfRotation180 = this._computeSelfRotation180();
  }

  // Gets all "units" meaning rows, cols, and regions.
  getAllUnits() {
    const n = this.n;
    const units = [];

    // 1. Rows (Shared)
    for (let r = 0; r < n; r++) {
      const indices = Array.from({ length: n }, (_, k) => r * n + k);
      units.push({ indices, label: `Row ${r + 1}` });
    }

    // 2. Columns (Shared)
    for (let c = 0; c < n; c++) {
      const indices = Array.from({ length: n }, (_, k) => k * n + c);
      units.push({ indices, label: `Column ${String.fromCharCode(65 + c)}` });
    }

    if (!this.game.regions) {
      console.error("Regions data is missing from the game instance!");
      return units;
    }

    // Regions: indices are board-local (0..n²-1), boardIdx distinguishes which
    // board.
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

  // Returns all regions on the given board that don't yet have a star placed.
  getUnsolvedRegions(boardIdx) {
    return this.units.filter(u =>
      u.label.includes("Region") &&
      u.boardIdx === boardIdx &&
      !u.indices.some(i => this.game.state[i] === CELL.STAR)
    );
  }

  // Returns an array of n index-lists, one per row (or column), for the given
  // axis.
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

  // Builds a map from cell index to region label for the given board.
  // Used to quickly look up which region a cell belongs to.
  buildCellToRegionMap(boardIdx) {
    const map = {};
    this.units
      .filter(u => u.label.includes("Region") && u.boardIdx === boardIdx)
      .forEach(reg => reg.indices.forEach(idx => { map[idx] = reg.label; }));
    return map;
  }

  // Returns the 8-way (king's move) neighbors of the given cell index.
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

  // Helper to get all combinations of an array of size k
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

  // Returns all region units that contain the given cell index.
  _getRegionsContaining(idx) {
    return this.units.filter(u => u.label.includes("Region") && u.indices.includes(idx));
  }

  // ───────────────────── 
  // ─── Hint Dispatch ─── 
  // ───────────────────── 

  getHint() {
    const rules = [
      // Error checking
      () => this.hintCheckForErrors(),
      () => this.hintAlreadySolved(),
      // Beginner
      () => this.hintSingleCellRegion(),
      () => this.hintOnlyEmpty(),
      () => this.hintExcludeAdjacency(),
      () => this.hintExcludeSolvedUnit(),
      () => this.hintDomino(),
      () => this.hintUnitSeesTooMuch(),
      () => this.hintUnitRegionSync(1),
      // Medium
      () => this.hintSeesTooMuch(2),
      () => this.hintSeesTooMuch(3),
      () => this.hintSeesTooMuch(null),
      () => this.hintUnitRegionSync(2),
      // Hard
      () => this.hintUnitRegionSync(3),
      () => this.hintDisjointUnitRegionSync(2),
      () => this.hintManyRegionsSync(),
      () => this.hintRegionSubsetSync(1),
      () => this.hintMainDiagonalReflection(),
      () => this.hintAntiDiagonalReflection(),
      () => this.hintRotation180(),
      // Expert
      () => this.hintDisjointUnitRegionSync(3),
      () => this.hintCrossBoardRegionPinned(2, "Row"),
      () => this.hintCrossBoardRegionPinned(2, "Col"),
      () => this.hintCrossBoardRegionPinned(3, "Row"),
      () => this.hintCrossBoardRegionPinned(3, "Col"),
      () => this.hintPartialOverlap(),
      () => this.hintLookaheadHalf(),
      () => this.hintRegionSubsetSync(2),
      // Grandmaster
      () => this.hintLookahead(1),
      () => this.hintLookahead(2),
      () => this.hintLookahead(3),
      () => this.hintLookahead(8),
      () => this.hintFromSolution(),
    ];

    for (const rule of rules) {
      const hint = rule();
      if (hint) return hint;
    }
    return null;
  }


  // ────────────────── 
  // ─── Hint Rules ─── 
  // ────────────────── 

  // MATCH: Any cell where the user's placement contradicts the solution.
  // ACTION: Highlights all incorrect cells in red before providing other hints.
  hintCheckForErrors() {
    const n = this.n;
    const highlights = [];

    for (let i = 0; i < n * n; i++) {
      const isWrong = (this.game.state[i] === CELL.STAR && this.game.solution[i] !== 'x')
        || (this.game.state[i] === CELL.DOT  && this.game.solution[i] === 'x');
      if (isWrong) highlights.push({ idx: i, color: 'hint-error-red' });
    }

    if (highlights.length > 0) {
      return {
        description: "Can't provide a hint, fix the errors marked in red first",
        highlights,
        marks: [],
        boardIdx: undefined
      };
    }

    return null;
  }

  // MATCH: The puzzle is already in a solved state.
  // ACTION: Returns an informational hint so the user knows no moves are needed.
  hintAlreadySolved() {
    const isSolved = this.game.state.every((v, i) => 
      (this.game.solution[i] === 'x') ? v === CELL.STAR : v !== CELL.STAR
    );
    if (!isSolved) return null;

    return {
      description: "The puzzle is already solved!",
      highlights: [],
      marks: [],
      boardIdx: undefined
    };
  }

  // MATCH: A region with exactly one cell and no star.
  // ACTION: Points to that cell as a forced star.
  hintSingleCellRegion() {
    for (let bIdx = 0; bIdx < 2; bIdx++) {
      for (const region of this.getUnsolvedRegions(bIdx)) {
        if (region.indices.length === 1 && this.game.state[region.indices[0]] === CELL.NONE) {
          return {
            description: `Every region must contain a star.`,
            highlights: [{ idx: region.indices[0], color: 'hint-target-green' }],
            marks: [],
            boardIdx: region.boardIdx
          };
        }
      }
    }
    return null;
  }

  // MATCH: A unit (row, column, or region) with no star and exactly one empty
  //   cell.
  // ACTION: Points to that cell as the forced star location.
  hintOnlyEmpty() {
    for (const unit of this.units) {
      const empty = unit.indices.filter(i => this.game.state[i] === CELL.NONE);
      const hasStar = unit.indices.some(i => this.game.state[i] === CELL.STAR);
      if (hasStar || empty.length !== 1) continue;

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
    }
    return null;
  }

  // Returns highlight/mark data for the first unit of the given type that has
  // a star but still has empty cells, or null if none found.
  getBlockedByStars(unitType) {
    for (const unit of this.units.filter(u => u.label.includes(unitType))) {
      const stars = unit.indices.filter(idx => this.game.state[idx] === CELL.STAR);
      const empty = unit.indices.filter(idx => this.game.state[idx] === CELL.NONE);

      // If this unit has its star but still has empty cells to dot...
      if (stars.length > 0 && empty.length > 0) {
        return {
          highlights: stars.map(idx => ({ idx, color: 'hint-source-blue' })),
          marks: empty.map(idx => ({ idx, color: 'hint-target-yellow' })),
          label: unit.label,
          boardIdx: unit.boardIdx
        };
      }
    }
    return null;
  }

  // MATCH: A row, column, or region that already has its star.
  // ACTION: Marks all remaining empty cells in that unit as dots.
  hintExcludeSolvedUnit() {
    const types = [
      { key: "Row",    desc: "This row already has its star." },
      { key: "Column", desc: "This column already has its star." },
      { key: "Region", desc: "This region already has its star." },
    ];
    for (const { key, desc } of types) {
      const result = this.getBlockedByStars(key);
      if (result) return { description: desc, ...result, boardIdx: result.boardIdx ?? undefined };
    }
    return null;
  }

  // MATCH: A placed star with empty neighbors.
  // ACTION: Marks those neighbors as dots since stars cannot touch.
  hintExcludeAdjacency() {
    for (let i = 0; i < this.n * this.n; i++) {
      if (this.game.state[i] !== CELL.STAR) continue;

      const marks = this.getNeighbors(i)
        .filter(nb => this.game.state[nb] === CELL.NONE)
        .map(nb => ({ idx: nb, color: 'hint-target-yellow' }));

      if (marks.length > 0) {
        return {
          description: "Stars cannot touch each other.",
          highlights: [{ idx: i, color: 'hint-source-blue' }],
          marks,
          boardIdx: undefined
        };
      }
    }
    return null;
  }

  // MATCH: An unsolved region with exactly two orthogonally adjacent empty cells.
  // ACTION: Marks cells that would be blocked regardless of which cell gets the star.
  hintDomino() {
    const n = this.n;

    for (let bIdx = 0; bIdx < 2; bIdx++) {
      for (const region of this.getUnsolvedRegions(bIdx)) {
        const empty = region.indices.filter(i => this.game.state[i] === CELL.NONE);
        if (empty.length !== 2) continue;

        const [idxA, idxB] = empty;
        const rA = Math.floor(idxA / n), cA = idxA % n;
        const rB = Math.floor(idxB / n), cB = idxB % n;

        // Only applies to orthogonally adjacent pairs
        if (Math.abs(rA - rB) + Math.abs(cA - cB) !== 1) continue;

        // Shared row or column blocks that entire line
        const blockedIndices = new Set();
        if (rA === rB) {
          for (let k = 0; k < n; k++) blockedIndices.add(rA * n + k);
        } else {
          for (let k = 0; k < n; k++) blockedIndices.add(k * n + cA);
        }

        // Intersection of both cells' neighborhoods also blocked
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
          return {
            description: "A star must be in the blue domino.",
            highlights: [
              { idx: idxA, color: 'hint-source-blue' },
              { idx: idxB, color: 'hint-source-blue' }
            ],
            marks: targets.map(idx => ({ idx, color: 'hint-target-yellow' })),
            boardIdx: region.boardIdx
          };
        }
      }
    }
    return null;
  }

  // Core logic for the "N units are covered by exactly N regions" deduction.
  // Works for any set of unit index-lists, adjacent or not.
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

  // Core logic for the "N regions are trapped inside N units" deduction.
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

  // MATCH: N rows/cols (adjacent or disjoint) where either:
  //   - N regions are trapped inside the window (standard), or
  //   - The window's available cells are covered by N regions (inverse).
  // ACTION: In both cases, cells in the window outside the relevant regions
  //   must be dots.
  // When adjacent=true, only considers contiguous windows (cheaper).
  _hintWindowRegionSync(N, axis, adjacent) {
    const n = this.n;
    const axisIndices = this.axisIndices[axis];

    const windows = adjacent
      ? Array.from({length: n - N + 1}, (_, startU) =>
        Array.from({length: N}, (_, i) => axisIndices[startU + i]))
        : this.getCombinations(Array.from({length: n}, (_, i) => i), N)
        .map(combo => combo.map(u => axisIndices[u]));

    for (let bIdx = 0; bIdx < 2; bIdx++) {
      for (const windowIndices of windows) {
        const standard = this._hintRegionsTrappedInUnits(windowIndices, bIdx, axis);
        if (standard) return standard;

        const inverse = this._hintUnitsCoveredByRegions(windowIndices, bIdx, axis);
        if (inverse) return inverse;
      }
    }
    return null;
  }

  // MATCH (Standard): N adjacent rows/cols whose only available cells belong to
  //   exactly N unsolved regions — those regions are "pinned" to this window.
  // MATCH (Inverse): N adjacent rows/cols whose available cells are all covered
  //   by exactly N unsolved regions.
  // ACTION: In both cases, cells in the window outside the relevant regions
  //   must be dots.
  hintUnitRegionSync(N) {
    for (const axis of ["Row", "Column"]) {
      const hint = this._hintWindowRegionSync(N, axis, true);
      if (hint) return hint;
    }
    return null;
  }

  // Extends hintUnitRegionSync to windows of 4 or more rows/cols.
  hintManyRegionsSync() {
    for (let n = 4; n < this.n; n++) {
      const result = this.hintUnitRegionSync(n);
      if (result) return result;
    }
    return null;
  }

  // Core logic shared by hintUnitSeesTooMuch and hintSeesTooMuch.
  // MATCH: A unit where every empty cell is "seen" by some external empty cell
  //   (same row, col, or diagonally adjacent).
  // ACTION: Marks that external cell as a dot — it would block the unit's star
  //   regardless of where in the unit it lands.
  _hintSeesTooMuchForUnits(units) {
    const n = this.n;
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

      if (targets.length > 0) return {
        boardIdx: unit.boardIdx,
        description: `The blue cells must contain a star.`,
        highlights: candidates.map(i => ({ idx: i, color: 'hint-source-blue' })),
        marks: targets,
      };
    }
    return null;
  }

  // MATCH: An unsolved row or column where every empty cell is "seen" by some
  //   external cell (same row, col, or adjacent).
  // ACTION: Marks that external cell as a dot since the row/col star would
  //   block it.
  hintUnitSeesTooMuch() {
    const rowColUnits = this.units.filter(u =>
      !u.label.includes("Region") &&
      !u.indices.some(i => this.game.state[i] === CELL.STAR)
    );
    return this._hintSeesTooMuchForUnits(rowColUnits);
  }

  // MATCH: An unsolved region where every empty cell is seen by some external
  //   cell.
  // ACTION: Marks that external cell as a dot.
  // nTarget filters to regions with exactly that many candidates (null = any).
  hintSeesTooMuch(nTarget = null) {
    const regionUnits = [0, 1].flatMap(bIdx => this.getUnsolvedRegions(bIdx))
      .filter(u => nTarget === null || u.indices.filter(i => this.game.state[i] === CELL.NONE).length === nTarget);
    return this._hintSeesTooMuchForUnits(regionUnits);
  }

  // 7788 notable example
  // MATCH: N disjoint (not necessarily adjacent) rows/cols whose available cells
  //   are covered by exactly N unsolved regions.
  // ACTION: Cells in those regions outside the N rows/cols must be dots.
  hintDisjointUnitRegionSync(N) {
    for (const axis of ["Row", "Column"]) {
      const hint = this._hintWindowRegionSync(N, axis, false);
      if (hint) return hint;
    }
    return null;
  }

  // MATCH: N regions whose combined available cells are a subset of N other
  //   regions' combined available cells (both needing the same star count).
  // ACTION: Cells in the larger set but not the smaller must be dots.
  hintRegionSubsetSync(N) {
    const comboSets = [];

    for (let bIdx = 0; bIdx < 2; bIdx++) {
      for (const combo of this.getCombinations(this.getUnsolvedRegions(bIdx), N)) {
        comboSets.push({
          label: `Board ${bIdx + 1} Combo (${combo.map(r => r.label.split(' ').pop()).join(',')})`,
          indices: new Set(combo.flatMap(r => r.indices.filter(i => this.game.state[i] !== CELL.DOT))),  // only available cells
          boardIdx: bIdx,
          regions: combo
        });
      }
    }

    for (let i = 0; i < comboSets.length; i++) {
      for (let j = 0; j < comboSets.length; j++) {
        if (i === j) continue;

        const setA = comboSets[i];
        const setB = comboSets[j];

        const isSubset = Array.from(setA.indices).every(idx => setB.indices.has(idx));
        if (!isSubset) continue;

        const targets = Array.from(setB.indices)
          .filter(idx => !setA.indices.has(idx) && this.game.state[idx] === CELL.NONE);

        if (targets.length > 0) {
          return this.formatSubsetHint(setA.regions, targets, setA.boardIdx);
        }
      }
    }
    return null;
  }

  // MATCH: N disjoint regions (potentially from different boards) whose
  //   available cells all fall in the same N adjacent rows or columns.
  // ACTION: Cells in those rows/cols outside the N regions must be dots.
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
      if (targets.length > 0) return this.formatCrossBoardHint(combo, targets, axis, uList);
    }
    return null;
  }


  // MATCH: Two regions (one per board) where the union of their non-shared
  //   cells all fall in a single row or column.
  // ACTION: Those non-shared cells must be dots — a star there would block both
  //   regions.
  hintPartialOverlap() {
    const n = this.n;

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

        return {
          boardIdx: undefined,
          description: `These two regions overlap everywhere except one row or column. A star anywhere in any non-shared cell would make one region unsolvable.`,
          highlights: shared
          .filter(i => this.game.state[i] === CELL.NONE)
          .map(i => ({ idx: i, color: 'hint-source-blue' })),
          marks: [
            ...onlyA.filter(i => this.game.state[i] === CELL.NONE).map(i => ({ idx: i, color: 'hint-target-yellow' })),
            ...onlyB.filter(i => this.game.state[i] === CELL.NONE).map(i => ({ idx: i, color: 'hint-target-yellow' })),
          ]
        };
      }
    }
    return null;
  }

  // MATCH: An empty cell where placing a star immediately creates a
  //   contradiction (after propagating just row/col/adjacency/region
  //   eliminations).
  // ACTION: That cell must be a dot.
  hintLookaheadHalf() {
    const n = this.n;

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
      if (!broken) continue;

      return {
        boardIdx: broken.type === 'region' ? broken.boardIdx : undefined,
        description: `The blue cells must contain a star. This is impossible if the circled cell holds a star.`,
        highlights: broken.indices.map(idx => ({ idx, color: 'hint-source-blue' })),
        marks: [{ idx: testIdx, color: 'hint-target-yellow' }]
      };
    }
    return null;
  }

  // MATCH: An empty cell where placing a star leads to a contradiction within
  //   nStages rounds of rule propagation.
  // ACTION: That cell must be a dot.
  hintLookahead(nStages) {
    const n = this.n;

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
        // Apply simple rules to the sandbox
        this._applySimulatedRules(sandboxState);

        if (this._isBoardBroken(sandboxState)) {
          broken = true;
          break;
        }
      }

      // 3. If broken, the test cell must be a dot
      if (broken) {
        return {
          boardIdx: undefined,
          description: `Placing a star here would make the puzzle unsolvable. Seeing why requires some lookahead.`,
          highlights: [],
          marks: [{ idx: testIdx, color: 'hint-target-yellow' }]
        };
      }
    }
    return null;
  }

  _isBoardSymmetric(mirrorFn) {
    const n = this.n;
    const [r1, r2] = this.game.regions;
    for (let i = 0; i < n * n; i++) {
      const mirror = mirrorFn(i);
      // Cells i and j are in the same region on board 1 iff their mirrors
      // are in the same region on board 2 — labels don't have to match.
      for (let j = i + 1; j < n * n; j++) {
        const mj = mirrorFn(j);
        const sameRegionBoard1 = r1[i] === r1[j];
        const sameRegionBoard2 = r2[mirror] === r2[mj];
        if (sameRegionBoard1 !== sameRegionBoard2) return false;
      }
    }
    return true;
  }

  _computeSelfRotation180() {
    const n = this.n;
    const total = n * n;
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

  hintMainDiagonalReflection() {
    if (!this.isMainDiagonalSymmetric) return null;
    const n = this.n;
    return this._hintSymmetry(
      i => (i % n) * n + Math.floor(i / n),
      `The two boards are reflections of each other across the main diagonal (↘). The solution must be symmetric, so any cell that "sees" its own reflection cannot be a star.`
    );
  }

  hintAntiDiagonalReflection() {
    if (!this.isAntiDiagonalSymmetric) return null;
    const n = this.n;
    return this._hintSymmetry(
      i => (n-1 - i%n) * n + (n-1 - Math.floor(i/n)),
      `The two boards are reflections of each other across the anti-diagonal (↙). The solution must be symmetric, so any cell that "sees" its own reflection cannot be a star.`
    );
  }

  hintRotation180() {
    if (!this.selfRotation180) return null;
    const n = this.n;
    return this._hintSymmetry(
      i => (n * n - 1) - i,
      `Each board is 180° rotationally symmetric. The solution must be too, so any cell that "sees" its own 180° rotation cannot be a star.`
    );
  }

  hintFromSolution() {
    const n = this.n;
    for (let i = 0; i < n * n; i++) {
      if (this.game.solution[i] !== 'x' && this.game.state[i] === CELL.NONE) {
        return {
          description: "No logical hint was found. Here's a nudge from the solution.",
          highlights: [],
          marks: [{ idx: i, color: 'hint-target-yellow' }],
          boardIdx: undefined
        };
      }
    }
    return null;
  }

  // ─────────────────────── 
  // ─── Hint Formatters ─── 
  // ─────────────────────── 

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

  // ────────────────── 
  // ─── Simulation ─── 
  // ────────────────── 

   // Simulates basic "Sees Star" and "Only Empty" logic 
  _applySimulatedRules(state) {
    const n = this.n;

    // 1. Sees Star: propagate consequences of each placed star
    for (let i = 0; i < state.length; i++) {
      if (state[i] !== CELL.STAR) continue;

      const row = Math.floor(i / n);
      const col = i % n;

      // Eliminate rest of row and column
      for (let j = 0; j < n; j++) {
        const rIdx = row * n + j;
        const cIdx = j * n + col;
        if (state[rIdx] === CELL.NONE && rIdx !== i) state[rIdx] = CELL.DOT;
        if (state[cIdx] === CELL.NONE && cIdx !== i) state[cIdx] = CELL.DOT;
      }

      // Eliminate neighbors
      for (const nb of this.getNeighbors(i)) {
        if (state[nb] === CELL.NONE) state[nb] = CELL.DOT;
      }

      // Eliminate rest of each region containing this star
      for (const reg of this._getRegionsContaining(i)) {
        reg.indices.forEach(idx => {
          if (state[idx] === CELL.NONE) state[idx] = CELL.DOT;
        });
      }
    }

    // 2. Only Empty: if a unit has one empty spot left, it must be the star
    for (const u of this.units) {
      const noneIndices = u.indices.filter(i => state[i] === CELL.NONE);
      const starIndices = u.indices.filter(i => state[i] === CELL.STAR);
      if (starIndices.length === 0 && noneIndices.length === 1) {
        state[noneIndices[0]] = CELL.STAR;
      }
    }
  }

  // Checks for rule violations: empty rows/cols/regions or touching stars 
  // Returns a descriptor of the first broken unit, or null if the board is valid.
  // { type: 'row'|'col'|'region', label, indices, boardIdx? }
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

    // Adjacency check — two stars touching. No unit to highlight in this case.
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
