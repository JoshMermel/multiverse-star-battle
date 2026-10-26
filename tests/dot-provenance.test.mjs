// Regression tests for auto-dot provenance (rules.js) across a reload (history.js).  Run:  node --test tests/
//
// Dot provenance lives only in memory: only the star/dot STATE is saved, so after a reload every restored dot has no recorded reason.  A star
// placed afterwards used to give such a dot its first reason (a region/row/column quota), and removing that star retracted it, wiping a dot
// the player had before the star.  Restored dots must count as the player's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; }, get length() { return Object.keys(this._d).length; }, key(i) { return Object.keys(this._d)[i]; } };
const { applyHistory } = await import('../history.js');
const { applyRules } = await import('../rules.js');
const { CELL } = await import('../constants.js');

// mondrian_2star puzzle 2 (10x10, two boards, 2 stars per row/column/region)
const BOARD_1 = 'AABBBBBBCCAABBBBBBCCAADEEEEECCAADEEEEECCAADEEEEECCFFGGGHHIJJFFGGGHHIJJFFGGGHHIJJFFGGGHHIJJFFGGGHHIJJ';
const BOARD_2 = 'AABBBCCDDDAABBBCCDDDAABBBCCDDDAABBBCCDDDEEEFFGGGGGEEEFFGGGGGEEEFFGGGGGHHHHHHIIIJHHHHHHIIIJHHHHHHIIIJ';
const at = (name) => (name.charCodeAt(0) - 65) + 10 * (Number(name.slice(1)) - 1);   // 'E3' -> 24

function newGame() {
  class Game {}
  applyHistory(Game);
  applyRules(Game);
  const g = new Game();
  Object.assign(g, { n: 10, regions: [BOARD_1, BOARD_2], starsPerGroup: 2, voidCells: undefined,
    _getCellsByIndex: () => [], updateCellVisual() {}, updateControls() {} });
  g._resetHistoryTo(new Array(100).fill(CELL.NONE));
  return g;
}

// the same sequence applyState (script.js) runs for a star placed / removed with auto-dot on
function placeStar(g, name) {
  const i = at(name);
  g.state[i] = CELL.STAR; g.dotReasons.delete(i); g._autoFillDots(i);
}
function removeStar(g, name) {
  const i = at(name);
  g.state[i] = CELL.NONE; g.dotReasons.delete(i); g._removeStarAsReason(i); g._refillIfNowJustified(i);
}
const dots = (g) => g.state.map((c, i) => (c === CELL.DOT ? i : -1)).filter(i => i >= 0);
const reload = (g) => g._resetHistoryTo([...g.state]);          // what loadProgress does with the saved state

test('removing a star keeps dots that existed before it (live session)', () => {
  const g = newGame();
  ['C3', 'C5', 'E5'].forEach(s => placeStar(g, s));
  const before = dots(g);
  placeStar(g, 'E3'); removeStar(g, 'E3');
  assert.deepEqual(before.filter(i => g.state[i] !== CELL.DOT), []);
});

test('removing a star keeps dots that existed before it, after a reload', () => {
  const g = newGame();
  ['C3', 'C5', 'E5'].forEach(s => placeStar(g, s));
  const before = dots(g);
  assert.ok(before.includes(at('C4')));
  reload(g);
  placeStar(g, 'E3'); removeStar(g, 'E3');
  assert.deepEqual(before.filter(i => g.state[i] !== CELL.DOT), [], 'a dot present before the star was wiped');
});

test('dots added by a star placed after a reload are still retracted when it is removed', () => {
  const g = newGame();
  ['C3', 'C5', 'E5'].forEach(s => placeStar(g, s));
  reload(g);
  const before = dots(g);
  placeStar(g, 'E3');
  assert.ok(dots(g).length > before.length);
  removeStar(g, 'E3');
  assert.deepEqual(dots(g), before);
});

test('the initial history snapshot records restored dots as manual (so undo cannot orphan them)', () => {
  const g = newGame();
  ['C3', 'C5'].forEach(s => placeStar(g, s));
  reload(g);
  const snap = JSON.parse(g.history[0]);
  for (const i of dots(g)) assert.ok(snap.dotReasons[i]?.includes('manual'), `dot ${i} has no manual reason in the snapshot`);
});
