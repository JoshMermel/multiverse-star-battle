import random
import heapq
from board_utils import get_neighbors_4, pretty_print
from generator import Generator


class VoronoiGenerator(Generator):
    """
    Generates approximate Voronoi diagrams on the grid.

    Each of the N regions grows outward from a randomly placed seed using a
    priority-queue flood fill.  The priority is the Euclidean distance from the
    cell to the region's seed, jittered by a small random offset per cell.

    The jitter is what makes this "approximate" rather than exact: pure
    Voronoi would produce smooth, round boundaries, while the per-cell noise
    creates the irregular, organic shapes typical of hand-drawn puzzle boards.

    Contiguity is guaranteed by construction: a cell can only be claimed by
    expanding from an already-claimed neighbour, so every region is a single
    connected blob regardless of seed placement or jitter magnitude.
    """

    # Controls how irregular the region boundaries are.
    # 0.0 → exact Voronoi (smooth, round blobs).
    # Higher values → more jagged, organic boundaries.
    JITTER = 1.2

    def _try_generate(self):
        n = self.n

        # 1. Place N seeds, one per region, at random distinct cells.
        seed_indices = self._random_seeds(n)
        seed_coords = [divmod(idx, n) for idx in seed_indices]

        grid = [None] * (n * n)

        # Priority queue entries: (priority, cell_index, region_id).
        # Priority is Euclidean distance to the region's seed plus jitter,
        # so cells close to a seed are claimed first, but with enough noise
        # to produce irregular boundaries.
        heap = []
        for reg_id, (sr, sc) in enumerate(seed_coords):
            grid[sr * n + sc] = reg_id
            for nb in get_neighbors_4(sr * n + sc, n):
                nr, nc = divmod(nb, n)
                dist = ((nr - sr) ** 2 + (nc - sc) ** 2) ** 0.5
                heapq.heappush(heap, (dist + random.uniform(0, self.JITTER), nb, reg_id))

        # 2. Flood fill: claim unclaimed cells in priority order.
        while heap:
            priority, idx, reg_id = heapq.heappop(heap)

            if grid[idx] is not None:
                continue  # already claimed by an earlier (lower-priority) wave

            grid[idx] = reg_id
            sr, sc = seed_coords[reg_id]

            for nb in get_neighbors_4(idx, n):
                if grid[nb] is None:
                    nr, nc = divmod(nb, n)
                    dist = ((nr - sr) ** 2 + (nc - sc) ** 2) ** 0.5
                    heapq.heappush(heap, (dist + random.uniform(0, self.JITTER), nb, reg_id))

        # The flood fill guarantees full coverage by construction (every cell
        # is reachable from at least one seed's expanding wave), so any None
        # here indicates a bug rather than an expected failure mode.
        if None in grid:
            return None

        # 3. Solve and return.
        return self._make_result(grid)


if __name__ == "__main__":
    print("\n--- Voronoi Generator (N=8) ---")
    VoronoiGenerator.demo(8)
