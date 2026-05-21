// Mixin for fetching, parsing, and caching puzzle data.

export function applyPuzzleLoader(GameClass) {
  const p = GameClass.prototype;

  // --- Helpers ---

  // Check if category is the daily puzzle.
  p.isDailyCategory = function (catId) {
    return catId === 'daily';
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
    // Use ISO-like local format (YYYY-MM-DD) for reliable parsing.
    const bostonDateStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());

    const midnightBoston = new Date(bostonDateStr).getTime();
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
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const cols = line.split(',');
      if (cols[0] === 'name') continue;
      const [name, N, board_1, board_2, solution, score, tier, is_solved] = cols;
      if (!name || !N || !board_1 || !board_2 || !solution) continue;
      puzzles.push({ id: id++, name, N: parseInt(N, 10), board1: board_1, board2: board_2, solution, tier: tier || '' });
    }
    return puzzles;
  };

  // --- Hashing ---

  // Generate a stable 16-character hash of the puzzle configuration.
  p.computePuzzleId = async function (puzzleData) {
    const stable = JSON.stringify({
      board1: puzzleData.board1,
      board2: puzzleData.board2,
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
    if (!this.puzzleCache.has('daily')) {
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

      this.puzzleCache.set('daily', dailyPuzzles);
    }

    this.loadedPuzzles = this.puzzleCache.get('daily');
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
