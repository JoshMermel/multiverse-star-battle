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

Unassigned cells are represented as None throughout, consistent with all
other generators.
"""

import random
from board_utils import get_neighbors_4, pretty_print
from generator import Generator

class SymmetricGenerator(Generator):
    # Symmetry types that require orbit quads (4 cells per region seed).
    _QUAD_SYMMETRIES = frozenset({'double_mirror', 'rot_90'})

    def __init__(self, n, symmetry_type=None):
        super().__init__(n)
        valid_symmetries = ['mirror', 'diagonal', 'double_mirror', 'rot_90', 'rot_180']
        self.sym_type = symmetry_type if symmetry_type else random.choice(valid_symmetries)

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
            return random.choice([i for i in range(n + 1) if (n - i) % 4 == 0])
        elif self.sym_type == 'rot_90':
            # The only valid straddle count is n%4 (so the remainder divides
            # into 4-cell quad orbits).  We also require count <= n//2 - 1 so
            # the outermost ring never touches the board border (which would
            # make the board unsolvable).  For N=7 these two constraints
            # conflict (n%4=3 > n//2-1=2), so rot_90 is unsupported there.
            count = n % 4
            if count > n // 2 - 1:
                return None  # signals _try_generate to skip this attempt
            return count
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
                # Even N straddles are on both sides of the midline
                if n % 2 == 0:
                    grid[self._get_idx(r, mid + 1)] = labels_used
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
            mid = n // 2
            # 1. Place the unique center seed for odd N
            if n % 2 != 0:
                grid[self._get_idx(mid, mid)] = labels_used
                labels_used += 1

            # 2. Identify potential straddle orbits
            potential_orbits = []
            if n % 2 == 0:
                # Even N: Use the 2-cell adjacent pairs crossing the midlines
                for i in range(mid):
                    potential_orbits.append({
                        'primary': [(i, mid - 1), (i, mid)],
                        'mirror':  [(n - 1 - i, mid - 1), (n - 1 - i, mid)]
                    })
                    potential_orbits.append({
                        'primary': [(mid - 1, i), (mid, i)],
                        'mirror':  [(mid - 1, n - 1 - i), (mid, n - 1 - i)]
                    })
            else:
                # Odd N: Use single cells located directly on the midlines
                for i in range(mid):
                    # Cells on the vertical axis (excluding the center)
                    potential_orbits.append({
                        'primary': [(i, mid)],
                        'mirror':  [(n - 1 - i, mid)]
                    })
                    # Cells on the horizontal axis (excluding the center)
                    potential_orbits.append({
                        'primary': [(mid, i)],
                        'mirror':  [(mid, n - 1 - i)]
                    })

            random.shuffle(potential_orbits)

            # 3. Place regions in symmetric partner pairs
            remaining = count - (1 if n % 2 != 0 else 0)
            for _ in range(remaining // 2):
                if not potential_orbits: break
                orbit = potential_orbits.pop()

                # Assign one label to the primary cell(s)
                for r, c in orbit['primary']:
                    grid[self._get_idx(r, c)] = labels_used
                labels_used += 1

                # Assign a different label to the mirror partner(s)
                for r, c in orbit['mirror']:
                    grid[self._get_idx(r, c)] = labels_used
                labels_used += 1

        elif self.sym_type in ('rot_90', 'rot_180'):
            is_odd = (n % 2 != 0)
            selected_layers = list(range(count))

            for layer in selected_layers:
                if is_odd and layer == 0:
                    grid[self._get_idx(n // 2, n // 2)] = labels_used
                else:
                    offset = 0 if is_odd else -1
                    r_min = (n // 2) - layer + offset
                    r_max = (n // 2) + layer
                    c_min = (n // 2) - layer + offset
                    c_max = (n // 2) + layer
                    for r in range(r_min, r_max + 1):
                        for c in range(c_min, c_max + 1):
                            if r == r_min or r == r_max or c == c_min or c == c_max:
                                idx = self._get_idx(r, c)
                                if idx is not None: grid[idx] = labels_used
                labels_used += 1

        return labels_used

    def _place_regular_seeds(self, grid, labels_used):
        """
        Plants the remaining region seeds in symmetric orbits (pairs for most
        symmetry types, quads for double_mirror and rot_90) until all n regions
        have been seeded.
        """
        n = self.n
        orbit_size = 4 if self.sym_type in self._QUAD_SYMMETRIES else 2
        indices = [i for i in range(n * n) if grid[i] is None]
        random.shuffle(indices)
        current_label = labels_used

        for idx in indices:
            if current_label >= n:
                break
            orbit = list(set(self.get_orbit(idx)))
            if len(orbit) == orbit_size and all(grid[o] is None for o in orbit):
                # Each orbit cell gets its own label; symmetric_flood_fill grows
                # them in lockstep so they form one symmetric region per orbit.
                for o_idx in orbit:
                    grid[o_idx] = current_label
                    current_label += 1

    # -- Flood fill -----------------------------------------------------------

    def symmetric_flood_fill(self, grid):
        """
        Grows all seeded regions symmetrically until the board is full.

        Maintains an explicit frontier list and membership set of
        (unfilled, filled_neighbour) pairs so each iteration picks from only
        the live boundary rather than rescanning all n² cells.  When a cell is
        filled its symmetric images are filled with the corresponding image
        labels, and their newly exposed neighbours are added to the frontier.

        Returns True if the board was filled successfully, False if the failure
        budget was exhausted (indicating an unsatisfiable seed configuration).
        """

        n = self.n
        frontier = []
        frontier_set = set()
        for i in range(n * n):
            if grid[i] is None:
                for nb in get_neighbors_4(i, n):
                    if grid[nb] is not None:
                        pair = (i, nb)
                        if pair not in frontier_set:
                            frontier.append(pair)
                            frontier_set.add(pair)

        max_failures = 200
        failures = 0

        while frontier and failures < max_failures:
            # Swap-and-pop: O(1) random removal without shuffling the whole list.
            pick = random.randrange(len(frontier))
            frontier[pick], frontier[-1] = frontier[-1], frontier[pick]
            u_idx, l_idx = frontier.pop()
            frontier_set.discard((u_idx, l_idx))

            if grid[u_idx] is not None:
                continue

            u_orbit = self.get_orbit(u_idx)
            l_orbit = self.get_orbit(l_idx)

            # 1. Consistency Check:
            # We must ensure that this expansion doesn't try to assign
            # different labels to the same physical cell.
            candidate_assignments = {}
            possible = True

            for u_img, l_img in zip(u_orbit, l_orbit):
                label_to_assign = grid[l_img]

                # If the target cell is already filled, it must match the label
                # we are trying to assign (this handles symmetric straddlers).
                if grid[u_img] is not None:
                    if grid[u_img] != label_to_assign:
                        possible = False
                        break

                # If we've already proposed a different label for this physical
                # cell during this specific orbit expansion, it's a conflict.
                if u_img in candidate_assignments:
                    if candidate_assignments[u_img] != label_to_assign:
                        possible = False
                        break

                candidate_assignments[u_img] = label_to_assign

            if not possible:
                failures += 1
                continue

            # 2. Commit the expansion.
            for u_img, label in candidate_assignments.items():
                if grid[u_img] is None:
                    grid[u_img] = label
                    for nb in get_neighbors_4(u_img, n):
                        if grid[nb] is None:
                            pair = (nb, u_img)
                            if pair not in frontier_set:
                                frontier.append(pair)
                                frontier_set.add(pair)

        return failures < max_failures

    # -- Public interface -----------------------------------------------------

    def _try_generate(self):
        """
        Attempts to generate a symmetric board with at least one valid Star
        Battle solution.  Returns (flat_board_string, solution_set) on success,
        or None on failure.  The outer retry loop in Generator.generate()
        handles repeated attempts.
        """
        grid = [None] * (self.n * self.n)
        straddle_count = self._decide_straddle_count()
        if straddle_count is None:
            return None  # unsupported N/symmetry combination
        labels_used = self._place_straddle_seeds(grid, straddle_count)
        self._place_regular_seeds(grid, labels_used)
        if not self.symmetric_flood_fill(grid):
            return None
        return self._make_result(grid)

    def _debug_print(self, grid):
        """Prints the given grid state using region label characters."""
        from board_utils import ALPHABET
        flat = "".join(
            ALPHABET[grid[r * self.n + c]] if grid[r * self.n + c] is not None else "."
            for r in range(self.n)
            for c in range(self.n)
        )
        pretty_print(flat, self.n)

if __name__ == "__main__":
    for m in ['mirror', 'diagonal', 'double_mirror', 'rot_90', 'rot_180']:
        print(f"\n--- Symmetric Generator: {m} (N=8) ---")
        SymmetricGenerator.demo(8, symmetry_type=m)
