"""
engine.py

Core scoring engine: TIER_ORDER/_TIER_RANK, and ScorerCore -- the solve-loop
driver plus the handful of helpers that are genuinely shared by every
star-count rule family (unit-completion enumeration, contradiction
detection, validated cell writes). Every rule_* implementation itself lives
in rules_common.py / rules_single_star.py / rules_multi_star.py; see
composite_scorer.py for how they're assembled into CompositeScorer.
"""

# Tier ordering for display and sorting. UNSOLVED sorts last.
TIER_ORDER = ["Beginner", "Medium", "Hard", "Symmetry", "Expert", "Grandmaster", "UNSOLVED"]
_TIER_RANK = {tier: i for i, tier in enumerate(TIER_ORDER)}

# _enumerate_unit_completions bails out (returns None, same as "already at
# quota" -- every caller already treats that as "this unit contributes
# nothing", the correct behavior for "we didn't check" as much as "we
# checked and there's nothing") once a unit's completion count would
# plausibly exceed this. Past that many valid non-touching placements, no
# single cell is ever common to all of them (or excluded from all of them)
# -- the "every completion agrees" argument this enumeration exists to
# support just doesn't fire on unconstrained units that large, no matter
# how long you search. Set to None to disable the cap entirely (e.g. for
# an offline scoring run where wall-clock time matters less than never
# skipping a potential deduction).
#
# Gated on an estimate of C(avail, needed) (see _estimate_combos below),
# NOT a flat ratio of avail/needed -- a flat ratio breaks down badly for
# small `needed`: a region down to its last star (needed=1) with a dozen
# empty cells is cheap (C(12,1)=12, no combinatorial blowup at all, since
# there's nothing to combine) but would trip a naive "avail > 4x needed"
# check anyway, silently discarding perfectly ordinary, fast, and
# sometimes-genuinely-forced deductions.
#
# Mirrors ENUMERATION_COMBO_CAP in solver-core.js -- see that constant's
# comment for the measured JS numbers behind this value (a 97-cell region
# on a real 21x21/5-star puzzle took ~19s to enumerate at this size for
# zero payoff; C(97,5) is on the order of 64 million). Verified against a
# broad puzzle corpus (see tools/verify_enumeration_cap.py) to produce
# identical score/tier for every puzzle tested, both with and without this
# cap enabled.
ENUMERATION_COMBO_CAP = 500000


def _estimate_combos(m, k, cap):
    """
    Cheap, early-exiting estimate of C(m, k) (the binomial coefficient) --
    only ever needs `k` multiply/divide steps (k is a star count, always
    small in practice), and bails the moment the running product clears
    `cap` since callers only care "is this over the cap", not the exact
    value. Mirrors estimateCombos in solver-core.js.
    """
    if k <= 0 or k > m:
        return 0
    result = 1
    for i in range(k):
        result = result * (m - i) / (i + 1)
        if result > cap:
            return result
    return result


class ScorerCore:
    """
    Drives the rule-based solve loop and hosts the rule-count-agnostic
    machinery every rule family builds on.

    Note on the `silent` parameter: several rules accept `silent=False`.
    In normal mode they validate each deduction against the canonical
    solution (catching logic bugs). In silent mode they write directly to
    the grid without validation, used for lookahead sandboxes.
    rule_sees_star has an additional asymmetry in non-silent mode: it returns
    immediately after the first star that produces changes, so the caller can
    re-prioritise rules. In silent mode it accumulates all star consequences
    before returning, since lookahead needs full propagation in one pass.
    """

    def __init__(self, verbose=False):
        self.verbose = verbose

    # -- Core solver ----------------------------------------------------------

    def solve(self, puzzle):
        """
        Attempts to solve the puzzle using the rule list in order.
        Returns (is_solved, total_score, max_tier).
        """
        if self.verbose:
            print(f"\n--- Solving: {puzzle.name} ---")

        if puzzle.stars_per_unit == 1:
            rules = self.rules_1star
        elif puzzle.stars_per_unit == 2:
            rules = self.rules_2_star
        else:
            rules = self.rules_multi_capped

        total_score = 0
        max_tier = "Beginner"

        try:
            while True:
                round_changes = 0
                for rule_func, weight, tier in rules:
                    changes = rule_func(puzzle)
                    if changes > 0:
                        round_changes += changes
                        total_score += weight
                        if _TIER_RANK[tier] > _TIER_RANK[max_tier]:
                            max_tier = tier
                        break
                if round_changes == 0:
                    break
        except ValueError as e:
            if self.verbose:
                print(f"  ERROR: {e}")
            return False, -999, "UNSOLVED"

        solved = all(val is not None for i, val in enumerate(puzzle.grid)
                       if i not in puzzle.void_cells)
        if not solved:
            max_tier = "UNSOLVED"
        return solved, total_score, max_tier

    # -- Internal helpers -----------------------------------------------------

    def _internal_set(self, p, idx, val, reason, silent):
        """Sets a cell in either validation mode or silent sandbox mode."""
        if p.grid[idx] is not None:
            return 0
        if silent:
            p.grid[idx] = val
            return 1
        return p.validate_and_set(idx, val, reason, self.verbose)

    def is_board_broken(self, p, visible_board_idx=None):
        """
        Note: generalized to respect p.stars_per_unit (quota) rather than
        assuming quota == 1, so this same function backs the 1★ AND 2★+
        lookahead rules. For stars_per_unit == 1 this reproduces the
        previous behavior exactly, since a unit is broken the moment it has
        no star and no empty cells left.

        Uses _unit_has_valid_completion for every unit to answer "is there
        at least one way to solve you given the placements of stars
        currently on the board?" -- i.e. can this row/column/region's
        remaining stars still be placed somewhere, respecting non-adjacency
        AND every other unit's remaining capacity. A unit still needing stars
        but with zero valid completions is a genuine contradiction: not just
        "no empty cells left", but also subtler cases like a region whose
        remaining candidates are (jointly, not just individually) boxed in by
        other rows/columns/regions that don't have room for them.

        `visible_board_idx`, when given, restricts every check (which units
        get scanned, and what _unit_has_valid_completion is allowed to
        reason about) to rows/columns and only that one board's regions --
        for the "single board" lookahead rules, which are meant to only rely
        on information visible from one board.
        """
        quota = p.stars_per_unit
        units = p.units if visible_board_idx is None else [
            u for u in p.units if u["board_idx"] is None or u["board_idx"] == visible_board_idx
        ]

        for unit in units:
            if not self._unit_has_valid_completion(p, unit, visible_board_idx=visible_board_idx):
                return True

        # _unit_has_valid_completion returns True once a unit is already at
        # quota, so it doesn't itself catch a unit that's gone OVER quota --
        # check that separately.
        for unit in units:
            stars = sum(1 for i in unit["indices"] if p.grid[i] == "x")
            if stars > quota:
                return True

        for i, val in enumerate(p.grid):
            if val == "x":
                if any(p.grid[nb] == "x" for nb in p._neighbor_map[i]):
                    return True
        return False

    def _find_broken_unit_single_board(self, p, b_idx):
        """
        Returns True if the current grid state contains a contradiction that
        is visible from board b_idx alone: a row, column, or region on b_idx
        with zero valid completions (see is_board_broken /
        _enumerate_unit_completions), or two adjacent stars.

        Broken regions on the *other* board are deliberately ignored, since
        detecting those requires cross-board region reasoning -- this is a
        thin wrapper around is_board_broken's visible_board_idx restriction.

        Shared by both the 1★ single-board lookahead rule
        (rule_lookahead_half_stage_single_board) and its 2★+ analogue
        (rule_lookahead_dots_single_board).
        """
        return self.is_board_broken(p, visible_board_idx=b_idx)

    def _cells_adjacent(self, p, a, b):
        """Whether two cell indices are adjacent, including diagonally."""
        return b in p._neighbor_map[a]

    def _cells_see_each_other(self, p, a, b):
        """
        Whether a star in cell `a` would rule out cell `b` as a candidate
        (symmetric): same row, same column, or 8-adjacent -- a broader
        relation than mere adjacency (_cells_adjacent above).
        """
        ra, ca = p.get_rc(a)
        rb, cb = p.get_rc(b)
        return ra == rb or ca == cb or (abs(ra - rb) <= 1 and abs(ca - cb) <= 1)

    def _enumerate_unit_completions(self, p, unit, strong=True, quota=None, visible_board_idx=None):
        """
        Enumerate every valid way to place a unit's remaining stars:
        combinations of the unit's empty cells, of the size still needed,
        that don't touch each other or any star already placed in the unit
        (even diagonally). Returns None if the unit is already fully
        satisfied, or [] if it has no valid completions.

        When `strong` is True (the default), completions that would overload
        some OTHER row/column/region past its star quota are also filtered
        out. When False, only the adjacency rule above is applied -- a
        cheaper but weaker over-approximation that ignores the rest of the
        board. Python port of _enumerateUnitCompletions in solver.js.

        `quota` defaults to p.stars_per_unit (the normal case), but can be
        overridden for synthetic combined units -- e.g. a pair of adjacent
        rows needs 2 * stars_per_unit in total. The capacity check below
        still enforces stars_per_unit on any OTHER real unit a combo
        touches (including the two individual rows/cols/regions making up a
        pair), since that's never overridden.

        `visible_board_idx`, when given, restricts the strong-mode capacity
        check to only consider OTHER units belonging to that one board
        (region units on a different board are ignored -- rows/columns are
        board-agnostic and always considered). Defaults to None (no
        restriction, the normal case). This exists so a "single board"
        lookahead check can reason about a shared row/column's capacity
        without silently pulling in the OTHER board's region layout, which
        that check is specifically meant not to depend on.

        Generation itself is a backtracking search over `avail` (in the
        same index order `combinations()` would enumerate, so results come
        out in the same order as before) that prunes a candidate cell the
        instant it's adjacent to an already-chosen cell or an existing
        star, instead of generating every size-`needed` combination up
        front via combinations() and filtering adjacency violations out
        afterward (what this used to do). Pruning during construction cuts
        off whole branches of the search tree before they're ever built,
        rather than paying to build them and then throwing them away -- a
        real cost on wide rows/columns/regions, where adjacent-cell
        rejections are common. The capacity check (which needs a complete
        combo to evaluate) still only runs once per surviving leaf, same
        as before. Mirrors solver-core.js's _enumerateUnitCompletions.
        """
        if quota is None:
            quota = p.stars_per_unit
        indices = unit["indices"]
        stars = [i for i in indices if p.grid[i] == "x"]
        needed = quota - len(stars)
        if needed <= 0:
            return None

        avail = [i for i in indices if p.grid[i] is None]
        if len(avail) < needed:
            return []
        if ENUMERATION_COMBO_CAP is not None and _estimate_combos(len(avail), needed, ENUMERATION_COMBO_CAP) > ENUMERATION_COMBO_CAP:
            return None

        valid = []
        chosen = []

        def try_from(start):
            if len(chosen) == needed:
                if not strong or self._combo_respects_capacity(p, chosen, unit, visible_board_idx):
                    valid.append(tuple(chosen))
                return
            # Not enough cells left in `avail` to reach `needed`: prune.
            if len(avail) - start < needed - len(chosen):
                return
            for i in range(start, len(avail)):
                cell = avail[i]
                if any(self._cells_adjacent(p, s, cell) for s in stars):
                    continue
                if any(self._cells_adjacent(p, c, cell) for c in chosen):
                    continue
                chosen.append(cell)
                try_from(i + 1)
                chosen.pop()

        try_from(0)
        return valid

    def _combo_respects_capacity(self, p, combo, unit, visible_board_idx):
        """
        Shared by _enumerate_unit_completions (strong mode) and
        _unit_has_valid_completion below: does placing `combo` (a complete,
        already adjacency-valid set of `unit`'s remaining stars) push any
        OTHER row/column/region past its star quota? (`unit` itself is
        exact by construction, so it's skipped.) Always checks against
        p.stars_per_unit, never a caller-supplied `quota` override -- see
        _enumerate_unit_completions' own docstring on why that's never
        overridden.
        """
        other_unit_counts = {}
        for cell in combo:
            for other_unit in p.units_by_cell[cell]:
                if other_unit["label"] == unit["label"]:
                    continue
                if (visible_board_idx is not None
                        and other_unit["board_idx"] is not None
                        and other_unit["board_idx"] != visible_board_idx):
                    continue
                other_unit_counts.setdefault(other_unit["label"], [0, other_unit])
                other_unit_counts[other_unit["label"]][0] += 1
        for add_count, other_unit in other_unit_counts.values():
            existing = sum(1 for i in other_unit["indices"] if p.grid[i] == "x")
            if existing + add_count > p.stars_per_unit:
                return False
        return True

    def _unit_has_valid_completion(self, p, unit, quota=None, visible_board_idx=None):
        """
        Cheap existence-only counterpart to _enumerate_unit_completions
        (always "strong" mode -- the only mode is_board_broken ever needs),
        for callers that only ask "does `unit` have AT LEAST ONE valid way
        to place its remaining stars", never the completions themselves.
        Short-circuits the same adjacency-pruned backtracking search the
        moment it finds one valid combo, instead of continuing to enumerate
        the rest. This is the main cost inside every lookahead-family rule
        (rule_lookahead_*, rule_lookahead_dots*): each speculative
        placement calls is_board_broken once, which checks EVERY row/
        column/region in turn, and the common case -- a unit that turns out
        not to be broken -- used to still pay for a full enumeration just
        to conclude "yes, completions exist"; existence usually resolves
        almost immediately instead.

        Returns True when `unit` is already at quota (needed <= 0) --
        matches _enumerate_unit_completions returning None there, which
        callers treat as "not broken" (over-quota is caught by a separate
        check). Mirrors solver-core.js's _unitHasValidCompletion.
        """
        if quota is None:
            quota = p.stars_per_unit
        indices = unit["indices"]
        stars = [i for i in indices if p.grid[i] == "x"]
        needed = quota - len(stars)
        if needed <= 0:
            return True

        avail = [i for i in indices if p.grid[i] is None]
        if len(avail) < needed:
            return False

        chosen = []

        def try_from(start):
            if len(chosen) == needed:
                return self._combo_respects_capacity(p, chosen, unit, visible_board_idx)
            if len(avail) - start < needed - len(chosen):
                return False
            for i in range(start, len(avail)):
                cell = avail[i]
                if any(self._cells_adjacent(p, s, cell) for s in stars):
                    continue
                if any(self._cells_adjacent(p, c, cell) for c in chosen):
                    continue
                chosen.append(cell)
                if try_from(i + 1):
                    return True
                chosen.pop()
            return False

        return try_from(0)

    def _cached_on_grid(self, p, cache_attr, compute_fn):
        """
        Small memoization helper: several expensive computations (unit
        completion enumeration, tiling scans, region/line guarantee
        tallies) independently trigger the SAME work when called more than
        once against an unchanged grid -- e.g. rule_unit_placement_forced_*
        alone calls _unit_completions_by_level for every unit up to 3 times
        per level (once per cond), and separate rules (rule_tile_*, the
        region/line quota-fill family) each ask the same underlying
        question again. Only one rule can succeed -- and mutate the grid --
        per round (see ScorerCore.solve), so a cache hit is always safe to
        reuse for as long as `key` stays keyed on a full grid snapshot
        rather than tracked mutation call sites.
        """
        cache = getattr(p, cache_attr, None)
        if cache is None:
            cache = {}
            setattr(p, cache_attr, cache)
        key = tuple(p.grid)
        if key not in cache:
            cache[key] = compute_fn()
        return cache[key]

    def _unit_completions_by_level(self, p, unit, level, quota=None):
        """
        Python port of solver-core.js's _unitCompletionsByLevel. Returns a
        list of "completion sets" for `unit` at the given difficulty level
        -- each entry is _enumerate_unit_completions' own return value
        (None: unit already at quota; []: that scope alone already finds
        the unit unsolvable; otherwise the valid combos). Used by rules
        that come in weak/intermediate/strong variants
        (rule_unit_placement_forced_cond):

         - 'weak': adjacency only, ignoring every other unit's capacity.
         - 'strong': full capacity check across every board's units at
           once -- a deduction found here may require combining both
           boards' region layouts.
         - 'intermediate': the capacity check restricted to ONE board's
           units at a time. A region only has one board to check (its
           own). A row/column has none, so it's checked once per board in
           turn, since its own capacity conflicts could come from either
           board's regions. A caller unions results across entries: if a
           deduction holds under ANY single board's view alone, that's the
           easier "intermediate" reasoning -- no need to combine both
           boards' information.

        Weak and strong always return a single-entry list (uniform shape
        with intermediate), so callers can treat all three levels
        identically.

        Cached per (unit, level, quota) for the current grid: this is the
        shared low-level primitive behind rule_unit_placement_forced_cond
        (via _get_placement_forced_combos, called up to 3x per level, once
        per cond, all asking the exact same question), the region/line
        guarantee family (_region_line_guarantees_impl,
        _region_line_partition_guarantees_impl -- each a separate full
        sweep over the same units at the same level), and
        rule_unit_completion_satisfies_other_unit -- without this, a
        single solve round can redo the same expensive enumeration for the
        same unit many times over, even though each of those callers
        already caches its OWN top-level result (that only avoids re-
        asking each OTHER, not the shared enumeration underneath).
        """
        cache_key = f"_unit_completions_cache_{unit['label']}_{level}_{quota}"
        return self._cached_on_grid(p, cache_key, lambda: self._unit_completions_by_level_impl(p, unit, level, quota))

    def _unit_completions_by_level_impl(self, p, unit, level, quota):
        if level == 'weak':
            return [self._enumerate_unit_completions(p, unit, strong=False, quota=quota)]
        if level == 'strong':
            return [self._enumerate_unit_completions(p, unit, strong=True, quota=quota)]
        scopes = [unit["board_idx"]] if unit["board_idx"] is not None else range(p.n_boards)
        return [
            self._enumerate_unit_completions(p, unit, strong=True, quota=quota, visible_board_idx=b_idx)
            for b_idx in scopes
        ]
