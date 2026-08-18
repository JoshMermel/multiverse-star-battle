"""
rules_multi_star.py

2-star+ rule_* implementations: everything written against an arbitrary
p.stars_per_unit rather than assuming exactly 1 star per row/col/region.
Python port of the "multi-star validated/compatible rules" section of
solver.js. See rules_single_star.py for the 1★-only rules they generalize,
and rules_common.py for the handful of rules shared verbatim by both
families.

multi-star-rules-experiment branch: deliberately stripped down from
main/gh-pages to re-derive the multi-star tier structure from first
principles, then selectively restored by explicit request as testing
progressed. Still cut (the whole at-least-1/at-most-1 abstraction, which
had no remaining consumers once these were cut): rule_clump_*,
rule_witness_* -- superseded by the Tiles/region-line-quota-fill rules,
or judged too hard to explain to a player. Restored:
rule_lookahead_dots(_single_board), rule_region_subset_sync_3/4 (defined
in rules_common.py), rule_unit_completion_satisfies_other_unit_*,
rule_unit_region_sync_multi_2_disjoint, rule_crossboard_n_region_pinned_multi_*,
and rule_lookahead_1/2/3_stage_multi (all three commented out in
composite_scorer.py for performance -- each is a full board-wide
speculative sweep per empty cell, repeated per stage, and got noticeably
slow at 3★+ scale even at 1 stage; rule_lookahead_dots(_single_board)'s
cheaper one-round version stays active). See composite_scorer.py's
multi_star_rules for what's still in play. If this
branch doesn't pan out, `git show gh-pages:tools/scorer/rules_multi_star.py`
has the pre-experiment version.
"""

from itertools import combinations

from board_utils import VOID_CHAR


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

        For cond == 'dots' (and the default/uncond case), forced_dots
        covers BOTH cells inside the unit and cells just outside it, via
        one unified test: is placing a star at a candidate cell
        incompatible with EVERY valid completion? Inside the unit, a cell
        absent from a completion is incompatible with it (starring it
        alongside that completion would overfill the unit's quota);
        outside the unit, a cell is incompatible with a completion if it's
        adjacent (including diagonally) to one of that completion's stars.
        This single test replaces what used to be two separate rules --
        one for inside cells, one for outside cells (the former
        rule_external_dot_from_placements_*) -- since both ask the same
        question, just of different cells. Python port of the unified
        hintUnitPlacementForced in solver-rules-multi.js.
        """
        combo_sets_by_unit = self._get_placement_forced_combos(p, level)
        # 'all_stars'/'any_star' only ever look at forced_stars, so skip the
        # dot-side enumeration entirely for those -- same cost as before this
        # rule absorbed the outside-cell case.
        wants_dots = cond != "all_stars" and cond != "any_star"
        changes = 0
        for unit in p.units:
            stars = sum(1 for i in unit["indices"] if p.grid[i] == "x")
            needed = p.stars_per_unit - stars
            if needed <= 0:
                continue

            completion_sets = combo_sets_by_unit.get(id(unit))
            if not completion_sets:
                continue

            unit_set = set(unit["indices"])
            avail = [i for i in unit["indices"] if p.grid[i] is None]

            # Union across scopes: forced if ANY single scope's combos
            # alone already prove it -- see _unit_completions_by_level.
            forced_stars = [
                c for c in avail if any(all(c in combo for combo in combos) for combos in completion_sets)
            ]
            forced_dots = []

            if wants_dots:
                # Cells just outside the unit: touching one of its cells,
                # not already decided, and not themselves part of the unit.
                outside = set()
                for cell in unit["indices"]:
                    for nb in p._neighbor_map[cell]:
                        if nb not in unit_set and p.grid[nb] is None:
                            outside.add(nb)

                def star_incompatible(cell, combo, unit_set=unit_set):
                    if cell in unit_set:
                        return cell not in combo
                    return any(self._cells_adjacent(p, s, cell) for s in combo)

                forced_dots = [
                    c for c in [*avail, *outside]
                    if any(all(star_incompatible(c, combo) for combo in combos) for combos in completion_sets)
                ]

            if cond == "all_stars":
                if len(forced_stars) != needed: forced_stars = []
            elif cond == "any_star":
                if len(forced_stars) == 0 or len(forced_stars) == needed: forced_stars = []
            elif cond == "dots":
                forced_stars = []

            for idx in forced_stars:
                changes += self._internal_set(p, idx, "x", f"Forced star ({cond})", silent=False)
            for idx in forced_dots:
                changes += self._internal_set(p, idx, ".", f"Forced dot ({cond})", silent=False)

            if changes > 0:
                return changes
        return 0

    # -- Region/line quota fill (2★+) --------------------------------------------
    #
    # A more powerful generalization of the "Rule of Clumps" (region/line-split):
    # instead of the cheap "remainder capped at m stars" heuristic, this asks
    # _get_placement_forced_combos' full placement enumeration directly: across
    # EVERY valid way to place a region's remaining stars, how many of them are
    # guaranteed to land in a given row/column, no matter which valid placement
    # turns out to be real? E.g. a region shaped like [(0,0),(0,1),(0,2),(1,0),
    # (2,0)] with 1 star left has multiple valid placements, but every one of
    # them puts a star somewhere in row 0 AND somewhere in column A -- so this
    # region is worth "at least 1" to each of those lines, even though it isn't
    # confined to either one (unlike the existing trapped/covered sync rules,
    # which require full confinement).
    #
    # A row/column's own quota need is met once enough of these per-region
    # guarantees (found on ONE board's own regions -- this reasoning is
    # deliberately single-board only, never combining regions across boards)
    # add up to exactly what's left. Regions are a strict partition of the
    # board, so distinct regions' guarantees about the same line never double
    # count -- any subset of them sums safely. Once some subset sums to exactly
    # the line's remaining need, every other empty cell in that line (i.e. in
    # regions NOT in that subset) must be a dot: the true solution already has
    # nothing left over for them. (Cells from a CHOSEN region beyond its own
    # counted guarantee stay untouched -- we know the count, not which of the
    # region's cells in the line realizes it.)
    def _region_line_guarantees(self, p, level):
        return self._cached_on_grid(
            p, f'_region_line_guarantees_cache_{level}',
            lambda: self._region_line_guarantees_impl(p, level))

    def _region_line_guarantees_impl(self, p, level):
        """
        Returns {('row', r) | ('col', c): [(board_idx, k, region_unit), ...]}
        -- every region, on any board, that's PROVEN (at the given
        _get_placement_forced_combos level) to place at least k >= 1 of its
        remaining stars in that row/column, regardless of which of its own
        valid completions turns out to be real.
        """
        combo_sets_by_unit = self._get_placement_forced_combos(p, level)
        result = {}
        for unit in p.units:
            if unit["board_idx"] is None:
                continue  # rows/columns aren't a source here, only regions
            completion_sets = combo_sets_by_unit.get(id(unit))
            if not completion_sets:
                continue
            # Regions always resolve to exactly one scope (see
            # _unit_completions_by_level: a region's board_idx is never
            # None, so 'intermediate' also collapses to a single scope).
            combos = completion_sets[0]

            rows_touched = set()
            cols_touched = set()
            for combo in combos:
                for cell in combo:
                    r, c = p.get_rc(cell)
                    rows_touched.add(r)
                    cols_touched.add(c)

            for r in rows_touched:
                k = min(sum(1 for cell in combo if p.get_rc(cell)[0] == r) for combo in combos)
                if k >= 1:
                    result.setdefault(('row', r), []).append((unit["board_idx"], k, unit))
            for c in cols_touched:
                k = min(sum(1 for cell in combo if p.get_rc(cell)[1] == c) for combo in combos)
                if k >= 1:
                    result.setdefault(('col', c), []).append((unit["board_idx"], k, unit))
        return result

    def _find_subset_sum_combo(self, items, target):
        """
        Backtracking search for a sublist of `items` (each (weight, ...))
        whose weights sum EXACTLY to target. Unlike _find_disjoint_group_combo
        (which needs exactly k groups of weight 1 each), a region's guarantee
        can be worth more than 1, so this is a general subset-sum search --
        still cheap since the candidate list is just the regions touching one
        line on one board (at most n of them).
        """
        def backtrack(i, remaining, chosen):
            if remaining == 0:
                return list(chosen)
            if i >= len(items) or remaining < 0:
                return None
            weight = items[i][0]
            if weight <= remaining:
                chosen.append(items[i])
                result = backtrack(i + 1, remaining - weight, chosen)
                if result is not None:
                    return result
                chosen.pop()
            return backtrack(i + 1, remaining, chosen)
        return backtrack(0, target, [])

    def _region_line_quota_fill(self, p, level):
        guarantees = self._region_line_guarantees(p, level)
        for (kind, line_idx), entries in guarantees.items():
            line_indices = p.row_indices[line_idx] if kind == "row" else p.col_indices[line_idx]
            stars = sum(1 for i in line_indices if p.grid[i] == "x")
            needed = p.stars_per_unit - stars
            if needed <= 0:
                continue
            avail = [i for i in line_indices if p.grid[i] is None]
            if not avail:
                continue

            # Never cross-board: group candidate regions by board and search
            # each board's regions independently.
            by_board = {}
            for board_idx, k, unit in entries:
                by_board.setdefault(board_idx, []).append((k, unit))

            for board_idx, board_entries in by_board.items():
                combo = self._find_subset_sum_combo(board_entries, needed)
                if combo is None:
                    continue
                covered = set()
                for _, unit in combo:
                    covered |= set(unit["indices"])
                targets = [i for i in avail if i not in covered]
                if not targets:
                    continue

                label = f"RegionLineQuotaFill({kind} {line_idx}, B{board_idx + 1}, level={level})"
                changes = sum(
                    p.validate_and_set(idx, ".", label, self.verbose) for idx in targets
                )
                if changes > 0:
                    return changes
        return 0

    def rule_region_line_quota_fill_weak(self, p):
        return self._region_line_quota_fill(p, level='weak')

    def rule_region_line_quota_fill_intermediate(self, p):
        return self._region_line_quota_fill(p, level='intermediate')

    def rule_region_line_quota_fill_strong(self, p):
        return self._region_line_quota_fill(p, level='strong')

    # -- Region/line partition trap (2★+) ----------------------------------------
    #
    # A sibling of _region_line_quota_fill above, built on the same per-region,
    # per-line completion tally. That rule splits a region's remaining cells
    # into "in this row/column" and "everywhere else", and asks how many
    # stars are guaranteed on the IN side (to fill the line's own quota).
    # This rule asks the same split's question about EITHER side on its own:
    # whenever a region's cells on one side of that split (in the line, or
    # outside it -- both are checked) are proven to hold at least m >= 1 of
    # the region's stars, no matter which valid completion turns out to be
    # real, any candidate cell (anywhere on the board) that's adjacent to
    # EVERY cell on that side can't be a star: whichever of them ends up
    # holding the guarantee, that candidate would be touching it. m doesn't
    # need to equal the number of cells on that side for this to be useful --
    # e.g. 3 cells guaranteed to jointly hold only 1 star still traps any
    # cell touching all 3, even without knowing which one it'll be.
    #
    # Concretely, per region/line pair, from the same per-combo tally:
    #  - IN-line guarantee: min_in_line = MIN over combos of (cells in the
    #    line) -- the same k _region_line_guarantees_impl computes.
    #  - OUT-of-line guarantee: needed - max_in_line, where max_in_line = MAX
    #    over combos of (cells in the line) -- the complement, since a
    #    completion placing `count` in the line places (needed - count)
    #    outside it, so the guaranteed-outside minimum is needed minus the
    #    guaranteed-inside MAXIMUM.
    # Both are independent, valid "at least m stars among this fixed cell
    # set" facts, so both get the same touches-all-of-them-is-a-dot check.
    # Python port of hintRegionLinePartitionTrapped in solver-rules-multi.js.

    def _region_line_partition_guarantees(self, p, level):
        return self._cached_on_grid(
            p, f'_region_line_partition_guarantees_cache_{level}',
            lambda: self._region_line_partition_guarantees_impl(p, level))

    def _region_line_partition_guarantees_impl(self, p, level):
        """
        Every region/line/side triple, on any board, where the region is
        PROVEN to place at least `guarantee` >= 1 of its remaining stars
        among a fixed set of its own cells (`group_cells`) -- either every
        cell it has in that row/column ('inside'), or every cell it has
        outside it ('outside'). Returns a list of dicts with keys
        board_idx/line_kind/line_idx/side/group_cells/guarantee.
        """
        combo_sets_by_unit = self._get_placement_forced_combos(p, level)
        result = []
        for unit in p.units:
            if unit["board_idx"] is None:
                continue  # rows/columns aren't a source here, only regions
            completion_sets = combo_sets_by_unit.get(id(unit))
            if not completion_sets:
                continue
            # Regions always resolve to exactly one scope (see
            # _unit_completions_by_level).
            combos = completion_sets[0]
            needed = len(combos[0])

            rows_touched = set()
            cols_touched = set()
            for combo in combos:
                for cell in combo:
                    r, c = p.get_rc(cell)
                    rows_touched.add(r)
                    cols_touched.add(c)

            avail = [i for i in unit["indices"] if p.grid[i] is None]

            def try_line(line_kind, line_idx, in_line):
                counts_in_line = [sum(1 for cell in combo if in_line(cell)) for combo in combos]
                min_in_line = min(counts_in_line)
                max_in_line = max(counts_in_line)

                if min_in_line >= 1:
                    inside_cells = [i for i in avail if in_line(i)]
                    if inside_cells:
                        result.append({
                            "board_idx": unit["board_idx"], "line_kind": line_kind, "line_idx": line_idx,
                            "side": "inside", "group_cells": inside_cells, "guarantee": min_in_line,
                        })

                g = needed - max_in_line
                if g >= 1:
                    outside_cells = [i for i in avail if not in_line(i)]
                    # Should be impossible (g >= 1 means every completion
                    # leaves at least one of its own cells outside the
                    # line) but guard anyway.
                    if outside_cells:
                        result.append({
                            "board_idx": unit["board_idx"], "line_kind": line_kind, "line_idx": line_idx,
                            "side": "outside", "group_cells": outside_cells, "guarantee": g,
                        })

            for r in rows_touched:
                try_line("row", r, lambda cell, r=r: p.get_rc(cell)[0] == r)
            for c in cols_touched:
                try_line("col", c, lambda cell, c=c: p.get_rc(cell)[1] == c)
        return result

    def _region_line_partition_trapped(self, p, level):
        for entry in self._region_line_partition_guarantees(p, level):
            group_cells = entry["group_cells"]
            group_set = set(group_cells)
            targets = [
                i for i in range(p.n * p.n)
                if p.grid[i] is None and i not in group_set
                and all(self._cells_adjacent(p, i, cell) for cell in group_cells)
            ]
            if not targets:
                continue
            label = (f"RegionLinePartitionTrapped({entry['side']} of "
                      f"{entry['line_kind']} {entry['line_idx']}, "
                      f"B{entry['board_idx'] + 1}, level={level})")
            changes = sum(p.validate_and_set(idx, ".", label, self.verbose) for idx in targets)
            if changes > 0:
                return changes
        return 0

    def rule_region_line_partition_trapped_weak(self, p):
        return self._region_line_partition_trapped(p, level='weak')

    def rule_region_line_partition_trapped_intermediate(self, p):
        return self._region_line_partition_trapped(p, level='intermediate')

    def rule_region_line_partition_trapped_strong(self, p):
        return self._region_line_partition_trapped(p, level='strong')

    # -- Region/line partition forced star (2★+) ---------------------------------
    #
    # A second sibling reasoning off the same per-region guarantees
    # _region_line_guarantees computes (used by _region_line_quota_fill /
    # _find_subset_sum_combo above), but drawing a different conclusion from
    # the same successful subset-sum match: _region_line_quota_fill uses it
    # to dot every OTHER cell in the line, since the matched regions'
    # guarantees already account for the line's whole remaining need. This
    # rule notices something else that same match implies: since the
    # matched regions' k's already sum EXACTLY to the line's need, none of
    # them can contribute MORE than its own guaranteed k -- that would
    # overshoot the line's actual quota, which is impossible. So each
    # matched region's in-line count is pinned to EXACTLY k, not just "at
    # least k". That pins its remainder too (its own total need minus k), on
    # BOTH sides of the split -- letting each side be reasoned about as its
    # own small local placement problem: how many ways are there to fit
    # exactly that many non-touching stars among just those cells? If every
    # local arrangement agrees on some cell, that cell must be a star. E.g.
    # a "rest" shaped like a P-pentomino needing 2 non-touching stars might
    # only have a couple of valid 2-cell arrangements, all of which happen
    # to include one specific cell.
    #
    # Why ignoring the rest of the board (no capacity checks, no reasoning
    # about which cells the OTHER side's completion touches) is still sound:
    # the true realized arrangement on a side must itself be one of the
    # valid LOCAL ones (adjacency is the only thing that can ever disqualify
    # it), so it's necessarily a MEMBER of the set _forced_cells_in_group
    # enumerates -- a cell common to that whole (possibly larger, since it
    # ignores extra constraints the true arrangement also happens to
    # satisfy) set is common to the true arrangement too. Same principle as
    # 'weak' mode in _enumerate_unit_completions. Python port of
    # hintRegionLinePartitionForced/_forcedCellsInGroup in
    # solver-rules-multi.js.

    def _forced_cells_in_group(self, p, cells, k, existing_stars):
        """
        Every cell in `cells` that appears in EVERY valid way to choose `k`
        mutually non-touching cells from `cells` alone (also not touching
        any of `existing_stars`). Returns [] if there's no valid
        arrangement, or if the valid arrangements don't all agree on any
        cell.
        """
        candidates = [c for c in cells if not any(self._cells_adjacent(p, s, c) for s in existing_stars)]
        if k <= 0 or len(candidates) < k:
            return []

        intersection = None
        chosen = []

        def try_from(start):
            nonlocal intersection
            if intersection is not None and len(intersection) == 0:
                return  # nothing left to narrow
            if len(chosen) == k:
                if intersection is None:
                    intersection = set(chosen)
                else:
                    intersection &= set(chosen)
                return
            if len(candidates) - start < k - len(chosen):
                return
            for i in range(start, len(candidates)):
                cell = candidates[i]
                if any(self._cells_adjacent(p, c, cell) for c in chosen):
                    continue
                chosen.append(cell)
                try_from(i + 1)
                chosen.pop()
                if intersection is not None and len(intersection) == 0:
                    return

        try_from(0)
        return list(intersection) if intersection else []

    def _region_line_partition_forced_facts(self, p, level):
        return self._cached_on_grid(
            p, f'_region_line_partition_forced_facts_cache_{level}',
            lambda: self._region_line_partition_forced_facts_impl(p, level))

    def _region_line_partition_forced_facts_impl(self, p, level):
        """
        Every region/line/side triple, on any board, where a successful
        _region_line_quota_fill-style subset-sum match pins the region's
        split to an exact count and some specific cell is forced across
        every local arrangement of that side's share. Returns a list of
        dicts with keys unit/side/forced_cells/line_count/rest_count.
        """
        guarantees = self._region_line_guarantees(p, level)
        result = []

        for (kind, line_idx), entries in guarantees.items():
            line_indices = p.row_indices[line_idx] if kind == "row" else p.col_indices[line_idx]
            in_line = (
                (lambda cell, r=line_idx: p.get_rc(cell)[0] == r) if kind == "row"
                else (lambda cell, c=line_idx: p.get_rc(cell)[1] == c)
            )

            stars = sum(1 for i in line_indices if p.grid[i] == "x")
            needed = p.stars_per_unit - stars
            if needed <= 0:
                continue
            avail = [i for i in line_indices if p.grid[i] is None]
            if not avail:
                continue

            # Same board grouping as _region_line_quota_fill -- never
            # cross-board (see rule_crossboard_region_line_partition_forced
            # below for that case).
            by_board = {}
            for board_idx, k, unit in entries:
                by_board.setdefault(board_idx, []).append((k, unit))

            for board_idx, board_entries in by_board.items():
                combo = self._find_subset_sum_combo(board_entries, needed)
                if combo is None:
                    continue

                # Every region in this matched combo is now pinned to
                # EXACTLY its own guaranteed k in this line (see the
                # section comment above).
                for k, unit in combo:
                    region_stars = sum(1 for i in unit["indices"] if p.grid[i] == "x")
                    region_needed = p.stars_per_unit - region_stars
                    outside_count = region_needed - k

                    inside_cells = [i for i in unit["indices"] if p.grid[i] is None and in_line(i)]
                    outside_cells = [i for i in unit["indices"] if p.grid[i] is None and not in_line(i)]
                    existing_stars = [i for i in unit["indices"] if p.grid[i] == "x"]

                    if k >= 1:
                        forced = self._forced_cells_in_group(p, inside_cells, k, existing_stars)
                        if forced:
                            result.append({
                                "unit": unit, "side": "inside", "forced_cells": forced,
                                "line_count": k, "rest_count": outside_count,
                            })
                    if outside_count >= 1:
                        forced = self._forced_cells_in_group(p, outside_cells, outside_count, existing_stars)
                        if forced:
                            result.append({
                                "unit": unit, "side": "outside", "forced_cells": forced,
                                "line_count": k, "rest_count": outside_count,
                            })
        return result

    def _region_line_partition_forced(self, p, level):
        # A cell can end up forced via more than one fact (row and column
        # reasoning about the same region can coincide) -- dedupe by the
        # exact forced-cell set.
        seen = set()
        for fact in self._region_line_partition_forced_facts(p, level):
            key = frozenset(fact["forced_cells"])
            if key in seen:
                continue
            seen.add(key)
            label = f"RegionLinePartitionForced({fact['unit']['label']}, {fact['side']}, level={level})"
            changes = sum(
                p.validate_and_set(idx, "x", label, self.verbose) for idx in fact["forced_cells"]
            )
            if changes > 0:
                return changes
        return 0

    def rule_region_line_partition_forced_weak(self, p):
        return self._region_line_partition_forced(p, level='weak')

    def rule_region_line_partition_forced_intermediate(self, p):
        return self._region_line_partition_forced(p, level='intermediate')

    def rule_region_line_partition_forced_strong(self, p):
        return self._region_line_partition_forced(p, level='strong')

    # -- Cross-board region/line quota fill + partition forced (Grandmaster, 2★+) -
    #
    # _region_line_quota_fill and _region_line_partition_forced_facts both
    # deliberately group a line's per-region guarantees BY BOARD before
    # subset-summing, and only ever search within one board's regions at a
    # time (see both functions' "Never cross-board" comments) -- the
    # same-board case is already sound and cheap, so there was no reason to
    # widen the search. This section adds the genuinely cross-board
    # generalization of that same subset-sum match: pool guarantees from
    # EVERY board for a line, and search for a combo that sums to the line's
    # need using regions from more than one board at once. E.g. board 1's
    # region A alone guarantees 1 star in the line, and board 2's region K
    # alone guarantees 1 star in the same line; individually neither covers
    # a needed=2 line, but together they do.
    #
    # This is only sound if the matched regions' remaining cells are
    # pairwise DISJOINT: boards share one physical grid, so a region on
    # board 1 and a region on board 2 can include the very same cell, and
    # summing guarantees across overlapping regions would double-count how
    # many distinct stars are actually still available. Same concern
    # _rule_crossboard_n_region_pinned_multi already handles for the
    # trapped-region-pin rule, via _are_disjoint -- this is the same fix
    # applied to the subset-sum search directly (checked incrementally
    # during the backtracking search below, rather than after the fact).
    #
    # Also requires the winning combo to span >= 2 distinct boards: an
    # all-same-board match would already have been found by the plain
    # per-board versions above, so this only exists to catch the genuinely
    # cross-board case (mirrors _rule_crossboard_n_region_pinned_multi's own
    # "boards_touched < 2: already covered elsewhere" guard).
    #
    # Only built on 'strong'-level guarantees: a region's own "at least k in
    # this line" fact is true regardless of which level computed it (a
    # weaker level just enumerates a superset of completions, so its k is a
    # safe -- if possibly looser -- lower bound), but 'strong' is the level
    # already used by the Expert-tier siblings this generalizes, and
    # cross-board combination is itself the expensive, deep reasoning step
    # that earns the Grandmaster tier -- there's no separate weak/
    # intermediate cross-board tier the way the per-region levels have.

    def _find_crossboard_subset_sum_combo(self, entries, target):
        """
        Like _find_subset_sum_combo, but `entries` are pooled from ALL
        boards (the raw (board_idx, k, unit) tuples _region_line_guarantees
        returns, not grouped by board first), and a valid combo must
        additionally have pairwise-disjoint index sets (checked
        incrementally via `used`) and span at least 2 distinct boards
        (checked once a full-target combo is found).
        """
        def backtrack(i, remaining, chosen, used, boards):
            if remaining == 0:
                return list(chosen) if len(boards) >= 2 else None
            if i >= len(entries) or remaining < 0:
                return None
            board_idx, k, unit = entries[i]
            unit_idxs = set(unit["indices"])
            if k <= remaining and used.isdisjoint(unit_idxs):
                chosen.append(entries[i])
                result = backtrack(i + 1, remaining - k, chosen, used | unit_idxs, boards | {board_idx})
                if result is not None:
                    return result
                chosen.pop()
            return backtrack(i + 1, remaining, chosen, used, boards)
        return backtrack(0, target, [], frozenset(), frozenset())

    def rule_crossboard_region_line_quota_fill(self, p):
        """
        Cross-board generalization of rule_region_line_quota_fill_strong
        (see section comment above): once a cross-board combo of regions'
        guarantees sums exactly to a line's remaining need, every other
        empty cell in that line must be a dot.
        """
        guarantees = self._region_line_guarantees(p, level='strong')
        for (kind, line_idx), entries in guarantees.items():
            line_indices = p.row_indices[line_idx] if kind == "row" else p.col_indices[line_idx]
            stars = sum(1 for i in line_indices if p.grid[i] == "x")
            needed = p.stars_per_unit - stars
            if needed <= 0:
                continue
            avail = [i for i in line_indices if p.grid[i] is None]
            if not avail:
                continue

            combo = self._find_crossboard_subset_sum_combo(entries, needed)
            if combo is None:
                continue

            covered = set()
            boards_used = set()
            for board_idx, _, unit in combo:
                covered |= set(unit["indices"])
                boards_used.add(board_idx)
            targets = [i for i in avail if i not in covered]
            if not targets:
                continue

            boards_label = ", ".join(f"B{b + 1}" for b in sorted(boards_used))
            label = f"CrossBoardRegionLineQuotaFill({kind} {line_idx}, {boards_label})"
            changes = sum(p.validate_and_set(idx, ".", label, self.verbose) for idx in targets)
            if changes > 0:
                return changes
        return 0

    def rule_crossboard_region_line_partition_forced(self, p):
        """
        Cross-board generalization of rule_region_line_partition_forced_strong
        (see section comment above): once a cross-board combo pins a
        region's in-line count to an exact k, its remainder (own quota
        minus k) is pinned too, on both sides of the split -- and either
        side's local placement problem may force a specific cell to be a
        star.
        """
        guarantees = self._region_line_guarantees(p, level='strong')
        seen = set()

        for (kind, line_idx), entries in guarantees.items():
            line_indices = p.row_indices[line_idx] if kind == "row" else p.col_indices[line_idx]
            in_line = (
                (lambda cell, r=line_idx: p.get_rc(cell)[0] == r) if kind == "row"
                else (lambda cell, c=line_idx: p.get_rc(cell)[1] == c)
            )

            stars = sum(1 for i in line_indices if p.grid[i] == "x")
            needed = p.stars_per_unit - stars
            if needed <= 0:
                continue
            avail = [i for i in line_indices if p.grid[i] is None]
            if not avail:
                continue

            combo = self._find_crossboard_subset_sum_combo(entries, needed)
            if combo is None:
                continue

            for board_idx, k, unit in combo:
                region_stars = sum(1 for i in unit["indices"] if p.grid[i] == "x")
                region_needed = p.stars_per_unit - region_stars
                outside_count = region_needed - k

                inside_cells = [i for i in unit["indices"] if p.grid[i] is None and in_line(i)]
                outside_cells = [i for i in unit["indices"] if p.grid[i] is None and not in_line(i)]
                existing_stars = [i for i in unit["indices"] if p.grid[i] == "x"]

                forced_sides = []
                if k >= 1:
                    forced_sides.append(("inside", self._forced_cells_in_group(p, inside_cells, k, existing_stars)))
                if outside_count >= 1:
                    forced_sides.append(("outside", self._forced_cells_in_group(p, outside_cells, outside_count, existing_stars)))

                for side, forced in forced_sides:
                    if not forced:
                        continue
                    key = frozenset(forced)
                    if key in seen:
                        continue
                    seen.add(key)
                    label = f"CrossBoardRegionLinePartitionForced({unit['label']}, {side})"
                    changes = sum(p.validate_and_set(idx, "x", label, self.verbose) for idx in forced)
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

        # Slide a window of size 'n' across the board's units. No "already has
        # a star" pre-filter here (unlike the 1★-only rule_only_empty this was
        # copied from, where any star IS the unit's full quota) -- at
        # stars_per_unit > 1, a unit can hold a star and still need more, and
        # skipping the whole window in that case silently disabled this rule
        # almost immediately on any 2★+ puzzle once a few stars land. The
        # downstream _hint_multi_regions_trapped_or_covered already computes
        # each unit's remaining need correctly (stars placed subtract from
        # its quota, whether that's 0 or more left), so no pre-filter is
        # needed: a fully-solved unit already has nothing left to decide
        # (rule_exclude_solved_unit dots it out well before this Hard-tier
        # rule runs) and contributes 0 to the window's required count either
        # way.
        for start_idx in range(p.n - n + 1):
            window_units = [units[i] for i in range(start_idx, start_idx + n)]

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

    # -- Restored from pre-experiment (2★+) --------------------------------------
    #
    # Three rule families that were cut during the multi-star-rules-experiment
    # stripping pass and later restored by explicit request. (The Clump and
    # Witness at-least-1/at-most-1 families from that same pass stay cut --
    # superseded by the Tiles/region-line-quota-fill rules, or judged too hard
    # to explain to a player, per that decision.)

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

    # -- Cross-board partial overlap (2★+) --------------------------------------
    #
    # Multi-star generalization of rule_crossboard_partial_overlap
    # (rules_single_star.py, 1★ only). Two regions on different boards, each
    # still needing its full stars_per_unit quota (no star placed in either
    # yet), that share almost all their cells: shared = cells common to
    # both regions' shapes, onlyA/onlyB = each region's own leftover cells.
    # Both regions obey the same equation against the SAME shared cells --
    # stars(shared) + stars(onlyA) = stars_per_unit = stars(shared) +
    # stars(onlyB) -- so stars(shared) cancels out and stars(onlyA) always
    # equals stars(onlyB), regardless of what stars_per_unit actually is.
    #
    # If every onlyA cell is ADJACENT to every onlyB cell, any star in
    # onlyA would touch a star in onlyB and vice versa -- so onlyA and
    # onlyB can't both hold a star simultaneously, and since their counts
    # are forced equal, the only value that works is 0 for both. Every
    # onlyA/onlyB cell must be a dot.
    #
    # Note this needs ADJACENCY specifically, not the broader "sees" (same
    # row/column/adjacent) the 1★ version uses: for 1★, two cells in the
    # same row already can't both be stars (a row only ever holds 1), but
    # once stars_per_unit > 1 that's no longer true -- only physical
    # touching is still an unconditional "can't both be stars" fact.
    #
    # Requires >= 2 shared cells, matching solver-rules-single.js's
    # hintPartialOverlap: with only 1 shared cell, "the star is in the
    # shared cells" is just a roundabout way of saying "the star is in
    # this one cell" -- not worth surfacing as its own hint until there's
    # an actual choice among several.

    def rule_crossboard_partial_overlap_multi(self, p):
        for b1, b2 in combinations(range(p.n_boards), 2):
            unsolved_b1 = [c for c, idxs in p.regions[b1].items()
                           if not any(p.grid[i] == "x" for i in idxs)]
            unsolved_b2 = [c for c, idxs in p.regions[b2].items()
                           if not any(p.grid[i] == "x" for i in idxs)]

            for r1_char in unsolved_b1:
                r1_avail = {i for i in p.regions[b1][r1_char] if p.grid[i] is None}
                if not r1_avail:
                    continue
                for r2_char in unsolved_b2:
                    r2_avail = {i for i in p.regions[b2][r2_char] if p.grid[i] is None}
                    if not r2_avail:
                        continue
                    shared = r1_avail & r2_avail
                    if len(shared) < 2:
                        continue
                    only_a = r1_avail - r2_avail
                    only_b = r2_avail - r1_avail
                    # Both sides must be non-empty: if one region's cells
                    # are a strict subset of the other's (only_a or only_b
                    # empty), the all()-over-empty-cross-product below is
                    # vacuously true, which would fire with no adjacency
                    # actually checked. That degenerate case is real (a
                    # region strictly contained in a same-quota region
                    # forces the outer region's extra cells to be dots
                    # too), but it's a different, simpler argument than
                    # this rule's -- not this rule's job to claim credit
                    # for it via a vacuous pass.
                    if not only_a or not only_b:
                        continue
                    disjoint = only_a | only_b
                    if not all(self._cells_adjacent(p, a, b) for a in only_a for b in only_b):
                        continue
                    changes = sum(
                        p.validate_and_set(
                            idx, ".",
                            f"Cross-board partial overlap (multi) "
                            f"B{b1 + 1}:{r1_char}/B{b2 + 1}:{r2_char}",
                            self.verbose)
                        for idx in disjoint if p.grid[idx] is None
                    )
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

    # -- Multi-stage lookahead (2★+, restored from pre-experiment) --------------
    #
    # 2★+ analogue of rules_single_star.py's rule_lookahead_1/2/3_stage. For
    # each empty cell, hypothetically place a star there and repeatedly
    # propagate quota-aware consequences -- adjacency dots, unit-solved
    # dots, and forced-star fills -- placing any newly-implied stars and
    # dots each round, for n_stages rounds. If a contradiction results, that
    # cell must be a dot. Unlike rule_lookahead_dots(_single_board) (which
    # only ever applies ONE round of direct consequences), this repeats the
    # propagation, so it can catch contradictions several steps removed from
    # the speculative placement -- at real computational cost, hence
    # Grandmaster tier. All three stages are commented out in
    # composite_scorer.py's multi_star_rules for performance (even 1-stage
    # got noticeably slow at 3★+ scale) -- the same cost shows up in the JS
    # hint UI's lookaheadLoop1/2/3/8, also commented out there, see
    # solver-rules-multi.js's _getMultiStarRuleList. Kept for 1★
    # (rules_single_star.py's rule_lookahead_1/2/3_stage) and available here
    # if this gets revisited.

    def rule_lookahead_1_stage_multi(self, p):
        return self._lookahead_n_stages_multi(p, n_stages=1)

    def rule_lookahead_2_stages_multi(self, p):
        return self._lookahead_n_stages_multi(p, n_stages=2)

    def rule_lookahead_3_stages_multi(self, p):
        # High stage count runs propagation to a fixed point; "3" is a
        # minimum depth, not an exact count. Mirrors rule_lookahead_3_stages.
        return self._lookahead_n_stages_multi(p, n_stages=10)

    def _lookahead_n_stages_multi(self, p, n_stages):
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

    # -- Symmetry rules (2★+) ---------------------------------------------------
    #
    # Generalizes SingleStarRules' symmetry-fill / diagonal-symmetry /
    # rotation-180 / diagonal-parity rules (rules_single_star.py) to any
    # stars_per_unit. Symmetry detection itself (p.diagonal_symmetries,
    # p.has_main_diagonal_symmetry, p.has_anti_diagonal_symmetry,
    # p.has_internal_rotation_180, p.has_crossboard_rotation_180) is purely
    # about REGION geometry (puzzle.py), so it's already quota-agnostic and
    # reused unchanged.
    #
    # The fill rules (rule_main_diagonal_fill / rule_anti_diagonal_fill /
    # rule_rotation_180_fill, both defined in SingleStarRules) are reused
    # UNCHANGED in multi_star_rules (composite_scorer.py) rather than
    # duplicated here: copying a known star/dot to its symmetric
    # counterpart is a property of the transform, not of quota, so they
    # already work correctly for any stars_per_unit.
    #
    # The "seeing your own mirror image forces a dot" rules need real
    # generalization, though: for 1★, i and mirror(i) sharing any unit
    # (row/col/region) is ALWAYS a contradiction if both were stars (every
    # unit's quota is 1). For k★, sharing a unit is only a contradiction if
    # that specific unit's remaining need is <= 1 -- if it's still >= 2,
    # both i and mirror(i) can perfectly well be stars in the same unit.
    # _cells_incompatible below captures exactly that (plus the
    # always-true adjacency case), and both the diagonal-symmetry/
    # rotation-180 "can't be a star" rules and diagonal-parity's "mutual
    # visibility" argument are rebuilt on top of it.

    def _cells_incompatible(self, p, a, b):
        """
        Whether cells a and b can never both be stars simultaneously:
        either they're adjacent (always illegal, independent of quota), or
        they share a row/column/region (any board) whose remaining need is
        <= 1 (that unit has room for at most 1 more star, so it can't
        absorb both). A pairwise check -- doesn't account for what OTHER
        cells might also want to be stars -- used to test whether a small
        cell set's "at most 1 of these can be a star" claim still holds
        once stars_per_unit > 1.
        """
        if b in p._neighbor_map[a]:
            return True
        ra, ca = p.get_rc(a)
        rb, cb = p.get_rc(b)
        if ra == rb:
            remaining = p.stars_per_unit - sum(1 for idx in p.row_indices[ra] if p.grid[idx] == "x")
            if remaining <= 1:
                return True
        if ca == cb:
            remaining = p.stars_per_unit - sum(1 for idx in p.col_indices[ca] if p.grid[idx] == "x")
            if remaining <= 1:
                return True
        for b_idx in range(p.n_boards):
            reg_char = p.cell_to_region[b_idx][a]
            if reg_char != VOID_CHAR and p.cell_to_region[b_idx][b] == reg_char:
                reg_indices = p.regions[b_idx][reg_char]
                remaining = p.stars_per_unit - sum(1 for idx in reg_indices if p.grid[idx] == "x")
                if remaining <= 1:
                    return True
        return False

    def rule_diagonal_symmetry_multi(self, p):
        if not p.diagonal_symmetries:
            return 0
        changes = 0
        for i in range(p.n * p.n):
            if p.grid[i] is not None:
                continue
            for fn in p.diagonal_symmetries:
                mirror = fn(i)
                if mirror == i:
                    continue
                if self._cells_incompatible(p, i, mirror):
                    changes += p.validate_and_set(i, ".", "DiagonalSymmetryMulti", self.verbose)
                    break
        return changes

    def rule_rotation_180_multi(self, p):
        if not (p.has_internal_rotation_180 or p.has_crossboard_rotation_180):
            return 0
        total = p.n * p.n
        changes = 0
        for i in range(total):
            if p.grid[i] is not None:
                continue
            mirror = total - 1 - i
            if mirror == i:
                continue
            if self._cells_incompatible(p, i, mirror):
                changes += p.validate_and_set(i, ".", "Rotation180Multi", self.verbose)
        return changes

    def rule_diagonal_parity_multi(self, p):
        """
        MATCH: puzzle has diagonal symmetry AND either: the diagonal has 1
        empty cell (parity determines its value, using a stars_per_unit-
        aware total -- n rows * stars_per_unit stars overall, not n); or
        parity is already satisfied and every pair of empty diagonal cells
        is pairwise incompatible (_cells_incompatible) -- meaning at most 1
        could be a star, and adding exactly 1 would break parity, so all
        must be dots. (Adding 2+ would preserve parity, which is why this
        only fires when the pairwise-incompatible bound is <= 1 -- for 1★
        that's every case where any two diagonal empties share a unit, but
        for k★ some pairs may legitimately coexist, so this fires less
        often than the 1★ version by design.)
        ACTION: sets the cell(s) accordingly.
        """
        n = p.n
        total_stars = n * p.stars_per_unit
        changes = 0

        def try_diag(diag_indices, label):
            nonlocal changes
            stars = sum(1 for i in diag_indices if p.grid[i] == "x")
            empties = [i for i in diag_indices if p.grid[i] is None]

            if len(empties) == 1:
                need_star = (stars % 2) != (total_stars % 2)
                val = "x" if need_star else "."
                changes += p.validate_and_set(
                    empties[0], val,
                    f"DiagonalParityMulti({label})", self.verbose)

            elif len(empties) >= 2:
                if (stars % 2) != (total_stars % 2):
                    return
                if not all(
                    self._cells_incompatible(p, a, b)
                    for idx_a, a in enumerate(empties)
                    for b in empties[idx_a + 1:]
                ):
                    return
                for idx in empties:
                    changes += p.validate_and_set(
                        idx, ".",
                        f"DiagonalParityMulti({label}) mutual-incompatibility",
                        self.verbose)

        if p.has_main_diagonal_symmetry:
            main_diag = [k * n + k for k in range(n)]
            try_diag(main_diag, "main")
            if changes > 0:
                return changes

        if p.has_anti_diagonal_symmetry:
            anti_diag = [k * n + (n - 1 - k) for k in range(n)]
            try_diag(anti_diag, "anti")
            if changes > 0:
                return changes

        return 0

    # -- Tiles (2★+, multi-star-rules-experiment) ------------------------------
    #
    # A "tile" is the set of currently-empty cells within some 2x2-bounded
    # box: two adjacent rows (or columns) times two adjacent columns (or
    # rows). Every pair of cells inside a 2x2 box touches (orthogonally or
    # diagonally), so a tile can NEVER hold more than 1 star, regardless of
    # which of its up to 4 cells are actually still empty.
    #
    # A pair of adjacent rows (or columns) -- a "band" -- still needing K
    # more stars can sometimes have its empties exactly partitioned into K
    # disjoint tiles (a "tiling"). Since each tile holds at most 1 star and
    # there are exactly K of them for K needed stars, pigeonhole forces
    # EVERY tile in that tiling to hold EXACTLY 1 star -- not just "at
    # most". A band can have more than one way to tile its empties into K
    # boxes (an isolated empty column can pair with either neighbor), so
    # multiple tilings -- and hence multiple "confirmed" (exactly-1-star)
    # tiles -- can coexist for the same band.
    #
    # Tilings are board-agnostic (row/column geometry, not regions), so
    # they're computed once per grid state and reused by every board and
    # every rule below. rule_tile_* is intentionally just three small
    # consumers of one shared _confirmed_tiles() fact base -- more
    # inferences from the same tiles are expected to show up later; add
    # them as their own rule_tile_* function rather than folding into an
    # existing one, so a hint always traces back to exactly one idea.

    def _find_tilings(self, has_empty, offset=0):
        """
        All ways to partition columns [offset, len(has_empty)) into
        untouched singletons (only where NOT has_empty) and adjacent pairs
        ("boxes", each covering at least one has_empty column), such that
        every has_empty position ends up inside exactly one box. Returns a
        list of tilings, each a list of box start-column ints. A run of
        has_empty columns can tile more than one way (an isolated has_empty
        column can pair with either neighbor), so this can return several
        tilings for the same has_empty pattern -- that's the point.
        """
        n = len(has_empty)
        if offset == n:
            return [[]]
        results = []
        if not has_empty[offset]:
            results.extend(self._find_tilings(has_empty, offset + 1))
        if offset + 1 < n and (has_empty[offset] or has_empty[offset + 1]):
            for rest in self._find_tilings(has_empty, offset + 2):
                results.append([offset] + rest)
        return results

    def _confirmed_tiles(self, p):
        return self._cached_on_grid(p, '_confirmed_tiles_cache', lambda: self._confirmed_tiles_impl(p))

    def _confirmed_tiles_impl(self, p):
        """
        Every confirmed (guaranteed exactly 1 star) tile on the board, as a
        set of frozensets of cell indices. Deduped: the same physical 2x2
        square can be confirmed via more than one tiling, or via both a
        row-band and a column-band view of it -- callers only care about
        the distinct cell-sets, not how many ways each was found.

        Coordinates are computed directly (r*n+c / c*n+r), NOT via
        p.row_indices/col_indices -- those exclude void cells, which would
        silently shift column positions out of alignment with the band's
        other line.
        """
        n = p.n
        quota = p.stars_per_unit
        tiles = set()

        for axis in ("row", "col"):
            for u in range(n - 1):
                if axis == "row":
                    line_a = [u * n + c for c in range(n)]
                    line_b = [(u + 1) * n + c for c in range(n)]
                else:
                    line_a = [c * n + u for c in range(n)]
                    line_b = [c * n + (u + 1) for c in range(n)]

                band_indices = [i for i in line_a + line_b if i not in p.void_cells]
                stars_in_band = sum(1 for i in band_indices if p.grid[i] == "x")
                k = 2 * quota - stars_in_band
                if k <= 0:
                    continue

                def is_empty(i):
                    return i not in p.void_cells and p.grid[i] is None

                has_empty = [is_empty(line_a[c]) or is_empty(line_b[c]) for c in range(n)]

                for tiling in self._find_tilings(has_empty):
                    if len(tiling) != k:
                        continue
                    for box_start in tiling:
                        a1, b1 = line_a[box_start], line_b[box_start]
                        a2, b2 = line_a[box_start + 1], line_b[box_start + 1]
                        cells = frozenset(i for i in (a1, b1, a2, b2) if is_empty(i))
                        if cells:
                            tiles.add(cells)
        return tiles

    def rule_tile_single_empty(self, p):
        """
        Rule 1 (Medium): a confirmed tile (guaranteed exactly 1 star) with
        only 1 empty cell means that cell IS the star.
        """
        for tile in self._confirmed_tiles(p):
            if len(tile) != 1:
                continue
            idx = next(iter(tile))
            changes = p.validate_and_set(idx, "x", "TileSingleEmpty", self.verbose)
            if changes > 0:
                return changes
        return 0

    def rule_tile_two_empty_dot(self, p):
        """
        Rule 2 (Hard): a confirmed tile with exactly 2 empty cells (always
        mutually touching, since every pair of cells in a 2x2 box touches)
        holds exactly 1 star, at one of those two cells -- whichever it
        turns out to be. Any OTHER cell touching BOTH of them would touch
        that star no matter which of the two it ends up being, so it must
        be a dot.
        """
        for tile in self._confirmed_tiles(p):
            if len(tile) != 2:
                continue
            a, b = tile
            targets = [
                i for i in p._neighbor_map[a]
                if i in p._neighbor_map[b] and i not in tile and p.grid[i] is None
            ]
            if not targets:
                continue
            changes = sum(
                p.validate_and_set(idx, ".", "TileTwoEmptyDot", self.verbose)
                for idx in targets
            )
            if changes > 0:
                return changes
        return 0

    def _find_disjoint_tile_combo(self, tiles, k):
        """Backtracking search for k mutually disjoint tiles among `tiles`."""
        def backtrack(start, chosen, used):
            if len(chosen) == k:
                return list(chosen)
            for idx in range(start, len(tiles)):
                t = tiles[idx]
                if used & t:
                    continue
                result = backtrack(idx + 1, chosen + [t], used | t)
                if result is not None:
                    return result
            return None
        return backtrack(0, [], frozenset())

    def _tile_quota_fill(self, p, want_single):
        """
        Shared by rule_tile_quota_fill_single (Hard, K=1) and
        rule_tile_disjoint_quota_fill (Expert, K>1): for a row/column/region
        (any board) needing K more stars, if K mutually disjoint confirmed
        tiles are all subsets of its remaining empties, those tiles
        collectively account for all K stars -- so every other empty cell in
        the unit must be a dot. want_single restricts to K==1 (a single tile
        already covers the unit's whole remaining need -- a much smaller ask
        than combining several disjoint tiles at once, hence the lower tier)
        vs K>1 for the general case.
        """
        all_tiles = list(self._confirmed_tiles(p))
        for unit in p.units:
            stars = sum(1 for i in unit["indices"] if p.grid[i] == "x")
            k = p.stars_per_unit - stars
            if k <= 0:
                continue
            if want_single and k != 1:
                continue
            if not want_single and k <= 1:
                continue
            avail = set(i for i in unit["indices"] if p.grid[i] is None)
            if len(avail) <= k:
                continue

            relevant = [t for t in all_tiles if t <= avail]
            if len(relevant) < k:
                continue

            combo = self._find_disjoint_tile_combo(relevant, k)
            if combo is None:
                continue

            covered = set().union(*combo)
            targets = [i for i in avail if i not in covered]
            if not targets:
                continue

            label = f"TileQuotaFill({unit['label']}, K={k})"
            changes = sum(
                p.validate_and_set(idx, ".", label, self.verbose) for idx in targets
            )
            if changes > 0:
                return changes
        return 0

    def rule_tile_quota_fill_single(self, p):
        """Rule 3a (Hard): the K=1 special case -- see _tile_quota_fill."""
        return self._tile_quota_fill(p, want_single=True)

    def rule_tile_disjoint_quota_fill(self, p):
        """Rule 3b (Expert): the general K>1 case -- see _tile_quota_fill."""
        return self._tile_quota_fill(p, want_single=False)

    # -- Lookahead-dots (2★+, restored from pre-experiment) ---------------------
    #
    # The multi-star analogue of the 1★ lookahead rules in
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
