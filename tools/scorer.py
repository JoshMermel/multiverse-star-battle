"""
scorer.py

Rule-based difficulty scorer for Multiverse Star Battle puzzles.

Simulates human solving by applying logic rules in order of difficulty,
tracking both the total score and the highest-tier rule needed.
"""

import string
from itertools import combinations

from board_utils import VOID_CHAR, get_neighbors_8


# Tier ordering for display and sorting. UNSOLVED sorts last.
TIER_ORDER = ["Beginner", "Medium", "Hard", "Symmetry", "Expert", "Grandmaster", "UNSOLVED"]
_TIER_RANK = {tier: i for i, tier in enumerate(TIER_ORDER)}

# Number of boards in a Multiverse Star Battle puzzle.
N_BOARDS = 2


class StarBattlePuzzle:
    """Holds the mutable solving state for one puzzle during scoring."""

    def __init__(self, n, board_1, board_2, solution_str, name):
        self.name = name
        self.n = n
        self.grid = [None] * (n * n)
        self.canonical_solution = solution_str

        # Voids: cells that belong to no region and can never hold a star.
        # Both boards must share the same void mask (voids are a property of
        # the puzzle layout, not of individual boards).
        self.void_cells = frozenset(
            i for i, ch in enumerate(board_1) if ch == VOID_CHAR
        )

        # Pre-fill void cells as dots so the solver never considers them.
        for i in self.void_cells:
            self.grid[i] = "."

        self.regions = [self._map_regions(board_1), self._map_regions(board_2)]

        # Row/col index lists exclude void cells so that constraint checks
        # (e.g. "does this row still need a star?") only consider live cells.
        self.row_indices = [
            [r * n + c for c in range(n) if (r * n + c) not in self.void_cells]
            for r in range(n)
        ]
        self.col_indices = [
            [r * n + c for r in range(n) if (r * n + c) not in self.void_cells]
            for c in range(n)
        ]
        self.cell_to_region = [list(board_1), list(board_2)]
        # Precomputed as sets for O(1) membership tests in _sees_too_much_n
        # and rule_triomino.
        self.region_sets = [
            {char: set(idxs) for char, idxs in self.regions[b].items()}
            for b in range(N_BOARDS)
        ]
        self._neighbor_map = {i: get_neighbors_8(i, n) for i in range(n * n)}
        self.diagonal_symmetries = self._detect_diagonal_symmetries()
        self.has_main_diagonal_symmetry  = self._detect_single_diagonal_symmetry(0)
        self.has_anti_diagonal_symmetry  = self._detect_single_diagonal_symmetry(1)
        self.has_internal_rotation_180 = self._detect_internal_rotation_180()
        self.has_crossboard_rotation_180 = self._detect_crossboard_rotation_180()

    def _map_regions(self, board_str):
        """Builds region→[cell_idx] mapping, skipping void cells."""
        mapping = {}
        for idx, char in enumerate(board_str):
            if char != VOID_CHAR:
                mapping.setdefault(char, []).append(idx)
        return mapping

    def get_rc(self, idx):
        return divmod(idx, self.n)

    def get_row_indices(self, r):
        """Returns the precomputed cell indices for row r."""
        return self.row_indices[r]

    def get_col_indices(self, c):
        """Returns the precomputed cell indices for column c."""
        return self.col_indices[c]

    def copy_grid(self):
        """Returns a shallow copy of the grid list (sufficient for lookahead)."""
        return list(self.grid)

    def restore_grid(self, saved):
        """Restores the grid from a previously saved copy."""
        self.grid[:] = saved

    def validate_and_set(self, idx, value, rule_name, verbose=False):
        """Sets a cell, validating against the canonical solution. Returns 1 if newly set."""
        expected = self.canonical_solution[idx]
        if expected != value:
            r, c = self.get_rc(idx)
            coord = f"{string.ascii_uppercase[c]}{r+1}"
            raise ValueError(
                f"Logic error in {rule_name}: inferred {value} at {coord}, expected {expected}"
            )
        if self.grid[idx] is None:
            self.grid[idx] = value
            if verbose:
                r, c = self.get_rc(idx)
                coord = f"{string.ascii_uppercase[c]}{r+1}"
                print(f"  [{rule_name}] {value} -> {coord}")
            return 1
        return 0

    # -- Symmetry detection ---------------------------------------------------
    #
    # All four detectors share the same pairwise equivalence check: for every
    # pair (i, j), "i and j are in the same region" must equal "mirror(i) and
    # mirror(j) are in the same region (on the appropriate board)".  The two
    # parameters that vary are:
    #   - which board(s) to check  (cross-board vs. each board independently)
    #   - which board supplies the mirrored lookup
    #
    # _check_pairwise_symmetry captures this pattern once.

    def _check_pairwise_symmetry(self, mirror_fn, src_board, dst_board):
        """
        Returns True if, for every pair (i, j):
          same_region(src_board, i, j)  ==  same_region(dst_board, mirror(i), mirror(j))

        Set src_board == dst_board to test a single board's internal symmetry.
        Set src_board=0, dst_board=1 (or vice versa) to test cross-board symmetry.

        Void cells are skipped: a void is in no region and its mirror is
        expected to also be void, so including them adds no information and
        would cause spurious mismatches if the void mask is not itself symmetric.
        """
        total = self.n * self.n
        src = self.cell_to_region[src_board]
        dst = self.cell_to_region[dst_board]
        for i in range(total):
            if i in self.void_cells:
                continue
            mi = mirror_fn(i)
            if mi in self.void_cells:
                continue
            for j in range(i + 1, total):
                if j in self.void_cells:
                    continue
                mj = mirror_fn(j)
                if mj in self.void_cells:
                    continue
                if (src[i] == src[j]) != (dst[mi] == dst[mj]):
                    return False
        return True

    def _detect_single_diagonal_symmetry(self, candidate_idx):
        """
        Returns True if the diagonal symmetry at candidates[candidate_idx]
        applies (either cross-board or internal).
        candidate_idx 0 = main diagonal, 1 = anti-diagonal.
        """
        n = self.n
        candidates = [
            lambda i, n=n: (i % n) * n + (i // n),
            lambda i, n=n: (n-1 - i % n) * n + (n-1 - i // n),
        ]
        fn = candidates[candidate_idx]
        cross_board = self._check_pairwise_symmetry(fn, src_board=0, dst_board=1)
        internal = (
            self._check_pairwise_symmetry(fn, src_board=0, dst_board=0)
            and self._check_pairwise_symmetry(fn, src_board=1, dst_board=1)
        )
        return cross_board or internal

    def _detect_diagonal_symmetries(self):
        n = self.n
        candidates = [
            lambda i, n=n: (i % n) * n + (i // n),           # main diagonal
            lambda i, n=n: (n-1 - i % n) * n + (n-1 - i // n),  # anti-diagonal
        ]
        # A diagonal symmetry applies if either:
        #   (a) board 2 is a diagonal reflection of board 1 (cross-board), OR
        #   (b) both boards independently have that diagonal symmetry (internal).
        # In both cases uniqueness forces the solution to respect the symmetry.
        result = []
        for fn in candidates:
            cross_board = self._check_pairwise_symmetry(fn, src_board=0, dst_board=1)
            internal = (
                self._check_pairwise_symmetry(fn, src_board=0, dst_board=0)
                and self._check_pairwise_symmetry(fn, src_board=1, dst_board=1)
            )
            if cross_board or internal:
                result.append(fn)
        return result

    def _detect_internal_rotation_180(self):
        """True if BOTH boards independently have 180-degree rotational symmetry."""
        total = self.n * self.n
        mirror_fn = lambda i: total - 1 - i
        return (
            self._check_pairwise_symmetry(mirror_fn, src_board=0, dst_board=0)
            and self._check_pairwise_symmetry(mirror_fn, src_board=1, dst_board=1)
        )

    def _detect_crossboard_rotation_180(self):
        """True if board 2 is a 180-degree rotation of board 1."""
        total = self.n * self.n
        mirror_fn = lambda i: total - 1 - i
        return self._check_pairwise_symmetry(mirror_fn, src_board=0, dst_board=1)


class CompositeScorer:
    """
    Scores Star Battle puzzles by simulating rule-based solving.
    Each rule has a weight (cost to apply) and a tier (difficulty level).
    The scorer tracks both total score and the highest tier rule used.

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
        # Each entry: (rule_func, weight, tier)
        self.rules = [
            # -- Beginner -----------------------------------------------------
            (self.rule_only_empty,                          1,  "Beginner"),
            (self.rule_sees_star,                           1,  "Beginner"),
            (self.rule_domino,                              5,  "Beginner"),
            (self.rule_triomino,                            7,  "Beginner"),
            (self.rule_1_row,                               10, "Beginner"),
            (self.rule_1_col,                               10, "Beginner"),

            # -- Medium -------------------------------------------------------
            (self.rule_sees_too_much_pair,                  12, "Medium"),
            (self.rule_sees_too_much_trio,                  15, "Medium"),
            (self.rule_sees_too_much,                       18, "Medium"),
            (self.rule_2_adjacent_rows,                     20, "Medium"),
            (self.rule_2_adjacent_cols,                     20, "Medium"),
            (self.rule_main_diagonal_fill,                  20, "Medium"),
            (self.rule_anti_diagonal_fill,                  20, "Medium"),
            (self.rule_rotation_180_fill,                   20, "Medium"),

            # -- Hard ---------------------------------------------------------
            (self.rule_3_adjacent_rows,                     25, "Hard"),
            (self.rule_3_adjacent_cols,                     25, "Hard"),
            (self.rule_2_disjoint_rows,                     30, "Hard"),
            (self.rule_2_disjoint_cols,                     30, "Hard"),
            (self.rule_many_adjacent_rows,                  35, "Hard"),
            (self.rule_many_adjacent_cols,                  35, "Hard"),
            (self.rule_region_contains_region,              40, "Hard"),

            # -- Symmetry - requires insight but not hard to apply -----------
            (self.rule_rotation_180,                        5, "Symmetry"),
            (self.rule_diagonal_symmetry,                   5, "Symmetry"),
            (self.rule_diagonal_parity,                      15, "Symmetry"),

            # -- Expert -------------------------------------------------------
            (self.rule_3_disjoint_rows,                     45, "Expert"),
            (self.rule_3_disjoint_cols,                     45, "Expert"),
            (self.rule_2_region_pinned_crossboard_rows,     50, "Expert"),
            (self.rule_2_region_pinned_crossboard_cols,     50, "Expert"),
            (self.rule_3_region_pinned_crossboard_rows,     60, "Expert"),
            (self.rule_3_region_pinned_crossboard_cols,     60, "Expert"),
            (self.rule_crossboard_partial_overlap,          75, "Expert"),
            (self.rule_lookahead_half_stage_single_board,   78, "Expert"),
            (self.rule_lookahead_half_stage,                80, "Expert"),
            (self.rule_region_pair_contains_pair,           90, "Expert"),

            # -- Grandmaster --------------------------------------------------
            (self.rule_lookahead_1_stage,                   120, "Grandmaster"),
            (self.rule_lookahead_2_stages,                  250, "Grandmaster"),
            # _lookahead_n_stages with a high stage count runs until the
            # propagation reaches a fixed point, so "3 stages" is a floor,
            # not a ceiling.  The name describes the minimum depth guaranteed.
            (self.rule_lookahead_3_stages,                  550, "Grandmaster"),
        ]

    # -- Core solver ----------------------------------------------------------

    def solve(self, puzzle):
        """
        Attempts to solve the puzzle using the rule list in order.
        Returns (is_solved, total_score, max_tier).
        """
        if self.verbose:
            print(f"\n--- Solving: {puzzle.name} ---")

        total_score = 0
        max_tier = "Beginner"

        try:
            while True:
                round_changes = 0
                for rule_func, weight, tier in self.rules:
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

    def is_board_broken(self, p):
        all_units = (p.row_indices + p.col_indices +
                     [idxs for b in p.regions for idxs in b.values()])
        for unit in all_units:
            stars = sum(1 for i in unit if p.grid[i] == "x")
            has_empty = any(p.grid[i] is None for i in unit)
            if stars > 1:
                return True
            if stars == 0 and not has_empty:
                return True
        for i, val in enumerate(p.grid):
            if val == "x":
                if any(p.grid[nb] == "x" for nb in p._neighbor_map[i]):
                    return True
        return False

    # -- Rules ----------------------------------------------------------------

    def rule_sees_star(self, p, silent=False):
        """
        Propagates row/col/region/adjacency exclusions from each placed star.

        In non-silent mode, returns after the first star that produces changes
        so the main loop can re-evaluate rule priority. In silent mode (used
        by lookahead), accumulates all consequences before returning.
        """
        changes = 0
        for s_idx, val in enumerate(p.grid):
            if val != "x":
                continue
            sr, sc = p.get_rc(s_idx)
            star_changes = 0

            for nb in p._neighbor_map[s_idx]:
                star_changes += self._internal_set(p, nb, ".", "Adjacency", silent)

            for i in p.row_indices[sr] + p.col_indices[sc]:
                star_changes += self._internal_set(p, i, ".", "Row/Col Limit", silent)

            for b_idx in range(N_BOARDS):
                reg_char = p.cell_to_region[b_idx][s_idx]
                for i in p.regions[b_idx][reg_char]:
                    star_changes += self._internal_set(
                        p, i, ".", f"Reg {reg_char} full", silent)

            changes += star_changes
            if not silent and star_changes > 0:
                return star_changes

        return changes

    def rule_only_empty(self, p, silent=False):
        """Places a star if only one valid cell remains in a unit or region."""
        all_units = (p.row_indices + p.col_indices +
                     [idxs for b in p.regions for idxs in b.values()])
        for unit in all_units:
            if any(p.grid[i] == "x" for i in unit):
                continue
            empty = [i for i in unit if p.grid[i] is None]
            if len(empty) == 1:
                res = self._internal_set(p, empty[0], "x", "Only empty cell", silent)
                if not silent and res > 0:
                    return res
        return 0

    def rule_domino(self, p):
        """
        MATCH: A unit/region with no star and exactly two orthogonally adjacent empty cells.
        ACTION: Marks cells that see both domino cells as dots.
        """
        containers = (
            [(p.get_row_indices(r), f"Row {r+1}") for r in range(p.n)] +
            [(p.get_col_indices(c), f"Col {string.ascii_uppercase[c]}") for c in range(p.n)] +
            [(idxs, f"B{b+1} Reg {rc}")
             for b in range(N_BOARDS) for rc, idxs in p.regions[b].items()]
        )
        for idxs, label in containers:
            if any(p.grid[i] == "x" for i in idxs):
                continue
            empty = [i for i in idxs if p.grid[i] is None]
            if len(empty) != 2:
                continue
            i1, i2 = empty
            r1, c1 = p.get_rc(i1)
            r2, c2 = p.get_rc(i2)
            if not ((abs(r1-r2) == 1 and c1 == c2) or (abs(c1-c2) == 1 and r1 == r2)):
                continue

            def can_see(r, c, tr, tc):
                return r == tr or c == tc or (abs(r-tr) <= 1 and abs(c-tc) <= 1)

            exclusion = {i1, i2}
            local_changes = 0
            for i in range(p.n * p.n):
                if p.grid[i] is not None or i in exclusion:
                    continue
                ir, ic = p.get_rc(i)
                if can_see(ir, ic, r1, c1) and can_see(ir, ic, r2, c2):
                    local_changes += p.validate_and_set(
                        i, ".", f"{label} domino shadow", self.verbose)
            if local_changes > 0:
                return local_changes
        return 0

    def rule_triomino(self, p):
        """
        MATCH: An unsolved row or column with any number of empty cells.
        ACTION: Any external cell that sees ALL empty cells in the unit must be a dot.
        """
        all_units = (
            [(p.get_row_indices(r), f"Row {r+1}") for r in range(p.n)] +
            [(p.get_col_indices(c), f"Col {string.ascii_uppercase[c]}") for c in range(p.n)]
        )
        for idxs, label in all_units:
            if any(p.grid[i] == "x" for i in idxs):
                continue
            candidates = [i for i in idxs if p.grid[i] is None]
            if not candidates:
                continue
            idxs_set = set(idxs)
            cand_coords = [p.get_rc(i) for i in candidates]
            local_changes = 0
            for i in range(p.n * p.n):
                if p.grid[i] is not None or i in idxs_set:
                    continue
                ir, ic = p.get_rc(i)
                if all(ir == tr or ic == tc or (abs(ir-tr) <= 1 and abs(ic-tc) <= 1)
                       for tr, tc in cand_coords):
                    local_changes += p.validate_and_set(
                        i, ".", f"{label} unit_sees_too_much", self.verbose)
            if local_changes > 0:
                return local_changes
        return 0

    def rule_sees_too_much_pair(self, p):
        """MATCH: Region with exactly 2 empty cells. ACTION: External cells seeing both are dots."""
        return self._sees_too_much_n(p, n_target=2, label_suffix="pair")

    def rule_sees_too_much_trio(self, p):
        """MATCH: Region with exactly 3 empty cells. ACTION: External cells seeing all three are dots."""
        return self._sees_too_much_n(p, n_target=3, label_suffix="trio")

    def rule_sees_too_much(self, p):
        """MATCH: Region with 4+ empty cells. ACTION: External cells seeing all are dots."""
        return self._sees_too_much_n(p, n_min=4, label_suffix="general")

    def _sees_too_much_n(self, p, n_target=None, n_min=None, label_suffix=""):
        changes = 0
        for b_idx in range(N_BOARDS):
            for r_char, r_indices in p.regions[b_idx].items():
                if any(p.grid[i] == "x" for i in r_indices):
                    continue
                candidates = [i for i in r_indices if p.grid[i] is None]
                if n_target is not None and len(candidates) != n_target:
                    continue
                if n_min is not None and len(candidates) < n_min:
                    continue
                r_indices_set = p.region_sets[b_idx][r_char]
                cand_coords = [p.get_rc(c) for c in candidates]
                for i in range(p.n * p.n):
                    if p.grid[i] is not None or i in r_indices_set:
                        continue
                    ir, ic = p.get_rc(i)
                    if all(ir == tr or ic == tc or (abs(ir-tr) <= 1 and abs(ic-tc) <= 1)
                           for tr, tc in cand_coords):
                        changes += p.validate_and_set(
                            i, ".",
                            f"sees_too_much_{label_suffix} (B{b_idx+1} Reg {r_char})",
                            self.verbose)
        return changes

    def rule_region_contains_region(self, p):
        return self._rule_region_combo_contains_region_combo(p, 1)

    def rule_region_pair_contains_pair(self, p):
        return self._rule_region_combo_contains_region_combo(p, 2)

    def _rule_region_combo_contains_region_combo(self, p, n):
        combo_sets = []
        for b_idx in range(N_BOARDS):
            regions = p.regions[b_idx]
            for chars in combinations(list(regions.keys()), n):
                if any(any(p.grid[i] == "x" for i in regions[c]) for c in chars):
                    continue
                available_idxs = {
                    i for c in chars for i in regions[c] if p.grid[i] is None
                }
                if not available_idxs:
                    continue
                combo_sets.append({
                    "label": "B{} Combo({})".format(b_idx + 1, ",".join(chars)),
                    "available_idxs": available_idxs,
                    "board": b_idx,
                })

        for i, set_a in enumerate(combo_sets):
            for j, set_b in enumerate(combo_sets):
                if i == j or set_a["board"] == set_b["board"]:
                    continue
                if set_a["available_idxs"].issubset(set_b["available_idxs"]):
                    extra = set_b["available_idxs"] - set_a["available_idxs"]
                    local_changes = sum(
                        p.validate_and_set(
                            idx, ".",
                            "{} contains {}".format(set_b["label"], set_a["label"]),
                            self.verbose)
                        for idx in extra if p.grid[idx] is None
                    )
                    if local_changes > 0:
                        return local_changes
        return 0

    def rule_1_row(self, p):
        return self._rule_n_unit_region_sync(p, n=1, axis="row")

    def rule_1_col(self, p):
        return self._rule_n_unit_region_sync(p, n=1, axis="col")

    def rule_2_adjacent_rows(self, p):
        return self._rule_n_unit_region_sync(p, n=2, axis="row")

    def rule_2_adjacent_cols(self, p):
        return self._rule_n_unit_region_sync(p, n=2, axis="col")

    def rule_3_adjacent_rows(self, p):
        return self._rule_n_unit_region_sync(p, n=3, axis="row")

    def rule_3_adjacent_cols(self, p):
        return self._rule_n_unit_region_sync(p, n=3, axis="col")

    def rule_many_adjacent_rows(self, p):
        for n in range(4, p.n):
            changes = self._rule_n_unit_region_sync(p, n, axis="row")
            if changes > 0:
                return changes
        return 0

    def rule_many_adjacent_cols(self, p):
        for n in range(4, p.n):
            changes = self._rule_n_unit_region_sync(p, n, axis="col")
            if changes > 0:
                return changes
        return 0

    def _rule_n_unit_region_sync(self, p, n, axis):
        units = p.row_indices if axis == "row" else p.col_indices
        starless_units = {u for u in range(p.n)
                          if not any(p.grid[i] == "x" for i in units[u])}
        for b_idx in range(N_BOARDS):
            regions = p.regions[b_idx]
            unsolved_regs = [c for c, idxs in regions.items()
                             if not any(p.grid[i] == "x" for i in idxs)]
            for start_u in range(p.n - n + 1):
                u_range = range(start_u, start_u + n)
                if not all(u in starless_units for u in u_range):
                    continue
                unit_idxs = set().union(*(units[u] for u in u_range))
                required_count = n
                avail_in_units = [i for i in unit_idxs if p.grid[i] is None]
                if not avail_in_units:
                    continue
                changes = self._apply_pin_rule(
                    p, b_idx, unit_idxs, avail_in_units, unsolved_regs,
                    required_count, f"{n}-unit {axis} window starting {start_u}")
                if changes > 0:
                    return changes
        return 0

    def rule_2_disjoint_rows(self, p):
        return self._rule_disjoint_unit_region_sync(p, n=2, axis="row")

    def rule_2_disjoint_cols(self, p):
        return self._rule_disjoint_unit_region_sync(p, n=2, axis="col")

    def rule_3_disjoint_rows(self, p):
        return self._rule_disjoint_unit_region_sync(p, n=3, axis="row")

    def rule_3_disjoint_cols(self, p):
        return self._rule_disjoint_unit_region_sync(p, n=3, axis="col")

    def _rule_disjoint_unit_region_sync(self, p, n, axis):
        """
        MATCH: N disjoint (not necessarily adjacent) units whose available
        cells are covered by exactly N unsolved regions, or vice versa.
        ACTION: Marks cells outside the intersection as dots.
        """
        units = p.row_indices if axis == "row" else p.col_indices
        starless_units = {u for u in range(p.n)
                          if not any(p.grid[i] == "x" for i in units[u])}
        for b_idx in range(N_BOARDS):
            regions = p.regions[b_idx]
            unsolved_regs = [c for c, idxs in regions.items()
                             if not any(p.grid[i] == "x" for i in idxs)]
            for combo in combinations(starless_units, n):
                unit_idxs = set().union(*(units[u] for u in combo))
                required_count = n
                avail_in_units = [i for i in unit_idxs if p.grid[i] is None]
                if not avail_in_units:
                    continue
                changes = self._apply_pin_rule(
                    p, b_idx, unit_idxs, avail_in_units, unsolved_regs,
                    required_count, f"disjoint {n}-{axis} combo {combo}")
                if changes > 0:
                    return changes
        return 0

    def _apply_pin_rule(self, p, b_idx, unit_idxs, avail_in_units,
                        unsolved_regs, required_count, label):
        """
        Shared logic for the pinning family of rules.

        Standard case: if exactly `required_count` unsolved regions have ALL
        their available cells inside unit_idxs, every other cell in unit_idxs
        can be eliminated.

        Inverse case: if the available cells in unit_idxs are covered by
        exactly `required_count` unsolved regions, every cell in those regions
        outside unit_idxs can be eliminated.

        Returns the number of newly set cells, or 0 if no deduction was made.

        Note: the walrus operator in the list comprehension below (avail :=)
        captures the available-cell list so it can be reused in the all()
        check on the same line without computing it twice.  Requires Python 3.8+.
        """
        regions = p.regions[b_idx]

        # Standard: regions trapped inside the window
        pinned_regs = [
            c for c in unsolved_regs
            if (avail := [i for i in regions[c] if p.grid[i] is None])
            and all(i in unit_idxs for i in avail)
        ]
        if len(pinned_regs) == required_count:
            reg_union = set().union(*(regions[c] for c in pinned_regs))
            changes = sum(
                p.validate_and_set(idx, ".", f"Pin({label})", self.verbose)
                for idx in unit_idxs if idx not in reg_union and p.grid[idx] is None
            )
            if changes > 0:
                return changes

        # Inverse: window trapped inside regions
        covering_regs = {p.cell_to_region[b_idx][i] for i in avail_in_units}
        covering_unsolved = [r for r in covering_regs if r in unsolved_regs]
        if len(covering_unsolved) == required_count:
            reg_union = set().union(*(regions[c] for c in covering_unsolved))
            changes = sum(
                p.validate_and_set(idx, ".", f"InvPin({label})", self.verbose)
                for idx in (reg_union - unit_idxs) if p.grid[idx] is None
            )
            if changes > 0:
                return changes

        return 0

    def rule_2_region_pinned_crossboard_rows(self, p):
        return self._rule_crossboard_n_region_pinned(p, n=2, axis="row")

    def rule_2_region_pinned_crossboard_cols(self, p):
        return self._rule_crossboard_n_region_pinned(p, n=2, axis="col")

    def rule_3_region_pinned_crossboard_rows(self, p):
        return self._rule_crossboard_n_region_pinned(p, n=3, axis="row")

    def rule_3_region_pinned_crossboard_cols(self, p):
        return self._rule_crossboard_n_region_pinned(p, n=3, axis="col")

    def _rule_crossboard_n_region_pinned(self, p, n, axis):
        """
        MATCH: N disjoint regions (from any board) whose available cells all
        fall in the same N adjacent rows/cols.
        ACTION: All other cells in those rows/cols are dots.
        """
        unsolved_regions = []
        for b_idx in range(N_BOARDS):
            for r_char, idxs in p.regions[b_idx].items():
                available = [i for i in idxs if p.grid[i] is None]
                if available and not any(p.grid[i] == "x" for i in idxs):
                    unsolved_regions.append({
                        "label": f"B{b_idx+1}-Reg{r_char}",
                        "all_idxs": set(idxs),
                        "available_idxs": available,
                    })

        if len(unsolved_regions) < n:
            return 0

        for combo in combinations(unsolved_regions, n):
            if not self._are_disjoint([r["all_idxs"] for r in combo]):
                continue
            all_available = [i for r in combo for i in r["available_idxs"]]
            occupied_units = {
                p.get_rc(idx)[0] if axis == "row" else p.get_rc(idx)[1]
                for idx in all_available
            }
            if len(occupied_units) != n:
                continue
            u_list = sorted(occupied_units)
            if u_list[-1] - u_list[0] != n - 1:
                continue

            unit_indices = [
                i for u in u_list
                for i in (p.get_row_indices(u) if axis == "row" else p.get_col_indices(u))
            ]
            region_union = set().union(*(r["all_idxs"] for r in combo))
            labels = ", ".join(r["label"] for r in combo)
            changes = sum(
                p.validate_and_set(
                    idx, ".",
                    f"Cross-Board {axis.capitalize()} Pin ({labels})",
                    self.verbose)
                for idx in unit_indices
                if idx not in region_union and p.grid[idx] is None
            )
            if changes > 0:
                return changes
        return 0

    def _are_disjoint(self, set_list):
        seen = set()
        for s in set_list:
            if not s.isdisjoint(seen):
                return False
            seen.update(s)
        return True

    def rule_crossboard_partial_overlap(self, p):
        """
        MATCH: Two regions (one per board) that partially overlap, where every
        cell in onlyA sees every cell in onlyB (and vice versa, which is
        symmetric).
        ACTION: Those non-shared cells (onlyA | onlyB) must be dots.

        Reasoning: if regA's star landed in onlyA it would eliminate all shared
        cells (same region) and, because it sees all of onlyB, would leave regB
        with no valid cell — contradiction. Symmetrically for regB. So both
        stars must land in the shared cells.

        Two cells see each other when a star in one eliminates the other:
        same row, same column, or 8-adjacent.

        The old check (all non-shared cells in one row/col) is a strict subset
        of this condition and is no longer needed separately.
        """
        def sees(i, j):
            ri, ci = p.get_rc(i)
            rj, cj = p.get_rc(j)
            return ri == rj or ci == cj or (abs(ri - rj) <= 1 and abs(ci - cj) <= 1)

        unsolved_b1 = [c for c, idxs in p.regions[0].items()
                       if not any(p.grid[i] == "x" for i in idxs)]
        unsolved_b2 = [c for c, idxs in p.regions[1].items()
                       if not any(p.grid[i] == "x" for i in idxs)]

        for r1_char in unsolved_b1:
            r1_avail = {i for i in p.regions[0][r1_char] if p.grid[i] is None}
            if not r1_avail:
                continue
            for r2_char in unsolved_b2:
                r2_avail = {i for i in p.regions[1][r2_char] if p.grid[i] is None}
                if not r2_avail:
                    continue
                only_a = r1_avail - r2_avail
                only_b = r2_avail - r1_avail
                if not (r1_avail & r2_avail) or not (only_a or only_b):
                    continue
                # Every cell in onlyA must see every cell in onlyB.
                if not all(sees(a, b) for a in only_a for b in only_b):
                    continue
                disjoint = only_a | only_b
                changes = sum(
                    p.validate_and_set(
                        idx, ".",
                        f"Cross-board partial overlap R1:{r1_char}/R2:{r2_char}",
                        self.verbose)
                    for idx in disjoint if p.grid[idx] is None
                )
                if changes > 0:
                    return changes
        return 0

    def rule_lookahead_half_stage_single_board(self, p):
        """
        Place a star speculatively, propagate row/col/adjacency consequences
        (board-agnostic), then apply only ONE board's region elimination for
        the test cell — and check whether that single board's view already
        yields a contradiction.

        This is strictly cheaper reasoning than rule_lookahead_half_stage:
        the contradiction is visible from a single board's perspective alone,
        without needing to combine region information from both boards.

        Two separate sandbox passes are run per candidate cell (one per board),
        each dotting out only that board's region for the test cell.
        A contradiction is accepted only if the broken unit belongs to the
        same board being tested (or is a row/col/adjacency violation, which
        is board-agnostic geometry).
        """
        for test_idx in (i for i, val in enumerate(p.grid) if val is None):
            for b_idx in range(N_BOARDS):
                # Find the region this cell belongs to on b_idx.
                reg_char = p.cell_to_region[b_idx][test_idx]
                reg_indices = p.regions[b_idx][reg_char]

                # Skip if this board's region already has a star (it's solved).
                if any(p.grid[i] == "x" for i in reg_indices):
                    continue

                saved = p.copy_grid()
                p.grid[test_idx] = "x"

                tr, tc = p.get_rc(test_idx)

                # Row and column elimination (board-agnostic).
                for i in p.row_indices[tr] + p.col_indices[tc]:
                    if p.grid[i] is None:
                        p.grid[i] = "."

                # Adjacency elimination (board-agnostic).
                for nb in p._neighbor_map[test_idx]:
                    if p.grid[nb] is None:
                        p.grid[nb] = "."

                # Region elimination for this board only.
                for i in reg_indices:
                    if p.grid[i] is None:
                        p.grid[i] = "."

                broken = self._find_broken_unit_single_board(p, b_idx)
                p.restore_grid(saved)

                if broken:
                    changes = p.validate_and_set(
                        test_idx, ".",
                        f"Half-stage single-board (B{b_idx+1}) lookahead contradiction",
                        self.verbose)
                    if changes > 0:
                        return changes
        return 0

    # experimental
    def _find_broken_unit_single_board(self, p, b_idx):
        """
        Returns True if the current grid state contains a contradiction that
        is visible from board b_idx alone: a row or column with no star and no
        empty cells, a region on b_idx with no star and no empty cells, or two
        adjacent stars.

        Broken regions on the *other* board are deliberately ignored, since
        detecting those requires cross-board region reasoning.
        """
        # Rows and columns are board-agnostic geometry — include them.
        for unit in p.row_indices + p.col_indices:
            stars = sum(1 for i in unit if p.grid[i] == "x")
            has_empty = any(p.grid[i] is None for i in unit)
            if stars > 1:
                return True
            if stars == 0 and not has_empty:
                return True

        # Only check regions belonging to b_idx.
        for reg_indices in p.regions[b_idx].values():
            stars = sum(1 for i in reg_indices if p.grid[i] == "x")
            has_empty = any(p.grid[i] is None for i in reg_indices)
            if stars > 1:
                return True
            if stars == 0 and not has_empty:
                return True

        # Adjacency violations are always local.
        for i, val in enumerate(p.grid):
            if val == "x":
                if any(p.grid[nb] == "x" for nb in p._neighbor_map[i]):
                    return True

        return False

    def rule_lookahead_half_stage(self, p):
        """Place star, apply sees_star consequences only, check for contradiction."""
        return self._lookahead_n_stages(p, n_stages=0, extra_half_stage=True)

    def rule_lookahead_1_stage(self, p):
        return self._lookahead_n_stages(p, n_stages=1)

    def rule_lookahead_2_stages(self, p):
        return self._lookahead_n_stages(p, n_stages=2)

    def rule_lookahead_3_stages(self, p):
        # High stage count runs propagation to a fixed point; "3" is a
        # minimum depth, not an exact count.  See rules table comment.
        return self._lookahead_n_stages(p, n_stages=10)

    def _lookahead_n_stages(self, p, n_stages, extra_half_stage=False):
        """
        For each empty cell, hypothetically place a star there and propagate
        consequences for n_stages rounds. If a contradiction results, that
        cell must be a dot.

        Uses copy_grid/restore_grid instead of deepcopy to avoid copying the
        large precomputed neighbor map and region dicts.
        """
        for test_idx in (i for i, val in enumerate(p.grid) if val is None):
            saved = p.copy_grid()
            p.grid[test_idx] = "x"
            broken = False

            for _ in range(n_stages):
                self.rule_sees_star(p, silent=True)
                self.rule_only_empty(p, silent=True)
                if self.is_board_broken(p):
                    broken = True
                    break

            if not broken and extra_half_stage:
                self.rule_sees_star(p, silent=True)
                if self.is_board_broken(p):
                    broken = True

            p.restore_grid(saved)

            if broken:
                changes = p.validate_and_set(
                    test_idx, ".",
                    f"{n_stages}-stage Lookahead contradiction",
                    self.verbose)
                if changes > 0:
                    return changes
        return 0

    # -- Symmetry fill rules --------------------------------------------------
    #
    # These rules propagate already-known cell states (star or dot) to their
    # symmetric counterparts.  They are the scoring-engine equivalent of the
    # JS hintMainDiagonalFill / hintAntiDiagonalFill / hintRotation180Fill
    # hints.
    #
    # Logic (mirrors _hintSymmetryFill in solver.js):
    #   For every empty cell i, look at mirror(i).
    #   - If mirror(i) is a star  → i must also be a star (copy it).
    #   - If mirror(i) is a dot   → i must also be a dot  (copy it).
    # Stars are propagated first (they are stronger deductions); dots are only
    # returned if no star copies were found, matching the JS behaviour.

    def _symmetry_fill(self, p, mirror_fn, rule_name):
        """
        Copy known star/dot placements from mirror_fn(i) → i for all empty i.

        Returns the number of newly set cells, prioritising stars over dots
        (returns as soon as one star is copied; accumulates all dot copies).
        """
        total = p.n * p.n
        star_copies = []
        dot_copies  = []

        for i in range(total):
            if p.grid[i] is not None:
                continue
            mirror = mirror_fn(i)
            if mirror == i:
                continue
            if p.grid[mirror] == "x":
                star_copies.append(i)
            elif p.grid[mirror] == ".":
                dot_copies.append(i)

        # Stars first — return immediately after the first validated star so
        # the main solve loop can re-prioritise rules (same pattern as other
        # rules that call validate_and_set).
        for i in star_copies:
            changes = p.validate_and_set(i, "x", rule_name, self.verbose)
            if changes > 0:
                return changes

        # Dots: accumulate and return the batch count.
        changes = 0
        for i in dot_copies:
            changes += p.validate_and_set(i, ".", rule_name, self.verbose)
        return changes

    def rule_main_diagonal_fill(self, p):
        """
        MATCH: Puzzle has main-diagonal (↘) symmetry AND a cell whose mirror
        already has a known value.
        ACTION: Copy that value (star or dot) to the empty symmetric cell.
        """
        if not p.has_main_diagonal_symmetry:
            return 0
        n = p.n
        mirror_fn = lambda i, n=n: (i % n) * n + (i // n)
        return self._symmetry_fill(p, mirror_fn, "MainDiagonalFill")

    def rule_anti_diagonal_fill(self, p):
        """
        MATCH: Puzzle has anti-diagonal (↙) symmetry AND a cell whose mirror
        already has a known value.
        ACTION: Copy that value (star or dot) to the empty symmetric cell.
        """
        if not p.has_anti_diagonal_symmetry:
            return 0
        n = p.n
        mirror_fn = lambda i, n=n: (n - 1 - i % n) * n + (n - 1 - i // n)
        return self._symmetry_fill(p, mirror_fn, "AntiDiagonalFill")

    def rule_rotation_180_fill(self, p):
        """
        MATCH: Puzzle has 180° rotational symmetry AND a cell whose 180°-
        rotated counterpart already has a known value.
        ACTION: Copy that value (star or dot) to the empty symmetric cell.
        """
        if not (p.has_internal_rotation_180 or p.has_crossboard_rotation_180):
            return 0
        total = p.n * p.n
        mirror_fn = lambda i: total - 1 - i
        return self._symmetry_fill(p, mirror_fn, "Rotation180Fill")

    def rule_diagonal_symmetry(self, p):
        if not p.diagonal_symmetries:
            return 0
        changes = 0
        for i in range(p.n * p.n):
            if p.grid[i] is not None:
                continue
            ri, ci = p.get_rc(i)

            def sees_own_mirror(mirror_fn):
                mirror = mirror_fn(i)
                if mirror == i:
                    return False
                mr, mc = p.get_rc(mirror)
                if ri == mr or ci == mc:
                    return True
                if mirror in p._neighbor_map[i]:
                    return True
                if p.cell_to_region[0][i] == p.cell_to_region[0][mirror]:
                    return True
                if p.cell_to_region[1][i] == p.cell_to_region[1][mirror]:
                    return True
                return False

            if any(sees_own_mirror(fn) for fn in p.diagonal_symmetries):
                changes += p.validate_and_set(i, ".", "DiagonalSymmetry", self.verbose)
        return changes


    def rule_diagonal_parity(self, p):
        """
        MATCH: Puzzle has diagonal symmetry AND either: the diagonal has 1 empty
        cell (parity determines its value); or parity is already satisfied and
        all empty diagonal cells mutually see each other (by adjacency or shared
        region) — meaning at most one could be a star, which would break parity,
        so all must be dots.
        ACTION: Sets the cell(s) accordingly.
        """
        n = p.n
        changes = 0

        def try_diag(diag_indices, label):
            nonlocal changes
            stars  = sum(1 for i in diag_indices if p.grid[i] == "x")
            empties = [i for i in diag_indices if p.grid[i] is None]

            if len(empties) == 1:
                # One cell left — parity decides.
                need_star = (stars % 2) != (n % 2)
                val = "x" if need_star else "."
                changes += p.validate_and_set(
                    empties[0], val,
                    f"DiagonalParity({label})", self.verbose)

            elif len(empties) >= 2:
                # Parity already satisfied: if all empties mutually see each
                # other (adjacency or same region on either board), at most one
                # could be a star — but that would break parity, so all are dots.
                if (stars % 2) != (n % 2):
                    return
                def see(a, b):
                    ra, ca = p.get_rc(a)
                    rb, cb = p.get_rc(b)
                    if abs(ra - rb) <= 1 and abs(ca - cb) <= 1:
                        return True
                    for b_idx in range(N_BOARDS):
                        ca_reg = p.cell_to_region[b_idx][a]
                        cb_reg = p.cell_to_region[b_idx][b]
                        if ca_reg != VOID_CHAR and ca_reg == cb_reg:
                            return True
                    return False
                if not all(see(a, b) for i, a in enumerate(empties)
                           for b in empties[i+1:]):
                    return
                for idx in empties:
                    changes += p.validate_and_set(
                        idx, ".",
                        f"DiagonalParity({label}) mutual-visibility",
                        self.verbose)

        if p.has_main_diagonal_symmetry:
            main_diag = [k * n + k for k in range(n)]
            try_diag(main_diag, "main")
            if changes > 0:
                return changes

        if p.has_anti_diagonal_symmetry:
            anti_diag = [k * n + (n - 1 - k) for k in range(n)]
            try_diag(anti_diag, "anti")
            if changes > 0:
                return changes

        return 0

    def rule_rotation_180(self, p):
        if not (p.has_internal_rotation_180 or p.has_crossboard_rotation_180):
            return 0
        total = p.n * p.n
        mirror_fn = lambda i: total - 1 - i
        changes = 0
        for i in range(total):
            if p.grid[i] is not None:
                continue
            mirror = mirror_fn(i)
            if mirror == i:
                continue
            ri, ci = p.get_rc(i)
            mr, mc = p.get_rc(mirror)
            conflicts = (
                ri == mr or ci == mc
                or mirror in p._neighbor_map[i]
                or p.cell_to_region[0][i] == p.cell_to_region[0][mirror]
                or p.cell_to_region[1][i] == p.cell_to_region[1][mirror]
            )
            if conflicts:
                changes += p.validate_and_set(i, ".", "Rotation180", self.verbose)
        return changes
