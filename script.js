import { PuzzleSolver } from './solver.js';
import { CELL } from './constants.js';

class StarBattleGame {
  // ────────────────────── 
  // ─── Initialisation ─── 
  // ────────────────────── 

  // Bootstraps the game: sets up global input handling then fetches puzzle data
  constructor() {
    this.puzzleCache = new Map();
    this.categories = [];
    this.loadedPuzzles = [];
    this.draggedIndices = [];
    // Listener setup must run before initGame so they exist during puzzle load
    this.setupGlobalListeners();
    document.addEventListener('DOMContentLoaded', () => this.initGame());
  }

  // Fetches the manifest, populates the category menu, and loads the initial
  // puzzle.
  async initGame() {
    try {
      const resp = await fetch('data/manifest.json');
      const data = await resp.json();
      this.categories = data.categories;
      this.groups = data.groups ?? {};

      this.setupMenu();
      this.setupControls();
      this.setupHelpModal();
      this.setupResetModal();

      const catSelect = document.getElementById('category-select');
      if (this.categories.length > 0) {
        const { catId, puzNum } = this.readUrlParams();

        // If the URL names a manifest category, load it normally via the
        // select. If it names an arbitrary data/ CSV (but not a daily_*
        // file, which is gated to one-per-day), load it directly. Otherwise
        // fall back to the first manifest category.
        const manifestCat = this.categories.find(c => c.id === catId);
        const isArbitraryCsv = catId && !manifestCat && !catId.startsWith('daily_');

        if (isArbitraryCsv) {
          await this.loadCategory(catId, puzNum);
        } else {
          catSelect.value = manifestCat ? manifestCat.id : this.categories[0].id;
          catSelect.dispatchEvent(new CustomEvent('change', { detail: { targetPuz: puzNum } }));
        }

      }
    } catch (e) {
      console.error(e);
      this.showToast("Failed to load game data", "error");
    }
  }

  // Wires up the main game action buttons. Called once after the DOM is ready.
  setupControls() {
    document.getElementById('undo-btn').onclick = () => this.undo();
    document.getElementById('redo-btn').onclick = () => this.redo();
    document.getElementById('check-btn').onclick = () => this.checkCorrectness();
    document.getElementById('hint-btn').onclick = () => this.getHint();
    this.setupBrowseModal();
    this.setupBookPicker();
    this.setupSettings();
  }

  // Creates open/close behaviour for a modal: close button(s), backdrop click,
  // Escape key, and an optional confirm action. Returns { open, close } handles.
  setupModal(modalId, { onConfirm } = {}) {
    const modal = document.getElementById(modalId);
    const close = () => modal.classList.add('modal-hidden');
    const open  = () => modal.classList.remove('modal-hidden');

    modal.querySelectorAll('[data-close]').forEach(btn => btn.onclick = close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !modal.classList.contains('modal-hidden')) close();
    });
    if (onConfirm) {
      document.getElementById(`${modalId}-confirm-btn`).onclick = () => {
        close();
        onConfirm();
      };
    }
    return { open, close };
  }

  // Sets up open/close behaviour for the instructions modal.
  setupHelpModal() {
    const { open } = this.setupModal('help-modal');
    document.getElementById('help-btn').onclick = open;
  }

  // Sets up open/close behaviour for the board-clearing confirmation modal.
  setupResetModal() {
    const { open } = this.setupModal('reset-modal', { onConfirm: () => this.doReset() });
    document.getElementById('reset-btn').onclick = open;
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  setupSettings() {
    const { open } = this.setupModal('settings-modal');
    document.getElementById('settings-btn').onclick = open;

    const darkToggle         = document.getElementById('setting-dark-mode');
    const tabToggle          = document.getElementById('setting-tab-mode');
    const axisLabelsToggle   = document.getElementById('setting-axis-labels');
    const autoFillDotsToggle = document.getElementById('setting-auto-fill-dots');

    // Restore persisted preferences
    const savedDark         = localStorage.getItem('setting-dark-mode')       === 'true';
    const savedTab          = localStorage.getItem('setting-tab-mode')        === 'true';
    const savedAxisLabels   = localStorage.getItem('setting-axis-labels')     === 'true';
    const savedAutoFillDots = localStorage.getItem('setting-auto-fill-dots')  === 'true';

    darkToggle.checked         = savedDark;
    tabToggle.checked          = savedTab;
    axisLabelsToggle.checked   = savedAxisLabels;
    autoFillDotsToggle.checked = savedAutoFillDots;
    this._applyDarkMode(savedDark);
    this._applyTabMode(savedTab);
    // Axis labels are applied after puzzle load, not here, because boards
    // don't exist yet — _applyAxisLabels() is called at the end of loadPuzzle().

    darkToggle.addEventListener('change', () => {
      localStorage.setItem('setting-dark-mode', darkToggle.checked);
      this._applyDarkMode(darkToggle.checked);
    });

    tabToggle.addEventListener('change', () => {
      localStorage.setItem('setting-tab-mode', tabToggle.checked);
      this._applyTabMode(tabToggle.checked);
    });

    axisLabelsToggle.addEventListener('change', () => {
      localStorage.setItem('setting-axis-labels', axisLabelsToggle.checked);
      // Rebuild both boards so label DOM is added/removed cleanly
      if (this.currentPuzzle && this.regions) {
        document.getElementById('board1').innerHTML = '';
        document.getElementById('board2').innerHTML = '';
        this.renderBoard('board1', this.regions[0]);
        this.renderBoard('board2', this.regions[1]);
        this.updateVisuals();
      }
    });

    autoFillDotsToggle.addEventListener('change', () => {
      localStorage.setItem('setting-auto-fill-dots', autoFillDotsToggle.checked);
    });
  }

  _applyDarkMode(on) {
    document.documentElement.setAttribute('data-theme', on ? 'dark' : '');
  }

  _applyTabMode(on) {
    document.body.classList.toggle('tab-mode', on);
    const tabs = document.getElementById('board-tabs');
    tabs.setAttribute('aria-hidden', on ? 'false' : 'true');

    if (on) {
      // Ensure board 1 is the initially visible one
      this._showBoard(this._activeTabBoard ?? 1);
    } else {
      // Restore both boards to normal flow
      document.querySelectorAll('.board-container').forEach(el => {
        el.classList.remove('tab-visible');
      });
    }

    // Wire tab buttons (idempotent — replaces onclick each time)
    document.querySelectorAll('.board-tab').forEach(btn => {
      const board = parseInt(btn.dataset.board);
      btn.onclick = () => this._showBoard(board);
    });
  }

  _showBoard(boardNum) {
    this._activeTabBoard = boardNum;
    document.querySelectorAll('.board-container').forEach((el, i) => {
      const isVisible = (i + 1) === boardNum;
      el.classList.toggle('tab-visible', isVisible);
    });
    document.querySelectorAll('.board-tab').forEach(btn => {
      btn.classList.toggle('board-tab--active', parseInt(btn.dataset.board) === boardNum);
    });
  }

  // ── End Settings ──────────────────────────────────────────────────────────

  setupBrowseModal() {
    const { open, close } = this.setupModal('browse-modal');

    document.getElementById('browse-btn').onclick = () => {
      this._renderBrowseGrid();
      open();
    };

    document.getElementById('browse-jump-btn').onclick = () => {
      const firstUnsolved = this._findFirstUnsolvedPuzzleNum();
      if (firstUnsolved === null) {
        this.showToast("You've solved every puzzle in this book! 🎉", "success");
        return;
      }
      close();
      const puzInput = document.getElementById('puzzle-input');
      puzInput.value = firstUnsolved;
      this.commitPuzzleSelection();
    };
  }

  // Builds (or rebuilds) the grid of browse tiles, marking solved/current state.
  async _renderBrowseGrid() {
    const grid = document.getElementById('browse-grid');
    grid.innerHTML = '';

    const puzzles = this.loadedPuzzles;
    if (!puzzles?.length) return;

    // Build a Set of hashes for all solved puzzles
    const solvedIds = new Set(JSON.parse(localStorage.getItem(this.solvedKey) || '[]'));

    // Pre-compute hashes for all puzzles in this book (cached on the puzzle objects)
    await Promise.all(puzzles.map(async (puz) => {
      if (!puz._cachedId) {
        puz._cachedId = await this.computePuzzleId(puz);
      }
    }));

    const currentId = this.currentPuzzleUniqueId;

    const solvedCount = puzzles.filter(puz => solvedIds.has(puz._cachedId)).length;
    const total = puzzles.length;
    const pct = Math.round(solvedCount / total * 100);
    const toolbarEl = document.querySelector('#browse-modal .browse-toolbar');
    if (toolbarEl) {
      const existing = toolbarEl.querySelector('.browse-completion');
      const completionEl = existing ?? document.createElement('div');
      completionEl.className = 'browse-completion';
      completionEl.textContent = `${solvedCount} of ${total} puzzles solved (${pct}%)`;
      if (!existing) toolbarEl.appendChild(completionEl);
    }

    let currentTier = null;
    puzzles.forEach((puz, i) => {
      const num = i + 1;

      // Insert a full-width tier header whenever the tier changes.
      if (puz.tier && puz.tier !== currentTier) {
        currentTier = puz.tier;
        const header = document.createElement('div');
        header.className = 'browse-tier-header';
        header.textContent = puz.tier;
        grid.appendChild(header);
      }

      const tile = document.createElement('button');
      tile.className = 'browse-tile';
      tile.textContent = num;
      tile.setAttribute('aria-label', `Puzzle ${num}${solvedIds.has(puz._cachedId) ? ' (solved)' : ''}`);

      if (solvedIds.has(puz._cachedId)) tile.classList.add('bt-solved');
      if (puz._cachedId === currentId)  tile.classList.add('bt-current');

      tile.onclick = () => {
        document.getElementById('browse-modal').classList.add('modal-hidden');
        const puzInput = document.getElementById('puzzle-input');
        puzInput.value = num;
        this.commitPuzzleSelection();
      };

      grid.appendChild(tile);
    });

    // Scroll the current tile into view
    const currentTile = grid.querySelector('.bt-current');
    if (currentTile) currentTile.scrollIntoView({ block: 'nearest' });
  }

  // Returns the 1-based puzzle number of the first unsolved puzzle, or null if all solved.
  _findFirstUnsolvedPuzzleNum() {
    const solvedIds = new Set(JSON.parse(localStorage.getItem(this.solvedKey) || '[]'));
    const idx = this.loadedPuzzles.findIndex(puz => !solvedIds.has(puz._cachedId));
    return idx === -1 ? null : idx + 1;
  }

  // Returns true if catId refers to the special daily puzzle category.
  isDailyCategory(catId) {
    return catId === 'daily';
  }

  // Returns true if today is Sunday in the Boston timezone.
  isSunday() {
    const day = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
    }).format(new Date());
    return day === 'Sun';
  }

  // Returns today's 0-based puzzle index by counting days since the Unix epoch
  // and wrapping around the available pool. This is stable for the whole day
  // regardless of when the page is loaded, and cycles forever as new puzzles
  // are added.
  getDailyPuzzleIndex(total) {
    // 1. Get the current time in Boston as a string (YYYY-MM-DD)
    const bostonDateStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());

    // 2. Convert that date string into a timestamp representing 
    // midnight of that day in the local system.
    // Note: 'en-CA' gives YYYY-MM-DD which Date() parses reliably.
    const midnightBoston = new Date(bostonDateStr).getTime();

    // 3. Calculate days since epoch based on that specific midnight
    const msPerDay = 24 * 60 * 60 * 1000;
    const daysSinceEpoch = Math.floor(midnightBoston / msPerDay);

    return daysSinceEpoch % total;
  }

  // Fetches daily.json, selects today's puzzle by date, loads it, and hides
  // the puzzle-navigation controls (prev/next/input) since there is only one
  // puzzle to show.
  async loadDailyCategory(targetSlot = 1) {
    if (!this.puzzleCache.has('daily')) {
      const isSunday = this.isSunday();

      // Fetch beginner/medium/hard in parallel; add expert on Sundays only.
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
  }

  async _loadDailyPuzzleBySlot(slot) {
    const puzzle = this.loadedPuzzles[slot - 1];
    await this.loadPuzzle(puzzle, 'daily');
  }

  // Parses the CSV format produced by gen_puzzles.py into an array of puzzle
  // objects. Expects a header row of: name,N,board_1,board_2,solution
  // Lines beginning with '#' (generator progress comments) are skipped.
  parseCsv(text) {
    const lines = text.split('\n');
    const puzzles = [];
    let id = 1;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const cols = line.split(',');
      // Skip the header row
      if (cols[0] === 'name') continue;
      const [name, N, board_1, board_2, solution, score, tier, is_solved] = cols;
      if (!name || !N || !board_1 || !board_2 || !solution) continue;
      puzzles.push({ id: id++, name, N: parseInt(N, 10), board1: board_1, board2: board_2, solution, tier: tier || '' });
    }
    return puzzles;
  }

  // Fetches puzzles for a category, updates the nav UI, and loads the target puzzle.
  // targetPuz is clamped to the valid range automatically.
  async loadCategory(catId, targetPuz = 1) {
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
  }

  setupMenu() {
    const catSelect = document.getElementById('category-select');
    const puzInput = document.getElementById('puzzle-input');
    const prevBtn = document.getElementById('prev-puz');
    const nextBtn = document.getElementById('next-puz');

    // Populate Categories.
    // Categories with no "group" field (e.g. Daily) are appended first as plain
    // options. The rest are grouped into <optgroup> elements, one per unique
    // group label, preserving manifest order within each group.
    const groups = new Map(); // group label -> <optgroup>
    this.categories.forEach(cat => {
      const opt = document.createElement('option');
      opt.value = cat.id;
      opt.textContent = cat.label;
      if (!cat.group) {
        catSelect.appendChild(opt);
      } else {
        if (!groups.has(cat.group)) {
          const og = document.createElement('optgroup');
          og.label = cat.group;
          catSelect.appendChild(og);
          groups.set(cat.group, og);
        }
        groups.get(cat.group).appendChild(opt);
      }
    });
    catSelect.onchange = async (e) => {
      const catId = e.target.value;
      if (!catId) return;
      this.setLoading(true);
      try {
        await this.loadCategory(catId, e.detail?.targetPuz ?? 1);
      } catch (err) {
        this.showToast("Could not load category", "error");
        console.error(err);
      } finally {
        this.setLoading(false);
      }
    };

    this.commitPuzzleSelection = async () => {
      let val = parseInt(puzInput.value, 10);
      // If the current book is an arbitrary CSV (not in the manifest select),
      // stay in it rather than falling back to whatever the select shows.
      const catId = (this.currentCategoryId && !catSelect.querySelector(`option[value="${this.currentCategoryId}"]`))
        ? this.currentCategoryId
        : catSelect.value;
      if (isNaN(val)) val = 1;

      // Skip if the requested puzzle is already loaded
      if (this.currentCategoryId === catId &&
        this.currentPuzzle?.id === val) return;

      this.setLoading(true);
      try {
        await this.loadCategory(catId, val);
      } finally {
        this.setLoading(false);
      }
    };

    this.stepPuzzle = (delta) => {
      let val = parseInt(puzInput.value) || 1;
      const total = parseInt(puzInput.max) || 0;

      if (delta < 0 && val <= 1) {
        this.showToast("You're on the first puzzle in this book.", "info");
        return;
      }
      if (delta > 0 && total > 0 && val >= total) {
        this.showToast("You're on the last puzzle in this book.", "info");
        return;
      }

      puzInput.value = val + delta;
      this.commitPuzzleSelection();
    };
    const stepPuzzle = this.stepPuzzle;
    prevBtn.onpointerdown = (e) => {
      e.preventDefault();
      stepPuzzle(-1);
    };
    nextBtn.onpointerdown = (e) => {
      e.preventDefault();
      stepPuzzle(1);
    };

    puzInput.addEventListener('input', (e) => {
      // Fire immediately for spinner arrow clicks; wait for Enter when typing.
      if (e.inputType === undefined || e.inputType === 'insertReplacementText') {
        this.commitPuzzleSelection();
      }
    });

    puzInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.commitPuzzleSelection();
        puzInput.blur(); // Remove focus after selection
      }
    });

    // Also commit if the user clicks out of the box
    puzInput.addEventListener('blur', () => {
      this.commitPuzzleSelection();
    });
  }

  // Attaches window-level listeners that persist for the lifetime of the app.
  // Must be called before any puzzle loads.
  setupGlobalListeners() {
    window.addEventListener('keydown', (e) => {
      // Left/right arrow keys navigate puzzles, unless focus is in a text input
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); this.stepPuzzle(-1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); this.stepPuzzle(1); }
    });

    window.addEventListener('pointerup', (e) => {
      if (this.isDragging) {
        this._commitDrag();
        this.isDragging = false;
      }
      this.clearDragHighlights();
      this.draggedIndices = [];

      // Don't clear hints or the toast when the user is just switching tabs —
      // they need the highlights and description while flipping between boards.
      if (e.target.closest('.board-tab')) return;

      this.clearHintUI();
      const isWinToast = document.getElementById('toast').classList.contains('toast-win');
      if (!isWinToast && (!this.toastBirthTime || Date.now() - this.toastBirthTime > 500)) {
        this.hideToast();
      }
    });

    // Book links in the help modal switch books without a page load.
    document.addEventListener('click', (e) => {
      const link = e.target.closest('.book-link');
      if (!link) return;
      const bookId = link.dataset.book;
      if (!bookId) return;
      document.getElementById('help-modal').classList.add('modal-hidden');
      this.selectCategory(bookId);
    });
  }

  // Disables navigation controls and fades the boards while a puzzle fetch is
  // in flight.
  setLoading(isLoading) {
    const ids = ['prev-puz', 'next-puz', 'puzzle-input', 'category-select',
      'hint-btn', 'check-btn', 'reset-btn'];
    ids.forEach(id => document.getElementById(id).disabled = isLoading);
    const boardsWrapper = document.getElementById('boards-wrapper');
    boardsWrapper.style.opacity = isLoading ? '0.4' : '1';
    boardsWrapper.style.pointerEvents = isLoading ? 'none' : '';
  }

  // ────────────────────── 
  // ─── Puzzle Loading ─── 
  // ────────────────────── 

  // Hashes puzzle content to a stable 16-char hex ID for localStorage keying.
  // Using content rather than puzzle name means renamed puzzles don't lose
  // progress.
  async computePuzzleId(puzzleData) {
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
    return hashHex.slice(0, 16); // 16 hex chars = 64 bits, plenty unique
  }

  // Initialises all game state for a new puzzle and re-renders both boards.
  async loadPuzzle(puzzleData, categoryId) {
    this.currentPuzzleUniqueId = await this.computePuzzleId(puzzleData);
    this.currentCategoryId = categoryId;
    this.currentPuzzle = puzzleData;

    this.n = puzzleData.N;
    this.solution = puzzleData.solution;
    this.regions = [puzzleData.board1, puzzleData.board2];

    this.state = new Array(this.n * this.n).fill(CELL.NONE);
    this.history = [JSON.stringify(this.state)];
    this.historyIdx = 0;

    document.getElementById('board1').innerHTML = '';
    document.getElementById('board2').innerHTML = '';
    document.documentElement.style.setProperty('--grid-n', this.n);

    this.renderBoard('board1', this.regions[0]);
    this.renderBoard('board2', this.regions[1]);
    this.updateVisuals();

    this.showToastOnLoad(categoryId, puzzleData.id);
    this.loadProgress({ suppressWinToast: true });
    this.updateControls();
    this.updateUrlParams(categoryId, puzzleData.id);

    this.solver = new PuzzleSolver(this);
  }

  showToastOnLoad(catId, puzId) {
    if (this.isDailyCategory(catId)) {
      const today = new Date().toLocaleDateString(undefined, {
        month: 'long', day: 'numeric'
      });
      const label = this.currentPuzzle?.dailyLabel ?? '';
      const sundayNote = label === 'Expert' ? ' ☀️ Sundays only' : '';
      this.showToast(`Daily ${label} — ${today}${sundayNote}`);
    } else {
      this.showToast(`Playing Puzzle ${puzId}`, "info");
    }
  }

  // Builds the cell grid and SVG region borders for one board.
  renderBoard(id, regionMap) {
    const wrapper = document.getElementById(id);
    const grid    = this._buildGrid();
    const svg     = this._buildRegionSvg(regionMap);

    const axisLabelsOn = localStorage.getItem('setting-axis-labels') === 'true';
    if (axisLabelsOn) {
      wrapper.classList.add('grid-wrapper--labeled');

      // Set the grid template explicitly in JS so we don't depend on
      // var(--grid-n) resolving correctly on this element.
      wrapper.style.gridTemplateColumns = `var(--cell-size) repeat(${this.n}, var(--cell-size))`;
      wrapper.style.gridTemplateRows    = `var(--cell-size) repeat(${this.n}, var(--cell-size))`;

      // Corner spacer: row 1, col 1
      const corner = document.createElement('div');
      corner.className = 'axis-corner';
      corner.style.gridRow    = '1';
      corner.style.gridColumn = '1';
      wrapper.appendChild(corner);

      // Column labels: row 1, cols 2..(n+1) — one per column, explicitly placed
      for (let c = 0; c < this.n; c++) {
        const label = document.createElement('div');
        label.className = 'axis-label axis-label--col';
        label.textContent = String.fromCharCode(65 + c);
        label.setAttribute('aria-hidden', 'true');
        label.style.gridRow    = '1';
        label.style.gridColumn = String(c + 2);
        wrapper.appendChild(label);
      }

      // Row labels: rows 2..(n+1), col 1 — one per row, explicitly placed
      for (let r = 0; r < this.n; r++) {
        const label = document.createElement('div');
        label.className = 'axis-label axis-label--row';
        label.textContent = String(r + 1);
        label.setAttribute('aria-hidden', 'true');
        label.style.gridRow    = String(r + 2);
        label.style.gridColumn = '1';
        wrapper.appendChild(label);
      }

      // Inner wrapper: rows 2..(n+1), col 2 — holds the grid + SVG overlay
      const inner = document.createElement('div');
      inner.className = 'axis-board-inner';
      inner.style.gridRow    = `2 / span ${this.n}`;
      inner.style.gridColumn = '2';
      // Explicit size required so the absolutely-positioned SVG overlay fills
      // the board correctly (100% resolves against this element's dimensions).
      inner.style.width  = `calc(${this.n} * var(--cell-size))`;
      inner.style.height = `calc(${this.n} * var(--cell-size))`;
      inner.appendChild(grid);
      inner.appendChild(svg);
      wrapper.appendChild(inner);
    } else {
      wrapper.classList.remove('grid-wrapper--labeled');
      wrapper.style.gridTemplateColumns = '';
      wrapper.style.gridTemplateRows    = '';
      wrapper.appendChild(grid);
      wrapper.appendChild(svg);
    }
  }

  // Creates the interactive grid div with all pointer event handlers attached.
  _buildGrid() {
    const grid = document.createElement('div');
    grid.className = 'star-battle-grid';
    grid.style.width = 'fit-content';
    grid.style.gridTemplateColumns = `repeat(${this.n}, var(--cell-size))`;
    grid.oncontextmenu = (e) => e.preventDefault();

    for (let i = 0; i < this.n * this.n; i++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.index = i;

      // Desktop-only cross-board hover: highlight the same cell index on both boards.
      // window.matchMedia is checked once at grid-build time; grids are rebuilt per
      // puzzle so this stays current if the user resizes/changes input device.
      if (window.matchMedia('(pointer: fine)').matches) {
        cell.addEventListener('pointerenter', () => {
          if (this.isDragging) return;
          this._setHoverSync(i, true);
        });
        cell.addEventListener('pointerleave', () => {
          this._setHoverSync(i, false);
        });
      }

      grid.appendChild(cell);
    }

    grid.onpointerdown = (e) => {
      const cell = e.target.closest('.cell');
      if (!cell) return;
      e.preventDefault();
      cell.setPointerCapture(e.pointerId);
      const idx = parseInt(cell.dataset.index);
      this.lastDraggedIndex = idx;
      this.handleStart(idx, e.button === 2);
    };

    grid.onpointerover = (e) => {
      const cell = e.target.closest('.cell');
      if (!cell || !this.isDragging) return;
      const idx = parseInt(cell.dataset.index);
      if (idx !== this.lastDraggedIndex) {
        this.lastDraggedIndex = idx;
        this.handleDrag(idx);
      }
    };

    grid.onpointermove = (e) => {
      if (!this.isDragging) return;
      // pointerover doesn't fire on touch during drag, so fall back to elementFromPoint.
      const cell = document.elementFromPoint(e.clientX, e.clientY)?.closest('.cell');
      if (cell) {
        const idx = parseInt(cell.dataset.index);
        if (idx !== this.lastDraggedIndex) {
          this.lastDraggedIndex = idx;
          this.handleDrag(idx);
        }
      }
    };

    return grid;
  }

  // Creates the SVG overlay that draws thick borders between regions.
  _buildRegionSvg(regionMap) {
    const COORD = 100; // virtual units per cell
    const totalCoord = this.n * COORD;
    const STROKE = COORD * 0.07;
    const HALF = STROKE / 2;

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "region-svg");
    svg.setAttribute("viewBox", `${-HALF} ${-HALF} ${totalCoord + STROKE} ${totalCoord + STROKE}`);

    // Walk every cell; draw a border segment wherever the region changes.
    let paths = "";
    for (let i = 0; i < this.n * this.n; i++) {
      const r = Math.floor(i / this.n), c = i % this.n;
      const x2 = (c + 1) * COORD, y2 = (r + 1) * COORD;
      if (c < this.n - 1 && regionMap[i] !== regionMap[i + 1])
        paths += `M ${x2} ${r * COORD} L ${x2} ${y2} `;
      if (r < this.n - 1 && regionMap[i] !== regionMap[i + this.n])
        paths += `M ${c * COORD} ${y2} L ${x2} ${y2} `;
    }

    const borderEl = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    borderEl.setAttribute("x", "0");
    borderEl.setAttribute("y", "0");
    borderEl.setAttribute("width", String(totalCoord));
    borderEl.setAttribute("height", String(totalCoord));
    borderEl.setAttribute("fill", "none");
    borderEl.setAttribute("stroke", "black");
    borderEl.setAttribute("stroke-width", String(STROKE));
    svg.appendChild(borderEl);

    const pathEl = document.createElementNS("http://www.w3.org/2000/svg", "path");
    pathEl.setAttribute("d", paths);
    pathEl.setAttribute("stroke", "black");
    pathEl.setAttribute("stroke-width", String(STROKE));
    pathEl.setAttribute("stroke-linecap", "round");
    pathEl.setAttribute("stroke-linejoin", "round");
    pathEl.setAttribute("fill", "none");
    svg.appendChild(pathEl);

    return svg;
  }

  // ────────────────── 
  // ─── Game State ─── 
  // ────────────────── 

  // Handles the initial pointer-down on a cell. Right-click toggles a star
  // directly; left-click cycles none -> dot -> star -> none and begins a drag
  // session.
  handleStart(idx, isRightClick) {
    const toast = document.getElementById('toast');
    const isWinToast = toast.classList.contains('toast-win') && 
      !toast.classList.contains('toast-hidden');
    if (!isWinToast) this.hideToast();
    this.isDragging = true;

    if (isRightClick) {
      document.querySelectorAll(`.cell[data-index="${idx}"]`).forEach(cell => {
        cell.classList.add('cell-drag-highlight');
      });
      this.applyState(idx, this.state[idx] === CELL.STAR ? CELL.NONE : CELL.STAR);
      this.saveHistory();
      this.isDragging = false;
      setTimeout(() => {
        document.querySelectorAll(`.cell[data-index="${idx}"]`).forEach(cell => {
          cell.classList.remove('cell-drag-highlight');
        });
      }, 80);
    } else {
      this.draggedIndices = [idx];
      document.querySelectorAll(`.cell[data-index="${idx}"]`).forEach(cell => {
        cell.classList.add('cell-drag-highlight');
      });
    }
  }

  // Paints a dot on any empty cell the pointer passes over during a drag.
  handleDrag(idx) {
    if (!this.isDragging || this.draggedIndices.includes(idx)) return;
    this.draggedIndices.push(idx);
    document.querySelectorAll(`.cell[data-index="${idx}"]`).forEach(cell => {
      cell.classList.add('cell-drag-highlight');
    });
  }

  _commitDrag() {
    if (!this.draggedIndices || this.draggedIndices.length === 0) return;

    if (this.draggedIndices.length === 1) {
      const idx = this.draggedIndices[0];
      const current = this.state[idx];
      if (current === CELL.STAR) {
        this.applyState(idx, CELL.NONE);
      } else {
        const next = current === CELL.NONE ? CELL.DOT : CELL.STAR;
        this.applyState(idx, next);
      }
    } else {
      for (const idx of this.draggedIndices) {
        if (this.state[idx] === CELL.NONE) {
          this.applyState(idx, CELL.DOT, { suppressWinToast: true, debounceMs: 0 }); // suppress mid-drag; drag is unambiguous
        }
      }
      // One final validate after all cells are committed, with win toast allowed
      this.validate();
    }

    this.saveHistory();
    this.draggedIndices = [];
  }

  clearDragHighlights() {
    document.querySelectorAll('.cell-drag-highlight').forEach(cell => {
      cell.classList.remove('cell-drag-highlight');
    });
  }

  // Highlights (or un-highlights) the cell at `idx` on every board simultaneously.
  // Only called on pointer:fine (desktop) devices; dragging suppresses it.
  _setHoverSync(idx, on) {
    document.querySelectorAll(`.cell[data-index="${idx}"]`).forEach(cell => {
      cell.classList.toggle('cell-hover-sync', on);
    });
  }

  // Applies a state change to one cell, updates its visual, validates the
  // board, and persists to localStorage.
  applyState(idx, type, { suppressWinToast = false, debounceMs } = {}) {
    if (this.state[idx] === type) return;
    this.state[idx] = type;
    document.querySelectorAll(`.cell[data-index="${idx}"]`).forEach(cell => {
      this.updateCellVisual(cell, type);
    });
    // If the caller didn't specify, infer: dots may be the first click of a
    // double-click so delay errors; stars and removals are unambiguous.
    const delay = debounceMs ?? (type === CELL.DOT ? 200 : 0);

    // Auto-fill: when a star is placed (and not already in a recursive call),
    // dot every empty cell in the same row, col, and region on both boards.
    if (type === CELL.STAR && !this._suppressAutoFill &&
        localStorage.getItem('setting-auto-fill-dots') === 'true') {
      this._suppressAutoFill = true;
      this._autoFillDots(idx);
      this._suppressAutoFill = false;
    }

    this.validate({ suppressWinToast, debounceMs: delay });
    this.saveCurrentState();
  }

  // Dots every CELL.NONE cell that shares a row, column, or region with the
  // star just placed at `idx`. Operates on the shared state (both boards see
  // the same state array), so the fill naturally appears on both boards.
  // Called only while _suppressAutoFill is true, so no recursion occurs.
  _autoFillDots(idx) {
    const n   = this.n;
    const row = Math.floor(idx / n);
    const col = idx % n;

    // Collect the union of cells to dot: entire row, entire col, entire region.
    // The region is defined by `this.regions[0]` — both boards share regions
    // that map to the same logical groups (they may differ visually but the
    // region id at each index is what matters for the rule).
    const regionId = this.regions[0][idx];
    const toFill   = new Set();

    for (let i = 0; i < n * n; i++) {
      const r = Math.floor(i / n), c = i % n;
      if (r === row || c === col || this.regions[0][i] === regionId) {
        toFill.add(i);
      }
    }

    // Also apply the region from board 2 (in case the two boards have
    // different region groupings at this index).
    const regionId2 = this.regions[1][idx];
    for (let i = 0; i < n * n; i++) {
      if (this.regions[1][i] === regionId2) toFill.add(i);
    }

    // Also dot all 8 cells adjacent to the star (orthogonal and diagonal),
    // since stars can never touch each other even diagonally.
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = row + dr, nc = col + dc;
        if (nr >= 0 && nr < n && nc >= 0 && nc < n) {
          toFill.add(nr * n + nc);
        }
      }
    }

    // Dot only empty cells; never overwrite a star (including the one just placed).
    for (const i of toFill) {
      if (this.state[i] === CELL.NONE) {
        this.state[i] = CELL.DOT;
        document.querySelectorAll(`.cell[data-index="${i}"]`).forEach(cell => {
          this.updateCellVisual(cell, CELL.DOT);
        });
      }
    }
  }

  // Returns true if every solution star is placed and no extra stars exist.
  // Empty cells and dots are ignored — the puzzle is solved even with blank
  // squares.
  isSolved() {
    return this.state.every((v, i) => (this.solution[i] === 'x') ? v === CELL.STAR : v !== CELL.STAR);
  }

  // Returns the set of cell indices involved in adjacency violations.
  _getAdjacentErrorIndices() {
    const n = this.n;
    const errors = new Set();
    for (let i = 0; i < n * n; i++) {
      if (this.state[i] !== CELL.STAR) continue;
      const r = Math.floor(i / n), c = i % n;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < n && nc >= 0 && nc < n) {
            const nb = nr * n + nc;
            if (this.state[nb] === CELL.STAR) { errors.add(i); errors.add(nb); }
          }
        }
      }
    }
    return errors;
  }

  // Highlights obvious rule violations in real time.
  // debounceMs controls how long to wait before showing error highlights:
  //   0   — show immediately (star placements, drags — clearly not mid-double-click)
  //   200 — short delay (dot placements — could be the first click of a double-click)
  validate({ suppressWinToast = false, debounceMs = 0 } = {}) {
    const n = this.n;
    const errorIndices = new Set();

    const checkGroup = (indices) => {
      const stars = indices.filter(i => this.state[i] === CELL.STAR);
      const allDots = indices.every(i => this.state[i] === CELL.DOT);
      // Highlight if more than 1 star or if group is impossible (all dots)
      if (stars.length > 1 || allDots) {
        indices.forEach(i => errorIndices.add(i));
      }
    };

    // Check rows and columns
    for (let i = 0; i < n; i++) {
      checkGroup(Array.from({length: n}, (_, k) => i * n + k));
      checkGroup(Array.from({length: n}, (_, k) => k * n + i));
    }

    // Check regions for both boards
    this.regions.forEach(regionString => {
      const regionIds = [...new Set(regionString.split(''))];
      regionIds.forEach(id => {
        const indices = [];
        for (let j = 0; j < regionString.length; j++) {
          if (regionString[j] === id) indices.push(j);
        }
        checkGroup(indices);
      });
    });

    // Check adjacency
    for (const idx of this._getAdjacentErrorIndices()) {
      errorIndices.add(idx);
    }

    // Debounce error highlights — dot placements use a delay to avoid flashing
    // on the first click of a double-click; stars and drags show errors immediately.
    // Clears always run immediately so removing an error feels instant.
    clearTimeout(this._errorHighlightTimer);
    if (errorIndices.size === 0 || debounceMs === 0) {
      this._applyErrorHighlights(errorIndices);
    } else {
      this._errorHighlightTimer = setTimeout(
        () => this._applyErrorHighlights(errorIndices), debounceMs
      );
    }

    // Win check — runs eagerly regardless of the highlight debounce
    if (this.isSolved() && errorIndices.size === 0) {
      this.markAsSolved();
      const toast = document.getElementById('toast');
      const winToastAlreadyVisible = toast.classList.contains('toast-win') &&
        !toast.classList.contains('toast-hidden');
      if (!suppressWinToast && !winToastAlreadyVisible) {
        this.showToast("🏆 Perfect! You've solved the Multiverse Star Battle!", "win", 15000);
      }
    } else {
      // If the board is no longer solved, dismiss the win toast
      const toast = document.getElementById('toast');
      if (toast.classList.contains('toast-win') && !toast.classList.contains('toast-hidden')) {
        this.hideToast();
      }
    }
  }

  _applyErrorHighlights(errorIndices) {
    document.querySelectorAll('.cell').forEach(cell => {
      const idx = parseInt(cell.dataset.index);
      cell.classList.toggle('error-cell', errorIndices.has(idx));
    });
  }

  // ─────────────── 
  // ─── History ─── 
  // ─────────────── 

  // Appends the current state to the undo history, truncating any undone future
  saveHistory() {
    const snap = JSON.stringify(this.state);
    // Deduplicate: skip if state hasn't actually changed since the last snapshot.
    if (snap === this.history[this.historyIdx]) return;

    this.history = this.history.slice(0, this.historyIdx + 1);
    this.history.push(snap);
    this.historyIdx++;
    this.updateControls()
  }

  // Steps back one entry in undo history.
  undo() {
    this.hideToast();
    if (this.historyIdx > 0) {
      this.historyIdx--;
      this.state = JSON.parse(this.history[this.historyIdx]);
      this.updateVisuals();
      this.validate();
      this.updateControls();
      this.saveCurrentState();
    }
  }

  // Steps forward one entry in undo history.
  redo() {
    this.hideToast();
    if (this.historyIdx < this.history.length - 1) {
      this.historyIdx++;
      this.state = JSON.parse(this.history[this.historyIdx]);
      this.updateVisuals();
      this.validate();
      this.updateControls();
      this.saveCurrentState();
    }
  }


  // ─────────────────── 
  // ─── Persistence ─── 
  // ─────────────────── 

  // Stable localStorage key for this puzzle's cell state.
  get stateKey() { return `sb_state_${this.currentPuzzleUniqueId}`; }

  // Shared localStorage key for the set of all solved puzzle IDs.
  get solvedKey() { return 'sb_solved'; }

  // Persists the current cell state to localStorage under the puzzle's unique
  // ID.
  saveCurrentState() {
    localStorage.setItem(this.stateKey, JSON.stringify(this.state));
  }

  // Restores saved cell state from localStorage if it exists, then syncs all UI
  loadProgress({ suppressWinToast = false } = {}) {
    const savedState = localStorage.getItem(this.stateKey);
    if (savedState) {
      this.state = JSON.parse(savedState);
      this.history = [JSON.stringify(this.state)];
      this.historyIdx = 0;
      this.updateVisuals();
      this.validate({ suppressWinToast });
    }
    this.updateControls();
    this.updateSolvedUI();
  }

  // Records this puzzle as solved in localStorage and updates the solved badge.
  markAsSolved() {
    const solved = JSON.parse(localStorage.getItem(this.solvedKey) || '[]');
    if (!solved.includes(this.currentPuzzleUniqueId)) {
      solved.push(this.currentPuzzleUniqueId);
      localStorage.setItem(this.solvedKey, JSON.stringify(solved));
    }
    this._updateSolvedBadge(solved);
  }

  // Shows or hides the ✅ badge based on whether this puzzle is recorded as solved.
  updateSolvedUI() {
    const solved = JSON.parse(localStorage.getItem(this.solvedKey) || '[]');
    this._updateSolvedBadge(solved);
  }

  // Sets the solved badge opacity from an already-fetched solved list.
  _updateSolvedBadge(solved) {
    const badge = document.getElementById('solved-badge');
    badge.style.opacity = solved.includes(this.currentPuzzleUniqueId) ? '1' : '0';
  }

  // ────────────────────── 
  // ─── UI & Rendering ─── 
  // ────────────────────── 

  // Updates a single cell's DOM to reflect its current state value.
  updateCellVisual(cell, val) {
    cell.innerHTML = val === CELL.STAR ? '<span class="star">★</span>'
      : val === CELL.DOT ? '<div class="dot"></div>'
      : '';
  }

  // Re-renders all cells on both boards to match the current state array.
  updateVisuals() {
    document.querySelectorAll('.cell').forEach(cell => {
      this.updateCellVisual(cell, this.state[cell.dataset.index]);
    });
  }

  // Enables or disables undo/redo buttons based on current history position.
  updateControls() {
    const undoBtn = document.getElementById('undo-btn');
    const redoBtn = document.getElementById('redo-btn');
    undoBtn.disabled = (this.historyIdx === 0);
    redoBtn.disabled = (this.historyIdx >= this.history.length - 1);
  }

  // Clears all cell state and resets history after the user confirms reset.
  doReset() {
    this.hideToast();
    this.state.fill(CELL.NONE);
    this.history = [JSON.stringify(this.state)];
    this.historyIdx = 0;
    this.clearHintUI();
    this.updateVisuals();
    this.updateControls();
    this.validate();
    this.saveCurrentState();
  }

  // ──────────────
  // ─── Hints ─── 
  // ──────────────

  // Asks the solver for the next hint and either displays it or shows a
  // fallback toast.
  getHint() {
    const hint = this.solver.getHint();
    if (hint) {
      this.applyHintUI(hint);
    } else {
      this.showToast("No hints found!", "info");
    }
  }

  // Applies highlight and mark classes to cells based on a hint object,
  // and shows the hint description as a toast.
  applyHintUI(hint) {
    const selectors = (hint.boardIdx !== undefined)
      ? [`#board${hint.boardIdx + 1}`]
      : ['#board1', '#board2'];

    // Unified loop — highlights and marks both just add a CSS class to a cell
    for (const { idx, color } of [...hint.highlights, ...hint.marks]) {
      for (const sel of selectors) {
        const cell = document.querySelector(`${sel} [data-index="${idx}"]`);
        if (cell) cell.classList.add(color);
      }
    }

    // In tab mode, switch to the board the hint is about. If the hint is
    // cross-board (boardIdx undefined), stay on whichever board the user
    // is already looking at — they can flip between tabs to see both sides.
    if (document.body.classList.contains('tab-mode') && hint.boardIdx !== undefined) {
      this._showBoard(hint.boardIdx + 1);
    }

    this.showToast(hint.description, "hint", 30000);
  }

  // Removes all hint highlight classes from every cell on both boards.
  clearHintUI() {
    document.querySelectorAll('.cell').forEach(cell => {
      cell.classList.remove('hint-source-blue', 'hint-target-yellow', 'hint-target-green', 'hint-error-red');
    });
  }

  // ─────────────────
  // ─── Feedback ─── 
  // ─────────────────

  // Displays a dismissible notification at the bottom of the screen.
  // Clears any previous toast type before applying the new one.
  showToast(message, type = 'info', duration = 2000) {
    const toast = document.getElementById('toast');
    this.activeToastType = type;
    toast.textContent = message;
    toast.className = '';
    toast.classList.add(`toast-${type}`, 'toast-hidden');
    void toast.offsetHeight;
    toast.classList.remove('toast-hidden');
    this.toastBirthTime = Date.now();

    toast.classList.remove('toast-hidden');
    toast.onclick = () => {
      if (Date.now() - this.toastBirthTime < 500) {
        return;
      }
      toast.classList.add('toast-hidden');
    };
    clearTimeout(this.toastTimeout);
    this.toastTimeout = setTimeout(() => {
      toast.classList.add('toast-hidden');
    }, duration);
  }
  hideToast() {
    this.activeToastType = null;
    document.getElementById('toast').classList.add('toast-hidden');
  }

  // Checks the user's current placements against the solution and shows a toast
  // with the result. Only considers filled cells (dots and stars), not empty
  // ones.
  checkCorrectness() {
    let errorCount = 0;
    let filledCount = 0;

    for (let i = 0; i < this.n * this.n; i++) {
      const userState = this.state[i]; // CELL.NONE, CELL.STAR, or CELL.DOT
      const isSolutionStar = (this.solution[i] === 'x');

      if (userState === CELL.NONE) continue;

      filledCount++;
      if ((userState === CELL.STAR && !isSolutionStar) || (userState === CELL.DOT && isSolutionStar)) {
        errorCount++;
      }
    }

    if (filledCount === 0) {
      this.showToast("The board is empty!", "info");
    } else if (errorCount > 0) {
      const squareText = errorCount === 1 ? "square is" : "squares are";
      this.showToast(`${errorCount} ${squareText} incorrect.`, "error");
    } else if (this.isSolved()) {
      this.showToast("You already solved the puzzle!", "win");
    } else {
      this.showToast("So far so good!", "success");
    }
  }

  // ────────────
  // ─── URL ─── 
  // ────────────

  // Reads ?book= and ?puzzle= from the URL.
  // Returns safe defaults if absent or invalid.
  readUrlParams() {
    const params = new URLSearchParams(window.location.search);
    const catId = params.get('book');
    const puzzleParam = params.get('puzzle');

    // For daily, translate label → slot number; fall back to 1.
    // Expert (slot 4) is only available on Sundays — clamp to 3 otherwise.
    const dailySlotMap = { beginner: 1, medium: 2, hard: 3, expert: 4 };
    let puzNum = (catId === 'daily' && puzzleParam in dailySlotMap)
      ? dailySlotMap[puzzleParam]
      : parseInt(puzzleParam, 10) || 1;

    if (catId === 'daily' && puzNum === 4 && !this.isSunday()) {
      puzNum = 3;
    }

    return { catId, puzNum };
  }

  // Updates the URL bar to reflect the current puzzle without adding a browser
  // history entry.
  updateUrlParams(catId, puzNum) {
    const params = new URLSearchParams();
    params.set('book', catId);
    if (this.isDailyCategory(catId)) {
      const dailyLabels = ['beginner', 'medium', 'hard', 'expert'];
      const slot = parseInt(document.getElementById('puzzle-input').value, 10);
      params.set('puzzle', dailyLabels[slot - 1] ?? 'beginner');
    } else {
      params.set('puzzle', puzNum);
    }
    window.history.replaceState(null, '', `?${params.toString()}`);
  }

  // ──────────────────────
  // ── Book Picker ───────

  // Switches to a new book category without a page load, resetting to puzzle 1.
  selectCategory(catId) {
    const catSelect     = document.getElementById('category-select');
    const currentNameEl = document.getElementById('bpb-current-name');
    catSelect.value = catId;
    catSelect.dispatchEvent(new CustomEvent('change', { detail: { targetPuz: 1 } }));
    const opt = catSelect.querySelector(`option[value="${catId}"]`);
    if (opt) currentNameEl.textContent = opt.textContent;
  }
  // ──────────────────────

  // Sets up the book picker modal: a two-level UI where users first pick a
  // group (e.g. "8x8"), then drill into its individual difficulty categories.
  setupBookPicker() {
    const catSelect     = document.getElementById('category-select');
    const modal         = document.getElementById('book-picker-modal');
    const body          = document.getElementById('bp-modal-body');
    const openBtn       = document.getElementById('book-picker-btn');
    const currentNameEl = document.getElementById('bpb-current-name');

    // All book/group metadata now lives in manifest.json — no hardcoded lookups here.
    const groupMeta = (g) => this.groups[g] ?? { icon: '📖', blurb: '', desc: '' };
    const catDesc   = (id) => this.categories.find(c => c.id === id)?.desc ?? '';

    const getStructuredCategories = () => {
      const groups = [];
      for (const child of catSelect.children) {
        if (child.tagName === 'OPTGROUP') {
          groups.push({
            group: child.label,
            cats: [...child.children].map(o => ({ id: o.value, label: o.textContent })),
          });
        } else if (child.tagName === 'OPTION') {
          let ug = groups.find(g => g.group === '__ungrouped__');
          if (!ug) { ug = { group: '__ungrouped__', cats: [] }; groups.push(ug); }
          ug.cats.push({ id: child.value, label: child.textContent });
        }
      }
      return groups;
    };

    const openModal  = () => { modal.classList.remove('modal-hidden'); renderGroups(); };
    const closeModal = () => modal.classList.add('modal-hidden');

    modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !modal.classList.contains('modal-hidden')) closeModal();
    });
    modal.querySelectorAll('[data-close]').forEach(btn => btn.onclick = closeModal);
    openBtn.onclick = openModal;

    const makeGroupCard = (name, icon, sub, desc, active) => {
      const card = document.createElement('button');
      card.className = 'bp-group-card' + (active ? ' bp-active' : '');
      card.innerHTML = `
        <span class="bp-icon">${icon}</span>
        <span class="bp-group-name">${name}</span>
        ${sub ? `<span class="bp-group-sub">${sub}</span>` : ''}
        ${desc ? `<span class="bp-group-desc">${desc}</span>` : ''}
      `;
      return card;
    };

    const renderGroups = () => {
      const groups = getStructuredCategories();
      const activeCatId = catSelect.value;
      body.innerHTML = '';
      const grid = document.createElement('div');
      grid.className = 'bp-groups';

      groups.forEach(g => {
        const meta = groupMeta(g.group);
        const isActive = g.cats.some(c => c.id === activeCatId);

        if (g.group === '__ungrouped__') {
          g.cats.forEach(cat => {
            if (cat.id === 'tmp') return;
            const card = makeGroupCard(cat.label, meta.icon, '', catDesc(cat.id), cat.id === activeCatId);
            card.onclick = () => selectCategory(cat.id);
            grid.appendChild(card);
          });
          return;
        }

        if (g.cats.length === 1) {
          const card = makeGroupCard(g.group, meta.icon, meta.blurb, catDesc(g.cats[0].id), isActive);
          card.onclick = () => selectCategory(g.cats[0].id);
          grid.appendChild(card);
          return;
        }

        const card = makeGroupCard(g.group, meta.icon, meta.blurb, '', isActive);
        card.onclick = () => renderDrill(g);
        grid.appendChild(card);
      });

      body.appendChild(grid);
    };

    const renderDrill = (group) => {
      const activeCatId = catSelect.value;
      const meta = groupMeta(group.group);
      body.innerHTML = '';

      const back = document.createElement('button');
      back.className = 'bp-back-btn';
      back.textContent = '← All books';
      back.onclick = renderGroups;

      const title = document.createElement('div');
      title.className = 'bp-drill-title';
      title.textContent = group.group;

      const list = document.createElement('div');
      list.className = 'bp-diff-list';

      group.cats.forEach(cat => {
        const btn = document.createElement('button');
        const isSelected = cat.id === activeCatId;
        const desc = catDesc(cat.id);
        btn.className = 'bp-diff-btn' + (isSelected ? ' bp-selected' : '');
        btn.innerHTML = `
          <span class="bp-diff-label">
            <span class="bp-diff-name">${cat.label}</span>
            ${desc ? `<span class="bp-diff-desc">${desc}</span>` : ''}
          </span>
          <span class="bp-diff-arrow">${isSelected ? '✓' : '›'}</span>
        `;
        btn.onclick = () => selectCategory(cat.id);
        list.appendChild(btn);
      });

      body.appendChild(back);
      body.appendChild(title);
      if (meta.desc) {
        const groupDesc = document.createElement('p');
        groupDesc.className = 'bp-group-desc-header';
        groupDesc.textContent = meta.desc;
        body.appendChild(groupDesc);
      }
      body.appendChild(list);
    };

    const selectCategory = (catId) => { closeModal(); this.selectCategory(catId); };

    // Sync button label whenever the select changes (e.g. on initial URL load).
    catSelect.addEventListener('change', () => {
      const opt = catSelect.querySelector(`option[value="${catSelect.value}"]`);
      if (opt) currentNameEl.textContent = opt.textContent;
    });

    // Mirror disabled state from hidden select to the picker button.
    new MutationObserver(() => {
      openBtn.disabled = catSelect.disabled;
    }).observe(catSelect, { attributes: true, attributeFilter: ['disabled'] });

    // Sync button label once options are populated by setupMenu().
    const observer = new MutationObserver(() => {
      if (catSelect.options.length > 0) {
        observer.disconnect();
        const opt = catSelect.querySelector(`option[value="${catSelect.value}"]`);
        if (opt) currentNameEl.textContent = opt.textContent;
      }
    });
    observer.observe(catSelect, { childList: true, subtree: true });
  }
}

new StarBattleGame();
