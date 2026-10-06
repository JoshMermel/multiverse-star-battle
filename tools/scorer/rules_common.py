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

    # -- Region subset, matched by capacity ---------------------------------------
    #
    # A region's capacity is how many stars it still needs. What a player
    # notices is "these cells are all inside that region, and both still need
    # the same number of stars", so the star count itself doesn't change the
    # tier:
    #   Hard   : one region needing K stars sits inside another region
    #            needing K stars, for any K.
    #   Expert : a region OR a PAIR of regions (two on one board) needing K
    #            stars sits inside another region or pair needing K stars.
    #            At least one side is a pair (single-in-single is Hard);
    #            groups of 3+ regions are not considered.
    # Either way the outer combo's cells outside the inner one are dots: all
    # K of the outer combo's stars must come from the inner combo's cells.
    # Combos may be on different boards (the boards share one solution).
    # Python port of hintRegionSubsetHard/Expert in solver-rules-common.js.
    # Replaced the K-indexed rule_region_subset_sync_1..4; at 2★ nearly
    # tier-neutral (2 of ~8,000 puzzles move), at 3★ ~70% of Expert -> Hard.

    def _region_capacity_combos(self, p, max_size):
        combos = []
        for b_idx in range(p.n_boards):
            needing = p.get_regions_needing_stars(b_idx)
            for size in range(1, max_size + 1):
                for combo in combinations(needing, size):
                    combos.append({
                        "k": sum(e["remaining"] for e in combo),
                        "regions": [e["unit"] for e in combo],
                        # Only still-open cells matter: a star already placed
                        # elsewhere isn't part of "where can the remaining
                        # stars go".
                        "indices": {i for e in combo for i in e["unit"]["indices"] if p.grid[i] is None},
                    })
        return combos

    def _rule_region_subset_by_capacity(self, p, max_size, require_pair, name):
        combos = self._region_capacity_combos(p, max_size)
        for a in combos:
            for b in combos:
                if a is b or a["k"] != b["k"]:
                    continue
                if require_pair and len(a["regions"]) == 1 and len(b["regions"]) == 1:
                    continue
                if not a["indices"] <= b["indices"]:
                    continue
                targets = [i for i in b["indices"] if i not in a["indices"]]
                if not targets:
                    continue
                label = "{}({} ⊆ {})".format(
                    name,
                    ",".join(r["label"].split(" ")[-1] for r in a["regions"]),
                    ",".join(r["label"].split(" ")[-1] for r in b["regions"]),
                )
                changes = sum(p.validate_and_set(i, ".", label, self.verbose) for i in targets)
                if changes > 0:
                    return changes
        return 0

    def rule_region_subset_hard(self, p):
        return self._rule_region_subset_by_capacity(p, 1, False, "RegionSubsetHard")

    def rule_region_subset_expert(self, p):
        return self._rule_region_subset_by_capacity(p, 2, True, "RegionSubsetExpert")

    # -- Region-pair placement forced ------------------------------------------
    #
    # unit_placement_forced's weak (adjacency-only) enumeration, applied to a
    # synthetic "hybrid region": the union of two unfinished regions on the
    # same board that share at least one orthogonal edge. Every way to place
    # the pair's COMBINED remaining stars anywhere in the union (pure union --
    # each constituent region's own quota is deliberately NOT enforced, so
    # e.g. both of a 1★ pair's stars may land in the same region) is
    # enumerated; a cell in no placement, or a cell just outside the union
    # touching a star of every placement, becomes a dot, and a cell in every
    # placement becomes a star. Single-board only, never cross-board. Pairs
    # whose enumeration would exceed ENUMERATION_COMBO_CAP are skipped (the
    # enumerator returns None for them).
    def _touching_region_pairs(self, p, board_idx):
        cache = getattr(p, "_touching_region_pairs_cache", None)
        if cache is None:
            cache = p._touching_region_pairs_cache = {}
        if board_idx not in cache:
            regions = [u for u in p.units if u["board_idx"] == board_idx]
            owner = {}
            for u in regions:
                for i in u["indices"]:
                    owner[i] = u["label"]
            by_label = {u["label"]: u for u in regions}
            pairs = set()
            for i, lab in owner.items():
                r, c = p.get_rc(i)
                for rr, cc in ((r + 1, c), (r, c + 1)):
                    if rr >= p.n or cc >= p.n:
                        continue
                    other = owner.get(rr * p.n + cc)
                    if other is not None and other != lab:
                        pairs.add(tuple(sorted((lab, other))))
            cache[board_idx] = [(by_label[a], by_label[b]) for a, b in sorted(pairs)]
        return cache[board_idx]

    def rule_region_pair_placement_forced(self, p):
        for b_idx in range(p.n_boards):
            if p.regionless_boards[b_idx]:
                continue
            for ua, ub in self._touching_region_pairs(p, b_idx):
                need_a = p.stars_per_unit - sum(1 for i in ua["indices"] if p.grid[i] == "x")
                need_b = p.stars_per_unit - sum(1 for i in ub["indices"] if p.grid[i] == "x")
                if need_a <= 0 or need_b <= 0:
                    continue
                union = {
                    "indices": ua["indices"] + ub["indices"],
                    "label": f"{ua['label']}+{ub['label']}",
                    "board_idx": b_idx,
                }
                # Weak enumeration depends only on the union's own cells, so
                # cache on exactly that state.
                enum_cache = getattr(p, "_region_pair_combos_cache", None)
                if enum_cache is None:
                    enum_cache = p._region_pair_combos_cache = {}
                key = (union["label"], tuple(p.grid[i] for i in union["indices"]))
                if key not in enum_cache:
                    enum_cache[key] = self._enumerate_unit_completions(
                        p, union, strong=False, quota=2 * p.stars_per_unit)
                combos = enum_cache[key]
                if not combos:
                    continue  # over cap (None) or contradiction ([]) -- leave to other rules
                union_set = set(union["indices"])
                avail = [i for i in union["indices"] if p.grid[i] is None]
                outside = {
                    nb for cell in union["indices"] for nb in p._neighbor_map[cell]
                    if nb not in union_set and p.grid[nb] is None
                }
                forced_stars = [c for c in avail if all(c in combo for combo in combos)]
                forced_dots = [c for c in avail if not any(c in combo for combo in combos)]
                forced_dots += [
                    c for c in outside
                    if all(any(self._cells_adjacent(p, s, c) for s in combo) for combo in combos)
                ]
                label = f"RegionPairPlacementForced({union['label']})"
                changes = 0
                for idx in forced_stars:
                    changes += p.validate_and_set(idx, "x", label, self.verbose)
                for idx in forced_dots:
                    changes += p.validate_and_set(idx, ".", label, self.verbose)
                if changes > 0:
                    return changes
        return 0

    # -- Region algebra --------------------------------------------------------
    #
    # Two DISJOINT units A, B on the same board -- each a row, a column, or
    # a region -- jointly hold 2N stars. If some OTHER unit C (any row, column,
    # or region, other than A/B themselves) has all of its non-dot cells
    # inside A∪B (and reaches into both A and B), then all N of C's stars lie
    # in A∪B, so the remainder R = (A∪B) \ C holds exactly N stars. R is then
    # reasoned about like a region of its own:
    #  - R already has its N stars: every other empty cell of R is a dot.
    #  - 1★: "sees too much" on R -- a cell outside R that sees (same
    #    row/column, or adjacent) every candidate of R is a dot; a lone
    #    candidate is a star.
    #  - 2★+: the weak (adjacency-only) placement enumeration on R as a
    #    synthetic unit with quota N: cells in no placement or touching a
    #    star of every placement are dots, cells in every placement are stars.
    #
    # A/B used to be restricted to "two regions on one board" (with C then
    # required to be a row/column or a region on a DIFFERENT board, so it
    # wouldn't just be a third region of that same board). Generalized so A
    # and B can be any disjoint pair of units at all -- e.g. two rows, or a
    # row and a region -- which also means there's no longer a single "home
    # board" to exclude C from; C only has to be a different unit than A/B.
    # Two REGIONS must still share a board, though (2026-09-29, user's
    # call): regions from different boards are never added together. A
    # row/column is on every board, so it pairs with anything.
    #
    # Finding (A, B) by testing every disjoint PAIR of units up front doesn't
    # scale -- it's O(units^2 * units) and measured at ~90ms/call on a
    # 25x25/6★ board (vs ~0.06ms for the original one-board-of-regions
    # search). Instead this iterates C first, exactly like the original did
    # (which built a single-valued cell->region `owner` map, since regions
    # partition a board): for C's FIRST live cell, try each unit touching it
    # as A (a cell's row, column, and one region per board -- a small, fixed
    # list via p.units_by_cell, not a single owner anymore since a cell can
    # belong to several candidate units at once); then require every
    # remaining live cell to share one common OTHER unit, which must be B.
    # That's the whole candidate set for this C, found in time proportional
    # to C's own cell count rather than the total unit count -- measured at
    # ~0.3ms/call on the same 25x25/6★ board, matching the original's cost
    # profile.
    # Matches hintRegionAlgebra in solver-rules-common.js.
    def rule_region_algebra(self, p):
        N = p.stars_per_unit
        for c_unit in p.units:
            live = [i for i in c_unit["indices"] if p.grid[i] != "."]
            if len(live) < 2:
                continue
            first_candidates = [u for u in p.units_by_cell[live[0]] if u is not c_unit]
            for ua in first_candidates:
                a_set = set(ua["indices"])
                remaining = [i for i in live[1:] if i not in a_set]
                if not remaining:
                    continue  # B would never be touched
                b_candidates = None
                for i in remaining:
                    cands = {id(u): u for u in p.units_by_cell[i] if u is not c_unit and u is not ua}
                    b_candidates = cands if b_candidates is None else {
                        k: v for k, v in b_candidates.items() if k in cands
                    }
                    if not b_candidates:
                        break
                if not b_candidates:
                    continue
                for ub in b_candidates.values():
                    b_set = set(ub["indices"])
                    if a_set & b_set:
                        continue
                    # A and B must be on the same board: two regions from
                    # different boards are never added together. A row/column
                    # (board_idx None) is on every board, so it pairs with
                    # anything. Matches solver-rules-common.js.
                    if (ua["board_idx"] is not None and ub["board_idx"] is not None
                            and ua["board_idx"] != ub["board_idx"]):
                        continue
                    c_set = set(c_unit["indices"])
                    rem = [i for i in ua["indices"] + ub["indices"] if i not in c_set]
                    label = f"RegionAlgebra({ua['label']}+{ub['label']}-{c_unit['label']})"
                    have = sum(1 for i in rem if p.grid[i] == "x")
                    avail = [i for i in rem if p.grid[i] is None]
                    if not avail:
                        continue
                    if have >= N:
                        changes = sum(p.validate_and_set(i, ".", label, self.verbose) for i in avail)
                        if changes:
                            return changes
                        continue
                    if N == 1:
                        # 1★: "sees too much" on R -- a star anywhere that
                        # sees (same row/column or adjacent) every candidate
                        # of R would leave R with no star.
                        rem_set = set(rem)
                        changes = 0
                        if len(avail) == 1:
                            changes += p.validate_and_set(avail[0], "x", label, self.verbose)
                        for i in range(p.n * p.n):
                            if p.grid[i] is None and i not in rem_set and all(
                                    self._cells_see_each_other(p, i, c) for c in avail):
                                changes += p.validate_and_set(i, ".", label, self.verbose)
                        if changes:
                            return changes
                        continue
                    r_unit = {"indices": rem, "label": label, "board_idx": None}
                    combos = self._enumerate_unit_completions(p, r_unit, strong=False, quota=N)
                    if not combos:
                        continue
                    rem_set = set(rem)
                    outside = {
                        nb for cell in rem for nb in p._neighbor_map[cell]
                        if nb not in rem_set and p.grid[nb] is None
                    }
                    forced_stars = [c for c in avail if all(c in combo for combo in combos)]
                    forced_dots = [c for c in avail if not any(c in combo for combo in combos)]
                    forced_dots += [
                        c for c in outside
                        if all(any(self._cells_adjacent(p, s, c) for s in combo) for combo in combos)
                    ]
                    changes = 0
                    for idx in forced_stars:
                        changes += p.validate_and_set(idx, "x", label, self.verbose)
                    for idx in forced_dots:
                        changes += p.validate_and_set(idx, ".", label, self.verbose)
                    if changes > 0:
                        return changes
        return 0

    # -- Partial subset + partial union-subset ---------------------------------
    #
    # Region subset (rule_region_subset_hard/expert, above) needs both sides
    # to need the SAME number of stars, so the leftover is all dots. These two
    # rules drop that restriction. If every open cell of A lies inside B, and A
    # needs fewer stars than B, then all of A's stars are among B's, so the
    # leftover R = B \ A holds EXACTLY need(B) - need(A) stars. R is then
    # reasoned about like a synthetic region with that quota, using the same
    # deduction as rule_region_algebra: the weak (adjacency-only) placement
    # enumeration -- cells in no placement or touching a star of every
    # placement are dots, cells in every placement are stars.
    #
    #  - rule_partial_subset (Hard): A and B are each a single unit (row,
    #    column or region -- regions from either board, since the boards
    #    share one solution).
    #  - rule_partial_subset_union (Expert): the same with a side that is a
    #    UNION of two disjoint units: pair-in-single, single-in-pair or
    #    pair-in-pair, quotas summed. Two regions are only ever added together
    #    on the same board (matching region algebra); a row/column pairs with
    #    anything. A pair never shares a member with the other side (that
    #    reduces to a plain partial subset).
    #
    # Only OPEN cells count, and "needs" are remaining needs, so a star
    # already placed inside A or B just lowers the quota. Equal needs are left
    # to the region-subset rules; this only fires for need(A) < need(B).

    def _open_unit_masks(self, p):
        """[(unit, open-cell bitmask, remaining need)] for every unit that
        still needs stars and has at least that many open cells."""
        N = p.stars_per_unit
        out = []
        for u in p.units:
            need = N
            mask = 0
            n_open = 0
            for i in u["indices"]:
                v = p.grid[i]
                if v is None:
                    mask |= 1 << i
                    n_open += 1
                elif v == "x":
                    need -= 1
            if need > 0 and n_open >= need:
                out.append((u, mask, need))
        return out

    def _synthetic_region_deduce(self, p, rem_cells, quota, label):
        """Forced stars/dots from R = rem_cells (all open) holding exactly
        `quota` stars. Returns the number of cells changed."""
        if len(rem_cells) < quota:
            return 0
        r_unit = {"indices": rem_cells, "label": label, "board_idx": None}
        combos = self._enumerate_unit_completions(p, r_unit, strong=False, quota=quota)
        if not combos:
            return 0
        rem_set = set(rem_cells)
        outside = {
            nb for cell in rem_cells for nb in p._neighbor_map[cell]
            if nb not in rem_set and p.grid[nb] is None
        }
        forced_stars = [c for c in rem_cells if all(c in combo for combo in combos)]
        forced_dots = [c for c in rem_cells if not any(c in combo for combo in combos)]
        forced_dots += [
            c for c in outside
            if all(any(self._cells_adjacent(p, s, c) for s in combo) for combo in combos)
        ]
        changes = 0
        for idx in forced_stars:
            changes += p.validate_and_set(idx, "x", label, self.verbose)
        for idx in forced_dots:
            changes += p.validate_and_set(idx, ".", label, self.verbose)
        return changes

    @staticmethod
    def _mask_cells(mask):
        cells = []
        while mask:
            low = mask & -mask
            cells.append(low.bit_length() - 1)
            mask ^= low
        return cells

    def rule_partial_subset(self, p):
        infos = self._open_unit_masks(p)
        tried = set()
        for ub, mb, kb in infos:
            for ua, ma, ka in infos:
                if ka >= kb or ma & ~mb or ma == mb:
                    continue
                rmask = mb & ~ma
                key = (rmask, kb - ka)
                if key in tried:
                    continue
                tried.add(key)
                label = f"PartialSubset({ua['label']} ⊆ {ub['label']})"
                changes = self._synthetic_region_deduce(p, self._mask_cells(rmask), kb - ka, label)
                if changes:
                    return changes
        return 0

    def rule_partial_subset_union(self, p):
        infos = self._open_unit_masks(p)
        if len(infos) < 2:
            return 0

        def compatible(x, y):
            ux, mx, _ = x
            uy, my, _ = y
            if mx & my:
                return False
            return not (ux["board_idx"] is not None and uy["board_idx"] is not None
                        and ux["board_idx"] != uy["board_idx"])

        # Candidate sides: (member indices, union mask, summed need, label).
        singles = [((k,), m, kk, u["label"]) for k, (u, m, kk) in enumerate(infos)]
        pairs = []
        for a in range(len(infos)):
            for b in range(a + 1, len(infos)):
                if compatible(infos[a], infos[b]):
                    pairs.append(((a, b), infos[a][1] | infos[b][1], infos[a][2] + infos[b][2],
                                  f"{infos[a][0]['label']} + {infos[b][0]['label']}"))
        outers = sorted(singles + pairs, key=lambda s: bin(s[1]).count("1"))
        tried = set()
        for o_members, o_mask, o_need, o_label in outers:
            # Singles lying inside this outer side (not its own members).
            inside = [s for s in singles
                      if s[0][0] not in o_members and not (s[1] & ~o_mask) and s[1] != o_mask]
            if not inside:
                continue
            # Inner candidates: a single (only inside an outer PAIR -- single-in-
            # single is rule_partial_subset), or a compatible pair of singles.
            cand = list(inside) if len(o_members) == 2 else []
            for x in range(len(inside)):
                for y in range(x + 1, len(inside)):
                    sx, sy = inside[x], inside[y]
                    if compatible(infos[sx[0][0]], infos[sy[0][0]]):
                        cand.append(((sx[0][0], sy[0][0]), sx[1] | sy[1], sx[2] + sy[2],
                                     f"{sx[3]} + {sy[3]}"))
            for i_members, i_mask, i_need, i_label in cand:
                if i_need >= o_need or i_mask == o_mask or i_mask & ~o_mask:
                    continue
                if len(o_members) == 1 and len(i_members) == 1:
                    continue
                rmask = o_mask & ~i_mask
                key = (rmask, o_need - i_need)
                if key in tried:
                    continue
                tried.add(key)
                label = f"PartialSubsetUnion({i_label} ⊆ {o_label})"
                changes = self._synthetic_region_deduce(p, self._mask_cells(rmask), o_need - i_need, label)
                if changes:
                    return changes
        return 0
