"""
composite_scorer.py

Assembles CompositeScorer from the core engine (ScorerCore) plus the three
rule-family mixins (CommonRules, SingleStarRules, MultiStarRules), and
builds the per-star-count rule tables.

There is exactly one canonical multi-star rule table (MULTI_STAR_RULES):
rules_2_star uses it in full, and rules_multi_capped -- used for every
stars_per_unit >= 3 -- is derived from it via an explicit, documented tier
cutoff (see MULTI_STAR_TIER_CUTOFF).
"""

from .engine import ScorerCore, _TIER_RANK
from .rules_common import CommonRules
from .rules_single_star import SingleStarRules
from .rules_multi_star import MultiStarRules


# 3+ star puzzles get every multi-star rule up through Expert; only
# Grandmaster (the N-stage lookahead rules) is capped off, since those are
# the ones with a real, measured runtime cost at 3★+ (confirmed via
# recon: the Hard-only cutoff previously used here produced zero
# incorrect deductions once tried up through Expert -- this is a
# performance-motivated cutoff, not a correctness one).
MULTI_STAR_TIER_CUTOFF = "Expert"


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

        # The single canonical multi-star (2★+) rule table, shared by 2★, 3★
        # (filtered below), and general multi-star scoring.
        #
        # multi-star-rules-experiment branch: deliberately stripped down to
        # re-derive the tier structure from first principles -- see
        # rules_multi_star.py's module docstring for what was removed and
        # why. `git show gh-pages:tools/scorer/composite_scorer.py` has the
        # pre-experiment version if this doesn't pan out.
        multi_star_rules = [
            # -- Beginner -----------------------------------------------------
            (self.rule_only_empty_multi,                          1,  "Beginner"),
            (self.rule_exclude_adjacency,                         1,  "Beginner"),
            (self.rule_exclude_solved_unit,                       1,  "Beginner"),
            (self.rule_unit_placement_forced_weak_all,           5,  "Beginner"),
            (self.rule_unit_placement_forced_weak_any,           10, "Beginner"),
            # Covers both inside-the-unit and outside-the-unit forced dots --
            # see rule_unit_placement_forced_cond's docstring.
            (self.rule_unit_placement_forced_weak_dots,          10, "Beginner"),
            # Moved here from Medium (multi-star-rules-experiment).
            (self.rule_unit_region_sync_multi_1,                  15, "Beginner"),

            # -- Medium -------------------------------------------------------
            (self.rule_unit_placement_forced_intermediate_all,    20, "Medium"),
            (self.rule_unit_region_sync_multi_2,                  25, "Medium"),
            # Reused directly from SingleStarRules -- copying a known
            # star/dot to its symmetric counterpart doesn't depend on
            # stars_per_unit, so no multi-star variant is needed.
            (self.rule_main_diagonal_fill,                        20, "Medium"),
            (self.rule_anti_diagonal_fill,                        20, "Medium"),
            (self.rule_rotation_180_fill,                         20, "Medium"),
            # Tiles (multi-star-rules-experiment) -- see rules_multi_star.py's
            # "Tiles" section comment for the shared _confirmed_tiles() concept
            # all three rule_tile_* rules build on.
            (self.rule_tile_single_empty,                         30, "Medium"),
            # Region/line quota fill (multi-star-rules-experiment) -- see
            # rules_multi_star.py's "Region/line quota fill" section comment.
            # weak/intermediate/strong track the same tier bump as
            # rule_unit_placement_forced_* one level up (Medium/Hard/Expert
            # instead of Beginner/Medium/Expert), since this rule needs a
            # placement-forced fact PLUS a cross-region quota argument on
            # top of it.
            (self.rule_region_line_quota_fill_weak,               32, "Medium"),
            # Region/line partition trap + forced-star (multi-star-rules-sync
            # with solver-rules-multi.js) -- siblings of region_line_quota_fill
            # built on the same per-region completion tally, just reasoning
            # about the guaranteed-inside/outside-the-line counts on their
            # own instead of summing them across regions. Slotted at the
            # same tier as their region_line_quota_fill counterpart, not one
            # above, since they don't need its extra cross-region subset-sum
            # step. The forced-star variant runs first at each tier, same as
            # unit_placement_forced's 'all_stars' running before
            # 'any_star'/'dots' -- confirming a star outright is a bigger
            # win than excluding one.
            (self.rule_region_line_partition_forced_weak,         33, "Medium"),
            (self.rule_region_line_partition_trapped_weak,        34, "Medium"),

            # -- Hard ---------------------------------------------------------
            (self.rule_unit_placement_forced_intermediate_any,    35, "Hard"),
            (self.rule_unit_placement_forced_intermediate_dots,   35, "Hard"),
            (self.rule_unit_region_sync_multi_3,                  45, "Hard"),
            (self.rule_tile_two_empty_dot,                        50, "Hard"),
            # Tile-quota-fill's K=1 special case: a single confirmed tile
            # already covers a unit's whole remaining need. See
            # rule_tile_disjoint_quota_fill (Expert) for K>1.
            (self.rule_tile_quota_fill_single,                    52, "Hard"),
            (self.rule_region_line_quota_fill_intermediate,       55, "Hard"),
            (self.rule_region_line_partition_forced_intermediate, 56, "Hard"),
            (self.rule_region_line_partition_trapped_intermediate, 57, "Hard"),
            (self.rule_region_subset_sync_1,                      60, "Hard"),
            (self.rule_region_subset_sync_2,                      65, "Hard"),
            (self.rule_unit_region_sync_multi_4_plus,             80, "Hard"),
            # Restored from pre-experiment -- see rules_multi_star.py's
            # "Restored from pre-experiment" section comment.
            (self.rule_unit_completion_satisfies_other_unit_intermediate, 82, "Hard"),

            # -- Symmetry - requires insight but not hard to apply -----------
            (self.rule_rotation_180_multi,                        5, "Symmetry"),
            (self.rule_diagonal_symmetry_multi,                   5, "Symmetry"),
            (self.rule_diagonal_parity_multi,                     15, "Symmetry"),

            # -- Expert -------------------------------------------------------
            # The full (cross-board) strong variants: a deduction here may
            # require combining BOTH boards' region layouts, unlike the
            # Medium/Hard intermediate variants above, which only ever need
            # one board's information at a time.
            (self.rule_unit_placement_forced_strong_all,          95, "Expert"),
            (self.rule_unit_placement_forced_strong_any,          96, "Expert"),
            (self.rule_unit_placement_forced_strong_dots,         97, "Expert"),
            # 1★ counterpart (rule_crossboard_partial_overlap, rules_single_star.py)
            # sits early in Expert there too; see rules_multi_star.py's
            # "Cross-board partial overlap" section comment for the
            # stars_per_unit-agnostic algebra behind it.
            (self.rule_crossboard_partial_overlap_multi,          98, "Expert"),
            (self.rule_tile_disjoint_quota_fill,                  100, "Expert"),
            # Tile rule 4 -- needs a genuinely incomplete tiling (a band
            # rule_tile_single_empty/two_empty_dot/quota_fill give up on
            # entirely) to have anything to say, so it's slotted after
            # every rule built on complete tilings. See its own section
            # comment (rules_multi_star.py, above rule_tile_bar_trapped).
            (self.rule_tile_bar_trapped,                          102, "Expert"),
            (self.rule_region_line_quota_fill_strong,             105, "Expert"),
            (self.rule_region_line_partition_forced_strong,       106, "Expert"),
            (self.rule_region_line_partition_trapped_strong,      107, "Expert"),
            # Restored from pre-experiment.
            (self.rule_unit_completion_satisfies_other_unit_strong, 108, "Expert"),
            (self.rule_unit_region_sync_multi_2_disjoint,         109, "Expert"),
            (self.rule_crossboard_n_region_pinned_multi_2_rows,   110, "Expert"),
            (self.rule_crossboard_n_region_pinned_multi_2_cols,   111, "Expert"),
            (self.rule_crossboard_n_region_pinned_multi_3_rows,   112, "Expert"),
            (self.rule_crossboard_n_region_pinned_multi_3_cols,   113, "Expert"),
            (self.rule_region_subset_sync_3,                      120, "Expert"),
            (self.rule_region_subset_sync_4,                      150, "Expert"),
            (self.rule_lookahead_dots_single_board,               160, "Expert"),
            (self.rule_lookahead_dots,                            180, "Expert"),

            # -- Grandmaster ------------------------------------------------
            # Cross-board region/line quota fill + partition forced -- see
            # rules_multi_star.py's "Cross-board region/line quota fill +
            # partition forced" section comment. Genuinely cross-board only
            # (same-board matches are already caught by the Expert-tier
            # region_line_quota_fill_strong/region_line_partition_forced_strong
            # above), so this is strictly additional reasoning, not a
            # duplicate of those. Forced-star runs first, same convention as
            # every other weak/any/dots-style pairing in this table.
            (self.rule_crossboard_region_line_partition_forced,   200, "Grandmaster"),
            (self.rule_crossboard_region_line_quota_fill,         210, "Grandmaster"),

            # All three N-stage multi-star lookahead rules are commented out
            # for performance: each is a full board-wide speculative sweep
            # per empty cell, repeated per stage, and that's expensive
            # enough at 3★+ scale that even 1-stage measurably slows things
            # down. rule_lookahead_dots(_single_board) above (Expert tier)
            # is the cheaper one-round equivalent and stays active. 1★'s
            # rule_lookahead_1/2/3_stage (rules_single_star.py) are
            # untouched. Leave commented rather than deleting, matching
            # gh-pages' own convention, in case this gets revisited.
            # (self.rule_lookahead_1_stage_multi,                   220, "Grandmaster"),
            # (self.rule_lookahead_2_stages_multi,                  350, "Grandmaster"),
            # (self.rule_lookahead_3_stages_multi,                  650, "Grandmaster"),
        ]

        self.rules_2_star = multi_star_rules

        # Every stars_per_unit >= 3 gets the same table with everything
        # above MULTI_STAR_TIER_CUTOFF dropped.
        self.rules_multi_capped = [
            r for r in multi_star_rules if _TIER_RANK[r[2]] <= _TIER_RANK[MULTI_STAR_TIER_CUTOFF]
        ]
