import random
from generator import Generator
from board_utils import flood_fill_favor_smallest, get_neighbors_4, is_contiguous


class SquareFreeDeboxGenerator(Generator):
    """
    Generates Star Battle boards with 'square-free' regions -- no 2x2 block
    of cells all belonging to the same region -- using a different
    construction than SquareFreeGenerator's strict tree growth.

    Why not just use SquareFreeGenerator
    -------------------------------------
    SquareFreeGenerator enforces a *sufficient* condition for square-free
    (every region is a tree: each new cell touches exactly one same-region
    cell) via greedy random growth. That's much stronger than necessary,
    and it pays for it in yield: regions can fully box each other in
    before the board is covered, discarding the whole attempt. Measured
    at n=9: ~99% of attempts never finish, and of the ones that do,
    virtually none are 2-star ambiguous (a tree region is usually too
    thin/small to legally hold 2 non-touching stars at all). Worse, the
    orphaned cells left behind are frequently *unrepairable* after the
    fact: a cell fully enclosed by one region's cells has no color choice
    that avoids completing a monochromatic 2x2 -- not a search problem,
    a geometric dead end inherent to how tree growth traps cells.

    This class takes the opposite approach: start from an ordinary
    flood-fill partition (see flood_fill_favor_smallest), which -- unlike
    tree growth -- always completes, since a frontier cell always has
    some bordering region to join. Then locally repair the (usually
    modest) number of monochromatic 2x2 blocks that an unconstrained
    partition naturally contains, by moving one cell of each violating
    block to a bordering region ("deboxing"). This targets the actual
    square-free constraint directly instead of a stricter stand-in for
    it, and starting from an always-complete board means there's no
    self-boxing failure mode to begin with.

    Region-size floor
    ------------------
    flood_fill_favor_smallest biases growth toward whichever bordering
    region is currently smallest, and deboxing tries to avoid shrinking
    any region below min_region_size when it has a choice. Neither
    *guarantees* every region ends up large enough for stars_per_unit
    non-touching stars (region shape matters as much as size -- a
    straight run of 3 cells can hold 2 stars, an L-bend of 3 cells
    can't), but both measurably cut down on the degenerate 1-2 cell
    regions that can never hold 2+ stars regardless of shape, which is
    what was making SquareFreeGenerator's 2-star yield ~0 in practice.

    min_region_size defaults to 2 * stars_per_unit - 1: the minimum
    length of a straight run of cells needed to fit stars_per_unit
    mutually non-touching cells (every other cell). It's a necessary,
    not sufficient, floor -- boards that still end up with an infeasible
    region shape simply come back with 0 solutions and get discarded by
    the usual ambiguity check in Generator._make_result, same as any
    other rejected attempt.
    """

    # How many rounds of "try to fix one violating 2x2 block" to attempt
    # before giving up on an attempt and letting the outer retry loop
    # (Generator.generate) start over from a fresh partition. Generous
    # since each successful round fixes at most one block, chosen as a
    # multiple of the board's own 2x2-block count so it scales with n.
    _ROUNDS_PER_CELL = 20

    def __init__(self, n, stars_per_unit=1, min_region_size=None):
        super().__init__(n, stars_per_unit=stars_per_unit)
        self.min_region_size = (
            min_region_size if min_region_size is not None
            else max(1, 2 * stars_per_unit - 1)
        )

    def _try_generate(self):
        n = self.n
        grid = [None] * (n * n)
        for reg_id, idx in enumerate(self._random_seeds(n)):
            grid[idx] = reg_id

        grid = flood_fill_favor_smallest(grid, n)
        if grid is None:
            return None  # shouldn't happen on a fully-seeded board; defensive

        if not self._debox(grid):
            return None

        sizes = {}
        for v in grid:
            sizes[v] = sizes.get(v, 0) + 1
        if min(sizes.values()) < self.min_region_size:
            # Necessary-condition prefilter: a region this small can never
            # legally hold stars_per_unit non-touching stars, so the board
            # is doomed to 0 solutions -- skip the solver call and retry.
            return None

        return self._make_result(grid)

    def _debox(self, grid):
        """
        Repeatedly finds a monochromatic 2x2 block and fixes it by moving
        one of its 4 cells to a bordering region, until none remain.
        Mutates grid in place. Returns True on success, False if a full
        round couldn't fix any of the currently-violating blocks (rare;
        the caller discards the attempt and retries from scratch).
        """
        n = self.n
        max_rounds = self._ROUNDS_PER_CELL * n * n
        for _ in range(max_rounds):
            blocks = self._find_2x2_blocks(grid)
            if not blocks:
                return True

            random.shuffle(blocks)
            fixed_any = False
            for block in blocks:
                # An earlier fix this round may have already resolved this
                # block as a side effect -- re-check before spending effort.
                if len({grid[c] for c in block}) > 1:
                    continue
                if (self._try_fix_block(grid, block, protect_min_size=self.min_region_size)
                        or self._try_fix_block(grid, block, protect_min_size=0)):
                    fixed_any = True
                    break
            if not fixed_any:
                return False
        return False

    def _find_2x2_blocks(self, grid):
        n = self.n
        blocks = []
        for r in range(n - 1):
            for c in range(n - 1):
                tl = r * n + c
                cells = [tl, tl + 1, tl + n, tl + n + 1]
                if len({grid[x] for x in cells}) == 1:
                    blocks.append(cells)
        return blocks

    def _would_complete_2x2(self, grid, cell, dest):
        n = self.n
        r, c = divmod(cell, n)
        for dr in (-1, 0):
            for dc in (-1, 0):
                r0, c0 = r + dr, c + dc
                if not (0 <= r0 < n - 1 and 0 <= c0 < n - 1):
                    continue
                block = [r0 * n + c0, r0 * n + c0 + 1, (r0 + 1) * n + c0, (r0 + 1) * n + c0 + 1]
                if all((dest if x == cell else grid[x]) == dest for x in block):
                    return True
        return False

    def _try_fix_block(self, grid, block, protect_min_size):
        """
        Attempts to fix one violating block by moving one of its 4 cells
        to a bordering region. Mutates grid in place and returns True on
        success. protect_min_size: skip moves that would shrink the
        donor region below this size, if any alternative exists.
        """
        n = self.n
        reg_id = grid[block[0]]
        cell_order = block[:]
        random.shuffle(cell_order)
        for cell in cell_order:
            dest_candidates = list({
                grid[nb] for nb in get_neighbors_4(cell, n) if grid[nb] != reg_id
            })
            random.shuffle(dest_candidates)
            for dest in dest_candidates:
                remaining_region = [i for i in range(n * n) if grid[i] == reg_id and i != cell]
                if len(remaining_region) < protect_min_size:
                    continue
                if remaining_region and not is_contiguous(remaining_region, n):
                    continue
                if self._would_complete_2x2(grid, cell, dest):
                    continue
                grid[cell] = dest
                return True
        return False


if __name__ == "__main__":
    print("\n--- SquareFreeDebox Generator (N=9, 2 stars) ---")
    SquareFreeDeboxGenerator.demo(9, stars_per_unit=2)
