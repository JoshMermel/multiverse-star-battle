# How to Solve

This file is documents all the techniques that I use to solve multiverse star
battles. This is intended as a guide for new players, documentation for my hint
system, and as a place for me to ramble about difficulty.

## Philosophy

All of the "books" of puzzles that I publish were created in the same way:

1. Generate many more puzzles than I need
2. Rank them by difficulty
3. Filter the big set down to a smaller set

My ranking system is built around a big list of techniques, sorted by my opinion
about thier complexity. The computer solver iterates down the list and checks
whether each technique can apply to the current state of the puzzle. If so, it
add some dots/stars, and jumps back to the top of the list. This is intended to
mimic how a human solves these puzzles.

At the end, I have a trace of a possible path through the puzzle, and I can ask
questions like "what was the hardest technique that was required?" and "how many
total technqiques were applied?".

This is not an original idea. Before starting this project, I was vaguely aware
that this is how Sudoku is ranked. I was also directly inspired by KrazyDad's
video series, linked from the readme.

## The hint system is the ranking system

As I built my list of rules, I needed to constantly ask myself - "is there a
simpler move that the one the computer chose here?". I sometimes found the text
descriptions difficult to visualize, so I used AI to re-implement the solver in
javascript, and integrated it into the gui. This turned into the "hint" feature.

## Techniques

### Only empty

If a region has only one empty square then that square must be a star.

<a><img src="images/only_empty.png"></img></a>

### Sees star

If a cell is in the same row/col/region as a star, then that cell must hold a
dot.

<a><img src="images/sees_star.png"></img></a>

### Domino

If a pair of adjacent cells must hold a star, that lets us place many dots. This
can apply because these are the only two empty cells left in a region, or
because these are the only two empty cells left in a row/col.

<a><img src="images/domino.png"></img></a>

Fun fact - this puzzle can be solved using just "Only empty", "Sees Star", and
"Domino".

### Triomino

A similar rule applies when there are three empty cells in a row/col, and one of
the three must contain a star. This rule also applies if the middle of the three
contains a dot.

<a><img src="images/triomino.png"></img></a>
<a><img src="images/triomino_middle_dot.png"></img></a>

### One row/col

This technique applies to two similar cases.

A. If a region covers all empty cells in a row/col - the rest of that region
cannot possibly have a star. If it did, then the row/col would be unsolvabled.

<a><img src="images/1_col_A.png"></img></a>

B. If a region's empty cells are fully contained in a row/col, then the
remainder of that row/col cannot have a star. If it did, the region would be
unsolvable.

<a><img src="images/1_col_B.png"></img></a>

<a><img src="images/1_row_B.png"></img></a>

### Sees too much

If any cell "sees" (by row/col/adjacency) all empty cells of a region/row/col,
then that cell must hold a dot. Otherwise the region/row/col would be
unsolvable.

For scoring, I break this rule into 3 cases.

1. The region has 2 empty cells.
2. The region has 3 empty cells.
3. The region has 4 or more empty cells.

<a><img src="images/sees_too_much.png"></img></a>

This is intended to reflect the way I solve. I usually look at regions with very
few empty cells first.

Also note that Domino is a special case of this rule. Many of my rules are
special cases of each other :)

### 2 adjacent rows/cols

This is similar to "One row/col", but look at a pair of adjacent rows. It also
comes in two flavors.

A. If a pair of regions covers all empty cells in a pair of adjacent rows/cols -
the rest of those regions cannot possibly have a star. If it did, there wouldn't
be room to satisfy both regions.

<a><img src="images/two_rows_A.png"></img></a>

B. If a pair of region's empty cells are fully contained in 2 adjacent
rows/cols, then the remainder of those rows/cols cannot have a star. If it did,
those regions wouldn't both be solvable.

<a><img src="images/two_cols_B.png"></img></a>

### Diagonal fill

Sometimes we can tell, just from the structure of the boards, that the solution
will have symmetry across one of the diagonals. There are two cases that I know
of:

1. Both boards have symmetry along one of the diagonals
2. One board is the transpose of the other

In both cases, we take advantage of the fact that the solution is unique. If
the unique solution didn't have diagonal-reflection symmetry, we could reflect
it across the diagonal, and we'd have a different valid solution to the puzzle.

So, any time we place a dot or star, we can also reflect that mark
across the diagonal.

<a><img src="images/diag_fill_1.png"></img></a>
<a><img src="images/diag_fill_2.png"></img></a>

### Rot180 fill

Similar to the above, sometimes we can tell that the solution must have
180-degree diagonal symmetry. There are two cases that I know of:

1. Both boards have 180 degree rotaitonal symmetry
2. The two boards are 180 degree rotations of one another

In both cases, we take advantage of the fact that the solution is unique. If the
unique solution didn't have 180 degree rotation symmetry, we could rotate it 180
degrees, and we'd have a different valid solution to the puzzle.

So any time we place a dot or star, we can also rotate that mark 180 degrees.

<a><img src="images/180_fill_1.png"></img></a>
<a><img src="images/180_fill_2.png"></img></a>

### 3 Adjacent rows/cols

This is just like "1 row/col" and "2 Adjacent rows/cols", but applied to groups
of 3 adjacent rows/cols. Like those, it comes in two flavors.

A. If a group of 3 regions covers all empty cells in a trio of adjacent rows/cols -
the rest of those regions cannot possibly have a star. If it did, there wouldn't
be room to satisfy both regions.

<a><img src="images/three_cols_A.png"></img></a>

B. If a group of 3 region's empty cells are fully contained in 3 adjacent rows/cols,
then the remainder of those rows/cols cannot have a star. If it did, those
regions wouldn't both be solvable.

<a><img src="images/3_cols_B.png"></img></a>

### 2 Disjoint rows/cols

This is the same as "2 Adjacent rows/cols", but we drop the requirement that the
rows be adjacent. This makes these cases harder to spot (and more rare). Like
those, it comes in two flavors.

<a><img src="images/2_disjoint_A.png"></img></a>
<a><img src="images/2_disjoint_B.png"></img></a>

### Many adjacent rows/cols

Generalizing "3 Adjacent rows/cols", looks at any number of adjacent rows and
cols. On this board, the A and B flavors make the same observation.

<a><img src="images/many_adjacent_A.png"></img></a>
<a><img src="images/many_adjacent_B.png"></img></a>

### Regions contins regions

This is my favorite rule. If one region is a subset of another, then the star
must be in the smaller one. Otherwise the smaller one would be unsolvable.

<a><img src="images/region_contains_region.png"></img></a>

### Rot180 symmetry

As mentioned above, there are times when we know that the solution will have 180
degree rotation symmetry. If so, we can place dots in any cell that "sees"
iteslf under 180 degree rotation.

<a><img src="images/180_1.png"></img></a>
<a><img src="images/180_2.png"></img></a>

### Diagonal symmetry

As mentioned above, there are times when we know that the solution will have
reflection symmetry across a diagonal. If so, we can place dots in any cell that
"sees" iteslf under diagonal reflection

<a><img src="images/diag_1.png"></img></a>
<a><img src="images/diag_2.png"></img></a>

### 3 disjoint rows

Like "2 disjoint rows" but we look at groups of 3 rows at once.

<a><img src="images/3_disjoint_rows_A.png"></img></a>
<a><img src="images/3_disjoint_cols_B.png"></img></a>

### 2 regions crossboard

<a><img src="images/2_regions_crossboard.png"></img></a>

### 3 regions crossboard

<a><img src="images/3_regions_crossboard.png"></img></a>

### Crossboard partial overlap

<a><img src="images/partial_overlap.png"></img></a>

### half-stage lookahead

<a><img src="images/half_lookahead.png"></img></a>

### region pair contains pair

<a><img src="images/double_subset.png"></img></a>

### Lookahead

<a><img src="images/1_lookahead_1.png"></img></a>
<a><img src="images/1_lookahead_2.png"></img></a>
<a><img src="images/1_lookahead_3.png"></img></a>

## Unimplemented Rules

### Implied region


### Both-or-Neither



## More philosophy

- symmetry
- how many applications of a hard rule are required?
- which levels are worth publishing
- ideas for future improvement to the scoring system


TODO(jmerm): link to levels in bestiary.md
