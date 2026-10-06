import { CELL, HINT_COLOR, HINT_SOURCE_VARIANTS } from './constants.js';

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
        : empty.length === 1
          ? `Only one spot is left for the last star in this ${unitType}.`
          : `Exactly ${empty.length} spots are left for the ${empty.length} remaining stars in this ${unitType}.`;
      return {
        description,
        highlights: [],
        marks: empty.map(idx => ({ idx, color: HINT_COLOR.TARGET_STAR })),
        boardIdx: unit.boardIdx,
        // Outline the unit's own full shape/boundary for the player --
        // a row/column outlines board-agnostically (see _outlineEntriesFor),
        // a region only on its own board.
        regionOutlines: this._outlineEntriesFor(unit, 'blue'),
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
      const empty = unit.indices.filter(idx => this.vState(idx) === CELL.NONE);
      return {
        description: typeDescs[key],
        highlights: [],
        marks: empty.map(idx => ({ idx, color: HINT_COLOR.TARGET })),
        boardIdx: unit.boardIdx ?? undefined,
        // Outline the unit's own full shape/boundary -- same reasoning as
        // hintOnlyEmpty above.
        regionOutlines: this._outlineEntriesFor(unit, 'blue'),
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

  // -- Region subset, matched by capacity (2★+) ---------------------------------
  //
  // The 2★+ replacement for hintRegionSubsetSync(K) in the multi-star rule
  // list (1★ still uses hintRegionSubsetSync(1)/(2), where K happens to equal
  // the number of regions). A region's CAPACITY is how many stars it still
  // needs. What a player actually notices is "these cells are all inside
  // that region, and both still need the same number of stars" -- so the
  // star count itself shouldn't change how hard the pattern is:
  //
  //  - Hard   (hintRegionSubsetHard): one region needing K stars sits inside
  //    another region needing K stars, for any K.
  //  - Expert (hintRegionSubsetExpert): a region OR a PAIR of regions (two
  //    regions on one board) needing K stars sits inside another region or
  //    pair needing K stars. At least one side must be a pair -- single-in-
  //    single is the Hard rule. Groups of three or more regions are not
  //    considered.
  //
  // Either way the cells of the outer combo outside the inner one are dots:
  // the outer combo's K stars all have to come from the inner combo's cells.
  //
  // Measured against the old K-tiered hintRegionSubsetSync(1..4) on 10 books
  // (~1000 puzzles each): essentially tier-neutral at 2★ (2 of ~8,000
  // puzzles move), but at 3★ roughly 70% of Expert puzzles become Hard, since
  // a region needing 3 inside another needing 3 used to be Expert purely
  // because of the 3.
  p._regionCapacityCombos = function (maxSize) {
    const combos = [];
    for (const bIdx of this.boardIndices) {
      const needing = this.getRegionsNeedingStars(bIdx);
      for (let size = 1; size <= maxSize; size++) {
        for (const combo of this.getCombinations(needing, size)) {
          combos.push({
            K: combo.reduce((sum, e) => sum + e.remaining, 0),
            regions: combo.map(e => e.region),
            // Only still-open cells matter: a star already placed elsewhere
            // isn't part of "where can the remaining stars go".
            indices: new Set(combo.flatMap(e => e.region.indices.filter(i => this.vState(i) === CELL.NONE))),
            boardIdx: bIdx,
          });
        }
      }
    }
    return combos;
  };

  p._regionSubsetByCapacity = function (maxSize, requirePair) {
    const combos = this._regionCapacityCombos(maxSize);
    const candidates = [];
    for (const a of combos) {
      for (const b of combos) {
        if (a === b || a.K !== b.K) continue;
        if (requirePair && a.regions.length === 1 && b.regions.length === 1) continue;
        if (!Array.from(a.indices).every(idx => b.indices.has(idx))) continue;
        const targets = Array.from(b.indices).filter(idx => !a.indices.has(idx));
        if (targets.length > 0) candidates.push({ a, b, targets });
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((x, y) => (x.targets[0] ?? 0) - (y.targets[0] ?? 0));
    return candidates.map(({ a, b, targets }) =>
      this.formatSubsetHint(a.regions, b.regions, targets, a.boardIdx, b.boardIdx));
  };

  p.hintRegionSubsetHard = function () {
    return this._regionSubsetByCapacity(1, false);
  };

  p.hintRegionSubsetExpert = function () {
    return this._regionSubsetByCapacity(2, true);
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

    // Name every line involved, the same way renderer.js labels the axes:
    // rows by 1-indexed number, columns by letter.
    const lineName = (label, i) => label === "Row" ? String(i + 1) : String.fromCharCode(65 + i);
    const listPhrase = (label, idxs) => {
      const names = [...idxs].sort((a, b) => a - b).map(i => lineName(label, i));
      const word = label.toLowerCase() + (names.length === 1 ? '' : 's');
      const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
      return `${word} ${list}`;
    };
    const windowIdxs = unitCombo.map(u => axisLabel === "Row" ? Math.floor(u[0] / n) : u[0] % n);
    const otherPhrase = listPhrase(otherAxisLabel, touchedOther);
    const windowPhrase = listPhrase(axisLabel, windowIdxs);
    const otherCount = touchedOther.size;
    const provides = otherCount === 1 ? 'provides' : 'provide';
    const needs = windowIdxs.length === 1 ? 'needs' : 'need';
    const starsPhrase = requiredCount === 1 ? 'the 1 star' : `the ${requiredCount} stars`;
    const satisfies = otherCount === 1 ? `that ${otherAxisLabel.toLowerCase()}`
      : otherCount === 2 ? `both ${otherAxisLabel.toLowerCase()}s`
      : `all of those ${otherAxisLabel.toLowerCase()}s`;
    const description = `${otherPhrase[0].toUpperCase()}${otherPhrase.slice(1)} ${provides} ${starsPhrase} `
      + `${windowPhrase} still ${needs}, which satisfies ${satisfies}.`;

    return {
      boardIdx: undefined,
      description,
      // The trapping lines' own empty cells -- each one already known (by
      // construction) to fall within one of the touched other-axis units.
      // Filled in addition to the outline since the outlined lines are the
      // WHOLE row/column, not just this subset.
      highlights: availInUnits.map(idx => ({ idx, color: HINT_COLOR.SOURCE })),
      marks: targets.map(idx => ({ idx, color: HINT_COLOR.TARGET })),
      // Outline the trapping rows/columns' full shape -- board-agnostic, so
      // it's drawn on every board -- same treatment as the region-based
      // sibling rules (_hintRegionsTrappedInUnits/_hintMultiRegionsTrappedInUnits).
      // One entry per board with every line's cells unioned together (not
      // per-line) so non-adjacent lines still split into separate contours
      // automatically, same as those siblings' own combo.flatMap pattern.
      regionOutlines: this.boardIndices.map(boardIdx => ({ indices: unitCombo.flat(), color: 'blue', boardIdx })),
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

  // -- Region-pair placement forced (1★ AND 2★+, Expert) ------------------
  //
  // hintUnitPlacementForced's weak (adjacency-only) enumeration applied to a
  // synthetic "hybrid region": the union of two unfinished regions on the
  // same board that share at least one orthogonal edge, needing both
  // regions' combined remaining stars. Pure union -- each region's own quota
  // is deliberately NOT enforced, so a placement may put all of the pair's
  // stars in one of the two regions. A cell in no placement, or a cell just
  // outside the union touching a star of every placement, is a dot; a cell
  // in every placement is a star. Single-board only, never cross-board.
  // Pairs whose enumeration would exceed ENUMERATION_COMBO_CAP are skipped.
  // Python port: rule_region_pair_placement_forced in rules_common.py.
  p._touchingRegionPairs = function () {
    if (this._touchingRegionPairsCache) return this._touchingRegionPairsCache;
    const n = this.n;
    const pairs = [];
    const regionsByBoard = new Map();
    for (const u of this.units) {
      if (u.boardIdx === undefined) continue;
      if (!regionsByBoard.has(u.boardIdx)) regionsByBoard.set(u.boardIdx, []);
      regionsByBoard.get(u.boardIdx).push(u);
    }
    for (const [boardIdx, regions] of regionsByBoard) {
      const owner = new Map();
      for (const u of regions) for (const i of u.indices) owner.set(i, u);
      const seen = new Set();
      for (const [i, ua] of owner) {
        const r = Math.floor(i / n), c = i % n;
        const nbs = [];
        if (r + 1 < n) nbs.push(i + n);
        if (c + 1 < n) nbs.push(i + 1);
        for (const j of nbs) {
          const ub = owner.get(j);
          if (!ub || ub === ua) continue;
          const [a, b] = ua.indices[0] < ub.indices[0] ? [ua, ub] : [ub, ua];
          const key = `${a.label}|${b.label}`;
          if (seen.has(key)) continue;
          seen.add(key);
          pairs.push({ a, b, boardIdx });
        }
      }
    }
    this._touchingRegionPairsCache = pairs;
    return pairs;
  };

  // Weak enumeration depends only on the union's own cells, so it's cached on
  // exactly that state and survives across moves elsewhere on the board --
  // most pairs are untouched by any single move. Cleared wholesale if it
  // grows large, since each entry can hold many combos.
  p._regionPairCombos = function (union) {
    if (!this._regionPairCombosCache || this._regionPairCombosCache.size > 5000) {
      this._regionPairCombosCache = new Map();
    }
    const key = `${union.label}|${union.indices.map(i => this.vState(i)).join(',')}`;
    let combos = this._regionPairCombosCache.get(key);
    if (combos === undefined) {
      combos = this._enumerateUnitCompletions(union, false, 2 * this.starsPerGroup);
      this._regionPairCombosCache.set(key, combos);
    }
    return combos;
  };

  p.hintRegionPairPlacementForced = function () {
    const hints = [];
    const pairs = this._touchingRegionPairs()
      .slice()
      .sort((x, y) => (x.a.indices[0] - y.a.indices[0]) || (x.b.indices[0] - y.b.indices[0]));
    for (const { a, b, boardIdx } of pairs) {
      const needA = this.starsPerGroup - a.indices.filter(i => this.vState(i) === CELL.STAR).length;
      const needB = this.starsPerGroup - b.indices.filter(i => this.vState(i) === CELL.STAR).length;
      if (needA <= 0 || needB <= 0) continue;

      const union = { indices: [...a.indices, ...b.indices], label: `${a.label}+${b.label}`, boardIdx };
      const combos = this._regionPairCombos(union);
      if (!combos || combos.length === 0) continue;

      const unionSet = new Set(union.indices);
      const avail = union.indices.filter(i => this.vState(i) === CELL.NONE);
      const outside = new Set();
      for (const cell of union.indices) {
        for (const nb of this.getNeighbors(cell)) {
          if (!unionSet.has(nb) && this.vState(nb) === CELL.NONE) outside.add(nb);
        }
      }
      const forcedStars = avail.filter(cell => combos.every(combo => combo.includes(cell)));
      const forcedDots = [
        ...avail.filter(cell => !combos.some(combo => combo.includes(cell))),
        ...[...outside].filter(cell => combos.every(combo => combo.some(s => this._cellsAdjacent(s, cell)))),
      ];
      if (forcedStars.length === 0 && forcedDots.length === 0) continue;

      const need = needA + needB;
      const intro = `Treat the two blue-outlined regions as one. Every way to place their ${need} remaining star${need === 1 ? '' : 's'}`;
      // Prototype: outline the union (a and b touching, so they trace as
      // ONE seamless blue shape -- no shared-edge line between them, since
      // both are in the same outline entry) instead of filling its cells.
      // See renderer.js's _buildRegionOutlineSvg.
      const regionOutlines = [{ indices: union.indices, color: 'blue', boardIdx }];
      if (forcedStars.length > 0) {
        hints.push({
          description: `${intro} includes the marked cell${forcedStars.length === 1 ? '' : 's'}.`,
          highlights: [],
          marks: forcedStars.map(idx => ({ idx, color: HINT_COLOR.TARGET_STAR })),
          regionOutlines,
          boardIdx
        });
      }
      if (forcedDots.length > 0) {
        hints.push({
          description: `${intro} rules out a star at the marked cell${forcedDots.length === 1 ? '' : 's'}.`,
          highlights: [],
          marks: forcedDots.map(idx => ({ idx, color: HINT_COLOR.TARGET })),
          regionOutlines,
          boardIdx
        });
      }
    }
    return hints.length > 0 ? hints : null;
  };

  // -- Region algebra (1★ AND 2★+, Expert) ---------------------------------
  //
  // Two DISJOINT units A, B on the same board -- each a row, a column, or
  // a region -- jointly hold 2N stars. If some OTHER unit C (any row, column,
  // or region, other than A/B themselves) has all of its non-dot cells
  // inside A∪B (and reaches into both A and B), then all N of C's stars lie
  // in A∪B, so the remainder R = (A∪B) \ C holds exactly N stars. R is then
  // reasoned about like a region of its own:
  //  - R already has its N stars: every other open cell of R is a dot.
  //  - 1★: a cell outside R that sees (same row/column, or adjacent) every
  //    open cell of R is a dot; a lone open cell of R is a star.
  //  - 2★+: hintUnitPlacementForced's weak (adjacency-only) enumeration on R.
  // Shown as R in blue and C in brown, on whichever board(s) A/B/C actually
  // live on (see abBoards/marksOn below) -- a whole row/column is board-
  // agnostic and drawn wherever the rest of the hint is; a region is drawn
  // on its own board, plus (for C) wherever it overlaps A/B if that's a
  // different board.
  //
  // A/B used to be restricted to "two regions on one board" (with C then
  // required to be a row/column or a region on a DIFFERENT board, so it
  // wouldn't just be a third region of that same board). Generalized so A
  // and B can be any disjoint pair of units at all -- e.g. two rows, or a
  // row and a region -- which also means there's no longer a single "home
  // board" to exclude C from; C only has to be a different unit than A/B.
  // Two REGIONS must still share a board, though (2026-09-29, user's
  // call): regions from different boards are never added together. A
  // row/column is on every board, so it pairs with anything.
  //
  // Finding (A, B) by testing every disjoint PAIR of units up front doesn't
  // scale -- O(units^2 * units), measured at ~90ms/call on a 25x25/6★ board.
  // Instead this iterates C first, exactly like the original did (which
  // built a single-valued cell->region owner Map, since regions partition a
  // board): for C's FIRST live cell, try each unit touching it as A (a
  // cell's row, column, and one region per board -- a small, fixed list via
  // _unitsByCell, not a single owner anymore since a cell can belong to
  // several candidate units at once); then require every remaining live
  // cell to share one common OTHER unit, which must be B. That's the whole
  // candidate set for this C, found in time proportional to C's own cell
  // count rather than the total unit count -- measured at ~0.3ms/call on
  // the same 25x25/6★ board, matching the original's cost profile.
  // Python port: rule_region_algebra in rules_common.py.
  p.hintRegionAlgebra = function () {
    const n = this.n;
    const N = this.starsPerGroup;
    const starsText = N === 1 ? '1 star' : `${N} stars`;
    const hints = [];
    const sees = (a, b) => {
      const ra = Math.floor(a / n), ca = a % n, rb = Math.floor(b / n), cb = b % n;
      return ra === rb || ca === cb || (Math.abs(ra - rb) <= 1 && Math.abs(ca - cb) <= 1);
    };

    for (const cUnit of this.units) {
      const live = cUnit.indices.filter(i => this.vState(i) !== CELL.DOT);
      if (live.length < 2) continue;

      const firstCandidates = this._unitsByCell[live[0]].filter(u => u !== cUnit);
      for (const ua of firstCandidates) {
        const aSet = new Set(ua.indices);
        const remaining = live.slice(1).filter(i => !aSet.has(i));
        if (remaining.length === 0) continue; // B would never be touched

        let bCandidates = null;
        for (const i of remaining) {
          const cands = new Set(this._unitsByCell[i].filter(u => u !== cUnit && u !== ua));
          bCandidates = bCandidates === null ? cands : new Set([...bCandidates].filter(u => cands.has(u)));
          if (bCandidates.size === 0) break;
        }
        if (!bCandidates || bCandidates.size === 0) continue;

        for (const ub of bCandidates) {
          const bSet = new Set(ub.indices);
          if (ua.indices.some(i => bSet.has(i))) continue; // not disjoint
          // A and B must be on the same board: two regions from different
          // boards are never added together. A row/column is on every
          // board, so it can pair with anything.
          if (ua.boardIdx !== undefined && ub.boardIdx !== undefined && ua.boardIdx !== ub.boardIdx) continue;

          const cSet = new Set(cUnit.indices);
          const rem = [...ua.indices, ...ub.indices].filter(i => !cSet.has(i));
          const have = rem.filter(i => this.vState(i) === CELL.STAR).length;
          const avail = rem.filter(i => this.vState(i) === CELL.NONE);
          if (avail.length === 0) continue;
          const remSet = new Set(rem);

          let forcedStars = [];
          let forcedDots = [];
          let why;
          if (have >= N) {
            forcedDots = avail;
            why = { dots: forcedDots.length === 1
              ? `The cyan cells already have their ${starsText}, so the marked cell is a dot.`
              : `The cyan cells already have their ${starsText}, so the marked cells are dots.` };
          } else if (N === 1) {
            if (avail.length === 1) forcedStars = avail;
            for (let i = 0; i < n * n; i++) {
              if (this.vState(i) === CELL.NONE && !remSet.has(i) && avail.every(c => sees(i, c))) forcedDots.push(i);
            }
            why = {
              // forcedStars is only ever populated when avail.length === 1,
              // so this branch is always singular.
              stars: `Only one cyan cell is still open, so it's a star.`,
              dots: forcedDots.length === 1
                ? `A star at the marked cell would see every open cyan cell, leaving them without their star.`
                : `A star at any of the marked cells would see every open cyan cell, leaving them without their star.`,
            };
          } else {
            const combos = this._enumerateUnitCompletions({ indices: rem, label: 'regionAlgebra' }, false, N);
            if (!combos || combos.length === 0) continue;
            const outside = new Set();
            for (const cell of rem) {
              for (const nb of this.getNeighbors(cell)) {
                if (!remSet.has(nb) && this.vState(nb) === CELL.NONE) outside.add(nb);
              }
            }
            forcedStars = avail.filter(cell => combos.every(combo => combo.includes(cell)));
            forcedDots = [
              ...avail.filter(cell => !combos.some(combo => combo.includes(cell))),
              ...[...outside].filter(cell => combos.every(combo => combo.some(s => this._cellsAdjacent(s, cell)))),
            ];
            why = {
              stars: forcedStars.length === 1
                ? `Every way to place ${N} non-touching stars in the cyan cells includes the marked cell.`
                : `Every way to place ${N} non-touching stars in the cyan cells includes the marked cells.`,
              dots: forcedDots.length === 1
                ? `Every way to place ${N} non-touching stars in the cyan cells rules out a star at the marked cell.`
                : `Every way to place ${N} non-touching stars in the cyan cells rules out a star at the marked cells.`,
            };
          }
          if (forcedStars.length === 0 && forcedDots.length === 0) continue;

          // Outline A∪B -- the whole "region pair" -- in blue. C (the
          // thing "implied" to lie inside it) and R (= A∪B minus C, the
          // thing actually gaining an exact star count) each get their own
          // highlight-fill color instead of a second outline color: C can
          // sit deep inside A∪B, so its boundary and part of A∪B's own
          // boundary often run right alongside each other, and two
          // semi-transparent outline strokes doing that read as a blurry
          // mess rather than two distinct shapes. A fill has no boundary
          // of its own to compete with an outline's, so both read cleanly
          // nested inside it instead.
          //
          // A∪B is drawn as one outline on the pair's own board -- the
          // region's board if either A or B is a region (a row/column
          // paired with it is drawn there only, not on every board), else
          // every board, like any other row/column outline. A and B's
          // indices are merged into ONE array per board so touching units
          // still trace as a single seamless shape, same as
          // hintRegionPairPlacementForced's union.
          const pairHome = ua.boardIdx ?? ub.boardIdx;
          const pairBoards = pairHome !== undefined ? [pairHome] : this.boardIndices;
          const pairByBoard = new Map(pairBoards.map(b => [b, [...ua.indices, ...ub.indices]]));
          const regionOutlines = [...pairByBoard.entries()].map(([b, indices]) => ({ indices, color: 'blue', boardIdx: b }));

          // A region only has geometric meaning on its own board, but its
          // cells still exist (and still matter to this argument) on every
          // board -- highlight them everywhere so the relationship is
          // visible no matter which board the player is looking at. A
          // row/column already looks identical on every board, so
          // repeating its highlight on all of them is just noise -- show
          // it once, on whichever board the blue outline is itself
          // anchored to (a concrete region's board if either A or B is
          // one, else the lowest board index the outline actually
          // touches).
          const fallbackBoard = ua.boardIdx ?? ub.boardIdx ?? [...pairByBoard.keys()].sort((x, y) => x - y)[0];
          const cBoards = cUnit.boardIdx !== undefined ? this.boardIndices : [fallbackBoard];
          const cColor = HINT_SOURCE_VARIANTS[1]; // brown
          // C's cells minus dots (see `live` above) -- a dot isn't part of
          // the "C lies entirely inside A∪B" argument, so it isn't part of
          // what's highlighted either.
          const highlights = cBoards.flatMap(b => live.map(idx => ({ idx, color: cColor, boards: [b] })));

          // R gets the same per-cell board treatment as the blue outline
          // (each cell shown on its owning unit's board, or the same
          // fallback a row/col owner would use) -- just as a highlight
          // instead of a separate outline entry.
          const rColor = HINT_SOURCE_VARIANTS[2]; // cyan
          for (const idx of rem) {
            const owner = aSet.has(idx) ? ua : ub;
            const boards = owner.boardIdx !== undefined ? [owner.boardIdx] : [fallbackBoard];
            for (const b of boards) highlights.push({ idx, color: rColor, boards: [b] });
          }

          // Marked cells are board-agnostic facts; show them on every
          // board the outline or either highlight actually appears on.
          const allBoardsInvolved = new Set([...pairByBoard.keys(), ...cBoards, fallbackBoard]);
          const marksOn = [...allBoardsInvolved];
          const boardIdx = allBoardsInvolved.size === 1 ? marksOn[0] : undefined;

          // Names A/B's own kinds instead of the generic "two blue-outlined
          // units" -- "two rows", "two columns", "two regions", or a
          // row/column paired with a region (region named second either
          // way, to read as "the odd one out" against the other two
          // matching). A row+column pair can never happen here: every row
          // and every column intersect in exactly one cell, so they can
          // never be the disjoint A/B this rule requires -- only
          // same-kind pairs or a row-or-column-with-a-region pair are
          // reachable, covering all 5 real cases.
          const kindA = this._unitKind(ua), kindB = this._unitKind(ub);
          const pairPhrase = kindA === kindB
            ? `two blue-outlined ${kindA}s`
            : `the blue-outlined ${kindA === 'region' ? kindB : kindA} and region`;

          const cName = cUnit.boardIdx !== undefined ? `The brown region` : `${cUnit.label} (brown)`;
          const intro = `${pairPhrase[0].toUpperCase()}${pairPhrase.slice(1)} hold ${2 * N} stars together. `
            + `${cName} has all its open cells inside them, so it accounts for ${N} of those, `
            + `leaving exactly ${starsText} for the cyan cells. `;
          if (forcedStars.length > 0) {
            hints.push({
              description: intro + why.stars,
              highlights,
              marks: forcedStars.map(idx => ({ idx, color: HINT_COLOR.TARGET_STAR, boards: marksOn })),
              regionOutlines,
              boardIdx
            });
          }
          if (forcedDots.length > 0) {
            hints.push({
              description: intro + why.dots,
              highlights,
              marks: forcedDots.map(idx => ({ idx, color: HINT_COLOR.TARGET, boards: marksOn })),
              regionOutlines,
              boardIdx
            });
          }
        }
      }
    }
    return hints.length > 0 ? hints : null;
  };

  // -- Partial subset + partial union-subset (2★+) --------------------------------
  //
  // Region subset (hintRegionSubsetHard/Expert) needs both sides to need the
  // SAME number of stars, so everything left over is a dot. These two rules
  // drop that restriction. If every open cell of A lies inside B, and A needs
  // FEWER stars than B, then all of A's stars are among B's, so the leftover
  // R = B \ A holds EXACTLY need(B) - need(A) stars. R is reasoned about like
  // a synthetic region with that quota, same as hintRegionAlgebra's
  // remainder: the weak (adjacency-only) placement enumeration -- cells in no
  // placement, or just outside R touching a star of every placement, are
  // dots; cells in every placement are stars.
  //
  //  - hintPartialSubset (Hard): A and B are each a single unit (row,
  //    column or region -- regions from either board, since the boards share
  //    one solution).
  //  - hintPartialSubsetUnion (Expert): one side or both is a UNION of two
  //    disjoint units (single-in-pair, pair-in-single, pair-in-pair), needs
  //    summed. Two regions are only ever added together on the same board
  //    (same convention as hintRegionAlgebra); a row/column pairs with
  //    anything. A pair never shares a member with the other side (that
  //    reduces to a plain partial subset).
  //
  // Only OPEN cells count and "needs" are remaining needs, so a star already
  // placed inside A or B just lowers the quota. Equal needs are left to the
  // region-subset rules. Python port: rule_partial_subset /
  // rule_partial_subset_union in rules_common.py.

  // One entry per unit that still needs stars (and has enough open cells):
  // BigInt bitmask of its open cells, so subset/disjointness tests on whole
  // units are single operations even on a 25x25 board.
  p._openUnitInfos = function () {
    const N = this.starsPerGroup;
    const infos = [];
    for (const unit of this.units) {
      let need = N, mask = 0n, size = 0;
      for (const i of unit.indices) {
        const s = this.vState(i);
        if (s === CELL.NONE) { mask |= 1n << BigInt(i); size++; }
        else if (s === CELL.STAR) need--;
      }
      if (need > 0 && size >= need) infos.push({ members: [unit], mask, size, need });
    }
    return infos;
  };

  // Same as above for a side made of one or two units.
  p._partialSubsetSide = function (...parts) {
    return {
      members: parts.flatMap(x => x.members),
      mask: parts.reduce((m, x) => m | x.mask, 0n),
      size: parts.reduce((s, x) => s + x.size, 0),
      need: parts.reduce((s, x) => s + x.need, 0),
    };
  };

  // Disjoint open cells, and never two regions from different boards.
  p._partialSubsetCompatible = function (x, y) {
    if (x.mask & y.mask) return false;
    const bx = x.members[0].boardIdx, by = y.members[0].boardIdx;
    return !(bx !== undefined && by !== undefined && bx !== by);
  };

  p._maskCells = function (mask) {
    const cells = [];
    for (let i = 0; mask > 0n; i++, mask >>= 1n) if (mask & 1n) cells.push(i);
    return cells;
  };

  // "the blue row", "the two blue columns", "the blue row and region"...
  p._partialSubsetPhrase = function (side, color) {
    const kinds = side.members.map(u => this._unitKind(u));
    if (kinds.length === 1) return `the ${color} ${kinds[0]}`;
    if (kinds[0] === kinds[1]) return `the two ${color} ${kinds[0]}s`;
    const [line, other] = kinds[0] === 'region' ? [kinds[1], kinds[0]] : [kinds[0], kinds[1]];
    return `the ${color} ${line} and ${other}`;
  };

  // The board a side is drawn on: its region's board if it has one (a
  // row/column paired with a region is drawn there only), else `fallback`.
  p._partialSubsetBoard = function (side, fallback) {
    const owner = side.members.find(u => u.boardIdx !== undefined);
    return owner ? owner.boardIdx : fallback;
  };

  // Builds the star/dot hints for "R = rem holds exactly `quota` stars", or
  // null if nothing is forced. `inner`/`outer` are the two sides.
  p._partialSubsetHints = function (inner, outer, remMask, quota) {
    const rem = this._maskCells(remMask);
    if (rem.length < quota) return null;
    const combos = this._enumerateUnitCompletions({ indices: rem, label: 'partialSubset' }, false, quota);
    if (!combos || combos.length === 0) return null;
    const remSet = new Set(rem);
    const outside = new Set();
    for (const cell of rem) {
      for (const nb of this.getNeighbors(cell)) {
        if (!remSet.has(nb) && this.vState(nb) === CELL.NONE) outside.add(nb);
      }
    }
    const forcedStars = rem.filter(cell => combos.every(combo => combo.includes(cell)));
    const forcedDots = [
      ...rem.filter(cell => !combos.some(combo => combo.includes(cell))),
      ...[...outside].filter(cell => combos.every(combo => combo.some(s => this._cellsAdjacent(s, cell)))),
    ];
    if (forcedStars.length === 0 && forcedDots.length === 0) return null;

    // Each side is outlined on its own board (blue = inner, brown = outer),
    // the inner side's open cells are filled blue and R pink (cyan sat too close to blue to tell apart), all on the
    // outer side's board -- same visual language as formatSubsetHint /
    // hintRegionAlgebra. A side that is only rows/columns is board-agnostic,
    // so it is drawn once, on the other side's board (or board 0).
    const fallbackBoard = this._partialSubsetBoard(inner, this._partialSubsetBoard(outer, this.boardIndices[0]));
    const innerBoard = this._partialSubsetBoard(inner, fallbackBoard);
    const outerBoard = this._partialSubsetBoard(outer, fallbackBoard);
    const involved = [...new Set([innerBoard, outerBoard])];
    const boardIdx = involved.length === 1 ? involved[0] : undefined;
    const regionOutlines = [
      { indices: inner.members.flatMap(u => u.indices), color: 'blue', boardIdx: innerBoard },
      { indices: outer.members.flatMap(u => u.indices), color: 'brown', boardIdx: outerBoard },
    ];
    const highlights = [
      ...this._maskCells(inner.mask).map(idx => ({ idx, color: HINT_SOURCE_VARIANTS[0], boards: [outerBoard] })),
      ...rem.map(idx => ({ idx, color: HINT_SOURCE_VARIANTS[3], boards: [outerBoard] })),
    ];

    const starsText = k => k === 1 ? '1 star' : `${k} stars`;
    const cap = s => s[0].toUpperCase() + s.slice(1);
    // A side that is a pair of units reads as plural ("the two blue rows
    // need 4 stars together"); a single unit stays singular.
    const verb = (side, singular, plural) => side.members.length === 2 ? plural : singular;
    const intro = `${cap(this._partialSubsetPhrase(inner, 'blue'))} ${verb(inner, 'needs', 'need')} ${starsText(inner.need)}`
      + `${inner.members.length === 2 ? ' together' : ''} and ${verb(inner, 'lies', 'lie')} entirely inside `
      + `${this._partialSubsetPhrase(outer, 'brown')}, which ${verb(outer, 'needs', 'together need')} ${starsText(outer.need)}. `
      + `All of the blue stars are among the brown ones, leaving exactly ${starsText(quota)} for the pink cells. `;
    const hints = [];
    if (forcedStars.length > 0) {
      hints.push({
        description: intro + (forcedStars.length === 1
          ? `Every way to place ${quota} non-touching ${quota === 1 ? 'star' : 'stars'} in the pink cells includes the marked cell.`
          : `Every way to place ${quota} non-touching ${quota === 1 ? 'star' : 'stars'} in the pink cells includes the marked cells.`),
        highlights, regionOutlines, boardIdx,
        marks: forcedStars.map(idx => ({ idx, color: HINT_COLOR.TARGET_STAR, boards: involved })),
      });
    }
    if (forcedDots.length > 0) {
      hints.push({
        description: intro + (forcedDots.length === 1
          ? `Every way to place ${quota} non-touching ${quota === 1 ? 'star' : 'stars'} in the pink cells rules out a star at the marked cell.`
          : `Every way to place ${quota} non-touching ${quota === 1 ? 'star' : 'stars'} in the pink cells rules out a star at the marked cells.`),
        highlights, regionOutlines, boardIdx,
        marks: forcedDots.map(idx => ({ idx, color: HINT_COLOR.TARGET, boards: involved })),
      });
    }
    return hints;
  };

  p.hintPartialSubset = function () {
    const infos = this._openUnitInfos();
    const tried = new Set();
    const hints = [];
    for (const b of infos) {
      for (const a of infos) {
        if (a.need >= b.need || (a.mask & ~b.mask) !== 0n || a.mask === b.mask) continue;
        const remMask = b.mask & ~a.mask;
        const quota = b.need - a.need;
        const key = `${remMask}:${quota}`;
        if (tried.has(key)) continue;
        tried.add(key);
        const found = this._partialSubsetHints(a, b, remMask, quota);
        if (found) hints.push(...found);
      }
    }
    return hints.length > 0 ? hints : null;
  };

  p.hintPartialSubsetUnion = function () {
    const infos = this._openUnitInfos();
    if (infos.length < 2) return null;
    const singles = infos;
    const pairs = [];
    for (let a = 0; a < singles.length; a++) {
      for (let b = a + 1; b < singles.length; b++) {
        if (this._partialSubsetCompatible(singles[a], singles[b])) {
          pairs.push(this._partialSubsetSide(singles[a], singles[b]));
        }
      }
    }
    const outers = [...singles, ...pairs].sort((x, y) => x.size - y.size);
    const tried = new Set();
    const hints = [];
    for (const outer of outers) {
      // Singles lying inside this outer side (not its own members).
      const inside = singles.filter(s =>
        !outer.members.includes(s.members[0]) && (s.mask & ~outer.mask) === 0n && s.mask !== outer.mask);
      if (inside.length === 0) continue;
      // Inner candidates: a single (only inside an outer PAIR -- single-in-
      // single is hintPartialSubset), or a compatible pair of singles.
      const cand = outer.members.length === 2 ? [...inside] : [];
      for (let x = 0; x < inside.length; x++) {
        for (let y = x + 1; y < inside.length; y++) {
          if (this._partialSubsetCompatible(inside[x], inside[y])) cand.push(this._partialSubsetSide(inside[x], inside[y]));
        }
      }
      for (const inner of cand) {
        if (inner.need >= outer.need || inner.mask === outer.mask || (inner.mask & ~outer.mask) !== 0n) continue;
        const remMask = outer.mask & ~inner.mask;
        const quota = outer.need - inner.need;
        const key = `${remMask}:${quota}`;
        if (tried.has(key)) continue;
        tried.add(key);
        const found = this._partialSubsetHints(inner, outer, remMask, quota);
        if (found) hints.push(...found);
      }
    }
    return hints.length > 0 ? hints : null;
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
