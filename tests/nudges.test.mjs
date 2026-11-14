// Tests for the incremental-hints nudges (solver-nudges.js).  Run:  node --test   (from the repo root)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PuzzleSolver } from '../solver.js';
import { CELL, HINT_COLOR } from '../constants.js';
import { NUDGE_EXEMPT } from '../solver-nudges.js';

// First puzzle of a data/*.csv book as a minimal game object the solver accepts.
function gameFrom(book, rowIdx = 0) {
  const lines = fs.readFileSync(new URL(`../data/${book}.csv`, import.meta.url), 'utf8').trim().split('\n');
  const hdr = lines[0].split(',');
  const c = lines[1 + rowIdx].split(',');
  const row = Object.fromEntries(hdr.map((h, i) => [h, c[i]]));
  const n = Number(row.N);
  const regions = hdr.filter(h => h.startsWith('board_')).map(h => row[h]);
  const stars = [...row.solution.slice(0, n)].filter(ch => ch === 'x').length;
  return { n, starsPerGroup: stars, regions, state: Array(n * n).fill(CELL.NONE), solution: row.solution };
}

test('getNudge: exempt and untagged hints get no nudge', () => {
  const solver = new PuzzleSolver(gameFrom('8x8_beginner'));
  const base = { description: 'x', highlights: [], marks: [{ idx: 0, color: HINT_COLOR.TARGET }] };
  assert.equal(solver.getNudge({ ...base, ruleKey: 'fromSolution' }), null);
  assert.equal(solver.getNudge({ ...base, ruleKey: 'checkForErrors' }), null);
  assert.equal(solver.getNudge({ ...base }), null);
});

test('getNudge outlines only: no fills, one neutral colour, no star/dot hint', () => {
  const solver = new PuzzleSolver(gameFrom('8x8_beginner'));
  const nudge = solver.getNudge({
    ruleKey: 'regionSubsetHard', description: 'full', boardIdx: 0,
    regionOutlines: [{ indices: [0, 1], color: 'blue', boardIdx: 0 }, { indices: [8, 9], color: 'brown', boardIdx: 0 }],
    highlights: [{ idx: 3, color: HINT_COLOR.SOURCE }],
    marks: [{ idx: 5, color: HINT_COLOR.TARGET_STAR }],
  });
  assert.deepEqual(nudge.marks, []);
  assert.deepEqual(nudge.highlights, [], 'source fills are dropped when there are outlines');
  assert.deepEqual(nudge.regionOutlines.map(o => o.color), ['blue', 'blue'], 'roles (blue vs brown) are not given away');
  assert.equal(nudge.boardIdx, 0);
  assert.match(nudge.description, /Press Hint again for the full hint\.$/);
});

test('getNudge keeps blue source cells only when there is nothing outlined', () => {
  const solver = new PuzzleSolver(gameFrom('8x8_beginner'));
  const nudge = solver.getNudge({
    ruleKey: 'excludeAdjacency', description: 'full',
    highlights: [{ idx: 3, color: HINT_COLOR.SOURCE }], marks: [{ idx: 4, color: HINT_COLOR.TARGET }],
  });
  assert.deepEqual(nudge.highlights, [{ idx: 3, color: HINT_COLOR.SOURCE }]);
  assert.deepEqual(nudge.marks, []);
});

test('getNudge: an answer-only hint is outlined, not filled (singleCellRegion outlines its region)', () => {
  const game = gameFrom('8x8_beginner');
  const solver = new PuzzleSolver(game);
  const region = solver.units.find(u => solver._unitKind(u) === 'region' && u.boardIdx === 0);
  const target = region.indices[0];
  const nudge = solver.getNudge({
    ruleKey: 'singleCellRegion', description: 'full', boardIdx: 0,
    highlights: [{ idx: target, color: HINT_COLOR.TARGET_STAR }], marks: [],
  });
  assert.deepEqual(nudge.highlights, []);
  assert.deepEqual(nudge.marks, []);
  assert.deepEqual(nudge.regionOutlines.map(o => [...o.indices].sort((a, b) => a - b)), [[...region.indices].sort((a, b) => a - b)]);

  const look = solver.getNudge({
    ruleKey: 'lookahead1', description: 'full', boardIdx: undefined,
    highlights: [], marks: [{ idx: 9, color: HINT_COLOR.TARGET }],
  });
  assert.deepEqual(look.marks, []);
  assert.ok(look.regionOutlines.every(o => o.indices.length === 1 && o.indices[0] === 9));
  assert.equal(look.regionOutlines.length, solver.boardIndices.length);
});

test('getNudge: tile outlines collapse to their band, or to the unit outline', () => {
  const game = gameFrom('8x8_beginner');
  const solver = new PuzzleSolver(game);
  const n = game.n;
  // three 2x2 tiles in rows 3-4 -> outline of those two rows on every board
  const tiles = [0, 2, 4].map(c => ({ topLeftIdx: 3 * n + c, color: 'blue' }));
  const band = solver.getNudge({ ruleKey: 'tileSingleEmpty', description: 'full', highlights: [], marks: [], tileOutlines: tiles });
  assert.deepEqual(band.tileOutlines, []);
  assert.equal(band.regionOutlines.length, solver.boardIndices.length);
  assert.deepEqual([...band.regionOutlines[0].indices].sort((a, b) => a - b),
    [...Array(2 * n).keys()].map(i => 3 * n + i));
  // a lone tile does not line up in a band: keep the tile outline
  const lone = solver.getNudge({ ruleKey: 'tileSingleEmpty', description: 'full', highlights: [], marks: [], tileOutlines: [tiles[0]] });
  assert.equal(lone.tileOutlines.length, 1);
  // region/line outline present: tiles are dropped
  const withUnit = solver.getNudge({
    ruleKey: 'regionTileStar', description: 'full', highlights: [], marks: [], tileOutlines: tiles,
    regionOutlines: [{ indices: [0, 1, 2], color: 'blue', boardIdx: 0 }],
  });
  assert.deepEqual(withUnit.tileOutlines, []);
  assert.equal(withUnit.regionOutlines.length, 1);
});

// Walk real puzzles with the real solver: every nudge must point at something
// and must never fill an answer cell or use the star colour.
for (const book of ['8x8_beginner', '9x9_medium', '14x14_2star_beginner']) {
  test(`nudges along a real solve (${book})`, () => {
    const game = gameFrom(book);
    const solver = new PuzzleSolver(game);
    let nudged = 0;
    for (let step = 0; step < 300; step++) {
      const hint = solver.getHint();
      if (!hint) break;
      assert.ok(hint.ruleKey, 'getHint tags its hints with ruleKey');
      const nudge = solver.getNudge(hint);
      if (nudge) {
        nudged++;
        assert.deepEqual(nudge.marks, [], `${hint.ruleKey}: a nudge never marks cells`);
        for (const m of nudge.highlights) {
          assert.notEqual(m.color, HINT_COLOR.TARGET_STAR, `${hint.ruleKey}: nudge leaks the star colour`);
          assert.notEqual(m.color, HINT_COLOR.TARGET, `${hint.ruleKey}: nudge fills an answer cell`);
        }
        assert.ok(nudge.description.length > 0);
        assert.ok(
          nudge.highlights.length + nudge.marks.length + (nudge.regionOutlines?.length ?? 0) + (nudge.tileOutlines?.length ?? 0) > 0,
          `${hint.ruleKey}: nudge points at nothing`,
        );
      }
      if (hint.ruleKey === 'alreadySolved' || hint.ruleKey === 'checkForErrors') break;
      let changed = false;
      for (const m of [...hint.marks, ...hint.highlights.filter(h => h.color === HINT_COLOR.TARGET_STAR)]) {
        if (game.state[m.idx] !== CELL.NONE) continue;
        if (hint.ruleKey === 'fromSolution') {
          game.state[m.idx] = game.solution[m.idx] === 'x' ? CELL.STAR : CELL.DOT; changed = true; break;
        }
        game.state[m.idx] = m.color === HINT_COLOR.TARGET_STAR ? CELL.STAR : CELL.DOT;
        changed = true;
      }
      if (!changed) break;
    }
    assert.ok(nudged > 0, 'at least one hint in the solve was nudged');
  });
}
