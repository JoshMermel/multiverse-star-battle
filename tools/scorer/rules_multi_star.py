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
            needed = p.stars_per_unit - stars
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

    def _find_at_least_one_pairs(self, p):
        """
        Source 3's at-least-1 half. Every pair of candidate cells (i, j),
        across every row/column/region on every board, such that no valid
        way to complete that unit's remaining stars leaves both i and j
        empty -- i.e. at least one of the pair must hold a star.
        """
        pairs = set()
        for unit in p.units:
            combos = self._enumerate_unit_completions(p, unit, strong=True)
            if not combos:
                continue
            avail = [i for i in unit["indices"] if p.grid[i] is None]
            for idx1 in range(len(avail)):
                for idx2 in range(idx1 + 1, len(avail)):
                    i, j = avail[idx1], avail[idx2]
                    if all(i in combo or j in combo for combo in combos):
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
        For a unit needing exactly 2 more stars with exactly 3 remaining
        candidates, if some pair among them is a subset of any known
        at-most-1 group, that pair supplies at most 1 of the 2 needed
        stars, so the third candidate is forced to a star.
        """
        for unit in p.units:
            stars = sum(1 for i in unit["indices"] if p.grid[i] == "x")
            needed = p.stars_per_unit - stars
            if needed != 2:
                continue
            avail = [i for i in unit["indices"] if p.grid[i] is None]
            if len(avail) != needed + 1:
                continue
            for a, b in combinations(avail, 2):
                pair = frozenset((a, b))
                if any(pair <= group for group in at_most_one_groups):
                    rem = [i for i in avail if i not in pair][0]
                    if p.grid[rem] is None:
                        changes = p.validate_and_set(
                            rem, "x", "AtLeastOneForcing", self.verbose)
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

    # -- Expert tier: witness-sourced (source 3, two-hop chain) ---------------

    def rule_witness_at_most_one_forcing(self, p):
        """_apply_at_most_one_forcing fed only by source 3."""
        at_least_pairs = self._find_at_least_one_pairs(p)
        if not at_least_pairs:
            return 0
        witness_groups = self._derive_at_most_one_groups_from_witness_pairs(p, at_least_pairs)
        if not witness_groups:
            return 0
        return self._apply_at_most_one_forcing(p, witness_groups)

    def rule_witness_disjoint_quota_fill(self, p):
        """_apply_disjoint_quota_fill fed only by source 3."""
        at_least_pairs = self._find_at_least_one_pairs(p)
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
        quota = p.stars_per_unit
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
        quota = p.stars_per_unit
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
