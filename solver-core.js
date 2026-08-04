import { CELL, HINT_COLOR } from './constants.js';
import { getNeighbors8, cellsAdjacent, rowIndices, colIndices } from './geometry.js';

// Core solving engine: precomputation, generic unit/board helpers, the
// getHint() dispatcher, simulation/lookahead machinery, and symmetry
// detection -- everything that's already agnostic to starsPerGroup.
//
// Rule implementations themselves live in the sibling solver-rules-*.js
// files, mixed onto this class's prototype (see solver.js, which assembles
// them -- the same applyX(Class) convention rules.js uses for
// StarBattleGame). getHint() picks between _getSingleStarRuleList() and
// _getMultiStarRuleList(), each supplied by one of those mixins.
export class PuzzleSolver {
  // --- Setup & Utilities ---
  constructor(game) {
    this.game = game;
    this.n = game.n;
    this.starsPerGroup = game.starsPerGroup || 1;

    // [0, 1, ..., numBoards - 1] -- shared by every rule that needs to
    // iterate all boards, instead of each writing its own `for (let bIdx
    // = 0; bIdx < this.game.regions.length; bIdx++)` or
    // `Array.from({length: this.game.regions.length}, (_, i) => i)`.
    // Never mutated after construction, so safe to share by reference.
    this.boardIndices = this.game.regions
      ? Array.from({ length: this.game.regions.length }, (_, i) => i)
      : [];

    // Void cells are tracked here rather than in game.state, so hint logic
    // can treat them as always-dot without mutating the real board state.
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

    // Map each cell to every unit (row/column/region, across all boards) that contains
    // it, so we can quickly tell whether a candidate placement would overload a unit
    // other than the one currently being solved.
    this._unitsByCell = Array.from({ length: this.n * this.n }, () => []);
    this.units.forEach(u => {
      u.indices.forEach(idx => this._unitsByCell[idx].push(u));
    });

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
    // Index into the current rule list of the rule that matched last time
    // for the current board state -- lets getHint() resume scanning there
    // instead of re-running every earlier (already-known-empty) rule on
    // every click. See getHint() for why this is safe.
    this.lastMatchedRuleIndex = 0;
  }

  // Reads a cell's state, reporting void cells as DOT regardless of what's
  // actually stored there (see voidIndices above).
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
      units.push({ indices: rowIndices(n, r), label: `Row ${r + 1}` });
    }

    // Columns (Shared)
    for (let c = 0; c < n; c++) {
      units.push({ indices: colIndices(n, c), label: `Column ${String.fromCharCode(65 + c)}` });
    }

    if (!this.game.regions) {
      console.error("Regions data is missing from the game instance!");
      return units;
    }

    // Regions (board-specific indices)
    this.game.regions.forEach((regionString, boardIdx) => {
      // '*' marks void cells, which belong to no region.
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
      this._unitKind(u) === "region" &&
      u.boardIdx === boardIdx &&
      !u.indices.some(i => this.vState(i) === CELL.STAR)
    );
  }

  // Get regions on the specified board that still need at least one more star,
  // paired with how many they still need. Unlike getUnsolvedRegions (which assumes
  // 1 star per region and so treats any placed star as "solved"), this correctly
  // handles regions that already have some, but not all, of their stars placed.
  getRegionsNeedingStars(boardIdx) {
    return this.units
      .filter(u => this._unitKind(u) === "region" && u.boardIdx === boardIdx)
      .map(region => ({
        region,
        remaining: this.starsPerGroup - region.indices.filter(i => this.vState(i) === CELL.STAR).length
      }))
      .filter(({ remaining }) => remaining > 0);
  }

  // Get cell indices grouped by axis (Row or Column).
  getAxisIndices(axis) {
    const n = this.n;
    const build = axis === "Row" ? rowIndices : colIndices;
    return Array.from({ length: n }, (_, i) => build(n, i));
  }

  // Map cell indices to region labels.
  buildCellToRegionMap(boardIdx) {
    const map = {};
    this.units
      .filter(u => this._unitKind(u) === "region" && u.boardIdx === boardIdx)
      .forEach(reg => reg.indices.forEach(idx => { map[idx] = reg.label; }));
    return map;
  }

  // Get adjacent neighbor cell indices (8-way).
  getNeighbors(idx) {
    return getNeighbors8(idx, this.n);
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

  // Find all regions containing the cell. Uses the precomputed
  // _unitsByCell index (cell -> every unit containing it) rather than
  // scanning every unit's full indices list.
  _getRegionsContaining(idx) {
    return this._unitsByCell[idx].filter(u => this._unitKind(u) === "region");
  }

  // Whether two cell indices are adjacent, including diagonally.
  _cellsAdjacent(a, b) {
    return cellsAdjacent(a, b, this.n);
  }

  // Row/Column/Region, based on a unit's label. Lives here (not in one of
  // the rule mixins) since it's used by core methods (_findAllBrokenUnits,
  // _getRegionsContaining, etc.) as well as both rule families.
  _unitKind(unit) {
    if (unit.label.startsWith("Row")) return "row";
    if (unit.label.startsWith("Col")) return "column";
    return "region";
  }

  // Enumerate every valid way to place a unit's remaining stars: combinations of the
  // unit's empty cells, of the size still needed, that don't touch each other or any
  // star already placed in the unit (even diagonally). Returns null if the unit is
  // already fully satisfied (no stars needed), or [] if it has no valid completions.
  //
  // When `strong` is true (the default), completions that would overload some OTHER
  // row/column/region past its star quota are also filtered out. When false, only the
  // adjacency rule above is applied — a cheaper but weaker over-approximation that
  // ignores the rest of the board.
  //
  // `quota` defaults to starsPerGroup (the normal case: how many stars a real unit
  // needs), but can be overridden for synthetic combined units -- e.g. a pair of
  // adjacent rows needs 2 * starsPerGroup in total. The capacity check below still
  // enforces starsPerGroup on any OTHER real unit a combo touches (including the two
  // individual rows/cols/regions making up a pair), since that's never overridden.
  //
  // `state` optionally overrides what counts as STAR/NONE/DOT for each cell -- pass a
  // sandboxed lookahead state array to evaluate completions against a speculative board
  // instead of the live game state. Defaults to null, meaning "read the real board via
  // this.vState" (unchanged behavior for every existing call site).
  //
  // `visibleBoardIdx` optionally restricts the strong-mode capacity check to only
  // consider OTHER units belonging to that one board (region units on a different
  // board are ignored -- rows/columns are board-agnostic and always considered).
  // Defaults to null (no restriction, the normal case). This exists so a "single
  // board" lookahead check can reason about a shared row/column's capacity without
  // silently pulling in the OTHER board's region layout, which that check is
  // specifically meant not to depend on.
  _enumerateUnitCompletions(unit, strong = true, quota = this.starsPerGroup, state = null, visibleBoardIdx = null) {
    const readState = state ? (i => state[i]) : (i => this.vState(i));
    const stars = unit.indices.filter(i => readState(i) === CELL.STAR);
    const needed = quota - stars.length;
    if (needed <= 0) return null;

    const avail = unit.indices.filter(i => readState(i) === CELL.NONE);
    if (avail.length < needed) return [];

    return this.getCombinations(avail, needed).filter(combo => {
      // Non-adjacency: combo cells can't touch each other or an existing star.
      for (let i = 0; i < combo.length; i++) {
        if (stars.some(s => this._cellsAdjacent(s, combo[i]))) return false;
        for (let j = i + 1; j < combo.length; j++) {
          if (this._cellsAdjacent(combo[i], combo[j])) return false;
        }
      }
      if (!strong) return true;

      // Capacity: this combo must not push any OTHER row/column/region over its star
      // quota. (The unit being solved is exact by construction, so it's skipped here.)
      const otherUnitCounts = new Map();
      for (const cell of combo) {
        for (const otherUnit of this._unitsByCell[cell]) {
          if (otherUnit.label === unit.label) continue;
          if (visibleBoardIdx !== null && otherUnit.boardIdx !== undefined && otherUnit.boardIdx !== visibleBoardIdx) continue;
          otherUnitCounts.set(otherUnit, (otherUnitCounts.get(otherUnit) || 0) + 1);
        }
      }
      for (const [otherUnit, addCount] of otherUnitCounts) {
        const existing = otherUnit.indices.filter(i => readState(i) === CELL.STAR).length;
        if (existing + addCount > this.starsPerGroup) return false;
      }

      return true;
    });
  }

  // Returns an array of "completion sets" for `unit` at the given
  // difficulty level -- each entry is _enumerateUnitCompletions' own return
  // value (null: unit already at quota; []: that scope alone already finds
  // the unit unsolvable; otherwise the valid combos), used by rules that
  // come in weak/intermediate/strong variants (hintUnitPlacementForced,
  // hintExternalDotFromPlacements):
  //
  //  - 'weak': adjacency only, ignoring every other unit's capacity.
  //  - 'strong': full capacity check across every board's units at once --
  //    a deduction found here may require combining both boards' region
  //    layouts.
  //  - 'intermediate': the capacity check restricted to ONE board's units
  //    at a time. A region only has one board to check (its own). A
  //    row/column has none, so it's checked once per board in turn, since
  //    its own capacity conflicts could come from either board's regions.
  //    A caller unions results across entries: if a deduction holds under
  //    ANY single board's view alone, that's the easier "intermediate"
  //    reasoning -- no need to combine both boards' information.
  //
  // Weak and strong always return a single-entry array (uniform shape with
  // intermediate), so callers can treat all three levels identically.
  _unitCompletionsByLevel(unit, level, quota = this.starsPerGroup) {
    if (level === 'weak') return [this._enumerateUnitCompletions(unit, false, quota)];
    if (level === 'strong') return [this._enumerateUnitCompletions(unit, true, quota)];
    const scopes = unit.boardIdx !== undefined ? [unit.boardIdx] : this.boardIndices;
    return scopes.map(bIdx => this._enumerateUnitCompletions(unit, true, quota, null, bIdx));
  }

  // --- Hint Dispatch ---

  getHint() {
    const rules = this.starsPerGroup === 1
      ? this._getSingleStarRuleList()
      : this._getMultiStarRuleList();

    // Detect board-state changes; reset cycling when the board changes.
    const stateString = this.game.state.join(',');
    if (stateString !== this.lastStateString) {
      this.lastStateString  = stateString;
      this.currentHintType  = null;
      this.currentHintIndex = 0;
      this.lastMatchedRuleIndex = 0;
    }

    // Resume scanning from the rule that matched last time for this exact
    // board state, instead of re-running every earlier rule from scratch
    // on every click. Safe because nothing mutates this.game.state during
    // hint evaluation (lookahead rules only ever mutate sandboxed copies),
    // so every rule before lastMatchedRuleIndex is guaranteed to still
    // return no hints against this same, unchanged state.
    const startAt = this.lastMatchedRuleIndex;

    for (let i = startAt; i < rules.length; i++) {
      const { key, fn } = rules[i];
      const hints = fn();
      if (!hints || hints.length === 0) continue;

      if (key !== this.currentHintType) {
        this.currentHintType  = key;
        this.currentHintIndex = 0;
        this.currentHints     = this._buildHintBatch(hints, rules, i);
      }
      this.lastMatchedRuleIndex = i;

      const hint = this.currentHints[this.currentHintIndex % this.currentHints.length];
      this.currentHintIndex++;
      return hint;
    }
    this.lastMatchedRuleIndex = 0;
    return null;
  }

  // When the matched rule only has one hint to show, every click would
  // otherwise just re-show that exact same hint forever. Pad the list with
  // up to 4 hints (randomly sampled if there are more) from the
  // next-easiest rule that also finds something -- skipping fromSolution,
  // the last-resort fallback, since padding with "just look at the answer"
  // isn't a real hint. The original hint always comes first (easier tier
  // before harder), with the padding appended after.
  _buildHintBatch(hints, rules, matchedIndex) {
    const batch = this._shuffle(hints.slice());
    if (batch.length > 1) return batch;

    for (let j = matchedIndex + 1; j < rules.length; j++) {
      const { key, fn } = rules[j];
      if (key === 'fromSolution') continue;
      const nextHints = fn();
      if (!nextHints || nextHints.length === 0) continue;
      const padding = this._shuffle(nextHints.slice()).slice(0, 4);
      return [...batch, ...padding];
    }
    return batch;
  }

  // --- Hint Formatters ---

  // Turns a list/set of 0-indexed board indices into a display phrase, e.g.
  // "Board 1", "Board 1 and Board 2", or "Board 1, Board 2 and Board 3".
  // Used so cross-board hint text names its boards explicitly instead of
  // leaving the player to guess which ones are involved.
  _describeBoards(boardIdxs) {
    const names = [...new Set(boardIdxs)].sort((a, b) => a - b).map(b => `Board ${b + 1}`);
    if (names.length <= 1) return names[0] ?? '';
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }

  formatSubsetHint(sourceRegs, targetRegs, targets, sourceBoardIdx, targetBoardIdx) {
    const targetSet = new Set(targets);
    // Both the source group and target group are physical grid cells that
    // exist on every board -- the deduction just happens to be justified by
    // region definitions on sourceBoardIdx and targetBoardIdx specifically.
    // So each cell is colored on every board actually involved (both
    // boards, or just one if they're the same), not source-only-on-its-
    // board and target-only-on-its-board -- that would leave, say, a
    // 3-board puzzle's board 2 correctly blank but board 1 and board 3
    // each only showing half the picture.
    const involvedBoards = [...new Set([sourceBoardIdx, targetBoardIdx])];

    const sourceHighlights = sourceRegs.flatMap(r =>
      r.indices.filter(i => this.vState(i) === CELL.NONE && !targetSet.has(i))
    ).map(idx => ({ idx, color: HINT_COLOR.SOURCE, boards: involvedBoards }));

    const crossBoard = sourceBoardIdx !== targetBoardIdx;
    const sourcePhrase = sourceRegs.length === 1 ? "One region" : `A group of ${sourceRegs.length} regions`;
    const targetPhrase = targetRegs.length === 1 ? "another region" : `a group of ${targetRegs.length} other regions`;
    const boardNote = crossBoard ? ` (${this._describeBoards([sourceBoardIdx])} vs. ${this._describeBoards([targetBoardIdx])})` : '';
    const description = `${sourcePhrase} needs exactly as many stars as ${targetPhrase}${boardNote}, and all of its candidate cells `
      + `fall inside theirs too -- so the rest of ${targetRegs.length === 1 ? "that region" : "those regions"} must be dots.`;

    return {
      boardIdx: crossBoard ? undefined : sourceBoardIdx,
      description,
      highlights: sourceHighlights,
      marks: targets.map(idx => ({ idx, color: HINT_COLOR.TARGET, boards: involvedBoards }))
    };
  }

  formatCrossBoardHint(combo, targets, axis, uList) {
    const targetSet = new Set(targets);

    const sourceHighlights = combo.flatMap(r =>
      r.availableIdxs.filter(idx => !targetSet.has(idx)).map(idx => ({ idx, color: HINT_COLOR.SOURCE, boards: [r.original.boardIdx] }))
    );

    const boardsInvolved = this._describeBoards(combo.map(r => r.original.boardIdx));
    return {
      boardIdx: undefined,
      description: `Cross-board (${boardsInvolved}): These ${combo.length} regions must place their stars in the same ${combo.length} ${axis.toLowerCase()}s.`,
      highlights: sourceHighlights,
      // Target cells are a row/column consequence -- board-agnostic by
      // construction (rows/columns are shared across every board), so no
      // `boards` override here; they broadcast to every board as before.
      marks: targets.map(idx => ({ idx, color: HINT_COLOR.TARGET }))
    };
  }

  // --- Simulation ---

  // Clones the live board state into a speculative sandbox with a star
  // placed at `testIdx`, and void cells forced to DOT (mirroring vState).
  // Used by every lookahead-style rule that asks "what if a star went here?"
  _buildSpeculativeState(testIdx) {
    const state = [...this.game.state];
    this.voidIndices.forEach(idx => { state[idx] = CELL.DOT; });
    state[testIdx] = CELL.STAR;
    return state;
  }

  // Fisher-Yates shuffle (in place). Array.prototype.sort with a random
  // comparator is a well-known non-uniform "shuffle" -- this is the correct
  // version, used to randomize which equally-valid hint the player sees
  // first for a given rule.
  _shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // Note: generalized to respect this.starsPerGroup (quota) rather than assuming
  // quota === 1, so this same function backs both the 1★ and 2★+ lookahead rules.
  // For starsPerGroup === 1 this reproduces the previous behavior exactly, since a
  // unit reaches its quota the instant it gets its first star.
  _applySimulatedRules(state) {
    const quota = this.starsPerGroup;

    // Adjacency dots always apply, regardless of quota -- stars can never touch.
    for (let i = 0; i < state.length; i++) {
      if (state[i] !== CELL.STAR) continue;
      for (const nb of this.getNeighbors(i)) {
        if (state[nb] === CELL.NONE) state[nb] = CELL.DOT;
      }
    }

    // Any unit (row/column/region) that has reached its star quota gets the rest
    // of its empty cells dotted out.
    for (const u of this.units) {
      const starCount = u.indices.filter(i => state[i] === CELL.STAR).length;
      if (starCount === quota) {
        u.indices.forEach(idx => {
          if (state[idx] === CELL.NONE) state[idx] = CELL.DOT;
        });
      }
    }

    // Forced star fill: if a unit's remaining empty cells exactly match how many
    // more stars it still needs, all of them must be stars.
    for (const u of this.units) {
      const noneIndices = u.indices.filter(i => state[i] === CELL.NONE);
      const starIndices = u.indices.filter(i => state[i] === CELL.STAR);
      const needed = quota - starIndices.length;
      if (needed > 0 && noneIndices.length === needed) {
        noneIndices.forEach(idx => { state[idx] = CELL.STAR; });
      }
    }
  }

  // Applies only the dots DIRECTLY implied by placing a single star at `idx`:
  // its neighbors always become dots, and any row/column/region that reaches
  // its star quota as a RESULT of this one placement gets the rest of its empty
  // cells dotted too. Unlike _applySimulatedRules this does one shallow pass
  // local to `idx`, not a full-board propagation.
  //
  // When boardIdx is given, only that board's region (for `idx`) is considered;
  // when null, every board's region containing `idx` is considered. Rows and
  // columns are always board-agnostic.
  _applyStarPlacementDots(state, idx, boardIdx = null) {
    const n = this.n;
    const quota = this.starsPerGroup;

    for (const nb of this.getNeighbors(idx)) {
      if (state[nb] === CELL.NONE) state[nb] = CELL.DOT;
    }

    const row = Math.floor(idx / n);
    const col = idx % n;
    [this.axisIndices.Row[row], this.axisIndices.Column[col]].forEach(indices => {
      const starCount = indices.filter(i => state[i] === CELL.STAR).length;
      if (starCount === quota) {
        indices.forEach(i => { if (state[i] === CELL.NONE) state[i] = CELL.DOT; });
      }
    });

    const regions = this._getRegionsContaining(idx)
      .filter(r => boardIdx === null || r.boardIdx === boardIdx);
    regions.forEach(reg => {
      const starCount = reg.indices.filter(i => state[i] === CELL.STAR).length;
      if (starCount === quota) {
        reg.indices.forEach(i => { if (state[i] === CELL.NONE) state[i] = CELL.DOT; });
      }
    });
  }

  // Uses the existing _enumerateUnitCompletions machinery to answer, for every unit,
  // "is there at least one way to solve you given the placements of stars currently on
  // the board?" -- i.e. can this row/column/region's remaining stars still be placed
  // somewhere, respecting non-adjacency AND every other unit's remaining capacity.
  // strong=true means a unit with zero valid completions (but still needing stars) is
  // a genuine contradiction, catching not just "no empty cells left" but also subtler
  // cases like a region whose only remaining candidates are jointly boxed in by other
  // rows/columns/regions that don't have room for them.
  //
  // Returns EVERY broken unit found (not just the first), so a candidate placement that
  // simultaneously breaks several rows/columns/regions surfaces all of them as separate,
  // independently valid reasons -- used by the lookahead hint rules so the player can
  // cycle through every one of them via the hint button, rather than only ever seeing
  // whichever happens to be checked first.
  //
  // `visibleBoardIdx`, when given, restricts every check (which units get scanned, and
  // what _enumerateUnitCompletions is allowed to reason about) to rows/columns and only
  // that one board's regions -- for the "single board" lookahead rules, which are meant
  // to only rely on information visible from one board.
  _findAllBrokenUnits(state, visibleBoardIdx = null) {
    const quota = this.starsPerGroup;
    const units = visibleBoardIdx === null
      ? this.units
      : this.units.filter(u => u.boardIdx === undefined || u.boardIdx === visibleBoardIdx);

    const broken = [];

    for (const unit of units) {
      const combos = this._enumerateUnitCompletions(unit, true, quota, state, visibleBoardIdx);
      if (combos !== null && combos.length === 0) {
        broken.push({ type: this._unitKind(unit), label: unit.label, indices: unit.indices, boardIdx: unit.boardIdx });
      }
    }

    // _enumerateUnitCompletions returns null once a unit is already at quota, so it
    // doesn't itself catch a unit that's gone OVER quota -- check that separately.
    for (const unit of units) {
      const starCount = unit.indices.filter(i => state[i] === CELL.STAR).length;
      if (starCount > quota) {
        broken.push({ type: this._unitKind(unit), label: unit.label, indices: unit.indices, boardIdx: unit.boardIdx });
      }
    }

    // One adjacency violation is enough to report; there's no useful per-unit breakdown
    // to enumerate further here (unlike rows/columns/regions, "adjacency" isn't a unit
    // players can be shown a bounded set of cells for in the same way).
    for (let i = 0; i < state.length; i++) {
      if (state[i] === CELL.STAR) {
        if (this.getNeighbors(i).some(nb => state[nb] === CELL.STAR)) {
          broken.push({ type: 'adjacency', label: 'adjacency', indices: [] });
          break;
        }
      }
    }

    return broken;
  }

  // Convenience wrapper: just the first broken unit found (or null), for callers that
  // only need to know whether something's broken, not every reason why.
  _findBrokenUnit(state, visibleBoardIdx = null) {
    return this._findAllBrokenUnits(state, visibleBoardIdx)[0] ?? null;
  }

  _isBoardBroken(state, visibleBoardIdx = null) {
    const quota = this.starsPerGroup;
    const units = visibleBoardIdx === null
      ? this.units
      : this.units.filter(u => u.boardIdx === undefined || u.boardIdx === visibleBoardIdx);

    for (const unit of units) {
      const combos = this._enumerateUnitCompletions(unit, true, quota, state, visibleBoardIdx);
      if (combos !== null && combos.length === 0) return true;
    }
    for (const unit of units) {
      const starCount = unit.indices.filter(i => state[i] === CELL.STAR).length;
      if (starCount > quota) return true;
    }
    for (let i = 0; i < state.length; i++) {
      if (state[i] === CELL.STAR) {
        if (this.getNeighbors(i).some(nb => state[nb] === CELL.STAR)) return true;
      }
    }
    return false;
  }

  // --- Symmetry detection ---

  // Checks whether board B's region layout is exactly what you'd get by applying
  // `transformFn` to board A's region layout -- the pairwise primitive behind every
  // "these two boards are reflections/rotations of each other" symmetry check.
  //
  // Single O(n^2) pass building a labelA -> labelB map, rather than an
  // O(n^4) scan over every cell PAIR: each cell i contributes one mapping,
  // regionsA[i] -> regionsB[transformFn(i)] (void cells included -- '*' is
  // just another label here, no special-casing needed), and a conflict
  // (the same A-label already mapped to a different B-label) is exactly
  // the old pairwise check's failure, for the pair (i, that earlier cell).
  // The reverse failure mode -- two different A-labels both mapping to the
  // same B-label -- can't happen without also tripping a conflict:
  // transformFn is a bijection on the full n*n grid (an involution here),
  // so a well-defined (conflict-free) function built this way is
  // automatically onto every B-label that appears -- and a function
  // between finite sets of equal size is injective iff it's onto
  // (pigeonhole; both boards always have the same number of distinct
  // labels, since they're both full partitions of the same n*n grid).
  _regionsAreTransformPartners(regionsA, regionsB, transformFn) {
    const total = this.n * this.n;
    const labelMap = new Map();
    for (let i = 0; i < total; i++) {
      const srcLabel = regionsA[i];
      const dstLabel = regionsB[transformFn(i)];
      const existing = labelMap.get(srcLabel);
      if (existing === undefined) {
        labelMap.set(srcLabel, dstLabel);
      } else if (existing !== dstLabel) {
        return false;
      }
    }
    return true;
  }

  // True when every board can be paired off with exactly one OTHER board such that
  // applying `transformFn` to one board's region layout produces its partner's layout.
  // Applying the transform to the whole multi-board puzzle then just permutes boards
  // pairwise (partner <-> partner) while leaving the overall constraint set -- rows,
  // columns, and every board's regions -- unchanged as a set, so the (unique) solution
  // must itself be invariant under the transform. Requires an even number of boards.
  //
  // This subsumes the old "exactly two boards, and they're partners" check: with two
  // boards there's only one possible pairing, so it's a strict generalization to any
  // even number of boards where a valid pairing exists (not necessarily board[i] paired
  // with board[i+1] -- any perfect matching works, e.g. board1<->board3, board2<->board4).
  //
  // `transformFn` is always an involution here (diagonal reflection or 180° rotation),
  // which makes "A is B's transform-partner" a symmetric relation (if applying it to A
  // gives B, applying it to B gives back A) -- so this reduces to a perfect-matching
  // existence check over the "is a transform-partner of" graph.
  _isBoardSymmetric(transformFn) {
    const numBoards = this.game.regions.length;
    if (numBoards === 0 || numBoards % 2 !== 0) return false;

    const partners = Array.from({ length: numBoards }, () => new Array(numBoards).fill(false));
    for (let i = 0; i < numBoards; i++) {
      for (let j = i + 1; j < numBoards; j++) {
        if (this._regionsAreTransformPartners(this.game.regions[i], this.game.regions[j], transformFn)) {
          partners[i][j] = partners[j][i] = true;
        }
      }
    }

    const used = new Array(numBoards).fill(false);
    const findMatching = () => {
      const i = used.indexOf(false);
      if (i === -1) return true;
      used[i] = true;
      for (let j = i + 1; j < numBoards; j++) {
        if (!used[j] && partners[i][j]) {
          used[j] = true;
          if (findMatching()) return true;
          used[j] = false;
        }
      }
      used[i] = false;
      return false;
    };

    return findMatching();
  }

  // Same O(n^2) label-map approach as _regionsAreTransformPartners, applied
  // to one board against itself (src and dst are the same region string).
  _computeInternalDiagonalSymmetry(mirrorFn) {
    const total = this.n * this.n;
    for (const r of this.game.regions) {
      const labelMap = new Map();
      for (let i = 0; i < total; i++) {
        const srcLabel = r[i];
        const dstLabel = r[mirrorFn(i)];
        const existing = labelMap.get(srcLabel);
        if (existing === undefined) {
          labelMap.set(srcLabel, dstLabel);
        } else if (existing !== dstLabel) {
          return false;
        }
      }
    }
    return true;
  }

  _computeInternalRotation180() {
    const total = this.n * this.n;
    return this._computeInternalDiagonalSymmetry(i => total - 1 - i);
  }

  _computeCrossboardRotation180() {
    const total = this.n * this.n;
    return this._isBoardSymmetric(i => total - 1 - i);
  }
}
