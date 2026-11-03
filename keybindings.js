// Configurable keyboard shortcuts: which key triggers which control.
//
// A binding is {key, ctrl, alt, meta, shift}: `key` is KeyboardEvent.key
// (what the keycap produces on the player's own layout, so a Dvorak or fully
// custom layout just works -- we only ever compare a press with a press
// recorded on the same layout), with single characters lowercased so
// CapsLock doesn't matter. Modifiers must match exactly.
//
// Only the player's OVERRIDES are stored (localStorage 'setting-keybindings':
// {actionId: binding | null}); null means "explicitly unbound", a missing id
// means "use the default". So a new default added later reaches everyone who
// hasn't touched that action. The only defaults are the arrow keys for
// previous/next puzzle, which is how they behaved before this was
// configurable.
//
// The pure helpers up top have no DOM dependency so tests can import them;
// the mixin below wires them to the page.

import { HIGHLIGHT_COLORS, HIGHLIGHT_TEXTURES } from './constants.js';

export const KEYBINDINGS_STORAGE_KEY = 'setting-keybindings';

// Pressed alone, these can't be a shortcut (they're how you type one).
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Fn', 'FnLock', 'OS']);
// Dead keys and IME states: the event doesn't say which key it was.
const UNUSABLE_KEYS = new Set(['Dead', 'Unidentified', 'Process', 'Compose']);
// Keys the page needs for itself: Tab/Enter/Space drive keyboard focus and
// buttons, so binding them would break keyboard navigation of the app.
const RESERVED_KEYS = new Map([['Tab', 'Tab'], ['Enter', 'Enter'], [' ', 'Space']]);

// section: heading in the shortcuts modal. repeat: whether holding the key
// repeats the action (good for stepping, bad for toggles). needsMarks: only
// does anything while the "Cell colors" setting is on.
export function buildKeyActions(colors = HIGHLIGHT_COLORS, textures = HIGHLIGHT_TEXTURES) {
  return [
    { id: 'prevPuzzle', section: 'Puzzles', label: 'Previous puzzle', repeat: true, defaultBinding: { key: 'ArrowLeft' } },
    { id: 'nextPuzzle', section: 'Puzzles', label: 'Next puzzle', repeat: true, defaultBinding: { key: 'ArrowRight' } },
    { id: 'undo', section: 'Controls', label: 'Undo', repeat: true },
    { id: 'redo', section: 'Controls', label: 'Redo', repeat: true },
    { id: 'reset', section: 'Controls', label: 'Reset' },
    { id: 'check', section: 'Controls', label: 'Correct so far?' },
    { id: 'hint', section: 'Controls', label: 'Hint' },
    { id: 'dotsStars', section: 'Cell colors', label: 'Dots & stars', needsMarks: true },
    ...colors.map((name, i) => ({ id: `color:${i}`, section: 'Cell colors', label: `Color: ${name}`, swatch: `hl-swatch hl-swatch-${name}`, needsMarks: true })),
    ...textures.map((name, i) => ({ id: `texture:${i}`, section: 'Cell colors', label: `Texture: ${name}`, swatch: `hl-tex-btn hl-tex-${name}`, needsMarks: true })),
    { id: 'toggleMarks', section: 'Cell colors', label: 'Hide / show marks', needsMarks: true },
  ];
}

export const KEY_ACTIONS = Object.freeze(buildKeyActions());

export function normalizeKey(key) {
  return key.length === 1 ? key.toLowerCase() : key;
}

// The binding a keydown event would record, or null for a press that can't be one.
export function eventToBinding(e) {
  if (MODIFIER_KEYS.has(e.key) || UNUSABLE_KEYS.has(e.key)) return null;
  return { key: normalizeKey(e.key), ctrl: !!e.ctrlKey, alt: !!e.altKey, meta: !!e.metaKey, shift: !!e.shiftKey };
}

export function reservedKeyName(binding) {
  return RESERVED_KEYS.get(binding.key) ?? null;
}

export function sameBinding(a, b) {
  return !!a && !!b && a.key === b.key
    && !!a.ctrl === !!b.ctrl && !!a.alt === !!b.alt && !!a.meta === !!b.meta && !!a.shift === !!b.shift;
}

const KEY_LABELS = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc', ' ': 'Space' };

export function bindingLabel(b) {
  const parts = [];
  if (b.ctrl) parts.push('Ctrl');
  if (b.alt) parts.push('Alt');
  if (b.shift) parts.push('Shift');
  if (b.meta) parts.push('Cmd');
  parts.push(KEY_LABELS[b.key] ?? (b.key.length === 1 ? b.key.toUpperCase() : b.key));
  return parts.join('+');
}

function isBinding(v) {
  return !!v && typeof v === 'object' && typeof v.key === 'string' && v.key.length > 0;
}

// The overrides saved in `storage`; anything malformed counts as "none".
export function loadStoredBindings(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(KEYBINDINGS_STORAGE_KEY));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    return {};
  }
}

export function saveStoredBindings(storage, stored) {
  if (Object.keys(stored).length === 0) storage.removeItem(KEYBINDINGS_STORAGE_KEY);
  else storage.setItem(KEYBINDINGS_STORAGE_KEY, JSON.stringify(stored));
}

// actionId -> binding | null, defaults overlaid with the stored overrides.
export function effectiveBindings(stored, actions = KEY_ACTIONS) {
  const result = new Map();
  for (const a of actions) {
    const override = Object.prototype.hasOwnProperty.call(stored, a.id) ? stored[a.id] : undefined;
    if (override === null) result.set(a.id, null);
    else if (isBinding(override)) result.set(a.id, override);
    else result.set(a.id, a.defaultBinding ?? null);
  }
  return result;
}

// The action a key press triggers, or undefined.
export function findKeyAction(effective, e, actions = KEY_ACTIONS) {
  const pressed = eventToBinding(e);
  if (!pressed) return undefined;
  return actions.find(a => sameBinding(effective.get(a.id), pressed));
}

// Bind `binding` to `id`. A key can only do one thing, so any other action
// currently on it is unbound; they're returned so the UI can say so.
export function assignBinding(stored, id, binding, actions = KEY_ACTIONS) {
  const effective = effectiveBindings(stored, actions);
  const next = { ...stored };
  const displaced = [];
  for (const a of actions) {
    if (a.id !== id && sameBinding(effective.get(a.id), binding)) {
      next[a.id] = null;
      displaced.push(a);
    }
  }
  next[id] = { key: binding.key, ctrl: !!binding.ctrl, alt: !!binding.alt, meta: !!binding.meta, shift: !!binding.shift };
  return { stored: next, displaced };
}

export function clearBinding(stored, id) {
  return { ...stored, [id]: null };
}

export function applyKeybindings(GameClass) {
  const p = GameClass.prototype;

  // Entry point for every keydown (registered in capture phase by
  // setupGlobalListeners, so it runs before the modals' own Escape
  // handlers: otherwise Escape would close a modal and THEN reach us as if
  // none were open, firing its binding too).
  p._handleKeydown = function (e) {
    if (this._keyCapture) { this._captureKey(e); return; }
    if (e.defaultPrevented) return;
    // Modals own the keyboard (Escape closes them, text boxes need typing).
    if (document.querySelector('.modal-overlay:not(.modal-hidden)')) return;
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;

    const effective = effectiveBindings(loadStoredBindings(localStorage));
    const action = findKeyAction(effective, e);
    if (!action) return;
    e.preventDefault();
    if (e.repeat && !action.repeat) return;
    this._runKeyAction(action);
  };

  p._runKeyAction = function (action) {
    // Click the real button, so the action is disabled exactly when the
    // button is (no undo with nothing to undo, nothing while loading).
    const click = (selector) => document.querySelector(selector)?.click();
    const [kind, arg] = action.id.split(':');
    if (action.needsMarks && !this._highlightsEnabled()) return;
    switch (kind) {
      case 'prevPuzzle': this.stepPuzzle?.(-1); break;
      case 'nextPuzzle': this.stepPuzzle?.(1); break;
      case 'undo': click('.ctrl-undo'); break;
      case 'redo': click('.ctrl-redo'); break;
      case 'reset': click('.ctrl-reset'); break;
      case 'check': click('.ctrl-check'); break;
      case 'hint': click('.ctrl-hint'); break;
      case 'dotsStars': this._selectHighlight(null); break;
      case 'color': this._selectHighlight(Number(arg)); break;
      case 'texture': this._selectTexture(Number(arg)); break;
      case 'toggleMarks': this._setMarksHidden(!this._marksHidden); break;
    }
  };

  // --- Shortcuts modal ---

  p.setupKeybindingsModal = function () {
    const modal = document.getElementById('keys-modal');
    if (!modal) return;
    const { open } = this.setupModal('keys-modal');
    const list = document.getElementById('keys-list');
    const status = document.getElementById('keys-status');

    const say = (text) => { status.textContent = text; };
    const stored = () => loadStoredBindings(localStorage);
    const save = (next) => { saveStoredBindings(localStorage, next); render(); };

    const cancelCapture = () => {
      if (!this._keyCapture) return;
      this._keyCapture = null;
      render();
    };

    const render = () => {
      const effective = effectiveBindings(stored());
      list.textContent = '';
      let section = null;
      for (const action of KEY_ACTIONS) {
        if (action.section !== section) {
          section = action.section;
          const h = document.createElement('h3');
          h.className = 'key-section';
          h.textContent = section;
          list.appendChild(h);
        }
        const row = document.createElement('div');
        row.className = 'key-row';

        const label = document.createElement('span');
        label.className = 'key-row-label';
        if (action.swatch) {
          const sw = document.createElement('span');
          sw.className = `key-swatch ${action.swatch}`;
          label.appendChild(sw);
        }
        label.appendChild(document.createTextNode(action.label));
        row.appendChild(label);

        const binding = effective.get(action.id);
        const capturing = this._keyCapture === action.id;
        const keyBtn = document.createElement('button');
        keyBtn.type = 'button';
        keyBtn.className = 'key-bind-btn';
        keyBtn.textContent = capturing ? 'Press a key…' : (binding ? bindingLabel(binding) : 'Unbound');
        keyBtn.classList.toggle('key-bind-btn--unbound', !binding && !capturing);
        keyBtn.classList.toggle('key-bind-btn--capturing', capturing);
        keyBtn.setAttribute('aria-label', `Shortcut for ${action.label}: ${binding ? bindingLabel(binding) : 'unbound'}. Activate to change.`);
        keyBtn.onclick = () => {
          this._keyCapture = capturing ? null : action.id;
          say(this._keyCapture ? 'Press the key to use (Esc works too). Click anywhere else to cancel.' : '');
          render();
          if (this._keyCapture) list.querySelector('.key-bind-btn--capturing')?.focus();
        };
        row.appendChild(keyBtn);

        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'key-clear-btn';
        clearBtn.textContent = '✕';
        clearBtn.setAttribute('aria-label', `Clear shortcut for ${action.label}`);
        clearBtn.disabled = !binding;
        clearBtn.onclick = () => { say(''); save(clearBinding(stored(), action.id)); };
        row.appendChild(clearBtn);

        list.appendChild(row);
      }
    };

    // Called from _handleKeydown while a row is waiting for its key.
    this._captureKey = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      const binding = eventToBinding(e);
      if (!binding || e.repeat) return;
      const reserved = reservedKeyName(binding);
      if (reserved) {
        say(`${reserved} is needed to navigate the page — pick another key.`);
        return;
      }
      const id = this._keyCapture;
      this._keyCapture = null;
      const { stored: next, displaced } = assignBinding(stored(), id, binding);
      say(displaced.length ? `${bindingLabel(binding)} was bound to ${displaced.map(a => a.label).join(', ')}; that is now unbound.` : '');
      save(next);
    };

    // Any click outside the capturing button abandons the capture (blur
    // isn't enough: Safari doesn't focus buttons on click).
    document.addEventListener('pointerdown', (e) => {
      if (this._keyCapture && !e.target.closest('.key-bind-btn--capturing')) { say(''); cancelCapture(); }
    }, true);

    document.getElementById('keys-reset-btn').onclick = () => {
      this._keyCapture = null;
      say('Restored the defaults.');
      save({});
    };

    document.getElementById('keys-btn').onclick = () => {
      document.getElementById('settings-modal').classList.add('modal-hidden');
      this._keyCapture = null;
      say('');
      render();
      open();
    };
  };
}
