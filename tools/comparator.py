import random
from abc import ABC, abstractmethod
from generator import GenerationError
from puzzle_deduper import PuzzleDeduper


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
