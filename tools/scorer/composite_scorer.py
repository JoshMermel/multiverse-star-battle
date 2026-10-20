"""
composite_scorer.py

Assembles CompositeScorer from the core engine (ScorerCore) plus the three
rule-family mixins (CommonRules, SingleStarRules, MultiStarRules), and
builds the per-star-count rule tables.

There is exactly one canonical multi-star rule table (multi_star_rules):
rules_2_star uses it in full, and rules_multi_capped -- used for every
stars_per_unit >= 3 -- is the very same table (the old 3★+ Grandmaster
cutoff was removed 2026-10-18; the name is kept for existing callers).
"""

from .engine import ScorerCore
from .rules_common import CommonRules
from .rules_single_star import SingleStarRules
from .rules_multi_star import MultiStarRules


class CompositeScorer(ScorerCore, CommonRules, SingleStarRules, MultiStarRules):
    """
    Scores Star Battle puzzles by simulating rule-based solving.
    Each rule has a weight (cost to apply) and a tier (difficulty level).
    The scorer tracks both total score and the highest-tier rule used.

    See ScorerCore (engine.py) for the solve loop and the rule-count-agnostic
    helpers every rule family builds on, and rules_common.py /
    rules_single_star.py / rules_multi_star.py for the rule_* methods
    themselves.

    uncap_grandmaster: DEPRECATED, accepted and ignored. It used to lift a
    performance-motivated cap that dropped Grandmaster rules for
    stars_per_unit >= 3 (and the old N-stage multi-star lookahead rules were
    commented out of the table); that cap was removed 2026-10-18, so every
    stars_per_unit now gets the full table. The parameter stays so existing
    callers keep working.
    """

    def __init__(self, verbose=False, uncap_grandmaster=False):
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
            (self.rule_4_5_adjacent_rows,                   35, "Hard"),
            (self.rule_4_5_adjacent_cols,                   35, "Hard"),
            (self.rule_region_contains_region,              40, "Hard"),
            # Tiles for 1★ (rules_single_star.py's own "Tiles for 1★"
            # section comment) -- moved here from Expert (2026-09-10,
            # weight unchanged) once real generation showed these fire
            # often enough on their own that, without anything genuinely
            # Expert-only behind them, they were absorbing puzzles that
            # should have stayed Hard. Matches solver-rules-single.js's
            # identical reorder.
            (self.rule_tile_domino,                         42, "Hard"),
            (self.rule_tile_sees_too_much,                  43, "Hard"),
            (self.rule_tile_region_subset,                  44, "Hard"),

            # -- Symmetry - requires insight but not hard to apply -----------
            (self.rule_rotation_180,                        5, "Symmetry"),
            (self.rule_diagonal_symmetry,                   5, "Symmetry"),
            (self.rule_diagonal_parity,                      15, "Symmetry"),

            # -- Expert -------------------------------------------------------
            # 6 or more adjacent rows/cols: the long-window tail of the
            # Hard-tier 4-5 rules, easiest end of Expert.
            (self.rule_6_plus_adjacent_rows,                40, "Expert"),
            (self.rule_6_plus_adjacent_cols,                40, "Expert"),
            # Tiles rule 4 -- shared with 2★+, see rules_multi_star.py's
            # section comment above rule_tile_pair_quota_fill. Restricted
            # to the 2-tile case; the 3-or-more-tile generalization
            # (rule_tile_pair_quota_fill_grandmaster) is Grandmaster-tier,
            # below.
            (self.rule_tile_pair_quota_fill,                 40, "Expert"),
            (self.rule_3_disjoint_rows,                     45, "Expert"),
            (self.rule_3_disjoint_cols,                     45, "Expert"),
            # Cross-board pin, 2-region case -- opens Expert, ahead of the
            # 3-region case (after rule_3_row_col_line_sync_*). The two
            # swapped positions AND weights: 60ef66b had promoted the
            # 3-region case here, leaving the strictly simpler 2-region
            # case behind it at a higher weight. Matches
            # solver-rules-single.js.
            (self.rule_2_region_pinned_crossboard_rows,     60, "Expert"),
            (self.rule_2_region_pinned_crossboard_cols,     60, "Expert"),
            (self.rule_3_row_col_line_sync_rows,            65, "Expert"),
            (self.rule_3_row_col_line_sync_cols,            65, "Expert"),
            (self.rule_3_region_pinned_crossboard_rows,     70, "Expert"),
            (self.rule_3_region_pinned_crossboard_cols,     70, "Expert"),
            (self.rule_crossboard_partial_overlap,          75, "Expert"),
            (self.rule_lookahead_half_stage_single_board,   78, "Expert"),
            (self.rule_lookahead_half_stage,                80, "Expert"),
            (self.rule_region_pair_contains_pair,           90, "Expert"),
            # Region-pair hybrid enumeration (stars, then dots; each preceded
            # by its tile-shaped version), then region algebra -- see
            # rules_common.py's section comments for both.
            (self.rule_region_pair_tile_star,               95, "Expert"),
            (self.rule_region_pair_stars,                   95, "Expert"),
            (self.rule_region_pair_tile_dots,               97, "Expert"),
            (self.rule_region_pair_dots,                    97, "Expert"),
            (self.rule_region_algebra,                      100, "Expert"),

            # -- Grandmaster --------------------------------------------------
            # Region algebra whose two units are apart (don't share an edge);
            # the touching case is Expert, above. See rules_common.py.
            (self.rule_region_algebra_apart,                 95, "Grandmaster"),
            # Tiles rule 4b -- shared with 2★+, see rules_multi_star.py's
            # rule_tile_pair_quota_fill_grandmaster. The 3-or-more-tile
            # generalization of rule_tile_pair_quota_fill (Expert, above).
            (self.rule_tile_pair_quota_fill_grandmaster,    115, "Grandmaster"),
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
            # Region tiles (see rules_multi_star.py): the tile-shaped version of
            # the next rule(s), tried first at the same tier and score.
            (self.rule_region_tile_star,                         5,  "Beginner"),
            (self.rule_line_tile_star,                           5,  "Beginner"),
            (self.rule_unit_placement_forced_weak_all,           5,  "Beginner"),
            (self.rule_unit_placement_forced_weak_any,           10, "Beginner"),
            # Covers both inside-the-unit and outside-the-unit forced dots --
            # see rule_unit_placement_forced_cond's docstring.
            (self.rule_region_tile_dots,                         10, "Beginner"),
            (self.rule_line_tile_dots,                           10, "Beginner"),
            (self.rule_unit_placement_forced_weak_dots,          10, "Beginner"),
            # Moved here from Medium (multi-star-rules-experiment).
            (self.rule_unit_region_sync_multi_1,                  15, "Beginner"),

            # -- Medium -------------------------------------------------------
            (self.rule_unit_region_sync_multi_2,                  25, "Medium"),
            # Reused directly from SingleStarRules -- copying a known
            # star/dot to its symmetric counterpart doesn't depend on
            # stars_per_unit, so no multi-star variant is needed.
            (self.rule_main_diagonal_fill,                        20, "Medium"),
            (self.rule_anti_diagonal_fill,                        20, "Medium"),
            (self.rule_rotation_180_fill,                         20, "Medium"),
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
            # Region tiles inside one row/column fill its quota -- last in Medium.
            (self.rule_region_tile_line_fill,                     35, "Medium"),

            # -- Hard ---------------------------------------------------------
            # Tiles (multi-star-rules-experiment) -- see rules_multi_star.py's
            # "Tiles" section comment for the shared _confirmed_tiles() concept
            # all three rule_tile_* rules build on. Moved here from the start
            # of Medium: a confirmed tile down to its last empty cell is a
            # simple, mechanical deduction, but still needs spotting a tiling
            # in the first place, which belongs a tier above the plain
            # unit/region reasoning that makes up Medium.
            (self.rule_tile_single_empty,                         30, "Hard"),
            # The 'intermediate' triple, reunited: this generation's own
            # weak/strong triples both stay together (all three of a
            # level's all/any/dots variants in the same tier), so
            # intermediate's all_stars variant belongs here with its
            # any_star/dots siblings too -- not a tier down in Medium,
            # which it was splitting off from for no documented reason.
            # The real cost of this rule is the enumeration itself (every
            # valid completion, aware of every other unit's remaining
            # capacity on this board); once that's done, reading off
            # "always included" vs "always excluded" are equally easy
            # conclusions, so there's no basis for putting one a tier
            # below the other two.
            (self.rule_unit_placement_forced_intermediate_all,    33, "Hard"),
            (self.rule_unit_placement_forced_intermediate_any,    35, "Hard"),
            (self.rule_unit_placement_forced_intermediate_dots,   35, "Hard"),
            (self.rule_unit_region_sync_multi_3,                  45, "Hard"),
            (self.rule_tile_two_empty_dot,                        50, "Hard"),
            # Region needing K stars inside a region needing K stars (any K).
            (self.rule_region_subset_hard,                        55, "Hard"),
            # Same as rule_region_tile_line_fill (Medium), but the K disjoint
            # region tiles may come from both boards.
            (self.rule_region_tile_line_fill_cross,               55, "Hard"),
            # Tile-quota-fill's K=1 special case: a single confirmed tile
            # already covers a unit's whole remaining need. See
            # rule_tile_disjoint_quota_fill (Expert) for K>1. Deliberately
            # AFTER rule_region_subset_hard: for a tile that is a whole
            # region this is the same deduction, and the subset wording is
            # the one a player would notice.
            # Single-unit-tile version of the rule below (region/line tiles
            # instead of band tiles) -- see rules_multi_star.py's "Single-unit
            # tiles" section comment. Same tier/score as the band rule.
            (self.rule_unit_tile_quota_fill_single,               52, "Hard"),
            (self.rule_tile_quota_fill_single,                    52, "Hard"),
            # A inside B where A needs FEWER stars: B \ A holds exactly the
            # difference, reasoned about like a synthetic region. See
            # rules_common.py's "Partial subset" section comment.
            (self.rule_partial_subset,                            58, "Hard"),
            (self.rule_region_line_quota_fill_intermediate,       60, "Hard"),
            (self.rule_region_line_partition_forced_intermediate, 65, "Hard"),
            (self.rule_region_line_partition_trapped_intermediate, 65, "Hard"),
            (self.rule_unit_region_sync_multi_4_to_5,             80, "Hard"),
            # Restored from pre-experiment -- see rules_multi_star.py's
            # "Restored from pre-experiment" section comment.
            (self.rule_unit_completion_satisfies_other_unit_intermediate, 82, "Hard"),
            # 2★+ generalization of rule_tile_sees_too_much -- see
            # rules_multi_star.py's section comment above
            # rule_tile_sees_too_much_multi. Toward the end of Hard: same
            # tile-spotting as rule_tile_single_empty/two_empty_dot (start
            # of Hard) PLUS a per-candidate line-completion check on top.
            (self.rule_unit_tile_sees_too_much_multi,             84, "Hard"),
            (self.rule_tile_sees_too_much_multi,                  84, "Hard"),

            # -- Symmetry - requires insight but not hard to apply -----------
            (self.rule_rotation_180_multi,                        5, "Symmetry"),
            (self.rule_diagonal_symmetry_multi,                   5, "Symmetry"),
            (self.rule_diagonal_parity_multi,                     15, "Symmetry"),

            # -- Expert -------------------------------------------------------
            
            # 6 or more adjacent rows/cols: the long-window tail of the
            # Hard-tier 4-5 rule, easiest end of Expert.
            (self.rule_unit_region_sync_multi_6_plus,             90, "Expert"),
            # Cross-board N-regions-pin-N-rows/cols, 2-region case -- opens
            # Expert; the 3-region case sits later (after
            # rule_tile_pair_quota_fill). The two swapped positions AND
            # weights: 60ef66b had promoted the 3-region case here, leaving
            # the strictly simpler 2-region case behind it at a higher
            # weight. Matches solver-rules-multi.js.
            (self.rule_crossboard_n_region_pinned_multi_2_rows,   112, "Expert"),
            (self.rule_crossboard_n_region_pinned_multi_2_cols,   113, "Expert"),
            # The full (cross-board) strong variants: a deduction here may
            # require combining BOTH boards' region layouts, unlike the
            # Medium/Hard intermediate variants above, which only ever need
            # one board's information at a time.
            (self.rule_unit_placement_forced_strong_all,          95, "Expert"),
            (self.rule_unit_placement_forced_strong_any,          96, "Expert"),
            (self.rule_unit_placement_forced_strong_dots,         97, "Expert"),
            (self.rule_tile_bar_trapped,                          100, "Expert"),
            # 1★ counterpart (rule_crossboard_partial_overlap, rules_single_star.py)
            # sits early in Expert there too; see rules_multi_star.py's
            # "Cross-board partial overlap" section comment for the
            # stars_per_unit-agnostic algebra behind it.
            (self.rule_crossboard_partial_overlap_multi,          105, "Expert"),
            (self.rule_unit_tile_disjoint_quota_fill,             110, "Expert"),
            (self.rule_tile_disjoint_quota_fill,                  110, "Expert"),
            # Tile rule 4 -- needs a genuinely incomplete tiling (a band
            # rule_tile_single_empty/two_empty_dot/quota_fill give up on
            # entirely) to have anything to say, so it's slotted after
            # every rule built on complete tilings. See its own section
            # comment (rules_multi_star.py, above rule_tile_bar_trapped).
            (self.rule_region_line_quota_fill_strong,             115, "Expert"),
            (self.rule_region_line_partition_forced_strong,       116, "Expert"),
            (self.rule_region_line_partition_trapped_strong,      117, "Expert"),
            # Restored from pre-experiment.
            (self.rule_unit_completion_satisfies_other_unit_strong, 118, "Expert"),
            (self.rule_unit_region_sync_multi_2_disjoint,         119, "Expert"),
            (self.rule_tile_pair_quota_fill,                      120, "Expert"),
            # Cross-board pin, 3-region case -- see the 2-region case at the
            # start of Expert.
            (self.rule_crossboard_n_region_pinned_multi_3_rows,   125, "Expert"),
            (self.rule_crossboard_n_region_pinned_multi_3_cols,   125, "Expert"),
            # Region or region-pair inside a region or pair, equal need.
            (self.rule_region_subset_expert,                      130, "Expert"),
            # Region-pair hybrid enumeration (stars, then dots; each preceded
            # by its tile-shaped version), then region algebra -- see
            # rules_common.py's section comments for both.
            (self.rule_region_pair_tile_star,                     152, "Expert"),
            (self.rule_region_pair_stars,                         152, "Expert"),
            (self.rule_region_pair_tile_dots,                     153, "Expert"),
            (self.rule_region_pair_dots,                          153, "Expert"),
            (self.rule_region_algebra,                            155, "Expert"),
            (self.rule_lookahead_dots_single_board,               160, "Expert"),
            # Partial subset where either side is a union of two units --
            # hardest rule in Expert. See rules_common.py's "Partial subset"
            # section comment.
            (self.rule_partial_subset_union,                      170, "Expert"),

            # -- Grandmaster ------------------------------------------------
            # Region algebra whose two units are apart (don't share an edge);
            # the touching case is Expert, above. See rules_common.py.
            (self.rule_region_algebra_apart,                      152, "Grandmaster"),
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
            # Tiles rule 4b -- see rules_multi_star.py's rule_tile_pair_
            # quota_fill_grandmaster. The 3-or-more-tile generalization of
            # rule_tile_pair_quota_fill (Expert, above). Not cross-board --
            # slotted after the two cross-board rules above purely by
            # convention (every other Grandmaster entry here is
            # cross-board-only), not because it depends on them.
            (self.rule_tile_pair_quota_fill_grandmaster,          215, "Grandmaster"),
            # Cross-board lookahead-dots: same one-round speculative
            # placement as the Expert-tier rule_lookahead_dots_single_board
            # above, but the contradiction it looks for only shows up by
            # combining two different regions' remaining quotas across BOTH
            # boards at once -- spotting that a subset of one board's
            # region overlaps a too-tight budget on the other board's
            # region, and only after committing to the hypothetical star,
            # is a lot to hold in your head. Matches solver-rules-multi.js's
            # identical reorder (see the comment there).
            (self.rule_lookahead_dots,                            220, "Grandmaster"),

            # There is no multi-stage lookahead for 2★+ (removed 2026-10-18:
            # repeated propagation is too hard to explain to a player, and a
            # 1-stage version solved only ~3% of stuck 3★+ puzzles). 1★'s
            # rule_lookahead_1/2/3_stage (rules_single_star.py) are untouched.
        ]

        self.rules_2_star = multi_star_rules

        # Every stars_per_unit >= 3 uses the same, full table. (It used to be
        # filtered to Expert and below plus a few exempt Grandmaster rules,
        # for speed; measured on 3★+ samples the Grandmaster rules cost little.)
        self.rules_multi_capped = multi_star_rules
