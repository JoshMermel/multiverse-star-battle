// solver.js
export class PuzzleSolver {
  constructor(game) {
    this.game = game;
    this.n = game.n;
  }

  // Add this helper to your PuzzleSolver class
  getRegionAt(idx, boardIdx) {
    const units = this.getAllUnits();
    // Ensure we are looking specifically for the region containing this index
    // on the board currently being processed.
    return units.find(u => 
      u.boardIdx === boardIdx && 
      u.label.toLowerCase().includes("region") && 
      u.indices.includes(idx)
    );
  }

  // Move all your hint logic here
  getHint() {
    const rules = [
      this.hintCheckForErrors,
      this.hintSingleCellRegion,
      this.hintOnlyEmpty,
      this.hintExcludeRow,
      this.hintExcludeCol,
      this.hintExcludeAdjacency,
      this.hintExcludeRegion,
      this.hintDomino,
      () => this.hintUnitRegionSync(1),
      () => this.hintSeesTooMuch(2),
      () => this.hintSeesTooMuch(3),
      () => this.hintUnitRegionSync(2),
      () => this.hintSeesTooMuch(null),
      () => this.hintUnitRegionSync(3),
      () => this.hintDisjointUnitRegionSync(2),
      this.hintManyRegionsSync,
      () => this.hintRegionSubsetSync(1),
      () => this.hintDisjointUnitRegionSync(3),
      () => this.hintCrossBoardRegionPinned(2, "Row"),
      () => this.hintCrossBoardRegionPinned(2, "Col"),
      //    self.rule_lookahead_half_stage, 50),
      () => this.hintCrossBoardRegionPinned(3, "Row"),
      () => this.hintCrossBoardRegionPinned(3, "Col"),
      //    self.rule_crossboard_partial_overlap, 75),
      () => this.hintRegionSubsetSync(2),
      () => this.hintLookahead(1),
      () => this.hintLookahead(2),
      () => this.hintLookahead(3),
      () => this.hintLookahead(4),
      () => this.hintLookahead(8),
    ];

    for (let rule of rules) {
      const hint = rule.call(this);
      if (hint) return hint;
    }
    return null;
  }

  hintCheckForErrors() {
    const n = this.n;
    const highlights = [];
    let wrongStarCount = 0;
    let wrongDotCount = 0;

    // We must loop through the state stored in the game instance
    for (let i = 0; i < n * n; i++) {
      const userChoice = this.game.state[i]; // Point to this.game
      const correctChoice = this.game.solution[i]; // 'x' for star, '.' for dot

      // Check for misplaced stars
      if (userChoice === 'star' && correctChoice !== 'x') {
        highlights.push({ idx: i, color: 'hint-error-red' });
        wrongStarCount++;
      }

      // Check for dots that should be stars
      if (userChoice === 'dot' && correctChoice === 'x') {
        highlights.push({ idx: i, color: 'hint-error-red' });
        wrongDotCount++;
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

  hintSingleCellRegion() {
    const units = this.getAllUnits().filter(u => u.label.includes("Region"));

    for (const region of units) {
      // Only look at regions that don't have a star yet
      const hasStar = region.indices.some(i => this.game.state[i] === 'star');
      if (hasStar) continue;

      // Find cells that aren't dotted
      const available = region.indices.filter(i => this.game.state[i] === 'none');

      // If the entire region consists of exactly one empty cell
      if (region.indices.length === 1 && available.length === 1) {
        const targetIdx = available[0];

        return {
          success: true,
          description: `This region only has one square, so it must contain a star!`,
          highlights: [{ idx: targetIdx, color: 'hint-target-yellow' }],
          marks: [], // No dots to place, just pointing out the star
          boardIdx: region.boardIdx
        };
      }
    }
    return null;
  }

  hintOnlyEmpty() {
    const units = this.getAllUnits();

    for (const unit of units) {
      const hasStar = unit.indices.some(i => this.game.state[i] === 'star'); 
      if (hasStar) continue;

      const empty = unit.indices.filter(i => this.game.state[i] === 'none');

      if (empty.length === 1) {
        const targetIdx = empty[0];
        const blockedSquares = unit.indices.filter(i => i !== targetIdx);

        // Determine generic type (Row, Column, or Region)
        let unitType = "unit";
        if (unit.label.includes("Row")) unitType = "row";
        else if (unit.label.includes("Column")) unitType = "column";
        else if (unit.label.includes("Region")) unitType = "region";

        return {
          success: true,
          // Clean, non-verbose description
          description: `In this ${unitType}, only one spot is left for a star.`,
          // Blue highlights the "reason" (the blocked cells)
          highlights: blockedSquares.map(idx => ({ idx, color: 'hint-source-blue' })),
          // Yellow circle marks the forced star
          marks: [{ idx: targetIdx, color: 'hint-target-yellow' }],
          boardIdx: unit.boardIdx 
        };
      }
    }
    return null;
  }

  getBlockedByStars(unitType) {
    const units = this.getAllUnits().filter(u => u.label.includes(unitType));

    for (const unit of units) {
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

  hintExcludeRow() {
    const result = this.getBlockedByStars("Row");
    if (!result) return null;

    return {
      success: true,
      description: "This row already has its star, so the remaining empty cells must be dots.",
      highlights: result.highlights,
      marks: result.marks,
      boardIdx: undefined 
    };
  }

  hintExcludeCol() {
    const result = this.getBlockedByStars("Column");
    if (!result) return null;

    return {
      success: true,
      description: "This column already has its star, so the remaining empty cells must be dots.",
      highlights: result.highlights,
      marks: result.marks,
      boardIdx: undefined 
    };
  }

  hintExcludeAdjacency() {
    const n = this.n;

    // Iterate through every cell to find stars
    for (let i = 0; i < n * n; i++) {
      if (this.game.state[i] === 'star') {
        const r = Math.floor(i / n);
        const c = i % n;
        const adjacentMarks = [];

        // Check the 8-way neighborhood (King's move)
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue; 

            const nr = r + dr, nc = c + dc;
            if (nr >= 0 && nr < n && nc >= 0 && nc < n) {
              const neighborIdx = nr * n + nc;
              // If we find an empty neighbor, we've found our hint
              if (this.game.state[neighborIdx] === 'none') {
                adjacentMarks.push({ idx: neighborIdx, color: 'hint-target-yellow' });
              }
            }
          }
        }

        // If this specific star has empty neighbors, return the hint immediately
        if (adjacentMarks.length > 0) {
          return {
            success: true,
            description: "Stars cannot touch each other so the marked cells must be dots",
            highlights: [{ idx: i, color: 'hint-source-blue' }],
            marks: adjacentMarks,
            boardIdx: undefined // Adjacency rules apply to the shared state
          };
        }
      }
    }
    return null;
  }

  hintExcludeRegion() {
    const result = this.getBlockedByStars("Region");
    if (!result) return null;

    return {
      success: true,
      description: "This region already has its star, so all other cells must be dots",
      highlights: result.highlights,
      marks: result.marks,
      boardIdx: result.boardIdx 
    };
  }

  hintDomino() {
    const n = this.n;
    const units = this.getAllUnits();
    const regions = units.filter(u => u.boardIdx !== undefined);

    for (const region of regions) {
      if (region.indices.some(i => this.game.state[i] === 'star')) continue;

      const empty = region.indices.filter(i => this.game.state[i] === 'none');
      if (empty.length !== 2) continue;

      const [idxA, idxB] = empty;
      const rA = Math.floor(idxA / n), cA = idxA % n;
      const rB = Math.floor(idxB / n), cB = idxB % n;

      const rowDist = Math.abs(rA - rB);
      const colDist = Math.abs(cA - cB);
      if (rowDist + colDist !== 1) continue; 

      let blockedIndices = new Set();
      let reason = "";

      // Case A: Shared Row (and adjacent)
      if (rA === rB) {
        for (let k = 0; k < n; k++) blockedIndices.add(rA * n + k);
        reason = "row";
      } 
      // Case B: Shared Column (and adjacent)
      else if (cA === cB) {
        for (let k = 0; k < n; k++) blockedIndices.add(k * n + cA);
        reason = "column";
      }

      const getAdj = (idx) => {
        const neighbors = new Set();
        const r = Math.floor(idx / n), c = idx % n;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const nr = r + dr, nc = c + dc;
            if (nr >= 0 && nr < n && nc >= 0 && nc < n) neighbors.add(nr * n + nc);
          }
        }
        return neighbors;
      };

      const adjA = getAdj(idxA);
      const adjB = getAdj(idxB);

      // Add intersection of 8-way neighborhoods
      [...adjA].forEach(idx => {
        if (adjB.has(idx)) blockedIndices.add(idx);
      });

      // Clean up
      blockedIndices.delete(idxA);
      blockedIndices.delete(idxB);

      const targets = Array.from(blockedIndices).filter(idx => this.game.state[idx] === 'none');

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
    return null;
  }

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

  hintUnitRegionSync(N) {
    const n = this.n;
    const units = this.getAllUnits();
    const axes = ["Row", "Column"];

    for (const axis of axes) {
      // Generate pure index sets for rows/cols (axis_indices in python)
      const axisIndices = [];
      for (let i = 0; i < n; i++) {
        const unitIdxs = [];
        for (let j = 0; j < n; j++) {
          unitIdxs.push(axis === "Row" ? i * n + j : j * n + i);
        }
        axisIndices.push(unitIdxs);
      }

      for (let bIdx = 0; bIdx < 2; bIdx++) {
        // Setup board-specific region data (regions[b_idx] in python)
        const boardRegions = units.filter(u => u.label.includes("Region") && u.boardIdx === bIdx);
        const unsolvedRegs = boardRegions.filter(reg => 
          !reg.indices.some(i => this.game.state[i] === 'star')
        );

        // Mapping: index -> region_label (cell_to_region in python)
        const cellToRegionMap = {};
        boardRegions.forEach(reg => {
          reg.indices.forEach(idx => {
            cellToRegionMap[idx % (n * n)] = reg.label;
          });
        });

        for (let startU = 0; startU <= n - N; startU++) {
          const uRange = Array.from({length: N}, (_, i) => startU + i);
          const windowIndices = uRange.flatMap(u => axisIndices[u]);
          const windowSet = new Set(windowIndices);

          const starsInWindow = windowIndices.filter(i => this.game.state[i] === 'star').length;
          const requiredCount = N - starsInWindow;
          if (requiredCount <= 0) continue;

          const availInUnits = windowIndices.filter(i => this.game.state[i] === 'none');
          if (availInUnits.length === 0) continue;

          // 1. STANDARD: N regions trapped in window units
          let pinnedRegs = [];
          for (const region of unsolvedRegs) {
            const regAvail = region.indices.filter(i => this.game.state[i] === 'none');
            if (regAvail.length > 0 && regAvail.every(idx => windowSet.has(idx % (n * n)))) {
              pinnedRegs.push(region);
            }
          }

          if (pinnedRegs.length === requiredCount) {
            const regUnion = new Set(pinnedRegs.flatMap(r => r.indices.map(i => i % (n * n))));
            const targets = windowIndices.filter(idx => 
              this.game.state[idx] === 'none' && !regUnion.has(idx % (n * n))
            );
            if (targets.length > 0) return this.formatHint(pinnedRegs, targets, axis, N, bIdx, "Standard");
          }

          // 2. INVERSE: Window units trapped in N regions
          // covering_regs = {p.cell_to_region[b_idx][i] for i in avail_in_units}
          const coveringRegLabels = new Set(availInUnits.map(idx => cellToRegionMap[idx % (n * n)]).filter(Boolean));
          const coveringUnsolved = Array.from(coveringRegLabels)
            .map(label => unsolvedRegs.find(r => r.label === label))
            .filter(Boolean);

          if (coveringUnsolved.length === requiredCount) {
            const regUnion = new Set(coveringUnsolved.flatMap(r => r.indices.map(i => i % (n * n))));
            // targets = (reg_union - unit_idxs)
            const targets = Array.from(regUnion).filter(idx => 
              !windowSet.has(idx) && this.game.state[idx] === 'none'
            );

            if (targets.length > 0) {
              return this.formatHint(coveringUnsolved, targets, axis, N, bIdx, "Inverse");
            }
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
    const unitNums = N === 1 ? `this 1 ${unitType}` : `${N} ${unitType}s`;

    const description = type === "Standard" 
      ? `The stars for these ${unitNums} are forced into the blue regions. Circled squares must be dots.`
      : `These ${unitNums} are entirely contained within these ${N} regions. Circled squares must be dots.`;

    return {
      success: true,
      boardIdx: bIdx,
      description: description,
      highlights: sourceHighlights,
      marks: targets.map(idx => ({ idx, color: 'hint-target-yellow' }))
    };
  }

  hintSeesTooMuch(nTarget = null) {
    const n = this.n;
    const units = this.getAllUnits();

    const boardRegions = units.filter(u => u.label.includes("Region"));
    for (const region of boardRegions) {
      // 1. Skip if the region is already solved
      // REMOVED the offset addition here; region.indices are already global
      if (region.indices.some(i => this.game.state[i] === 'star')) continue;

      // 2. Filter empty cells in the region
      const candidates = region.indices.filter(idx => 
        this.game.state[idx] === 'none'
      );

      if (nTarget !== null && candidates.length !== nTarget) continue;
      if (candidates.length === 0) continue;

      const targets = []; 
      const bIdx = region.boardIdx;

      // 3. Check every empty cell ON THIS BOARD
      for (let i = 0; i < n * n; i++) {
        // Calculate the global index for the cell we are testing

        // Must be empty and NOT part of the region itself
        if (this.game.state[i] !== 'none' || region.indices.includes(i)) continue;

        // Normalize coordinates for the "canSee" math
        const ir = Math.floor(i / n);
        const ic = i % n;

        const canSeeAll = candidates.every(cand => {
          const tr = Math.floor(cand / n);
          const tc = cand % n;

          return ir === tr || ic === tc || (Math.abs(ir - tr) <= 1 && Math.abs(ic - tc) <= 1);
        });

        if (canSeeAll) {
          targets.push({ idx: i, color: 'hint-target-yellow' });
        }
      }

      if (targets.length > 0) {
        return {
          success: true,
          description: 'The circles must be dots, or the blue region would be unsolvable.',
          highlights: candidates.map(idx => ({ 
            idx: idx, // Already global
            color: 'hint-source-blue' 
          })),
          marks: targets,
          boardIdx: bIdx,
        };
      }
    }
    return null;
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

  // 7788 notable example
  hintDisjointUnitRegionSync(N) {
    const n = this.n;
    const boardSize = n * n;
    const units = this.getAllUnits();
    const axes = ["Row", "Column"];

    for (const axis of axes) {
      const axisIndices = this.getAxisIndices(axis); 

      for (let bIdx = 0; bIdx < 2; bIdx++) {
        // Filter regions strictly for this board
        const boardRegions = units.filter(u => u.label.includes("Region") && u.boardIdx === bIdx);

        // Map index (0-63) to region labels for localized lookup
        const cellToRegionMap = {};
        boardRegions.forEach(reg => {
          reg.indices.forEach(idx => {
            cellToRegionMap[idx] = reg.label;
          });
        });

        const unsolvedRegs = boardRegions.filter(reg => 
          !reg.indices.some(i => this.game.state[i] === 'star')
        );

        const combinations = this.getCombinations(Array.from({length: n}, (_, i) => i), N);

        for (const combo of combinations) {
          const windowIndices = combo.flatMap(u => axisIndices[u]);
          const windowSet = new Set(windowIndices);

          const starsInWindow = windowIndices.filter(i => this.game.state[i] === 'star').length;
          const requiredCount = N - starsInWindow;

          if (requiredCount <= 0) continue;

          const availInUnits = windowIndices.filter(i => this.game.state[i] === 'none');
          if (availInUnits.length === 0) continue;

          // Identify regions covering the empty spots in these disjoint units
          const coveringRegLabels = new Set(availInUnits.map(idx => cellToRegionMap[idx]).filter(Boolean));
          const coveringUnsolved = Array.from(coveringRegLabels)
            .map(label => unsolvedRegs.find(r => r.label === label))
            .filter(Boolean);

          // Logic: If N units are trapped in exactly N regions
          if (coveringUnsolved.length === requiredCount) {
            const regUnion = new Set(coveringUnsolved.flatMap(r => r.indices));

            // Identify target cells: indices in these regions that are NOT in the N units
            const targets = Array.from(regUnion).filter(idx => 
              !windowSet.has(idx) && this.game.state[idx] === 'none'
            );

            if (targets.length > 0) {
              const unitNums = combo.map(u => u + 1).join(" & ");

              return {
                success: true,
                boardIdx: bIdx,
                description: `${axis}s ${unitNums} can only fit their stars within these ${N} regions. Other parts of those regions must be dots.`,
                highlights: [
                  // Only highlight cells that are BOTH in the region and in the chosen units
                  ...availInUnits.filter(idx => regUnion.has(idx)).map(idx => ({ idx, color: 'hint-source-blue' })),
                  // Draw the row/column borders for context
                  ...windowIndices.map(idx => ({ idx, color: 'hint-border-gray' }))
                ],
                marks: targets.map(idx => ({ idx, color: 'hint-target-yellow' }))
              };
            }
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
    const n = this.n;
    const units = this.getAllUnits();
    const combo_sets = [];

    // 1. Collect all combinations of N regions for both boards
    for (let bIdx = 0; bIdx < 2; bIdx++) {
      const boardRegions = units.filter(u => u.label.includes("Region") && u.boardIdx === bIdx);

      // Filter for regions that don't have their star yet
      const unsolvedRegs = boardRegions.filter(reg => 
        !reg.indices.some(i => this.game.state[i] === 'star')
      );

      const regionCombos = this.getCombinations(unsolvedRegs, N);

      for (const combo of regionCombos) {
        const combinedIdxs = new Set(combo.flatMap(r => r.indices));

        combo_sets.push({
          label: `Board ${bIdx + 1} Combo (${combo.map(r => r.label.split(' ').pop()).join(',')})`,
          indices: combinedIdxs,
          boardIdx: bIdx,
          regions: combo // Keep reference for highlighting
        });
      }
    }

    // 2. Compare every set against every other set
    for (let i = 0; i < combo_sets.length; i++) {
      for (let j = 0; j < combo_sets.length; j++) {
        if (i === j) continue;

        const setA = combo_sets[i];
        const setB = combo_sets[j];

        // Check if setA is a subset of setB
        const isSubset = Array.from(setA.indices).every(idx => setB.indices.has(idx));

        if (isSubset) {
          // Find extra cells in B that are not in A
          const targets = Array.from(setB.indices).filter(idx => 
            !setA.indices.has(idx) && this.game.state[idx] === 'none'
          );

          if (targets.length > 0) {
            // Logic: Stars for these N regions are trapped in the smaller area (setA)
            // Therefore, the "extra" area in setB must be dots.
            return this.formatSubsetHint(
              setA.regions, 
              targets, 
              setA.boardIdx, 
              setA.label, 
              setB.label
            );
          }
        }
      }
    }
    return null;
  }

  formatSubsetHint(sourceRegs, targets, bIdx, labelA, labelB) {
    const targetSet = new Set(targets);

    // Highlights: Empty cells in the inner subset (A) get the blue background
    const sourceHighlights = sourceRegs.flatMap(r => 
      r.indices.filter(i => this.game.state[i] === 'none' && !targetSet.has(i))
    ).map(idx => ({ idx, color: 'hint-source-blue' }));

    return {
      success: true,
      boardIdx: undefined,
      description: `Subset Logic: Since ${labelB} entirely contains ${labelA}, and both need the same number of stars, the extra squares in the larger area must be dots.`,
      highlights: sourceHighlights,
      marks: targets.map(idx => ({ idx, color: 'hint-target-yellow' }))
    };
  }

  hintCrossBoardRegionPinned(N, axis = "Row") {
    const n = this.n;
    const units = this.getAllUnits();

    // 1. Pool all unsolved regions from both boards
    let unsolvedRegions = [];
    for (let bIdx = 0; bIdx < 2; bIdx++) {
      const boardRegions = units.filter(u => u.label.includes("Region") && u.boardIdx === bIdx);
      for (const reg of boardRegions) {
        const available = reg.indices.filter(i => this.game.state[i] === 'none');
        const hasStar = reg.indices.some(i => this.game.state[i] === 'star');

        if (available.length > 0 && !hasStar) {
          unsolvedRegions.push({
            label: `B${bIdx + 1}-${reg.label.split(' ').pop()}`,
            allIdxs: new Set(reg.indices),
            availableIdxs: available,
            original: reg
          });
        }
      }
    }

    if (unsolvedRegions.length < N) return null;

    // 2. Check combinations of N regions
    const combos = this.getCombinations(unsolvedRegions, N);
    for (const combo of combos) {

      // Ensure regions are mutually disjoint (important for cross-board sets)
      if (!this._areDisjoint(combo.map(r => r.allIdxs))) continue;

      // Determine which units (rows/cols) these combined regions occupy
      const allAvailable = combo.flatMap(r => r.availableIdxs);
      const occupiedUnits = new Set(allAvailable.map(idx => {
        const relativeIdx = idx % (n * n);
        return axis === "Row" ? Math.floor(relativeIdx / n) : relativeIdx % n;
      }));

      // If N regions are trapped in exactly N units
      if (occupiedUnits.size === N) {
        const uList = Array.from(occupiedUnits).sort((a, b) => a - b);

        // Following the Python logic: checking for adjacency
        if (uList[uList.length - 1] - uList[0] === N - 1) {
          const regionUnion = new Set(combo.flatMap(r => Array.from(r.allIdxs)));
          const targets = [];

          // Collect indices for the N units across BOTH boards
          for (const u of uList) {
            for (let b = 0; b < 2; b++) {
              const boardOffset = b * (n * n);
              for (let i = 0; i < n; i++) {
                const relativeIdx = axis === "Row" ? (u * n + i) : (i * n + u);
                const absoluteIdx = relativeIdx + boardOffset;

                // If unit cell is empty and NOT in the N regions
                if (!regionUnion.has(absoluteIdx) && this.game.state[absoluteIdx] === 'none') {
                  targets.push(absoluteIdx);
                }
              }
            }
          }

          if (targets.length > 0) {
            return this.formatCrossBoardHint(combo, targets, axis, uList);
          }
        }
      }
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
      // Since it's cross-board, we can default to Board 1 or the board of the first region
      boardIdx: undefined,
      description: `Cross-Board Logic: These ${combo.length} regions (${labels}) are pinned to ${axis}s ${unitNums}. Squares in these ${axis}s outside these regions must be dots.`,
      highlights: sourceHighlights,
      marks: targets.map(idx => ({ idx, color: 'hint-target-yellow' }))
    };
  }

  hintLookahead(nStages) {
    const n = this.n;
    const boardSize = n * n;

    // Find all empty cells to test
    const emptyIndices = this.game.state
      .map((val, idx) => (val === 'none' ? idx : null))
      .filter(idx => idx !== null);

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
          boardIdx: testIdx < boardSize ? 0 : 1,
          description: `${nStages}-stage Lookahead: Placing a star here makes the board impossible. This square must be a dot.`,
          highlights: [{ idx: testIdx, color: 'hint-source-blue' }],
          marks: [{ idx: testIdx, color: 'hint-target-yellow' }]
        };
      }
    }
    return null;
  }

  /** * Checks for rule violations: empty rows/cols/regions or touching stars 
   *
   */
  _isBoardBroken(state) {
    const n = this.n;
    const boardSize = n * n;
    const units = this.getAllUnits();

    // Check Rows, Columns, and Regions
    const allUnitIndices = units.map(u => u.indices);

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

  /**
   * Simulates basic "Sees Star" and "Only Empty" logic 
   *
   */
  _applySimulatedRules(state) {
    const n = this.n;
    const boardSize = n * n;
    const units = this.getAllUnits();

    // 1. If a cell sees a star, it must be a dot (Sees Star)
    for (let i = 0; i < state.length; i++) {
      if (state[i] === 'star') {
        const row = Math.floor((i % boardSize) / n);
        const col = i % n;
        const bIdx = i < boardSize ? 0 : 1;
        const offset = bIdx * boardSize;

        // Row/Col and Adjacency
        for (let j = 0; j < n; j++) {
          const rIdx = (row * n + j) + offset;
          const cIdx = (j * n + col) + offset;
          if (state[rIdx] === 'none' && rIdx !== i) state[rIdx] = 'dot';
          if (state[cIdx] === 'none' && cIdx !== i) state[cIdx] = 'dot';
        }
        this.getNeighbors(i).forEach(nb => {
          if (state[nb] === 'none') state[nb] = 'dot';
        });
      }
    }

    // 2. If a unit has only one empty spot left, it must be a star (Only Empty) 
    //
    for (const u of units) {
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

