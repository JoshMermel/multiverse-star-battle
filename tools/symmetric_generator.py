# this class only really works when N is even. It could be fixed up, but I
# haven't bothered.

"""
symmetric_generator.py

Generates Star Battle boards with one of five structural symmetry types:
  mirror        - left/right reflection
  diagonal      - transpose (main diagonal reflection)
  double_mirror - both horizontal and vertical axis reflection
  rot_90        - 90-degree rotational symmetry (implies rot_180 and rot_270 too)
  rot_180       - 180-degree rotational symmetry

Seeding strategy
----------------
Each symmetry type has an axis or fixed-point locus where a region can
"straddle" the axis of symmetry (occupying cells that map to each other).
_decide_straddle_count picks how many such axis-straddling regions to seed
first; _place_straddle_seeds plants them.  _place_regular_seeds then places
the remaining regions in symmetric orbit pairs (or quads for rot_90 /
double_mirror).  symmetric_flood_fill grows all seeded regions simultaneously
while preserving the chosen symmetry.
"""

import random
from board_utils import get_neighbors_4, pretty_print
from board_solver import get_all_solutions
from generator import Generator


class SymmetricGenerator(Generator):
    # Symmetry types that require orbit quads (4 cells per region seed).
    _QUAD_SYMMETRIES = frozenset({'double_mirror', 'rot_90'})

    def __init__(self, n, symmetry_type=None):
        super().__init__(n)
        # Grid is local to _try_generate, not stored as instance state.

        valid_symmetries = ['mirror', 'diagonal', 'double_mirror', 'rot_90', 'rot_180']
        if symmetry_type is None:
            self.sym_type = random.choice(valid_symmetries)
        else:
            self.sym_type = symmetry_type

    # -- Grid helpers ---------------------------------------------------------

    def _get_idx(self, r, c):
        """Returns the flat index for (r, c), or None if out of bounds."""
        if 0 <= r < self.n and 0 <= c < self.n:
            return r * self.n + c
        return None

    def get_orbit(self, idx):
        """
        Returns all cell indices that are symmetric images of idx.
        Out-of-bounds images (None from _get_idx) are filtered out.
        """
        r, c = divmod(idx, self.n)
        n = self.n
        if self.sym_type == 'mirror':
            candidates = [idx, self._get_idx(r, n - 1 - c)]
        elif self.sym_type == 'diagonal':
            candidates = [idx, self._get_idx(c, r)]
        elif self.sym_type == 'double_mirror':
            candidates = [idx, self._get_idx(r, n - 1 - c),
                          self._get_idx(n - 1 - r, c), self._get_idx(n - 1 - r, n - 1 - c)]
        elif self.sym_type == 'rot_90':
            candidates = [idx, self._get_idx(c, n - 1 - r),
                          self._get_idx(n - 1 - r, n - 1 - c), self._get_idx(n - 1 - c, r)]
        elif self.sym_type == 'rot_180':
            candidates = [idx, self._get_idx(n - 1 - r, n - 1 - c)]
        else:
            candidates = [idx]
        return [i for i in candidates if i is not None]

    # -- Seeding --------------------------------------------------------------

    def _decide_straddle_count(self):
        """
        Returns how many axis-straddling region seeds to place.
        The valid counts vary by symmetry type to ensure the total number of
        regions (n) can be filled exactly by straddle seeds plus orbit seeds.
        """
        n = self.n
        if self.sym_type == 'mirror':
            return random.choice([i for i in range(n % 2, n + 1, 2)])
        elif self.sym_type == 'diagonal':
            return random.choice([i for i in range(1, n + 1) if i % 2 == n % 2])
        elif self.sym_type == 'double_mirror':
            choices = [i for i in range(n + 1) if i % 2 == 0 and (n - i) % 4 == 0]
            return random.choice(choices)
        elif self.sym_type == 'rot_90':
            return 0
        elif self.sym_type == 'rot_180':
            limit = n // 2
            return random.choice([i for i in range(limit) if i % 2 == n % 2])
        return 0

    def _place_straddle_seeds(self, grid, count):
        """
        Plants `count` axis-straddling region seeds into grid and returns the
        number of region labels consumed (so _place_regular_seeds can continue
        from there).
        Note: the double_mirror case may place fewer seeds than requested if
        no valid placements are available; callers should treat the board as
        potentially malformed if this matters.
        """
        n = self.n
        labels_used = 0
        if count == 0:
            return 0

        if self.sym_type == 'mirror':
            mid = (n - 1) // 2
            rows = list(range(n))
            random.shuffle(rows)
            for _ in range(count):
                r = rows.pop()
                grid[self._get_idx(r, mid)] = labels_used
                grid[self._get_idx(r, n - 1 - mid)] = labels_used
                labels_used += 1

        elif self.sym_type == 'diagonal':
            cut_points = sorted(random.sample(range(1, n), count - 1))
            segments = zip([0] + cut_points, cut_points + [n])
            for start, end in segments:
                for i in range(start, end):
                    grid[self._get_idx(i, i)] = labels_used
                    if i < end - 1:
                        grid[self._get_idx(i, i + 1)] = labels_used
                        grid[self._get_idx(i + 1, i)] = labels_used
                labels_used += 1

        elif self.sym_type == 'double_mirror':
            mid = (n - 1) // 2
            for _ in range(count // 2):
                placed = False
                axes = ['v', 'h']
                random.shuffle(axes)
                for axis in axes:
                    if axis == 'v':
                        potential_pos = [(r, mid) for r in range(mid)]
                    else:
                        potential_pos = [(mid, c) for c in range(mid)]
                    random.shuffle(potential_pos)
                    for r, c in potential_pos:
                        if axis == 'v':
                            c2, r2 = (mid + 1 if n % 2 == 0 else mid), r
                            mr1, mc1, mr2, mc2 = n - 1 - r, c, n - 1 - r2, c2
                        else:
                            r2, c2 = (mid + 1 if n % 2 == 0 else mid), c
                            mr1, mc1, mr2, mc2 = r, n - 1 - c, r2, n - 1 - c2

                        cells_a = {self._get_idx(r, c), self._get_idx(r2, c2)}
                        cells_b = {self._get_idx(mr1, mc1), self._get_idx(mr2, mc2)}
                        if all(grid[idx] == -1 for idx in (cells_a | cells_b)):
                            for idx in cells_a:
                                grid[idx] = labels_used
                            labels_used += 1
                            for idx in cells_b:
                                grid[idx] = labels_used
                            labels_used += 1
                            placed = True
                            break
                    if placed:
                        break

        elif self.sym_type == 'rot_180':
            max_layers = n // 2
            pool = list(range(1, max_layers - 1))
            random.shuffle(pool)
            selected_layers = sorted([0] + pool[: count - 1])

            mid_start, mid_end = (n // 2) - 1, (n // 2)
            for ring_layer in selected_layers:
                r_min = mid_start - ring_layer
                r_max = mid_end + ring_layer
                c_min = mid_start - ring_layer
                c_max = mid_end + ring_layer
                for r in range(r_min, r_max + 1):
                    for c in range(c_min, c_max + 1):
                        if r == r_min or r == r_max or c == c_min or c == c_max:
                            idx = self._get_idx(r, c)
                            if idx is not None and grid[idx] == -1:
                                grid[idx] = labels_used
                labels_used += 1

        return labels_used

    def _place_regular_seeds(self, grid, labels_used):
        """
        Plants the remaining region seeds in symmetric orbits (pairs for most
        symmetry types, quads for double_mirror and rot_90) until all n regions
        have been seeded.
        """
        n = self.n
        total_regions = n
        if labels_used >= total_regions:
            return
        orbit_size = 4 if self.sym_type in self._QUAD_SYMMETRIES else 2
        indices = [i for i in range(n * n) if grid[i] == -1]
        random.shuffle(indices)
        current_label = labels_used
        for idx in indices:
            if current_label >= total_regions:
                break
            orbit = list(set(self.get_orbit(idx)))
            if len(orbit) == orbit_size and all(grid[o] == -1 for o in orbit):
                for i, o_idx in enumerate(orbit):
                    grid[o_idx] = current_label + i
                current_label += orbit_size

    # -- Flood fill -----------------------------------------------------------

    def symmetric_flood_fill(self, grid):
        """
        Grows all seeded regions symmetrically until the board is full.

        Maintains an explicit frontier list and membership set of
        (unfilled, filled_neighbour) pairs so each iteration picks from only
        the live boundary rather than rescanning all n² cells.  When a cell is
        filled its symmetric images are filled with the corresponding image
        labels, and their newly exposed neighbours are added to the frontier.
        """
        n = self.n

        frontier = []
        frontier_set = set()
        for i in range(n * n):
            if grid[i] == -1:
                for nb in get_neighbors_4(i, n):
                    if grid[nb] != -1:
                        pair = (i, nb)
                        if pair not in frontier_set:
                            frontier.append(pair)
                            frontier_set.add(pair)

        while frontier:
            pick_idx = random.randrange(len(frontier))
            # Swap-and-pop for O(1) removal.
            frontier[pick_idx], frontier[-1] = frontier[-1], frontier[pick_idx]
            u_idx, l_idx = frontier.pop()
            frontier_set.discard((u_idx, l_idx))

            if grid[u_idx] != -1:
                continue

            u_orbit = self.get_orbit(u_idx)
            l_orbit = self.get_orbit(l_idx)

            for u_img, l_img in zip(u_orbit, l_orbit):
                if grid[u_img] == -1:
                    grid[u_img] = grid[l_img]
                    for nb in get_neighbors_4(u_img, n):
                        if grid[nb] == -1:
                            pair = (nb, u_img)
                            if pair not in frontier_set:
                                frontier.append(pair)
                                frontier_set.add(pair)

    # -- Public interface -----------------------------------------------------

    def _try_generate(self):
        """
        Attempts to generate a symmetric board with at least one valid Star
        Battle solution.  Returns (flat_board_string, solution_set) on success,
        or None on failure.  The outer retry loop in Generator.generate()
        handles repeated attempts.
        """
        grid = [-1] * (self.n * self.n)
        straddle_count = self._decide_straddle_count()
        labels_used = self._place_straddle_seeds(grid, straddle_count)
        self._place_regular_seeds(grid, labels_used)
        self.symmetric_flood_fill(grid)

        solutions = get_all_solutions(grid, self.n)
        return self._make_result(grid, solutions)

    def _debug_print(self, grid):
        """Prints the given grid state using region label characters."""
        from board_utils import ALPHABET
        flat = "".join(
            ALPHABET[grid[r * self.n + c]] if grid[r * self.n + c] != -1 else "."
            for r in range(self.n)
            for c in range(self.n)
        )
        pretty_print(flat, self.n)


if __name__ == "__main__":
    for m in ['mirror', 'diagonal', 'double_mirror', 'rot_90', 'rot_180']:
        print(f"\n--- Symmetric Generator: {m} (N=8) ---")
        gen = SymmetricGenerator(8, m)
        board, solutions = gen.generate()
        pretty_print(board, 8)
        print(f"Solutions: {len(solutions)}")
