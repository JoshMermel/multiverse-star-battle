Python code for generating and scoring puzzles.

 - gen_puzzle.py handles command line args and general orchestration 
 - generator.py and its subclasses handle generation of individual boards with
   multiple solutions.
   - test_generator.py contains tests for these
 - comparator.py and its subclasses use generators to find pairs of boards with
   exactly one shared solution.
   - test_comparator.py contains tests for these
 - board_solver.py uses OR-Tools to efficiently solve candidate boards.
 - scorer.py uses human-inspired heuristics to estimate difficulty of board
   pairs.
 - font_data.py is a pixel font used to generate boards with letters inside them
 - board_utils.py contains helpers that are useful across the project and which
   don't fit anywhere else.

Stuff I intend to do short/medium term:
 - Concurrency.
 - Allow more variety in how LetterGenerator places letters.
 - Integrate deduping into puzzle generation.
 - Make the SymmetricGenerator work on more board sizes.
 - Maybe handle Ctrl-C during long runs and output whatever puzzles have been
   generated so far.
 - Maybe integrate my janky swastika-filtering logic into SymmetricGenerator.
 - Write a doc to explain each heuristic in scorer.py and give examples.

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
