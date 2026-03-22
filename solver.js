// solver.js
export class PuzzleSolver {
  constructor(game) {
    this.game = game;
    this.n = game.n;

    // precompute some useful values that many hint functions need.
    this.units = this.getAllUnits();
    this.axisIndices = {
      Row: this.getAxisIndices("Row"),
      Column: this.getAxisIndices("Column"),
    };
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

  getUnsolvedRegions(boardIdx) {
    return this.units.filter(u =>
      u.label.includes("Region") &&
      u.boardIdx === boardIdx &&
      !u.indices.some(i => this.game.state[i] === 'star')
    );
  }

  getAxisIndices(axis) {
    const n = this.n;
    const axisIndices = [];
    for (let i = 0; i < n; i++) {
      const unitIdxs = [];
      for (let j = 0; j < n; j++) {
        unitIdxs.push(axis === "Row" ? i * n + j : j * n + i);
      }
      axisIndices.push(unitIdxs);
    }
    return axisIndices;
  }


  // Get the region of |boardIdx| which contains |idx|.
  getRegionAt(idx, boardIdx) {
    return this.units.find(u => 
      u.boardIdx === boardIdx && 
      u.label.toLowerCase().includes("region") && 
      u.indices.includes(idx)
    );
  }

  buildCellToRegionMap(boardIdx) {
    const map = {};
    this.units
      .filter(u => u.label.includes("Region") && u.boardIdx === boardIdx)
      .forEach(reg => reg.indices.forEach(idx => { map[idx] = reg.label; }));
    return map;
  }

  getHint() {
    const rules = [
      () => this.hintCheckForErrors(),
      () => this.hintAlreadySolved(),
      () => this.hintSingleCellRegion(),
      () => this.hintOnlyEmpty(),
      () => this.hintExcludeAdjacency(),
      () => this.hintExcludeSolvedUnit(),
      () => this.hintDomino(),
      () => this.hintUnitSeesTooMuch(),
      () => this.hintUnitRegionSync(1),
      () => this.hintSeesTooMuch(2),
      () => this.hintSeesTooMuch(3),
      () => this.hintUnitRegionSync(2),
      () => this.hintSeesTooMuch(null),
      () => this.hintUnitRegionSync(3),
      () => this.hintDisjointUnitRegionSync(2),
      () => this.hintManyRegionsSync(),
      () => this.hintRegionSubsetSync(1),
      () => this.hintDisjointUnitRegionSync(3),
      () => this.hintCrossBoardRegionPinned(2, "Row"),
      () => this.hintCrossBoardRegionPinned(2, "Col"),
      () => this.hintCrossBoardRegionPinned(3, "Row"),
      () => this.hintCrossBoardRegionPinned(3, "Col"),
      () => this.hintPartialOverlap(),
      () => this.hintRegionSubsetSync(2),
      () => this.hintLookaheadHalf(),
      () => this.hintLookahead(1),
      () => this.hintLookahead(2),
      () => this.hintLookahead(3),
      () => this.hintLookahead(4),
      () => this.hintLookahead(8),
    ];

    for (let rule of rules) {
      const hint = rule();
      if (hint) return hint;
    }
    return null;
  }

  hintCheckForErrors() {
    const n = this.n;
    const highlights = [];

    // We must loop through the state stored in the game instance
    for (let i = 0; i < n * n; i++) {
      const userChoice = this.game.state[i]; // Point to this.game
      const correctChoice = this.game.solution[i]; // 'x' for star, '.' for dot

      // Check for misplaced stars
      if (userChoice === 'star' && correctChoice !== 'x') {
        highlights.push({ idx: i, color: 'hint-error-red' });
      }

      // Check for dots that should be stars
      if (userChoice === 'dot' && correctChoice === 'x') {
        highlights.push({ idx: i, color: 'hint-error-red' });
      }
    }

    if (highlights.length > 0) {
      return {
        success: true,
        description: "Can't provide a hint, fix the errors marked in red first",
        highlights: highlights,
        marks: [],
        boardIdx: undefined // Highlight across both boards
      };
    }

    return null;
  }

  hintAlreadySolved() {
    const isSolved = this.game.state.every((v, i) => 
      (this.game.solution[i] === 'x') ? v === 'star' : v !== 'star'
    );
    if (!isSolved) return null;

    return {
      success: true,
      description: "The puzzle is already solved!",
      highlights: [],
      marks: [],
      boardIdx: undefined
    };
  }

  hintSingleCellRegion() {
    for (let bIdx = 0; bIdx < 2; bIdx++) {
      for (const region of this.getUnsolvedRegions(bIdx)) {
        if (region.indices.length === 1 && this.game.state[region.indices[0]] === 'none') {
          return {
            success: true,
            description: `This region only has one square, so it must contain a star`,
            highlights: [{ idx: region.indices[0], color: 'hint-target-green' }],
            marks: [],
            boardIdx: region.boardIdx
          };
        }
      }
    }
    return null;
  }

  hintOnlyEmpty() {
    for (const unit of this.units) {
      const empty = unit.indices.filter(i => this.game.state[i] === 'none');
      const hasStar = unit.indices.some(i => this.game.state[i] === 'star');
      if (hasStar || empty.length !== 1) continue;

      const unitType = unit.label.includes("Row") ? "row"
        : unit.label.includes("Column") ? "column"
        : "region";

      return {
        success: true,
        description: `In this ${unitType}, only one spot is left for a star.`,
        highlights: unit.indices
        .filter(i => i !== empty[0])
        .map(idx => ({ idx, color: 'hint-source-blue' })),
        marks: [{ idx: empty[0], color: 'hint-target-green' }],
        boardIdx: unit.boardIdx
      };
    }
    return null;
  }

  getBlockedByStars(unitType) {
    for (const unit of this.units.filter(u => u.label.includes(unitType))) {
      const stars = unit.indices.filter(idx => this.game.state[idx] === 'star');
      const empty = unit.indices.filter(idx => this.game.state[idx] === 'none');

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

  hintExcludeSolvedUnit() {
    const types = [
      { key: "Row",    desc: "This row already has its star, so the remaining empty cells must be dots." },
      { key: "Column", desc: "This column already has its star, so the remaining empty cells must be dots." },
      { key: "Region", desc: "This region already has its star, so all other cells must be dots." },
    ];
    for (const { key, desc } of types) {
      const result = this.getBlockedByStars(key);
      if (result) return { success: true, description: desc, ...result, boardIdx: result.boardIdx ?? undefined };
    }
    return null;
  }

  hintExcludeAdjacency() {
    for (let i = 0; i < this.n * this.n; i++) {
      if (this.game.state[i] !== 'star') continue;

      const marks = this.getNeighbors(i)
        .filter(nb => this.game.state[nb] === 'none')
        .map(nb => ({ idx: nb, color: 'hint-target-yellow' }));

      if (marks.length > 0) {
        return {
          success: true,
          description: "Stars cannot touch each other so the marked cells must be dots",
          highlights: [{ idx: i, color: 'hint-source-blue' }],
          marks,
          boardIdx: undefined
        };
      }
    }
    return null;
  }

  hintDomino() {
    const n = this.n;

    for (let bIdx = 0; bIdx < 2; bIdx++) {
      for (const region of this.getUnsolvedRegions(bIdx)) {
        const empty = region.indices.filter(i => this.game.state[i] === 'none');
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
          .filter(idx => this.game.state[idx] === 'none');

        if (targets.length > 0) {
          return {
            success: true,
            description: "A star must be in the blue domino, so the circled cells must contain dots.",
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

  hintUnitRegionSync(N) {
    const n = this.n;

    for (const axis of ["Row", "Column"]) {
      const axisIndices = this.axisIndices[axis];

      for (let bIdx = 0; bIdx < 2; bIdx++) {
        const unsolvedRegs = this.getUnsolvedRegions(bIdx);
        const cellToRegionMap = this.buildCellToRegionMap(bIdx);

        for (let startU = 0; startU <= n - N; startU++) {
          const windowIndices = Array.from({length: N}, (_, i) => axisIndices[startU + i]).flat();
          const windowSet = new Set(windowIndices);

          const starsInWindow = windowIndices.filter(i => this.game.state[i] === 'star').length;
          const requiredCount = N - starsInWindow;
          if (requiredCount <= 0) continue;

          const availInUnits = windowIndices.filter(i => this.game.state[i] === 'none');
          if (availInUnits.length === 0) continue;

          // STANDARD: N regions trapped inside the window
          const pinnedRegs = unsolvedRegs.filter(reg => {
            const regAvail = reg.indices.filter(i => this.game.state[i] === 'none');
            return regAvail.length > 0 && regAvail.every(idx => windowSet.has(idx));
          });

          if (pinnedRegs.length === requiredCount) {
            const regUnion = new Set(pinnedRegs.flatMap(r => r.indices));
            const targets = windowIndices.filter(idx =>
              this.game.state[idx] === 'none' && !regUnion.has(idx)
            );
            if (targets.length > 0) return this.formatHint(pinnedRegs, targets, axis, N, bIdx, "Standard");
          }

          // INVERSE: window trapped inside N regions
          const coveringRegLabels = new Set(availInUnits.map(idx => cellToRegionMap[idx]).filter(Boolean));
          const coveringUnsolved = Array.from(coveringRegLabels)
            .map(label => unsolvedRegs.find(r => r.label === label))
            .filter(Boolean);

          if (coveringUnsolved.length === requiredCount) {
            const regUnion = new Set(coveringUnsolved.flatMap(r => r.indices));
            const targets = Array.from(regUnion).filter(idx =>
              !windowSet.has(idx) && this.game.state[idx] === 'none'
            );
            if (targets.length > 0) return this.formatHint(coveringUnsolved, targets, axis, N, bIdx, "Inverse");
          }
        }
      }
    }
    return null;
  }

  hintManyRegionsSync() {
    for (let n = 4; n < this.n; n++) {
      const result = this.hintUnitRegionSync(n);
      if (result) return result;
    }
    return null;
  }

  formatHint(sourceRegs, targets, axis, N, bIdx, type) {
    const n = this.n;
    // Ensure we are working with a clean set of target indices
    const targetSet = new Set(targets);

    // 1. Identify all empty cells in the involved regions
    const allRegEmpty = sourceRegs.flatMap(r => 
      r.indices.filter(i => this.game.state[i] === 'none')
    );

    // 2. EXCLUSIVE FILTER:
    // A square gets a blue background ONLY if it is NOT a target circle
    const sourceHighlights = allRegEmpty
      .filter(idx => !targetSet.has(idx))
      .map(idx => ({ idx, color: 'hint-source-blue' }));

    const unitType = axis.toLowerCase();
    const unitsPhrase = N === 1 ? `this ${unitType}` : `these ${N} ${unitType}s`;

    const description = type === "Standard"
      ? `The star for ${unitsPhrase} must fall in one of the blue regions. Circled squares must be dots.`
      : `All empty cells in ${unitsPhrase} are covered by the blue regions. Circled squares must be dots.`;

    return {
      success: true,
      boardIdx: bIdx,
      description: description,
      highlights: sourceHighlights,
      marks: targets.map(idx => ({ idx, color: 'hint-target-yellow' }))
    };
  }

  hintUnitSeesTooMuch() {
    const n = this.n;

    for (const unit of this.units) {
      // Only consider unsolved rows and columns
      if (unit.label.includes("Region")) continue;
      if (unit.indices.some(i => this.game.state[i] === 'star')) continue;

      const candidates = unit.indices.filter(i => this.game.state[i] === 'none');
      if (candidates.length === 0) continue;

      // Precompute coordinates for each candidate
      const candCoords = candidates.map(i => ({ i, r: Math.floor(i / n), c: i % n }));

      // Check every empty cell not in this unit
      const targets = [];
      for (let i = 0; i < n * n; i++) {
        if (this.game.state[i] !== 'none' || unit.indices.includes(i)) continue;

        const ir = Math.floor(i / n);
        const ic = i % n;

        const canSeeAll = candCoords.every(({ r, c }) =>
          ir === r || ic === c || (Math.abs(ir - r) <= 1 && Math.abs(ic - c) <= 1)
        );

        if (canSeeAll) targets.push({ idx: i, color: 'hint-target-yellow' });
      }

      if (targets.length > 0) {
        const unitType = unit.label.includes("Row") ? "row" : "column";
        return {
          success: true,
          boardIdx: undefined,
          description: `No matter where the star goes in this ${unitType}, it would block the circled cell. So the circled cell must be a dot.`,
          highlights: candidates.map(i => ({ idx: i, color: 'hint-source-blue' })),
          marks: targets,
        };
      }
    }
    return null;
  }

  hintSeesTooMuch(nTarget = null) {
    const n = this.n;

    for (let bIdx = 0; bIdx < 2; bIdx++) {
      for (const region of this.getUnsolvedRegions(bIdx)) {
        const candidates = region.indices.filter(i => this.game.state[i] === 'none');

        if (candidates.length === 0) continue;
        if (nTarget !== null && candidates.length !== nTarget) continue;

        // Precompute row/col for each candidate
        const candCoords = candidates.map(i => ({ i, r: Math.floor(i / n), c: i % n }));

        const targets = [];
        for (let i = 0; i < n * n; i++) {
          if (this.game.state[i] !== 'none' || region.indices.includes(i)) continue;

          const ir = Math.floor(i / n);
          const ic = i % n;

          const canSeeAll = candCoords.every(({ r, c }) =>
            ir === r || ic === c || (Math.abs(ir - r) <= 1 && Math.abs(ic - c) <= 1)
          );

          if (canSeeAll) targets.push({ idx: i, color: 'hint-target-yellow' });
        }

        if (targets.length > 0) {
          return {
            success: true,
            description: `No matter where the star goes in the blue region, it would block the circled cells. So they must be dots.`,
            highlights: candidates.map(idx => ({ idx, color: 'hint-source-blue' })),
            marks: targets,
            boardIdx: bIdx,
          };
        }
      }
    }
    return null;
  }

  // 7788 notable example
  hintDisjointUnitRegionSync(N) {
    const n = this.n;

    for (const axis of ["Row", "Column"]) {
      const axisIndices = this.axisIndices[axis];

      for (let bIdx = 0; bIdx < 2; bIdx++) {
        const unsolvedRegs = this.getUnsolvedRegions(bIdx);
        const cellToRegionMap = this.buildCellToRegionMap(bIdx);

        for (const combo of this.getCombinations(Array.from({length: n}, (_, i) => i), N)) {
          const windowIndices = combo.flatMap(u => axisIndices[u]);
          const windowSet = new Set(windowIndices);

          const starsInWindow = windowIndices.filter(i => this.game.state[i] === 'star').length;
          const requiredCount = N - starsInWindow;
          if (requiredCount <= 0) continue;

          const availInUnits = windowIndices.filter(i => this.game.state[i] === 'none');
          if (availInUnits.length === 0) continue;

          const coveringRegLabels = new Set(availInUnits.map(idx => cellToRegionMap[idx]).filter(Boolean));
          const coveringUnsolved = Array.from(coveringRegLabels)
            .map(label => unsolvedRegs.find(r => r.label === label))
            .filter(Boolean);

          if (coveringUnsolved.length !== requiredCount) continue;

          const regUnion = new Set(coveringUnsolved.flatMap(r => r.indices));
          const targets = Array.from(regUnion)
            .filter(idx => !windowSet.has(idx) && this.game.state[idx] === 'none');

          if (targets.length > 0) {
            const unitLabel = N === 1
              ? `${axis} ${combo[0] + 1}`
              : `${axis}s ${combo.map(u => u + 1).join(", ")}`;
            const regPhrase = N === 1 ? "this region" : `these ${N} regions`;

            return {
              success: true,
              boardIdx: bIdx,
              description: `These ${combo.length} ${axis.toLowerCase()}s can only be satisfied by stars in the highlighted regions. Other cells in those ${axis.toLowerCase()}s must be dots.`,
              highlights: [
                ...availInUnits.filter(idx => regUnion.has(idx)).map(idx => ({ idx, color: 'hint-source-blue' })),
              ],
              marks: targets.map(idx => ({ idx, color: 'hint-target-yellow' }))
            };
          }
        }
      }
    }
    return null;
  }

  // Simple helper to get all combinations of an array of size k
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

  hintRegionSubsetSync(N) {
    const comboSets = [];

    for (let bIdx = 0; bIdx < 2; bIdx++) {
      for (const combo of this.getCombinations(this.getUnsolvedRegions(bIdx), N)) {
        comboSets.push({
          label: `Board ${bIdx + 1} Combo (${combo.map(r => r.label.split(' ').pop()).join(',')})`,
          indices: new Set(combo.flatMap(r => r.indices)),
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
          .filter(idx => !setA.indices.has(idx) && this.game.state[idx] === 'none');

        if (targets.length > 0) {
          return this.formatSubsetHint(setA.regions, targets, setA.boardIdx, setA.label, setB.label);
        }
      }
    }
    return null;
  }

  formatSubsetHint(sourceRegs, targets, bIdx, labelA, labelB) {
    const targetSet = new Set(targets);
    const sourceHighlights = sourceRegs.flatMap(r =>
      r.indices.filter(i => this.game.state[i] === 'none' && !targetSet.has(i))
    ).map(idx => ({ idx, color: 'hint-source-blue' }));

    const description = sourceRegs.length === 1
      ? `One region is a subset of another. Yellow circles must be dots.`
      : `${sourceRegs.length} regions are a subset of ${sourceRegs.length} other regions. Yellow circles must be dots.`;

    return {
      success: true,
      boardIdx: undefined,
      description,
      highlights: sourceHighlights,
      marks: targets.map(idx => ({ idx, color: 'hint-target-yellow' }))
    };
  }

  hintCrossBoardRegionPinned(N, axis = "Row") {
    const n = this.n;

    // Build unsolved region descriptors from both boards
    const unsolvedRegions = [0, 1].flatMap(bIdx =>
      this.getUnsolvedRegions(bIdx)
      .filter(reg => reg.indices.some(i => this.game.state[i] === 'none'))
      .map(reg => ({
        label: `B${bIdx + 1}-${reg.label.split(' ').pop()}`,
        allIdxs: new Set(reg.indices),
        availableIdxs: reg.indices.filter(i => this.game.state[i] === 'none'),
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
        for (let b = 0; b < 2; b++) {
          const boardOffset = b * (n * n);
          for (let i = 0; i < n; i++) {
            const absoluteIdx = (axis === "Row" ? u * n + i : i * n + u) + boardOffset;
            if (!regionUnion.has(absoluteIdx) && this.game.state[absoluteIdx] === 'none') {
              targets.push(absoluteIdx);
            }
          }
        }
      }

      if (targets.length > 0) return this.formatCrossBoardHint(combo, targets, axis, uList);
    }
    return null;
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

  formatCrossBoardHint(combo, targets, axis, uList) {
    const targetSet = new Set(targets);
    const labels = combo.map(r => r.label).join(", ");
    const unitNums = uList.map(u => u + 1).join(", ");

    // Source highlights: Empty squares in regions that aren't targets
    const sourceHighlights = combo.flatMap(r => 
      r.availableIdxs.filter(idx => !targetSet.has(idx))
    ).map(idx => ({ idx, color: 'hint-source-blue' }));

    return {
      success: true,
      boardIdx: undefined,
      description: `Cross-board: These ${combo.length} regions must place their stars in the same ${combo.length} ${axis.toLowerCase()}s. Empty cells in those ${axis.toLowerCase()}s outside these regions must be dots.`,
      highlights: sourceHighlights,
      marks: targets.map(idx => ({ idx, color: 'hint-target-yellow' }))
    };
  }

  hintPartialOverlap() {
    const n = this.n;

    const board0Regions = this.getUnsolvedRegions(0);
    const board1Regions = this.getUnsolvedRegions(1);

    for (const regA of board0Regions) {
      for (const regB of board1Regions) {
        const setA = new Set(regA.indices.filter(i => this.game.state[i] !== 'dot'));
        const setB = new Set(regB.indices.filter(i => this.game.state[i] !== 'dot'));

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

        const targets = shared.filter(i => this.game.state[i] === 'none');
        if (targets.length === 0) continue;

        return {
          success: true,
          boardIdx: undefined,
          description: `These two regions overlap everywhere except one row or column. A star anywhere in that line would block both regions, so those cells must be dots.`,
          highlights: shared
          .filter(i => this.game.state[i] === 'none')
          .map(i => ({ idx: i, color: 'hint-source-blue' })),
          marks: [
            ...onlyA.filter(i => this.game.state[i] === 'none').map(i => ({ idx: i, color: 'hint-target-yellow' })),
            ...onlyB.filter(i => this.game.state[i] === 'none').map(i => ({ idx: i, color: 'hint-target-yellow' })),
          ]
        };
      }
    }
    return null;
  }

  hintLookaheadHalf() {
    const n = this.n;
    const boardSize = n * n;

    const emptyIndices = this.game.state
      .flatMap((val, idx) => val === 'none' ? [idx] : []);

    for (const testIdx of emptyIndices) {
      const sandboxState = [...this.game.state];
      sandboxState[testIdx] = 'star';

      // Half stage: only apply sees-star consequences, no forced-star pass
      const row = Math.floor(testIdx / n);
      const col = testIdx % n;

      // Eliminate rest of row and column
      for (let j = 0; j < n; j++) {
        const rIdx = row * n + j;
        const cIdx = j * n + col;
        if (sandboxState[rIdx] === 'none' && rIdx !== testIdx) sandboxState[rIdx] = 'dot';
        if (sandboxState[cIdx] === 'none' && cIdx !== testIdx) sandboxState[cIdx] = 'dot';
      }

      // Eliminate neighbors
      this.getNeighbors(testIdx).forEach(nb => {
        if (sandboxState[nb] === 'none') sandboxState[nb] = 'dot';
      });

      // Eliminate rest of each region containing testIdx
      for (let bIdx = 0; bIdx < 2; bIdx++) {
        const regChar = this.game.regions[bIdx][testIdx];
        for (let i = 0; i < n * n; i++) {
          if (this.game.regions[bIdx][i] === regChar && sandboxState[i] === 'none') {
            sandboxState[i] = 'dot';
          }
        }
      }

      if (this._isBoardBroken(sandboxState)) {
        return {
          success: true,
          boardIdx: undefined,
          description: `Placing a star here would make the puzzle unsolvable. This square must be a dot.`,
          highlights: [],
          marks: [{ idx: testIdx, color: 'hint-target-yellow' }]
        };
      }
    }
    return null;
  }

  hintLookahead(nStages) {
    const n = this.n;
    const boardSize = n * n;

    // Find all empty cells to test
    const emptyIndices = this.game.state
      .flatMap((val, idx) => val === 'none' ? [idx] : []);

    for (const testIdx of emptyIndices) {
      // 1. Create a sandbox
      let sandboxState = [...this.game.state];
      sandboxState[testIdx] = 'star';

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
          success: true,
          boardIdx: undefined,
          description: `Placing a star here would make the puzzle unsolvable. This square must be a dot.`,
          highlights: [],
          marks: [{ idx: testIdx, color: 'hint-target-yellow' }]
        };
      }
    }
    return null;
  }

  // Checks for rule violations: empty rows/cols/regions or touching stars 
  _isBoardBroken(state) {
    const n = this.n;
    const boardSize = n * n;

    // Check Rows, Columns, and Regions
    const allUnitIndices = this.units.map(u => u.indices);

    for (const indices of allUnitIndices) {
      const hasStar = indices.some(i => state[i] === 'star');
      const hasEmpty = indices.some(i => state[i] === 'none');

      // Contradiction: Unit needs a star but has no stars and no empty spots 
      //
      if (!hasStar && !hasEmpty) return true;
    }

    // Check for Adjacency: Two stars touching
    for (let i = 0; i < state.length; i++) {
      if (state[i] === 'star') {
        const neighbors = this.getNeighbors(i);
        if (neighbors.some(nb => state[nb] === 'star')) return true;
      }
    }

    return false;
  }

   // Simulates basic "Sees Star" and "Only Empty" logic 
  _applySimulatedRules(state) {
    const n = this.n;

    // 1. If a cell sees a star, it must be a dot (Sees Star)
    for (let i = 0; i < state.length; i++) {
      if (state[i] === 'star') {
        const row = Math.floor(i / n);
        const col = i % n;
        for (let j = 0; j < n; j++) {
          const rIdx = row * n + j;
          const cIdx = j * n + col;
          if (state[rIdx] === 'none' && rIdx !== i) state[rIdx] = 'dot';
          if (state[cIdx] === 'none' && cIdx !== i) state[cIdx] = 'dot';
        }
        this.getNeighbors(i).forEach(nb => {
          if (state[nb] === 'none') state[nb] = 'dot';
        });
      }
    }
    const regions = this.units.filter(u => u.label.includes("Region"));
    for (const reg of regions) {
      const hasStar = reg.indices.some(idx => state[idx] === 'star');
      if (hasStar) {
        reg.indices.forEach(idx => {
          if (state[idx] === 'none') state[idx] = 'dot';
        });
      }
    }

    // 2. If a unit has only one empty spot left, it must be a star (Only Empty) 
    //
    for (const u of this.units) {
      const noneIndices = u.indices.filter(i => state[i] === 'none');
      const starIndices = u.indices.filter(i => state[i] === 'star');
      if (starIndices.length === 0 && noneIndices.length === 1) {
        state[noneIndices[0]] = 'star';
      }
    }
  }

  getNeighbors(idx) {
    const n = this.n;
    const boardSize = n * n;
    const bIdx = idx < boardSize ? 0 : 1;
    const offset = bIdx * boardSize;
    const relativeIdx = idx % boardSize;

    const row = Math.floor(relativeIdx / n);
    const col = relativeIdx % n;
    const neighbors = [];

    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = row + dr;
        const nc = col + dc;

        if (nr >= 0 && nr < n && nc >= 0 && nc < n) {
          neighbors.push((nr * n + nc) + offset);
        }
      }
    }
    return neighbors;
  }
}

