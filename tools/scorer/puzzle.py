"""
puzzle.py

StarBattlePuzzle: holds the mutable solving state for one puzzle during
scoring, plus the board-layout precomputation (units, neighbor map,
symmetry detection) every rule family reads from.
"""

import string

from board_utils import VOID_CHAR, get_neighbors_8


class StarBattlePuzzle:
    """Holds the mutable solving state for one puzzle during scoring."""

    def __init__(self, n, boards, solution_str, name, stars_per_unit=1):
        """
        boards: a sequence of board strings (one per "universe"). A
        Multiverse Star Battle puzzle may have any number of boards >= 1;
        classic single-board Star Battle is the n_boards == 1 case.

        stars_per_unit: how many stars each row/column/region must contain.
        Classic Star Battle is 1; "2★" and "3★" puzzles use 2 or 3.
        """
        self.name = name
        self.n = n
        self.stars_per_unit = stars_per_unit
        self.grid = [None] * (n * n)
        self.canonical_solution = solution_str

        boards = list(boards)
        self.n_boards = len(boards)
        if self.n_boards < 1:
            raise ValueError("A puzzle must have at least one board.")

        # Voids: cells that belong to no region and can never hold a star.
        # All boards must share the same void mask (voids are a property of
        # the puzzle layout, not of individual boards).
        self.void_cells = frozenset(
            i for i, ch in enumerate(boards[0]) if ch == VOID_CHAR
        )
        for b_idx, board_str in enumerate(boards[1:], start=1):
            other_voids = frozenset(
                i for i, ch in enumerate(board_str) if ch == VOID_CHAR
            )
            if other_voids != self.void_cells:
                raise ValueError(
                    f"Board {b_idx + 1} has a different void mask than board 1; "
                    "all boards in a puzzle must share the same voids."
                )

        # Pre-fill void cells as dots so the solver never considers them.
        for i in self.void_cells:
            self.grid[i] = "."

        self.regions = [self._map_regions(b) for b in boards]

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
        self.cell_to_region = [list(b) for b in boards]
        # Precomputed as sets for O(1) membership tests in _sees_too_much_n
        # and rule_triomino.
        self.region_sets = [
            {char: set(idxs) for char, idxs in self.regions[b].items()}
            for b in range(self.n_boards)
        ]
        self._neighbor_map = {i: get_neighbors_8(i, n) for i in range(n * n)}

        # Unified view of every row, column, and (per-board) region as a
        # single "unit" list, plus a cell -> containing-units index. Used by
        # the multi-star (2★/3★) rules, which need to reason generically
        # across unit types and detect when a candidate placement would
        # overload some OTHER unit past its star quota.
        self.units = self._build_units()
        self.units_by_cell = [[] for _ in range(n * n)]
        for unit in self.units:
            for idx in unit["indices"]:
                self.units_by_cell[idx].append(unit)

        self.diagonal_symmetries, self.has_main_diagonal_symmetry, self.has_anti_diagonal_symmetry = \
            self._detect_diagonal_symmetries()
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

    def _build_units(self):
        """Builds the unified rows + columns + (per-board) regions unit list."""
        units = []
        for r in range(self.n):
            units.append({"indices": self.row_indices[r], "label": f"Row {r+1}", "board_idx": None})
        for c in range(self.n):
            units.append({"indices": self.col_indices[c],
                           "label": f"Col {string.ascii_uppercase[c]}", "board_idx": None})
        for b_idx in range(self.n_boards):
            for r_char, idxs in self.regions[b_idx].items():
                units.append({"indices": idxs, "label": f"B{b_idx+1} Reg {r_char}", "board_idx": b_idx})
        return units

    def get_regions_needing_stars(self, board_idx):
        """
        Regions on the given board that still need at least one more star,
        paired with how many they still need. Unlike a plain "has any star"
        check (which assumes 1 star per region), this stays correct when a
        region can hold more than one star.
        """
        result = []
        for unit in self.units:
            if unit["board_idx"] != board_idx:
                continue
            remaining = self.stars_per_unit - sum(1 for i in unit["indices"] if self.grid[i] == "x")
            if remaining > 0:
                result.append({"unit": unit, "remaining": remaining})
        return result

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

        Void cells are treated as just another region label (VOID_CHAR
        compares equal to itself like any other label, no special-casing
        needed) -- there's no puzzle with symmetric-but-voided boards today
        and none planned, so this doesn't need to handle a void mask that's
        itself asymmetric under mirror_fn. Matches solver-core.js's
        _regionsAreTransformPartners, which never special-cased voids either.

        Implemented as a single O(n^2) pass building a src-label -> dst-label
        map, rather than an O(n^4) scan over every cell PAIR: each cell i
        contributes one mapping, src[i] -> dst[mirror(i)], and a conflict
        (the same src label already mapped to a different dst label) is
        exactly the "same_region(src) != same_region(dst)" failure above,
        for the pair (i, that earlier cell). The reverse failure mode --
        two different src labels both mapping to the same dst label -- can't
        happen without also tripping a conflict: mirror_fn is a bijection on
        the full n*n grid (an involution here), so a well-defined
        (conflict-free) function built this way is automatically onto every
        dst label that appears -- and a function between finite sets of
        equal size is injective iff it's onto (pigeonhole; both boards
        always partition the same n*n grid into the same number of labels).
        """
        src = self.cell_to_region[src_board]
        dst = self.cell_to_region[dst_board]
        label_map = {}
        for i in range(self.n * self.n):
            src_label = src[i]
            dst_label = dst[mirror_fn(i)]
            existing = label_map.get(src_label)
            if existing is None:
                label_map[src_label] = dst_label
            elif existing != dst_label:
                return False
        return True

    def _internal_symmetry(self, mirror_fn):
        """True if EVERY board independently has the symmetry given by mirror_fn."""
        return all(
            self._check_pairwise_symmetry(mirror_fn, src_board=b, dst_board=b)
            for b in range(self.n_boards)
        )

    def _crossboard_symmetry(self, mirror_fn):
        """
        True if every board can be accounted for under mirror_fn -- each
        board either paired off with exactly one OTHER board whose region
        layout it becomes under the transform, or (board count needn't be
        even for this) left paired with ITSELF, when it's internally
        symmetric under the same transform. Applying the transform to the
        whole multi-board puzzle then just permutes boards among
        themselves this way (partner <-> partner, self-symmetric boards
        fixed in place) while leaving the overall constraint set -- rows,
        columns, and every board's regions -- unchanged as a set, so the
        (unique) solution must itself be invariant under the transform,
        self-symmetric boards included.

        This used to require an even board count, treating "some boards
        pair up, others are internally symmetric" as if it needed separate
        handling from "every board pairs up" (_crossboard_symmetry, even
        count only) or "every board is internally symmetric"
        (_internal_symmetry, any count) -- two different all-or-nothing
        checks, OR'd together by callers. But mirror_fn is always an
        involution here (diagonal reflection or 180-degree rotation:
        applying it twice is the identity), so any permutation of the
        boards it could possibly induce decomposes into only fixed points
        (self-paired) and 2-cycles (real partners) -- there's no other
        shape a valid assignment could take. So "some self-paired, some
        real partners" isn't a third case to reason about separately, it's
        the fully general one, and it works for any board count, including
        odd ones: e.g. 3 boards where two are 180-degree partners and the
        third has its own internal 180-degree symmetry forces the same
        conclusion (the solution must be 180-degree-invariant) that a pure
        4-board partner-only or 3-board all-internal case would.

        This subsumes the old "exactly two boards, and they're mirror
        images of each other" check: with two boards there's only one
        possible pairing, so it's a strict generalization to any board
        count where a valid (self-pairs-allowed) matching exists -- not
        necessarily board[i] paired with board[i+1]; any perfect matching
        works, e.g. board1<->board3, board2 self-paired, board4<->board5.

        mirror_fn being an involution also makes "A is B's mirror-partner"
        (including A is A's own) a symmetric relation -- so this reduces to
        a perfect-matching-with-self-loops existence check over the "is a
        mirror-partner of" graph. Board counts here are small, so a simple
        backtracking search is plenty fast.
        """
        n_boards = self.n_boards
        if n_boards == 0:
            return False

        self_paired = [
            self._check_pairwise_symmetry(mirror_fn, src_board=b, dst_board=b)
            for b in range(n_boards)
        ]
        partners = [[False] * n_boards for _ in range(n_boards)]
        for i in range(n_boards):
            for j in range(i + 1, n_boards):
                if self._check_pairwise_symmetry(mirror_fn, src_board=i, dst_board=j):
                    partners[i][j] = partners[j][i] = True

        used = [False] * n_boards

        def find_matching():
            if all(used):
                return True
            i = used.index(False)
            used[i] = True
            if self_paired[i] and find_matching():
                return True
            for j in range(i + 1, n_boards):
                if not used[j] and partners[i][j]:
                    used[j] = True
                    if find_matching():
                        return True
                    used[j] = False
            used[i] = False
            return False

        return find_matching()

    def _detect_diagonal_symmetries(self):
        """
        Checks each diagonal candidate (main, then anti) exactly once and
        returns (symmetric_fns, has_main, has_anti). A diagonal symmetry
        applies whenever every board can be accounted for under that
        reflection -- paired with another board that's its diagonal
        reflection, or (no even board count required) left paired with
        itself, if it has that diagonal symmetry internally -- see
        _crossboard_symmetry, which covers both (and any mix) in one
        check. Either way, uniqueness forces the solution to respect the
        symmetry. _internal_symmetry is also OR'd in below for its own
        sake, though it's now a strict subset of _crossboard_symmetry's
        result -- harmless, but kept for clarity/documentation of intent.
        """
        n = self.n
        candidates = [
            lambda i, n=n: (i % n) * n + (i // n),              # main diagonal
            lambda i, n=n: (n-1 - i % n) * n + (n-1 - i // n),  # anti-diagonal
        ]
        flags = [self._crossboard_symmetry(fn) or self._internal_symmetry(fn) for fn in candidates]
        symmetric_fns = [fn for fn, ok in zip(candidates, flags) if ok]
        return symmetric_fns, flags[0], flags[1]

    def _detect_internal_rotation_180(self):
        """True if EVERY board independently has 180-degree rotational symmetry."""
        total = self.n * self.n
        mirror_fn = lambda i: total - 1 - i
        return self._internal_symmetry(mirror_fn)

    def _detect_crossboard_rotation_180(self):
        """
        True if every board can be accounted for under 180-degree
        rotation -- paired with another board that's its rotation, or (no
        even board count required) left paired with itself if it's
        internally 180-degree-symmetric. See _crossboard_symmetry.
        """
        total = self.n * self.n
        mirror_fn = lambda i: total - 1 - i
        return self._crossboard_symmetry(mirror_fn)
