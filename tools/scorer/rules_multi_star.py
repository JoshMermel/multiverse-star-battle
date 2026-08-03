"""
rules_multi_star.py

2-star+ rule_* implementations: everything written against an arbitrary
p.stars_per_unit rather than assuming exactly 1 star per row/col/region.
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
            needed = p.stars_per_unit - stars
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
        Stars can never touch, regardless of stars_per_unit. Python port of
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
        Once a unit has ALL of its stars_per_unit stars placed, every other
        empty cell in it must be a dot. Python port of hintExcludeSolvedUnit
        in solver.js (the "unit is full" portion of the 1★ rule_sees_star,
        generalized from "has any star" to "has reached its quota").
        """
        changes = 0
        for unit in p.units:
            indices = unit["indices"]
            stars = sum(1 for i in indices if p.grid[i] == "x")
            if stars < p.stars_per_unit:
                continue
            local_changes = sum(
                self._internal_set(p, i, ".", f"UnitSolved({unit['label']})", silent)
                for i in indices if p.grid[i] is None
            )
            changes += local_changes
            if not silent and local_changes > 0:
                return local_changes
        return changes

    def _rule_external_dot_from_placements(self, p, level):
        """
        For each unsatisfied row/column/region, enumerate every valid way to
        place its remaining star(s). If some cell outside the unit is
        adjacent (including diagonally) to a star in EVERY one of those
        placements, then whichever placement turns out to be true, that cell
        would end up touching a star -- so it must be a dot. Python port of
        hintExternalDotFromPlacements in solver.js.

        level is 'weak'/'intermediate'/'strong' -- see
        ScorerCore._unit_completions_by_level for what each means. For
        'intermediate', a target is used if it's forced by ANY single
        scope's (e.g. one board's) combos alone.
        """
        for unit in p.units:
            completion_sets = [
                combos for combos in self._unit_completions_by_level(p, unit, level) if combos
            ]
            if not completion_sets:
                continue

            unit_set = set(unit["indices"])
            target_union = set()
            for combos in completion_sets:
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
                if intersection:
                    target_union |= intersection

            if not target_union:
                continue

            label = f"ExternalDot{level.capitalize()}({unit['label']})"
            changes = sum(
                p.validate_and_set(idx, ".", label, self.verbose)
                for idx in target_union if p.grid[idx] is None
            )
            if changes > 0:
                return changes
        return 0

    def rule_external_dot_from_placements_weak(self, p):
        return self._rule_external_dot_from_placements(p, level='weak')

    def rule_external_dot_from_placements_intermediate(self, p):
        return self._rule_external_dot_from_placements(p, level='intermediate')

    def rule_external_dot_from_placements_strong(self, p):
        return self._rule_external_dot_from_placements(p, level='strong')

    def rule_unit_region_sync_multi_1(self, p):
        return self._rule_unit_region_sync_multi(p, 1)

    def rule_unit_region_sync_multi_2(self, p):
        return self._rule_unit_region_sync_multi(p, 2)

    def rule_unit_region_sync_multi_3(self, p):
        return self._rule_unit_region_sync_multi(p, 3)

    def rule_unit_placement_forced_weak_all(self, p):
        return self.rule_unit_placement_forced_cond(p, level='weak', cond="all_stars")

    def rule_unit_placement_forced_weak_any(self, p):
        return self.rule_unit_placement_forced_cond(p, level='weak', cond="any_star")

    def rule_unit_placement_forced_weak_dots(self, p):
        return self.rule_unit_placement_forced_cond(p, level='weak', cond="dots")

    def rule_unit_placement_forced_intermediate_all(self, p):
        return self.rule_unit_placement_forced_cond(p, level='intermediate', cond="all_stars")

    def rule_unit_placement_forced_intermediate_any(self, p):
        return self.rule_unit_placement_forced_cond(p, level='intermediate', cond="any_star")

    def rule_unit_placement_forced_intermediate_dots(self, p):
        return self.rule_unit_placement_forced_cond(p, level='intermediate', cond="dots")

    def rule_unit_placement_forced_strong_all(self, p):
        return self.rule_unit_placement_forced_cond(p, level='strong', cond="all_stars")

    def rule_unit_placement_forced_strong_any(self, p):
        return self.rule_unit_placement_forced_cond(p, level='strong', cond="any_star")

    def rule_unit_placement_forced_strong_dots(self, p):
        return self.rule_unit_placement_forced_cond(p, level='strong', cond="dots")

    def _get_placement_forced_combos(self, p, level):
        """
        Enumerates every unit's remaining-star completions once per (grid
        state, level) and shares the result across all nine
        rule_unit_placement_forced_* variants -- weak_all/any/dots share
        one pass, intermediate_all/any/dots share a separate pass, and
        strong_all/any/dots share a third -- instead of each of the nine
        independently re-running the same combinatorial enumeration over
        every unit. Keyed on a full grid snapshot rather than tracked
        mutation sites so it can never go stale, at the cost of a cheap
        tuple(p.grid) per top-level rule call.

        Each cached value is a dict of unit id -> list of "completion
        sets" (see ScorerCore._unit_completions_by_level): a single-entry
        list for weak/strong, one entry per board for intermediate.
        """
        cache = getattr(p, '_placement_forced_cache', None)
        if cache is None:
            cache = p._placement_forced_cache = {}
        key = (level, tuple(p.grid))
        cached = cache.get(key)
        if cached is not None:
            return cached
        result = {}
        for unit in p.units:
            completion_sets = [
                combos for combos in self._unit_completions_by_level(p, unit, level) if combos
            ]
            if completion_sets:
                result[id(unit)] = completion_sets
        cache[key] = result
        return result

    def rule_unit_placement_forced_cond(self, p, level, cond):
        """
        Generalized placement-enumeration engine that filters on specific
        sub-conditions. level is 'weak'/'intermediate'/'strong' -- see
        ScorerCore._unit_completions_by_level.
        """
        combo_sets_by_unit = self._get_placement_forced_combos(p, level)
        changes = 0
        for unit in p.units:
            stars = sum(1 for i in unit["indices"] if p.grid[i] == "x")
            needed = p.stars_per_unit - stars
            if needed <= 0:
                continue

            completion_sets = combo_sets_by_unit.get(id(unit))
            if not completion_sets:
                continue

            # Union across scopes: forced if ANY single scope's combos
            # alone already prove it -- see _unit_completions_by_level.
            avail = [i for i in unit["indices"] if p.grid[i] is None]
            forced_stars = [
                c for c in avail if any(all(c in combo for combo in combos) for combos in completion_sets)
            ]
            forced_dots = [
                c for c in avail if any(not any(c in combo for combo in combos) for combos in completion_sets)
            ]

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

    def rule_unit_completion_satisfies_other_unit_intermediate(self, p):
        return self._rule_unit_completion_satisfies_other_unit(p, level='intermediate')

    def rule_unit_completion_satisfies_other_unit_strong(self, p):
        return self._rule_unit_completion_satisfies_other_unit(p, level='strong')

    def _rule_unit_completion_satisfies_other_unit(self, p, level):
        """
        For a row/column/region with missing stars, enumerate every valid
        way to place its remaining stars. If EVERY one of those completions
        exactly fills up some OTHER row/column/region (of a different
        type), then that other unit's entire remaining quota is guaranteed
        to come from this unit no matter which completion turns out to be
        true -- so any of its other empty cells (outside this unit) must be
        dots. Checked in both directions: a region's placements can force a
        row or column, and a row's or column's placements can force a
        region (or the other axis). Python port of
        hintUnitCompletionSatisfiesOtherUnit in solver.js.

        level is 'intermediate' or 'strong' (no 'weak' -- a capacity-free
        version of this rule wouldn't reliably prove anything, since the
        whole deduction hinges on quota bookkeeping). See
        ScorerCore._unit_completions_by_level: 'intermediate' only ever
        needs one board's regions to reach its conclusion; 'strong' may
        need both.
        """
        seen_pairs = set()  # (unit label, other label), deduped across scopes

        for unit in p.units:
            completion_sets = [
                combos for combos in self._unit_completions_by_level(p, unit, level) if combos
            ]
            if not completion_sets:
                continue

            source_kind = self._unit_kind(unit)
            avail = [i for i in unit["indices"] if p.grid[i] is None]
            scopes = [unit["board_idx"]] if unit["board_idx"] is not None else list(range(p.n_boards))

            for scope_i, combos in enumerate(completion_sets):
                # For 'intermediate', an "other" unit is only a fair
                # candidate if it's visible from THIS SAME scope's
                # single-board viewpoint -- a region on a different board
                # isn't something this particular completion set's
                # reasoning ever looked at.
                scope_board_idx = scopes[scope_i] if level == 'intermediate' else None

                seen_labels = set()
                others = []
                for idx in avail:
                    for other_unit in p.units_by_cell[idx]:
                        if other_unit["label"] == unit["label"]:
                            continue
                        if self._unit_kind(other_unit) == source_kind:
                            continue
                        if (scope_board_idx is not None and other_unit["board_idx"] is not None
                                and other_unit["board_idx"] != scope_board_idx):
                            continue
                        if other_unit["label"] in seen_labels:
                            continue
                        seen_labels.add(other_unit["label"])
                        others.append(other_unit)

                for other in others:
                    pair_key = (unit["label"], other["label"])
                    if pair_key in seen_pairs:
                        continue

                    other_stars = sum(1 for i in other["indices"] if p.grid[i] == "x")
                    other_needed = p.stars_per_unit - other_stars
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

                    seen_pairs.add(pair_key)
                    label = (f"UnitCompletionSatisfies{level.capitalize()}({unit['label']} -> {other['label']})")
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
        required_count = n * p.stars_per_unit - stars_in_window
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
                    changes = self._hint_multi_regions_trapped_or_covered(p, unit_combo, b_idx, axis)
                    if changes > 0:
                        return changes
        return 0

    # -- Cross-board N-regions-pin-N-rows/cols (2★+) ---------------------------
    #
    # Generalizes rule_2/3_region_pinned_crossboard_rows/cols (1★-only,
    # rules_single_star.py) to any stars_per_unit. The 1★ version matches
    # exactly N regions (each implicitly needing exactly 1 star, since 1★
    # regions always need 1) whose available cells all fall in the same N
    # adjacent rows/cols -- which for 1★ automatically fills that window's
    # entire quota (N rows x 1 star/row = N). Once a region can need more
    # than one star, "N regions confined to N rows" no longer implies "these
    # regions supply the window's entire quota" (a window of N rows needs
    # N * stars_per_unit stars, not N) -- see _apply_pin_rule_multi's
    # required_count for the same distinction. So this pools every trapped
    # region (any board) in the window and compares their summed remaining
    # need to the window's actual required_count, not to n. Genuinely
    # cross-board only: an all-same-board trapped set would already have
    # been caught earlier (Medium/Hard) by rule_unit_region_sync_multi_2/_3
    # (_apply_pin_rule_multi's own per-board Case (b)), so this requires the
    # trapped set to span at least 2 distinct boards.

    def rule_crossboard_n_region_pinned_multi_2_rows(self, p):
        return self._rule_crossboard_n_region_pinned_multi(p, n=2, axis="row")

    def rule_crossboard_n_region_pinned_multi_2_cols(self, p):
        return self._rule_crossboard_n_region_pinned_multi(p, n=2, axis="col")

    def rule_crossboard_n_region_pinned_multi_3_rows(self, p):
        return self._rule_crossboard_n_region_pinned_multi(p, n=3, axis="row")

    def rule_crossboard_n_region_pinned_multi_3_cols(self, p):
        return self._rule_crossboard_n_region_pinned_multi(p, n=3, axis="col")

    def _rule_crossboard_n_region_pinned_multi(self, p, n, axis):
        """
        MATCH: within a window of n adjacent rows/cols, every region (pooled
        across ALL boards) whose open cells are entirely confined to that
        window ("trapped") jointly needs exactly as many stars as the
        window itself still needs (n * stars_per_unit, minus stars already
        placed in the window) -- and that trapped set spans at least 2
        different boards. (A trapped set confined to one board is already
        covered by rule_unit_region_sync_multi_2/_3's "trapped" case, via
        _apply_pin_rule_multi -- this rule only fires on the genuinely
        cross-board case.)
        ACTION: every other open cell in the window is a dot.

        Mirrors _apply_pin_rule_multi's Case (b), generalized to pool
        regions from every board instead of one board at a time. Requires
        the trapped regions' open cells to be pairwise disjoint: since
        boards share one physical grid, a region on board A and a region on
        board B can include the same cell, and summing "remaining" across
        overlapping regions would overcount how many distinct stars are
        actually still needed.
        """
        units = p.row_indices if axis == "row" else p.col_indices
        for start_u in range(p.n - n + 1):
            u_range = range(start_u, start_u + n)
            window_idxs = set().union(*(units[u] for u in u_range))

            stars_in_window = sum(1 for i in window_idxs if p.grid[i] == "x")
            required_count = n * p.stars_per_unit - stars_in_window
            if required_count <= 0:
                continue

            needing = [
                entry
                for b_idx in range(p.n_boards)
                for entry in p.get_regions_needing_stars(b_idx)
            ]
            trapped = [
                entry for entry in needing
                if (avail := [i for i in entry["unit"]["indices"] if p.grid[i] is None])
                and all(i in window_idxs for i in avail)
            ]
            if not trapped:
                continue

            boards_touched = {e["unit"]["board_idx"] for e in trapped}
            if len(boards_touched) < 2:
                continue  # same-board only: already covered elsewhere

            idx_sets = [set(e["unit"]["indices"]) for e in trapped]
            if not self._are_disjoint(idx_sets):
                continue

            total_trapped_needed = sum(e["remaining"] for e in trapped)
            if total_trapped_needed != required_count:
                continue

            reg_union = set().union(*idx_sets)
            labels = ", ".join(e["unit"]["label"] for e in trapped)
            changes = sum(
                p.validate_and_set(
                    idx, ".",
                    f"Cross-Board {axis.capitalize()} Pin Multi ({labels})",
                    self.verbose)
                for idx in window_idxs
                if idx not in reg_union and p.grid[idx] is None
            )
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
            required_count = n * p.stars_per_unit - stars_in_window
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

    # -- At-least-1 / at-most-1 (2★+) ------------------------------------------
    #
    # A group of cells can be known to jointly hold "at least 1" star, or
    # jointly hold "at most 1" star. Two forcing checks consume those facts:
    #
    # (a) N+1 candidates, N needed (_apply_at_most_one_forcing): if a unit
    #     needs 2 more stars from exactly 3 candidates {x, y, z}, and some
    #     pair among them is a known at-most-1 group, that pair supplies at
    #     most 1 of the 2 needed stars, so the third candidate is forced.
    # (b) Q disjoint groups fill the quota (_apply_disjoint_quota_fill): if a
    #     unit needs Q more stars and Q mutually disjoint at-least-1 groups
    #     are found among its candidates, they account for the quota
    #     exactly, so every other candidate is forced to a dot.
    #
    # Three sources feed those checks, kept separate (not pooled) so a hint
    # only ever traces back to ONE kind of reasoning -- see rule_clump_* vs
    # rule_witness_* below for how each maps to a tier.
    #
    # Source 1 (region/line-split, "Rule of Clumps", from krazydad): a
    # region's remaining candidates in one row/column ("in_line"), plus a
    # small "remainder" outside it. If adjacency alone proves the remainder
    # holds at most m stars, and the region needs k overall, in_line must
    # supply at least (k - m) of them. m == 0 makes the rest of the line all
    # dots directly; (k - m) == 1 registers in_line as an at-least-1 group
    # and the rest of the line as an at-most-1 group.
    #
    # Source 2 (line-pair box covering): for a pair of adjacent rows (or
    # columns), cover every empty cell in that 2-line band with the fewest
    # disjoint 2x2 boxes (any 2x2 is always an at-most-1 group). If the box
    # count matches the band's remaining star need exactly, each box must
    # supply exactly one star -- both at-least-1 and at-most-1 at once.
    # Board-agnostic; no region membership involved.
    #
    # Sources 1 and 2 are single geometric hops a player can check by eye --
    # feed the Hard-tier rule_clump_* rules below.
    #
    # Source 3 (witness projection): a pair {i, j} is at-least-1 when no
    # valid completion of some unit leaves both empty. Pick a cell forced to
    # a dot if i were starred, and a different cell forced to a dot if j
    # were starred -- those two cells can't both be stars without forcing
    # both i and j empty, so they're at-most-1. A genuine two-hop chain, not
    # visually checkable -- feeds the Expert-tier rule_witness_* rules below.

    def _cached_on_grid(self, p, cache_attr, compute_fn):
        """
        Small memoization helper for the Hard/Expert "clump"/"witness"
        analysis passes below: several sibling rules (rule_clump_*,
        rule_witness_*) each independently trigger the same expensive
        grid-wide scan when they run in the same round with no state
        change between them (only one rule can succeed -- and mutate the
        grid -- per round; see ScorerCore.solve). Keyed on a full grid
        snapshot rather than tracked mutation call sites, so a cache hit
        is only ever returned for a grid state identical to the one it
        was computed from -- correct regardless of how many places
        happen to write to p.grid.
        """
        cache = getattr(p, cache_attr, None)
        if cache is None:
            cache = {}
            setattr(p, cache_attr, cache)
        key = tuple(p.grid)
        if key not in cache:
            cache[key] = compute_fn()
        return cache[key]

    def _find_at_least_one_pairs(self, p, level):
        return self._cached_on_grid(
            p, f'_at_least_one_pairs_cache_{level}', lambda: self._find_at_least_one_pairs_impl(p, level))

    def _find_at_least_one_pairs_impl(self, p, level):
        """
        Source 3's at-least-1 half. Every pair of candidate cells (i, j),
        across every row/column/region on every board, such that no valid
        way to complete that unit's remaining stars leaves both i and j
        empty -- i.e. at least one of the pair must hold a star.

        level is 'intermediate' or 'strong' (no 'weak' -- same reasoning
        as _rule_unit_completion_satisfies_other_unit: a capacity-free
        version wouldn't reliably prove anything). See
        ScorerCore._unit_completions_by_level: 'intermediate' only ever
        needs one board's regions to reach its conclusion; 'strong' may
        need both. (_cells_forced_to_dot_if_starred, the at-most-1 half
        below, is deliberately NOT level-gated: it's a simple one-step
        consequence check that's equally valid whichever board(s) it
        happens to touch, not a capacity-combining argument.)
        """
        pairs = set()
        for unit in p.units:
            completion_sets = [
                combos for combos in self._unit_completions_by_level(p, unit, level) if combos
            ]
            if not completion_sets:
                continue
            avail = [i for i in unit["indices"] if p.grid[i] is None]
            for idx1 in range(len(avail)):
                for idx2 in range(idx1 + 1, len(avail)):
                    i, j = avail[idx1], avail[idx2]
                    if any(
                        all(i in combo or j in combo for combo in combos)
                        for combos in completion_sets
                    ):
                        pairs.add((i, j) if i < j else (j, i))
        return pairs

    def _cells_forced_to_dot_if_starred(self, p, idx):
        """
        Cells that would be forced to a dot as an immediate, one-step
        consequence of placing a star at idx: its 8-neighbors (adjacency
        always applies, regardless of quota), plus any row/column/region
        containing idx that would reach its star quota as a RESULT of this
        one placement (i.e. currently has quota - 1 stars). Deliberately
        cheap/one-step -- not the full set of cells that would eventually
        be excluded after further propagation -- since that's all the
        soundness of the at-most-1 projection below actually needs.
        """
        quota = p.stars_per_unit
        forced = set(nb for nb in p._neighbor_map[idx] if p.grid[nb] is None)

        r, c = p.get_rc(idx)
        for unit_indices in (p.row_indices[r], p.col_indices[c]):
            stars = sum(1 for i in unit_indices if p.grid[i] == "x")
            if stars == quota - 1:
                forced.update(i for i in unit_indices if i != idx and p.grid[i] is None)

        for b_idx in range(p.n_boards):
            reg_char = p.cell_to_region[b_idx][idx]
            reg_indices = p.regions[b_idx][reg_char]
            stars = sum(1 for i in reg_indices if p.grid[i] == "x")
            if stars == quota - 1:
                forced.update(i for i in reg_indices if i != idx and p.grid[i] is None)

        return forced

    def _derive_at_most_one_groups_from_witness_pairs(self, p, at_least_one_pairs):
        """
        Source 3's at-most-1 half: projects each at-least-1 pair {i, j} to
        every at-most-1 witness pair {a, b}: a drawn from cells
        forced-to-dot-if-i-starred, b drawn from cells
        forced-to-dot-if-j-starred, a != b.
        """
        groups = set()
        for (i, j) in at_least_one_pairs:
            forced_by_i = self._cells_forced_to_dot_if_starred(p, i)
            forced_by_j = self._cells_forced_to_dot_if_starred(p, j)
            for a in forced_by_i:
                for b in forced_by_j:
                    if a != b:
                        groups.add(frozenset((a, b)))
        return groups

    def _max_stars_fittable(self, p, cells):
        """
        Upper bound on how many stars could simultaneously occupy `cells`,
        from mutual non-adjacency alone -- always a sound bound, regardless
        of what units the cells belong to (adjacency is never allowed,
        independent of quota). Brute-forces every subset, so only meant for
        small cell sets (a "tiny clump", e.g. bounded by a 2x2 box -- which
        always gives exactly 1 -- or smaller/sparser).
        """
        cells = list(cells)
        best = 0
        for mask in range(1, 1 << len(cells)):
            subset = [cells[i] for i in range(len(cells)) if mask & (1 << i)]
            if len(subset) <= best:
                continue
            if all(
                not self._cells_adjacent(p, subset[a], subset[b])
                for a in range(len(subset))
                for b in range(a + 1, len(subset))
            ):
                best = len(subset)
        return best

    # Cap on the region's "leftover" cell count source 1 will analyze via
    # _max_stars_fittable's brute force -- keeps it a cheap "tiny clump"
    # check rather than a full sub-region solver.
    _LINE_SPLIT_REMAINDER_CAP = 4

    def _region_line_split_facts(self, p):
        return self._cached_on_grid(
            p, '_region_line_split_cache', lambda: self._region_line_split_facts_impl(p))

    def _region_line_split_facts_impl(self, p):
        """
        Source 1 (see class-level comment above). Returns (changes,
        at_most_one_groups, at_least_one_groups): changes > 0 if a "rest of
        the line is entirely dots" deduction was applied directly;
        at_most_one_groups is every "rest of line" cell set found to hold
        at most 1 star instead; at_least_one_groups is every "in_line" cell
        set proven to hold at least 1 star (only when that bound is
        exactly 1 -- see class-level comment).
        """
        at_most_groups = set()
        at_least_groups = set()

        for b_idx in range(p.n_boards):
            for r_char, r_indices in p.regions[b_idx].items():
                avail = [i for i in r_indices if p.grid[i] is None]
                if len(avail) < 2:
                    continue
                stars_in_region = sum(1 for i in r_indices if p.grid[i] == "x")
                k = p.stars_per_unit - stars_in_region
                if k <= 0:
                    continue

                for axis, units in (("row", p.row_indices), ("col", p.col_indices)):
                    lines = {}
                    for i in avail:
                        rr, cc = p.get_rc(i)
                        key = rr if axis == "row" else cc
                        lines.setdefault(key, []).append(i)

                    for line_idx, in_line in lines.items():
                        remainder = [i for i in avail if i not in in_line]
                        if not remainder or len(remainder) > self._LINE_SPLIT_REMAINDER_CAP:
                            continue
                        m = self._max_stars_fittable(p, remainder)
                        q = k - m
                        if q < 1:
                            continue  # remainder alone could already cover it

                        if q == 1:
                            at_least_groups.add(frozenset(in_line))

                        line_indices = units[line_idx]
                        line_stars = sum(1 for i in line_indices if p.grid[i] == "x")
                        line_needed = p.stars_per_unit - line_stars
                        rest_of_line = [
                            i for i in line_indices
                            if p.grid[i] is None and i not in in_line
                        ]
                        if not rest_of_line:
                            continue

                        bound = line_needed - q
                        if bound <= 0:
                            label = (
                                f"AtLeastOneLineSplit(B{b_idx+1} Reg {r_char} "
                                f"vs {axis} {line_idx})"
                            )
                            changes = sum(
                                p.validate_and_set(idx, ".", label, self.verbose)
                                for idx in rest_of_line
                            )
                            if changes > 0:
                                return changes, at_most_groups, at_least_groups
                        elif bound == 1:
                            at_most_groups.add(frozenset(rest_of_line))
        return 0, at_most_groups, at_least_groups

    def _find_line_pair_box_cover_groups(self, p):
        return self._cached_on_grid(
            p, '_box_cover_cache', lambda: self._find_line_pair_box_cover_groups_impl(p))

    def _find_line_pair_box_cover_groups_impl(self, p):
        """
        Source 2 (see class-level comment above): for each pair of
        ADJACENT rows (and separately, adjacent columns), try to cover
        every empty cell in that 2-line band with the fewest possible
        disjoint 2x2 boxes. If the minimum box count exactly matches the
        band's remaining star need, every box is registered as BOTH an
        at-least-1 and an at-most-1 group.

        Board-agnostic: rows/columns are shared across every board, so
        this never loops over p.n_boards, unlike source 1.
        """
        groups = set()
        n = p.n

        for axis, units in (("row", p.row_indices), ("col", p.col_indices)):
            for start in range(n - 1):
                window_indices = units[start] + units[start + 1]
                avail = [i for i in window_indices if p.grid[i] is None]
                if not avail:
                    continue
                stars_in_window = sum(1 for i in window_indices if p.grid[i] == "x")
                required = 2 * p.stars_per_unit - stars_in_window
                if required <= 0:
                    continue

                # Positions along the OTHER axis (columns, if axis == "row")
                # that have at least one empty cell in this band.
                other_positions = sorted(set(
                    (i % n if axis == "row" else i // n) for i in avail
                ))

                # Greedy minimum covering by width-2 spans: start a box at
                # the leftmost uncovered position, extend one more position
                # right, skip everything that box now covers, repeat. This
                # is the standard optimal strategy for "minimum number of
                # fixed-width intervals to cover a set of points", and
                # naturally produces disjoint boxes (each skips past its
                # own full span before the next one starts).
                boxes = []
                idx = 0
                while idx < len(other_positions):
                    c0 = other_positions[idx]
                    boxes.append((c0, c0 + 1))
                    idx += 1
                    while idx < len(other_positions) and other_positions[idx] <= c0 + 1:
                        idx += 1

                if len(boxes) != required:
                    continue

                for (c0, c1) in boxes:
                    box_cells = [
                        i for i in avail
                        if (i % n if axis == "row" else i // n) in (c0, c1)
                    ]
                    if box_cells:
                        groups.add(frozenset(box_cells))

        return groups

    def _apply_at_most_one_forcing(self, p, at_most_one_groups):
        """
        For a unit needing N more stars from exactly N+1 remaining
        candidates, if some pair among them is a subset of any known
        at-most-1 group, that pair supplies at most 1 of the N needed
        stars -- so the other N-1 candidates must jointly supply at least
        N-1, and since there are exactly that many of them, ALL of them
        are forced to stars (pigeonhole). N=2 is the classic case (a
        single "third candidate" forced); this generalizes to any N>=2,
        which matters for 3-star+ puzzles where a unit can need 3 or more
        stars from 4 or more candidates.
        """
        for unit in p.units:
            stars = sum(1 for i in unit["indices"] if p.grid[i] == "x")
            needed = p.stars_per_unit - stars
            if needed < 2:
                continue
            avail = [i for i in unit["indices"] if p.grid[i] is None]
            if len(avail) != needed + 1:
                continue
            for a, b in combinations(avail, 2):
                pair = frozenset((a, b))
                if any(pair <= group for group in at_most_one_groups):
                    rest = [i for i in avail if i not in pair]
                    changes = sum(
                        p.validate_and_set(idx, "x", "AtLeastOneForcing", self.verbose)
                        for idx in rest if p.grid[idx] is None
                    )
                    if changes > 0:
                        return changes
        return 0

    def _find_disjoint_group_combo(self, groups, k):
        """
        Backtracking search for k mutually disjoint groups among `groups`
        (each a list/tuple/frozenset of cell indices). Returns the combo
        (a list of k groups) if found, else None. `groups` and k are both
        expected to be small in practice (k is a unit's remaining star
        quota -- at most stars_per_unit), so this is cheap.
        """
        def backtrack(start, chosen, used):
            if len(chosen) == k:
                return list(chosen)
            for idx in range(start, len(groups)):
                g = groups[idx]
                if used & set(g):
                    continue
                result = backtrack(idx + 1, chosen + [g], used | set(g))
                if result is not None:
                    return result
            return None
        return backtrack(0, [], set())

    def _apply_disjoint_quota_fill(self, p, at_least_one_groups):
        """
        For a unit needing exactly Q more stars: if Q mutually disjoint
        at-least-1 groups can be found, all contained within the unit's
        remaining candidates, those groups collectively guarantee exactly
        Q stars -- matching the unit's remaining need exactly -- so every
        other candidate in the unit, outside their union, must be a dot.

        Q=2 (a still-fully-open 2★ unit) needs two disjoint at-least-1
        groups; Q=1 (a unit already at quota-1, down to its last star)
        needs just one -- that single group fully accounts for the unit's
        last star, so the rest of its empties are dots. Both are the same
        principle at different Q.
        """
        all_groups = list(at_least_one_groups)
        for unit in p.units:
            stars = sum(1 for i in unit["indices"] if p.grid[i] == "x")
            q = p.stars_per_unit - stars
            if q <= 0:
                continue
            avail = set(i for i in unit["indices"] if p.grid[i] is None)
            if len(avail) <= q:
                continue  # nothing extra to eliminate even if this succeeds

            relevant = [g for g in all_groups if set(g) <= avail]
            if len(relevant) < q:
                continue

            combo = self._find_disjoint_group_combo(relevant, q)
            if combo is None:
                continue

            covered = set()
            for g in combo:
                covered |= set(g)
            targets = [i for i in avail if i not in covered]
            if not targets:
                continue

            label = f"DisjointAtLeastOneQuotaFill({unit['label']}, Q={q})"
            changes = sum(
                p.validate_and_set(idx, ".", label, self.verbose) for idx in targets
            )
            if changes > 0:
                return changes
        return 0

    # -- Hard tier: clump-sourced (sources 1 + 2, single geometric hop) -------

    def rule_clump_direct_dots(self, p):
        """Region/line-split's self-contained direct-dots case, standalone."""
        changes, _, _ = self._region_line_split_facts(p)
        return changes

    def rule_clump_at_most_one_forcing(self, p):
        """_apply_at_most_one_forcing fed only by sources 1 and 2."""
        _, clump_groups, _ = self._region_line_split_facts(p)
        box_groups = self._find_line_pair_box_cover_groups(p)
        at_most_one_groups = clump_groups | box_groups
        if not at_most_one_groups:
            return 0
        return self._apply_at_most_one_forcing(p, at_most_one_groups)

    def rule_clump_disjoint_quota_fill(self, p):
        """_apply_disjoint_quota_fill fed only by sources 1 and 2."""
        _, _, clump_groups = self._region_line_split_facts(p)
        box_groups = self._find_line_pair_box_cover_groups(p)
        at_least_one_groups = clump_groups | box_groups
        if not at_least_one_groups:
            return 0
        return self._apply_disjoint_quota_fill(p, at_least_one_groups)

    # -- Hard/Expert tier: witness-sourced (source 3, two-hop chain) ----------
    #
    # 'intermediate' (Hard): the at-least-1 pairs only ever needed one
    # board's regions to prove. 'strong' (Expert): may need both boards'
    # regions combined. Same split as rule_unit_placement_forced_* etc.

    def rule_witness_at_most_one_forcing_intermediate(self, p):
        return self._rule_witness_at_most_one_forcing(p, level='intermediate')

    def rule_witness_at_most_one_forcing_strong(self, p):
        return self._rule_witness_at_most_one_forcing(p, level='strong')

    def _rule_witness_at_most_one_forcing(self, p, level):
        """_apply_at_most_one_forcing fed only by source 3."""
        at_least_pairs = self._find_at_least_one_pairs(p, level)
        if not at_least_pairs:
            return 0
        witness_groups = self._derive_at_most_one_groups_from_witness_pairs(p, at_least_pairs)
        if not witness_groups:
            return 0
        return self._apply_at_most_one_forcing(p, witness_groups)

    def rule_witness_disjoint_quota_fill_intermediate(self, p):
        return self._rule_witness_disjoint_quota_fill(p, level='intermediate')

    def rule_witness_disjoint_quota_fill_strong(self, p):
        return self._rule_witness_disjoint_quota_fill(p, level='strong')

    def _rule_witness_disjoint_quota_fill(self, p, level):
        """_apply_disjoint_quota_fill fed only by source 3."""
        at_least_pairs = self._find_at_least_one_pairs(p, level)
        if not at_least_pairs:
            return 0
        return self._apply_disjoint_quota_fill(p, at_least_pairs)

    # -- Lookahead rules (2★+) --------------------------------------------------
    #
    # These are the multi-star analogues of the 1★ lookahead rules in
    # rules_single_star.py. The key difference: placing a single speculative
    # star in a 2★+ puzzle does NOT, by itself, fill an entire
    # row/column/region -- it only completes a unit that already held
    # (stars_per_unit - 1) stars. So "the dots implied by that star" means
    # adjacency dots (always), plus unit-solved dots for any unit the
    # placement happens to complete.

    def _rule_lookahead_dots_impl(self, p, single_board):
        """
        Shared implementation for rule_lookahead_dots_single_board /
        rule_lookahead_dots: speculatively place one star, add only the
        dots that placement directly implies (adjacency, plus any
        row/column/region it happens to complete), and check for a
        contradiction. single_board=True checks each board in turn,
        restricting region completion (and the resulting contradiction
        check) to that one board's viewpoint; single_board=False checks
        region completion across every board the test cell belongs to at
        once, catching contradictions that only surface by combining
        region information from multiple boards.
        """
        quota = p.stars_per_unit
        board_scopes = range(p.n_boards) if single_board else [None]

        for test_idx in (i for i, val in enumerate(p.grid) if val is None):
            tr, tc = p.get_rc(test_idx)

            for b_idx in board_scopes:
                if single_board:
                    reg_char = p.cell_to_region[b_idx][test_idx]
                    reg_indices = p.regions[b_idx][reg_char]
                    # Skip if this board's region has already reached quota (solved).
                    if sum(1 for i in reg_indices if p.grid[i] == "x") >= quota:
                        continue

                saved = p.copy_grid()
                p.grid[test_idx] = "x"

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

                # Region dots: this board only in single-board mode, every
                # board the cell belongs to otherwise.
                for b in ([b_idx] if single_board else range(p.n_boards)):
                    reg_char = p.cell_to_region[b][test_idx]
                    reg_indices = p.regions[b][reg_char]
                    if sum(1 for i in reg_indices if p.grid[i] == "x") == quota:
                        for i in reg_indices:
                            if p.grid[i] is None:
                                p.grid[i] = "."

                broken = (self._find_broken_unit_single_board(p, b_idx)
                          if single_board else self.is_board_broken(p))
                p.restore_grid(saved)

                if broken:
                    label = (f"Lookahead-dots single-board (B{b_idx+1}) contradiction"
                             if single_board else "Lookahead-dots contradiction")
                    changes = p.validate_and_set(test_idx, ".", label, self.verbose)
                    if changes > 0:
                        return changes
        return 0

    def rule_lookahead_dots_single_board(self, p):
        """
        2★+ analogue of rule_lookahead_half_stage_single_board. Region
        completion is restricted to a single board at a time, so a
        contradiction is only accepted if it's visible from that board's
        viewpoint (or is board-agnostic row/col/adjacency geometry).
        """
        return self._rule_lookahead_dots_impl(p, single_board=True)

    def rule_lookahead_dots(self, p):
        """
        2★+ analogue of rule_lookahead_half_stage. Same speculative
        single-star placement as rule_lookahead_dots_single_board, but
        region completion is checked across EVERY board the test cell
        belongs to, so contradictions that only surface when combining
        region information from multiple boards are also caught.
        """
        return self._rule_lookahead_dots_impl(p, single_board=False)

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
