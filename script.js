class StarBattleGame {
  constructor() {
    this.categories = []; // From manifest
    this.loadedPuzzles = []; // Current category puzzles
    this.initGame();
  }

  async initGame() {
    try {
      const resp = await fetch('data/manifest.json');
      const data = await resp.json();
      this.categories = data.categories;

      this.setupMenu();

      const catSelect = document.getElementById('category-select');
      if (this.categories.length > 0) {
        catSelect.value = this.categories[0].id;
        // Manually trigger the change event to load the puzzles
        catSelect.dispatchEvent(new Event('change'));
      }
    } catch (e) {
      this.showToast("Failed to load game data", "error");
    }
  }

  setupMenu() {
    const catSelect = document.getElementById('category-select');
    const puzInput = document.getElementById('puzzle-input');
    const countLabel = document.getElementById('puzzle-count-label');
    const helpBtn = document.getElementById('help-btn');

    // Populate Categories
    this.categories.forEach(cat => {
      const opt = document.createElement('option');
      opt.value = cat.id;
      opt.textContent = cat.label;
      catSelect.appendChild(opt);
    });

    catSelect.onchange = async (e) => {
      const catId = e.target.value;
      if (!catId) return;

      try {
        const resp = await fetch(`data/${catId}.json`);
        this.loadedPuzzles = await resp.json();

        // Update the UI range
        const total = this.loadedPuzzles.length;
        puzInput.max = total;
        countLabel.textContent = `of ${total}`;

        // Auto-load the first one on category change
        puzInput.value = 1;
        this.loadPuzzle(this.loadedPuzzles[0], catId);
      } catch (err) {
        this.showToast("Could not load category", "error");
        console.log(err);
      }
    };

    const commitPuzzleSelection = () => {
      let val = parseInt(puzInput.value);
      const max = this.loadedPuzzles.length;
      const catId = catSelect.value;

      // 1. Validation & Clamping
      if (isNaN(val)) val = 1;
      if (val < 1) val = 1;
      if (val > max) val = max;

      // 2. Sync the UI value
      puzInput.value = val;

      // 3. Load the puzzle
      this.loadPuzzle(this.loadedPuzzles[val - 1], catId);
    };

    puzInput.addEventListener('input', (e) => {
        // 'inputType' is null or 'insertReplacementText' when arrows are clicked
        // If the user is typing, we wait for Enter.
        // If they click the arrows, it triggers immediately.
        if (e.inputType === undefined || e.inputType === 'insertReplacementText') {
            commitPuzzleSelection();
        }
    });

    puzInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault(); // Stop form submission if inside a form
        commitPuzzleSelection();
        puzInput.blur(); // Optional: remove focus after selection
      }
    });

    // Optional: Also commit if the user clicks out of the box
    puzInput.addEventListener('blur', () => {
        commitPuzzleSelection();
    });

    helpBtn.onclick = () => {
      const instructions = `
STAR BATTLE RULES:
1. Place stars in cells so that each row, column, and bolded region contains exactly one star.
2. Stars cannot touch each other, even diagonally.
3. Use 'Dots' to mark cells where stars cannot possibly go.
    `;

      alert(instructions);
    };
  }

  loadPuzzle(puzzleData, categoryId) {
    // Save the reference to the current puzzle data
    this.currentPuzzleUniqueId = `${categoryId}_${puzzleData.id}`;
    this.currentPuzzle = puzzleData;

    // Map data to game properties
    this.n = puzzleData.N;
    this.solution = puzzleData.solution;
    this.regions = [puzzleData.board1, puzzleData.board2];

    // Reset game state for a fresh start
    this.state = new Array(this.n * this.n).fill('none');
    this.history = [JSON.stringify(this.state)];
    this.historyIdx = 0;

    // Wipe the HTML clean before re-rendering
    document.getElementById('board1').innerHTML = '';
    document.getElementById('board2').innerHTML = '';

    // Re-run the board creation logic
    this.init();
    this.showToast(`Playing Puzzle ${puzzleData.id}`, "info");
    this.loadProgress();
  }

  init() {
    this.renderBoard('board1', this.regions[0], 0);
    this.renderBoard('board2', this.regions[1], 1);
    this.attachListeners();
    this.updateVisuals();
  }

  renderBoard(id, regionMap, boardIdx) {
    const wrapper = document.getElementById(id);
    document.documentElement.style.setProperty('--grid-n', this.n);

    // Get the actual pixel size for SVG math
    const measure = document.createElement('div');
    measure.style.width = 'var(--cell-size)';
    measure.style.position = 'absolute';
    document.body.appendChild(measure);
    const cellSize = measure.getBoundingClientRect().width;
    document.body.removeChild(measure);

    const totalSize = this.n * cellSize;

    const grid = document.createElement('div');
    grid.className = 'star-battle-grid';
    grid.style.width = 'fit-content';
    // Use the variable directly in the style for perfect sync
    grid.style.gridTemplateColumns = `repeat(${this.n}, var(--cell-size))`;

    // Prevent default right-click menu on the board
    grid.oncontextmenu = (e) => e.preventDefault();

    for (let i = 0; i < this.n * this.n; i++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.index = i;

      // MOUSE HANDLERS
      cell.onmousedown = (e) => {
        e.preventDefault();
        this.handleStart(i, e.button === 2);
      };
      cell.onmouseenter = () => {
        if (this.isDragging) this.handleDrag(i);
      };
      grid.appendChild(cell);
    }

    // TOUCH HANDLERS
    grid.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const touch = e.touches[0];
      const target = document.elementFromPoint(touch.clientX, touch.clientY);
      if (target && target.classList.contains('cell')) {
        this.handleStart(parseInt(target.dataset.index), false);
      }
    }, { passive: false });

    grid.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const touch = e.touches[0];
      const target = document.elementFromPoint(touch.clientX, touch.clientY);
      if (target && target.classList.contains('cell')) {
        this.handleDrag(parseInt(target.dataset.index));
      }
    }, { passive: false });

    grid.addEventListener('touchend', (e) => {
      this.handleEnd();
    }, { passive: false });

    wrapper.appendChild(grid);

    // SVG Borders logic
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "region-svg");
    svg.setAttribute("width", totalSize);
    svg.setAttribute("height", totalSize);
    let paths = "";
    for (let i = 0; i < this.n * this.n; i++) {
      const r = Math.floor(i / this.n), c = i % this.n;
      const x2 = (c + 1) * cellSize, y2 = (r + 1) * cellSize;
      if (c < this.n - 1 && regionMap[i] !== regionMap[i+1]) paths += `M ${x2} ${r*cellSize} L ${x2} ${y2} `;
      if (r < this.n - 1 && regionMap[i] !== regionMap[i+this.n]) paths += `M ${c*cellSize} ${y2} L ${x2} ${y2} `;
    }
    const pathEl = document.createElementNS("http://www.w3.org/2000/svg", "path");
    pathEl.setAttribute("d", paths);
    pathEl.setAttribute("stroke", "black");
    pathEl.setAttribute("stroke-width", "3");
    pathEl.setAttribute("stroke-linecap", "round");
    pathEl.setAttribute("stroke-linejoin", "round");
    pathEl.setAttribute("fill", "none");
    svg.appendChild(pathEl);
    wrapper.appendChild(svg);
  }

  handleStart(idx, isRightClick) {
    this.hideToast();
    this.isDragging = true;
    this.hasChangedDuringDrag = true;

    if (isRightClick) {
      this.applyState(idx, this.state[idx] === 'star' ? 'none' : 'star');
      this.saveHistory(); // Immediate commit for right click
      this.isDragging = false; // Don't drag-paint after a right-click
    } else {
      const current = this.state[idx];
      const next = current === 'none' ? 'dot' : (current === 'dot' ? 'star' : 'none');
      this.applyState(idx, next);
    }
  }

  handleDrag(idx) {
    if (this.isDragging && this.state[idx] === 'none') {
      this.applyState(idx, 'dot');
      this.hasChangedDuringDrag = true;
    }
  }

  handleEnd() {
    if (this.isDragging) {
      if (this.hasChangedDuringDrag) {
        this.saveHistory();
      }
      this.isDragging = false;
      this.hasChangedDuringDrag = false;
    }
  }

  applyState(idx, type) {
    if (this.state[idx] === type) return;
    this.state[idx] = type;
    this.updateVisuals();
    this.validate();
    this.saveCurrentState();
  }

  validate() {
    const n = this.n;
    const errorIndices = new Set();

    const checkGroup = (indices) => {
      const stars = indices.filter(i => this.state[i] === 'star');
      const allDots = indices.every(i => this.state[i] === 'dot');

      // Highlight if more than 1 star or if group is impossible (all dots)
      if (stars.length > 1 || allDots) {
        indices.forEach(i => errorIndices.add(i));
      }
    };

    // Check Rows & Columns
    for (let i = 0; i < n; i++) {
      checkGroup(Array.from({length: n}, (_, k) => i * n + k)); // Row
      checkGroup(Array.from({length: n}, (_, k) => k * n + i)); // Col
    }

    // Check Regions (for both boards)
    this.regions.forEach(regionString => {
      const regionIds = [...new Set(regionString.split(''))];
      regionIds.forEach(id => {
        const indices = [];
        for(let j=0; j<regionString.length; j++) if(regionString[j] === id) indices.push(j);
        checkGroup(indices);
      });
    });

    // Check Star Adjacency (8-way)
    for (let i = 0; i < n * n; i++) {
      if (this.state[i] === 'star') {
        const r = Math.floor(i / n);
        const c = i % n;

        // Look at all 8 neighbors
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue; // Skip self

            const nr = r + dr;
            const nc = c + dc;

            if (nr >= 0 && nr < n && nc >= 0 && nc < n) {
              const neighborIdx = nr * n + nc;
              if (this.state[neighborIdx] === 'star') {
                errorIndices.add(i);
                errorIndices.add(neighborIdx);
              }
            }
          }
        }
      }
    }

    // 5. Update DOM
    document.querySelectorAll('.cell').forEach(cell => {
      const idx = parseInt(cell.dataset.index);
      if (errorIndices.has(idx)) {
        cell.classList.add('error-cell');
      } else {
        cell.classList.remove('error-cell');
      }
    });

    // 6. Win Check
    const isWin = this.state.every((v, i) => (this.solution[i] === 'x') ? v === 'star' : v !== 'star');
    if (isWin && errorIndices.size === 0) {
      this.showToast("🏆 Perfect! You've solved the Star Battle!", "win");
      this.markAsSolved();
    }
  }

  updateVisuals() {
    const cells = document.querySelectorAll('.cell');
    cells.forEach(cell => {
      const val = this.state[cell.dataset.index];
      cell.innerHTML = val === 'star' ? '<span class="star">★</span>' : (val === 'dot' ? '<div class="dot"></div>' : '');
    });
  }

  saveHistory() {
    const snap = JSON.stringify(this.state);
    // Safety check: don't save if it's identical to the last point in history
    if (snap === this.history[this.historyIdx]) return;

    this.history = this.history.slice(0, this.historyIdx + 1);
    this.history.push(snap);
    this.historyIdx++;
  }

  undo() { if (this.historyIdx > 0) { this.historyIdx--; this.state = JSON.parse(this.history[this.historyIdx]); this.updateVisuals(); this.validate(); } }
  redo() { if (this.historyIdx < this.history.length - 1) { this.historyIdx++; this.state = JSON.parse(this.history[this.historyIdx]); this.updateVisuals(); this.validate(); } }
  reset() { if (confirm("Clear the entire board?")) { this.state.fill('none'); this.saveHistory(); this.updateVisuals(); this.validate(); } }

  showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = '';
    toast.classList.add(`toast-${type}`);
    toast.classList.remove('toast-hidden');
    toast.onclick = () => {
      toast.classList.add('toast-hidden');
    };
    this.toastTimeout = setTimeout(() => {
      toast.classList.add('toast-hidden');
    }, 2000);
  }
  hideToast() {
    document.getElementById('toast').classList.add('toast-hidden');
  }

  checkCorrectness() {
    let errorCount = 0;
    let filledCount = 0;

    for (let i = 0; i < this.n * this.n; i++) {
      const userState = this.state[i];
      const isSolutionStar = (this.solution[i] === 'x');

      if (userState === 'none') continue;

      filledCount++;

      const isWrongStar = (userState === 'star' && !isSolutionStar);
      const isWrongDot = (userState === 'dot' && isSolutionStar);

      if (isWrongStar || isWrongDot) {
        errorCount++;

        // Visual feedback (optional blink)
        const cell = document.querySelector(`[data-index="${i}"]`);
        cell.classList.add('error-blink');
        setTimeout(() => cell.classList.remove('error-blink'), 1500);
      }
    }

    if (filledCount === 0) {
      this.showToast("The board is empty!", "info");
    } else if (errorCount > 0) {
      const squareText = errorCount === 1 ? "square is" : "squares are";
      this.showToast(`${errorCount} ${squareText} incorrect.`, "error");
    } else {
      this.showToast("So far so good", "success");
    }
  }
  attachListeners() {
    window.onmouseup = () => {
      if (this.isDragging) {
        if (this.hasChangedDuringDrag) {
          this.saveHistory();
        }
        this.isDragging = false;
        this.hasChangedDuringDrag = false;
      }
    };
    document.getElementById('undo-btn').onclick = () => this.undo();
    document.getElementById('redo-btn').onclick = () => this.redo();
    document.getElementById('reset-btn').onclick = () => this.reset();
    document.getElementById('check-btn').onclick = () => this.checkCorrectness();
  }

  saveCurrentState() {
      const key = `sb_state_${this.currentPuzzleUniqueId}`;
      localStorage.setItem(key, JSON.stringify(this.state));
  }
  markAsSolved() {
      const solved = JSON.parse(localStorage.getItem('sb_solved') || '[]');
      if (!solved.includes(this.currentPuzzleUniqueId)) {
          solved.push(this.currentPuzzleUniqueId);
          localStorage.setItem('sb_solved', JSON.stringify(solved));
      }
      this.updateSolvedUI();
  }
  loadProgress() {
      // 1. Load the board state if it exists
      const savedState = localStorage.getItem(`sb_state_${this.currentPuzzleUniqueId}`);
      if (savedState) {
          this.state = JSON.parse(savedState);
          this.updateVisuals();
      }

      // 2. Check if this puzzle was already solved to show a checkmark
      this.updateSolvedUI();
  }
  updateSolvedUI() {
    const solved = JSON.parse(localStorage.getItem('sb_solved') || '[]');
    const badge = document.getElementById('solved-badge');

    const isSolved = solved.includes(this.currentPuzzleUniqueId);
    badge.style.visibility = isSolved ? 'visible' : 'hidden';
  }
}

new StarBattleGame();
