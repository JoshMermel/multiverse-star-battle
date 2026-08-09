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
export const HINT_SOURCE_VARIANTS = Object.freeze([
  'hint-source-blue',
  'hint-source-purple',
  'hint-source-cyan',
  'hint-source-pink',
]);

// Plain color names (not full class names) for the "tiles" rule family's 2x2
// box-outline hints -- see solver-rules-multi.js's Tiles section. Index i
// here intentionally matches HINT_SOURCE_VARIANTS[i], so a multi-tile hint's
// outline color always matches that tile's own cell-highlight color.
export const TILE_OUTLINE_COLORS = Object.freeze(['blue', 'purple', 'cyan', 'pink']);
