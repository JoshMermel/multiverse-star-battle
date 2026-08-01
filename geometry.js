// Pure cell-geometry helpers for an n x n board, shared by the game (rules.js)
// and the solver (solver-core.js, solver-rules-*.js). No board/game state --
// every function takes n explicitly and has no side effects.

// 8-way neighbor cell indices (orthogonal + diagonal).
export function getNeighbors8(idx, n) {
  const row = Math.floor(idx / n);
  const col = idx % n;
  const neighbors = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = row + dr, nc = col + dc;
      if (nr >= 0 && nr < n && nc >= 0 && nc < n) {
        neighbors.push(nr * n + nc);
      }
    }
  }
  return neighbors;
}

// Whether two cells are adjacent, including diagonally (the "stars can't
// touch" rule).
export function cellsAdjacent(a, b, n) {
  const ra = Math.floor(a / n), ca = a % n;
  const rb = Math.floor(b / n), cb = b % n;
  return Math.abs(ra - rb) <= 1 && Math.abs(ca - cb) <= 1;
}

// Whether cell a "sees" cell b: same row, same column, or adjacent. Used by
// deductions like "an external cell that sees every candidate in a unit."
// Narrower than same-region visibility, which needs region data callers
// layer on top themselves.
export function cellsSee(a, b, n) {
  const ra = Math.floor(a / n), ca = a % n;
  const rb = Math.floor(b / n), cb = b % n;
  return ra === rb || ca === cb || (Math.abs(ra - rb) <= 1 && Math.abs(ca - cb) <= 1);
}

// All cell indices in row r / column c of an n x n board.
export function rowIndices(n, r) {
  return Array.from({ length: n }, (_, k) => r * n + k);
}

export function colIndices(n, c) {
  return Array.from({ length: n }, (_, k) => k * n + c);
}
