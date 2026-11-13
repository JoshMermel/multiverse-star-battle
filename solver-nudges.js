import { HINT_COLOR } from './constants.js';

// Nudges for the opt-in "Incremental hints" setting: the first Hint press
// shows a NUDGE -- where to look, and a vague idea why -- and the next press
// shows the full hint. A nudge is just a reduced hint-shaped object, so
// renderer.js's applyHintUI draws it exactly like a full hint.
//
// What a nudge keeps and drops (see buildNudge):
//   keeps  the SOURCES: blue/brown/... highlighted cells, region outlines and
//          tile outlines -- the part of the picture that carries the reasoning
//   drops  the TARGETS: the marked cells (the answer), and the star-vs-dot
//          distinction (green vs yellow)
// A hint with nothing but targets (e.g. singleCellRegion, the lookahead
// rules) falls back to showing its target cells in neutral yellow, so the
// player is still pointed somewhere.
//
// The nudge's wording is per rule family (NUDGE_TEXT, first match wins).
// NUDGE_EXEMPT lists rules that get no nudge (the full hint shows at once).
// tests/nudges.test.mjs fails if a rule appears in neither, so a new rule
// has to be given a nudge decision.

// Rules whose hint is already minimal or isn't a deduction.
export const NUDGE_EXEMPT = new Set(['checkForErrors', 'alreadySolved', 'fromSolution']);

// [pattern on the rule key, nudge sentence]. Wording rules: point at WHAT to
// look at ("the outlined ...", "the yellow cell"), say what kind of reasoning
// applies if it helps, never say what the conclusion is.
export const NUDGE_TEXT = [
  // Beginner
  [/^singleCellRegion$/, 'Look at the yellow cell: what does its region need?'],
  [/^onlyEmpty$/, 'Look at the outlined line or region: how many places are left for its stars?'],
  [/^excludeSolvedUnit$/, 'Look at the outlined line or region: does it still need anything?'],
  [/^excludeAdjacency$/, 'Look at the blue star: what does it rule out around it?'],
  [/^domino$/, 'Look at the outlined region and the blue cells: what do they tell you about where its star can go?'],
  [/^unitSeesTooMuch$/, 'Look at the blue cells: what do they tell you about where this line\'s star can go?'],
  [/^(seesTooMuch\d+|seesTooMuchAll)$/, 'Look at the outlined region and the blue cells: what do they tell you about where its star can go?'],

  // Forced placement within one line or region (weak = adjacency only;
  // intermediate and strong also weigh what other lines/regions still need)
  [/^unitPlacementForcedWeak/, 'Look at the outlined line or region: some cells can\'t take its stars without touching.'],
  [/^unitPlacementForcedIntermediate/, 'Look at the outlined line or region: weigh what the rows, columns and regions crossing it still need.'],
  [/^unitPlacementForcedStrong/, 'Look at the outlined line or region: weigh what every board still needs from the cells crossing it.'],

  // Tiles
  [/^(region|line)Tile(Star|Dots)$/, 'Look at the tiles inside the outlined area.'],
  [/^regionTileLineFill/, 'Look at the outlined tiles: how much of the line\'s star quota do they cover?'],
  [/^tilePairQuotaFill/, 'Look at the outlined tiles: how many stars do they account for?'],
  [/^tile(QuotaFillSingle|DisjointQuotaFill)$/, 'Look at the outlined tiles: how many stars do they account for?'],
  [/^tile(SingleEmpty|TwoEmptyDot|SeesTooMuch|SeesTooMuchMulti|BarTrapped|Domino|RegionSubset)$/, 'Look at the outlined tiles: each one has to hold a star.'],

  // Counting windows
  // (prefix match: covers the 1★ and Multi variants, e.g. unitRegionSyncMulti4To5)
  [/^(disjointUnitRegionSync|unitRegionSync|rowColLineSync|manyRegionsSync|longRegionsSync)/, 'Look at the outlined cells: how do their star counts relate to each other?'],

  // Region/line quota and partition
  [/^regionLineQuotaFill/, 'Look at the outlined region and line: how do they share their stars?'],
  [/^regionLinePartition/, 'Look at the outlined region and line: how can the region split its stars?'],
  [/^crossBoardRegionLine/, 'Look at the outlined region and line: the line is shared by every board.'],

  // Subset / overlap / algebra / pairs
  [/^(regionSubset|partialSubset)/, 'Compare the outlined groups of cells: does one fit inside the other?'],
  [/^(partialOverlap|crossBoardPartialOverlap)/, 'Look at the outlined regions: they overlap almost entirely, so what is left over?'],
  [/^regionPair/, 'Look at the outlined pair of regions: how many stars can they hold?'],
  [/^regionAlgebra/, 'Compare the outlined groups of cells: what is the difference between their star counts?'],
  [/^unitCompletionSatisfiesOtherUnit/, 'Look at the outlined line or region: every way of finishing it helps another unit.'],
  [/^crossBoardPinned/, 'Look at the outlined regions: what do they force on the rows or columns they share across boards?'],

  // Symmetry
  [/^symmetry/, 'This board\'s solution is symmetric. What does a cell have to do with its mirror image?'],

  // Lookahead: the yellow cell is the one to test
  [/^lookahead/, 'Imagine a star in the yellow cell and follow what happens: does anything break?'],
];

const FALLBACK_TEXT = 'Look at the highlighted cells.';
const SUFFIX = ' Press Hint again for the full hint.';

export function nudgeTextFor(ruleKey) {
  for (const [pattern, text] of NUDGE_TEXT) if (pattern.test(ruleKey)) return text;
  return null;
}

export function applyNudges(PuzzleSolver) {
  const p = PuzzleSolver.prototype;

  // Builds the nudge for a full hint (tagged with .ruleKey by getHint), or
  // returns null when the rule is exempt (or untagged) and the full hint
  // should show straight away.
  p.getNudge = function (hint) {
    const key = hint.ruleKey;
    if (!key || NUDGE_EXEMPT.has(key)) return null;

    const isTarget = c => c === HINT_COLOR.TARGET || c === HINT_COLOR.TARGET_STAR;
    const sources = (hint.highlights || []).filter(h => !isTarget(h.color));
    const hasOutlines = (hint.regionOutlines?.length ?? 0) + (hint.tileOutlines?.length ?? 0) > 0;

    let highlights, marks;
    if (sources.length > 0 || hasOutlines) {
      highlights = sources;
      marks = [];
    } else {
      // Nothing but the answer to show: point at it, without saying star or dot.
      highlights = [];
      marks = [...(hint.highlights || []), ...(hint.marks || [])]
        .map(m => ({ ...m, color: HINT_COLOR.TARGET }));
    }

    // Cross-board rules: also say which boards the deduction spans.
    let text = nudgeTextFor(key) ?? FALLBACK_TEXT;
    if (/^crossBoard/.test(key) && hint.boardIdx === undefined) {
      const boards = new Set();
      for (const o of [...(hint.regionOutlines || []), ...(hint.tileOutlines || [])]) {
        if (o.boardIdx !== undefined) boards.add(o.boardIdx);
        (o.boards || []).forEach(b => boards.add(b));
      }
      for (const m of [...(hint.highlights || []), ...(hint.marks || [])]) (m.boards || []).forEach(b => boards.add(b));
      if (boards.size > 1) text += ` It involves ${this._describeBoardNumbers([...boards])}.`;
    }

    return {
      description: text + SUFFIX,
      highlights,
      marks,
      regionOutlines: hint.regionOutlines,
      tileOutlines: hint.tileOutlines,
      boardIdx: hint.boardIdx,
      isNudge: true,
    };
  };
}
