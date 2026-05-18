// input.js
// Mixes input/event-wiring methods into StarBattleGame.prototype.
// Call applyInput(StarBattleGame) once before instantiating the class.
//
// Everything here runs once at startup to attach DOM event listeners.
// Methods read game state and call back into the game instance, but do
// not mutate game state directly.

export function applyInput(GameClass) {
  const p = GameClass.prototype;

  // ── Controls ──────────────────────────────────────────────────────────────

  // Wires up the main game action buttons. Called once after the DOM is ready.
  p.setupControls = function () {
    document.getElementById('undo-btn').onclick = () => this.undo();
    document.getElementById('redo-btn').onclick = () => this.redo();
    document.getElementById('check-btn').onclick = () => this.checkCorrectness();
    document.getElementById('hint-btn').onclick = () => this.getHint();
    this.setupBrowseModal();
    this.setupBookPicker();
    this.setupSettings();
    this.setupAuth();
  };

  p.setupAuth = function () {
    const { storageManager } = this._deps;
    const authBtn = document.getElementById('auth-btn');

    const updateAuthBtn = (user) => {
      authBtn.textContent = user ? 'Sign Out' : 'Sign In';
    };

    storageManager.setCallbacks({
      onAuthChange: updateAuthBtn,
      onCloudDataLoaded: () => {
        this.loadProgress({ suppressWinToast: true });
      }
    });

    authBtn.onclick = () => {
      if (storageManager.user) {
        storageManager.signOut();
      } else {
        storageManager.signIn();
      }
    };
  };

  // ── Modals ────────────────────────────────────────────────────────────────

  // Creates open/close behaviour for a modal: close button(s), backdrop click,
  // Escape key, and an optional confirm action. Returns { open, close } handles.
  p.setupModal = function (modalId, { onConfirm } = {}) {
    const modal = document.getElementById(modalId);
    const close = () => modal.classList.add('modal-hidden');
    const open = () => modal.classList.remove('modal-hidden');

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
  };

  // Sets up open/close behaviour for the instructions modal.
  p.setupHelpModal = function () {
    const { open } = this.setupModal('help-modal');
    document.getElementById('help-btn').onclick = open;
  };

  // Sets up open/close behaviour for the board-clearing confirmation modal.
  p.setupResetModal = function () {
    const { open } = this.setupModal('reset-modal', { onConfirm: () => this.doReset() });
    document.getElementById('reset-btn').onclick = open;
  };

  // ── Settings ──────────────────────────────────────────────────────────────

  p.setupSettings = function () {
    const { open } = this.setupModal('settings-modal');
    document.getElementById('settings-btn').onclick = open;

    const darkToggle = document.getElementById('setting-dark-mode');
    const tabToggle = document.getElementById('setting-tab-mode');
    const axisLabelsToggle = document.getElementById('setting-axis-labels');
    const autoFillDotsToggle = document.getElementById('setting-auto-fill-dots');

    // Restore persisted preferences
    const savedDark = localStorage.getItem('setting-dark-mode') === 'true';
    const savedTab = localStorage.getItem('setting-tab-mode') === 'true';
    const savedAxisLabels = localStorage.getItem('setting-axis-labels') === 'true';
    const savedAutoFillDots = localStorage.getItem('setting-auto-fill-dots') === 'true';

    darkToggle.checked = savedDark;
    tabToggle.checked = savedTab;
    axisLabelsToggle.checked = savedAxisLabels;
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

    // ── Clear saves ──────────────────────────────────────────────────────────
    const clearSavesBtn = document.getElementById('clear-saves-btn');
    let clearSavesConfirmPending = false;
    let clearSavesConfirmTimer = null;

    clearSavesBtn.addEventListener('click', () => {
      if (!clearSavesConfirmPending) {
        // First click: enter confirm state
        clearSavesConfirmPending = true;
        clearSavesBtn.textContent = 'Are you sure?';
        clearSavesBtn.classList.add('danger-btn--confirm');
        // Auto-revert if the user doesn't follow through within 4 seconds
        clearSavesConfirmTimer = setTimeout(() => {
          clearSavesConfirmPending = false;
          clearSavesBtn.textContent = 'Clear saves';
          clearSavesBtn.classList.remove('danger-btn--confirm');
        }, 4000);
      } else {
        // Second click: execute
        clearTimeout(clearSavesConfirmTimer);
        clearSavesConfirmPending = false;
        clearSavesBtn.textContent = 'Clear saves';
        clearSavesBtn.classList.remove('danger-btn--confirm');
        this._clearAllSaveData();
      }
    });
  };

  // ── Global listeners ──────────────────────────────────────────────────────

  // Attaches window-level listeners that persist for the lifetime of the app.
  // Must be called before any puzzle loads.
  p.setupGlobalListeners = function () {
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
  };

  // ── Menu & puzzle navigation ──────────────────────────────────────────────

  p.setupMenu = function () {
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
      if (this.currentCategoryId === catId && this.currentPuzzle?.id === val) return;

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

    prevBtn.onpointerdown = (e) => { e.preventDefault(); this.stepPuzzle(-1); };
    nextBtn.onpointerdown = (e) => { e.preventDefault(); this.stepPuzzle(1); };

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
        puzInput.blur();
      }
    });

    // Also commit if the user clicks out of the box
    puzInput.addEventListener('blur', () => {
      this.commitPuzzleSelection();
    });
  };

  // ── Browse modal ──────────────────────────────────────────────────────────

  p.setupBrowseModal = function () {
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
  };

  // Builds (or rebuilds) the grid of browse tiles, marking solved/current state.
  p._renderBrowseGrid = async function () {
    const { storageManager } = this._deps;
    const grid = document.getElementById('browse-grid');
    grid.innerHTML = '';

    const puzzles = this.loadedPuzzles;
    if (!puzzles?.length) return;

    // Build a Set of hashes for all solved puzzles
    const solvedIds = new Set(storageManager.getSolvedList());

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
      if (puz._cachedId === currentId) tile.classList.add('bt-current');

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
  };

  // Returns the 1-based puzzle number of the first unsolved puzzle, or null if all solved.
  p._findFirstUnsolvedPuzzleNum = function () {
    const { storageManager } = this._deps;
    const solvedIds = new Set(storageManager.getSolvedList());
    const idx = this.loadedPuzzles.findIndex(puz => !solvedIds.has(puz._cachedId));
    return idx === -1 ? null : idx + 1;
  };

  // ── Book picker ───────────────────────────────────────────────────────────

  // Switches to a new book category without a page load, resetting to puzzle 1.
  p.selectCategory = function (catId) {
    const catSelect = document.getElementById('category-select');
    const currentNameEl = document.getElementById('bpb-current-name');
    catSelect.value = catId;
    catSelect.dispatchEvent(new CustomEvent('change', { detail: { targetPuz: 1 } }));
    const opt = catSelect.querySelector(`option[value="${catId}"]`);
    if (opt) currentNameEl.textContent = opt.textContent;
  };

  // Sets up the book picker modal: a two-level UI where users first pick a
  // group (e.g. "8x8"), then drill into its individual difficulty categories.
  p.setupBookPicker = function () {
    const catSelect = document.getElementById('category-select');
    const modal = document.getElementById('book-picker-modal');
    const body = document.getElementById('bp-modal-body');
    const openBtn = document.getElementById('book-picker-btn');
    const currentNameEl = document.getElementById('bpb-current-name');

    // All book/group metadata now lives in manifest.json — no hardcoded lookups here.
    const groupMeta = (g) => this.groups[g] ?? { icon: '📖', blurb: '', desc: '' };
    const catDesc = (id) => this.categories.find(c => c.id === id)?.desc ?? '';

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

    const openModal = () => { modal.classList.remove('modal-hidden'); renderGroups(); };
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
  };
}
