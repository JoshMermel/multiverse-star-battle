import random
from abc import ABC, abstractmethod
from board_utils import canonical_relabel, get_transformation_maps
from generator import GenerationError
from puzzle_deduper import PuzzleDeduper


_ATTEMPTS_PER_PAIR = 500

class Comparator(ABC):
    """
    board_count: how many boards each emitted puzzle group contains. Defaults
    to 2 (the classic pairwise case). Subclasses that emit groups of a
    different size (e.g. TripleComparator) must override this so callers
    (e.g. gen_puzzles.py) know how many board_N columns to expect before
    any puzzles have actually been generated.
    """
    board_count = 2

    def __init__(self, n, output_rows, randomize_orientation_for_output=True):
        self.n = n
        self.output_rows = output_rows
        self.pairs_found = 0
        self.randomize_orientation_for_output = randomize_orientation_for_output
        self._deduper = PuzzleDeduper()

    def run(self, count):
        max_attempts = count * _ATTEMPTS_PER_PAIR
        for _ in range(max_attempts):
            if self.pairs_found >= count:
                break
            self._next_pair()
        else:
            if self.pairs_found < count:
                print(
                    f"Warning: {self.__class__.__name__} hit attempt limit "
                    f"({max_attempts}), only found {self.pairs_found}/{count} pairs.",
                    flush=True,
                )

    @abstractmethod
    def _next_pair(self):
        pass

    def _generate_safe(self, generator):
        try:
            return generator.generate()
        except GenerationError:
            return None

    def _next_puzzle_name(self, suffix=""):
        base = f"puzzle_{self.pairs_found + 1}"
        return f"{base}_{suffix}" if suffix else base

    def _match_against_pool(self, pool, candidates):
        """
        Scans `pool` (a list of (board, solutions) tuples awaiting a
        match) for the first entry that shares exactly one solution with
        any of `candidates` (this attempt's own (board, solutions)
        variants). On a match, removes that entry from `pool` -- safe
        because every caller returns immediately after -- and returns
        (candidate_board, pool_board, common_solution). Returns None if
        no match is found; the caller decides what to do with an
        unmatched attempt (e.g. appending it to the pool).
        """
        for i, (pool_flat, pool_sols) in enumerate(pool):
            for variant_board, variant_sols in candidates:
                common = variant_sols & pool_sols
                if len(common) == 1:
                    pool.pop(i)
                    return variant_board, pool_flat, next(iter(common))
        return None

    def _emit(self, name, boards, solution):
        """
        Records a matched group of boards (any length >= 1). Handles optional
        orientation randomization and mandatory canonicalization.

        boards: list of board strings, in the order they should be presented
        (e.g. board_1, board_2, ..., board_N in the output row).
        """
        final_boards = list(boards)
        final_sol = solution

        # 1. Handle Randomization (if enabled)
        if self.randomize_orientation_for_output:
            random.shuffle(final_boards)

            all_maps = get_transformation_maps(self.n)
            forward_map, _ = random.choice(all_maps)

            # Apply transform to boards
            def apply_tr(b_str):
                res = [""] * (self.n * self.n)
                for i, char in enumerate(b_str):
                    res[forward_map[i]] = char
                return "".join(res)

            final_boards = [apply_tr(b) for b in final_boards]

            # Apply transform to solution
            sol_list = ["."] * (self.n * self.n)
            for i, char in enumerate(final_sol):
                if char == 'x':
                    sol_list[forward_map[i]] = 'x'
            final_sol = "".join(sol_list)

        # 2. Mandatory Canonicalization — each board independently
        final_boards = [canonical_relabel(b) for b in final_boards]

        if self._deduper.is_duplicate(final_boards, self.n):
            return
        self._deduper.register(final_boards, self.n)

        row = {'name': name, 'N': self.n}
        for i, b in enumerate(final_boards, start=1):
            row[f'board_{i}'] = b
        row['solution'] = final_sol
        self.output_rows.append(row)

        boards_csv = ",".join(final_boards)
        print(f"{name},{self.n},{boards_csv},{final_sol}", flush=True)
        self.pairs_found += 1
