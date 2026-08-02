"""
symmetric_generator.py

Generates Star Battle boards with one of six structural symmetry types:
  mirror          - left/right reflection
  diagonal        - transpose (main diagonal reflection)
  double_mirror   - both horizontal and vertical axis reflection
  double_diagonal - both diagonal reflections (implies 180-degree rotation), but NOT mirror
  rot_90          - 90-degree rotational symmetry (implies rot_180 and rot_270 too)
  rot_180         - 180-degree rotational symmetry
  octo            - 8-fold symmetry (N=8, no translation; pulls from an allowlist)

And one of eight translation types that tile a smaller sub-board across the full grid:
  none       - no tiling, generate the full NxN board directly (default)
  vsplit     - tile a (N/2 rows) x (N cols) sub-board top-to-bottom   [N even]
  hsplit     - tile a (N rows) x (N/2 cols) sub-board left-to-right   [N even]
  quadrants  - tile a (N/2 x N/2) sub-board into all four quadrants   [N div 4]
  vfence     - tile a (N/4 rows) x (N cols) sub-board, 4 rows tall    [N div 4]
  hfence     - tile a (N rows) x (N/4 cols) sub-board, 4 cols wide    [N div 4]
  vsplit3    - tile a (N/3 rows) x (N cols) sub-board top-to-bottom,  [N div 3]
               3 copies (e.g. three 3x9 bands for N=9)
  hsplit3    - tile a (N rows) x (N/3 cols) sub-board left-to-right,  [N div 3]
               3 copies (e.g. three 9x3 bands for N=9)

Symmetry types that require square geometry (diagonal, double_diagonal, rot_90, octo) are
incompatible with any translation_type other than "none".  rot_180 with a non-none
translation type requires the rectangular sub-board to have matching row/col parity
(both even, as with N divisible by 4; or both odd, as with vsplit3/hsplit3 on N=9) so
there's a well-defined centre-of-rotation.

Allowlist-based generation
--------------------------
Two symmetry types use allowlists rather than procedural generation:

  rot_90 (N=8 only) — call set_allowlist('rot_90', [...]) before generating.
  octo   (N=8 only) — call set_allowlist('octo',   [...]) before generating.

Each allowlist entry is a 64-character string of uppercase letters (A–H) encoding
region labels in row-major order.  set_allowlist() deduplicates entries.  If the
relevant allowlist is empty, _try_generate returns None (the generator will retry
up to its normal budget).

Each translation copy uses a distinct set of region labels, so the full NxN board
always has exactly N regions; each copy just happens to be congruent in shape.

Seeding strategy (sub-board / full-board)
-----------------------------------------
Each symmetry type has an axis or fixed-point locus where a region can "straddle"
the axis of symmetry.  _decide_straddle_count picks how many such axis-straddling
region seeds to place first; _place_straddle_seeds plants them.
_place_regular_seeds then places the remaining regions in symmetric orbit pairs
(or quads for rot_90 / double_mirror).  symmetric_flood_fill grows all seeded
regions simultaneously while preserving the chosen symmetry.

All of these methods operate on a _RectContext that carries (rows, cols, n_regions,
sym_type), so the same logic handles both rectangular sub-boards and the full square.

Fixed-point pre-seeding
-----------------------
A "fixed point" is a cell whose symmetric image is itself.  If flood fill ever
expands two different regions into the same fixed point simultaneously, the conflict
is unresolvable.  To prevent this, every fixed point is guaranteed to be assigned
during straddle seeding before flood fill begins:

  mirror (odd cols)     : entire middle column (rows cells)
  diagonal              : entire main diagonal (n cells)       [square only]
  double_mirror (odd N) : middle column + middle row, sharing the centre cell
  rot_90 / rot_180      : centre cell only (odd N); none for even N
"""

import random
from dataclasses import dataclass, field
from typing import Optional
from generator import Generator
from symmetric_allowlists import ALLOWLISTS as _ALLOWLISTS


def _rect_neighbors(flat: int, cols: int, rows: int) -> list:
    """
    4-connected neighbours of flat index in a (rows x cols) rectangle.

    This is the rectangular generalisation of board_utils.get_neighbors_4,
    which only handles square boards.  For square boards (rows == cols) the
    two are equivalent.
    """
    r, c = divmod(flat, cols)
    result = []
    if r > 0:
        result.append((r - 1) * cols + c)
    if r < rows - 1:
        result.append((r + 1) * cols + c)
    if c > 0:
        result.append(r * cols + c - 1)
    if c < cols - 1:
        result.append(r * cols + c + 1)
    return result


# ── Compatibility tables ──────────────────────────────────────────────────────

# Symmetry types that produce 4-cell orbits (require n_regions divisible by 4
# after straddle seeds are placed).
_QUAD_SYMMETRIES = frozenset({'double_mirror', 'double_diagonal', 'rot_90'})

# Symmetry types that require square geometry (their orbits/axes assume rows==cols).
# These are incompatible with translation types whose sub-board is rectangular.
# quadrants produces an N/2 x N/2 sub-board (square), so it's fine.
# vsplit/hsplit/vfence/hfence/vsplit3/hsplit3 produce rectangular sub-boards, so they're not.
_SQUARE_ONLY_SYMMETRIES = frozenset({'diagonal', 'double_diagonal', 'rot_90', 'octo'})
_RECT_TRANSLATION_TYPES = frozenset({'vsplit', 'hsplit', 'vfence', 'hfence', 'vsplit3', 'hsplit3'})

_VALID_SYMMETRIES = ['none', 'mirror', 'diagonal', 'double_mirror',
                     'double_diagonal', 'rot_90', 'rot_180', 'octo']

_VALID_TRANSLATIONS = ['none', 'vsplit', 'hsplit', 'quadrants', 'vfence', 'hfence',
                       'vsplit3', 'hsplit3']


def set_allowlist(symmetry_type: str, entries: list[str]) -> None:
    """
    Register an allowlist for a symmetry type that supports it ('rot_90' or 'octo').

    entries — list of 64-character strings where each character is an uppercase
              letter (A–H for an 8×8 board) encoding the region label for that
              cell in row-major order.  Duplicate entries are silently removed.
    """
    if symmetry_type not in _ALLOWLISTS:
        raise ValueError(
            f"set_allowlist: symmetry_type {symmetry_type!r} does not support "
            f"allowlists.  Choose from {list(_ALLOWLISTS)}."
        )
    seen: set[str] = set()
    clean: list[str] = []
    for e in entries:
        if e not in seen:
            seen.add(e)
            clean.append(e)
    _ALLOWLISTS[symmetry_type] = clean


def _decode_allowlist_entry(entry: str, n: int = 8) -> list[int]:
    """
    Convert a 64-char allowlist string into a flat integer grid (0-based labels).
    'A' → 0, 'B' → 1, … 'H' → 7.
    """
    if len(entry) != n * n:
        raise ValueError(
            f"Allowlist entry has length {len(entry)}, expected {n * n}."
        )
    return [ord(ch) - ord('A') for ch in entry.upper()]


def _sub_board_shape(n: int, translation_type: str):
    """
    Returns (rows, cols, n_regions) for the sub-board implied by translation_type.
    For 'none' this is just (n, n, n).
    """
    if translation_type == 'none':
        return n, n, n
    elif translation_type == 'vsplit':
        return n // 2, n, n // 2
    elif translation_type == 'hsplit':
        return n, n // 2, n // 2
    elif translation_type == 'quadrants':
        return n // 2, n // 2, n // 4
    elif translation_type == 'vfence':
        return n // 4, n, n // 4
    elif translation_type == 'hfence':
        return n, n // 4, n // 4
    elif translation_type == 'vsplit3':
        return n // 3, n, n // 3
    elif translation_type == 'hsplit3':
        return n, n // 3, n // 3
    else:
        raise ValueError(f"Unknown translation_type: {translation_type!r}")


# ── Sub-board context ─────────────────────────────────────────────────────────

@dataclass
class _RectContext:
    """
    Carries the geometry and symmetry type for a single rectangular sub-board.

    rows, cols  — dimensions of the sub-board
    n_regions   — number of distinct regions to place (equals n for the full board)
    sym_type    — one of _VALID_SYMMETRIES; 'none' means no intra-sub-board symmetry
    """
    rows: int
    cols: int
    n_regions: int
    sym_type: str  # one of _VALID_SYMMETRIES; 'none' means no intra-sub-board symmetry
    join_earlier_prob: float = 0.2
    stars_per_unit: int = 1
    # Per-instance memo for get_orbit -- a pure function of (flat, sym_type,
    # rows, cols) that flood_fill calls very frequently (often several times
    # for the same cell before it's finally resolved, since a still-unfilled
    # cell can be re-added to flood_fill's frontier by more than one
    # already-filled neighbor). Computed lazily per flat index rather than
    # eagerly for the whole board, since not every _RectContext instance
    # necessarily runs flood_fill to completion.
    _orbit_cache: dict = field(default_factory=dict, init=False, repr=False, compare=False)

    # ── Index helpers ─────────────────────────────────────────────────────────

    def idx(self, r: int, c: int) -> Optional[int]:
        """Flat index for (r, c), or None if out of bounds."""
        if 0 <= r < self.rows and 0 <= c < self.cols:
            return r * self.cols + c
        return None

    def rc(self, flat: int):
        """(row, col) from a flat index."""
        return divmod(flat, self.cols)

    def size(self) -> int:
        return self.rows * self.cols

    # ── Orbit ─────────────────────────────────────────────────────────────────

    def get_orbit(self, flat: int):
        """
        All flat indices that are symmetric images of flat under sym_type.
        Out-of-bounds images are filtered out.  When sym_type is 'none' every
        cell is its own orbit. Memoized per flat index -- see _orbit_cache.
        """
        cached = self._orbit_cache.get(flat)
        if cached is not None:
            return cached
        orbit = self._compute_orbit(flat)
        self._orbit_cache[flat] = orbit
        return orbit

    def _compute_orbit(self, flat: int):
        r, c = self.rc(flat)
        R, C = self.rows, self.cols

        if self.sym_type == 'mirror':
            # Left-right reflection across the vertical midline of the sub-board.
            candidates = [flat, self.idx(r, C - 1 - c)]
        elif self.sym_type == 'diagonal':
            # Only valid for square sub-boards (rows == cols).
            candidates = [flat, self.idx(c, r)]
        elif self.sym_type == 'double_diagonal':
            candidates = [flat,
                          self.idx(c, r),
                          self.idx(C - 1 - c, R - 1 - r),
                          self.idx(R - 1 - r, C - 1 - c)]
        elif self.sym_type == 'double_mirror':
            candidates = [flat,
                          self.idx(r, C - 1 - c),
                          self.idx(R - 1 - r, c),
                          self.idx(R - 1 - r, C - 1 - c)]
        elif self.sym_type == 'rot_90':
            # Only valid for square sub-boards.
            candidates = [flat,
                          self.idx(c, R - 1 - r),
                          self.idx(R - 1 - r, C - 1 - c),
                          self.idx(C - 1 - c, r)]
        elif self.sym_type == 'rot_180':
            candidates = [flat, self.idx(R - 1 - r, C - 1 - c)]
        else:
            candidates = [flat]

        return [i for i in candidates if i is not None]

    # ── Straddle count ────────────────────────────────────────────────────────

    def decide_straddle_count(self) -> Optional[int]:
        """
        Returns how many axis-straddling region seeds to place, chosen
        uniformly at random from all valid values.  Returns None when the
        N/symmetry combination is unsupported (e.g. rot_90 for certain sizes).

        The logic mirrors the original _decide_straddle_count but uses
        self.rows / self.cols / self.n_regions rather than a single n.
        """
        R, C, K = self.rows, self.cols, self.n_regions

        if self.sym_type == 'none':
            return 0

        elif self.sym_type == 'mirror':
            # Axis is the vertical midline of the sub-board (cols dimension).
            if C % 2 == 1:
                # Odd cols: middle column is all fixed points; must be fully seeded.
                return random.choice(range(1, K + 1, 2))
            else:
                # Even cols: no fixed points; straddle pairs span adjacent mid cols.
                return random.choice(range(0, K + 1, 2))

        elif self.sym_type == 'diagonal':
            # Square boards only; axis is the main diagonal.
            valid = [i for i in range(1, K + 1) if i % 2 == K % 2]
            if self.stars_per_unit == 2:
                # A forced-count experiment at N=9 (1.875M trials, 375k per
                # count) found ambiguous stars_per_unit=2 boards ONLY at
                # straddle counts 3 and 5 -- 0.149% and 0.078% yield
                # respectively -- while counts 1, 7, and 9 produced ZERO
                # successes across 375k trials each. Restrict to the odd
                # counts in [3, (K+1)//2] for 2-star generation.
                restricted = [i for i in valid if 3 <= i <= (K + 1) // 2]
                if restricted:
                    valid = restricted
            return random.choice(valid)

        elif self.sym_type == 'double_diagonal':
            valid = [i for i in range(3, K + 1) if (K - i) % 4 == 0]
            if not valid:
                return None
            return random.choice(valid)

        elif self.sym_type == 'double_mirror':
            return random.choice([i for i in range(K + 1) if (K - i) % 4 == 0])

        elif self.sym_type == 'rot_90':
            count = K % 4
            if count > K // 2 - 1:
                return None
            return count

        elif self.sym_type == 'rot_180':
            is_odd = (R % 2 != 0)
            max_possible = min(R // 2, C // 2) + (1 if is_odd else 0)
            max_possible = min(max_possible, K)
            # (K - i) must be even so regular seeds can be placed in pairs
            valid_counts = [i for i in range(max_possible + 1) if (K - i) % 2 == 0]
            return random.choice(valid_counts) if valid_counts else 0

        return 0

    # ── Straddle seeding ──────────────────────────────────────────────────────

    def place_straddle_seeds(self, grid: list, count: int, label_offset: int = 0) -> int:
        """
        Plants `count` axis-straddling region seeds starting at label_offset.
        Returns the number of labels consumed (i.e. new label_offset for callers).

        grid is indexed over the sub-board (size = rows * cols).
        label_offset shifts all labels so that tiled copies don't share labels.
        """
        R, C = self.rows, self.cols
        labels_used = 0
        if count == 0:
            return 0

        if self.sym_type == 'mirror':
            mid = (C - 1) // 2
            if C % 2 == 1:
                # Odd cols: divide the middle column into `count` contiguous segments.
                cut_points = sorted(random.sample(range(1, R), count - 1))
                segments = list(zip([0] + cut_points, cut_points + [R]))
                for start, end in segments:
                    for r in range(start, end):
                        grid[self.idx(r, mid)] = label_offset + labels_used
                    labels_used += 1
            else:
                # Even cols: each straddle covers the two cells that straddle the midline.
                rows = list(range(R))
                random.shuffle(rows)
                for _ in range(count):
                    r = rows.pop()
                    grid[self.idx(r, mid)] = label_offset + labels_used
                    grid[self.idx(r, mid + 1)] = label_offset + labels_used
                    labels_used += 1

        elif self.sym_type == 'diagonal':
            n = R  # square, R == C
            instructions = ['N']
            rem_ns = count - 1
            rem_js = n - count
            rem_instructions = ['N'] * rem_ns + ['J'] * rem_js
            random.shuffle(rem_instructions)
            instructions.extend(rem_instructions)

            active_seeds = []
            for i in range(n):
                inst = instructions[i]
                if inst == 'N':
                    label = label_offset + labels_used
                    grid[self.idx(i, i)] = label
                    active_seeds.append((label, i))
                    labels_used += 1
                else:  # 'J'
                    if random.random() < self.join_earlier_prob and len(active_seeds) > 1:
                        target = random.choice(active_seeds[:-1])
                    else:
                        target = active_seeds[-1]
                    label, k = target
                    for r in range(k, i + 1):
                        grid[self.idx(r, i)] = label
                        grid[self.idx(i, r)] = label
                    for c in range(k, i + 1):
                        grid[self.idx(k, c)] = label
                        grid[self.idx(c, k)] = label
                    active_seeds = [s for s in active_seeds if not (k < s[1] < i)]
                    active_seeds = [s for s in active_seeds if s[0] != label]
                    active_seeds.append((label, i))

        elif self.sym_type == 'double_diagonal':
            n = R  # square

            def _even_palindromic_partition(total, num_segs):
                half = num_segs // 2
                if half == 0:
                    return []
                if half == 1:
                    a = total // 2
                    return [a, total - a]
                cuts = sorted(random.sample(range(1, total // 2), half - 1))
                outer = [cuts[0]] + [cuts[i] - cuts[i - 1] for i in range(1, half - 1)]
                inner = total // 2 - sum(outer)
                half_parts = outer + [inner]
                return half_parts + half_parts[::-1]

            def _seed_diagonal(diag_cells, parts):
                nonlocal labels_used
                pos = 0
                for part_size in parts:
                    label = label_offset + labels_used
                    for k in range(pos, pos + part_size):
                        r2, c2 = diag_cells[k]
                        cell = self.idx(r2, c2)
                        if grid[cell] is None:
                            grid[cell] = label
                        else:
                            label = grid[cell]
                        if k < pos + part_size - 1:
                            nr, nc = diag_cells[k + 1]
                            for br, bc in [(r2, nc), (nr, c2)]:
                                bridge = self.idx(br, bc)
                                if bridge is not None and grid[bridge] is None:
                                    grid[bridge] = label
                    labels_used += 1
                    pos += part_size

            main_cells = [(i, i) for i in range(n)]
            anti_cells = [(i, n - 1 - i) for i in range(n)]

            if n % 2 == 0:
                # Even N: the diagonals never share a cell, so each is
                # seeded independently exactly as before -- both counts
                # even, no centre region.
                valid_anti = [k for k in range(2, count, 2)]
                anti_count = random.choice(valid_anti) if valid_anti else 2
                main_count = count - anti_count
                _seed_diagonal(main_cells, _even_palindromic_partition(n, main_count))
                _seed_diagonal(anti_cells, _even_palindromic_partition(n, anti_count))
            else:
                # Odd N: main and anti-diagonal share the true centre
                # cell (n//2, n//2). Reserve exactly one label for a
                # single centre region that grows outward from that
                # cell along BOTH diagonals (arm_main/arm_anti cells
                # each direction, independently sized -- this is what
                # lets the centre region span more than one cell along
                # each diagonal). The rest of the straddle budget
                # (count - 1, always even) splits into an even count of
                # wing segments per diagonal, seeded on the leftover
                # cells outside the centre's reach via the exact same
                # (unmodified) wing logic as the even-N case -- removing
                # an odd-length, symmetric chunk from the middle of an
                # odd-length diagonal always leaves an even remainder,
                # so nothing about the wing math has to change.
                center = n // 2
                wing_total_segs = count - 1
                main_wing_segs = random.choice(range(0, wing_total_segs + 1, 2))
                anti_wing_segs = wing_total_segs - main_wing_segs

                # Grow the centre from the shared cell outward along each
                # axis, leaving >= 1 cell per wing segment on each side.
                max_arm_main = (n - 1 - main_wing_segs) // 2
                max_arm_anti = (n - 1 - anti_wing_segs) // 2
                arm_main = random.randint(0, max_arm_main)
                arm_anti = random.randint(0, max_arm_anti)

                center_label = label_offset + labels_used
                labels_used += 1

                def _seed_centre_arm(cells):
                    for k, (r2, c2) in enumerate(cells):
                        cell = self.idx(r2, c2)
                        if grid[cell] is None:
                            grid[cell] = center_label
                        if k < len(cells) - 1:
                            nr, nc = cells[k + 1]
                            for br, bc in [(r2, nc), (nr, c2)]:
                                bridge = self.idx(br, bc)
                                if bridge is not None and grid[bridge] is None:
                                    grid[bridge] = center_label

                _seed_centre_arm(main_cells[center - arm_main:center + arm_main + 1])
                _seed_centre_arm(anti_cells[center - arm_anti:center + arm_anti + 1])

                main_leftover = main_cells[:center - arm_main] + main_cells[center + arm_main + 1:]
                anti_leftover = anti_cells[:center - arm_anti] + anti_cells[center + arm_anti + 1:]
                _seed_diagonal(main_leftover, _even_palindromic_partition(len(main_leftover), main_wing_segs))
                _seed_diagonal(anti_leftover, _even_palindromic_partition(len(anti_leftover), anti_wing_segs))

        elif self.sym_type == 'double_mirror':
            mid_r, mid_c = R // 2, C // 2
            if R % 2 == 0 and C % 2 == 0:
                centre = {(mid_r - 1, mid_c - 1), (mid_r - 1, mid_c),
                          (mid_r, mid_c - 1), (mid_r, mid_c)}
                potential_orbits = []
                for i in range(mid_r):
                    v_orb = {
                        'primary': [(i, mid_c - 1), (i, mid_c)],
                        'mirror':  [(R - 1 - i, mid_c - 1), (R - 1 - i, mid_c)],
                    }
                    potential_orbits.append(v_orb)
                for i in range(mid_c):
                    h_orb = {
                        'primary': [(mid_r - 1, i), (mid_r, i)],
                        'mirror':  [(mid_r - 1, C - 1 - i), (mid_r, C - 1 - i)],
                    }
                    if not (set(h_orb['primary']) | set(h_orb['mirror'])) & centre:
                        potential_orbits.append(h_orb)
                random.shuffle(potential_orbits)
                assert len(potential_orbits) >= count // 2
                for _ in range(count // 2):
                    orbit = potential_orbits.pop()
                    for r2, c2 in orbit['primary']:
                        grid[self.idx(r2, c2)] = label_offset + labels_used
                    labels_used += 1
                    for r2, c2 in orbit['mirror']:
                        grid[self.idx(r2, c2)] = label_offset + labels_used
                    labels_used += 1
            else:
                # Odd rows or cols: middle row/column are all fixed points.
                mid = R // 2  # for the vertical axis (odd cols)
                v_count = random.choice(
                    [i for i in range(1, count + 1, 2) if (count - i + 1) <= C])
                h_count = count - v_count + 1

                def get_palindromic_partition(total_len, num_segments):
                    if num_segments == 1:
                        return [total_len]
                    half = num_segments // 2
                    cuts = sorted(random.sample(range(1, total_len // 2 + 1), half))
                    outer = [cuts[0]] + [cuts[i] - cuts[i - 1] for i in range(1, half)]
                    centre = total_len - 2 * sum(outer)
                    return outer + [centre] + outer[::-1]

                v_parts = get_palindromic_partition(R, v_count)
                h_parts = get_palindromic_partition(C, h_count)

                curr_r = 0
                centre_label = None
                for i, size in enumerate(v_parts):
                    label = label_offset + labels_used
                    for r2 in range(curr_r, curr_r + size):
                        grid[self.idx(r2, mid_c)] = label
                    if i == len(v_parts) // 2:
                        centre_label = label
                    labels_used += 1
                    curr_r += size

                curr_c = 0
                for i, size in enumerate(h_parts):
                    label = centre_label if i == len(h_parts) // 2 else label_offset + labels_used
                    for c2 in range(curr_c, curr_c + size):
                        grid[self.idx(mid_r, c2)] = label
                    if i != len(h_parts) // 2:
                        labels_used += 1
                    curr_c += size

        elif self.sym_type == 'rot_90':
            # Concentric square rings centred on the (square) sub-board.
            n = R  # square: R == C
            is_odd = (n % 2 != 0)
            for layer in range(count):
                if is_odd and layer == 0:
                    grid[self.idx(n // 2, n // 2)] = label_offset + labels_used
                else:
                    offset_val = 0 if is_odd else -1
                    r_min = (n // 2) - layer + offset_val
                    r_max = (n // 2) + layer
                    for r2 in range(r_min, r_max + 1):
                        for c2 in range(r_min, r_max + 1):
                            if r2 == r_min or r2 == r_max or c2 == r_min or c2 == r_max:
                                grid[self.idx(r2, c2)] = label_offset + labels_used
                labels_used += 1

        elif self.sym_type == 'rot_180':
            is_odd = (R % 2 != 0)
            for layer in range(count):
                if is_odd and layer == 0:
                    grid[self.idx(R // 2, C // 2)] = label_offset + labels_used
                else:
                    offset_val = 0 if is_odd else -1
                    r_min = (R // 2) - layer + offset_val
                    r_max = (R // 2) + layer
                    c_min = (C // 2) - layer + offset_val
                    c_max = (C // 2) + layer

                    for r2 in range(r_min, r_max + 1):
                        for c2 in range(c_min, c_max + 1):
                            if r2 == r_min or r2 == r_max or c2 == c_min or c2 == c_max:
                                cell = self.idx(r2, c2)
                                if cell is not None:
                                    grid[cell] = label_offset + labels_used
                labels_used += 1

        return labels_used

    # ── Regular seeding ───────────────────────────────────────────────────────

    def place_regular_seeds(self, grid: list, labels_used: int, label_offset: int = 0):
        """
        Plants the remaining region seeds in symmetric orbits until all
        n_regions have been seeded (relative to label_offset).
        """
        orbit_size = 4 if self.sym_type in _QUAD_SYMMETRIES else 2
        if self.sym_type == 'none':
            orbit_size = 1

        indices = [i for i in range(self.size()) if grid[i] is None]
        random.shuffle(indices)
        current_label = label_offset + labels_used

        for flat in indices:
            if current_label >= label_offset + self.n_regions:
                break
            orbit = list(set(self.get_orbit(flat)))
            if len(orbit) == orbit_size and all(grid[o] is None for o in orbit):
                for o_idx in orbit:
                    grid[o_idx] = current_label
                    current_label += 1

    # ── Flood fill ────────────────────────────────────────────────────────────

    def flood_fill(self, grid: list) -> bool:
        """
        Grows all seeded regions symmetrically until the sub-board is full.
        Returns True on success, False if the failure budget is exhausted.

        Works for both rectangular sub-boards and the full square board.
        """
        frontier = []
        for i in range(self.size()):
            if grid[i] is None:
                for nb in _rect_neighbors(i, self.cols, self.rows):
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
                    for nb in _rect_neighbors(u_img, self.cols, self.rows):
                        if grid[nb] is None:
                            frontier.append((nb, u_img))

        return failures < max_failures

    # ── Sub-board generation ──────────────────────────────────────────────────

    def try_fill(self, label_offset: int = 0) -> Optional[list]:
        """
        Attempts to generate a single filled sub-board.
        Returns a flat list of length (rows * cols) with integer labels
        in [label_offset, label_offset + n_regions), or None on failure.

        This is the rectangular generalisation of _try_generate's inner logic.
        """
        grid = [None] * self.size()

        straddle_count = self.decide_straddle_count()
        if straddle_count is None:
            return None  # unsupported combination (e.g. rot_90 for certain sizes)

        labels_used = self.place_straddle_seeds(grid, straddle_count, label_offset)
        self.place_regular_seeds(grid, labels_used, label_offset)

        if not self.flood_fill(grid):
            return None

        if any(v is None for v in grid):
            return None  # flood fill left gaps (shouldn't happen, but be safe)

        return grid


# ── Tiling helpers ────────────────────────────────────────────────────────────

def _tile_sub_board(sub_grid: list, sub_rows: int, sub_cols: int,
                    n: int, translation_type: str) -> list:
    """
    Copies a filled sub-board into the correct positions of a full NxN grid.

    Each of the (2 or 4) tile copies receives a distinct label range so that
    all N regions in the final board are distinct.  The sub-board uses labels
    [0, n_regions); each subsequent copy is shifted by n_regions.

    Returns a flat list of length n*n.
    """
    full = [None] * (n * n)
    n_regions = len(set(sub_grid))   # number of distinct labels in the sub-board

    for copy_index, (tile_r, tile_c) in enumerate(_tile_offsets(n, translation_type)):
        offset = copy_index * n_regions
        for sr in range(sub_rows):
            for sc in range(sub_cols):
                fr = tile_r + sr
                fc = tile_c + sc
                full[fr * n + fc] = sub_grid[sr * sub_cols + sc] + offset

    return full


def _tile_offsets(n: int, translation_type: str):
    """
    Returns a list of (row_offset, col_offset) pairs — one per tile copy —
    giving the top-left corner of each copy in the full NxN grid.
    """
    if translation_type == 'vsplit':
        return [(0, 0), (n // 2, 0)]
    elif translation_type == 'hsplit':
        return [(0, 0), (0, n // 2)]
    elif translation_type == 'quadrants':
        h = n // 2
        return [(0, 0), (0, h), (h, 0), (h, h)]
    elif translation_type == 'vfence':
        q = n // 4
        return [(i * q, 0) for i in range(4)]
    elif translation_type == 'hfence':
        q = n // 4
        return [(0, i * q) for i in range(4)]
    elif translation_type == 'vsplit3':
        t = n // 3
        return [(i * t, 0) for i in range(3)]
    elif translation_type == 'hsplit3':
        t = n // 3
        return [(0, i * t) for i in range(3)]
    else:
        raise ValueError(f"Unexpected translation_type in _tile_offsets: {translation_type!r}")



# ── Main generator ────────────────────────────────────────────────────────────

class SymmetricGenerator(Generator):
    """
    Generates Star Battle boards with optional intra-board structural symmetry
    and/or translation symmetry (tiling of a repeated sub-board pattern).
    """

    # Kept for backward compat (used in demo loop below).
    _QUAD_SYMMETRIES = _QUAD_SYMMETRIES

    def __init__(self, n, symmetry_type=None, translation_type='none', join_earlier_prob=0.2,
                 stars_per_unit=1):
        super().__init__(n, stars_per_unit=stars_per_unit)
        # Reconnecting a new diagonal seed to an EARLIER (non-adjacent)
        # region instead of extending the current one (see 'diagonal' in
        # place_straddle_seeds) tends to produce small regions. That's fine
        # at 1 star, but a small region often can't fit stars_per_unit
        # non-touching stars while still leaving room for a second valid
        # placement, so it makes 2-star+ boards much harder to find --
        # always disable it above 1 star rather than let it fight the
        # search.
        self.join_earlier_prob = join_earlier_prob if stars_per_unit == 1 else 0.0

        # ── Resolve symmetry_type ─────────────────────────────────────────────
        # Python None means "pick randomly"; the string 'none' means "no symmetry".
        if symmetry_type is None:
            if translation_type == 'none':
                eligible = [s for s in _VALID_SYMMETRIES if s != 'none']
                # 'octo' requires N=8 and a non-empty allowlist.
                if n != 8 or not _ALLOWLISTS.get('octo'):
                    eligible = [s for s in eligible if s != 'octo']
                # 'rot_90' on N=8 uses an allowlist; exclude if allowlist is empty.
                if n == 8 and not _ALLOWLISTS.get('rot_90'):
                    eligible = [s for s in eligible if s != 'rot_90']
                self.sym_type = random.choice(eligible)
            else:
                # Exclude square-only symmetries for rectangular sub-board modes.
                # quadrants is fine (N/2 x N/2 is always square).
                sq_ok = (translation_type == 'quadrants')
                eligible = [s for s in _VALID_SYMMETRIES
                            if s != 'none'
                            and s != 'octo'  # octo never allows translation
                            and (sq_ok or s not in _SQUARE_ONLY_SYMMETRIES)]
                self.sym_type = random.choice(eligible)
        else:
            if symmetry_type not in _VALID_SYMMETRIES:
                raise ValueError(
                    f"symmetry_type {symmetry_type!r} is not valid. "
                    f"Choose from {_VALID_SYMMETRIES}, or pass None to pick randomly."
                )
            self.sym_type = symmetry_type

        # ── Resolve translation_type ──────────────────────────────────────────
        if translation_type not in _VALID_TRANSLATIONS:
            raise ValueError(
                f"translation_type {translation_type!r} is not valid. "
                f"Choose from {_VALID_TRANSLATIONS}."
            )
        self.trans_type = translation_type

        # ── Cross-validate ────────────────────────────────────────────────────
        self._validate(n, self.sym_type, self.trans_type)

    @staticmethod
    def _validate(n, sym_type, trans_type):
        """Raises ValueError for any incompatible (n, sym_type, trans_type) triple."""

        # Divisibility requirements by translation type.
        requires_even = {'vsplit', 'hsplit'}
        requires_div4 = {'quadrants', 'vfence', 'hfence'}
        requires_div3 = {'vsplit3', 'hsplit3'}

        if trans_type in requires_even and n % 2 != 0:
            raise ValueError(
                f"translation_type={trans_type!r} requires N to be even (got N={n})."
            )
        if trans_type in requires_div4 and n % 4 != 0:
            raise ValueError(
                f"translation_type={trans_type!r} requires N to be divisible by 4 "
                f"(got N={n})."
            )
        if trans_type in requires_div3 and n % 3 != 0:
            raise ValueError(
                f"translation_type={trans_type!r} requires N to be divisible by 3 "
                f"(got N={n})."
            )

        # Square-only symmetries are incompatible with translation types that produce
        # a rectangular sub-board.  quadrants is fine (sub-board is always square).
        if trans_type in _RECT_TRANSLATION_TYPES and sym_type in _SQUARE_ONLY_SYMMETRIES:
            raise ValueError(
                f"symmetry_type={sym_type!r} requires square geometry and is "
                f"incompatible with translation_type={trans_type!r} "
                f"(which produces a rectangular sub-board)."
            )

        # rot_180 with tiling: sub-board rows/cols must share parity so there's a
        # well-defined centre of rotation.  Both even (e.g. N div 4 for
        # vsplit/hsplit, or N div 4 for quadrants/vfence/hfence) gives a pure
        # pairing with no fixed cell.  Both odd (e.g. 3x9 sub-board from
        # vsplit3/hsplit3 on N=9) gives a single true fixed cell at the centre.
        # Mixed parity (one odd, one even) has no well-defined centre and is
        # rejected.
        if trans_type != 'none' and sym_type == 'rot_180':
            sub_rows, sub_cols, _ = _sub_board_shape(n, trans_type)
            if sub_rows % 2 != sub_cols % 2:
                raise ValueError(
                    f"symmetry_type='rot_180' with translation_type={trans_type!r} "
                    f"requires the sub-board's rows and cols to share parity "
                    f"(got {sub_rows}x{sub_cols} for N={n})."
                )

        # octo is only supported for N=8, translation='none'.
        if sym_type == 'octo':
            if n != 8:
                raise ValueError(
                    f"symmetry_type='octo' is only supported for N=8 (got N={n})."
                )
            if trans_type != 'none':
                raise ValueError(
                    f"symmetry_type='octo' does not support translation "
                    f"(got translation_type={trans_type!r})."
                )

    # ── Wrappers (delegate to _RectContext) ────────────────────────────────────
    # get_orbit() is used directly by test_generators.py.

    def _get_idx(self, r, c):
        return self._full_ctx().idx(r, c)

    def get_orbit(self, idx):
        return self._full_ctx().get_orbit(idx)

    def symmetric_flood_fill(self, grid):
        return self._full_ctx().flood_fill(grid)

    def _full_ctx(self) -> _RectContext:
        """A _RectContext covering the entire NxN board."""
        return _RectContext(self.n, self.n, self.n, self.sym_type,
                             join_earlier_prob=self.join_earlier_prob,
                             stars_per_unit=self.stars_per_unit)

    # ── Core generation ───────────────────────────────────────────────────────

    def _try_generate(self):
        """
        Attempts to generate a valid board with at least MIN_SOLUTIONS Star Battle
        solutions.  Returns (flat_board_string, solutions) on success, None on failure.

        For translation_type='none' this is a direct square generation.
        For any other translation_type, a rectangular sub-board is generated and
        then tiled; each tile copy gets a fresh label range so all N regions are
        distinct.
        """
        if self.trans_type == 'none':
            return self._try_generate_full()
        else:
            return self._try_generate_tiled()

    def _try_generate_full(self):
        """Direct generation of the full NxN board (no tiling)."""
        # Use allowlist for rot_90 on 8×8 boards and for all octo boards.
        use_allowlist = (
            (self.sym_type == 'rot_90' and self.n == 8) or
            self.sym_type == 'octo'
        )
        if use_allowlist:
            return self._try_generate_from_allowlist()

        ctx = self._full_ctx()
        sub_grid = ctx.try_fill(label_offset=0)
        if sub_grid is None:
            return None
        return self._make_result(sub_grid)

    def _try_generate_from_allowlist(self):
        """
        Pick a random entry from the allowlist for this symmetry type and decode it
        into a board result.  Returns None if the allowlist is empty.
        """
        entries = _ALLOWLISTS.get(self.sym_type, [])
        if not entries:
            return None
        entry = random.choice(entries)
        grid = _decode_allowlist_entry(entry, self.n)
        return self._make_result(grid)

    def _try_generate_tiled(self):
        """Generate a sub-board, tile it, and return the full board result."""
        sub_rows, sub_cols, n_regions = _sub_board_shape(self.n, self.trans_type)
        ctx = _RectContext(sub_rows, sub_cols, n_regions, self.sym_type,
                           join_earlier_prob=self.join_earlier_prob,
                           stars_per_unit=self.stars_per_unit)

        sub_grid = ctx.try_fill(label_offset=0)
        if sub_grid is None:
            return None

        full_grid = _tile_sub_board(sub_grid, sub_rows, sub_cols, self.n, self.trans_type)
        return self._make_result(full_grid)


if __name__ == "__main__":
    print("=== No translation (original behaviour) ===")
    for m in ['mirror', 'diagonal', 'double_mirror', 'double_diagonal', 'rot_90', 'rot_180']:
        print(f"\n--- sym={m}, trans=none (N=8) ---")
        SymmetricGenerator.demo(8, symmetry_type=m)

    print("\n\n=== vsplit: 4x8 sub-board tiled top-to-bottom ===")
    for sym in ['mirror', 'double_mirror', 'rot_180', 'none']:
        print(f"\n--- sym={sym}, trans=vsplit (N=8) ---")
        SymmetricGenerator.demo(8, symmetry_type=sym, translation_type='vsplit')

    print("\n\n=== hsplit: 8x4 sub-board tiled left-to-right ===")
    for sym in ['mirror', 'double_mirror', 'rot_180', 'none']:
        print(f"\n--- sym={sym}, trans=hsplit (N=8) ---")
        SymmetricGenerator.demo(8, symmetry_type=sym, translation_type='hsplit')

    print("\n\n=== quadrants: 4x4 sub-board tiled into all four quadrants ===")
    for sym in ['mirror', 'diagonal', 'rot_180', 'none']:
        print(f"\n--- sym={sym}, trans=quadrants (N=8) ---")
        SymmetricGenerator.demo(8, symmetry_type=sym, translation_type='quadrants')

    print("\n\n=== vfence: 2x8 sub-board tiled into 4 horizontal bands ===")
    for sym in ['mirror', 'rot_180', 'none']:
        print(f"\n--- sym={sym}, trans=vfence (N=8) ---")
        SymmetricGenerator.demo(8, symmetry_type=sym, translation_type='vfence')

    print("\n\n=== hfence: 8x2 sub-board tiled into 4 vertical bands ===")
    for sym in ['rot_180', 'none']:
        print(f"\n--- sym={sym}, trans=hfence (N=8) ---")
        SymmetricGenerator.demo(8, symmetry_type=sym, translation_type='hfence')

    print("\n\n=== vsplit3: 3x9 sub-board tiled top-to-bottom (3 copies) ===")
    for sym in ['mirror', 'rot_180', 'none']:
        print(f"\n--- sym={sym}, trans=vsplit3 (N=9) ---")
        SymmetricGenerator.demo(9, symmetry_type=sym, translation_type='vsplit3')

    print("\n\n=== hsplit3: 9x3 sub-board tiled left-to-right (3 copies) ===")
    for sym in ['mirror', 'rot_180', 'none']:
        print(f"\n--- sym={sym}, trans=hsplit3 (N=9) ---")
        SymmetricGenerator.demo(9, symmetry_type=sym, translation_type='hsplit3')
