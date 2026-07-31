"""
scorer

Rule-based difficulty scorer for Multiverse Star Battle puzzles.

Simulates human solving by applying logic rules in order of difficulty,
tracking both the total score and the highest-tier rule needed.

Public API (unchanged from the former single-file tools/scorer.py):
StarBattlePuzzle, CompositeScorer, TIER_ORDER, _TIER_RANK.

Internally the implementation is split across:
  puzzle.py            -- StarBattlePuzzle (puzzle state + symmetry detection)
  engine.py             -- ScorerCore (solve loop + rule-count-agnostic helpers)
  rules_common.py       -- rules shared verbatim by every star count
  rules_single_star.py  -- rules that assume exactly 1 star per unit
  rules_multi_star.py   -- rules generalized to stars_per_group >= 2
  composite_scorer.py   -- CompositeScorer, assembled from the pieces above
"""

from .puzzle import StarBattlePuzzle
from .engine import TIER_ORDER, _TIER_RANK
from .composite_scorer import CompositeScorer

__all__ = ["StarBattlePuzzle", "CompositeScorer", "TIER_ORDER", "_TIER_RANK"]
