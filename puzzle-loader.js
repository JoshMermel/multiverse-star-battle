// Mixin for fetching, parsing, and caching puzzle data.

export function applyPuzzleLoader(GameClass) {
  console.log("applying");
  const p = GameClass.prototype;

  // --- Helpers ---

  // Check if category is the daily puzzle.
  p.isDailyCategory = function (catId) {
    return catId === 'daily';
  };

  // Recall the last puzzle visited in a book, so returning to it resumes
  // where the user left off instead of jumping back to puzzle 1. Daily
  // puzzles aren't tracked this way, since "position" doesn't apply there.
  p._getRememberedPuzzleNum = function (catId) {
    const val = parseInt(localStorage.getItem(`sb_last_puz_${catId}`), 10);
    return Number.isInteger(val) && val > 0 ? val : 1;
  };

  // Remember the current puzzle position for a book.
  p._rememberPuzzlePosition = function (catId, puzNum) {
    localStorage.setItem(`sb_last_puz_${catId}`, String(puzNum));
  };

  // Get today's date in the Boston timezone as an ISO-like YYYY-MM-DD string.
  p._getBostonDateStr = function () {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());
  };

  // Check if today is Sunday in the Boston timezone.
  p.isSunday = function () {
    const day = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
    }).format(new Date());
    return day === 'Sun';
  };

  // Calculate today's stable puzzle index from the Unix epoch.
  p.getDailyPuzzleIndex = function (total) {
    const midnightBoston = new Date(this._getBostonDateStr()).getTime();
    const msPerDay = 24 * 60 * 60 * 1000;
    const daysSinceEpoch = Math.floor(midnightBoston / msPerDay);

    return daysSinceEpoch % total;
  };

  // --- Parsing ---

  // Parse CSV puzzle data into an array of puzzle objects.
  p.parseCsv = function (text) {
    const lines = text.split('\n');
    const puzzles = [];
    let id = 1;
    let headers = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const cols = line.split(',');
      if (cols[0] === 'name') {
        headers = cols.map(c => c.trim());
        continue;
      }
      if (headers.length === 0) {
        const [name, N, board_1, board_2, solution, score, tier, is_solved] = cols;
        if (!name || !N || !board_1 || !board_2 || !solution) continue;
        puzzles.push({
          id: id++,
          name,
          N: parseInt(N, 10),
          boards: [board_1, board_2],
          board1: board_1,
          board2: board_2,
          solution,
          tier: tier || ''
        });
        continue;
      }

      const rowObj = {};
      headers.forEach((h, idx) => {
        rowObj[h] = cols[idx] ? cols[idx].trim() : '';
      });

      if (!rowObj.name || !rowObj.N || !rowObj.solution) continue;

      const boards = [];
      const boardKeys = Object.keys(rowObj)
        .filter(k => k.toLowerCase().startsWith('board'))
        .sort((a, b) => {
          const numA = parseInt(a.replace(/\D/g, ''), 10) || 0;
          const numB = parseInt(b.replace(/\D/g, ''), 10) || 0;
          return numA - numB;
        });

      boardKeys.forEach(k => {
        if (rowObj[k]) {
          boards.push(rowObj[k]);
        }
      });

      if (boards.length === 0) continue;

      puzzles.push({
        id: id++,
        name: rowObj.name,
        N: parseInt(rowObj.N, 10),
        boards,
        board1: boards[0] || '',
        board2: boards[1] || '',
        solution: rowObj.solution,
        tier: rowObj.tier || ''
      });
    }
    return puzzles;
  };

  // --- Hashing ---

  // Generate a stable 16-character hash of the puzzle configuration.
  p.computePuzzleId = async function (puzzleData) {
    const stable = JSON.stringify({
      boards: puzzleData.boards || [puzzleData.board1, puzzleData.board2],
      solution: puzzleData.solution,
    });
    const hashBuffer = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(stable)
    );
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex.slice(0, 16);
  };

  // --- Loading ---

  // Load a category by ID and target puzzle index.
  p.loadCategory = async function (catId, targetPuz = 1) {
    if (this.isDailyCategory(catId)) {
      await this.loadDailyCategory(targetPuz);
      return;
    }

    const puzInput = document.getElementById('puzzle-input');
    const countLabel = document.getElementById('puzzle-count-label');

    if (!this.puzzleCache.has(catId)) {
      const response = await fetch(`data/${catId}.csv`);
      this.puzzleCache.set(catId, this.parseCsv(await response.text()));
    }
    this.loadedPuzzles = this.puzzleCache.get(catId);
    const total = this.loadedPuzzles.length;

    puzInput.max = total;
    countLabel.textContent = `of ${total}`;

    const clampedPuz = Math.max(1, Math.min(targetPuz, total));
    puzInput.value = clampedPuz;

    await this.loadPuzzle(this.loadedPuzzles[clampedPuz - 1], catId);
  };

  // Load today's daily puzzles from all tiers (including expert on Sundays).
  p.loadDailyCategory = async function (targetSlot = 1) {
    // Keyed by date (not a fixed 'daily' key) so a tab left open across
    // midnight fetches fresh puzzles instead of reusing yesterday's cache.
    const cacheKey = `daily_${this._getBostonDateStr()}`;
    if (!this.puzzleCache.has(cacheKey)) {
      const isSunday = this.isSunday();

      const fetches = [
        fetch('data/daily_beginner.csv').then(r => r.text()),
        fetch('data/daily_medium.csv').then(r => r.text()),
        fetch('data/daily_hard.csv').then(r => r.text()),
        ...(isSunday ? [fetch('data/daily_expert.csv').then(r => r.text())] : []),
      ];
      const texts = await Promise.all(fetches);

      const tierDefs = [
        { label: 'Beginner', text: texts[0] },
        { label: 'Medium',   text: texts[1] },
        { label: 'Hard',     text: texts[2] },
        ...(isSunday ? [{ label: 'Expert', text: texts[3] }] : []),
      ];

      const dailyPuzzles = tierDefs.map(({ label, text }) => {
        const puzzles = this.parseCsv(text);
        return {
          ...puzzles[this.getDailyPuzzleIndex(puzzles.length)],
          dailyLabel: label,
        };
      });

      this.puzzleCache.set(cacheKey, dailyPuzzles);
    }

    this.loadedPuzzles = this.puzzleCache.get(cacheKey);
    const total = this.loadedPuzzles.length;

    const puzInput = document.getElementById('puzzle-input');
    puzInput.max = total;
    const clampedSlot = Math.max(1, Math.min(targetSlot, total));
    puzInput.value = clampedSlot;
    document.getElementById('puzzle-count-label').textContent = `of ${total}`;

    await this._loadDailyPuzzleBySlot(clampedSlot);
  };

  p._loadDailyPuzzleBySlot = async function (slot) {
    const puzzle = this.loadedPuzzles[slot - 1];
    await this.loadPuzzle(puzzle, 'daily');
  };
}
