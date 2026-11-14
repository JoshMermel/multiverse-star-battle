import { HINT_COLOR } from './constants.js';

// Nudges for the opt-in "Incremental hints" setting: the first Hint press
// shows a NUDGE -- where to look, and nothing more -- and the next press shows
// the full hint. A nudge is a reduced hint-shaped object, so renderer.js's
// applyHintUI draws it exactly like a full hint.
//
// The point of a nudge is to leave the inference to the player, so it says
// WHERE to look but not what to conclude or which technique applies:
//
//   - Outlines only. Every outline is drawn in the one neutral blue, so the
//     roles the full hint's colours give them (this is the region, that is
//     the line, A inside B) aren't given away either.
//   - No cell fills. Blue "source" cells usually ARE the deduction ("the star
//     must be in these cells"), and the targets are the answer, so both are
//     dropped. Only a hint with no outline at all (excludeAdjacency, the
//     symmetry fill) keeps its blue source cells, since there is nothing else
//     to point at.
//   - Tiles collapse to the band or unit they live in: a region/line outline
//     already outlines the unit, and tile-only hints outline the two-row or
//     two-column band (the tiling is the insight, not the location). When the
//     tiles don't line up in a band, the tile outlines are kept.
//   - A hint with only an answer cell outlines it instead of filling it
//     (lookahead), or outlines its region (singleCellRegion).
//
// The wording is a short pointer per kind of thing outlined (NUDGE_TEXT, first
// match wins; the last entry is the default). tests/nudges.test.mjs covers the
// shape; NUDGE_EXEMPT lists rules that get no nudge (the full hint shows at
// once).

// Rules whose hint is already minimal or isn't a deduction.
export const NUDGE_EXEMPT = new Set(['checkForErrors', 'alreadySolved', 'fromSolution']);

export const NUDGE_TEXT = [
  [/^singleCellRegion$/, 'Look at the outlined region.'],
  [/^(onlyEmpty|excludeSolvedUnit|unitPlacementForced)/, 'Look at the outlined row, column or region.'],
  [/^excludeAdjacency$/, 'Look at the blue star.'],
  [/^symmetry/, 'Think about this puzzle\'s symmetry.'],
  [/^lookahead/, 'What happens if you put a star in the outlined cell?'],
  [/./, 'Look at the outlined area.'],
];

const SUFFIX = ' Press Hint again for the full hint.';
const NUDGE_OUTLINE_COLOR = 'blue';

export function nudgeTextFor(ruleKey) {
  for (const [pattern, text] of NUDGE_TEXT) if (pattern.test(ruleKey)) return text;
  return null;
}

export function applyNudges(PuzzleSolver) {
  const p = PuzzleSolver.prototype;

  // Cells covered by tile outlines (a tile with `cells` hugs those cells; a
  // plain one is the 2x2 box at its top-left).
  p._tileOutlineCells = function (tiles) {
    const n = this.n;
    return tiles.flatMap(t => t.cells ?? [t.topLeftIdx, t.topLeftIdx + 1, t.topLeftIdx + n, t.topLeftIdx + n + 1]);
  };

  // Outline entries for the band of rows (or columns) that a set of tiles
  // sits in, across every board -- or null when the tiles don't line up in a
  // band narrower than they are long (a lone 2x2 tile, say).
  p._tileBandOutlines = function (tiles) {
    const n = this.n;
    const cells = this._tileOutlineCells(tiles);
    const rows = cells.map(i => Math.floor(i / n)), cols = cells.map(i => i % n);
    const r0 = Math.min(...rows), r1 = Math.max(...rows);
    const c0 = Math.min(...cols), c1 = Math.max(...cols);
    const rowSpan = r1 - r0 + 1, colSpan = c1 - c0 + 1;
    let indices;
    if (rowSpan <= 2 && colSpan > 2) {
      indices = []; for (let r = r0; r <= r1; r++) for (let c = 0; c < n; c++) indices.push(r * n + c);
    } else if (colSpan <= 2 && rowSpan > 2) {
      indices = []; for (let c = c0; c <= c1; c++) for (let r = 0; r < n; r++) indices.push(r * n + c);
    } else return null;
    return this.boardIndices.map(boardIdx => ({ indices, color: NUDGE_OUTLINE_COLOR, boardIdx, inset: true }));
  };

  // The region (on the hint's board) containing `idx`, as outline entries.
  p._regionOutlineAround = function (idx, boardIdx) {
    const unit = this.units.find(u =>
      this._unitKind(u) === 'region' && u.boardIdx === boardIdx && u.indices.includes(idx));
    return unit ? this._outlineEntriesFor(unit, NUDGE_OUTLINE_COLOR) : null;
  };

  // Builds the nudge for a full hint (tagged with .ruleKey by getHint), or
  // returns null when the rule is exempt (or untagged) and the full hint
  // should show straight away.
  p.getNudge = function (hint) {
    const key = hint.ruleKey;
    if (!key || NUDGE_EXEMPT.has(key)) return null;

    const isTarget = c => c === HINT_COLOR.TARGET || c === HINT_COLOR.TARGET_STAR;
    const sources = (hint.highlights || []).filter(h => !isTarget(h.color));

    let regionOutlines = (hint.regionOutlines || []).map(o => ({ ...o, color: NUDGE_OUTLINE_COLOR }));
    let tileOutlines = hint.tileOutlines || [];
    if (tileOutlines.length > 0) {
      if (regionOutlines.length > 0) tileOutlines = [];          // the unit is enough
      else {
        const band = this._tileBandOutlines(tileOutlines);
        if (band) { regionOutlines = band; tileOutlines = []; }
      }
    }

    // Blue source cells only when there is nothing outlined to point at.
    let highlights = (regionOutlines.length > 0 || tileOutlines.length > 0) ? [] : sources;

    // Nothing but the answer: outline its region (singleCellRegion) or the
    // cell itself, rather than filling it.
    if (highlights.length === 0 && regionOutlines.length === 0 && tileOutlines.length === 0) {
      const targets = [...(hint.highlights || []), ...(hint.marks || [])].filter(m => isTarget(m.color));
      if (key === 'singleCellRegion' && targets.length > 0 && hint.boardIdx !== undefined) {
        regionOutlines = this._regionOutlineAround(targets[0].idx, hint.boardIdx) ?? [];
      }
      if (regionOutlines.length === 0) {
        regionOutlines = targets.flatMap(m =>
          (m.boards ?? (hint.boardIdx !== undefined ? [hint.boardIdx] : this.boardIndices))
            .map(boardIdx => ({ indices: [m.idx], color: NUDGE_OUTLINE_COLOR, boardIdx })));
      }
    }

    // Cross-board rules: also say which boards the deduction spans.
    let text = nudgeTextFor(key);
    if (/^crossBoard/.test(key) && hint.boardIdx === undefined) {
      const boards = new Set();
      for (const o of [...regionOutlines, ...tileOutlines]) {
        if (o.boardIdx !== undefined) boards.add(o.boardIdx);
        (o.boards || []).forEach(b => boards.add(b));
      }
      for (const m of highlights) (m.boards || []).forEach(b => boards.add(b));
      if (boards.size > 1) text += ` It involves ${this._describeBoardNumbers([...boards])}.`;
    }

    return {
      description: text + SUFFIX,
      highlights,
      marks: [],
      regionOutlines,
      tileOutlines,
      boardIdx: hint.boardIdx,
      isNudge: true,
    };
  };
}
