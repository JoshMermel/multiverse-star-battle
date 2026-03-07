// note to self
//   python3 -m http.server 8000
import { PuzzleSolver } from './solver.js';

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
    const prevBtn = document.getElementById('prev-puz');
    const nextBtn = document.getElementById('next-puz');
    const countLabel = document.getElementById('puzzle-count-label');
    const helpBtn = document.getElementById('help-btn');

    this.lastLoadedSelection = {
        catId: null,
        puzNum: null
    };

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
        this.lastLoadedSelection.catId = catId;
        this.lastLoadedSelection.puzNum = 1;
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

      // Validation & Clamping
      if (isNaN(val)) val = 1;
      if (val < 1) val = 1;
      if (val > max) val = max;
      puzInput.value = val;

      // ignore this if nothing changed. Dunno why this happens.
      if (this.lastLoadedSelection.catId === catId && 
        this.lastLoadedSelection.puzNum === val) {
        return; 
      }
      this.lastLoadedSelection.catId = catId;
      this.lastLoadedSelection.puzNum = val;

      // Load the puzzle
      this.loadPuzzle(this.loadedPuzzles[val - 1], catId);
    };

    const stepPuzzle = (delta) => {
        let val = parseInt(puzInput.value) || 1;
        puzInput.value = val + delta;
        commitPuzzleSelection(); // Reuses your existing validation/load logic
    };
    prevBtn.onpointerdown = (e) => {
      e.preventDefault();
      stepPuzzle(-1);
    };
    nextBtn.onpointerdown = (e) => {
        e.preventDefault();
        stepPuzzle(1);
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
    this.currentPuzzleUniqueId = `${categoryId}_${puzzleData.id}_v2`;
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
    this.solver = new PuzzleSolver(this);
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
        grid.appendChild(cell);
    }

    grid.onpointerdown = (e) => {
        // Find the closest element with class 'cell'
        const cell = e.target.closest('.cell');
        if (!cell) return;

        e.preventDefault();
        cell.setPointerCapture(e.pointerId);
        
        const idx = parseInt(cell.dataset.index);
        this.lastDraggedIndex = idx;
        this.handleStart(idx, e.button === 2);
    };

    grid.onpointerover = (e) => {
        // 'pointerover' is the delegation equivalent of 'pointerenter'
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

        // On touch devices, 'pointerover' doesn't fire during a drag,
        // so we still use elementFromPoint for finger-sliding.
        const target = document.elementFromPoint(e.clientX, e.clientY);
        const cell = target?.closest('.cell');
        
        if (cell) {
            const idx = parseInt(cell.dataset.index);
            if (idx !== this.lastDraggedIndex) {
                this.lastDraggedIndex = idx;
                this.handleDrag(idx);
            }
        }
    };

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
      this.showToast("🏆 Perfect! You've solved the Multiverse Star Battle!", "win", 15000);
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
    this.updateControls()
  }

  undo() { if (this.historyIdx > 0) { this.historyIdx--; this.state = JSON.parse(this.history[this.historyIdx]); this.updateVisuals(); this.validate(); } }
  redo() { if (this.historyIdx < this.history.length - 1) { this.historyIdx++; this.state = JSON.parse(this.history[this.historyIdx]); this.updateVisuals(); this.validate(); } }
  reset() {
    if (confirm("Clear the entire board?")) {
      this.state.fill('none');
      this.history = [JSON.stringify(this.state)];
      this.historyIdx = 0;
      this.clearHintUI();
      this.updateVisuals();
      this.updateControls();
      this.validate();
    }
  }

  showToast(message, type = 'info', duration = 2000) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = '';
    toast.classList.add(`toast-${type}`);
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
    document.getElementById('toast').classList.add('toast-hidden');
  }

  checkCorrectness() {
    let errorCount = 0;
    let filledCount = 0;
    let userStarCount = 0;

    for (let i = 0; i < this.n * this.n; i++) {
      const userState = this.state[i]; // 'none', 'star', or 'dot'
      const isSolutionStar = (this.solution[i] === 'x');

      if (userState === 'none') continue;

      filledCount++;
      if (userState === 'star') userStarCount++;

      const isWrongStar = (userState === 'star' && !isSolutionStar);
      const isWrongDot = (userState === 'dot' && isSolutionStar);

      if (isWrongStar || isWrongDot) {
        errorCount++;
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
    } else if (userStarCount === this.n) {
      this.showToast("You already solved the puzzle!", "win");
    } else {
      this.showToast("So far so good!", "success");
    }
  }

  attachListeners() {
    window.addEventListener('pointerup', () => {
      if (this.isDragging) {
        if (this.hasChangedDuringDrag) {
          this.saveHistory();
        }
        this.isDragging = false;
        this.hasChangedDuringDrag = false;
      }
      this.clearHintUI();
    });
    document.getElementById('undo-btn').onclick = () => {
      this.undo();
      this.updateControls();
    }
    document.getElementById('redo-btn').onclick = () => {
      this.redo();
      this.updateControls();
    }
    document.getElementById('reset-btn').onclick = () => this.reset();
    document.getElementById('check-btn').onclick = () => this.checkCorrectness();
    document.getElementById('hint-btn').onclick = () => this.getHint();
  }
  updateControls() {
    const undoBtn = document.getElementById('undo-btn');
    const redoBtn = document.getElementById('redo-btn');
    undoBtn.disabled = (this.historyIdx === 0);
    redoBtn.disabled = (this.historyIdx >= this.history.length - 1);
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
    const savedState = localStorage.getItem(`sb_state_${this.currentPuzzleUniqueId}`);
    if (savedState) {
        this.state = JSON.parse(savedState);
        this.history = [JSON.stringify(this.state)];
        this.historyIdx = 0;
        this.updateVisuals();
    }

    this.updateControls();
    this.updateSolvedUI();
  }
  updateSolvedUI() {
    const solved = JSON.parse(localStorage.getItem('sb_solved') || '[]');
    const badge = document.getElementById('solved-badge');

    const isSolved = solved.includes(this.currentPuzzleUniqueId);
    badge.style.visibility = isSolved ? 'visible' : 'hidden';
  }

  applyHintUI(hint) {
    // this.clearHintUI();
    const selectors = (hint.boardIdx !== undefined) 
      ? [`#board${hint.boardIdx + 1}`] 
      : ['#board1', '#board2'];

    // Apply Highlights (Blue Star)
    hint.highlights.forEach(h => {
      selectors.forEach(sel => {
        const cell = document.querySelector(`${sel} [data-index="${h.idx}"]`);
        if (cell) cell.classList.add(h.color);
      });
    });

    // Apply Marks (Yellow Outlines)
    hint.marks.forEach(m => {
      selectors.forEach(sel => {
        const cell = document.querySelector(`${sel} [data-index="${m.idx}"]`);
        if (cell) cell.classList.add(m.color); // Use the color defined in the hint object
      });
    });

    // this.showToast(hint.description, "hint", 30000);
    console.log(hint.description);
  }

  clearHintUI() {
    document.querySelectorAll('.cell').forEach(cell => {
      cell.classList.remove('hint-source-blue', 'hint-target-yellow', 'hint-error-red');
    });
  }

  getHint() {
    const hint = this.solver.getHint();
    if (hint) {
      this.applyHintUI(hint);
    } else {
      this.showToast("No hints found!", "info");
    }
  }
}

new StarBattleGame();
