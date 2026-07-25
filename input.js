// Mixin for binding DOM input events and setting up UI controls.

export function applyInput(GameClass) {
  const p = GameClass.prototype;

  // --- Controls ---

  // Set up event handlers for control buttons.
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

  // --- Modals ---

  // Set up open/close behavior for a modal and return control handles.
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

  // Set up help modal behavior.
  p.setupHelpModal = function () {
    const { open } = this.setupModal('help-modal');
    document.getElementById('help-btn').onclick = open;

    // Auto-open the help modal the very first time a user visits, then
    // remember that they've seen it so it won't pop up again.
    if (!localStorage.getItem('has-seen-help-modal')) {
      localStorage.setItem('has-seen-help-modal', 'true');
      open();
    }
  };

  // Set up reset confirmation modal.
  p.setupResetModal = function () {
    const { open } = this.setupModal('reset-modal', { onConfirm: () => this.doReset() });
    document.getElementById('reset-btn').onclick = open;
  };

  // --- Settings ---

  p.setupSettings = function () {
    const { open } = this.setupModal('settings-modal');
    document.getElementById('settings-btn').onclick = open;

    const darkToggle = document.getElementById('setting-dark-mode');
    const tabToggle = document.getElementById('setting-tab-mode');
    const axisLabelsToggle = document.getElementById('setting-axis-labels');
    const autoFillDotsToggle = document.getElementById('setting-auto-fill-dots');
    const showTimerToggle = document.getElementById('setting-show-timer');

    // Restore saved preferences.
    const savedDark = localStorage.getItem('setting-dark-mode') === 'true';
    const savedTab = localStorage.getItem('setting-tab-mode') === 'true';
    const savedAxisLabels = localStorage.getItem('setting-axis-labels') === 'true';
    const savedAutoFillDots = localStorage.getItem('setting-auto-fill-dots') === 'true';
    const savedShowTimer = localStorage.getItem('setting-show-timer') === 'true';

    darkToggle.checked = savedDark;
    tabToggle.checked = savedTab;
    axisLabelsToggle.checked = savedAxisLabels;
    autoFillDotsToggle.checked = savedAutoFillDots;
    showTimerToggle.checked = savedShowTimer;
    this._applyDarkMode(savedDark);
    this._applyShowTimer(savedShowTimer);
    // Note: Tab mode and axis labels both depend on board containers that
    // don't exist yet at settings-setup time, so they're applied during
    // puzzle load instead (see loadPuzzle / renderBoard).

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
      // Re-render boards to apply/remove labels.
      if (this.currentPuzzle && this.regions) {
        this.regions.forEach((regionString, idx) => {
          const boardEl = document.getElementById(`board${idx + 1}`);
          if (boardEl) {
            boardEl.innerHTML = '';
            this.renderBoard(`board${idx + 1}`, regionString);
          }
        });
        this.updateVisuals();
      }
    });

    autoFillDotsToggle.addEventListener('change', () => {
      localStorage.setItem('setting-auto-fill-dots', autoFillDotsToggle.checked);
    });

    showTimerToggle.addEventListener('change', () => {
      localStorage.setItem('setting-show-timer', showTimerToggle.checked);
      this._applyShowTimer(showTimerToggle.checked);
    });

    // --- Clear Saves ---
    const clearSavesBtn = document.getElementById('clear-saves-btn');
    let clearSavesConfirmPending = false;
    let clearSavesConfirmTimer = null;

    clearSavesBtn.addEventListener('click', () => {
      if (!clearSavesConfirmPending) {
        // Enter confirmation state on first click.
        clearSavesConfirmPending = true;
        clearSavesBtn.textContent = 'Are you sure?';
        clearSavesBtn.classList.add('danger-btn--confirm');
        // Auto-revert confirmation after 4 seconds.
        clearSavesConfirmTimer = setTimeout(() => {
          clearSavesConfirmPending = false;
          clearSavesBtn.textContent = 'Clear saves';
          clearSavesBtn.classList.remove('danger-btn--confirm');
        }, 4000);
      } else {
        // Execute clear operation on second click.
        clearTimeout(clearSavesConfirmTimer);
        clearSavesConfirmPending = false;
        clearSavesBtn.textContent = 'Clear saves';
        clearSavesBtn.classList.remove('danger-btn--confirm');
        this._clearAllSaveData();
      }
    });
  };

  // --- Global Event Listeners ---

  // Attach global key and click event listeners.
  p.setupGlobalListeners = function () {
    window.addEventListener('keydown', (e) => {
      // Navigate puzzles with arrow keys unless focused on inputs.
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

      // Keep hints visible when switching board tabs.
      if (e.target.closest('.board-tab')) return;

      this.clearHintUI();
      const isWinToast = document.getElementById('toast').classList.contains('toast-win');
      if (!isWinToast && (!this.toastBirthTime || Date.now() - this.toastBirthTime > 500)) {
        this.hideToast();
      }
    });

    // Abort any in-progress drag when the pointer is cancelled by the browser
    // (e.g. an incoming call or system gesture interrupts the touch stream).
    window.addEventListener('pointercancel', () => this._abortDrag());

    // Abort any in-progress drag when the user app-switches away. The page
    // becomes hidden before the pointer stream ends, so pointerup never fires.
    // Also pause the solve timer here — backgrounding the tab shouldn't count
    // as active solve time — and persist the elapsed progress, since this is
    // a common way a session ends without ever switching puzzles. When the
    // tab regains focus, resume the timer from where it left off.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this._abortDrag();
        this._pauseTimerForBackground();
      } else if (document.visibilityState === 'visible') {
        this._resumeTimerFromBackground();
      }
    });

    // Fallback for closing/navigating away from the tab entirely — more
    // reliable than visibilitychange on some mobile browsers.
    window.addEventListener('pagehide', () => this._persistTimerProgress());

    // Allow book links inside modal text to switch categories.
    document.addEventListener('click', (e) => {
      const link = e.target.closest('.book-link');
      if (!link) return;
      const bookId = link.dataset.book;
      if (!bookId) return;
      document.getElementById('help-modal').classList.add('modal-hidden');
      this.selectCategory(bookId);
    });
  };

  // --- Navigation & Menu Setup ---

  // Silently discard an in-progress drag without committing any cell changes.
  // Called when the pointer stream is interrupted (app-switch, incoming call,
  // system gesture) so that stale drag highlights don't persist on return.
  p._abortDrag = function () {
    if (!this.isDragging && (!this.draggedIndices || this.draggedIndices.length === 0)) return;
    this.isDragging = false;
    this.draggedIndices = [];
    this.clearDragHighlights();
  };

  p.setupMenu = function () {
    const catSelect = document.getElementById('category-select');
    const puzInput = document.getElementById('puzzle-input');
    const prevBtn = document.getElementById('prev-puz');
    const nextBtn = document.getElementById('next-puz');

    // Populate categories select dropdown with optional grouping.
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
      // Stay in custom CSV category if active.
      const catId = (this.currentCategoryId && !catSelect.querySelector(`option[value="${this.currentCategoryId}"]`))
        ? this.currentCategoryId
        : catSelect.value;
      if (isNaN(val)) val = 1;

      // Skip if puzzle is already active.
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
      // Commit spinner inputs immediately; wait for explicit actions when typing.
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

    // Commit selection on blur.
    puzInput.addEventListener('blur', () => {
      this.commitPuzzleSelection();
    });
  };

  // --- Browse Modal ---

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

  // Render list of puzzles in the browse modal grid.
  p._renderBrowseGrid = async function () {
    const { storageManager } = this._deps;
    const grid = document.getElementById('browse-grid');
    grid.innerHTML = '';

    const puzzles = this.loadedPuzzles;
    if (!puzzles?.length) return;

    // Identify solved puzzles.
    const solvedIds = new Set(storageManager.getSolvedList());

    // Cache puzzle IDs.
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

    // Scroll active puzzle tile into view.
    const currentTile = grid.querySelector('.bt-current');
    if (currentTile) currentTile.scrollIntoView({ block: 'nearest' });
  };

  // Find the first unsolved puzzle index in the active book.
  p._findFirstUnsolvedPuzzleNum = function () {
    const { storageManager } = this._deps;
    const solvedIds = new Set(storageManager.getSolvedList());
    const idx = this.loadedPuzzles.findIndex(puz => !solvedIds.has(puz._cachedId));
    return idx === -1 ? null : idx + 1;
  };

  // --- Book Picker ---

  // Select a category and load its first puzzle.
  p.selectCategory = function (catId) {
    const catSelect = document.getElementById('category-select');
    const currentNameEl = document.getElementById('bpb-current-name');
    catSelect.value = catId;
    const targetPuz = this._getRememberedPuzzleNum(catId);
    catSelect.dispatchEvent(new CustomEvent('change', { detail: { targetPuz } }));
    const opt = catSelect.querySelector(`option[value="${catId}"]`);
    if (opt) currentNameEl.textContent = opt.textContent;
  };

  // Set up the book picker modal with grouped categories.
  p.setupBookPicker = function () {
    const catSelect = document.getElementById('category-select');
    const modal = document.getElementById('book-picker-modal');
    const body = document.getElementById('bp-modal-body');
    const openBtn = document.getElementById('book-picker-btn');
    const currentNameEl = document.getElementById('bpb-current-name');

    // Metadata is loaded from the manifest.
    const groupMeta = (g) => this.groups[g] ?? { icon: '📖', blurb: '', desc: '' };
    const catObj = (id) => this.categories.find(c => c.id === id);
    const catDesc = (id) => catObj(id)?.desc ?? '';
    const catStars = (id) => catObj(id)?.stars ?? 1;

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

    const makeGroupCard = (name, icon, sub, desc, active, starsBadgeText) => {
      const card = document.createElement('button');
      card.className = 'bp-group-card' + (active ? ' bp-active' : '');
      const starsBadgeHtml = starsBadgeText ? `<span class="bp-card-stars-badge">${starsBadgeText}</span>` : '';
      card.innerHTML = `
        ${starsBadgeHtml}
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
            const numStars = catStars(cat.id);
            const card = makeGroupCard(cat.label, meta.icon, '', catDesc(cat.id), cat.id === activeCatId, '★'.repeat(numStars));
            card.onclick = () => selectCategory(cat.id);
            grid.appendChild(card);
          });
          return;
        }

        if (g.cats.length === 1) {
          const numStars = catStars(g.cats[0].id);
          const card = makeGroupCard(g.group, meta.icon, meta.blurb, catDesc(g.cats[0].id), isActive, '★'.repeat(numStars));
          card.onclick = () => selectCategory(g.cats[0].id);
          grid.appendChild(card);
          return;
        }

        // Collect all distinct star counts in this group
        const starCounts = [...new Set(g.cats.map(c => catStars(c.id)))].sort((a, b) => a - b);
        const badgeText = starCounts.map(s => '★'.repeat(s)).join(' / ');

        const card = makeGroupCard(g.group, meta.icon, meta.blurb, '', isActive, badgeText);
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
        const stars = catStars(cat.id);
        btn.className = 'bp-diff-btn' + (isSelected ? ' bp-selected' : '');
        btn.innerHTML = `
          <span class="bp-diff-label">
            <span class="bp-diff-name">${cat.label} <span class="bp-diff-stars-badge">${'★'.repeat(stars)}</span></span>
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

    // Update button label on select changes.
    catSelect.addEventListener('change', () => {
      const opt = catSelect.querySelector(`option[value="${catSelect.value}"]`);
      if (opt) currentNameEl.textContent = opt.textContent;
    });

    // Synchronize disabled state with underlying select.
    new MutationObserver(() => {
      openBtn.disabled = catSelect.disabled;
    }).observe(catSelect, { attributes: true, attributeFilter: ['disabled'] });

    // Update button label when options are ready.
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
