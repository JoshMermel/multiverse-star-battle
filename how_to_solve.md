# How to Solve

This file is documents all the techniques that I use to solve multiverse star
battles. This is intended as a guide for new players, documentation for my hint
system, and as a place for me to ramble about difficulty.

## Philosophy

All of the "books" of puzzles that I publish were created in the same way:

1. Generate many more puzzles than I need
2. Rank them by difficulty
3. Filter the big set down to a smaller set

The goal of my ranking system is to estimate how hard a human will find each
puzzle. It does this by solving like a human would. Humans look for patterns
that let them place dots/stars, and tend to notice simpler patterns before
complex ones. Similarly, my ranking system is built around a big list of
techniques, sorted by my opinion about thier complexity. The computer solver
iterates down the list and checks whether each technique can apply to the
current state of the puzzle. If so, it add some dots/stars, and jumps back to
the top of the list.

At the end, I have a trace of a possible path through the puzzle, and I can ask
questions like "what was the hardest technique that was required?" and "how many
total technqiques were applied?".

This is not an original idea. Before starting this project, I was vaguely aware
that this is how Sudoku is ranked. I was also directly inspired by KrazyDad's
video series, linked from the readme.

## The hint system is the ranking system

As I built my list of techniques, I needed to constantly ask myself - "is there a
simpler move that the one the computer chose here?". I sometimes found the text
descriptions difficult to visualize, so I used AI to re-implement the solver in
javascript, and integrated it into the gui. This turned into the "hint" feature.

## Techniques

### The rules of the puzzle

#### Only empty

If a region has only one empty square then that square must be a star.

<img src="images/only_empty.png" width="600"></img>

#### Sees star

If a cell is in the same row/col/region as a star, then that cell must hold a
dot.

<img src="images/sees_star.png" width="600"></img>

### Notable shapes

There are a number of shapes which let you place dots. I usually start each solve
by scanning for them.

<img src="images/domino.png" width="600"></img>

In this case, A6 and A7 form a domino, so there cannot be a star in the rest of
the A column, or in B6/B7.

<img src="images/triomino.png" width="600"></img>

There must be a star in {A3, B3, C3}, because the are the only empty cells in
board 1's top-left region. If we put a star at B4, then that region would not
have any stars.

<img src="images/triomino_middle_dot.png" width="600"></img>

There must be a star in {D6, D8}, since they are the only empty cells left in
column D. This lets us place dots at C7 and E7, since a star in either location
would make column D unsolvable.

<img src="images/sees_too_much.png" width="600"></img>

There must be a star in  {D2, F1, G1}, since they form a region on board 1. All
three of these "see" {C1, D1, F2, G2} by row, col, or adjacency. So a star in
any of these 4 cells would make that region of board 1 unsolvable, and we can
mark all 4 with dots.

More generally, if every empty cell of an unsolved row/col/region "sees" the
same set of cells outside of that row/col/region, then those cells cannot hold a
star. I call this category of inference "sees too much".

### Adjacent rows/cols

This technique comes in 2 flavors.

A. If a group of N regions covers all the empty cells in a group of N adjacent
rows/cols - the rest of those regions cannot possibly have a star. If it did,
there wouldn't be room to satisfy all the regions.

B. If the empty cells of a group of N regions are fully contained in N adjacent
rows/cols, then the remainder of those rows/cols cannot have a star. If it did,
those regions wouldn't all be solvable.

These descriptions are pretty abstract, so let's look at some concrete exapmles,
starting with N=1.

#### One row/col

<img src="images/1_col_A.png" width="600"></img>

In this case, the leftmost region on board1 is fully contained in column A.
Therefore, the rest of that region cannot hold a star, or column A would be
unsolvable.

<img src="images/1_row_B.png" width="600"></img>

On the same puzzle, we can also look at the top-left region on board 2. This
region is fully contained in row 1, so the rest of row 1 cannot hold a star. If
it did, the top-left region would be unsolvable.

<img src="images/1_col_B.png" width="600"></img>

Note that placing dots on the board can create opportunities to use these
techniques. In this case, look at column A on board 2. Because of dots we've
already placed, we can see that one region owns all empty cells in the column.
This lets us place dots in the remainder of that region.


<img src="images/2_rows_A.png" width="600"></img>

Now let's consider a case where N=2. In this case, the bottom-right and
bottom-left regions of board2 combine to fill rows 7 and 8. We know that these
two rows contain two stars, so there's no room for starts in the rest of those
regions.

<img src="images/2_cols_B.png" width="600"></img>

And here is case B for N=2. The two square regions on board 2 are both contained
in columns C and D. Each one must contain a star, so the rest of columns C and D
must contain dots.

<img src="images/3_cols_A.png" width="600"></img>

Moving on to N=3, the story is the same. Columns {F,G,H} on board 2 are filled
by 3 regions, so the remainder of those regions cannot have stars.

<img src="images/3_cols_B.png" width="600"></img>

The same board contains an example of case B for N=3. The leftmost 3 regions on
board 2 are fully contained in columns {A,B,C}. Each region must contain a star,
so they must collectively put three stars in those three columns. Therefore the
rest of those columns must have dots.

<img src="images/many_adjacent_A.png" width="600"></img>

<img src="images/many_adjacent_B.png" width="600"></img>

One last example for N=4. In this case, we can make the same observation using a
type-A inference, or a type-B inference.

### Disjoint rows/cols

I find it easier to spot row/col based inferences when the rows/cols are
contiguous, but the logic works exactly the same even if they are not.

<img src="images/2_disjoint_A.png" width="600"></img>

Look at rows 1 and 3. Together, they must contain two stars. No matter how we
place them, we'll satisfy the top two regions of board 2, so the remainder of
those regions must be dots.

<img src="images/2_disjoint_B.png" width="600"></img>

Look at the regions containing blue squares. Together, they must place stars in
rows 2 and 4. Therefore the rest of those rows must contain dots.

<img src="images/3_disjoint_rows_A.png" width="600"></img>

Here is a disjoint example with N=3. Three regions are fully contained in
columns {C, E, H}, so the rest of those columns must contain dots.

<img src="images/3_disjoint_cols_B.png" width="600"></img>

And here is an example of case B for N=3. Rows {1,2,4} only see three regions,
so the rest of those regions must contain dots.

### Symmetry

Sometimes we can tell, just from the structure of the boards, that the solution
has some symmetry. We can use this to to our advantage.

#### Diagonal

<img src="images/self_diag_2.png" width="600"></img>

In this case, the two boards are diagonal reflections of one another. If the
solution wasn't symmetric along that reflection, then we could reflect it, and
have a second valid solution. But since we know the solution is unique, we can
reflect all dots/stars along that reflection. In this case, we've placed a dot
at A2, and that tells us that there must also be a dot at B1.

<img src="images/self_diag_1.png" width="600"></img>

Let's take this logic one step further. Here is another puzzle where the boards
are diagonal refelctions of one another. Since the solution is symmetric, any
cell which "sees" its own reflection (by row/col/adjacency/region) cannot have a
star.

<img src="images/both_diag.png" width="600"></img>

Here, both boards have diagonal self-symmetry. By the same logic above, this
means the solution must also have diagonal self-symmetry. So any cell which "sees"
itself under diagonal reflection cannot have a star.

I find this technique frustratingly powerful. It's easy to spot, and trivializes
many puzzles that would otherwise be very difficult.

#### Rot180

<img src="images/self_rot180_1.png" width="600"></img>

This puzzle has two boards that are 180 degree rotations of one another. If the
unique solution wasn't symmetric along that reflection, then we could rotate it
180 degrees, and we'd have a second valid solution to the puzzle. So any time
we place a dot or star, we can also rotate that mark 180 degrees.

<img src="images/self_rot180_2.png" width="600"></img>

Again, we can take this further and consider every cell alongside image under
180 degree rotation. If the two "see" each other, including by being in the same
region, then they cannot be a star.

<img src="images/both_rot180.png" width="600"></img>

Here, both boards have 180 degree self-symmetry. By the same logic above, this
means the solution must also have 180 degree symmetry. So any cell which "sees"
itself under 180 degree rotation cannot have a star.


### Crossboard

<img src="images/region_contains_region.png" width="600"></img>

In this case, the top-right region of board 1 is a subset of the top-right
region of board 2. If we put a non-shared cell of board 2, it would make that
region unsolvable on board 1. More generally, if any region is a subset of
another region, we can place dots in all cells of the larger region which are
not in the smaller region. This is my favorite technique.


<img src="images/double_subset.png" width="600"></img>

We can apply the same logic when one pair of regions is a subset of another
pair. This technique is quite rare, but I think it's really cool.  Fun fact,
there's a second place you can apply double-subset in this image.

<img src="images/2_regions_crossboard.png" width="600"></img>

In this case, the bottom-left region of board1 and the bottom-right region of
board2 are disjoint, and are both contained in rows 7 and 8. No matter how we
place stars in those regions, we'll satisfy those rows, so we can mark the rest
of those rows with dots.

<img src="images/3_regions_crossboard.png" width="600"></img>

The same reasoning applies with >2 rows/cols. In this case, the empty cells of 3
regions (two from board 1, one from board 2) are all contained in columns {D, E,
F}.  So th rest of those columns must contain only dots.

<img src="images/partial_overlap.png" width="600"></img>

Focus on the regions containing blue cells on each board. They share 3 cells
{B5, C5, D5}, and each have on cell which is not shared (D3 and D7). If we put
the star in the non-shared region of one, then we'd put dots in all shared
cells, and be forced to put a dot in the non-shared cell of the other. But in
this case, D3 and D7 see each other, so we aren't allowed to put stars in both.

More generally, if the non-shared cells of two regions all mutually see each
other, then we can put dots in all of them.

### Lookahead

<img src="images/half_lookahead.png" width="600"></img>

In this case, a star at B1 would see B4 (by column), and A3 (by region on board
2). This would make the middle-left region of board 1 unsolvable, so B1 cannot
contain a star. This is sorta like a generalized version of "sees too much", but
taking into account the region on the other board.

I call this "half-stage lookahead", because it's implemented in terms of the
multi-stage lookahead technique below.  This is the hardest kind of inference
that I still think of as "human viable" in the general case. And even then, I
only allow it in "expert" tier puzzles.

#### Multi-stage lookahead

This is the technique of last resort, sort like a guess-and-test.


<img src="images/1_lookahead_1.png" width="600"></img>

Consider a star at C3:

<img src="images/1_lookahead_2.png" width="600"></img>

This forces the following dots, which forces a star at A4.

<img src="images/1_lookahead_3.png" width="600"></img>

But placing the A4 star makes one region on board 1 unsolvable.

I think this technique is not viable for humans in the typical case, but can be
used in specialized cases. I also think it's fun to see how many repititons of
the "place all implied dots, now place all implied stars" process is needed to
find a contradiction on especially hard puzzles.

## Unimplemented Techniques

### Implied region

There are lots of ways to notice an implied region, here's one. Maybe I'll add
more later

<img src="images/implied_region.png" width="600"></img>

Check out columns E+F of board 1. There is trio of empty cells (F4, E5, F5), and
a pair of empty cells on (E7, F7). Each cluster must contain one star. So we can
treat the E7+F7 pair like a region, and eliminate H7.

I haven't figured out how to write this technique for the solver yet. All my
techniques for pointing out implied regions are too vauge.

### Both-or-Neither

This is a technique I see a teammate use sometimes. He'll point out two cells
that must be equal, then say ~"oh, but if both are stars, then there's a
contradiction", and mark dots in both.

I think it's probably a special case of lookahead, but more human-viable.

## More philosophy

- symmetry
- how many applications of a hard technique are required?
- which levels are worth publishing
- ideas for future improvement to the scoring system


TODO(jmerm): link to levels in armory.md
