"""
composite_scorer.py

Assembles CompositeScorer from the core engine (ScorerCore) plus the three
rule-family mixins (CommonRules, SingleStarRules, MultiStarRules), and
builds the per-star-count rule tables.

rules_2_star / rules_3_star / rules_general_multi used to be three
separately hand-written ~35-entry arrays that were supposed to be kept in
sync by hand. In practice they'd drifted: rules_3_star silently dropped its
entire Expert/Grandmaster tier (commented out), and rules_general_multi
mislabeled rule_region_subset_sync_3/_4 as "Hard" instead of "Expert". Here
there is exactly one canonical multi-star rule table (MULTI_STAR_RULES);
rules_2_star and rules_general_multi use it in full, and rules_3_star is
derived from it via an explicit, documented tier cutoff instead of
commented-out rows.
"""

from .engine import ScorerCore, _TIER_RANK
from .rules_common import CommonRules
from .rules_single_star import SingleStarRules
from .rules_multi_star import MultiStarRules


# 3★ puzzles don't get the Expert/Grandmaster tier of multi-star rules --
# a real, pre-existing capability gap versus 2★ and 4★+ puzzles (kept as-is;
# not something this restructuring changes).
TIER_CUTOFF_BY_STAR_COUNT = {3: "Hard"}


class CompositeScorer(ScorerCore, CommonRules, SingleStarRules, MultiStarRules):
    """
    Scores Star Battle puzzles by simulating rule-based solving.
    Each rule has a weight (cost to apply) and a tier (difficulty level).
    The scorer tracks both total score and the highest-tier rule used.

    See ScorerCore (engine.py) for the solve loop and the rule-count-agnostic
    helpers every rule family builds on, and rules_common.py /
    rules_single_star.py / rules_multi_star.py for the rule_* methods
    themselves.
    """

    def __init__(self, verbose=False):
        super().__init__(verbose=verbose)

        # Each entry: (rule_func, weight, tier)
        self.rules_1star = [
            # -- Beginner -----------------------------------------------------
            (self.rule_only_empty,                          1,  "Beginner"),
            (self.rule_sees_star,                           1,  "Beginner"),
            (self.rule_domino,                              5,  "Beginner"),
            (self.rule_triomino,                            7,  "Beginner"),
            (self.rule_1_row,                               10, "Beginner"),
            (self.rule_1_col,                               10, "Beginner"),

            # -- Medium -------------------------------------------------------
            (self.rule_sees_too_much_pair,                  12, "Medium"),
            (self.rule_sees_too_much_trio,                  15, "Medium"),
            (self.rule_sees_too_much,                       18, "Medium"),
            (self.rule_2_adjacent_rows,                     20, "Medium"),
            (self.rule_2_adjacent_cols,                     20, "Medium"),
            (self.rule_main_diagonal_fill,                  20, "Medium"),
            (self.rule_anti_diagonal_fill,                  20, "Medium"),
            (self.rule_rotation_180_fill,                   20, "Medium"),

            # -- Hard ---------------------------------------------------------
            (self.rule_3_adjacent_rows,                     25, "Hard"),
            (self.rule_3_adjacent_cols,                     25, "Hard"),
            (self.rule_2_disjoint_rows,                     30, "Hard"),
            (self.rule_2_disjoint_cols,                     30, "Hard"),
            (self.rule_2_row_col_line_sync_rows,            30, "Hard"),
            (self.rule_2_row_col_line_sync_cols,            30, "Hard"),
            (self.rule_many_adjacent_rows,                  35, "Hard"),
            (self.rule_many_adjacent_cols,                  35, "Hard"),
            (self.rule_region_contains_region,              40, "Hard"),

            # -- Symmetry - requires insight but not hard to apply -----------
            (self.rule_rotation_180,                        5, "Symmetry"),
            (self.rule_diagonal_symmetry,                   5, "Symmetry"),
            (self.rule_diagonal_parity,                      15, "Symmetry"),

            # -- Expert -------------------------------------------------------
            (self.rule_3_disjoint_rows,                     45, "Expert"),
            (self.rule_3_disjoint_cols,                     45, "Expert"),
            (self.rule_3_row_col_line_sync_rows,            45, "Expert"),
            (self.rule_3_row_col_line_sync_cols,            45, "Expert"),
            (self.rule_2_region_pinned_crossboard_rows,     50, "Expert"),
            (self.rule_2_region_pinned_crossboard_cols,     50, "Expert"),
            (self.rule_3_region_pinned_crossboard_rows,     60, "Expert"),
            (self.rule_3_region_pinned_crossboard_cols,     60, "Expert"),
            (self.rule_crossboard_partial_overlap,          75, "Expert"),
            (self.rule_lookahead_half_stage_single_board,   78, "Expert"),
            (self.rule_lookahead_half_stage,                80, "Expert"),
            (self.rule_region_pair_contains_pair,           90, "Expert"),

            # -- Grandmaster --------------------------------------------------
            (self.rule_lookahead_1_stage,                   120, "Grandmaster"),
            (self.rule_lookahead_2_stages,                  250, "Grandmaster"),
            # _lookahead_n_stages with a high stage count runs until the
            # propagation reaches a fixed point, so "3 stages" is a floor,
            # not a ceiling.  The name describes the minimum depth guaranteed.
            (self.rule_lookahead_3_stages,                  550, "Grandmaster"),
        ]
        # Backward-compat alias: existing callers referencing `self.rules`
        # keep getting the classic 1★ rule list.
        self.rules = self.rules_1star

        # The single canonical multi-star (2★+) rule table. rule_region_subset_sync_3/_4
        # are "Expert" here (previously they were only correctly labeled "Expert" in
        # rules_2_star -- rules_general_multi had mislabeled them "Hard").
        multi_star_rules = [
            # -- Beginner -----------------------------------------------------
            (self.rule_only_empty_multi,                          1,  "Beginner"),
            (self.rule_exclude_adjacency,                         1,  "Beginner"),
            (self.rule_exclude_solved_unit,                       1,  "Beginner"),
            (self.rule_unit_placement_forced_weak_all,           5,  "Beginner"),
            (self.rule_unit_region_sync_multi_1,                  10, "Beginner"),

            # -- Medium -------------------------------------------------------
            (self.rule_unit_placement_forced_weak_any,           12, "Medium"),
            (self.rule_unit_placement_forced_weak_dots,          12, "Medium"),
            (self.rule_external_dot_from_placements_weak,         15, "Medium"),
            (self.rule_unit_placement_forced_strong_all,         20, "Medium"),
            (self.rule_unit_region_sync_multi_2,                  25, "Medium"),

            # -- Hard ---------------------------------------------------------
            (self.rule_unit_placement_forced_strong_any,          35, "Hard"),
            (self.rule_unit_placement_forced_strong_dots,         35, "Hard"),
            (self.rule_external_dot_from_placements_strong,       40, "Hard"),
            (self.rule_unit_region_sync_multi_3,                  45, "Hard"),
            (self.rule_region_subset_sync_1,                      60, "Hard"),
            (self.rule_region_subset_sync_2,                      65, "Hard"),
            (self.rule_unit_region_sync_multi_4_plus,             80, "Hard"),
            (self.rule_unit_completion_satisfies_other_unit,      85, "Hard"),
            (self.rule_clump_direct_dots,                         86, "Hard"),
            (self.rule_clump_at_most_one_forcing,                 87, "Hard"),
            (self.rule_clump_disjoint_quota_fill,                 88, "Hard"),

            # -- Expert -------------------------------------------------------
            (self.rule_unit_region_sync_multi_2_disjoint,         100, "Expert"),
            (self.rule_witness_at_most_one_forcing,               101, "Expert"),
            (self.rule_witness_disjoint_quota_fill,               102, "Expert"),
            (self.rule_region_subset_sync_3,                      120, "Expert"),
            (self.rule_region_subset_sync_4,                      150, "Expert"),
            (self.rule_lookahead_dots_single_board,               160, "Expert"),
            (self.rule_lookahead_dots,                            180, "Expert"),

            # -- Grandmaster ----------------------------------------------------
            (self.rule_lookahead_1_stage_multi,                   220, "Grandmaster"),
            (self.rule_lookahead_2_stages_multi,                  350, "Grandmaster"),
            (self.rule_lookahead_3_stages_multi,                  650, "Grandmaster"),
        ]

        self.rules_2_star = multi_star_rules
        self.rules_general_multi = multi_star_rules

        # 3★ gets the same table with everything above the documented cutoff
        # tier dropped -- reproduces the prior rules_3_star's Expert/Grandmaster
        # gap exactly, but as one visible line instead of five commented-out rows.
        cutoff_tier = TIER_CUTOFF_BY_STAR_COUNT[3]
        self.rules_3_star = [
            r for r in multi_star_rules if _TIER_RANK[r[2]] <= _TIER_RANK[cutoff_tier]
        ]
