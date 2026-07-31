import { PuzzleSolver } from './solver-core.js';
import { applyCommonSolverRules } from './solver-rules-common.js';
import { applySingleStarRules } from './solver-rules-single.js';
import { applyMultiStarRules } from './solver-rules-multi.js';

// PuzzleSolver's core engine lives in solver-core.js; its hint rules are
// mixed onto the prototype from the sibling solver-rules-*.js files, the
// same applyX(Class) convention rules.js uses for StarBattleGame (see
// script.js). Splitting it this way keeps solver.js a stable import for
// callers (script.js does `import { PuzzleSolver } from './solver.js'`)
// while the ~2200-line single class becomes: a rule-count-agnostic core,
// rules shared by every star count, 1★-only rules, and 2★+-only rules.
applyCommonSolverRules(PuzzleSolver);
applySingleStarRules(PuzzleSolver);
applyMultiStarRules(PuzzleSolver);

export { PuzzleSolver };
