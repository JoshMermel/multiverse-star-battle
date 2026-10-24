// Lays out a printable booklet of puzzles (numbered puzzle pages followed
// by an answer key) as vector PDF pages. Pure data in, bytes out: nothing
// here touches the DOM or game state, so the print modal (print.js) just
// parses its form and hands the selected puzzles over. Drawing primitives
// live in pdf-writer.js.

import { PdfDocument, textWidth } from './pdf-writer.js';
import { isRegionlessBoard } from './geometry.js';

// Page sizes in points (1/72 inch).
export const PAPER = Object.freeze({
  letter: { label: 'Letter', width: 612, height: 792 },
  a4: { label: 'A4', width: 595.28, height: 841.89 },
});

// "Puzzles per page" choices offered in the UI, besides Auto.
export const PER_PAGE_CHOICES = Object.freeze([1, 2, 3, 4, 6, 8]);

const MARGIN = 40;
const SLOT_GAP = 20;       // between puzzles on a page
const BOARD_GAP = 18;      // between a puzzle's boards, side by side
const BOARD_GAP_V = 6;     // ...and stacked (the next board's label sits in it too)
const PUZZLE_TITLE_H = 20;
const BOARD_LABEL_H = 12;
const KEY_TITLE_H = 13;
// Room reserved above and left of each board for its column letters and
// row numbers, when those are on.
const PUZZLE_GUTTER = 12;
const KEY_GUTTER = 9;

// Auto picks the most puzzles per page that keep cells at least this big
// (points; ~0.28 inch / 7 mm is comfortable to write in), and never draws
// them bigger than the max, so a small board doesn't balloon.
const PUZZLE_MIN_CELL = 20;
const PUZZLE_MAX_CELL = 30;
// Answer-key boards only need to be checked by eye.
const KEY_MIN_CELL = 10;
const KEY_MAX_CELL = 16;

const AUTO_PER_PAGE = [1, 2, 3, 4, 6, 8, 9, 12];
const AUTO_KEY_PER_PAGE = [1, 2, 3, 4, 6, 8, 9, 12, 16, 20, 24, 30, 36, 42, 48, 60];

// --- Selection parsing ---

// Parse the "which puzzles" field: comma-separated numbers and ranges
// ("1-10, 15, 20-25"), or "all". Order is kept as typed (so someone can ask
// for a particular sequence) and repeats are dropped. Returns
// { ids: number[] } or { error: string }.
export function parsePuzzleSelection(text, total) {
  const trimmed = String(text).trim();
  if (!trimmed) return { error: 'Enter which puzzles to print, like 1-10 or 3, 7, 12-15.' };
  if (/^all$/i.test(trimmed)) {
    return { ids: Array.from({ length: total }, (_, i) => i + 1) };
  }

  const seen = new Set();
  const ids = [];
  for (const token of trimmed.split(/[,;]/)) {
    const part = token.trim();
    if (!part) continue;
    const m = part.match(/^(\d+)\s*(?:[-–]\s*(\d+))?$/);
    if (!m) return { error: `Couldn't read "${part}". Use numbers and ranges like 1-10, 15.` };
    const from = parseInt(m[1], 10);
    const to = m[2] === undefined ? from : parseInt(m[2], 10);
    if (from > to) return { error: `"${part}" counts backwards -- write it as ${to}-${from}.` };
    for (const bound of [from, to]) {
      if (bound < 1 || bound > total) {
        return { error: `Puzzle ${bound} doesn't exist -- this book has ${total}.` };
      }
    }
    for (let i = from; i <= to; i++) {
      if (!seen.has(i)) { seen.add(i); ids.push(i); }
    }
  }
  if (ids.length === 0) return { error: 'Enter which puzzles to print, like 1-10 or 3, 7, 12-15.' };
  return { ids };
}

// --- Layout ---

// Biggest cell size at which `boards` n x n boards fit in a slot of the
// given size (title above, labels over each board when there's more than
// one), trying every way to arrange the boards in rows and columns. Each
// board also carries a `gutter` of axis labels along its top and left.
// Returns { cell, boardCols, boardRows } with `cell` NOT yet capped.
function fitBoardsInSlot(slotW, slotH, boards, n, titleH, gutter) {
  const labelH = boards > 1 ? BOARD_LABEL_H : 0;
  let best = null;
  for (let boardCols = 1; boardCols <= boards; boardCols++) {
    const boardRows = Math.ceil(boards / boardCols);
    const byWidth = (slotW - (boardCols - 1) * BOARD_GAP - boardCols * gutter) / (boardCols * n);
    const byHeight = (slotH - titleH - boardRows * (labelH + gutter) - (boardRows - 1) * BOARD_GAP_V) / (boardRows * n);
    const cell = Math.min(byWidth, byHeight);
    if (!best || cell > best.cell) best = { cell, boardCols, boardRows };
  }
  return best;
}

// Best way to tile `k` slots over `area`, each holding one puzzle's boards.
function fitSlots(area, k, boards, n, titleH, maxCell, gutter) {
  let best = null;
  for (let cols = 1; cols <= k; cols++) {
    const rows = Math.ceil(k / cols);
    const slotW = (area.width - (cols - 1) * SLOT_GAP) / cols;
    const slotH = (area.height - (rows - 1) * SLOT_GAP) / rows;
    const fit = fitBoardsInSlot(slotW, slotH, boards, n, titleH, gutter);
    if (!best || fit.cell > best.rawCell) {
      best = { cols, rows, slotW, slotH, rawCell: fit.cell, boardCols: fit.boardCols, boardRows: fit.boardRows };
    }
  }
  return { ...best, k, gutter, cell: Math.max(1, Math.min(best.rawCell, maxCell)) };
}

// The rules blurb at the top of each puzzle page.
function rulesText({ stars, regionless, boards }) {
  const amount = stars === 1 ? '1 star' : `${stars} stars`;
  let text = regionless
    ? `Place ${amount} in every row and column of each board. Black cells cannot hold a star.`
    : `Place ${amount} in every row, column and bold region of each board.`;
  text += ' Stars may not touch, even diagonally.';
  if (boards > 1) text += ' The boards share one solution: stars go in the same cells on every board.';
  return text;
}

const RULES_SIZE = 8.5;
const RULES_LEADING = 11;

function wrapText(text, size, maxWidth) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    const attempt = line ? `${line} ${word}` : word;
    if (line && textWidth(attempt, size) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = attempt;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Describe a puzzle's shape for planning: `stars` per row/column, whether
// it's regionless, board count and size. Booklets are laid out for the
// largest board count / size among the selected puzzles, so a mixed
// selection (the daily set) still fits.
export function describePuzzles(puzzles) {
  const first = puzzles[0];
  const stars = Math.max(1, Math.round((first.solution.match(/x/g) || []).length / first.N));
  return {
    stars,
    regionless: first.boards.every(b => isRegionlessBoard(b)),
    boards: Math.max(...puzzles.map(p => p.boards.length)),
    n: Math.max(...puzzles.map(p => p.N)),
  };
}

// Work out the page structure: how many puzzles per page (picking
// automatically if asked), at what cell size, and how many puzzle and
// answer-key pages that makes. Also used by the modal's live summary, so
// it only does arithmetic.
export function planBooklet({ count, shape, paper = 'letter', perPage = 'auto', includeKey = true, axisLabels = false }) {
  const page = PAPER[paper] ?? PAPER.letter;
  const rulesLines = wrapText(rulesText(shape), RULES_SIZE, page.width - 2 * MARGIN);
  const puzzleArea = {
    x: MARGIN,
    y: MARGIN + 30 + rulesLines.length * RULES_LEADING + 8,
    width: page.width - 2 * MARGIN,
    height: 0,
  };
  puzzleArea.height = page.height - 44 - puzzleArea.y;
  const keyArea = {
    x: MARGIN,
    y: MARGIN + 30,
    width: page.width - 2 * MARGIN,
    height: page.height - 44 - (MARGIN + 30),
  };

  const choose = (candidates, area, boards, titleH, minCell, maxCell, gutter) => {
    const usable = candidates.filter(k => k <= Math.max(1, count));
    let chosen = fitSlots(area, usable[0], boards, shape.n, titleH, maxCell, gutter);
    for (const k of usable) {
      const fit = fitSlots(area, k, boards, shape.n, titleH, maxCell, gutter);
      if (fit.rawCell >= minCell) chosen = fit;
    }
    return chosen;
  };

  const puzzleGutter = axisLabels ? PUZZLE_GUTTER : 0;
  const keyGutter = axisLabels ? KEY_GUTTER : 0;
  const puzzleLayout = perPage === 'auto'
    ? choose(AUTO_PER_PAGE, puzzleArea, shape.boards, PUZZLE_TITLE_H, PUZZLE_MIN_CELL, PUZZLE_MAX_CELL, puzzleGutter)
    : fitSlots(puzzleArea, perPage, shape.boards, shape.n, PUZZLE_TITLE_H, PUZZLE_MAX_CELL, puzzleGutter);
  const keyLayout = choose(AUTO_KEY_PER_PAGE, keyArea, 1, KEY_TITLE_H, KEY_MIN_CELL, KEY_MAX_CELL, keyGutter);

  const puzzlePages = Math.ceil(count / puzzleLayout.k);
  const keyPages = includeKey ? Math.ceil(count / keyLayout.k) : 0;
  return { page, rulesLines, puzzleArea, keyArea, puzzleLayout, keyLayout, puzzlePages, keyPages, includeKey };
}

// --- Drawing ---

const THIN_GRAY = 0.62;

// Draw one n x n board with its top-left at (x, y): thin grid, black voids,
// bold region borders (wherever neighboring cells' region letters differ,
// plus the outline), the optional axis labels (column letters above, row
// numbers to the left, like the game's Axis labels setting), and -- for the
// answer key -- the solution's stars.
function drawBoard(page, x, y, cell, n, regionString, solution, axisLabels) {
  const size = n * cell;
  const thick = Math.min(2.2, Math.max(0.9, cell * 0.085));
  const thin = Math.max(0.3, cell * 0.022);

  const grid = [];
  for (let i = 1; i < n; i++) {
    grid.push([x + i * cell, y, x + i * cell, y + size]);
    grid.push([x, y + i * cell, x + size, y + i * cell]);
  }
  page.lines(grid, { width: thin, gray: THIN_GRAY });

  for (let i = 0; i < n * n; i++) {
    if (regionString[i] === '*') {
      page.fillRect(x + (i % n) * cell, y + Math.floor(i / n) * cell, cell, cell, 0);
    }
  }

  const edges = [];
  for (let i = 0; i < n * n; i++) {
    const r = Math.floor(i / n), c = i % n;
    if (c < n - 1 && regionString[i] !== regionString[i + 1]) {
      edges.push([x + (c + 1) * cell, y + r * cell, x + (c + 1) * cell, y + (r + 1) * cell]);
    }
    if (r < n - 1 && regionString[i] !== regionString[i + n]) {
      edges.push([x + c * cell, y + (r + 1) * cell, x + (c + 1) * cell, y + (r + 1) * cell]);
    }
  }
  page.lines(edges, { width: thick, cap: 'square' });
  page.strokeRect(x, y, size, size, { width: thick });

  if (axisLabels) {
    const fontSize = Math.min(9, Math.max(6, cell * 0.4));
    for (let i = 0; i < n; i++) {
      page.text(String.fromCharCode(65 + i), x + (i + 0.5) * cell, y - 2.5, fontSize, { align: 'center', gray: 0.35 });
      page.text(String(i + 1), x - 2.5, y + (i + 0.5) * cell + fontSize * 0.35, fontSize, { align: 'right', gray: 0.35 });
    }
  }

  if (solution) {
    const outer = cell * 0.38, inner = outer * 0.42;
    for (let i = 0; i < n * n; i++) {
      if (solution[i] !== 'x') continue;
      const cx = x + (i % n + 0.5) * cell, cy = y + (Math.floor(i / n) + 0.5) * cell;
      const points = [];
      for (let p = 0; p < 10; p++) {
        const radius = p % 2 === 0 ? outer : inner;
        const angle = -Math.PI / 2 + p * Math.PI / 5;
        points.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]);
      }
      page.fillPolygon(points, 0);
    }
  }
}

// Draw one slot: a title, then the puzzle's boards (or, for the key, just
// the first board with its stars), centered in the slot.
function drawSlot(page, slotX, slotY, layout, titleH, title, titleSize, puzzle, { key }) {
  const boardsToDraw = key ? [puzzle.boards[0]] : puzzle.boards;
  const labelH = boardsToDraw.length > 1 ? BOARD_LABEL_H : 0;
  const { cell, slotW, slotH, gutter } = layout;
  const boardCols = key ? 1 : layout.boardCols;
  const boardRows = key ? 1 : layout.boardRows;
  // A board's footprint includes its axis-label gutter along the top/left.
  const boardSize = puzzle.N * cell + gutter;

  const blockW = boardCols * boardSize + (boardCols - 1) * BOARD_GAP;
  const blockH = titleH + boardRows * (labelH + boardSize) + (boardRows - 1) * BOARD_GAP_V;
  const left = slotX + (slotW - blockW) / 2;
  const top = slotY + Math.max(0, (slotH - blockH) / 2);

  page.text(title, left, top + titleSize, titleSize, { bold: true });

  boardsToDraw.forEach((regionString, i) => {
    const bx = left + (i % boardCols) * (boardSize + BOARD_GAP);
    const by = top + titleH + labelH + Math.floor(i / boardCols) * (labelH + boardSize + BOARD_GAP_V);
    if (labelH) page.text(`Board ${i + 1}`, bx, by - 3, 8, { gray: 0.4 });
    drawBoard(page, bx + gutter, by + gutter, cell, puzzle.N, regionString, key ? puzzle.solution : null, gutter > 0);
  });
}

function drawPageFrame(page, bookLabel, subtitle, pageNumber) {
  const { width, height } = page;
  page.text(subtitle ? `${bookLabel} - ${subtitle}` : bookLabel, MARGIN, MARGIN + 10, 11, { bold: true });
  page.text('Multiverse Star Battle', width - MARGIN, MARGIN + 10, 9, { align: 'right', gray: 0.45 });
  page.lines([[MARGIN, MARGIN + 17, width - MARGIN, MARGIN + 17]], { width: 0.6, gray: 0.55 });
  page.text(String(pageNumber), width / 2, height - 24, 9, { align: 'center', gray: 0.35 });
}

// Slot positions for one page, row by row.
function slotOrigin(area, layout, slotIndex) {
  const col = slotIndex % layout.cols, row = Math.floor(slotIndex / layout.cols);
  return {
    x: area.x + col * (layout.slotW + SLOT_GAP),
    y: area.y + row * (layout.slotH + SLOT_GAP),
  };
}

// Build the booklet. `puzzles` are { number, N, boards: [regionString, ...],
// solution } in print order; `number` is the puzzle's number in its book
// (optional `title` / `keyTitle` override "Puzzle N" / "N").
// Resolves to the PDF's bytes.
export async function buildBooklet({ puzzles, bookLabel, paper = 'letter', perPage = 'auto', includeKey = true, axisLabels = false }) {
  const shape = describePuzzles(puzzles);
  const plan = planBooklet({ count: puzzles.length, shape, paper, perPage, includeKey, axisLabels });
  const doc = new PdfDocument({ title: `${bookLabel} puzzles` });
  let pageNumber = 0;

  for (let start = 0; start < puzzles.length; start += plan.puzzleLayout.k) {
    const page = doc.addPage(plan.page.width, plan.page.height);
    drawPageFrame(page, bookLabel, '', ++pageNumber);
    plan.rulesLines.forEach((line, i) => {
      page.text(line, MARGIN, MARGIN + 30 + i * RULES_LEADING, RULES_SIZE, { gray: 0.3 });
    });
    puzzles.slice(start, start + plan.puzzleLayout.k).forEach((puzzle, slot) => {
      const { x, y } = slotOrigin(plan.puzzleArea, plan.puzzleLayout, slot);
      drawSlot(page, x, y, plan.puzzleLayout, PUZZLE_TITLE_H, puzzle.title ?? `Puzzle ${puzzle.number}`, 13, puzzle, { key: false });
    });
  }

  if (plan.includeKey) {
    for (let start = 0; start < puzzles.length; start += plan.keyLayout.k) {
      const page = doc.addPage(plan.page.width, plan.page.height);
      drawPageFrame(page, bookLabel, 'Answer key', ++pageNumber);
      puzzles.slice(start, start + plan.keyLayout.k).forEach((puzzle, slot) => {
        const { x, y } = slotOrigin(plan.keyArea, plan.keyLayout, slot);
        drawSlot(page, x, y, plan.keyLayout, KEY_TITLE_H, puzzle.keyTitle ?? String(puzzle.number), 9, puzzle, { key: true });
      });
    }
  }

  return doc.toBytes();
}
