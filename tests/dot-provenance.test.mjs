// Regression tests for auto-dot provenance (rules.js) across a reload (history.js).  Run:  node --test   (from the repo root)
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
const { storageManager } = await import('../storage.js');

// mondrian_2star puzzle 2 (10x10, two boards, 2 stars per row/column/region)
const BOARD_1 = 'AABBBBBBCCAABBBBBBCCAADEEEEECCAADEEEEECCAADEEEEECCFFGGGHHIJJFFGGGHHIJJFFGGGHHIJJFFGGGHHIJJFFGGGHHIJJ';
const BOARD_2 = 'AABBBCCDDDAABBBCCDDDAABBBCCDDDAABBBCCDDDEEEFFGGGGGEEEFFGGGGGEEEFFGGGGGHHHHHHIIIJHHHHHHIIIJHHHHHHIIIJ';
const SOLUTION = (() => { const s = new Array(100).fill('.'); ['B1','D1','F2','I2','A3','C3','G4','I4','C5','E5','A6','H6','D7','F7','H8','J8','B9','E9','G10','J10']
  .forEach(n => { s[(n.charCodeAt(0) - 65) + 10 * (Number(n.slice(1)) - 1)] = 'x'; }); return s.join(''); })();
const at = (name) => (name.charCodeAt(0) - 65) + 10 * (Number(name.slice(1)) - 1);   // 'E3' -> 24

function newGame(id = 'test-puzzle') {
  class Game {}
  applyHistory(Game);
  applyRules(Game);
  const g = new Game();
  Object.assign(g, { n: 10, regions: [BOARD_1, BOARD_2], starsPerGroup: 2, voidCells: undefined, currentPuzzleUniqueId: id, solution: SOLUTION,
    _getCellsByIndex: () => [], updateCellVisual() {}, updateControls() {}, updateVisuals() {}, validate() {}, updateSolvedUI() {},
    _persistTimerProgress() {} });
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


// ---- persistence across a real save + load (storage.js) ----
const fresh = () => { localStorage._d = {}; };
const saved = (g) => { g.saveCurrentState(); return g; };
const reloaded = (g) => { const g2 = newGame(g.currentPuzzleUniqueId); g2.loadProgress(); return g2; };
const record = (id = 'test-puzzle') => localStorage.getItem(`sb_dr_${id}`);

test('dots placed automatically are still retracted with their star after a reload', () => {
  fresh();
  const g = newGame(); placeStar(g, 'C3'); saved(g);
  assert.ok(dots(g).length > 0);
  const g2 = reloaded(g);
  assert.deepEqual(dots(g2), dots(g));
  removeStar(g2, 'C3');
  assert.deepEqual(dots(g2), [], 'auto-placed dots should have been retracted');
});

test("the player's own dots survive a reload and the removal of a star that also justified them", () => {
  fresh();
  const g = newGame();
  for (const name of ['J10', 'B2']) { const i = at(name); g.state[i] = CELL.DOT; g._addDotReason(i, 'manual'); }   // B2 is next to C3
  placeStar(g, 'C3'); saved(g);
  const g2 = reloaded(g);
  removeStar(g2, 'C3');
  assert.deepEqual(dots(g2).sort((a, b) => a - b), [at('B2'), at('J10')].sort((a, b) => a - b));
});

test("a record that does not match the saved board is ignored (every dot counts as the player's own)", () => {
  fresh();
  const g = newGame(); placeStar(g, 'C3'); saved(g);
  const board = [...g.state]; board[at('J10')] = CELL.DOT;
  storageManager.savePuzzleState(g.currentPuzzleUniqueId, board);        // e.g. an older cached copy of the app saved the board only
  const g2 = reloaded(g);
  removeStar(g2, 'C3');
  assert.equal(dots(g2).length, dots(g).length + 1, 'nothing should be retracted');
});

test('a game saved before the record existed loads with every dot kept', () => {
  fresh();
  const g = newGame(); placeStar(g, 'C3'); saved(g);
  localStorage.removeItem('sb_dr_test-puzzle');
  const g2 = reloaded(g);
  removeStar(g2, 'C3');
  assert.equal(dots(g2).length, dots(g).length);
});

test('a garbled record is ignored rather than breaking the load', () => {
  fresh();
  const g = newGame(); placeStar(g, 'C3'); saved(g);
  for (const junk of ['not json', '{"v":2,"s":"","a":[1]}', '{"v":1,"s":null,"a":"x"}']) {
    localStorage.setItem('sb_dr_test-puzzle', junk);
    assert.deepEqual(dots(reloaded(g)), dots(g));
  }
});

test('the record is small, and absent once there is nothing to record', () => {
  fresh();
  const g = newGame(); ['C3', 'C5', 'E5'].forEach(s => placeStar(g, s)); saved(g);
  assert.ok(record() && record().length < 600, `record is ${record()?.length} bytes`);
  const g2 = newGame(); g2.state = new Array(100).fill(CELL.NONE); g2._resetHistoryTo(g2.state); saved(g2);
  assert.equal(record(), null);
});

test('a solved puzzle keeps no record (it would pile up for every puzzle ever solved)', () => {
  fresh();
  const g = newGame();
  [...SOLUTION].forEach((c, i) => { if (c === 'x') placeStar(g, 'ABCDEFGHIJ'[i % 10] + (Math.floor(i / 10) + 1)); });
  assert.ok(g.isSolved() && dots(g).length > 0);
  saved(g);
  assert.equal(record(), null);
});

test('clearing all puzzle data removes the records too', async () => {
  fresh();
  const g = newGame(); placeStar(g, 'C3'); saved(g);
  assert.ok(record());
  await storageManager.clearAllPuzzleData();
  assert.equal(record(), null);
});

test('the E3 scenario through a real save and load: star added and removed after a reload changes nothing', () => {
  fresh();
  const g = newGame(); ['C3', 'C5', 'E5'].forEach(s => placeStar(g, s)); saved(g);
  const g2 = reloaded(g);
  const before = dots(g2);
  placeStar(g2, 'E3');
  assert.ok(dots(g2).length > before.length);
  removeStar(g2, 'E3');
  assert.deepEqual(dots(g2), before);
});
