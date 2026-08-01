import random
from generator import Generator


class SquareFreeGenerator(Generator):
    """
    Generates Star Battle boards with 'skeletal' regions.

    Constraint: regions form trees — each grown cell connects to exactly one
    existing cell of the same region (strict branching).  This implies the
    square-free property: a 2×2 filled block would require at least one cell
    to have two same-region neighbours, violating the constraint.

    Growth strategy
    ---------------
    Each region maintains a list of live branch tips.  On each iteration one
    region is chosen at random and we attempt to extend its most-recently-added
    tip (LIFO order, working backwards through the list).  If a tip has no
    valid neighbours it is permanently pruned.  A region becomes inactive once
    all its tips are pruned.

    When all regions are inactive the board may still have unfilled cells
    (regions can box each other in), in which case the attempt is discarded
    and the outer retry loop tries again.  This failure mode becomes more
    frequent for large N.
    """

    def _try_generate(self):
        n = self.n
        grid = [None] * (n * n)

        # tips[reg_id]: list of live branch-tip indices for that region.
        # We treat this as a stack (LIFO) — new tips are appended and we
        # search from the end, giving priority to the most recent growth.
        tips = []
        for reg_id, idx in enumerate(self._random_seeds(n)):
            grid[idx] = reg_id
            tips.append([idx])

        active_regions = list(range(n))

        while active_regions:
            # Choose a region at random each iteration for unbiased growth.
            reg_id = random.choice(active_regions)
            frontier = tips[reg_id]
            expanded = False

            # Walk the tip stack from the top (most recent), looking for a
            # tip that can still grow.  Prune dead tips as we go using
            # swap-and-pop for O(1) removal.
            i = len(frontier) - 1
            while i >= 0:
                curr_idx = frontier[i]
                nr_base, nc_base = divmod(curr_idx, n)

                candidates = []
                for dr, dc in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
                    nr, nc = nr_base + dr, nc_base + dc
                    if not (0 <= nr < n and 0 <= nc < n):
                        continue
                    n_idx = nr * n + nc
                    if grid[n_idx] is not None:
                        continue

                    # Strict branching: the candidate cell must touch exactly
                    # one same-region cell (curr_idx).  If it also borders
                    # another cell of this region, accepting it would create a
                    # cycle, violating the tree structure.
                    has_other_same_reg = any(
                        grid[(nr + ddr) * n + (nc + ddc)] == reg_id
                        for ddr, ddc in [(-1, 0), (1, 0), (0, -1), (0, 1)]
                        if (0 <= nr + ddr < n and 0 <= nc + ddc < n
                            and (nr + ddr) * n + (nc + ddc) != curr_idx)
                    )
                    if not has_other_same_reg:
                        candidates.append(n_idx)

                if candidates:
                    next_idx = random.choice(candidates)
                    grid[next_idx] = reg_id
                    frontier.append(next_idx)
                    expanded = True
                    break
                else:
                    # Tip is permanently stuck — prune it with swap-and-pop.
                    frontier[i] = frontier[-1]
                    frontier.pop()
                    i -= 1

            if not expanded:
                active_regions.remove(reg_id)

        if None in grid:
            # Some cells were never claimed; discard this attempt.
            return None

        return self._make_result(grid)


if __name__ == "__main__":
    print("\n--- SquareFree Generator (N=8) ---")
    SquareFreeGenerator.demo(8)
