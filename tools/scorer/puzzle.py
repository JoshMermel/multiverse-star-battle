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

    def __init__(self, n, boards, solution_str, name, stars_per_group=1):
        """
        boards: a sequence of board strings (one per "universe"). A
        Multiverse Star Battle puzzle may have any number of boards >= 1;
        classic single-board Star Battle is the n_boards == 1 case.

        stars_per_group: how many stars each row/column/region must contain.
        Classic Star Battle is 1; "2★" and "3★" puzzles use 2 or 3.
        """
        self.name = name
        self.n = n
        self.stars_per_group = stars_per_group
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
            remaining = self.stars_per_group - sum(1 for i in unit["indices"] if self.grid[i] == "x")
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

    def _internal_symmetry(self, mirror_fn):
        """True if EVERY board independently has the symmetry given by mirror_fn."""
        return all(
            self._check_pairwise_symmetry(mirror_fn, src_board=b, dst_board=b)
            for b in range(self.n_boards)
        )

    def _crossboard_symmetry(self, mirror_fn):
        """
        True if every board can be paired off with exactly one OTHER board
        such that applying mirror_fn to one board's region layout produces
        its partner's layout. Applying the transform to the whole
        multi-board puzzle then just permutes boards pairwise (partner <->
        partner) while leaving the overall constraint set -- rows, columns,
        and every board's regions -- unchanged as a set, so the (unique)
        solution must itself be invariant under the transform. Requires an
        even number of boards.

        This subsumes the old "exactly two boards, and they're mirror
        images of each other" check: with two boards there's only one
        possible pairing, so it's a strict generalization to any even board
        count where a valid pairing exists -- not necessarily board[i]
        paired with board[i+1]; any perfect matching works, e.g.
        board1<->board3, board2<->board4.

        mirror_fn is always an involution here (diagonal reflection or
        180-degree rotation), which makes "A is B's mirror-partner" a
        symmetric relation (if applying it to A gives B, applying it to B
        gives back A) -- so this reduces to a perfect-matching existence
        check over the "is a mirror-partner of" graph. Board counts here are
        small, so a simple backtracking search is plenty fast.
        """
        n_boards = self.n_boards
        if n_boards == 0 or n_boards % 2 != 0:
            return False

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
            for j in range(i + 1, n_boards):
                if not used[j] and partners[i][j]:
                    used[j] = True
                    if find_matching():
                        return True
                    used[j] = False
            used[i] = False
            return False

        return find_matching()

    def _detect_single_diagonal_symmetry(self, candidate_idx):
        """
        Returns True if the diagonal symmetry at candidates[candidate_idx]
        applies (either every board is paired with a diagonal-reflection
        partner board, or every board independently has the symmetry).
        candidate_idx 0 = main diagonal, 1 = anti-diagonal.
        """
        n = self.n
        candidates = [
            lambda i, n=n: (i % n) * n + (i // n),
            lambda i, n=n: (n-1 - i % n) * n + (n-1 - i // n),
        ]
        fn = candidates[candidate_idx]
        return self._crossboard_symmetry(fn) or self._internal_symmetry(fn)

    def _detect_diagonal_symmetries(self):
        n = self.n
        candidates = [
            lambda i, n=n: (i % n) * n + (i // n),           # main diagonal
            lambda i, n=n: (n-1 - i % n) * n + (n-1 - i // n),  # anti-diagonal
        ]
        # A diagonal symmetry applies if either:
        #   (a) every board can be paired with another board that's its
        #       diagonal reflection (cross-board; requires an even board
        #       count and a valid pairing -- see _crossboard_symmetry), OR
        #   (b) every board independently has that diagonal symmetry (internal).
        # In both cases uniqueness forces the solution to respect the symmetry.
        result = []
        for fn in candidates:
            if self._crossboard_symmetry(fn) or self._internal_symmetry(fn):
                result.append(fn)
        return result

    def _detect_internal_rotation_180(self):
        """True if EVERY board independently has 180-degree rotational symmetry."""
        total = self.n * self.n
        mirror_fn = lambda i: total - 1 - i
        return self._internal_symmetry(mirror_fn)

    def _detect_crossboard_rotation_180(self):
        """True if every board is paired with another board that's its 180-degree rotation."""
        total = self.n * self.n
        mirror_fn = lambda i: total - 1 - i
        return self._crossboard_symmetry(mirror_fn)
