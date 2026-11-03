// Tests for the pure parts of keybindings.js (binding capture, matching, conflict handling, storage).  Run:  node --test   (from the repo root)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KEY_ACTIONS, eventToBinding, sameBinding, bindingLabel, reservedKeyName, effectiveBindings, findKeyAction,
  assignBinding, clearBinding, loadStoredBindings, saveStoredBindings, KEYBINDINGS_STORAGE_KEY,
} from '../keybindings.js';

const press = (key, mods = {}) => ({ key, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, metaKey: !!mods.meta, shiftKey: !!mods.shift });
const fakeStorage = () => ({ _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } });

test('defaults: only the arrow keys are bound, to prev/next puzzle', () => {
  const eff = effectiveBindings({});
  const bound = KEY_ACTIONS.filter(a => eff.get(a.id)).map(a => a.id);
  assert.deepEqual(bound, ['prevPuzzle', 'nextPuzzle']);
  assert.equal(findKeyAction(eff, press('ArrowLeft')).id, 'prevPuzzle');
  assert.equal(findKeyAction(eff, press('ArrowRight')).id, 'nextPuzzle');
});

test('modifiers must match exactly (Cmd+Left is browser Back, not previous puzzle)', () => {
  const eff = effectiveBindings({});
  assert.equal(findKeyAction(eff, press('ArrowLeft', { meta: true })), undefined);
  assert.equal(findKeyAction(eff, press('ArrowLeft', { shift: true })), undefined);
});

test('modifier-only and dead-key presses cannot be recorded', () => {
  for (const key of ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Dead', 'Unidentified']) assert.equal(eventToBinding(press(key)), null, key);
});

test('letters match regardless of CapsLock/Shift case; shift is tracked separately', () => {
  const { stored } = assignBinding({}, 'undo', eventToBinding(press('z', { ctrl: true })));
  const eff = effectiveBindings(stored);
  assert.equal(findKeyAction(eff, press('Z', { ctrl: true })).id, 'undo');
  assert.equal(findKeyAction(eff, press('z')), undefined);
  assert.equal(findKeyAction(eff, press('z', { ctrl: true, shift: true })), undefined);
});

test('Escape is a valid binding', () => {
  const { stored } = assignBinding({}, 'dotsStars', eventToBinding(press('Escape')));
  assert.equal(findKeyAction(effectiveBindings(stored), press('Escape')).id, 'dotsStars');
  assert.equal(reservedKeyName(eventToBinding(press('Escape'))), null);
});

test('Tab, Enter and Space are reserved for page navigation', () => {
  for (const key of ['Tab', 'Enter', ' ']) assert.ok(reservedKeyName(eventToBinding(press(key))), JSON.stringify(key));
});

test('rebinding a key already in use unbinds the previous owner', () => {
  const left = eventToBinding(press('ArrowLeft'));
  const { stored, displaced } = assignBinding({}, 'undo', left);
  assert.deepEqual(displaced.map(a => a.id), ['prevPuzzle']);
  const eff = effectiveBindings(stored);
  assert.equal(eff.get('prevPuzzle'), null);
  assert.equal(findKeyAction(eff, press('ArrowLeft')).id, 'undo');
});

test('clearing a default leaves it unbound; clearing back to {} restores it', () => {
  const cleared = clearBinding({}, 'nextPuzzle');
  assert.equal(effectiveBindings(cleared).get('nextPuzzle'), null);
  assert.equal(findKeyAction(effectiveBindings(cleared), press('ArrowRight')), undefined);
  assert.equal(effectiveBindings({}).get('nextPuzzle').key, 'ArrowRight');
});

test('every color and texture has its own action', () => {
  assert.equal(KEY_ACTIONS.filter(a => a.id.startsWith('color:')).length, 9);
  assert.equal(KEY_ACTIONS.filter(a => a.id.startsWith('texture:')).length, 9);
  assert.equal(new Set(KEY_ACTIONS.map(a => a.id)).size, KEY_ACTIONS.length);
});

test('storage round trip; corrupt or empty storage falls back to defaults', () => {
  const s = fakeStorage();
  assert.deepEqual(loadStoredBindings(s), {});
  const { stored } = assignBinding({}, 'hint', eventToBinding(press('h')));
  saveStoredBindings(s, stored);
  assert.equal(effectiveBindings(loadStoredBindings(s)).get('hint').key, 'h');
  s.setItem(KEYBINDINGS_STORAGE_KEY, '{not json');
  assert.deepEqual(loadStoredBindings(s), {});
  s.setItem(KEYBINDINGS_STORAGE_KEY, '[1,2]');
  assert.deepEqual(loadStoredBindings(s), {});
  s.setItem(KEYBINDINGS_STORAGE_KEY, JSON.stringify({ undo: 'garbage', hint: { nokey: 1 } }));
  assert.equal(effectiveBindings(loadStoredBindings(s)).get('undo'), null);
  saveStoredBindings(s, {});
  assert.equal(s.getItem(KEYBINDINGS_STORAGE_KEY), null);
});

test('labels', () => {
  assert.equal(bindingLabel(eventToBinding(press('ArrowLeft'))), '←');
  assert.equal(bindingLabel(eventToBinding(press('Escape'))), 'Esc');
  assert.equal(bindingLabel(eventToBinding(press('z', { ctrl: true, shift: true }))), 'Ctrl+Shift+Z');
  assert.ok(sameBinding(eventToBinding(press('A')), eventToBinding(press('a'))));
});
