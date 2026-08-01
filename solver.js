import { PuzzleSolver } from './solver-core.js';
import { applyCommonSolverRules } from './solver-rules-common.js';
import { applySingleStarRules } from './solver-rules-single.js';
import { applyMultiStarRules } from './solver-rules-multi.js';

// PuzzleSolver's core engine lives in solver-core.js; its hint rules are
// mixed onto the prototype from the sibling solver-rules-*.js files, the
// same applyX(Class) convention rules.js uses for StarBattleGame (see
// script.js). This file stays a stable import for callers (script.js does
// `import { PuzzleSolver } from './solver.js'`) regardless of how the
// rules underneath are organized.
applyCommonSolverRules(PuzzleSolver);
applySingleStarRules(PuzzleSolver);
applyMultiStarRules(PuzzleSolver);

export { PuzzleSolver };
