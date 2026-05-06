import random
from board_solver import get_all_solutions
from board_utils import get_neighbors_4
from generator import Generator


class RectangleGenerator(Generator):
    """
    Generates boards by additively painting rectangles onto the grid.

    The grid starts as a single region. Each rectangle painted over it
    reassigns all covered cells to a new region label. This can:
      - Split an existing region in two if the rectangle cuts across it
        without covering it entirely (both halves get new labels)
      - Create intersection regions where the rectangle overlaps multiple
        existing regions

    Rectangles are painted one at a time until the grid has exactly N
    contiguous regions. If painting a rectangle would push the region count
    over N, that attempt is skipped. If we exhaust our attempt budget without
    reaching exactly N regions, _try_generate returns None and the outer
    retry loop tries again.

    Rectangles must be at least 2 cells wide and 2 cells tall.
    """

    # How many rectangle placements to attempt before giving up.
    MAX_RECT_ATTEMPTS = 200

    def _try_generate(self):
        n = self.n

        # Start with a single region covering the whole board.
        grid = [0] * (n * n)
        next_label = 1

        for _ in range(self.MAX_RECT_ATTEMPTS):
            region_count = self._count_regions(grid, n)
            if region_count == n:
                break

            # Sample a rectangle with both dimensions >= 2.
            # Allow up to n-1 so there's always at least one cell outside.
            w = random.randint(2, n - 1)
            h = random.randint(2, n - 1)
            c0 = random.randint(0, n - w)
            r0 = random.randint(0, n - h)

            # Paint a fresh label over the rectangle.
            new_label = next_label
            old_grid = grid[:]
            for r in range(r0, r0 + h):
                for c in range(c0, c0 + w):
                    grid[r * n + c] = new_label
            next_label += 1

            # Count contiguous regions after painting.
            new_count = self._count_regions(grid, n)

            if new_count > n:
                # This rectangle pushed us over — revert and try another.
                grid = old_grid
                next_label -= 1
            # If new_count <= n, keep the paint (we may need more rectangles
            # to reach exactly n, or we're done).

        if self._count_regions(grid, n) != n:
            return None

        # Normalise labels to 0..n-1 (painting leaves gaps after reverts).
        label_map = {label: i for i, label in enumerate(sorted(set(grid)))}
        grid = [label_map[v] for v in grid]

        solutions = get_all_solutions(grid, n)
        return self._make_result(grid, solutions)

    def _count_regions(self, grid, n):
        """Returns the number of contiguous same-label regions."""
        visited = [False] * (n * n)
        count = 0
        for start in range(n * n):
            if visited[start]:
                continue
            count += 1
            stack = [start]
            label = grid[start]
            while stack:
                idx = stack.pop()
                if visited[idx]:
                    continue
                visited[idx] = True
                for nb in get_neighbors_4(idx, n):
                    if not visited[nb] and grid[nb] == label:
                        stack.append(nb)
        return count
