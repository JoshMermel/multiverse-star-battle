"""
engine.py

Core scoring engine: TIER_ORDER/_TIER_RANK, and ScorerCore -- the solve-loop
driver plus the handful of helpers that are genuinely shared by every
star-count rule family (unit-completion enumeration, contradiction
detection, validated cell writes). Every rule_* implementation itself lives
in rules_common.py / rules_single_star.py / rules_multi_star.py; see
composite_scorer.py for how they're assembled into CompositeScorer.
"""

from itertools import combinations

# Tier ordering for display and sorting. UNSOLVED sorts last.
TIER_ORDER = ["Beginner", "Medium", "Hard", "Symmetry", "Expert", "Grandmaster", "UNSOLVED"]
_TIER_RANK = {tier: i for i, tier in enumerate(TIER_ORDER)}


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

        Uses _enumerate_unit_completions(strong=True) for every unit to
        answer "is there at least one way to solve you given the placements
        of stars currently on the board?" -- i.e. can this row/column/region's
        remaining stars still be placed somewhere, respecting non-adjacency
        AND every other unit's remaining capacity. A unit still needing stars
        but with zero valid completions is a genuine contradiction: not just
        "no empty cells left", but also subtler cases like a region whose
        remaining candidates are (jointly, not just individually) boxed in by
        other rows/columns/regions that don't have room for them.

        `visible_board_idx`, when given, restricts every check (which units
        get scanned, and what _enumerate_unit_completions is allowed to
        reason about) to rows/columns and only that one board's regions --
        for the "single board" lookahead rules, which are meant to only rely
        on information visible from one board.
        """
        quota = p.stars_per_unit
        units = p.units if visible_board_idx is None else [
            u for u in p.units if u["board_idx"] is None or u["board_idx"] == visible_board_idx
        ]

        for unit in units:
            combos = self._enumerate_unit_completions(p, unit, strong=True, visible_board_idx=visible_board_idx)
            if combos is not None and len(combos) == 0:
                return True

        # _enumerate_unit_completions returns None once a unit is already at
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

        valid = []
        for combo in combinations(avail, needed):
            ok = True
            for idx1 in range(len(combo)):
                if any(self._cells_adjacent(p, s, combo[idx1]) for s in stars):
                    ok = False
                    break
                for idx2 in range(idx1 + 1, len(combo)):
                    if self._cells_adjacent(p, combo[idx1], combo[idx2]):
                        ok = False
                        break
                if not ok:
                    break
            if not ok:
                continue

            if strong:
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
                overloaded = False
                for add_count, other_unit in other_unit_counts.values():
                    existing = sum(1 for i in other_unit["indices"] if p.grid[i] == "x")
                    if existing + add_count > p.stars_per_unit:
                        overloaded = True
                        break
                if overloaded:
                    continue

            valid.append(combo)
        return valid
