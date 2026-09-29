import { CELL, HINT_COLOR, HINT_SOURCE_VARIANTS } from './constants.js';
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

  // Shared by hintDomino and hintTileDomino: given two orthogonally-
  // adjacent empty cells known to be a "domino" (a unit/tile with no star
  // yet and exactly these 2 candidates, so exactly one of them holds the
  // unit's single star), returns every other empty cell that can't be a
  // star as a result -- the rest of the row/column the domino lies along
  // (whichever of the two cells gets the star, that line's quota is met
  // either way), plus any cell adjacent to BOTH domino cells (adjacent to
  // the star regardless of which one it turns out to be). Returns null if
  // the pair isn't actually orthogonally adjacent, or if nothing new gets
  // eliminated.
  p._dominoEliminationTargets = function (idxA, idxB) {
    const n = this.n;
    const rA = Math.floor(idxA / n), cA = idxA % n;
    const rB = Math.floor(idxB / n), cB = idxB % n;

    if (Math.abs(rA - rB) + Math.abs(cA - cB) !== 1) return null;

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

    const targets = Array.from(blockedIndices).filter(idx => this.vState(idx) === CELL.NONE);
    return targets.length > 0 ? targets : null;
  };

  // Rule: Check for domino patterns in starless units -- any row, column,
  // or region whose only 2 empty cells are orthogonally adjacent. Rows and
  // columns are included to match Python's rule_domino
  // (rules_single_star.py), which has always checked every unit kind.
  p.hintDomino = function () {
    const candidates = [];

    for (const unit of this.units) {
      if (unit.indices.some(i => this.vState(i) === CELL.STAR)) continue;
      const empty = unit.indices.filter(i => this.vState(i) === CELL.NONE);
      if (empty.length !== 2) continue;

      const [idxA, idxB] = empty;
      const targets = this._dominoEliminationTargets(idxA, idxB);
      if (!targets) continue;

      candidates.push({ unit, idxA, idxB, targets });
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.idxA - b.idxA || a.idxB - b.idxB);
    return candidates.map(({ unit, idxA, idxB, targets }) => ({
      description: `The star for this ${this._unitKind(unit)} must be in the highlighted domino.`,
      // Outline the whole unit and fill just the domino inside it, so the
      // player sees both where the domino came from and the domino itself.
      // A row/column (boardIdx undefined) shows on every board.
      highlights: [idxA, idxB].map(idx => ({ idx, color: HINT_COLOR.SOURCE })),
      marks: targets.map(idx => ({ idx, color: HINT_COLOR.TARGET })),
      boardIdx: unit.boardIdx,
      regionOutlines: this._outlineEntriesFor(unit, 'blue'),
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

    const N = unitCombo.length;
    const axisWord = axis.toLowerCase();
    const regWord = coveringUnsolved.length === 1 ? 'region' : 'regions';
    const description = N === 1
      ? `The highlighted ${axisWord} provides the star for the blue-outlined ${regWord}.`
      : `The ${N} highlighted ${axisWord}s provide all the stars for the blue-outlined ${regWord}.`;

    return {
      boardIdx: bIdx,
      description,
      // The window's own empty cells -- each one already known (by
      // construction, see coveringRegLabels above) to belong to one of the
      // outlined regions below. Filled in addition to the outline since the
      // outlined regions can extend well beyond the window; this pins down
      // exactly which part of them is the row/column-relevant part.
      highlights: availInUnits.map(idx => ({ idx, color: HINT_COLOR.SOURCE })),
      marks: targets.map(idx => ({ idx, color: HINT_COLOR.TARGET })),
      // Outline the covering regions' own full shape instead of filling
      // them -- all on this same bIdx by construction (unsolvedRegs is
      // built per-board by the caller). See _buildRegionOutlineSvg.
      regionOutlines: [{ indices: coveringUnsolved.flatMap(r => r.indices), color: 'blue', boardIdx: bIdx }],
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

    const N = windowIndices.length;
    const axisWord = axis.toLowerCase();
    const regWord = pinnedRegs.length === 1 ? 'region' : 'regions';
    const description = N === 1
      ? `The star for this ${axisWord} must come from the blue-outlined ${regWord}.`
      : `All stars for these ${N} ${axisWord}s must come from the blue-outlined ${regWord}.`;

    return {
      boardIdx: bIdx,
      description,
      // The pinned regions' own empty cells -- all inside the window by
      // construction. Same treatment as _hintUnitsCoveredByRegions's fill
      // of the window's empty cells: whichever side is the subset gets
      // its empty cells filled, on top of the regions' outline.
      highlights: pinnedRegs
        .flatMap(r => r.indices.filter(i => this.vState(i) === CELL.NONE))
        .map(idx => ({ idx, color: HINT_COLOR.SOURCE })),
      marks: targets.map(idx => ({ idx, color: HINT_COLOR.TARGET })),
      // Prototype: outline the pinned regions instead of filling their
      // cells -- all on this same bIdx by construction. See
      // _buildRegionOutlineSvg.
      regionOutlines: [{ indices: pinnedRegs.flatMap(r => r.indices), color: 'blue', boardIdx: bIdx }],
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

  // Helper: indices of every empty cell OUTSIDE `excludeIndices` that sees
  // every one of `candidateIndices`. Shared by the row/col/region
  // "sees too much" rule below and hintTileSeesTooMuch, which needs the
  // same search but builds its own hint (tile outlines) around the result.
  p._externalCellsSeeingAll = function (candidateIndices, excludeIndices) {
    const n = this.n;
    const exclude = new Set(excludeIndices);
    const targets = [];
    for (let i = 0; i < n * n; i++) {
      if (this.vState(i) !== CELL.NONE || exclude.has(i)) continue;
      if (candidateIndices.every(c => cellsSee(i, c, n))) targets.push(i);
    }
    return targets;
  };

  // Helper to find external cells that see all options in a unit. The
  // unit's empty cells are filled on top of its whole-unit outline, since
  // the outline alone doesn't show which few cells are still open.
  p._hintSeesTooMuchForUnits = function (units) {
    const hintCandidates = [];
    for (const unit of units) {
      const candidates = unit.indices.filter(i => this.vState(i) === CELL.NONE);
      if (candidates.length === 0) continue;

      const targetIdxs = this._externalCellsSeeingAll(candidates, unit.indices);
      if (targetIdxs.length === 0) continue;
      hintCandidates.push({ unit, candidates, targets: targetIdxs.map(idx => ({ idx, color: HINT_COLOR.TARGET })) });
    }
    if (hintCandidates.length === 0) return null;
    hintCandidates.sort((a, b) => a.candidates[0] - b.candidates[0]);
    return hintCandidates.map(({ unit, candidates, targets }) => ({
      boardIdx: unit.boardIdx,
      description: `The star for this ${this._unitKind(unit)} must be in one of the highlighted cells.`,
      highlights: candidates.map(idx => ({ idx, color: HINT_COLOR.SOURCE })),
      marks: targets,
      // Outline the unit's own full shape/boundary, same convention as
      // hintOnlyEmpty/hintExcludeSolvedUnit -- not just the still-empty
      // candidate cells.
      regionOutlines: this._outlineEntriesFor(unit, 'blue'),
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

  // _hintAxisLineTrapped / _hintAxisLineSyncAll / hintRowColLineSync (the
  // row<->column-only "swordfish" deduction -- no region information
  // needed) moved to solver-rules-common.js: generalized to any
  // starsPerGroup, it's now shared verbatim by both star-count families
  // (see hintRowColLineSync's own comment there).

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

            candidates.push({ shared, onlyA, onlyB, boardA, boardB, regA, regB });
          }
        }
      }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (a.shared[0] ?? 0) - (b.shared[0] ?? 0));
    return candidates.map(({ regA, regB, shared, onlyA, onlyB, boardA, boardB }) => ({
      boardIdx: undefined,
      description: `The blue region (${this._describeBoards([boardA])}) and the brown region (${this._describeBoards([boardB])}) overlap in the cyan cells. `
        + `A star in either region outside the cyan cells would see every non-cyan cell of the other region, forcing that region's star into the cyan cells as well -- `
        + `two stars in one region. So both regions share one star, in the cyan cells.`,
      // The overlap's non-dot cells, shaded on both boards so the shared
      // area is visible wherever the player looks -- the outlines alone
      // only show it implicitly, as the place the two shapes coincide.
      highlights: shared.map(idx => ({ idx, color: HINT_SOURCE_VARIANTS[2], boards: [boardA, boardB] })),
      marks: [
        ...onlyA.filter(i => this.vState(i) === CELL.NONE).map(i => ({ idx: i, color: HINT_COLOR.TARGET, boards: [boardA] })),
        ...onlyB.filter(i => this.vState(i) === CELL.NONE).map(i => ({ idx: i, color: HINT_COLOR.TARGET, boards: [boardB] })),
      ],
      // Prototype: outline each region's FULL shape on its own board
      // instead of filling just the shared overlap cells -- shows the
      // overlap geometrically (where the two outlines coincide) rather
      // than only via the shared cells' fill. See _buildRegionOutlineSvg.
      regionOutlines: [
        { indices: regA.indices, color: 'blue', boardIdx: boardA },
        { indices: regB.indices, color: 'brown', boardIdx: boardB },
      ],
    }));
  };

  // Sandbox for a speculative star at testIdx: the row/column/adjacency
  // dots it implies (board-agnostic), plus dots for the rest of its region
  // on each board in `boards`.
  p._lookaheadHalfSandbox = function (testIdx, boards) {
    const n = this.n;
    const row = Math.floor(testIdx / n);
    const col = testIdx % n;
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

    // Region elimination, on the given boards only.
    for (const reg of this._getRegionsContaining(testIdx)) {
      if (!boards.includes(reg.boardIdx)) continue;
      reg.indices.forEach(i => {
        if (sandboxState[i] === CELL.NONE) sandboxState[i] = CELL.DOT;
      });
    }
    return sandboxState;
  };

  // Shared implementation for hintLookaheadHalfSingleBoard/hintLookaheadHalf:
  // speculatively place one star, eliminate the row/column/adjacency dots it
  // implies (board-agnostic) plus region dots, and check for a broken unit.
  // singleBoard=true does this once per board, restricting region
  // elimination (and the resulting hint) to that one board's region;
  // singleBoard=false does it once per test cell, eliminating from EVERY
  // board's region at once and checking across all boards together.
  p._hintLookaheadHalfImpl = function (singleBoard) {
    const candidates = [];

    const emptyIndices = this.game.state
      .flatMap((val, idx) => this.vState(idx) === CELL.NONE ? [idx] : []);

    const boardScopes = singleBoard
      ? this.boardIndices
      : [null];

    for (const testIdx of emptyIndices) {
      for (const bIdx of boardScopes) {
        if (singleBoard && !this._getRegionsContaining(testIdx).some(r => r.boardIdx === bIdx)) continue;

        const sandboxState = this._lookaheadHalfSandbox(testIdx, singleBoard ? [bIdx] : this.boardIndices);

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
    return candidates.map(({ testIdx, broken, boardIdx }) => {
      // The all-boards variant also says which boards' regions the player
      // needs to look at, when it's more than one.
      const description = `The blue-outlined cells must contain a star — impossible if the circled cell holds one.`
        + (singleBoard ? '' : this._boardsNeededNote(broken, boards => this._lookaheadHalfSandbox(testIdx, boards)));
      return {
        boardIdx: singleBoard ? boardIdx : (broken.type === 'region' ? broken.boardIdx : undefined),
        description,
        highlights: [],
        marks: [{ idx: testIdx, color: HINT_COLOR.TARGET }],
        // `broken` (from _findAllBrokenUnits) is itself a {indices, boardIdx}
        // unit -- outline its shape instead of filling it. Empty for the rare
        // 'adjacency' break (no unit shape to show), which _outlineEntriesFor
        // handles fine (produces no path).
        regionOutlines: this._outlineEntriesFor(broken, 'blue'),
      };
    });
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
      // Symmetry hints just state the solution's symmetry, whether it comes
      // from each board being self-symmetric or from the boards pairing up
      // with each other -- the "why" isn't needed to use the deduction.
      const desc = `The solution is symmetric across the main diagonal (↘).`;
      const hint = this._hintSymmetryFill(i => (i % n) * n + Math.floor(i / n), desc);
      if (hint) results.push(hint);
    }

    if (this.isAntiDiagonalSymmetric) {
      const desc = `The solution is symmetric across the anti-diagonal (↙).`;
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
    // Built once, shared by tryDiagParity's "mutual visibility" check below
    // (same pattern _hintSymmetry uses) -- an empty map for any regionless
    // board (see isRegionlessBoard/solver-core.js's unit-building, which
    // skips region units entirely there), so map[a] is always undefined
    // and the same-region branch never spuriously fires for one.
    const cellToRegionMaps = this.game.regions.map((_, bIdx) => this.buildCellToRegionMap(bIdx));

    if (this.internalRotation180 || this.crossboardRotation180) {
      // Just states the solution's symmetry, whether internal or cross-board
      // -- same as hintSymmetryFill.
      const description = `The solution has 180° rotational symmetry. A cell that "sees" its own rotation can't be a star.`;
      const hint = this._hintSymmetry(i => (n * n - 1) - i, description);
      if (hint) results.push(hint);
    }

    if (this.isMainDiagonalSymmetric) {
      const description = `The solution is symmetric across the main diagonal (↘). A cell that "sees" its own reflection can't be a star.`;
      const hint = this._hintSymmetry(i => (i % n) * n + Math.floor(i / n), description);
      if (hint) results.push(hint);
    }

    if (this.isAntiDiagonalSymmetric) {
      const description = `The solution is symmetric across the anti-diagonal (↙). A cell that "sees" its own reflection can't be a star.`;
      const hint = this._hintSymmetry(
        i => (n - 1 - i % n) * n + (n - 1 - Math.floor(i / n)),
        description
      );
      if (hint) results.push(hint);
    }


    const tryDiagParity = (diagIndices, dirLabel) => {
      const parity = n % 2 === 0 ? 'even' : 'odd';
      const reason = `The solution is symmetric across the ${dirLabel} diagonal`;

      const diagStars  = diagIndices.filter(i => this.vState(i) === CELL.STAR).length;
      const diagEmpties = diagIndices.filter(i => this.vState(i) === CELL.NONE);

      if (diagEmpties.length === 1) {
        const needStar = (diagStars % 2) !== (n % 2);
        const idx   = diagEmpties[0];
        const color = needStar ? HINT_COLOR.TARGET_STAR : HINT_COLOR.TARGET;
        results.push({
          description: `${reason}, so by parity the diagonal needs an ${parity} number of stars — this cell is a ${needStar ? 'star' : 'dot'}.`,
          highlights: diagIndices.filter(i => this.vState(i) === CELL.STAR)
            .map(i => ({ idx: i, color: HINT_COLOR.SOURCE })),
          marks: [{ idx, color }],
          boardIdx: undefined
        });
      } else if (diagEmpties.length >= 2) {
        if ((diagStars % 2) !== (n % 2)) return;
        // All empties must mutually see each other (adjacency or same region
        // on any board) -- via cellToRegionMaps (built above), NOT a raw
        // this.game.regions[boardIdx][cell] comparison: a regionless board's
        // raw string gives every non-void cell the SAME character by
        // construction (see isRegionlessBoard), which would make this
        // spuriously true for ANY two non-void cells on one, not just cells
        // genuinely sharing a region. Found via a real 6x6/1★ regionless
        // puzzle where this wrongly dotted two diagonal cells the solution
        // actually needed as stars -- Python's rule_diagonal_parity already
        // guards this correctly (rules_single_star.py's `see` helper skips
        // regionless_boards explicitly); this mirrors that fix using JS's
        // own existing "empty map for a regionless board" mechanism instead
        // (same one _hintSymmetry above already relies on).
        const allSeeEachOther = diagEmpties.every((a, ai) => diagEmpties.every((b, bi) => {
          if (ai === bi) return true;
          const ra = Math.floor(a / n), ca = a % n;
          const rb = Math.floor(b / n), cb = b % n;
          return (Math.abs(ra - rb) <= 1 && Math.abs(ca - cb) <= 1)
            || cellToRegionMaps.some(map => map[a] !== undefined && map[a] === map[b]);
        }));
        if (!allSeeEachOther) return;
        results.push({
          description: `${reason}, so by parity the diagonal needs an ${parity} number of stars — the rest of the diagonal is dots.`,
          highlights: diagIndices.filter(i => this.vState(i) === CELL.STAR)
            .map(i => ({ idx: i, color: HINT_COLOR.SOURCE })),
          marks: diagEmpties.map(i => ({ idx: i, color: HINT_COLOR.TARGET })),
          boardIdx: undefined
        });
      }
    };

    if (this.isMainDiagonalSymmetric) {
      tryDiagParity(Array.from({ length: n }, (_, k) => k * n + k), '↘');
    }
    if (this.isAntiDiagonalSymmetric) {
      tryDiagParity(Array.from({ length: n }, (_, k) => k * n + (n - 1 - k)), '↙');
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

  // --- Tiles for 1★ (Hard) ---
  //
  // The multi-star "Tiles" family (solver-rules-multi.js's _confirmedTiles:
  // a row-pair or column-pair whose empty cells can be exactly partitioned
  // into 2x2 boxes, one star guaranteed per box) is already starsPerGroup-
  // agnostic -- _confirmedTilesImpl's quota is this.starsPerGroup, so it
  // already produces the correct k=2 (2*1 - starsInBand) tiling for 1★
  // boards, it just never got any 1★-specific rules built on top of it.
  // These three reuse that same machinery (and, where possible, the exact
  // existing 1★ elimination logic for a "confirmed single star among these
  // cells" unit) applied to a TILE instead of a row/column/region:
  //   - hintTileDomino: a tile whose empty cells ARE a domino -- feeds
  //     _dominoEliminationTargets exactly like hintDomino does.
  //   - hintTileSeesTooMuch: a tile with exactly 3 empty cells -- feeds
  //     _externalCellsSeeingAll exactly like hintUnitSeesTooMuch does.
  //   - hintTileRegionSubset: a tile entirely inside one unsolved region --
  //     that region's own star is satisfied by the tile, so the rest of
  //     the region (outside the tile) must be dots. Structurally inert on
  //     a regionless board (getUnsolvedRegions is always empty there),
  //     same as every other region-based rule.
  //
  // Recognizing the 2-line tiling structure at all is a genuinely harder
  // pattern than spotting an already-grouped region's own domino/sees-too-
  // much/subset relationship, so all three sit at the END of Hard --
  // originally placed at Expert, but moved down (2026-09-10) once real
  // generation showed they fire often enough on their own that, without
  // anything genuinely Expert-only behind them, they were absorbing
  // puzzles that should have stayed Hard.
  //
  // All three outline BOTH tiles of the matched tile's own tiling (the
  // row/col pair's full K-tiles-for-K-stars covering, shown for context --
  // same reasoning as the multi-star Tiles family's
  // _tileOutlinesAndHighlights), but only tint the cells actually driving
  // THIS hint's deduction: the one matched tile, minus any cell about to
  // get a `marks` color (so a cell never ends up with two conflicting
  // highlight classes).

  // Rule: a confirmed tile (this._confirmedTiles()) whose empty cells are
  // themselves a domino. Combines every matching tile within the SAME
  // tiling into one hint (same pattern as hintTileSingleEmpty/
  // hintTileTwoEmptyDot) -- a tiling can confirm more than one domino at
  // once, and a player looking at that tiling's outline should see every
  // conclusion it supports, not just one at a time.
  p.hintTileDomino = function () {
    const seenKeys = new Set(); // "targets|tile cells" already claimed by an earlier tiling
    const hints = [];
    for (const tiling of this._confirmedTiles()) {
      const matchingTiles = [];
      const targetSet = new Set();
      for (const tile of tiling.tiles) {
        if (tile.cells.length !== 2) continue;
        const [idxA, idxB] = tile.cells;
        const targets = this._dominoEliminationTargets(idxA, idxB);
        if (!targets || targets.length === 0) continue;
        const key = this._groupKey(targets) + '|' + this._groupKey(tile.cells);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        matchingTiles.push(tile);
        targets.forEach(t => targetSet.add(t));
      }
      if (matchingTiles.length === 0) continue;

      const targetList = [...targetSet].sort((a, b) => a - b);
      const { tileOutlines, highlights } = this._tileOutlinesAndHighlights(tiling.tiles, matchingTiles, targetList);
      const description = matchingTiles.length === 1
        ? `This tile's empty cells must contain a star.`
        : `${matchingTiles.length} of these tiles' empty cells must each contain a star.`;
      hints.push({
        description,
        highlights,
        marks: targetList.map(idx => ({ idx, color: HINT_COLOR.TARGET })),
        tileOutlines,
        boardIdx: undefined
      });
    }
    if (hints.length === 0) return null;
    hints.sort((a, b) => a.marks[0].idx - b.marks[0].idx);
    return hints;
  };

  // Whether a tile's 2 empty cells are diagonal to each other (distinct row
  // AND column) rather than sharing a row or column -- the latter is the
  // domino case (hintTileDomino), handled separately since a shared row/
  // column lets that rule eliminate along the whole line, not just via
  // adjacency. A diagonal pair has no such shared-line elimination, but
  // still guarantees its 1 star lands at one of the two cells, so it's
  // eligible for the same "external cell sees both" reasoning as a 3-empty
  // tile below -- just with 2 candidates instead of 3.
  p._isDiagonalTilePair = function (cells) {
    if (cells.length !== 2) return false;
    const n = this.n;
    const [a, b] = cells;
    return Math.floor(a / n) !== Math.floor(b / n) && (a % n) !== (b % n);
  };

  // Rule: a confirmed tile whose empty cells are either exactly 3 cells, or
  // 2 diagonally-opposite cells -- either way, some external cell sees
  // (touches, or shares a row/column with) every one of them, so it can't
  // be a star no matter which of the tile's cells turns out to hold it.
  // (The 2-adjacent-empties case is hintTileDomino, and the 1-empty case
  // is hintTileSingleEmpty's 1★ counterpart -- see the section comment
  // above hintTileDomino.)
  p.hintTileSeesTooMuch = function () {
    const seenKeys = new Set(); // "targets|tile cells" already claimed by an earlier tiling
    const hints = [];
    for (const tiling of this._confirmedTiles()) {
      const matchingTiles = [];
      const targetSet = new Set();
      for (const tile of tiling.tiles) {
        if (tile.cells.length !== 3 && !this._isDiagonalTilePair(tile.cells)) continue;
        const targetIdxs = this._externalCellsSeeingAll(tile.cells, tile.cells);
        if (targetIdxs.length === 0) continue;
        const key = this._groupKey(targetIdxs) + '|' + this._groupKey(tile.cells);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        matchingTiles.push(tile);
        targetIdxs.forEach(t => targetSet.add(t));
      }
      if (matchingTiles.length === 0) continue;

      const targetList = [...targetSet].sort((a, b) => a - b);
      const { tileOutlines, highlights } = this._tileOutlinesAndHighlights(tiling.tiles, matchingTiles, targetList);
      const description = matchingTiles.length === 1
        ? `This tile's empty cells must contain a star.`
        : `${matchingTiles.length} of these tiles' empty cells must each contain a star.`;
      hints.push({
        description,
        highlights,
        marks: targetList.map(idx => ({ idx, color: HINT_COLOR.TARGET })),
        tileOutlines,
        boardIdx: undefined
      });
    }
    if (hints.length === 0) return null;
    hints.sort((a, b) => a.marks[0].idx - b.marks[0].idx);
    return hints;
  };

  // Rule: a confirmed tile entirely inside one unsolved region -- the
  // tile's guaranteed star satisfies that region too, so the rest of the
  // region (outside the tile) must be dots.
  p.hintTileRegionSubset = function () {
    const hints = [];
    for (const bIdx of this.boardIndices) {
      const cellToRegionMap = this.buildCellToRegionMap(bIdx);
      const unsolvedRegs = this.getUnsolvedRegions(bIdx);
      if (unsolvedRegs.length === 0) continue;

      for (const tiling of this._confirmedTiles()) {
        const matchingTiles = [];
        const targetSet = new Set();
        for (const tile of tiling.tiles) {
          if (tile.cells.length === 0) continue;
          const labels = new Set(tile.cells.map(i => cellToRegionMap[i]).filter(Boolean));
          if (labels.size !== 1) continue;
          const [label] = labels;
          const region = unsolvedRegs.find(r => r.label === label);
          if (!region) continue;

          const tileSet = new Set(tile.cells);
          const targets = region.indices.filter(i => !tileSet.has(i) && this.vState(i) === CELL.NONE);
          if (targets.length === 0) continue;

          matchingTiles.push(tile);
          targets.forEach(t => targetSet.add(t));
        }
        if (matchingTiles.length === 0) continue;

        const targetList = [...targetSet].sort((a, b) => a - b);
        const { tileOutlines, highlights } = this._tileOutlinesAndHighlights(tiling.tiles, matchingTiles, targetList);
        const description = matchingTiles.length === 1
          ? `This tile sits entirely inside a region, so the rest of that region must be dots.`
          : `${matchingTiles.length} of these tiles each sit entirely inside a region, so the rest of each region must be dots.`;
        hints.push({
          description,
          highlights,
          marks: targetList.map(idx => ({ idx, color: HINT_COLOR.TARGET })),
          tileOutlines,
          boardIdx: bIdx
        });
      }
    }
    if (hints.length === 0) return null;
    hints.sort((a, b) => a.marks[0].idx - b.marks[0].idx);
    return hints;
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
      // Moved here from Expert: with nothing genuinely Expert-only behind
      // them, these three were absorbing puzzles that should have stayed
      // Hard (see the "Tiles for 1★" section comment above hintTileDomino).
      { key: 'tileDomino',               fn: () => this.hintTileDomino() },
      { key: 'tileSeesTooMuch',          fn: () => this.hintTileSeesTooMuch() },
      { key: 'tileRegionSubset',         fn: () => this.hintTileRegionSubset() },
      // Symmetry - requires insight but not hard to apply. Was mis-slotted
      // mid-Hard (before the tile rules above); moved to the end of Hard,
      // matching composite_scorer.py's rules_1star ordering and
      // solver-rules-multi.js's symmetryDeductionMulti placement -- this
      // rule's "sees its own mirror" check is a static geometric fact,
      // true from move zero for a symmetric board, so its LIST POSITION
      // (not just its tier label) determines whether an easier Hard-tier
      // tile deduction gets tried first. Puzzle 757 in
      // 8x8_regionless_symmetric surfaced this: composite_scorer.py's
      // canonical solve never needs rule_diagonal_symmetry (uses
      // TileSeesTooMuch instead), so the puzzle is tier="Hard" -- but the
      // old ordering here made getHint() reach symmetryDeduction before
      // ever trying the tile rules.
      { key: 'symmetryDeduction',        fn: () => this.hintSymmetryDeduction() },
      // Expert
      // Tiles rule 4 (shared with 2★+ -- see the section comment above
      // hintTilePairQuotaFill in solver-rules-multi.js).
      { key: 'tilePairQuotaFill',        fn: () => this.hintTilePairQuotaFill() },
      { key: 'disjointUnitRegionSync3',  fn: () => this.hintDisjointUnitRegionSync(3) },
      // Cross-board pin, 2-region case -- opens Expert, ahead of the
      // 3-region case (after rowColLineSync3 below). The two swapped
      // positions: 60ef66b had promoted the 3-region case here, leaving
      // the strictly simpler 2-region case behind it, so the GUI's first
      // hint could show "3 regions in 3 rows" while a "2 regions in 2
      // cols" deduction was also available.
      { key: 'crossBoardPinned2Row',     fn: () => this.hintCrossBoardRegionPinned(2, "Row") },
      { key: 'crossBoardPinned2Col',     fn: () => this.hintCrossBoardRegionPinned(2, "Column") },
      { key: 'rowColLineSync3',          fn: () => this.hintRowColLineSync(3) },
      // Cross-board pin, 3-region case -- see the 2-region case above.
      { key: 'crossBoardPinned3Row',     fn: () => this.hintCrossBoardRegionPinned(3, "Row") },
      { key: 'crossBoardPinned3Col',     fn: () => this.hintCrossBoardRegionPinned(3, "Column") },
      { key: 'partialOverlap',           fn: () => this.hintPartialOverlap() },
      { key: 'lookaheadHalfSingleBoard', fn: () => this.hintLookaheadHalfSingleBoard() },
      { key: 'lookaheadHalf',            fn: () => this.hintLookaheadHalf() },
      { key: 'regionSubsetSync2',        fn: () => this.hintRegionSubsetSync(2) },
      // Region algebra, then the region-pair hybrid enumeration -- see the
      // section comments above hintRegionAlgebra/hintRegionPairPlacementForced
      // in solver-rules-common.js.
      { key: 'regionAlgebra',             fn: () => this.hintRegionAlgebra() },
      { key: 'regionPairPlacementForced', fn: () => this.hintRegionPairPlacementForced() },
      // Grandmaster
      // Tiles rule 4b -- see the section comment above hintTilePairQuotaFill
      // in solver-rules-multi.js. The 3-or-more-tile generalization of
      // hintTilePairQuotaFill (Expert, above).
      { key: 'tilePairQuotaFillGrandmaster', fn: () => this.hintTilePairQuotaFillGrandmaster() },
      { key: 'lookahead1',              fn: () => this.hintLookahead(1) },
      { key: 'lookahead2',              fn: () => this.hintLookahead(2) },
      { key: 'lookahead3',              fn: () => this.hintLookahead(3) },
      { key: 'lookahead8',              fn: () => this.hintLookahead(8) },
      { key: 'fromSolution',            fn: () => this.hintFromSolution() },
    ];
  };
}
