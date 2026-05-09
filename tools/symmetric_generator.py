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

Fixed-point pre-seeding
-----------------------
A "fixed point" is a cell whose symmetric image is itself.  If flood fill
ever expands two different regions into the same fixed point simultaneously,
the conflict is unresolvable.  To prevent this, every fixed point is
guaranteed to be assigned during straddle seeding before flood fill begins:

  mirror (odd N)        : entire middle column (n cells)
  diagonal              : entire main diagonal (n cells)
  double_mirror (odd N) : middle column + middle row, sharing the centre cell
  rot_90 / rot_180      : centre cell only (odd N); none for even N

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
        Returns how many axis-straddling region seeds to place, chosen
        uniformly at random from all valid values.  A count is valid when the
        remaining (n - count) regions divide evenly into full-size orbits.
        Returns None for unsupported N/symmetry combinations.
        """
        n = self.n
        if self.sym_type == 'mirror':
            if n % 2 == 1:
                # Odd N: the entire middle column must be seeded to cover all
                # fixed points before flood fill.  The column has n cells so
                # count must be odd (segments) and divide n rows; any odd value
                # from 1 to n is valid since we use contiguous segments.
                return random.choice(range(1, n + 1, 2))
            else:
                # Even N: no fixed points; each straddle covers one row's
                # mid-column pair, so count can be any even value from 0 to n.
                return random.choice(range(0, n + 1, 2))
        elif self.sym_type == 'diagonal':
            return random.choice([i for i in range(1, n + 1) if i % 2 == n % 2])
        elif self.sym_type == 'double_mirror':
            return random.choice([i for i in range(n + 1) if (n - i) % 4 == 0])
        elif self.sym_type == 'rot_90':
            # The only valid count is n%4. We also require count <= n//2 - 1
            # so no ring touches the board border (which would be unsolvable).
            # For N=7 these constraints conflict (n%4=3 > n//2-1=2), so rot_90
            # is unsupported for that N.
            count = n % 4
            if count > n // 2 - 1:
                return None
            return count
        elif self.sym_type == 'rot_180':
            return random.choice([i for i in range(n // 2) if i % 2 == n % 2])
        return 0

    def _place_straddle_seeds(self, grid, count):
        """
        Plants `count` axis-straddling region seeds into grid and returns
        the number of region labels consumed.
        """
        n = self.n
        labels_used = 0
        if count == 0:
            return 0

        if self.sym_type == 'mirror':
            mid = (n - 1) // 2
            if n % 2 == 1:
                # Odd N: divide the middle column into `count` contiguous
                # segments using random cut points.  Each segment is one
                # region, guaranteeing every fixed point is pre-seeded and
                # that all seeds are contiguous.
                cut_points = sorted(random.sample(range(1, n), count - 1))
                segments = zip([0] + cut_points, cut_points + [n])
                for start, end in segments:
                    for r in range(start, end):
                        grid[self._get_idx(r, mid)] = labels_used
                    labels_used += 1
            else:
                # Even N: each straddle covers both cells that straddle the
                # vertical midline in a single row.
                rows = list(range(n))
                random.shuffle(rows)
                for _ in range(count):
                    r = rows.pop()
                    grid[self._get_idx(r, mid)] = labels_used
                    grid[self._get_idx(r, mid + 1)] = labels_used
                    labels_used += 1

        elif self.sym_type == 'diagonal':
            # Divide the main diagonal into `count` contiguous segments.
            # Adjacent off-diagonal cells are included so each region spans
            # across the axis of symmetry.
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
            if n % 2 == 0:
                # Even N: straddle seeds are 2-cell pairs that cross the
                # vertical or horizontal midline.  The 2x2 centre block sits at
                # the intersection of both midlines and would be claimed by both
                # a v-straddle and an h-straddle; we exclude h-straddle orbits
                # that touch it to avoid overwriting.  Those cells are absorbed
                # into the v-straddle region during flood fill.
                centre = {(mid-1, mid-1), (mid-1, mid), (mid, mid-1), (mid, mid)}
                potential_orbits = []
                for i in range(mid):
                    v_orb = {
                        'primary': [(i, mid-1), (i, mid)],
                        'mirror':  [(n-1-i, mid-1), (n-1-i, mid)],
                    }
                    h_orb = {
                        'primary': [(mid-1, i), (mid, i)],
                        'mirror':  [(mid-1, n-1-i), (mid, n-1-i)],
                    }
                    potential_orbits.append(v_orb)
                    if not (set(h_orb['primary']) | set(h_orb['mirror'])) & centre:
                        potential_orbits.append(h_orb)
                random.shuffle(potential_orbits)
                assert len(potential_orbits) >= count // 2, (
                    f"double_mirror even N={n}: need {count // 2} orbit pairs "
                    f"but only {len(potential_orbits)} available"
                )
                for _ in range(count // 2):
                    orbit = potential_orbits.pop()
                    for r, c in orbit['primary']:
                        grid[self._get_idx(r, c)] = labels_used
                    labels_used += 1
                    for r, c in orbit['mirror']:
                        grid[self._get_idx(r, c)] = labels_used
                    labels_used += 1
            else:
                # Odd N: the middle column and middle row are all fixed points
                # and must be fully pre-seeded.  The column is divided into
                # v_count contiguous segments and the row into h_count segments;
                # the centre cell belongs to the column's centre segment and is
                # reused as the label for the row's centre segment so both arms
                # form one region.
                v_count = random.choice([i for i in range(1, count + 1, 2) if (count - i + 1) <= n])
                h_count = count - v_count + 1

                def get_palindromic_partition(total_len, num_segments):
                    """
                    Splits total_len into num_segments contiguous parts whose
                    sizes are palindromic (symmetric around a centre part of
                    size 1).  This ensures seeded regions respect the double-
                    mirror symmetry.
                    """
                    if num_segments == 1:
                        return [total_len]
                    half_segs = num_segments // 2
                    half_len = total_len // 2
                    divs = sorted(random.sample(range(1, half_len), half_segs - 1))
                    parts = []
                    last = 0
                    for d in divs:
                        parts.append(d - last)
                        last = d
                    parts.append(half_len - last)
                    return parts + [1] + parts[::-1]

                v_parts = get_palindromic_partition(n, v_count)
                h_parts = get_palindromic_partition(n, h_count)

                curr_r = 0
                for i, size in enumerate(v_parts):
                    label = labels_used
                    for r in range(curr_r, curr_r + size):
                        grid[self._get_idx(r, mid)] = label
                    if i == len(v_parts) // 2:
                        centre_label = label
                    labels_used += 1
                    curr_r += size

                curr_c = 0
                for i, size in enumerate(h_parts):
                    label = centre_label if i == len(h_parts) // 2 else labels_used
                    for c in range(curr_c, curr_c + size):
                        grid[self._get_idx(mid, c)] = label
                    if i != len(h_parts) // 2:
                        labels_used += 1
                    curr_c += size

        elif self.sym_type in ('rot_90', 'rot_180'):
            # Straddle seeds are concentric square rings centred on the grid.
            # Layer 0 for odd N is the single centre cell; each subsequent
            # layer is the next ring outward.  _decide_straddle_count ensures
            # all rings fit within the board (r_min >= 1), so no out-of-bounds
            # check is needed in the ring-drawing loop.
            is_odd = (n % 2 != 0)
            for layer in range(count):
                if is_odd and layer == 0:
                    grid[self._get_idx(n // 2, n // 2)] = labels_used
                else:
                    offset = 0 if is_odd else -1
                    r_min = (n // 2) - layer + offset
                    r_max = (n // 2) + layer
                    for r in range(r_min, r_max + 1):
                        for c in range(r_min, r_max + 1):
                            if r == r_min or r == r_max or c == r_min or c == r_max:
                                grid[r * n + c] = labels_used
                labels_used += 1

        return labels_used

    def _place_regular_seeds(self, grid, labels_used):
        """
        Plants the remaining region seeds in symmetric orbits — pairs for most
        symmetry types, quads for double_mirror and rot_90 — until all n
        regions have been seeded.

        Each cell in an orbit receives its own label rather than sharing one.
        symmetric_flood_fill grows orbit cells in lockstep so they form one
        symmetric region without needing identical labels.
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
                for o_idx in orbit:
                    grid[o_idx] = current_label
                    current_label += 1

    # -- Flood fill -----------------------------------------------------------

    def symmetric_flood_fill(self, grid):
        """
        Grows all seeded regions symmetrically until the board is full.

        Maintains a frontier of (unfilled_cell, filled_neighbour) pairs.
        Each iteration picks a pair at random, computes the symmetric orbit
        of both cells, and propagates the neighbour's label to the unfilled
        cell and all its images simultaneously.

        The only conflict that can arise is two images in the same expansion
        step aliasing to the same physical cell with different proposed labels.
        This is counted as a failure; if failures exceed the budget the board
        is considered unsatisfiable and False is returned.

        Fixed-point conflicts cannot occur because all fixed points are
        pre-seeded by _place_straddle_seeds before flood fill begins.

        Returns True on success, False if the failure budget is exhausted.
        """
        n = self.n
        frontier = []
        for i in range(n * n):
            if grid[i] is None:
                for nb in get_neighbors_4(i, n):
                    if grid[nb] is not None:
                        frontier.append((i, nb))

        max_failures = 200
        failures = 0

        while frontier and failures < max_failures:
            pick = random.randrange(len(frontier))
            frontier[pick], frontier[-1] = frontier[-1], frontier[pick]
            u_idx, l_idx = frontier.pop()

            if grid[u_idx] is not None:
                continue

            u_orbit = self.get_orbit(u_idx)
            l_orbit = self.get_orbit(l_idx)

            # Build proposed assignments for this expansion step, checking that
            # no two orbit images alias to the same cell with different labels.
            candidate_assignments = {}
            possible = True
            for u_img, l_img in zip(u_orbit, l_orbit):
                label = grid[l_img]
                if u_img in candidate_assignments and candidate_assignments[u_img] != label:
                    possible = False
                    break
                candidate_assignments[u_img] = label

            if not possible:
                failures += 1
                continue

            for u_img, label in candidate_assignments.items():
                if grid[u_img] is None:
                    grid[u_img] = label
                    for nb in get_neighbors_4(u_img, n):
                        if grid[nb] is None:
                            frontier.append((nb, u_img))

        return failures < max_failures

    # -- Public interface -----------------------------------------------------

    def _try_generate(self):
        """
        Attempts to generate a symmetric board with at least MIN_SOLUTIONS
        valid Star Battle solutions.  Returns (flat_board_string, solutions)
        on success, or None on failure.
        """
        grid = [None] * (self.n * self.n)
        straddle_count = self._decide_straddle_count()
        if straddle_count is None:
            return None  # unsupported N/symmetry combination (e.g. rot_90, N=7)
        labels_used = self._place_straddle_seeds(grid, straddle_count)
        self._place_regular_seeds(grid, labels_used)
        if not self.symmetric_flood_fill(grid):
            return None
        return self._make_result(grid)


if __name__ == "__main__":
    for m in ['mirror', 'diagonal', 'double_mirror', 'rot_90', 'rot_180']:
        print(f"\n--- Symmetric Generator: {m} (N=8) ---")
        SymmetricGenerator.demo(7, symmetry_type=m)
