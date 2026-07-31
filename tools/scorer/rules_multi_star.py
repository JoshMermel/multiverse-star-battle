"""
rules_multi_star.py

2-star+ rule_* implementations: everything written against an arbitrary
p.stars_per_group rather than assuming exactly 1 star per row/col/region.
Python port of the "multi-star validated/compatible rules" section of
solver.js. See rules_single_star.py for the 1★-only rules they generalize,
and rules_common.py for the handful of rules shared verbatim by both
families.
"""

from itertools import combinations


class MultiStarRules:
    def rule_only_empty_multi(self, p, silent=False):
        """
        Generalized rule_only_empty: for any unit still needing N more stars,
        if exactly N empty cells remain, all of them must be stars (there's
        no other way to fit N stars into N cells). Python port of
        hintOnlyEmpty in solver.js.
        """
        for unit in p.units:
            indices = unit["indices"]
            stars = sum(1 for i in indices if p.grid[i] == "x")
            needed = p.stars_per_group - stars
            if needed <= 0:
                continue
            empty = [i for i in indices if p.grid[i] is None]
            if len(empty) != needed:
                continue
            changes = sum(
                self._internal_set(p, i, "x", f"OnlyEmpty({unit['label']})", silent)
                for i in empty
            )
            if not silent and changes > 0:
                return changes
        return 0

    def rule_exclude_adjacency(self, p, silent=False):
        """
        Stars can never touch, regardless of stars_per_group. Python port of
        hintExcludeAdjacency in solver.js (the adjacency-only portion of the
        1★ rule_sees_star).
        """
        changes = 0
        for i, val in enumerate(p.grid):
            if val != "x":
                continue
            star_changes = 0
            for nb in p._neighbor_map[i]:
                star_changes += self._internal_set(p, nb, ".", "Adjacency", silent)
            changes += star_changes
            if not silent and star_changes > 0:
                return star_changes
        return changes

    def rule_exclude_solved_unit(self, p, silent=False):
        """
        Once a unit has ALL of its stars_per_group stars placed, every other
        empty cell in it must be a dot. Python port of hintExcludeSolvedUnit
        in solver.js (the "unit is full" portion of the 1★ rule_sees_star,
        generalized from "has any star" to "has reached its quota").
        """
        changes = 0
        for unit in p.units:
            indices = unit["indices"]
            stars = sum(1 for i in indices if p.grid[i] == "x")
            if stars < p.stars_per_group:
                continue
            local_changes = sum(
                self._internal_set(p, i, ".", f"UnitSolved({unit['label']})", silent)
                for i in indices if p.grid[i] is None
            )
            changes += local_changes
            if not silent and local_changes > 0:
                return local_changes
        return changes

    def _rule_external_dot_from_placements(self, p, strong):
        """
        For each unsatisfied row/column/region, enumerate every valid way to
        place its remaining star(s). If some cell outside the unit is
        adjacent (including diagonally) to a star in EVERY one of those
        placements, then whichever placement turns out to be true, that cell
        would end up touching a star -- so it must be a dot. Python port of
        hintExternalDotFromPlacements in solver.js.
        """
        for unit in p.units:
            combos = self._enumerate_unit_completions(p, unit, strong)
            if not combos:
                continue

            unit_set = set(unit["indices"])
            intersection = None
            for combo in combos:
                seen = set()
                for cell in combo:
                    for nb in p._neighbor_map[cell]:
                        if nb not in unit_set and p.grid[nb] is None:
                            seen.add(nb)
                intersection = seen if intersection is None else (intersection & seen)
                if not intersection:
                    break

            if not intersection:
                continue

            label = f"ExternalDot{'Strong' if strong else 'Weak'}({unit['label']})"
            changes = sum(
                p.validate_and_set(idx, ".", label, self.verbose)
                for idx in intersection if p.grid[idx] is None
            )
            if changes > 0:
                return changes
        return 0

    def rule_external_dot_from_placements_weak(self, p):
        return self._rule_external_dot_from_placements(p, strong=False)

    def rule_external_dot_from_placements_strong(self, p):
        return self._rule_external_dot_from_placements(p, strong=True)

    def rule_unit_region_sync_multi_1(self, p):
        return self._rule_unit_region_sync_multi(p, 1)

    def rule_unit_region_sync_multi_2(self, p):
        return self._rule_unit_region_sync_multi(p, 2)

    def rule_unit_region_sync_multi_3(self, p):
        return self._rule_unit_region_sync_multi(p, 3)

    def rule_unit_placement_forced_weak_all(self, p):
        return self.rule_unit_placement_forced_cond(p, strong=False, cond="all_stars")

    def rule_unit_placement_forced_weak_any(self, p):
        return self.rule_unit_placement_forced_cond(p, strong=False, cond="any_star")

    def rule_unit_placement_forced_weak_dots(self, p):
        return self.rule_unit_placement_forced_cond(p, strong=False, cond="dots")

    def rule_unit_placement_forced_strong_all(self, p):
        return self.rule_unit_placement_forced_cond(p, strong=True, cond="all_stars")

    def rule_unit_placement_forced_strong_any(self, p):
        return self.rule_unit_placement_forced_cond(p, strong=True, cond="any_star")

    def rule_unit_placement_forced_strong_dots(self, p):
        return self.rule_unit_placement_forced_cond(p, strong=True, cond="dots")

    def rule_unit_placement_forced_cond(self, p, strong, cond):
        """Generalized placement-enumeration engine that filters on specific sub-conditions."""
        changes = 0
        for unit in p.units:
            stars = sum(1 for i in unit["indices"] if p.grid[i] == "x")
            needed = p.stars_per_group - stars
            if needed <= 0:
                continue

            combos = self._enumerate_unit_completions(p, unit, strong)
            if not combos:
                continue

            avail = [i for i in unit["indices"] if p.grid[i] is None]
            forced_stars = [c for c in avail if all(c in combo for combo in combos)]
            forced_dots = [c for c in avail if not any(c in combo for combo in combos)]

            if cond == "all_stars":
                if len(forced_stars) != needed: forced_stars = []
                forced_dots = []
            elif cond == "any_star":
                if len(forced_stars) == 0 or len(forced_stars) == needed: forced_stars = []
                forced_dots = []
            elif cond == "dots":
                forced_stars = []

            for idx in forced_stars:
                changes += self._internal_set(p, idx, "x", f"Forced star ({cond})", silent=False)
            for idx in forced_dots:
                changes += self._internal_set(p, idx, ".", f"Forced dot ({cond})", silent=False)

            if changes > 0:
                return changes
        return 0

    def _unit_kind(self, unit):
        """Row/Column/Region, based on a unit's label."""
        if unit["label"].startswith("Row"):
            return "row"
        if unit["label"].startswith("Col"):
            return "column"
        return "region"

    def rule_unit_completion_satisfies_other_unit(self, p):
        """
        For a row/column/region with missing stars, enumerate every valid
        way to place its remaining stars (strong -- i.e. also respecting
        other units' limits). If EVERY one of those completions exactly
        fills up some OTHER row/column/region (of a different type), then
        that other unit's entire remaining quota is guaranteed to come from
        this unit no matter which completion turns out to be true -- so any
        of its other empty cells (outside this unit) must be dots. Checked
        in both directions: a region's placements can force a row or
        column, and a row's or column's placements can force a region (or
        the other axis). Python port of hintUnitCompletionSatisfiesOtherUnit
        in solver.js.
        """
        for unit in p.units:
            combos = self._enumerate_unit_completions(p, unit, strong=True)
            if not combos:
                continue

            source_kind = self._unit_kind(unit)
            avail = [i for i in unit["indices"] if p.grid[i] is None]

            # Other units (of a different type) that share at least one candidate
            # cell with this one -- only these could possibly be "always satisfied".
            seen_labels = set()
            others = []
            for idx in avail:
                for other_unit in p.units_by_cell[idx]:
                    if other_unit["label"] == unit["label"]:
                        continue
                    if self._unit_kind(other_unit) == source_kind:
                        continue
                    if other_unit["label"] in seen_labels:
                        continue
                    seen_labels.add(other_unit["label"])
                    others.append(other_unit)

            for other in others:
                other_stars = sum(1 for i in other["indices"] if p.grid[i] == "x")
                other_needed = p.stars_per_group - other_stars
                if other_needed <= 0:
                    continue

                other_set = set(other["indices"])
                all_satisfy = all(
                    sum(1 for c in combo if c in other_set) == other_needed
                    for combo in combos
                )
                if not all_satisfy:
                    continue

                unit_set = set(unit["indices"])
                targets = [
                    idx for idx in other["indices"]
                    if idx not in unit_set and p.grid[idx] is None
                ]
                if not targets:
                    continue

                label = (f"UnitCompletionSatisfies({unit['label']} -> {other['label']})")
                changes = sum(
                    p.validate_and_set(idx, ".", label, self.verbose) for idx in targets
                )
                if changes > 0:
                    return changes
        return 0

    def _hint_multi_regions_trapped_or_covered(self, p, unit_combo, b_idx, axis):
        """
        Quota-aware trapped/covered region <-> unit-combo sync for board
        b_idx, generalizing the 1-star pin-rule pattern to units/regions
        that can hold more than one star (compares summed remaining star
        NEED, not a raw count of regions/cells -- see
        get_regions_needing_stars). unit_combo is a list of unit index-lists
        (rows or columns) and need not be adjacent, so this backs both the
        4+-adjacent-window caller (_rule_multi_window_sync) and the disjoint
        2-unit caller (rule_unit_region_sync_multi_2_disjoint).

        This is the same two-case logic as _apply_pin_rule_multi (which
        handles adjacent windows directly via start_u/u_range); this version
        takes an already-built unit_combo instead so it also works for
        disjoint combinations of units.

        Bug history: this used to compare `p.regions` (a list of one
        region-dict per board) against `b_idx` (an int) directly -- always
        False, so region_cells was always empty and both branches below were
        permanent no-ops. Fixed to use get_regions_needing_stars(b_idx) like
        every other multi-star region-sync rule.

        Trapped: regions on b_idx entirely confined to unit_combo's cells
        collectively need exactly as many stars as unit_combo still needs ->
        the rest of unit_combo (outside those regions) must be dots.

        Covered: regions on b_idx touching unit_combo's available cells
        collectively need exactly as many stars as unit_combo still needs ->
        the rest of those regions (outside unit_combo) must be dots.
        """
        n = len(unit_combo)
        unit_idxs = set(idx for unit in unit_combo for idx in unit)

        stars_in_window = sum(1 for i in unit_idxs if p.grid[i] == "x")
        required_count = n * p.stars_per_group - stars_in_window
        if required_count <= 0:
            return 0

        avail_in_units = [i for i in unit_idxs if p.grid[i] is None]
        if not avail_in_units:
            return 0

        needing = p.get_regions_needing_stars(b_idx)

        # Trapped: regions entirely confined to unit_combo.
        pinned = [
            entry for entry in needing
            if (avail := [i for i in entry["unit"]["indices"] if p.grid[i] is None])
            and all(i in unit_idxs for i in avail)
        ]
        total_pinned_needed = sum(entry["remaining"] for entry in pinned)
        if pinned and total_pinned_needed == required_count:
            reg_union = set().union(*(e["unit"]["indices"] for e in pinned))
            label = f"MultiRegionSync({n}-{axis}, B{b_idx+1} trapped)"
            changes = sum(
                p.validate_and_set(idx, ".", label, self.verbose)
                for idx in unit_idxs if idx not in reg_union and p.grid[idx] is None
            )
            if changes > 0:
                return changes

        # Covered: regions touching unit_combo's available cells.
        touching_labels = {p.cell_to_region[b_idx][i] for i in avail_in_units}
        touching = [
            e for e in needing
            if e["unit"]["label"].split(" ")[-1] in touching_labels
        ]
        total_touching_needed = sum(entry["remaining"] for entry in touching)
        if touching and total_touching_needed == required_count:
            reg_union = set().union(*(e["unit"]["indices"] for e in touching))
            label = f"MultiRegionSync({n}-{axis}, B{b_idx+1} covering)"
            changes = sum(
                p.validate_and_set(idx, ".", label, self.verbose)
                for idx in reg_union if idx not in unit_idxs and p.grid[idx] is None
            )
            if changes > 0:
                return changes

        return 0

    def _rule_multi_window_sync(self, p, n, axis):
        """Helper method to run windowed region sync across 'n' units along a specific axis."""
        changes = 0
        units = p.row_indices if axis == "row" else p.col_indices

        # Slide a window of size 'n' across the board's units
        for start_idx in range(p.n - n + 1):
            window_units = [units[i] for i in range(start_idx, start_idx + n)]

            # Skip if any unit in the window already has a settled star
            if any(any(p.grid[i] == "x" for i in unit) for unit in window_units):
                continue

            for b_idx in range(p.n_boards):
                # Reuse your internal trapped/covered logic across the window
                changes = self._hint_multi_regions_trapped_or_covered(p, window_units, b_idx, axis)
                if changes > 0:
                    return changes
        return 0

    def rule_unit_region_sync_multi_4_plus(self, p):
        for n in range(4, p.n):
            for axis in ["row", "col"]:
                changes = self._rule_multi_window_sync(p, n, axis)
                if changes > 0:
                    return changes
        return 0

    def rule_unit_region_sync_multi_2_disjoint(self, p):
        """Allows non-adjacent combinations of 2 units to process multi-sync logic."""
        for axis in ["row", "col"]:
            units = p.row_indices if axis == "row" else p.col_indices
            starless_units = [u for u in range(p.n) if not any(p.grid[i] == "x" for i in units[u])]
            for combo in combinations(starless_units, 2):
                unit_combo = [units[u] for u in combo]
                for b_idx in range(p.n_boards):
                    # Leverages internal multi-trapped logic dynamically
                    changes = self._hint_multi_regions_trapped_or_covered(p, unit_combo, b_idx, axis)
                    if changes > 0:
                        return changes
        return 0

    def _rule_unit_region_sync_multi(self, p, n):
        """
        Generalized N-adjacent-rows/cols <-> region sync, for units and
        regions that can hold more than 1 star. Python port of
        hintUnitRegionSyncMulti(N) in solver.js.
        """
        for axis in ("row", "col"):
            changes = self._apply_pin_rule_multi(p, n, axis)
            if changes > 0:
                return changes
        return 0

    def _apply_pin_rule_multi(self, p, n, axis):
        """
        Multi-star generalization of _apply_pin_rule: instead of comparing a
        COUNT of pinned/covering regions to a count of units (which assumes 1
        star per region), sums each region's actual remaining star need and
        compares that sum to the window's total remaining need.
        """
        units = p.row_indices if axis == "row" else p.col_indices
        for start_u in range(p.n - n + 1):
            u_range = range(start_u, start_u + n)
            unit_idxs = set().union(*(units[u] for u in u_range))

            stars_in_window = sum(1 for i in unit_idxs if p.grid[i] == "x")
            required_count = n * p.stars_per_group - stars_in_window
            if required_count <= 0:
                continue

            avail_in_units = [i for i in unit_idxs if p.grid[i] is None]
            if not avail_in_units:
                continue

            for b_idx in range(p.n_boards):
                needing = p.get_regions_needing_stars(b_idx)

                # Case (b): regions entirely confined to the window ("trapped")
                # collectively need exactly as many stars as the window still
                # needs -> rest of the window (outside those regions) is dots.
                pinned = [
                    entry for entry in needing
                    if (avail := [i for i in entry["unit"]["indices"] if p.grid[i] is None])
                    and all(i in unit_idxs for i in avail)
                ]
                total_pinned_needed = sum(entry["remaining"] for entry in pinned)
                if pinned and total_pinned_needed == required_count:
                    reg_union = set().union(*(e["unit"]["indices"] for e in pinned))
                    label = f"PinMulti({n}-{axis} @ {start_u}, B{b_idx+1} trapped)"
                    changes = sum(
                        p.validate_and_set(idx, ".", label, self.verbose)
                        for idx in unit_idxs if idx not in reg_union and p.grid[idx] is None
                    )
                    if changes > 0:
                        return changes

                # Case (a): regions touching the window ("covering") collectively
                # need exactly as many stars as the window still needs -> rest of
                # those regions (outside the window) is dots.
                touching_labels = {p.cell_to_region[b_idx][i] for i in avail_in_units}
                touching = [
                    e for e in needing
                    if e["unit"]["label"].split(" ")[-1] in touching_labels
                ]
                total_touching_needed = sum(entry["remaining"] for entry in touching)
                if touching and total_touching_needed == required_count:
                    reg_union = set().union(*(e["unit"]["indices"] for e in touching))
                    label = f"PinMulti({n}-{axis} @ {start_u}, B{b_idx+1} covering)"
                    changes = sum(
                        p.validate_and_set(idx, ".", label, self.verbose)
                        for idx in reg_union if idx not in unit_idxs and p.grid[idx] is None
                    )
                    if changes > 0:
                        return changes
        return 0

    # -- Lookahead rules (2★+) --------------------------------------------------
    #
    # These are the multi-star analogues of the 1★ lookahead rules in
    # rules_single_star.py. The key difference: placing a single speculative
    # star in a 2★+ puzzle does NOT, by itself, fill an entire
    # row/column/region -- it only completes a unit that already held
    # (stars_per_group - 1) stars. So "the dots implied by that star" means
    # adjacency dots (always), plus unit-solved dots for any unit the
    # placement happens to complete.

    def rule_lookahead_dots_single_board(self, p):
        """
        2★+ analogue of rule_lookahead_half_stage_single_board. Place a star
        speculatively and add only the dots that single star's placement
        directly implies (adjacency, plus any row/column/region it happens
        to complete), then check for a contradiction visible from ONE
        board's region alone. Region completion is restricted to a single
        board at a time, so a contradiction is only accepted if it's visible
        from that board's viewpoint (or is board-agnostic row/col/adjacency
        geometry).
        """
        quota = p.stars_per_group
        for test_idx in (i for i, val in enumerate(p.grid) if val is None):
            for b_idx in range(p.n_boards):
                reg_char = p.cell_to_region[b_idx][test_idx]
                reg_indices = p.regions[b_idx][reg_char]

                # Skip if this board's region has already reached quota (solved).
                if sum(1 for i in reg_indices if p.grid[i] == "x") >= quota:
                    continue

                saved = p.copy_grid()
                p.grid[test_idx] = "x"

                tr, tc = p.get_rc(test_idx)

                # Adjacency dots always apply.
                for nb in p._neighbor_map[test_idx]:
                    if p.grid[nb] is None:
                        p.grid[nb] = "."

                # Row/column dots only if this placement completed the quota.
                for unit in (p.row_indices[tr], p.col_indices[tc]):
                    if sum(1 for i in unit if p.grid[i] == "x") == quota:
                        for i in unit:
                            if p.grid[i] is None:
                                p.grid[i] = "."

                # Region dots (this board only), only if quota reached.
                if sum(1 for i in reg_indices if p.grid[i] == "x") == quota:
                    for i in reg_indices:
                        if p.grid[i] is None:
                            p.grid[i] = "."

                broken = self._find_broken_unit_single_board(p, b_idx)
                p.restore_grid(saved)

                if broken:
                    changes = p.validate_and_set(
                        test_idx, ".",
                        f"Lookahead-dots single-board (B{b_idx+1}) contradiction",
                        self.verbose)
                    if changes > 0:
                        return changes
        return 0

    def rule_lookahead_dots(self, p):
        """
        2★+ analogue of rule_lookahead_half_stage. Same speculative
        single-star placement as rule_lookahead_dots_single_board, but
        region completion is checked across EVERY board the test cell
        belongs to, so contradictions that only surface when combining
        region information from multiple boards are also caught.
        """
        quota = p.stars_per_group
        for test_idx in (i for i, val in enumerate(p.grid) if val is None):
            saved = p.copy_grid()
            p.grid[test_idx] = "x"

            tr, tc = p.get_rc(test_idx)

            for nb in p._neighbor_map[test_idx]:
                if p.grid[nb] is None:
                    p.grid[nb] = "."

            for unit in (p.row_indices[tr], p.col_indices[tc]):
                if sum(1 for i in unit if p.grid[i] == "x") == quota:
                    for i in unit:
                        if p.grid[i] is None:
                            p.grid[i] = "."

            for b_idx in range(p.n_boards):
                reg_char = p.cell_to_region[b_idx][test_idx]
                reg_indices = p.regions[b_idx][reg_char]
                if sum(1 for i in reg_indices if p.grid[i] == "x") == quota:
                    for i in reg_indices:
                        if p.grid[i] is None:
                            p.grid[i] = "."

            broken = self.is_board_broken(p)
            p.restore_grid(saved)

            if broken:
                changes = p.validate_and_set(
                    test_idx, ".",
                    "Lookahead-dots contradiction",
                    self.verbose)
                if changes > 0:
                    return changes
        return 0

    def rule_lookahead_1_stage_multi(self, p):
        return self._lookahead_n_stages_multi(p, n_stages=1)

    def rule_lookahead_2_stages_multi(self, p):
        return self._lookahead_n_stages_multi(p, n_stages=2)

    def rule_lookahead_3_stages_multi(self, p):
        # High stage count runs propagation to a fixed point; "3" is a
        # minimum depth, not an exact count. Mirrors rule_lookahead_3_stages.
        return self._lookahead_n_stages_multi(p, n_stages=10)

    def _lookahead_n_stages_multi(self, p, n_stages):
        """
        2★+ analogue of _lookahead_n_stages. For each empty cell,
        hypothetically place a star there and repeatedly propagate
        quota-aware consequences -- adjacency dots, unit-solved dots, and
        forced-star fills -- placing any newly-implied stars and dots each
        round, for n_stages rounds. If a contradiction results, that cell
        must be a dot.
        """
        for test_idx in (i for i, val in enumerate(p.grid) if val is None):
            saved = p.copy_grid()
            p.grid[test_idx] = "x"
            broken = False

            for _ in range(n_stages):
                self.rule_exclude_adjacency(p, silent=True)
                self.rule_exclude_solved_unit(p, silent=True)
                self.rule_only_empty_multi(p, silent=True)
                if self.is_board_broken(p):
                    broken = True
                    break

            p.restore_grid(saved)

            if broken:
                changes = p.validate_and_set(
                    test_idx, ".",
                    f"{n_stages}-stage multi-star Lookahead contradiction",
                    self.verbose)
                if changes > 0:
                    return changes
        return 0
