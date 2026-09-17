#!/usr/bin/env python3
"""
run_regionless_rebuild.py

Orchestrates build_regionless_books.py across all 4 books, smallest to
largest, committing each book's data/<n>x<n>_regionless.csv to git
immediately after it's written (never pushes -- that's the user's own call).
Each book already parallelizes internally across every CPU core (see
build_pool's ProcessPoolExecutor use), so books run one at a time here
rather than overlapped, to avoid oversubscribing the machine.
"""
import subprocess
import sys
import time

REPO = "/Users/joshmermelstein/projects/entangled_star_battle/multiverse-star-battle"
PYTHON = f"{REPO}/tools/venv/bin/python3"
LOG = f"{REPO}/tools/regionless_rebuild_run/rebuild_status.log"

# Smallest to largest, matching BOOKS' own order in build_regionless_books.py.
BOOK_NAMES = ["6x6_1star", "8x8_1star", "9x9_2star", "13x13_3star"]
BOOK_TO_PATH = {
    "6x6_1star": "data/6x6_regionless.csv",
    "8x8_1star": "data/8x8_regionless.csv",
    "9x9_2star": "data/9x9_regionless.csv",
    "13x13_3star": "data/13x13_regionless.csv",
}


def log(msg):
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    print(line, flush=True)
    with open(LOG, "a") as f:
        f.write(line + "\n")


def run_book(name):
    log(f"=== starting {name} ===")
    t0 = time.time()
    raw_log_path = f"{REPO}/tools/regionless_rebuild_run/{name}_raw.log"
    with open(raw_log_path, "w") as raw_log:
        result = subprocess.run(
            [PYTHON, "build_regionless_books.py", name],
            cwd=f"{REPO}/tools",
            stdout=raw_log, stderr=subprocess.STDOUT,
        )
    elapsed = time.time() - t0
    with open(raw_log_path) as f:
        tail = f.readlines()[-20:]
    log(f"{name} finished in {elapsed:.0f}s (exit {result.returncode}). Tail of log:\n" + "".join(tail))
    if result.returncode != 0:
        log(f"{name} FAILED -- not committing")
        return False

    path = BOOK_TO_PATH[name]
    diff = subprocess.run(["git", "diff", "--stat", "--", path], cwd=REPO, capture_output=True, text=True)
    log(f"{name} git diff --stat:\n{diff.stdout}")

    # Deliberately `git commit -- <path>` rather than `git add` + plain
    # `git commit`: this repo is shared with at least one other concurrent
    # session tonight (see this session's own earlier near-miss), and a
    # pathspec-restricted commit commits ONLY that path's current
    # working-tree content regardless of whatever else might be sitting in
    # the shared index at that moment -- unlike `git add path && git
    # commit` (no pathspec on the commit itself), which would sweep in
    # anything else already staged by someone else.
    commit_msg = (
        f"Regenerate {path.split('/')[-1]} with wide-range sampling from an oversampled pool\n\n"
        f"Rebuilt via tools/build_regionless_books.py's new oversample-then-select "
        f"approach: collects a pool several times bigger than each tier's target "
        f"(diluting same-carve tier-sibling influence -- see the script's own module "
        f"docstring), drops the most void-heavy slice of the Beginner pool before "
        f"selecting, and uses book_gen.py's select_uniform to spread the final pick "
        f"across each tier's actual score range instead of clustering at the easy end.\n\n"
        f"Also re-scored against tonight's rule changes (Medium is confirmed dead for "
        f"regionless boards at every size tested; {name} uses the 250/500/250"
        f"{'+5 Grandmaster bonus' if name in ('6x6_1star', '8x8_1star') else ''} split).\n\n"
        f"Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
    )
    commit = subprocess.run(["git", "commit", "-m", commit_msg, "--", path], cwd=REPO, capture_output=True, text=True)
    log(f"{name} git commit stdout:\n{commit.stdout}")
    if commit.stderr.strip():
        log(f"{name} git commit stderr:\n{commit.stderr}")
    if commit.returncode != 0:
        log(f"{name} COMMIT FAILED")
        return False
    log(f"{name} COMMITTED (not pushed)")
    return True


def main():
    log("=== regionless rebuild started ===")
    for name in BOOK_NAMES:
        ok = run_book(name)
        if not ok:
            log(f"Stopping after {name} failure.")
            sys.exit(1)
    log("=== ALL_BOOKS_COMPLETE ===")


if __name__ == "__main__":
    main()
