# How to Solve, 2★+ Regionless

This is a companion to [how_to_solve2.md](how_to_solve2.md), for regionless boards
that need more than one star per row/column — see
[how_to_solve_regionless.md](how_to_solve_regionless.md) for the 1★ case first. I'm
not re-deriving each technique here, just showing which of part 2's ideas still work
once regions are gone, and what they look like without them.

All of the example puzzles below live in the `armory2_regionless` book, and (since
every regionless puzzle I publish is single-board) each one is a single board rather
than a pair. Click any image to load that exact puzzle.

## The rules of the puzzle, revisited

Neither half of this needed regions to begin with — "exactly enough empty cells
left" and "stars can't touch" both work identically on a row or column.

<a href="index.html?book=armory2_regionless&puzzle=1">
<img src="images/regionless/only_empty_multi.png" width="600"></img> </a>

Row 2 has exactly two non-void cells, A2 and H2, and this board needs 2 stars per
row — so both must be stars.

---

<a href="index.html?book=armory2_regionless&puzzle=2">
<img src="images/regionless/adjacency.png" width="600"></img> </a>

H2 is already a star, so G3 and H3 — both touching it — become dots.

## Unit Placement Forced

This one never mentioned regions in its own description — "take a row, column, or
region" — and it doesn't need one either: the combinatorial argument works the same
way over a row or column's own remaining empty cells.

<a href="index.html?book=armory2_regionless&puzzle=3">
<img src="images/regionless/unit_placement_forced.png" width="600"></img> </a>

This row's three remaining empty cells, C5/D5/E5, need 2 non-touching stars. Since
D5 touches both of its neighbors, the only way to fit 2 stars is to skip it — so C5
and E5 must both be stars.

## Tiles

Tiles apply just as fully at 2★+ as they did in the 1★ companion — every variant
I checked (domino-style, two-empty-dot, quota-fill, sees-too-much, pair-quota-fill,
disjoint-quota-fill, and bar-trapped) fired on regionless boards in testing. The only
absent one is, unsurprisingly, "tile falls inside a real drawn region."

<a href="index.html?book=armory2_regionless&puzzle=4">
<img src="images/regionless/tile_single_empty.png" width="600"></img> </a>

This column-pair still needs 4 stars, and splits cleanly into 4 confirmed tiles —
one of which has only a single empty cell left, G2. Since that tile is guaranteed
exactly one star, G2 must be it.

## Adjacent and disjoint rows/cols, revisited

Same as in part 1: both of these compare a *count of regions* to a *count of
rows/columns*, so neither has a regionless equivalent. Row/col line sync — covered
in the 1★ companion — is still the right regionless-native substitute in principle,
but I don't currently have a small, clean 2★+ example of it; it turned out to be
much rarer at 2★+ than I expected; I'll add one if I find a good candidate.

## Region/Line Quota Fill

This technique is defined entirely in terms of a region's contribution to a line —
there's no regionless equivalent.

## Symmetry, revisited

180-degree rotation carries over unchanged, checking the void mask's symmetry
instead of region-layout symmetry. Diagonal symmetry and diagonal parity, on the
other hand, didn't turn up at all in my regionless testing — not even in puzzle
pools specifically generated to be diagonally symmetric — so I'm not confident they
meaningfully apply at 2★+; I've left them out rather than force an example.

<a href="index.html?book=armory2_regionless&puzzle=5">
<img src="images/regionless/rotation_180_multi.png" width="600"></img> </a>

This board has 180-degree symmetry. E5 and F6 are each other's rotation and touch,
so neither can be a star — both must be dots.

## Unit completion satisfies other unit

I couldn't find this one firing on any regionless board I tested. It may still be
theoretically possible — its own description allows a row's completions to force a
column's quota, no region required — but it seems to be too rare to matter in
practice.

## Crossboard, revisited

Every crossboard technique compares regions across two different boards. None of
them have a regionless equivalent, and every regionless puzzle I publish is
single-board besides.

## Lookahead

Unlike the 1★ case (where multi-stage lookahead survives just fine), I didn't find
*any* lookahead rule firing on a 2★+ regionless board in testing, half-stage or
multi-stage. I suspect the extra room 2★+ regionless boards have — more stars means
more give in the "no empty cells left" bookkeeping lookahead depends on — makes
these contradictions harder to construct. No example here for that reason.

---

That covers every 2★+ technique from the original document, regionless or not.
