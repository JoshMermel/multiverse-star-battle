"""
regionless_generator.py

Generates single-board "regionless" ("shapeless") Star Battle puzzles:
stars_per_unit stars per row/column, NO region constraint at all -- voids
alone force uniqueness. See is_regionless_board (board_utils.py) for how
the rest of the codebase detects this variant from the board string alone
(a board with <= 1 distinct non-void id) -- this generator produces boards
that satisfy that condition by construction: every non-void cell shares
region id 0.

Strategy: "maximal-void carve". Unlike SolutionFirstGenerator (which starts
from a fully-open board and grows/repairs REGIONS to reach uniqueness),
there are no regions here to grow -- so this starts from the OTHER
extreme: every cell except the intended solution's own stars is voided.
That starting point is always trivially unique (each row/col then has
exactly stars_per_unit playable cells, forced to be the solution), so no
solver call is needed to confirm it. Cells are then un-voided one at a
time, in random order, keeping each one only if the board stays uniquely
solvable (checked via CP-SAT, get_solutions_capped) -- reverting
(re-voiding) otherwise.

Difficulty is an emergent property of how far this carve gets, not a
generation input: the process doesn't stop at a single target tier. See
Generator.generate_tier_ladder, which runs the SAME carve to completion
and harvests one board per difficulty tier reached along the way, since
one expensive carve naturally passes through every tier on its way from
trivial to (possibly) harder than this ruleset can solve. This matches how
the rest of this codebase already treats difficulty: a tier-agnostic pool,
classified after the fact (see gen_puzzles.py's score subcommand and
book_gen.py) -- generate_tier_ladder is just a far more sample-efficient
producer for that same pool.

Each tier's representative is sampled RANDOMLY from every board seen at
that tier during the carve, not just the last (densest, hence hardest-
within-tier) one -- otherwise every puzzle this generator ever produced at
a given tier would sit right at that tier's hard edge, with no variety
toward its easier end. This needs no extra verification: uniqueness is
monotonic in void count (removing voids can only shrink a board's solution
count, never grow it), so every accepted step along the way -- not just
the final one -- is independently already a verified-unique, already-
scored, equally legitimate example of whatever tier it landed at.

Void placement is intentionally NOT symmetric (unconstrained), and boards
that undershoot every tier (structural failure, e.g. no valid star
placement found) return None -- callers should retry with a fresh attempt,
same convention as every other generator in this codebase.
"""

import random

from board_solver import get_solutions_capped
from board_utils import VOID_CHAR, ALPHABET
from filter import board_contains_swastika
from generator import Generator
from scorer import StarBattlePuzzle, CompositeScorer, _TIER_RANK
from solution_first_core import random_star_placement, stars_to_solution_string


class RegionlessGenerator(Generator):
    """Maximal-void-carve generator for regionless (shapeless) puzzles."""

    def __init__(self, n, stars_per_unit=1):
        super().__init__(n, stars_per_unit=stars_per_unit)

    def _try_generate(self):
        """
        ABC-required single-board contract (used by the inherited
        Generator.generate()/demo()): runs one carve attempt and returns
        the board at the HARDEST tier it reached, packaged via
        _make_result(min_solutions=1) -- a regionless puzzle has no
        multiverse partner to disambiguate it, so (like
        SolutionFirstGenerator) it targets a genuinely unique solution,
        not the "ambiguous per board" default the rest of this codebase's
        generators use.

        Most callers that actually want value out of this generator should
        use generate_tier_ladder() instead, which harvests every tier
        reached by the same carve rather than keeping only the hardest.
        """
        ladder = self._carve_once()
        if not ladder:
            return None
        hardest_tier = max(ladder, key=lambda t: _TIER_RANK[t])
        board_str, solution, _score = ladder[hardest_tier]
        return self._make_result(
            [VOID_CHAR if ch == VOID_CHAR else ALPHABET.index(ch) for ch in board_str],
            solutions={solution}, min_solutions=1,
        )

    def generate_tier_ladder(self, sampling="random"):
        """
        Public single-attempt entry point (no outer retry loop -- mirrors
        _try_generate's contract): runs one carve and returns a dict
        {tier: (board_str, solution, score)}, one entry per difficulty
        tier reached, or None on a structural failure (e.g. no valid star
        placement found within budget). Callers that want several boards
        spanning the tier range should call this directly in their own
        retry loop, e.g. RegionlessLadderComparator, rather than going
        through generate()/_try_generate() (which discards every tier but
        the hardest).

        sampling picks which board represents each tier out of everything
        seen at that tier along the way:
          - "random" (default): a random pick -- see module docstring for
            why (variety across a whole book, at Beginner's own bias toward
            the denser half of its range).
          - "hardest": always the densest (last-seen, hence hardest-within-
            tier) board -- for mining genuinely extreme examples of a tier,
            e.g. a "hardest Expert this ruleset can still solve" bonus.
            Skips Beginner's denser-half bias too (moot at "hardest": the
            single densest state already IS the far end of that range).
        """
        return self._carve_once(sampling=sampling)

    def generate_full_history(self):
        """
        Public single-attempt entry point, like generate_tier_ladder, but
        returns the UNCOLLAPSED history instead: {tier: [(board_str,
        solution, score), ...]}, every board seen at every tier during this
        one carve, in acceptance order, or None on a structural failure.

        generate_tier_ladder (any sampling mode) keeps only ONE board per
        tier per run, discarding the rest -- fine for building a book (one
        run should only ever contribute one candidate per tier bucket), but
        wasteful for MINING a small number of truly extreme examples: a
        single run can pass through many distinct boards at the tier of
        interest before graduating or exhausting candidates, and every one
        of them was already independently verified unique and scored (see
        _carve_once's own comment) at no extra cost. Pooling the FULL
        history across many runs -- see build_regionless_books.py's
        mine_extreme_bonus -- gets a much larger, richer candidate pool
        per unit of carve time than one-pick-per-run ever could.
        """
        return self._carve_once(raw=True)

    def _carve_once(self, sampling="random", raw=False):
        n = self.n
        stars_per_unit = self.stars_per_unit

        star_cells = random_star_placement(n, stars_per_unit)
        if star_cells is None:
            return None
        star_set = set(star_cells)
        solution = stars_to_solution_string(star_set, n)

        # Maximal starting mask: only the solution's own cells are
        # playable. Always trivially unique (see module docstring) --
        # no solver call needed to confirm the starting point itself.
        grid = [VOID_CHAR] * (n * n)
        for cell in star_set:
            grid[cell] = 0

        candidates = [i for i in range(n * n) if i not in star_set]
        random.shuffle(candidates)

        scorer = CompositeScorer(verbose=False)
        # tier -> every (board_str, solution, score) seen at that tier along
        # the way, in acceptance order. Every entry here is independently a
        # valid, already-verified-unique board -- see the "why sampling
        # needs no extra solver calls" note below -- so keeping the whole
        # per-tier history (not just the densest board) costs nothing extra
        # to compute, only a little memory.
        seen_by_tier = {}

        for cell in candidates:
            grid[cell] = 0
            solutions = get_solutions_capped(grid, n, cap=2, stars_per_unit=stars_per_unit)
            if solutions is None or len(solutions) > 1:
                grid[cell] = VOID_CHAR
                continue
            if solutions != {solution}:
                # Should be unreachable: star_set never gets voided, so the
                # intended solution is always among any solutions found.
                # Guard against a silent inconsistency rather than trust it.
                grid[cell] = VOID_CHAR
                continue

            board_str = "".join(VOID_CHAR if v == VOID_CHAR else ALPHABET[v] for v in grid)
            if board_contains_swastika(board_str, n):
                grid[cell] = VOID_CHAR
                continue

            puzzle = StarBattlePuzzle(n=n, boards=[board_str], solution_str=solution,
                                       name="carve", stars_per_unit=stars_per_unit)
            solved, score, tier = scorer.solve(puzzle)
            if solved:
                seen_by_tier.setdefault(tier, []).append((board_str, solution, score))

        if not seen_by_tier:
            return None
        if raw:
            return seen_by_tier

        # Sample ONE representative per tier at random from everything seen
        # at that tier, rather than always keeping the last (densest, so
        # hardest-within-tier) board -- always picking the hardest end would
        # mean every "Medium" puzzle this generator ever produces sits right
        # at the Medium/Hard boundary, with no variety toward the easier end
        # of Medium. No extra CP-SAT/scorer work is needed to do this: every
        # accepted step above was independently verified unique already
        # (uniqueness is monotonic in void count -- an accepted step only
        # ever REMOVES voids relative to the guaranteed-unique start, and
        # removing voids can only shrink a board's solution count, never
        # grow it, so every prefix of the accepted sequence is unique too,
        # not just the final one), and every accepted step was independently
        # scored already, so any of them is an equally legitimate example of
        # whatever tier it landed at.
        #
        # Beginner is the one exception: every OTHER tier has a real
        # signature technique (region-sync, tiles, lookahead, ...), so
        # varying how richly that technique gets exercised across a whole
        # book is genuine variety. Beginner has no technique at all -- it's
        # pure forced-filling -- so its only axis of variation is how much
        # is even open, and the sparse end of that range (right after the
        # forced starting point) isn't an "easy" example, it's a nearly
        # content-free one. So for Beginner only, sample from the denser
        # (later) half of its range instead of the whole thing.
        result = {}
        for tier, entries in seen_by_tier.items():
            if sampling == "hardest":
                result[tier] = entries[-1]
                continue
            pool = entries[len(entries) // 2:] if tier == "Beginner" else entries
            result[tier] = random.choice(pool)
        return result
