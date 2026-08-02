import random
from board_utils import connected_components
from generator import Generator


class VennGenerator(Generator):
    """
    Generates boards by superimposing rectangles.

    Each attempt draws up to 15 random rectangles on the grid.  Every new
    rectangle "slices" any region it overlaps, splitting it along the boundary.
    After each slice the grid is flood-filled to renumber contiguous components;
    once exactly N components exist the board is passed to the solver.

    Aesthetic constraints
    ---------------------
    1. No collinear boundary segments — two rectangles may not share any
       portion of a horizontal or vertical edge.
    2. No shared corners — rectangle corners may touch lines but not other
       rectangle corners (prevents + and pinwheel intersections).
    3. Dimension limits — no rectangle spanning the full grid width or height,
       and no 2-wide rectangle shorter than 4 in the other dimension.
    """

    def _try_generate(self):
        n = self.n

        # Track committed boundary segments and corners locally so each
        # attempt starts clean without touching instance state.
        used_segments = {'h': {}, 'v': {}}
        used_corners = set()

        grid = [[0] * n for _ in range(n)]

        def is_segment_blocked(orientation, index, start, end):
            """True if [start, end) overlaps any committed segment on this row/col."""
            for s, e in used_segments[orientation].get(index, []):
                if max(start, s) < min(end, e):
                    return True
            return False

        for _ in range(15):
            r_coords = sorted(random.sample(range(n + 1), 2))
            c_coords = sorted(random.sample(range(n + 1), 2))
            r1, r2, c1, c2 = r_coords[0], r_coords[1], c_coords[0], c_coords[1]
            h, w = r2 - r1, c2 - c1

            # 1. Dimension constraints
            if h == n or w == n:
                continue
            if h < 2 or w < 2:
                continue
            if (h == 2 and w < 4) or (w == 2 and h < 4):
                continue

            # 2. No collinear boundary segments
            if (is_segment_blocked('h', r1, c1, c2) or
                    is_segment_blocked('h', r2, c1, c2) or
                    is_segment_blocked('v', c1, r1, r2) or
                    is_segment_blocked('v', c2, r1, r2)):
                continue

            # 3. No shared corners (corners may touch lines, not other corners)
            new_corners = {(r1, c1), (r1, c2), (r2, c1), (r2, c2)}
            if not new_corners.isdisjoint(used_corners):
                continue

            # 4. Apply slice: relabel cells inside the rectangle per their
            #    current region so each old region becomes its own temp label.
            intersected = set()
            for r in range(r1, r2):
                for c in range(c1, c2):
                    intersected.add(grid[r][c])

            next_temp = 100
            for old_label in intersected:
                for r in range(r1, r2):
                    for c in range(c1, c2):
                        if grid[r][c] == old_label:
                            grid[r][c] = next_temp
                next_temp += 1

            # 5. Commit boundary state
            used_corners.update(new_corners)
            used_segments['h'].setdefault(r1, []).append((c1, c2))
            used_segments['h'].setdefault(r2, []).append((c1, c2))
            used_segments['v'].setdefault(c1, []).append((r1, r2))
            used_segments['v'].setdefault(c2, []).append((r1, r2))

            # 6. Renumber contiguous components
            grid, count = self._get_components(grid)

            if count == n:
                grid_flat = [grid[r][c] for r in range(n) for c in range(n)]
                return self._make_result(grid_flat)

            if count > n:
                # Overshot — further slices can only make it worse; abandon
                # this attempt entirely and let the outer loop retry.
                return None

        return None

    def _get_components(self, grid):
        """
        Sequentially relabels the 2-D grid so each contiguous same-value
        region gets its own integer label. Returns (new_grid, count).
        """
        n = self.n
        flat = [grid[r][c] for r in range(n) for c in range(n)]

        by_value = {}
        for i, v in enumerate(flat):
            by_value.setdefault(v, []).append(i)

        new_flat = [-1] * (n * n)
        count = 0
        for cells in by_value.values():
            for component in connected_components(cells, n):
                for idx in component:
                    new_flat[idx] = count
                count += 1

        new_grid = [[new_flat[r * n + c] for c in range(n)] for r in range(n)]
        return new_grid, count


if __name__ == "__main__":
    print("\n--- Venn Generator (N=8) ---")
    VennGenerator.demo(8)
