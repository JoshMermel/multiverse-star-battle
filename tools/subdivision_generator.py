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

    @staticmethod
    def _can_split(rect):
        _, _, h, w = rect
        # Leaves: 1×K (h==1), K×1 (w==1), or 2×2 exactly.
        if h == 1 or w == 1:
            return False
        if h == 2 and w == 2:
            return False
        return True

    @classmethod
    def _split_options(cls, rect):
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
            weight = cls.BALANCED_WEIGHT if both_thick else cls.DEGENERATE_WEIGHT
            options.append((('H', cut), weight))
        for cut in range(1, w):
            both_thick = (cut >= 2) and (w - cut >= 2)
            weight = cls.BALANCED_WEIGHT if both_thick else cls.DEGENERATE_WEIGHT
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
            splittable = [rect for rect in rects if self._can_split(rect)]
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
