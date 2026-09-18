"""
rules_common.py

Rules referenced by both the 1-star and multi-star (2-star+) rule families:
the region-subset-sync family (these already reason in terms of each
region's remaining star *need* via get_regions_needing_stars, rather than
"has any star", so they work unmodified for any stars_per_unit) and the
row<->column line-sync family (originally 1-star-only, generalized here to
any stars_per_unit -- see _rule_axis_line_sync).
"""

from itertools import combinations


class CommonRules:
    def rule_2_row_col_line_sync_rows(self, p):
        return self._rule_axis_line_sync(p, n=2, axis="row")

    def rule_2_row_col_line_sync_cols(self, p):
        return self._rule_axis_line_sync(p, n=2, axis="col")

    def rule_3_row_col_line_sync_rows(self, p):
        return self._rule_axis_line_sync(p, n=3, axis="row")

    def rule_3_row_col_line_sync_cols(self, p):
        return self._rule_axis_line_sync(p, n=3, axis="col")

    def _rule_axis_line_sync(self, p, n, axis):
        """
        MATCH: N rows (or N columns) whose empty cells are confined to
        other-axis units whose combined remaining room exactly matches
        what's still needed — the pure row<->column analogue of
        _apply_pin_rule, with no region information involved at all. Works
        identically on regular and irregular (including regionless) boards,
        at any stars_per_unit. Python port of hintRowColLineSync /
        _hintAxisLineTrapped in solver.js, generalized the same way (see
        that function's comment for the full reasoning): moved here from
        rules_single_star.py, where it started out 1-star-only.

        For stars_per_unit == 1, every other-axis unit a window's empty
        cells touch always has exactly 1 cell of remaining room (a unit
        already at quota has no empty cell left to touch in the first
        place) -- so required_count ends up equal to the touched-unit
        COUNT, which is what this checked before generalizing. For
        stars_per_unit > 1 that's no longer guaranteed (a touched column
        might still have room for 2+ stars), so the real invariant is the
        touched units' TOTAL remaining room, not just how many there are.

        ACTION: Marks the remaining empty cells in those other-axis units
        as dots.
        """
        quota = p.stars_per_unit
        units = p.row_indices if axis == "row" else p.col_indices
        other_units = p.col_indices if axis == "row" else p.row_indices
        # Units still short of quota -- for stars_per_unit == 1 that's
        # exactly "no star yet" (the previous, 1-star-only condition this
        # generalizes).
        unsaturated_units = [
            u for u in range(p.n)
            if sum(1 for i in units[u] if p.grid[i] == "x") < quota
        ]

        for combo in combinations(unsaturated_units, n):
            unit_idxs = set().union(*(units[u] for u in combo))

            stars_in_window = sum(1 for i in unit_idxs if p.grid[i] == "x")
            required_count = n * quota - stars_in_window
            if required_count <= 0:
                continue

            avail_in_units = [i for i in unit_idxs if p.grid[i] is None]
            if not avail_in_units:
                continue

            # Which units of the OTHER axis do these empty cells touch?
            if axis == "row":
                touched_other = {i % p.n for i in avail_in_units}
            else:
                touched_other = {i // p.n for i in avail_in_units}

            other_remaining = sum(
                quota - sum(1 for i in other_units[u] if p.grid[i] == "x")
                for u in touched_other
            )
            if other_remaining != required_count:
                continue

            other_union = set().union(*(other_units[u] for u in touched_other))
            changes = sum(
                p.validate_and_set(
                    idx, ".",
                    f"AxisLineSync({n}-{axis} combo {combo})",
                    self.verbose)
                for idx in other_union
                if idx not in unit_idxs and p.grid[idx] is None
            )
            if changes > 0:
                return changes
        return 0

    def _build_region_need_combo_sets(self, p, k):
        """
        Build region combos (per board) whose TOTAL remaining star need sums
        to exactly k. Unlike a plain "N regions" combo (which implicitly
        assumed 1 star per region), this also picks up partially-solved
        regions (e.g. a region needing exactly 1 more star) and lets
        different-sized combos be compared against each other -- e.g. one
        region needing 2 stars vs two different regions each needing 1.
        Python port of _buildRegionNeedComboSets in solver.js.
        """
        combo_sets = []
        for b_idx in range(p.n_boards):
            needing = p.get_regions_needing_stars(b_idx)

            # A combo's size can never exceed k, since every member needs >= 1 star.
            for size in range(1, k + 1):
                for combo in combinations(needing, size):
                    total = sum(e["remaining"] for e in combo)
                    if total != k:
                        continue

                    regions = [e["unit"] for e in combo]
                    combo_sets.append({
                        "label": "B{} Combo({})".format(
                            b_idx + 1, ",".join(r["label"].split(" ")[-1] for r in regions)
                        ),
                        # Only still-open cells matter here -- an already-placed
                        # star elsewhere isn't part of the "where can the
                        # remaining stars go" reasoning for this combo.
                        "indices": {i for r in regions for i in r["indices"] if p.grid[i] is None},
                        "board_idx": b_idx,
                        "regions": regions,
                    })
        return combo_sets

    def rule_region_subset_sync_1(self, p):
        return self._rule_region_subset_sync(p, 1)

    def rule_region_subset_sync_2(self, p):
        return self._rule_region_subset_sync(p, 2)

    def rule_region_subset_sync_3(self, p):
        return self._rule_region_subset_sync(p, 3)

    def rule_region_subset_sync_4(self, p):
        return self._rule_region_subset_sync(p, 4)

    def _rule_region_subset_sync(self, p, k):
        """
        Compare region combos -- possibly spanning different boards, which
        matters for multiverse puzzles where the same physical cell can
        belong to a different region on each board -- whose total remaining
        star need sums to exactly k. If combo A's still-open cells are a
        full subset of combo B's, the extra open cells in B must be dots.
        Python port of hintRegionSubsetSync(K) in solver.js.
        """
        combo_sets = self._build_region_need_combo_sets(p, k)

        for set_a in combo_sets:
            for set_b in combo_sets:
                if set_a is set_b:
                    continue
                if not set_a["indices"].issubset(set_b["indices"]):
                    continue
                targets = [
                    idx for idx in set_b["indices"]
                    if idx not in set_a["indices"] and p.grid[idx] is None
                ]
                if not targets:
                    continue
                label = f"RegionSubsetSync({set_a['label']} ⊆ {set_b['label']})"
                changes = sum(
                    p.validate_and_set(idx, ".", label, self.verbose)
                    for idx in targets
                )
                if changes > 0:
                    return changes
        return 0

    def rule_fixed_tile_grid_parity(self, p):
        """
        EXPERIMENTAL -- prototype, not yet placed at a final tier (see
        tools/measure_fixed_tile_grid_parity.py, which tests this at both
        Hard and Expert against a real corpus before deciding).

        MATCH: n == 4 * stars_per_unit + 2 only (e.g. 6x6/1★, 10x10/2★,
        14x14/3★) -- see below for why only this exact board size works.
        Divide the board into a FIXED m x m grid of 2x2 tiles (m = n/2,
        independent of solving state -- tile (tr, tc) always covers rows
        {2*tr, 2*tr+1} and columns {2*tc, 2*tc+1}). Any 2x2 block can hold
        at most 1 star (all 4 cells mutually touch), so each tile-row/
        tile-column -- 2 real rows/columns, needing 2*stars_per_unit stars
        total -- gets that many stars from its m tiles, each contributing
        0 or 1. m = 2*stars_per_unit + 1 is exactly one MORE than needed,
        so at most one tile per tile-row/tile-column can have zero stars
        ("empty"); and since total stars == total non-empty tiles (a tile
        has either 0 or exactly 1, never 2+), total empty tiles across the
        whole grid is EXACTLY m too -- so the empty tiles form a genuine
        permutation: exactly one per tile-row, exactly one per tile-column.
        If m-1 of the m empty tiles are already independently confirmed
        (every one of that tile's 4 cells decided, none a star), the last
        tile's (row, col) is forced by elimination (the one row and one
        column not yet used) -- so ITS cells, wherever still undecided,
        must be dots too, even though neither its own tile-row nor its own
        tile-column individually shows a met quota yet on its own.
        ACTION: dots any undecided cell in that forced-empty tile.
        """
        n = p.n
        stars = p.stars_per_unit
        if n != 4 * stars + 2:
            return 0
        m = n // 2

        def tile_cells(tr, tc):
            return [(2 * tr + dr) * n + (2 * tc + dc) for dr in (0, 1) for dc in (0, 1)]

        def is_confirmed_empty(tr, tc):
            return all(p.grid[c] is not None and p.grid[c] != "x" for c in tile_cells(tr, tc))

        empties = [(tr, tc) for tr in range(m) for tc in range(m) if is_confirmed_empty(tr, tc)]
        if len(empties) != m - 1:
            return 0

        rows_used = {tr for tr, _tc in empties}
        cols_used = {tc for _tr, tc in empties}
        missing_rows = set(range(m)) - rows_used
        missing_cols = set(range(m)) - cols_used
        if len(missing_rows) != 1 or len(missing_cols) != 1:
            return 0  # Shouldn't happen on a consistent board -- defensive only.

        tr, tc = missing_rows.pop(), missing_cols.pop()
        targets = [c for c in tile_cells(tr, tc) if p.grid[c] is None]
        if not targets:
            return 0

        label = f"FixedTileGridParity(tile {tr},{tc})"
        return sum(p.validate_and_set(c, ".", label, self.verbose) for c in targets)
