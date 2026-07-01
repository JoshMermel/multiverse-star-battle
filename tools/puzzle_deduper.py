"""
puzzle_deduper.py

Canonical deduplication for Multiverse Star Battle puzzle groups (any
number of boards >= 1).

Used by comparator.py during generation and by gen_puzzles.py during
standalone scoring. Import PuzzleDeduper from here rather than from
comparator.py so both paths share the same logic.
"""

from board_utils import get_transformation_maps, canonical_relabel


class PuzzleDeduper:
    """
    Tracks seen puzzle groups across all 8 dihedral orientations.
    Board order is ignored — (A, B, C) and (C, A, B) are the same puzzle.

    A stable canonical fingerprint is computed by applying all 8 transforms
    to the group, relabeling each result, sorting the boards within each
    transform (to ignore board order), then taking the lexicographic minimum
    across all 8 — so every orientation of the same puzzle maps to the same
    single string, and both register() and is_duplicate() use it.
    """

    def __init__(self):
        self._seen = set()

    @staticmethod
    def _apply(board_str, forward_map, n):
        result = [""] * (n * n)
        for i, ch in enumerate(board_str):
            result[forward_map[i]] = ch
        return "".join(result)

    @staticmethod
    def _canonical_fingerprint(boards, n):
        candidates = []
        for forward_map, _ in get_transformation_maps(n):
            transformed = sorted(
                canonical_relabel(PuzzleDeduper._apply(b, forward_map, n))
                for b in boards
            )
            candidates.append("|".join(transformed))
        return min(candidates)  # stable across all orientations

    def is_duplicate(self, boards, n):
        return self._canonical_fingerprint(boards, n) in self._seen

    def register(self, boards, n):
        self._seen.add(self._canonical_fingerprint(boards, n))
