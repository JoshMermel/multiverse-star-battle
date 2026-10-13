// Shared cell state constants used by both the game and the solver.
export const CELL = Object.freeze({ NONE: 'none', STAR: 'star', DOT: 'dot' });

// Hint highlight colors, applied as CSS classes to cells. solver-*.js
// choose which color goes on each highlight/mark; renderer.js applies and
// clears the classes. Centralized so a typo in either place is a build-time
// reference error instead of a silently-broken highlight.
export const HINT_COLOR = Object.freeze({
  SOURCE: 'hint-source-blue',
  TARGET: 'hint-target-yellow',
  TARGET_STAR: 'hint-target-green',
  ERROR: 'hint-error-red',
});

// A hint sometimes highlights several disjoint "source" groups at once
// (e.g. "each of these N groups must contain a star"), all playing the same
// SOURCE role -- cycled through per group so they're visually distinguishable
// instead of blurring into one indistinct blob of blue. Index 0 intentionally
// matches HINT_COLOR.SOURCE, so a single-group hint still renders exactly as
// before.
//
// Was blue/purple/cyan/pink -- a colorblind player reported being unable to
// reliably tell the purple slot apart from blue. Purple is a blue+red
// blend, and protanopia/deuteranopia (by far the most common forms of
// color blindness) both reduce red-channel perception, so that blend reads
// as a dimmer, less saturated blue rather than a distinctly different hue.
// Replaced with brown, separated from every other slot (and from the rest
// of the app's highlight hues -- error red, target-star green, target
// yellow, line-highlight amber) by lightness/saturation as well as hue,
// which holds up across every type of color vision deficiency, not just
// the red-green ones.
export const HINT_SOURCE_VARIANTS = Object.freeze([
  'hint-source-blue',
  'hint-source-brown',
  'hint-source-cyan',
  'hint-source-pink',
]);

// Plain color names (not full class names) for the "tiles" rule family's 2x2
// box-outline hints -- see solver-rules-multi.js's Tiles section. Index i
// here intentionally matches HINT_SOURCE_VARIANTS[i], so a multi-tile hint's
// outline color always matches that tile's own cell-highlight color.
export const TILE_OUTLINE_COLORS = Object.freeze(['blue', 'brown', 'cyan', 'pink']);

// The user's own cell-coloring palette (the opt-in "Cell colors" setting) --
// purely a note-taking aid, unrelated to HINT_COLOR above. A highlight is
// stored as an index into this list (null = uncolored); each name maps to a
// `cell-hl-<name>` class on the board and a `hl-swatch-<name>` class on the
// palette button (style.css). Append new colors at the END: saved
// highlights (storage.js) are indices, so reordering would recolor them.
//
// Chosen to stay distinguishable under protanopia/deuteranopia/tritanopia
// in both themes, as translucent cell tints: a simulated pairwise-distance
// search over candidate hues ruled out the usual red/green/purple picks
// (red~green and blue~purple collapse for red-green colorblindness) in
// favor of colors that differ in LIGHTNESS as well as hue -- light yellow
// and sky vs. mid orange/gray vs. dark brown/blue.
export const HIGHLIGHT_COLORS = Object.freeze(['yellow', 'orange', 'brown', 'sky', 'blue', 'gray']);
