Python code for generating and scoring puzzles.

 - gen_puzzles.py handles command line args and general orchestration
 - generator.py and its subclasses (random_generator.py, symmetric_generator.py,
   letter_generator.py, voronoi_generator.py, subdivision_generator.py,
   square_free_generator.py, quad_aligned_generator.py, venn_generator.py,
   voting_district_generator.py, void_generator.py, solution_first_generator.py,
   ...) handle generation of individual boards with multiple solutions.
   - test_generators.py contains tests for these
 - comparator.py and its subclasses (symmetric_pool_comparator.py,
   asymmetric_pool_comparator.py, self_comparator.py, mono_comparator.py,
   sudoku_comparator.py, triple_comparator.py,
   solution_first_pair_comparator.py, ...) use generators to find pairs (or
   larger groups) of boards with exactly one shared solution.
   - test_comparators.py contains tests for these
 - board_solver.py uses OR-Tools to efficiently solve candidate boards.
 - scorer/ is a package that uses human-inspired heuristics to estimate
   difficulty of board pairs. It's split into a core solve loop (engine.py,
   puzzle.py) plus rule-family mixins (rules_common.py, rules_single_star.py,
   rules_multi_star.py) assembled into CompositeScorer (composite_scorer.py);
   parallel.py adds score_puzzles_parallel for scoring many puzzles across a
   process pool. See scorer/__init__.py for the full breakdown.
 - puzzle_deduper.py is used to dedupe puzzles, including orientation and
   swapping
 - font_data.py is a pixel font used to generate boards with letters inside them
 - board_utils.py contains helpers that are useful across the project and which
   don't fit anywhere else.
 - build_books.py builds the finished books in data/ from the big pools of scored
   puzzles in library/ (gitignored), following the recipes in books/*.toml. See
   books/README.md for the full guide. Supporting scripts: rescore_pools.py (refresh
   pools after a scoring change), trim_pool.py (shrink oversized pools
   while keeping every score tail), topup_pool.py / probe_gen.py / gen_twin_extra.py /
   gen_mono_extra.py / append_to_pool.py (grow a pool with newly generated puzzles),
   unsolved_sync.py (keep data/ UNSOLVED rows present in their pools), and book_gen.py
   (the original one-book selector).

Stuff I might or might not do longer term:
 - Maybe account for the following during scoring:
   - how early does the first hard rule appear?
   - how early is the first star placed?
   - N row/cols along an edge is easier to spot than mid-board?
   - how often a solver of beginner/medium/... strength would need to switch
     boards
   - lookahead is expensive and not targeted. A good choice of lookahead might
     prevent the need for others. The same is true more generally if you think
     about it; maybe rules need to return a list of possible "Inference" objects
     and then the solver randomly selects amongst them?
