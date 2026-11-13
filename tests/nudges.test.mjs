// Tests for the incremental-hints nudges (solver-nudges.js).  Run:  node --test   (from the repo root)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PuzzleSolver } from '../solver.js';
import { CELL, HINT_COLOR } from '../constants.js';
import { NUDGE_EXEMPT, nudgeTextFor } from '../solver-nudges.js';

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

test('every rule in both rule lists has a nudge sentence or is exempt', () => {
  const missing = [];
  for (const book of ['8x8_beginner', '14x14_2star_beginner']) {
    const solver = new PuzzleSolver(gameFrom(book));
    const rules = solver.starsPerGroup === 1 ? solver._getSingleStarRuleList() : solver._getMultiStarRuleList();
    // Both lists, whichever this puzzle uses:
    const keys = new Set([...solver._getSingleStarRuleList(), ...solver._getMultiStarRuleList(), ...rules].map(r => r.key));
    for (const key of keys) if (!NUDGE_EXEMPT.has(key) && !nudgeTextFor(key)) missing.push(key);
  }
  assert.deepEqual([...new Set(missing)], [], 'give these rules a NUDGE_TEXT entry (or add them to NUDGE_EXEMPT)');
});

test('getNudge: exempt and untagged hints get no nudge', () => {
  const solver = new PuzzleSolver(gameFrom('8x8_beginner'));
  const base = { description: 'x', highlights: [], marks: [{ idx: 0, color: HINT_COLOR.TARGET }] };
  assert.equal(solver.getNudge({ ...base, ruleKey: 'fromSolution' }), null);
  assert.equal(solver.getNudge({ ...base, ruleKey: 'checkForErrors' }), null);
  assert.equal(solver.getNudge({ ...base }), null);
});

test('getNudge keeps sources and outlines, drops marks, and never reveals star vs dot', () => {
  const solver = new PuzzleSolver(gameFrom('8x8_beginner'));
  const outlines = [{ indices: [0, 1], color: 'blue', boardIdx: 0 }];
  const withSources = solver.getNudge({
    ruleKey: 'onlyEmpty', description: 'full', boardIdx: 0, regionOutlines: outlines,
    highlights: [{ idx: 3, color: HINT_COLOR.SOURCE }],
    marks: [{ idx: 5, color: HINT_COLOR.TARGET_STAR }],
  });
  assert.deepEqual(withSources.marks, []);
  assert.deepEqual(withSources.highlights, [{ idx: 3, color: HINT_COLOR.SOURCE }]);
  assert.equal(withSources.regionOutlines, outlines);
  assert.equal(withSources.boardIdx, 0);
  assert.match(withSources.description, /Press Hint again for the full hint\.$/);

  // Nothing but the answer (green highlight, as singleCellRegion does): show it neutral yellow.
  const onlyTargets = solver.getNudge({
    ruleKey: 'singleCellRegion', description: 'full', boardIdx: 0,
    highlights: [{ idx: 7, color: HINT_COLOR.TARGET_STAR }], marks: [],
  });
  assert.deepEqual(onlyTargets.highlights, []);
  assert.deepEqual(onlyTargets.marks, [{ idx: 7, color: HINT_COLOR.TARGET }]);
});

// Walk real puzzles with the real solver: every nudge must be hint-shaped, must
// never use the star colour, and must never mark a cell the full hint doesn't
// already highlight or mark.
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
        const fullCells = new Set([...hint.highlights, ...hint.marks].map(m => m.idx));
        for (const m of [...nudge.highlights, ...nudge.marks]) {
          assert.notEqual(m.color, HINT_COLOR.TARGET_STAR, `${hint.ruleKey}: nudge leaks the star colour`);
          assert.ok(fullCells.has(m.idx), `${hint.ruleKey}: nudge shows a cell the full hint doesn't`);
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
