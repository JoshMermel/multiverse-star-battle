"""
regionless_ladder_comparator.py

Comparator wrapper for RegionlessGenerator.generate_tier_ladder(): a
single-board (board_count=1) comparator that, per attempt, harvests EVERY
difficulty tier reached by one maximal-void carve and emits each as its
own puzzle row -- far more sample-efficient than the usual "one attempt,
one puzzle" comparator contract most other modes use, since a carve that
happens to reach Expert tier necessarily passed through Beginner/Medium/
Hard on the way there too (see regionless_generator.py's module docstring
for the carve itself).

Iterates ladder.items() in plain dict-insertion order rather than sorting
by tier rank -- generate_tier_ladder()'s snapshots dict only ever gains a
NEW key the first time a tier is reached (later visits to that same tier
just overwrite its value), so insertion order already IS ascending
difficulty order for free.
"""

from comparator import Comparator


class RegionlessLadderComparator(Comparator):
    """Single-board comparator: emits every tier RegionlessGenerator reaches per carve."""

    board_count = 1

    def __init__(self, generator, n, output_rows):
        super().__init__(n, output_rows)
        self.generator = generator

    def _next_pair(self):
        ladder = self.generator.generate_tier_ladder()
        if not ladder:
            return
        for _tier, (board_str, solution, _score) in ladder.items():
            self._emit(self._next_puzzle_name(), [board_str], solution)
