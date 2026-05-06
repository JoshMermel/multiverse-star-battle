import random
from board_solver import get_all_solutions
from board_utils import pretty_print
from generator import Generator

class SquareFreeGenerator(Generator):
    """
    Generates Star Battle boards with 'skeletal' regions.

    Constraint: regions form trees — each grown cell connects to exactly one
    existing cell of the same region (strict branching). This implies the
    square-free property: a 2x2 block would require at least one cell to have
    two same-region neighbours.
    """

    def _try_generate(self):
        n = self.n
        grid_flat = [None] * (n * n)

        # 1. Initialize N seeds — one per region
        seed_indices = random.sample(range(n * n), n)
        # tips[reg_id] holds the frontier of live branch-tips for that region
        tips = []
        for reg_id, idx in enumerate(seed_indices):
            grid_flat[idx] = reg_id
            tips.append([idx])

        active_regions = list(range(n))

        # 2. Competitive Branching Growth
        while active_regions:
            # Pick one region at random per iteration for fair, unbiased growth
            reg_id = random.choice(active_regions)
            frontier = tips[reg_id]
            expanded = False

            # Search frontier backwards to prioritise 'tips' of branches
            for i in range(len(frontier) - 1, -1, -1):
                curr_idx = frontier[i]
                nr_base, nc_base = divmod(curr_idx, n)

                candidates = []
                for dr, dc in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
                    nr, nc = nr_base + dr, nc_base + dc
                    if not (0 <= nr < n and 0 <= nc < n):
                        continue
                    n_idx = nr * n + nc
                    if grid_flat[n_idx] is not None:
                        continue

                    # Strict branching: the candidate must touch only curr_idx
                    # among existing same-region cells (i.e. curr_idx is its
                    # sole same-region neighbour).
                    has_other_same_reg = any(
                        grid_flat[(nr + ddr) * n + (nc + ddc)] == reg_id
                        for ddr, ddc in [(-1, 0), (1, 0), (0, -1), (0, 1)]
                        if 0 <= nr + ddr < n and 0 <= nc + ddc < n
                        and (nr + ddr) * n + (nc + ddc) != curr_idx
                    )
                    if not has_other_same_reg:
                        candidates.append(n_idx)

                if candidates:
                    next_idx = random.choice(candidates)
                    grid_flat[next_idx] = reg_id
                    frontier.append(next_idx)
                    expanded = True
                    break
                else:
                    # This branch tip is permanently stuck; prune it
                    frontier.pop(i)

            if not expanded:
                active_regions.remove(reg_id)

        # 3. Validate fill and solve
        if None in grid_flat:
            return None

        solutions = get_all_solutions(grid_flat, n)
        return self._make_result(grid_flat, solutions)

if __name__ == "__main__":
    print("\n--- SquareFree Generator (N=8) ---")
    gen = SquareFreeGenerator(8)
    board, solutions = gen.generate()
    pretty_print(board, 8)
    print(f"Solutions: {len(solutions)}")
