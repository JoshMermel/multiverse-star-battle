import random
from abc import ABC, abstractmethod
from generator import GenerationError
from board_utils import get_transformation_maps, canonical_relabel

class PuzzleDeduper:
    """
    Tracks seen puzzle pairs across all 8 dihedral orientations.
    Board order is ignored — (A, B) and (B, A) are the same puzzle.

    A stable canonical fingerprint is computed by applying all 8 transforms
    to the pair, relabeling each result, sorting the two boards within each
    transform (to ignore board order), then taking the lexicographic minimum
    across all 8 — so every orientation of the same puzzle maps to the same
    single string, and both register() and is_duplicate() use it.
    """
    def __init__(self):
        self._seen = set()

    @staticmethod
    def _apply(board_str, forward_map, n):
        result = [""] * (n * n)
        for i, ch in enumerate(board_str):
            result[forward_map[i]] = ch
        return "".join(result)

    @staticmethod
    def _canonical_fingerprint(b1, b2, n):
        candidates = []
        for forward_map, _ in get_transformation_maps(n):
            tb1 = canonical_relabel(PuzzleDeduper._apply(b1, forward_map, n))
            tb2 = canonical_relabel(PuzzleDeduper._apply(b2, forward_map, n))
            a, b = sorted([tb1, tb2])  # ignore board order
            candidates.append(f"{a}|{b}")
        return min(candidates)  # stable across all orientations

    def is_duplicate(self, b1, b2, n):
        return self._canonical_fingerprint(b1, b2, n) in self._seen

    def register(self, b1, b2, n):
        self._seen.add(self._canonical_fingerprint(b1, b2, n))


_ATTEMPTS_PER_PAIR = 500

class Comparator(ABC):
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

    def _emit(self, name, board_1, board_2, solution):
        """
        Records a matched pair. Handles optional transformation and 
        mandatory canonicalization
        """
        final_b1 = board_1
        final_b2 = board_2
        final_sol = solution

        # 1. Handle Randomization (if enabled)
        if self.randomize_orientation_for_output:
            if random.random() < 0.5:
                final_b1, final_b2 = final_b2, final_b1

            all_maps = get_transformation_maps(self.n)
            forward_map, _ = random.choice(all_maps)

            # Apply transform to boards
            def apply_tr(b_str):
                res = [""] * (self.n * self.n)
                for i, char in enumerate(b_str):
                    res[forward_map[i]] = char
                return "".join(res)

            final_b1 = apply_tr(final_b1)
            final_b2 = apply_tr(final_b2)

            # Apply transform to solution
            sol_list = ["."] * (self.n * self.n)
            for i, char in enumerate(final_sol):
                if char == 'x':
                    sol_list[forward_map[i]] = 'x'
            final_sol = "".join(sol_list)

        # 2. Mandatory Canonicalization — each board independently
        final_b1 = canonical_relabel(final_b1)
        final_b2 = canonical_relabel(final_b2)

        if self._deduper.is_duplicate(final_b1, final_b2, self.n):
            return
        self._deduper.register(final_b1, final_b2, self.n)

        row = {
            'name': name, 
            'N': self.n, 
            'board_1': final_b1,
            'board_2': final_b2, 
            'solution': final_sol
        }
        self.output_rows.append(row)
        print(f"{name},{self.n},{final_b1},{final_b2},{final_sol}", flush=True)
        self.pairs_found += 1
