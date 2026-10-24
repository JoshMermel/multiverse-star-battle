// Mixin for the "Print puzzles" modal: pick a range or list of puzzles from
// the current book, and download a printable PDF booklet of them followed by
// an answer key. The layout and PDF drawing live in print-booklet.js /
// pdf-writer.js, which are imported on demand -- most visits never print,
// so they don't load with the game.

const PAPER_KEY = 'print-paper';
const PER_PAGE_KEY = 'print-per-page';
const ANSWER_KEY_KEY = 'print-answer-key';
const AXIS_LABELS_KEY = 'print-axis-labels';

// Letter in North America, A4 nearly everywhere else.
function defaultPaper() {
  const region = (navigator.language || '').split('-')[1]?.toUpperCase();
  return !region || ['US', 'CA', 'MX'].includes(region) ? 'letter' : 'a4';
}

export function applyPrint(GameClass) {
  const p = GameClass.prototype;

  p.setupPrintModal = function () {
    const modal = document.getElementById('print-modal');
    if (!modal) return;
    const { open, close } = this.setupModal('print-modal');

    const selectionInput = document.getElementById('print-selection');
    const errorEl = document.getElementById('print-selection-error');
    const summaryEl = document.getElementById('print-summary');
    const downloadBtn = document.getElementById('print-download-btn');
    const perPageSelect = document.getElementById('print-per-page');
    const keyToggle = document.getElementById('print-answer-key');
    const labelsToggle = document.getElementById('print-axis-labels');
    const paperButtons = [...document.querySelectorAll('#print-paper button')];

    let paper = localStorage.getItem(PAPER_KEY);
    if (paper !== 'letter' && paper !== 'a4') paper = defaultPaper();
    const setPaper = (value) => {
      paper = value;
      localStorage.setItem(PAPER_KEY, value);
      paperButtons.forEach(btn => btn.setAttribute('aria-checked', String(btn.dataset.value === value)));
    };
    setPaper(paper);
    paperButtons.forEach(btn => btn.addEventListener('click', () => { setPaper(btn.dataset.value); refresh(); }));

    const savedPerPage = localStorage.getItem(PER_PAGE_KEY);
    if ([...perPageSelect.options].some(o => o.value === savedPerPage)) perPageSelect.value = savedPerPage;
    perPageSelect.addEventListener('change', () => {
      localStorage.setItem(PER_PAGE_KEY, perPageSelect.value);
      refresh();
    });

    keyToggle.checked = localStorage.getItem(ANSWER_KEY_KEY) !== 'false';
    keyToggle.addEventListener('change', () => {
      localStorage.setItem(ANSWER_KEY_KEY, keyToggle.checked);
      refresh();
    });

    labelsToggle.checked = localStorage.getItem(AXIS_LABELS_KEY) === 'true';
    labelsToggle.addEventListener('change', () => {
      localStorage.setItem(AXIS_LABELS_KEY, labelsToggle.checked);
      refresh();
    });

    const perPageChoice = () =>
      perPageSelect.value === 'auto' ? 'auto' : parseInt(perPageSelect.value, 10);

    // What the form currently describes: the selected puzzles, or an error.
    const readForm = async () => {
      const booklet = await import('./print-booklet.js');
      const parsed = booklet.parsePuzzleSelection(selectionInput.value, this.loadedPuzzles.length);
      return { booklet, ...parsed };
    };

    // A puzzle as the booklet builder wants it. The daily set has no book
    // numbering to speak of, so its puzzles are titled by tier instead.
    const toBookletPuzzle = (puzzle) => ({
      number: puzzle.id,
      N: puzzle.N,
      boards: puzzle.boards,
      solution: puzzle.solution,
      ...(puzzle.dailyLabel && { title: `Daily ${puzzle.dailyLabel}`, keyTitle: puzzle.dailyLabel }),
    });

    const pageWord = (n) => `${n} page${n === 1 ? '' : 's'}`;

    // Keep the error line, summary and Download button in step with the form.
    let refreshToken = 0;
    const refresh = async () => {
      const token = ++refreshToken;
      const { booklet, ids, error } = await readForm();
      if (token !== refreshToken) return; // a newer edit superseded this one
      errorEl.hidden = !error;
      errorEl.textContent = error ?? '';
      downloadBtn.disabled = Boolean(error);
      if (error) { summaryEl.textContent = ''; return; }

      const puzzles = ids.map(id => toBookletPuzzle(this.loadedPuzzles[id - 1]));
      const plan = booklet.planBooklet({
        count: puzzles.length,
        shape: booklet.describePuzzles(puzzles),
        paper,
        perPage: perPageChoice(),
        includeKey: keyToggle.checked,
        axisLabels: labelsToggle.checked,
      });
      const count = `${puzzles.length} puzzle${puzzles.length === 1 ? '' : 's'}`;
      const perPage = `${plan.puzzleLayout.k} per page`;
      summaryEl.textContent = plan.includeKey
        ? `${count}, ${perPage}: ${pageWord(plan.puzzlePages)} of puzzles + ${pageWord(plan.keyPages)} of answers.`
        : `${count}, ${perPage}: ${pageWord(plan.puzzlePages)}.`;
    };
    selectionInput.addEventListener('input', refresh);

    // Offer the PDF as a file download.
    const saveBlob = (bytes, filename) => {
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    };

    downloadBtn.addEventListener('click', async () => {
      const { booklet, ids, error } = await readForm();
      if (error) return;
      downloadBtn.disabled = true;
      const idleLabel = downloadBtn.textContent;
      downloadBtn.textContent = 'Building…';
      try {
        const category = this.categories.find(c => c.id === this.currentCategoryId);
        const group = category?.group && category.group !== '__ungrouped__' ? `${category.group} - ` : '';
        const bookLabel = `${group}${category?.label ?? this.currentCategoryId}`;
        const bytes = await booklet.buildBooklet({
          puzzles: ids.map(id => toBookletPuzzle(this.loadedPuzzles[id - 1])),
          bookLabel,
          paper,
          perPage: perPageChoice(),
          includeKey: keyToggle.checked,
          axisLabels: labelsToggle.checked,
        });
        const rangeName = selectionInput.value.replace(/\s+/g, '').replace(/[^0-9a-z,-]/gi, '').replace(/,/g, '_').slice(0, 40);
        saveBlob(bytes, `${this.currentCategoryId}-puzzles-${rangeName}.pdf`);
        close();
      } catch (err) {
        console.error('[print] failed to build booklet:', err);
        this.showToast('Sorry, the PDF could not be created.', 'error');
      } finally {
        downloadBtn.textContent = idleLabel;
        downloadBtn.disabled = false;
      }
    });

    // Opening (from the Settings modal): describe the current book and
    // offer its first few puzzles.
    document.getElementById('print-btn').onclick = () => {
      document.getElementById('settings-modal').classList.add('modal-hidden');
      const total = this.loadedPuzzles.length;
      const category = this.categories.find(c => c.id === this.currentCategoryId);
      document.getElementById('print-book-name').textContent = category?.label ?? this.currentCategoryId;
      document.getElementById('print-book-total').textContent = String(total);
      selectionInput.value = total <= 1 ? '1' : `1-${Math.min(total, 10)}`;
      refresh();
      open();
      selectionInput.focus();
      selectionInput.select();
    };
  };
}
