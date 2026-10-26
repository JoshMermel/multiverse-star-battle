import random
from generator import Generator


class SubdivisionGenerator(Generator):
    """
    Generates an NxN board by recursively splitting rectangles.

    Algorithm
    ---------
    1. Start with a single rectangle covering the full NxN board.
    2. Repeat until there are exactly N regions:
       a. Collect every rectangle that is currently splittable.
       b. Pick one at random and split it along a random valid cut line,
          producing two new rectangles.
    3. Assign each final rectangle a distinct region label and write it
       into the flat grid.

    Splittability rules
    -------------------
    A rectangle may NOT be split if it is already 2×2 or 1×K (for any K);
    those are valid final regions but cannot be subdivided further.
    Any other rectangle can be cut freely:
      - horizontally at any row offset 1 … H-1
      - vertically   at any col offset 1 … W-1
    There is no minimum-child-size constraint; children may themselves be
    2×2 or 1×K, in which case they simply become unsplittable leaves.
    """

    # ------------------------------------------------------------------
    # Internal rectangle representation: (row, col, height, width)
    # ------------------------------------------------------------------

    # Relative likelihood of cuts that keep both children "thick" (both
    # dimensions ≥ 2) versus cuts that produce a 1×K or K×1 child.
    # Raise BALANCED_WEIGHT or lower DEGENERATE_WEIGHT to suppress thin strips.
    BALANCED_WEIGHT   = 1
    DEGENERATE_WEIGHT = 0.2

    def __init__(self, n, stars_per_unit=1, min_region_size=1):
        """
        min_region_size: never produce a rectangle with fewer cells than this.
        For multi-star boards every rectangle must also be able to hold
        stars_per_unit non-touching stars (checked automatically, see
        _rect_ok); min_region_size=3 or more is then just an extra floor.
        Region sizes only shrink as splitting continues, so excluding bad
        cuts at split time is exact.  Defaults leave the 1-star output unchanged.
        """
        super().__init__(n, stars_per_unit)
        self.min_region_size = min_region_size

    def _rect_ok(self, rect):
        _, _, h, w = rect
        if h * w < self.min_region_size:
            return False
        # a rectangle holds at most ceil(h/2) * ceil(w/2) mutually non-touching cells; a k-star region needs k of them (so 2 stars rules out
        # 2x2 and smaller, 3 stars also rules out 1x4, 2x4, 2x2, 3x2 ...).  Without this a board is simply unsolvable.
        return (h + 1) // 2 * ((w + 1) // 2) >= self.stars_per_unit

    @staticmethod
    def _can_split(rect):
        _, _, h, w = rect
        # Leaves: 1×K (h==1), K×1 (w==1), or 2×2 exactly.
        if h == 1 or w == 1:
            return False
        if h == 2 and w == 2:
            return False
        return True

    def _split_options(self, rect):
        """
        Returns a list of ((axis, cut), weight) pairs for every valid cut.
        axis='H' cuts horizontally; axis='V' cuts vertically.
        cut is the number of rows/cols in the first sub-rectangle.

        Cuts where both children have both dimensions ≥ 2 receive
        BALANCED_WEIGHT; cuts that produce a 1×K or K×1 child receive
        DEGENERATE_WEIGHT.
        """
        r, c, h, w = rect
        options = []
        for cut in range(1, h):
            both_thick = (cut >= 2) and (h - cut >= 2)
            weight = self.BALANCED_WEIGHT if both_thick else self.DEGENERATE_WEIGHT
            if self._rect_ok((0, 0, cut, w)) and self._rect_ok((0, 0, h - cut, w)):
                options.append((('H', cut), weight))
        for cut in range(1, w):
            both_thick = (cut >= 2) and (w - cut >= 2)
            weight = self.BALANCED_WEIGHT if both_thick else self.DEGENERATE_WEIGHT
            if self._rect_ok((0, 0, h, cut)) and self._rect_ok((0, 0, h, w - cut)):
                options.append((('V', cut), weight))
        return options

    @staticmethod
    def _apply_split(rect, axis, cut):
        r, c, h, w = rect
        if axis == 'H':
            return (r, c, cut, w), (r + cut, c, h - cut, w)
        else:
            return (r, c, h, cut), (r, c + cut, h, w - cut)

    # ------------------------------------------------------------------

    def _try_generate(self):
        n = self.n
        rects = [(0, 0, n, n)]   # single rectangle covering the board

        # We need exactly n regions, so we need n-1 splits.
        for _ in range(n - 1):
            splittable = [rect for rect in rects
                          if self._can_split(rect) and self._split_options(rect)]
            if not splittable:
                # Dead end: not enough splittable rectangles remain.
                return None

            largest_area = max(h * w for _, _, h, w in splittable)
            largest = [r for r in splittable if r[2] * r[3] == largest_area]
            target = random.choice(largest)
            options = self._split_options(target)
            (axis, cut), = random.choices(
                [opt for opt, _ in options],
                weights=[w for _, w in options],
                k=1,
            )
            child_a, child_b = self._apply_split(target, axis, cut)

            rects.remove(target)
            rects.append(child_a)
            rects.append(child_b)

        if len(rects) != n:
            return None

        # Assign region labels and fill the flat grid.
        grid = [None] * (n * n)
        random.shuffle(rects)          # randomise label assignment
        for label, (r, c, h, w) in enumerate(rects):
            for dr in range(h):
                for dc in range(w):
                    grid[(r + dr) * n + (c + dc)] = label

        return self._make_result(grid)


if __name__ == "__main__":
    print("\n--- SubdivisionGenerator (N=8) ---")
    SubdivisionGenerator.demo(8)
