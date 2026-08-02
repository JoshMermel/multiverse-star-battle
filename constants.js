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
