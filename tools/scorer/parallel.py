"""
parallel.py

Process-pool parallel scoring. Scoring is embarrassingly parallel -- each
puzzle solves independently, with no shared mutable state between puzzles
-- but the rule engine is pure-Python CPU-bound work, so threads don't
help here (the GIL serializes them right back down to one core); this uses
separate processes instead via concurrent.futures.ProcessPoolExecutor.

Workers build their own StarBattlePuzzle/CompositeScorer from plain,
picklable inputs (name/n/boards/solution/stars_per_unit) rather than
having those (larger, closure-bearing) objects passed across the process
boundary.
"""

import os
from concurrent.futures import ProcessPoolExecutor

from .puzzle import StarBattlePuzzle
from .composite_scorer import CompositeScorer


def _build_scorer(exclude_rule_names, verbose):
    scorer = CompositeScorer(verbose=verbose)
    if exclude_rule_names:
        exclude = set(exclude_rule_names)
        for attr in ("rules_1star", "rules_2_star", "rules_multi_capped"):
            setattr(scorer, attr, [
                r for r in getattr(scorer, attr) if r[0].__name__ not in exclude
            ])
    return scorer


def _score_one(task):
    name, n, boards, solution, stars_per_unit, exclude_rule_names, verbose = task
    puzzle = StarBattlePuzzle(n, boards, solution, name, stars_per_unit=stars_per_unit)
    scorer = _build_scorer(exclude_rule_names, verbose)
    try:
        solved, score, tier = scorer.solve(puzzle)
        return name, solved, score, tier, None
    except Exception as e:  # noqa: BLE001
        return name, False, -999, "UNSOLVED", str(e)


def score_puzzles_parallel(puzzle_specs, exclude_rule_names=None, max_workers=None, verbose=False):
    """
    puzzle_specs: iterable of (name, n, boards, solution, stars_per_unit).
    `name` must be unique across the batch -- it's the key results are
    returned under, since ProcessPoolExecutor.map does not guarantee
    input-order completion under the hood the way this function surfaces
    it (results are collected into a dict, so completion order doesn't
    matter to the caller).

    exclude_rule_names: optional iterable of rule method names (e.g.
    "rule_at_least_one_forcing") to drop from every star-count's rule
    table before scoring -- useful for A/B comparisons without needing two
    separate CompositeScorer subclasses.

    max_workers defaults to os.cpu_count().

    Returns {name: (solved, score, tier, error_or_None)}. `error` is the
    exception message if solve() raised (a logic bug -- a rule inferred a
    value that didn't match the canonical solution), else None.
    """
    tasks = [
        (name, n, boards, solution, stars_per_unit, exclude_rule_names, verbose)
        for name, n, boards, solution, stars_per_unit in puzzle_specs
    ]
    if not tasks:
        return {}

    results = {}
    with ProcessPoolExecutor(max_workers=max_workers or os.cpu_count()) as pool:
        for name, solved, score, tier, error in pool.map(_score_one, tasks, chunksize=8):
            results[name] = (solved, score, tier, error)
    return results
