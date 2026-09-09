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

// Plain color name for the "region/line quota fill" rule family's full-row/
// column outline band -- see solver-rules-multi.js's hintRegionLineQuotaFill
// and renderer.js's _applyLineHighlight. Deliberately not one of the
// HINT_SOURCE_VARIANTS/TILE_OUTLINE_COLORS hues (those are already in play
// on the same hint's region highlight), so the line band always reads as
// its own distinct thing. Matches --line-highlight-amber in style.css and
// the "amber-outlined" wording in solver-rules-multi.js's hint text --
// keep all three in sync if this color ever changes.
export const LINE_HIGHLIGHT_COLOR = 'amber';
