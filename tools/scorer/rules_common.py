"""
rules_common.py

Rules referenced by both the 1-star and multi-star (2-star+) rule families:
the region-subset-sync family. These already reason in terms of each
region's remaining star *need* (via get_regions_needing_stars) rather than
"has any star", so they work unmodified for any stars_per_unit.
"""

from itertools import combinations


class CommonRules:
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
